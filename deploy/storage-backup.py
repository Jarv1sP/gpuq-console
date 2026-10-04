#!/usr/bin/env python3
"""Root-only, local restic backup with pinned physical mounts.

Does not initialize repositories, prune snapshots, restore data, or stop jobs.
An online file backup is not an application-consistent database snapshot.
Recovering platform registrations requires the normal identity/rebind checks.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import time
import uuid


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def path_check(path, *, private=False, directory=False):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'ABSOLUTE_PATH_REQUIRED')
    for component in [*reversed(path.parents), path]:
        info = component.lstat()
        require(not stat.S_ISLNK(info.st_mode), 'SYMLINK_COMPONENT')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'WRONG_PATH_TYPE')
    if private:
        require(info.st_uid == 0 and not info.st_mode & 0o077, 'PRIVATE_ROOT_CONTROL_REQUIRED')
    return info


def read_config(path):
    path_check(Path(path).parent, private=True, directory=True)
    path_check(path, private=True)
    config = json.loads(Path(path).read_text())
    require(set(config) == {'schema', 'host', 'repository', 'passwordFile', 'stateDirectory',
                            'mounts', 'sources', 'reserveBytes', 'reserveInodes'}, 'CONFIG_FIELDS')
    require(config['schema'] == 1 and config['host'] == socket.gethostname(), 'HOST_MISMATCH')
    require(type(config['reserveBytes']) is int and config['reserveBytes'] >= 20 * 1024**3,
            'CAPACITY_RESERVE_REQUIRED')
    require(type(config['reserveInodes']) is int and config['reserveInodes'] >= 10000,
            'INODE_RESERVE_REQUIRED')
    require(isinstance(config['sources'], list) and 0 < len(config['sources']) <= 32 and
            len(set(config['sources'])) == len(config['sources']), 'SOURCE_LIST')
    require(isinstance(config['mounts'], dict) and config['mounts'], 'MOUNT_PINS_REQUIRED')
    for field in ('repository', 'passwordFile', 'stateDirectory'):
        require(isinstance(config[field], str) and Path(config[field]).is_absolute() and
                '..' not in Path(config[field]).parts, 'ABSOLUTE_LOCAL_CONTROL_REQUIRED')
    require(all(isinstance(source, str) and Path(source).is_absolute() and
                source != '/' and '..' not in Path(source).parts for source in config['sources']),
            'BOUNDED_ABSOLUTE_SOURCES_REQUIRED')
    for mount, expected in config['mounts'].items():
        require(set(expected) == {'uuid', 'fstype'} and
                re.fullmatch('[a-fA-F0-9-]+', expected['uuid']), 'MOUNT_PIN_FIELDS')
        require(Path(mount).is_absolute(), 'MOUNT_ABSOLUTE')
    return config


def mounts(config):
    result = {}
    for path, expected in config['mounts'].items():
        path_check(path, directory=True)
        query = subprocess.run(['/usr/bin/findmnt', '-J', '-T', path, '-o',
                                'TARGET,UUID,FSTYPE,FSROOT,MAJ:MIN,OPTIONS'],
                               check=True, capture_output=True, text=True, timeout=10)
        rows = json.loads(query.stdout)['filesystems']
        require(len(rows) == 1, 'AMBIGUOUS_MOUNT')
        row = rows[0]
        require(row['target'] == path and row['uuid'] == expected['uuid'] and
                row['fstype'] == expected['fstype'] and row['fsroot'] == '/' and
                'rw' in row['options'].split(','), 'WRONG_OR_MISSING_MOUNT')
        result[path] = row
    return result


def enclosing(path, mount_map):
    candidates = [mount for mount in mount_map if Path(path).is_relative_to(mount)]
    require(candidates, 'UNPINNED_PATH')
    return max(candidates, key=len)


def actual_mount(path, expected):
    query = subprocess.run(['/usr/bin/findmnt', '-J', '-T', str(path), '-o',
                            'TARGET,UUID,FSTYPE,FSROOT,MAJ:MIN,OPTIONS'],
                           check=True, capture_output=True, text=True, timeout=10)
    rows = json.loads(query.stdout)['filesystems']
    require(len(rows) == 1 and rows[0] == expected, 'UNEXPECTED_PATH_MOUNT')
    device = Path(path).stat().st_dev
    require(f'{os.major(device)}:{os.minor(device)}' == expected['maj:min'], 'PATH_DEVICE_MISMATCH')


def no_nested_source_mounts(sources, mountinfo):
    for line in mountinfo.splitlines():
        fields = line.split()
        require(len(fields) >= 6, 'INVALID_MOUNTINFO')
        target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match.group(1), 8)), fields[4])
        for source in sources:
            require(not target.startswith(source.rstrip('/') + '/'), 'NESTED_SOURCE_MOUNT')


def guard(config, baseline=None):
    current = mounts(config)
    if baseline is not None:
        require(current == baseline, 'MOUNT_CHANGED_DURING_BACKUP')
    for key in ('repository', 'stateDirectory'):
        path_check(config[key], private=True, directory=True)
    path_check(config['passwordFile'], private=True)
    path_check(Path(config['passwordFile']).parent, private=True, directory=True)
    repo_mount = enclosing(config['repository'], current)
    require(repo_mount != '/', 'BACKUP_REPOSITORY_ON_SYSTEM_DISK')
    path_check(repo_mount, private=True, directory=True)
    require(enclosing(config['stateDirectory'], current) == repo_mount, 'STATE_NOT_ON_BACKUP_DISK')
    actual_mount(config['repository'], current[repo_mount])
    actual_mount(config['stateDirectory'], current[repo_mount])
    for source in config['sources']:
        path_check(source, directory=Path(source).is_dir())
        source_mount = enclosing(source, current)
        actual_mount(source, current[source_mount])
        require(current[source_mount]['maj:min'] != current[repo_mount]['maj:min'],
                'SOURCE_AND_BACKUP_SAME_PHYSICAL_VOLUME')
        require(not Path(config['repository']).is_relative_to(source), 'RECURSIVE_BACKUP')
    no_nested_source_mounts([*config['sources'], config['repository'], config['stateDirectory']],
                            Path('/proc/self/mountinfo').read_text())
    capacity = os.statvfs(config['repository'])
    require(capacity.f_bavail * capacity.f_frsize >= config['reserveBytes'] and
            capacity.f_favail >= config['reserveInodes'], 'BACKUP_DISK_RESERVE_REACHED')
    return current


def persist(path, value):
    temporary = path.parent / ('.write-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(value, file, sort_keys=True); file.write('\n'); file.flush(); os.fsync(file.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def restic(config, args):
    # No inherited RESTIC_*, HTTP_PROXY, shell command or remote repository.
    return ['/usr/bin/restic', '--repo', config['repository'], '--password-file',
            config['passwordFile'], '--no-cache', *args]


def run(config, action):
    require(os.geteuid() == 0 and action in ('backup', 'check-all'), 'ROOT_AND_VALID_ACTION_REQUIRED')
    baseline = guard(config)
    state = Path(config['stateDirectory'])
    lock = os.open(state / '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(lock)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and
            not info.st_mode & 0o077, 'UNSAFE_LOCK')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    record = {'schema': 1, 'action': action, 'run': uuid.uuid4().hex, 'startedAt': time.time(),
              'phase': 'RUNNING', 'host': config['host'], 'sources': config['sources'],
              'consistency': 'file-level; application restore requires reconciliation',
              'automaticDeletion': False}
    file = state / (record['run'] + '.json')
    persist(file, record)
    persist(state / 'latest.json', record)
    args = (['--json', 'backup', '--one-file-system', '--host', config['host'],
             '--tag', 'gpuq-independent-backup', *config['sources']] if action == 'backup'
            else ['check', '--read-data'])
    log_path = state / (record['run'] + '.log')
    env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
           'GOMAXPROCS': '2'}
    process = None
    try:
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as log:
            process = subprocess.Popen(restic(config, args), stdout=log, stderr=subprocess.STDOUT, env=env)
            while process.poll() is None:
                guard(config, baseline)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    continue
            log.flush(); os.fsync(log.fileno())
        require(process.returncode == 0, 'RESTIC_INCOMPLETE_OR_FAILED')
        guard(config, baseline)
        record.update(phase='BACKUP_COMPLETE' if action == 'backup' else 'FULL_DATA_CHECK_PASSED',
                      exitCode=process.returncode, log=str(log_path))
    except BaseException as error:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=10)
        record.update(phase='REVIEW_REQUIRED', reason=str(error) if isinstance(error, RuntimeError)
                      else type(error).__name__, exitCode=process.returncode if process else None)
        raise
    finally:
        record['finishedAt'] = time.time(); persist(file, record)
        persist(state / 'latest.json', record); os.close(lock)
    print(json.dumps({'phase': record['phase'], 'receipt': str(file)}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('backup', 'check-all'))
    parser.add_argument('--config', default='/etc/gpuq-backup/config.json')
    args = parser.parse_args()
    run(read_config(args.config), args.action)


if __name__ == '__main__':
    main()
