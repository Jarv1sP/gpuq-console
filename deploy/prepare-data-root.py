#!/usr/bin/env python3
"""Safely prepare the service-private /data2/datasets cache directory.

Default is preview. --apply creates only a missing datasets directory, assigns
its requested service owner and mode 0700, and never changes an existing object.
The /data2 entry must be an exact, writable, independently mounted local data
filesystem. This tool does not mount disks, migrate data, initialize cache
contents, modify existing ownership, or start services.

Example: sudo python3 prepare-data-root.py --service-user dataset-service --apply
If an existing /data2 belongs to a trusted host administrator rather than root,
explicitly acknowledge that owner with --trusted-parent-uid UID. Do not grant
this trust to ordinary users: that owner can replace paths below the mount.
"""
import argparse
import contextlib
import fcntl
import grp
import json
import os
from pathlib import Path
import pwd
import re
import stat


DATA_ROOT = Path('/data2')
LOCAL_FILESYSTEMS = {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'bcachefs'}


class PreparationError(ValueError):
    pass


def _unescape(value):
    return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match.group(1), 8)), value)


def read_mounts(path=Path('/proc/self/mountinfo')):
    result = []
    for line in path.read_text().splitlines():
        left, separator, right = line.partition(' - ')
        before, after = left.split(), right.split()
        if not separator or len(before) < 6 or len(after) < 3:
            raise PreparationError('Malformed mount table; refusing to guess')
        result.append({'id': before[0], 'target': _unescape(before[4]), 'device': before[2],
                       'fstype': after[0], 'options': before[5].split(','),
                       'superOptions': after[2].split(',')})
    return result


def checked_path(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise PreparationError('Storage path must be absolute without traversal')
    return path


@contextlib.contextmanager
def directory(path):
    """No symbolic-link traversal, including any ancestor directory."""
    path = checked_path(path)
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def device_id(descriptor):
    number = os.fstat(descriptor).st_dev
    return str(os.major(number)) + ':' + str(os.minor(number))


def mount_state(root, descriptor, mounts=None):
    rows = read_mounts() if mounts is None else mounts
    current = [row for row in rows if row['target'] == str(root)]
    system = [row for row in rows if row['target'] == '/']
    if not current or not system:
        raise PreparationError('Storage root must be an exact active mount, not an ordinary directory')
    current, system = current[-1], system[-1]
    if current['device'] == system['device'] or current['fstype'] not in LOCAL_FILESYSTEMS:
        raise PreparationError('Storage must be a local data filesystem, never the root filesystem')
    if 'ro' in current['options'] or 'ro' in current.get('superOptions', []):
        raise PreparationError('Storage filesystem is read-only')
    if device_id(descriptor) != current['device']:
        raise PreparationError('Opened directory no longer matches the active data mount')
    cache = root / 'datasets'
    if any(Path(row['target']) == cache or cache in Path(row['target']).parents for row in rows):
        raise PreparationError('Existing datasets submount will not be modified or adopted')
    return {key: current[key] for key in ('id', 'device', 'fstype')}


def validated_trust(values):
    if any(type(uid) is not int or uid < 1 or uid >= 2**32 - 1 for uid in values):
        raise PreparationError('Trusted parent UID must be a positive local administrator UID')
    return sorted(set(values))


def check_parent(info, trusted_uids):
    if info.st_uid not in {0, *trusted_uids} or info.st_mode & 0o022:
        raise PreparationError('Storage parent must have a trusted owner and no group/other write permission')


def resolve_service(username, groupname=None):
    try:
        user = pwd.getpwnam(username)
        group = grp.getgrnam(groupname) if groupname else grp.getgrgid(user.pw_gid)
    except KeyError as error:
        raise PreparationError('Service user/group does not exist; no account will be created') from error
    return {'user': user.pw_name, 'uid': user.pw_uid, 'group': group.gr_name, 'gid': group.gr_gid}


def check_existing(parent_fd, identity):
    try:
        info = os.stat('datasets', dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(info.st_mode):
        raise PreparationError('Existing datasets path is not a real directory; nothing changed')
    if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (identity['uid'], identity['gid'], 0o700):
        raise PreparationError('Existing datasets owner/group/mode differs from requested service:0700; review manually, no automatic chown/chmod')
    return True


def build_plan(username, groupname=None, *, trusted_parent_uids=(), root=DATA_ROOT, mounts=None):
    root = checked_path(root)
    trusted = validated_trust(trusted_parent_uids)
    identity = resolve_service(username, groupname)
    with directory(root) as descriptor:
        state = mount_state(root, descriptor, mounts)
        info = os.fstat(descriptor)
        check_parent(info, trusted)
        exists = check_existing(descriptor, identity)
    return {'action': 'preserve' if exists else 'create', 'root': str(root),
            'path': str(root / 'datasets'), 'mount': state, 'rootInode': info.st_ino,
            'service': identity, 'mode': '0700', 'trustedParentUids': trusted,
            'trustAssumption': 'Only root and the explicitly listed host-administrator UIDs may control the storage parent; existing data/owners remain unchanged.',
            'cacheConfig': {'root': str(root / 'datasets'), 'serviceUid': identity['uid'], 'serviceGid': identity['gid']}}


def apply_plan(plan):
    if os.geteuid() != 0:
        raise PreparationError('--apply requires root; it only assigns ownership to a newly created directory')
    root = checked_path(plan['root'])
    identity = resolve_service(plan['service']['user'], plan['service']['group'])
    if identity != plan['service']:
        raise PreparationError('Service identity changed after preview; nothing applied')
    trusted = validated_trust(plan['trustedParentUids'])
    with directory(root) as descriptor:
        state = mount_state(root, descriptor)
        info = os.fstat(descriptor)
        check_parent(info, trusted)
        if state != plan['mount'] or info.st_ino != plan['rootInode']:
            raise PreparationError('Storage mount changed after preview; nothing applied')
        if check_existing(descriptor, identity):
            return {**plan, 'status': 'preserved', 'changed': False}
        # The open mount FD pins this filesystem: a concurrent path replacement
        # cannot redirect mkdir/chown into a newly exposed root-disk directory.
        try:
            os.mkdir('datasets', 0o700, dir_fd=descriptor)
        except FileExistsError:
            if check_existing(descriptor, identity):
                return {**plan, 'status': 'preserved', 'changed': False}
            raise PreparationError('datasets changed during preparation; nothing adopted')
        child = os.open('datasets', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
        try:
            # Only this newly created inode is changed. Never recurse or repair
            # an existing directory, even if it was empty at preview time.
            os.fchown(child, identity['uid'], identity['gid'])
            os.fchmod(child, 0o700)
            os.fsync(child)
        finally:
            os.close(child)
        os.fsync(descriptor)
        check_existing(descriptor, identity)
        # If a privileged actor removed/replaced the mount concurrently, report
        # failure rather than claiming the currently visible /data2 is usable.
        final = mount_state(root, descriptor)
        if final != state:
            raise PreparationError('Storage mount changed during preparation; data not removed, recheck before use')
    return {**plan, 'status': 'prepared', 'changed': True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--service-user', required=True, help='Existing account which runs dataset-cache')
    parser.add_argument('--service-group', help='Existing group; default is the account primary group')
    parser.add_argument('--trusted-parent-uid', action='append', type=int, default=[], help='Explicitly trust an existing storage-parent owner as a host administrator')
    parser.add_argument('--apply', action='store_true', help='Create only missing datasets directory; default is read-only preview')
    args = parser.parse_args(argv)
    try:
        kwargs = {'trusted_parent_uids': args.trusted_parent_uid}
        if not args.apply:
            print(json.dumps({'dryRun': True, **build_plan(args.service_user, args.service_group, **kwargs)}, indent=2))
            return 0
        if os.geteuid() != 0:
            raise PreparationError('--apply requires root')
        lock = os.open('/run/lock/gpuq-prepare-data-root.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(lock)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0:
                raise PreparationError('Unsafe preparation lock')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = apply_plan(build_plan(args.service_user, args.service_group, **kwargs))
        finally:
            os.close(lock)
        print(json.dumps(result, indent=2))
        return 0
    except (PreparationError, OSError) as error:
        print(json.dumps({'error': str(error), 'note': 'No existing data deleted, moved or permission-repaired. Any newly created directory is left for review.'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
