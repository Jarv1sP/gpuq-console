#!/usr/bin/env python3
"""Explicit administrator setup plus a bounded, non-GPU enforcement probe.

Never reexec/restart a manager or a job. This is an installer helper, not a
sudoers capability exposed to console users.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import time


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=20).stdout


def delegation_content(existing):
    controllers = set(existing.split()) | {'cpu', 'memory', 'pids'}
    if any(not re.fullmatch(r'[a-z][a-z0-9_]*', item) for item in controllers):
        raise ValueError('Invalid existing DelegateControllers')
    return '[Service]\nDelegate=' + ' '.join(sorted(controllers)) + '\n'


def write_dropin(directory, content, owner=0):
    """Only replace our one regular file, retaining an owner-private backup."""
    directory = Path(directory)
    for path in (directory.parent, directory):
        if path == directory:
            try: path.mkdir(mode=0o755)
            except FileExistsError: pass
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
            raise ValueError('CPU delegation directory must be trusted and not linked')
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = '90-gpuq-console-cpu.conf'
    temporary = '.gpuq-cpu-' + os.urandom(12).hex()
    backup = None
    try:
        try: previous = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except FileNotFoundError: previous = None
        if previous is not None:
            try:
                info = os.fstat(previous)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != owner or info.st_mode & 0o022:
                    raise ValueError('CPU delegation drop-in must be a trusted regular file')
                raw = os.read(previous, 65537)
                if len(raw) > 65536: raise ValueError('CPU delegation drop-in is unexpectedly large')
            finally: os.close(previous)
            if raw == content.encode(): return {'changed': False, 'path': str(directory / name), 'backup': None}
            backup = name + '.before-' + str(time.time_ns())
            out = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            with os.fdopen(out, 'wb') as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=fd)
        with os.fdopen(out, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o644)
            stream.write(content.encode()); stream.flush(); os.fsync(stream.fileno())
        os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
        return {'changed': True, 'path': str(directory / name), 'backup': str(directory / backup) if backup else None}
    finally:
        try: os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError: pass
        os.close(fd)


def configure(uid):
    if os.geteuid() != 0: raise ValueError('CPU delegation setup requires explicit administrator execution')
    if type(uid) is not int or uid <= 0: raise ValueError('A non-root service UID is required')
    pwd.getpwuid(uid)
    supported = Path('/sys/fs/cgroup/cgroup.controllers').read_text().split()
    if not {'cpu', 'memory', 'pids'} <= set(supported): raise ValueError('Required cgroup v2 controllers are unavailable')
    unit = f'user@{uid}.service'
    existing = run('/usr/bin/systemctl', 'show', unit, '--property=DelegateControllers', '--value')
    result = write_dropin(Path('/etc/systemd/system') / (unit + '.d'), delegation_content(existing))
    run('/usr/bin/systemctl', 'daemon-reload')
    result.update(unit=unit, appliedToActiveManager=False,
                  next='No user manager was restarted or reexecuted. Administrator: inspect live controllers; if missing, confirm a maintenance window before a same-value CPUWeight apply and user daemon-reexec, then rerun the enforcement probe.')
    return result


PROBE = '''import json,pathlib
group=next(line.split(':',2)[2] for line in pathlib.Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
root=pathlib.Path('/sys/fs/cgroup')/group.lstrip('/')
cpu=(root/'cpu.max').read_text().split()
memory=int((root/'memory.max').read_text())
pids=int((root/'pids.max').read_text())
assert len(cpu)==2 and cpu[0]!='max' and 0<int(cpu[0])<=int(cpu[1]),'CPU quota is not enforced'
assert 0<memory<=134217728 and 0<pids<=32,'Memory/PID limits are not enforced'
print(json.dumps({'cpuMax':' '.join(cpu),'memoryMax':memory,'pidsMax':pids}))
'''


def probe():
    if os.geteuid() == 0: raise ValueError('Run the enforcement probe as the GPUQ service user')
    output = run('/usr/bin/systemd-run', '--user', '--quiet', '--wait', '--pipe', '--collect',
                 '--property=Type=exec', '--property=CPUQuota=100%', '--property=MemoryMax=128M',
                 '--property=TasksMax=32', '--property=RuntimeMaxSec=10',
                 '/usr/bin/python3', '-c', PROBE)
    return json.loads(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--configure', type=int, metavar='SERVICE_UID')
    action.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try: print(json.dumps(probe() if args.check else configure(args.configure)))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        raise SystemExit('CPU delegation is not ready: ' + str(error) + '\nDo not restart user@ or GPUQ automatically; request administrator review, then rerun --check.')
