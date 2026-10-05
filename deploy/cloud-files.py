#!/usr/bin/python3
"""Private node-local cloud jobs. Members never receive the CD2 credential.

Cloud writes are immutable/idempotency-fenced. An uncertain upload is retained
and never silently submitted twice. Downloads stage privately and commit with
the existing no-overwrite data-import implementation. No VPS payload relay.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
ACTIVE = {'QUEUED', 'RUNNING', 'CANCELING'}
STATES = ACTIVE | {'READY', 'VERIFYING', 'VERIFIED', 'FAILED', 'CANCELED', 'PAUSED'}
PUBLIC = ('operationId', 'action', 'fileId', 'name', 'path', 'state', 'phase',
          'bytes', 'totalBytes', 'sha256', 'createdAt', 'updatedAt', 'error', 'errorCode')


class CloudConfirmationTimeout(ValueError):
    """Only the fixed worker deadline code may produce this public reason."""


class CloudFileIdentityChanged(ValueError):
    """Fixed typed worker reason; never expose an upstream message or ID."""
    def __init__(self, stage):
        if stage not in ('IDENTITY_BEFORE_TRANSFER', 'IDENTITY_AFTER_TRANSFER'):
            raise ValueError('Invalid cloud identity stage')
        self.stage = stage


class CloudFiles:
    def __init__(self, executor):
        self.n, self.w, self.imports = executor, executor.data_workspaces(), executor.data_imports()

    def config(self):
        c = self.n.CONFIG.get('cloudFiles')
        if not isinstance(c, dict) or c.get('enabled') is not True:
            raise ValueError('Cloud storage is not enabled on this node')
        allowed = {'enabled', 'nodeExecutable', 'worker', 'privateConfig', 'maxFileBytes', 'maxUserBytes', 'maxTotalBytes'}
        if set(c) != allowed:
            raise ValueError('Cloud node configuration is invalid')
        for key in ('nodeExecutable', 'worker', 'privateConfig'):
            if not isinstance(c[key], str) or not c[key].startswith('/') or '..' in Path(c[key]).parts:
                raise ValueError('Cloud runtime paths must be installed by the administrator')
        for key in ('maxFileBytes', 'maxUserBytes', 'maxTotalBytes'):
            if type(c[key]) is not int or not 1 <= c[key] <= 2**50:
                raise ValueError('Cloud storage limits are invalid')
        if c['maxFileBytes'] > min(c['maxUserBytes'], c['maxTotalBytes'], 1024**4):
            raise ValueError('Cloud file limit exceeds the account limit')
        return c

    def storage(self, user, key=None, create=False):
        module, cache, owner = self.w.storage(user)
        folder = owner/'cloud-files'
        module._mkdir(folder)
        if key is not None:
            if not isinstance(key, str) or not UUID.fullmatch(key):
                raise ValueError('A valid cloud operation ID is required')
            folder /= key
            if create:
                module._mkdir(folder)
        return module, cache, owner, folder

    def load(self, user, key):
        module, _, _, folder = self.storage(user, key)
        task = module._read_json(folder/'task.json')
        if (not isinstance(task, dict) or task.get('schema') != 1 or task.get('userId') != user
                or task.get('operationId') != key or task.get('state') not in STATES
                or task.get('action') not in ('upload', 'verify', 'download')
                or type(task.get('generation')) is not int):
            raise ValueError('Cloud operation metadata is invalid')
        return task

    def save(self, task):
        module, _, _, folder = self.storage(task['userId'], task['operationId'])
        task['updatedAt'] = time.time()
        module._write_json(folder/'task.json', task)

    @staticmethod
    def unit(task):
        return 'gpuq-cloud-'+hashlib.sha256((task['userId']+'\0'+task['operationId']).encode()).hexdigest()[:32]

    def stopped(self, task):
        return self.w.unit_stopped(self.unit(task)+'.service')

    def public(self, task, check=True):
        result = {k: task[k] for k in PUBLIC if k in task}
        if check and task['state'] in ACTIVE and self.stopped(task):
            result.update(state='PAUSED' if task['action'] == 'download' else 'FAILED',
                          error='Cloud worker stopped; no automatic upload retry was performed')
        result['canResume'] = (task['action'] == 'download' and result['state'] in ('PAUSED', 'FAILED', 'CANCELED')
                               and task.get('errorCode') != 'CLOUD_FILE_IDENTITY_CHANGED')
        result['vpsRelay'] = False
        return result

    def tasks(self, user):
        module, _, _, folder = self.storage(user)
        with module._directory(folder) as fd:
            keys = sorted(name for name in os.listdir(fd) if UUID.fullmatch(name))
        if len(keys) > 1024:
            raise ValueError('Too many retained cloud operations; ask an administrator to archive them')
        tasks = []
        for key in keys:
            try:tasks.append(self.load(user, key))
            except FileNotFoundError:
                # Admission can stop between mkdir and its first durable task.
                # Only an entirely empty, safe directory is ignorable; there
                # cannot be a launched worker before task.json was written.
                with module._directory(folder/key) as fd:
                    if os.listdir(fd):raise ValueError('Incomplete cloud task needs administrator review')
        return tasks

    def reserve_cloud(self, task):
        # This ledger is node-global. Only the single designated cloud node may
        # be enabled for this account; other nodes use the existing LAN transfer.
        c = self.config()
        module, cache, _, _ = self.storage(task['userId'])
        with cache._locked():
            location = cache.root/'.cloud-budget.json'
            try:
                ledger = module._read_json(location)
            except FileNotFoundError:
                ledger = {}
            if not isinstance(ledger, dict) or len(ledger) > 100000:
                raise ValueError('Cloud budget ledger requires administrator review')
            for row in ledger.values():
                if not isinstance(row, dict) or set(row) != {'userId', 'bytes'} or type(row['bytes']) is not int or row['bytes'] < 0:
                    raise ValueError('Cloud budget ledger is invalid')
            key = hashlib.sha256((task['userId']+'\0'+task['operationId']).encode()).hexdigest()
            row = {'userId': task['userId'], 'bytes': task['totalBytes']}
            if key in ledger:
                if ledger[key] != row:
                    raise ValueError('Cloud reservation identity changed')
                return
            if sum(v['bytes'] for v in ledger.values())+row['bytes'] > c['maxTotalBytes'] or sum(v['bytes'] for v in ledger.values() if v['userId'] == task['userId'])+row['bytes'] > c['maxUserBytes']:
                raise ValueError('Cloud storage allowance exceeded; retained partial uploads count toward it')
            ledger[key] = row
            module._write_json(location, ledger)

    def source(self, user, path):
        module, _, owner, _ = self.storage(user)
        parts = self.w.relative(path)
        with module._directory(owner/'data'/Path(*parts[:-1])) as parent:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_nlink != 1 or s.st_mode & 0o022:
                raise ValueError('Cloud upload requires a private regular file, not a link')
            return fd, s
        except BaseException:
            os.close(fd)
            raise

    def file_record(self, user, file_id):
        task = self.load(user, file_id)
        if task['action'] != 'upload' or task['state'] not in ('VERIFYING', 'VERIFIED') or not task.get('receipt'):
            raise ValueError('Cloud file was not uploaded by this account or is not confirmed')
        return task

    def start(self, action, args):
        c = self.config()
        user, key = args['userId'], args.get('key')
        self.storage(user, key)  # validate before any launch
        if action not in ('upload', 'verify', 'download'):
            raise ValueError('Unknown cloud operation')
        identity = {'action': action, 'path': args.get('path'), 'fileId': args.get('fileId')}
        if action in ('upload', 'download'):
            self.w.relative(identity['path'])
        if action != 'upload' and (not isinstance(identity['fileId'], str) or not UUID.fullmatch(identity['fileId'])):
            raise ValueError('A confirmed cloud file ID is required')
        if action == 'upload' and identity['fileId'] is not None or action == 'verify' and identity['path'] is not None:
            raise ValueError('Cloud action fields mismatch')
        try:
            previous = self.load(user, key)
        except FileNotFoundError:
            previous = None
        if previous:
            if previous['identity'] != identity:
                raise ValueError('Operation key belongs to a different cloud request')
            if previous.get('errorCode') == 'CLOUD_FILE_IDENTITY_CHANGED':
                raise ValueError('File identity changed; reverify the file, then create a new download operation')
            # Ambiguous upload never creates another cloud file. Verification
            # uses a new key; only a byte-verified download may resume this key.
            if action != 'download' or previous['state'] == 'READY' or not self.stopped(previous):
                return self.public(previous)
        tasks = self.tasks(user)
        if not previous and len(tasks) >= 1024:
            raise ValueError('Cloud operation history limit reached')
        if any(t['operationId'] != key and t['state'] in ACTIVE and not self.stopped(t) for t in tasks):
            raise ValueError('Another cloud transfer is active in this personal data workspace')
        self.w.writable(args)
        self.w.no_terminals(user)
        lock = self.w.lifetime(user, exclusive=True)
        try:
            task = previous or {'schema': 1, 'userId': user, 'operationId': key,
                'identity': identity, 'action': action, 'generation': 0, 'createdAt': time.time(), 'bytes': 0}
            if action == 'upload':
                fd, info = self.source(user, identity['path'])
                os.close(fd)
                if info.st_size > c['maxFileBytes']:
                    raise ValueError('Cloud file exceeds the per-file limit')
                task.update(path=identity['path'], name=Path(identity['path']).name, totalBytes=info.st_size)
                self.reserve_cloud(task)
            else:
                cloud = self.file_record(user, identity['fileId'])
                if action == 'download' and cloud['state'] != 'VERIFIED':
                    raise ValueError('Wait for cloud verification before downloading')
                if previous and previous.get('receipt') != cloud['receipt']:
                    raise ValueError('Verified receipt changed; create a new download instead of rebinding this operation')
                task.update(fileId=cloud['operationId'], receipt=cloud['receipt'], totalBytes=cloud['totalBytes'],
                            name=cloud['name'], **({'path': identity['path']} if action == 'download' else {}))
            task.update(state='QUEUED', generation=task['generation']+1, cancelRequested=False)
            task.pop('error', None)
            self.storage(user, key, create=True)
            self.save(task)
            try:
                self.n.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit='+self.unit(task),
                    '--property=KillMode=control-group', '--property=UMask=0077', '--property=CPUQuota=100%',
                    '--property=MemoryMax=512M', '--property=TasksMax=32', '--property=IOWeight=10',
                    '--property=RuntimeMaxSec=86400', '--property=TimeoutStopSec=25',
                    '--property=StandardOutput=null', '--property=StandardError=null',
                    '/usr/bin/python3', str(self.n.HERE/'node-executor.py'), '--cloud-files-worker',
                    user, key, str(task['generation'])], timeout=8)
            except Exception:
                task['error'] = 'Worker launch is unconfirmed; refresh this operation, do not repeat the upload'
                self.save(task)
            return self.public(task, check=False)
        finally:
            os.close(lock)

    def check_current(self, task, **update):
        with self.w.guard({'userId': task['userId']}, blocking=True):
            current = self.load(task['userId'], task['operationId'])
            if current['generation'] != task['generation'] or current.get('cancelRequested'):
                raise ValueError('Cloud operation canceled or replaced; partial files are retained')
            task.update(update)
            self.save(task)

    def io(self, task, fd):
        c = self.config()
        request = {'action': task['action'], 'ownerId': task['userId'], 'operationId': task['operationId']}
        if task['action'] == 'upload':
            request.update(name=task['name'], size=task['totalBytes'])
        else:
            request.update(fileId=task['fileId'], receipt=task['receipt'])
            if task['action'] == 'download':
                request['offset'] = os.fstat(fd).st_size
        env = {**self.n.ENV, 'GPUQ_CLOUD_FILE_FD': str(fd)}
        p = subprocess.Popen([c['nodeExecutable'], c['worker'], c['privateConfig']], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                             pass_fds=(() if fd is None else (fd,)))
        selector = selectors.DefaultSelector()
        selector.register(p.stdout, selectors.EVENT_READ)
        result, pending, began = None, b'', time.monotonic()
        try:
            p.stdin.write(json.dumps(request).encode()); p.stdin.close()
            while True:
                self.check_current(task)
                if time.monotonic()-began > 86400:
                    raise ValueError('Cloud operation timed out; partial files are retained')
                events = selector.select(1)
                if not events:
                    if p.poll() is not None:
                        break
                    continue
                chunk = os.read(p.stdout.fileno(), 65536)
                if not chunk:
                    break
                pending += chunk
                if len(pending) > 65536:
                    raise ValueError('Cloud worker response exceeded the control limit')
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    frame = json.loads(line)
                    if frame.get('kind') == 'progress':
                        size = frame.get('bytes')
                        if type(size) is not int or not 0 <= size <= task['totalBytes']:
                            raise ValueError('Cloud progress is invalid')
                        self.check_current(task, bytes=size, phase=str(frame.get('stage', 'TRANSFER'))[:40])
                    elif frame.get('kind') == 'result' and result is None:
                        result = frame['result']
                    elif (frame.get('kind') == 'error' and task['action'] == 'verify'
                          and frame.get('errorCode') == 'CLOUD_CONFIRMATION_TIMEOUT'
                          and set(frame) <= {'kind', 'error', 'errorCode'}):
                        raise CloudConfirmationTimeout()
                    elif (frame.get('kind') == 'error' and task['action'] == 'download'
                          and frame.get('errorCode') == 'CLOUD_FILE_IDENTITY_CHANGED'
                          and frame.get('errorStage') in ('IDENTITY_BEFORE_TRANSFER', 'IDENTITY_AFTER_TRANSFER')
                          and set(frame) <= {'kind', 'error', 'errorCode', 'errorStage'}):
                        raise CloudFileIdentityChanged(frame['errorStage'])
                    elif frame.get('kind') not in ('retained',):
                        raise ValueError('Cloud transfer did not return a verified result')
            if p.wait(timeout=10) != 0 or pending or not isinstance(result, dict):
                raise ValueError('Cloud transfer did not complete; partial files are retained')
            expected_id = task['operationId'] if task['action'] == 'upload' else task['fileId']
            if result.get('id') != expected_id:
                raise ValueError('Cloud file identity did not match this operation')
            return result
        finally:
            selector.close()
            if p.poll() is None:
                p.terminate()
                try:p.wait(timeout=15)
                except subprocess.TimeoutExpired:p.kill(); p.wait(timeout=5)
            p.stdout.close()

    def worker(self, user, key, generation):
        task, lifetime, lock, fd, owned = None, None, None, None, False
        try:
            module, cache, owner, folder = self.storage(user, key)
            with module._directory(folder) as parent:
                lock = os.open('worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
            module._regular(lock)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.w.guard({'userId': user}, blocking=True):
                task = self.load(user, key)
                if str(task['generation']) != str(generation) or task['state'] not in ('QUEUED', 'CANCELING'):
                    return 0
                owned = True
                if task.get('cancelRequested'):
                    raise ValueError('Cloud operation canceled')
                self.w.writable({'userId': user}); self.w.no_terminals(user)
                lifetime = self.w.lifetime(user, exclusive=True)
                task['state'] = 'RUNNING'; self.save(task)
            if task['action'] == 'upload':
                fd, info = self.source(user, task['path'])
                if info.st_size != task['totalBytes']:
                    raise ValueError('Source size changed; no cloud upload started')
            elif task['action'] == 'download':
                if task.get('phase') == 'COMMITTING':
                    self.imports.commit(task, module, owner, folder, recovery=True)
                    self.check_current(task, state='READY', bytes=task['totalBytes'])
                    return 0
                with module._directory(folder) as parent:
                    fd = os.open('payload.part', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
                module._regular(fd)
                used = self.imports.usage(user, key)
                for other in self.tasks(user):
                    if other['operationId'] != key:
                        other_folder = self.storage(user, other['operationId'])[3]
                        try:used += (other_folder/'payload.part').lstat().st_size
                        except FileNotFoundError:pass
                if used+task['totalBytes'] > self.imports.limits['maxUserBytes']:
                    raise ValueError('Personal data storage allowance exceeded')
                self.imports.reservation(task, max(0, task['totalBytes']-os.fstat(fd).st_size)+65536)
            result = self.io(task, fd)
            if task['action'] == 'upload':
                if result.get('state') != 'VERIFYING' or result.get('size') != task['totalBytes'] or not re.fullmatch('[a-f0-9]{64}', result.get('sha256', '')) or not isinstance(result.get('receipt'), str):
                    raise ValueError('Cloud upload receipt is invalid')
                self.check_current(task, state='VERIFYING', bytes=task['totalBytes'], sha256=result['sha256'], receipt=result['receipt'])
            elif task['action'] == 'verify':
                if result.get('state') != 'VERIFIED' or not isinstance(result.get('receipt'), str):
                    raise ValueError('Cloud verification receipt is invalid')
                with self.w.guard({'userId': user}, blocking=True):
                    current = self.load(user, key)
                    if current.get('cancelRequested') or current['generation'] != task['generation']:
                        raise ValueError('Cloud verification canceled')
                    cloud = self.file_record(user, task['fileId'])
                    cloud.update(state=result['state'], receipt=result['receipt']); self.save(cloud)
                    task.update(state=result['state']); self.save(task)
            else:
                if result.get('state') != 'VERIFIED' or result.get('bytes') != task['totalBytes'] or result.get('sha256Verified') is not True:
                    raise ValueError('Cloud download verification failed')
                # Sealed receipt validates content inside the node worker.
                # Persist COMMITTING before making the file visible atomically.
                self.check_current(task, phase='COMMITTING', sha256=result['sha256'], bytes=result['bytes'])
                os.close(fd); fd = None
                self.imports.commit(task, module, owner, folder)
                self.check_current(task, state='READY')
            return 0
        except Exception as error:
            if task is not None and owned:
                with self.w.guard({'userId': user}, blocking=True):
                    current = self.load(user, key)
                    if str(current['generation']) == str(generation):
                        current.update(state='CANCELED' if current.get('cancelRequested') else ('PAUSED' if task['action'] == 'download' else 'FAILED'),
                            error='Cloud operation did not complete; existing local and cloud files are retained. Check status before retrying.')
                        if isinstance(error, CloudConfirmationTimeout) and not current.get('cancelRequested'):
                            current.update(phase='CLOUD_CONFIRMATION_TIMEOUT',
                                error='Cloud confirmation timed out before a stable remote file identity/hash was available. Uploaded files are retained, not retransmitted; start a new verification later.')
                        if isinstance(error, CloudFileIdentityChanged) and not current.get('cancelRequested'):
                            current.update(phase=error.stage, errorCode='CLOUD_FILE_IDENTITY_CHANGED',
                                error='Cloud file identity changed; reverify this file, then create a new download. Existing local/cloud files and this operation are retained.')
                        self.save(current)
            return 1
        finally:
            for handle in (fd, lifetime, lock):
                if handle is not None:os.close(handle)
            if task is not None and owned and task['action'] == 'download':
                try:self.imports.reservation(task, 0)
                except Exception:pass

    def process(self, operation, args):
        allowed = {'info': set(), 'list': set(), 'status': {'operationId'}, 'cancel': {'operationId'},
                   'upload': {'key', 'path'}, 'verify': {'key', 'fileId'}, 'download': {'key', 'fileId', 'path'}}
        action = operation.removeprefix('datasets.cloud.')
        if action not in allowed or not isinstance(args, dict) or set(args)-allowed[action]-{'userId', 'hostAdmin'} or args.get('hostAdmin', False) is not False:
            raise ValueError('Invalid private cloud request')
        self.n.workspace(args['userId'])
        if action == 'info':
            c = self.n.CONFIG.get('cloudFiles', {})
            return {'enabled': c.get('enabled') is True, 'nodeLocal': True, 'vpsRelay': False,
                    'maxFileBytes': self.config()['maxFileBytes'] if c.get('enabled') is True else 0}
        with self.w.guard(args, blocking=True):
            if action == 'list':
                tasks = sorted(self.tasks(args['userId']), key=lambda t: t['createdAt'], reverse=True)
                return {'files': [self.public(t) for t in tasks[:50]], 'total': len(tasks), 'limit': 50}
            if action in ('upload', 'verify', 'download'):
                return self.start(action, args)
            task = self.load(args['userId'], args.get('operationId'))
            if action == 'cancel' and task['state'] in ACTIVE:
                task['cancelRequested'] = True
                task['state'] = 'CANCELED' if self.stopped(task) else 'CANCELING'
                self.save(task)
            return self.public(task)
