#!/usr/bin/python3 -I
"""Non-interactive administrator commands; no PTY or shell interpolation.

The same self-contained file is installed root-owned at ROOT_HELPER. The node
imports only process(); sudo accepts a bounded JSON request on stdin. Durable
dispatch receipts deliberately prefer UNKNOWN over ever repeating a command.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time

ROOT_HELPER = '/usr/local/libexec/gpuq-console-admin-command'
ROOT = Path('/var/lib/gpuq-console/admin-commands')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
LIMIT = 65536  # Each stream, bytes; excess is drained but never stored.
REQUEST_LIMIT = 20000  # Whole UTF-8 JSON request, identical on both sides of sudo.
MAX_CONCURRENT = 4  # Accidental fan-out guard, not a ROOT resource sandbox.
TERMINAL = {'SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT'}


def valid_id(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError('A UUID command key/handle is required')
    return value


def validate(operation, args, identity=True):
    allowed = {'host.exec': {'key', 'argv', 'cwd', 'timeoutSec'},
               'host.status': {'id'}, 'host.cancel': {'id'}}
    if operation not in allowed or not isinstance(args, dict):
        raise ValueError('Invalid host command operation')
    if set(args) - allowed[operation] - ({'userId', 'username'} if identity else set()):
        raise ValueError('Invalid host command fields')
    if identity:
        if not isinstance(args.get('userId'), str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)', args['userId']):
            raise ValueError('Invalid administrator identity')
        username = args.get('username')
        if not isinstance(username, str) or not username or len(username) > 100 or any(ord(c) < 32 for c in username):
            raise ValueError('Invalid administrator name')
    if operation != 'host.exec':
        valid_id(args.get('id'))
        return dict(args)
    valid_id(args.get('key'))
    argv = args.get('argv')
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 128 or
            any(not isinstance(a, str) or '\0' in a for a in argv) or not argv[0] or
            len(json.dumps(argv, ensure_ascii=False).encode()) > 12000):
        raise ValueError('Invalid or oversized command argv')
    cwd = args.get('cwd', '/root')
    if not isinstance(cwd, str) or not cwd.startswith('/') or '\0' in cwd or len(cwd) > 1024:
        raise ValueError('Command cwd must be an absolute path')
    timeout = args.get('timeoutSec', 300)
    if type(timeout) is not int or not 1 <= timeout <= 86400:
        raise ValueError('Command timeoutSec must be an integer from 1 to 86400')
    return {**args, 'cwd': cwd, 'timeoutSec': timeout}


def process(config, operation, args):
    """Called only by the authenticated forced-command node executor."""
    if config.get('hostRoot') is not True or not isinstance(args, dict) or args.get('hostAdmin') is not True:
        raise ValueError('Host root commands require an administrator and enabled hostRoot')
    payload = validate(operation, {k: v for k, v in args.items() if k != 'hostAdmin'})
    request = json.dumps({'operation': operation, 'args': payload}, ensure_ascii=False)
    if len(request.encode('utf-8')) > REQUEST_LIMIT:
        raise ValueError('Host command request is too large')
    info = Path(ROOT_HELPER).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('Unsafe root command helper')
    completed = subprocess.run(['/usr/bin/sudo', '-n', ROOT_HELPER],
                               input=request, text=True, encoding='utf-8',
                               capture_output=True, timeout=18,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    if completed.returncode:
        raise ValueError('Root command helper failed; retry with the SAME key to inspect, not a new key')
    response = json.loads(completed.stdout)
    if not response.get('ok'):
        raise ValueError(response.get('error', 'Root command failed'))
    return response['result']


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


class Commands:
    def __init__(self, root=ROOT, helper=ROOT_HELPER):
        self.root = Path(root)
        self.helper = helper

    def path(self, identifier, suffix):
        return self.root / (valid_id(identifier) + suffix)

    def load(self, identifier):
        return json.loads(self.path(identifier, '.json').read_text())

    def audit(self, event, spec, **extra):
        # Never copy argv, cwd, stdout or stderr into the audit trail.
        record = {'at': now(), 'event': event, 'id': spec['key'],
                  'userId': spec['userId'], 'username': spec['username'],
                  'digest': spec['digest'], **extra}
        fd = os.open(self.root / 'audit.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            data = (json.dumps(record) + '\n').encode()
            while data:
                data = data[os.write(fd, data):]
            os.fsync(fd)
        finally:
            os.close(fd)

    @staticmethod
    def unit(identifier):
        return 'gpuq-host-' + valid_id(identifier) + '.service'

    @staticmethod
    def run_system(argv, timeout=8):
        return subprocess.run(argv, text=True, capture_output=True, timeout=timeout,
                              env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})

    def activity(self, identifier):
        """True=still active, False=confirmed empty, None=cannot establish."""
        try:
            out = self.run_system(['/usr/bin/systemctl', 'show', self.unit(identifier),
                                  '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup'], 4)
            props = dict(line.split('=', 1) for line in out.stdout.splitlines() if '=' in line)
            if set(props) != {'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup'}:
                return None
            if out.returncode and not (out.returncode == 1 and props['LoadState'] == 'not-found'):
                return None
            if props['MainPID'] != '0' or props['ActiveState'] not in ('inactive', 'failed'):
                return True
            group = props['ControlGroup']
            if group:
                if not group.startswith('/') or '..' in Path(group).parts or Path(group).name != self.unit(identifier):
                    return None
                path = Path('/sys/fs/cgroup') / group.lstrip('/')
                try:
                    events = dict(line.split() for line in (path / 'cgroup.events').read_text().splitlines())
                except FileNotFoundError:
                    return False if not path.exists() else None
                return events.get('populated') != '0'
            return False if props['LoadState'] in ('loaded', 'not-found') else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return None

    def status(self, identifier, user_id):
        spec = self.load(identifier)
        if spec['userId'] != user_id:
            raise ValueError('Command handle is not owned by this administrator')
        active = self.activity(identifier)
        # The worker may publish its receipt while activity() waits on systemd.
        # Read after that lifecycle check so a confirmed-empty command cannot
        # inherit a stale missing receipt and spuriously become UNKNOWN.
        receipt = self.path(identifier, '.result.json')
        result = json.loads(receipt.read_text()) if receipt.exists() else {}
        cancel = self.path(identifier, '.cancel').exists()
        if active is True:
            state = 'CANCELING' if cancel else 'RUNNING'
        elif active is False and result.get('state') in TERMINAL:
            state = result['state']
        elif active is False and cancel:
            state = 'CANCELED'
        else:
            state = 'UNKNOWN'
        out = {'id': identifier, 'key': identifier, 'state': state,
               'createdAt': spec['createdAt'], 'timeoutSec': spec['timeoutSec'],
               'exitCode': result.get('exitCode') if state in TERMINAL else None,
               'signal': result.get('signal') if state in TERMINAL else None,
               'timedOut': result.get('timedOut', False),
               'truncated': result.get('truncated', {s: self.path(identifier, '.' + s + '.truncated').exists() for s in ('stdout', 'stderr')}),
               'cancelRequested': cancel, 'outputLimitBytes': LIMIT}
        if result.get('finishedAt'):
            out['finishedAt'] = result['finishedAt']
        for stream in ('stdout', 'stderr'):
            path = self.path(identifier, '.' + stream)
            try:
                with path.open('rb') as file:
                    out[stream] = file.read(LIMIT).decode('utf-8', errors='replace')
            except FileNotFoundError:
                out[stream] = ''
        if state == 'UNKNOWN':
            out['error'] = 'Command outcome is not confirmed; this key will never dispatch again. Inspect this handle before deciding on a new command.'
        if result.get('error'):
            out['error'] = result['error']
        return out

    def admission_slot(self):
        """Called under the global admission lock; unknown launches retain a slot.

        Merely seeing no systemd unit is insufficient after a launch timeout:
        the dispatch can still be in flight. A worker-start marker, terminal
        receipt, or explicit cancellation plus a confirmed empty unit fences
        reuse. No command is redispatched to resolve an uncertain slot.
        """
        for index in range(MAX_CONCURRENT):
            slot = self.root / ('.admission-' + str(index) + '.json')
            if not slot.exists():
                return slot
            identifier = valid_id(json.loads(slot.read_text())['id'])
            if not self.path(identifier, '.json').exists():
                raise ValueError('Host command admission state is incomplete; administrator inspection is required')
            result_path = self.path(identifier, '.result.json')
            result = json.loads(result_path.read_text()) if result_path.exists() else {}
            fenced = (self.path(identifier, '.started').exists() or
                      self.path(identifier, '.cancel').exists() or result.get('state') in TERMINAL)
            if fenced and self.activity(identifier) is False:
                return slot
        raise ValueError('Host command concurrency limit reached (4); inspect existing handles, including UNKNOWN launches')

    def call(self, operation, args):
        args = validate(operation, args)
        identifier = args['key'] if operation == 'host.exec' else args['id']
        with self.path(identifier, '.lock').open('a') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            if operation == 'host.exec':
                digest = hashlib.sha256(json.dumps([args['userId'], args['argv'], args['cwd'], args['timeoutSec']],
                                                  ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
                file = self.path(identifier, '.json')
                if file.exists():
                    previous = self.load(identifier)
                    if previous['digest'] != digest or previous['userId'] != args['userId']:
                        raise ValueError('The same command key cannot be reused for different arguments')
                    return self.status(identifier, args['userId'])
                with (self.root / '.admission.lock').open('a') as admission:
                    try:
                        fcntl.flock(admission, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        raise ValueError('Host command admission is busy; retry with the SAME key') from None
                    if len(list(self.root.glob('*.json'))) >= 10000:
                        raise ValueError('Host command history is full; administrator archival is required')
                    slot = self.admission_slot()
                    spec = {**args, 'digest': digest, 'createdAt': now()}
                    # Audit and durable attempted/slot markers precede launch.
                    # A crash can suppress a command, never repeat or over-admit it.
                    self.audit('submit', spec)
                    atomic_json(file, spec)
                    atomic_json(slot, {'id': identifier, 'reservedAt': now()})
                    unit = self.unit(identifier)
                    argv = ['/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + unit,
                            '--property=Type=exec', '--property=KillMode=control-group',
                            '--property=TimeoutStopSec=5', '--property=UMask=0077',
                            '--property=RuntimeMaxSec=' + str(args['timeoutSec'] + 10),
                            '--', self.helper, '--worker', identifier]
                    try:
                        self.run_system(argv)
                    except (OSError, subprocess.TimeoutExpired):
                        pass  # Launch may have happened. NEVER automatically resubmit.
            else:
                spec = self.load(identifier)
                if spec['userId'] != args['userId']:
                    raise ValueError('Command handle is not owned by this administrator')
                if operation == 'host.cancel' and self.status(identifier, args['userId'])['state'] not in TERMINAL:
                    self.audit('cancel', spec)
                    atomic_json(self.path(identifier, '.cancel'), {'at': now()})
                    try:
                        self.run_system(['/usr/bin/systemctl', 'stop', self.unit(identifier)], 9)
                    except (OSError, subprocess.TimeoutExpired):
                        pass  # Return CANCELING/UNKNOWN unless cleanup is confirmed.
            return self.status(identifier, args['userId'])

    def worker(self, identifier):
        # Also guards against accidental manual/double starts of the same unit.
        with self.path(identifier, '.worker.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.path(identifier, '.started').exists():
                return 1
            spec = self.load(identifier)
            self.audit('start', spec)
            atomic_json(self.path(identifier, '.started'), {'at': now()})
            canceled = [False]
            previous = {}
            def stopping(_signum, _frame):
                canceled[0] = True
            for value in (signal.SIGTERM, signal.SIGINT):
                previous[value] = signal.signal(value, stopping)
            child = None
            streams = {}
            selector = selectors.DefaultSelector()
            truncated = {'stdout': False, 'stderr': False}
            counts = {'stdout': 0, 'stderr': 0}
            state, error, timed_out = 'FAILED', None, False
            try:
                for stream in counts:
                    streams[stream] = self.path(identifier, '.' + stream).open('wb', buffering=0)
                if self.path(identifier, '.cancel').exists():
                    canceled[0] = True
                if not canceled[0]:
                    child = subprocess.Popen(spec['argv'], cwd=spec['cwd'], stdin=subprocess.DEVNULL,
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                             env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                                                  'HOME': '/root', 'USER': 'root', 'LOGNAME': 'root', 'LANG': 'C.UTF-8'})
                    for stream in counts:
                        pipe = getattr(child, stream)
                        os.set_blocking(pipe.fileno(), False)
                        selector.register(pipe, selectors.EVENT_READ, stream)
                    deadline = time.monotonic() + spec['timeoutSec']
                    stopping_at = None
                    while True:
                        at = time.monotonic()
                        code = child.poll()
                        timed_out = timed_out or (code is None and at >= deadline)
                        # On parent exit also reap descendants that retain the pipes.
                        if (canceled[0] or timed_out or code is not None) and stopping_at is None:
                            stopping_at = at
                            self.kill_group(child, signal.SIGTERM)
                        if stopping_at is not None and at - stopping_at >= 1:
                            self.kill_group(child, signal.SIGKILL)
                        for event, _mask in selector.select(0.05):
                            data = os.read(event.fileobj.fileno(), 65536)
                            if not data:
                                selector.unregister(event.fileobj); event.fileobj.close(); continue
                            stream = event.data
                            keep = data[:max(0, LIMIT - counts[stream])]
                            if keep:
                                streams[stream].write(keep); counts[stream] += len(keep)
                            if len(keep) < len(data):
                                if not truncated[stream]:
                                    atomic_json(self.path(identifier, '.' + stream + '.truncated'), {'truncated': True})
                                    truncated[stream] = True
                        if code is not None and not selector.get_map():
                            break
                        if stopping_at is not None and at - stopping_at >= 2:
                            break  # systemd owns the final cgroup cleanup as well.
                    child.wait(timeout=2)
                state = 'TIMED_OUT' if timed_out else 'CANCELED' if canceled[0] else 'SUCCEEDED' if child.returncode == 0 else 'FAILED'
            except Exception as exception:
                error = str(exception)[:300]
            finally:
                if child is not None:
                    self.kill_group(child, signal.SIGKILL)
                    try:
                        child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
                    for pipe in (child.stdout, child.stderr):
                        pipe.close()
                selector.close()
                for file in streams.values():
                    file.close()
                for value, handler in previous.items():
                    signal.signal(value, handler)
            code = child.returncode if child is not None else None
            result = {'state': state, 'exitCode': code if code is not None and code >= 0 else None,
                      'signal': -code if code is not None and code < 0 else None,
                      'timedOut': timed_out, 'truncated': truncated, 'finishedAt': now()}
            if error:
                result['error'] = error
            self.audit('finish', spec, state=state, exitCode=result['exitCode'], signal=result['signal'])
            atomic_json(self.path(identifier, '.result.json'), result)
            return 0

    @staticmethod
    def kill_group(child, sig):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass


def prepare_root():
    if os.geteuid() != 0:
        raise ValueError('The fixed root command helper must run as root')
    cursor = Path('/')
    for part in ROOT.parts[1:]:
        cursor /= part
        try:
            cursor.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = cursor.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Unsafe host command state directory')


def main():
    os.umask(0o077)
    prepare_root()
    commands = Commands()
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        return commands.worker(valid_id(sys.argv[2]))
    if len(sys.argv) != 1:
        raise ValueError('Invalid helper arguments')
    raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    if len(raw) > REQUEST_LIMIT:
        raise ValueError('Host command request is too large')
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {'operation', 'args'}:
        raise ValueError('Invalid host command request')
    result = commands.call(request['operation'], request['args'])
    print(json.dumps({'ok': True, 'result': result}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exception:
        print(json.dumps({'ok': False, 'error': str(exception)[:300]}))
        sys.exit(1 if '--worker' in sys.argv else 0)
