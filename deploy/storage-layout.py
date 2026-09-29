#!/usr/bin/env python3
"""Preview or establish /data2 without moving, deleting, or changing data owners.

Existing data filesystems are preserved. Otherwise supply a dedicated directory
on an already mounted local data filesystem, for example:
  sudo python3 deploy/storage-layout.py --source /data-disk/gpuq-data2
  sudo python3 deploy/storage-layout.py --source /data-disk/gpuq-data2 --apply

Only the second invocation writes. This manages the root mapping only, not
datasets, caches, user workspaces, disk formatting, or the source disk's mount.
Consumers must depend on /data2 being mounted; an ordinary path existing is not
proof that storage is available. No service or machine is restarted.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time


TARGET = Path('/data2')
UNIT_DIR = Path('/etc/systemd/system')
MARKER = '# Managed by GPUQ Console storage-layout.py (v1)\n'
LOCAL_FILESYSTEMS = {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'bcachefs'}


class LayoutError(ValueError):
    pass


def unescape_mount(value):
    return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match.group(1), 8)), value)


def read_mounts(path=Path('/proc/self/mountinfo')):
    mounts = []
    for line in path.read_text().splitlines():
        before, separator, after = line.partition(' - ')
        left, right = before.split(), after.split()
        if not separator or len(left) < 6 or len(right) < 3:
            raise LayoutError('Malformed mountinfo; refusing to guess the storage layout')
        mounts.append({'target': unescape_mount(left[4]), 'device': left[2],
                       'root': unescape_mount(left[3]), 'options': left[5].split(','),
                       'fstype': right[0], 'source': unescape_mount(right[1]),
                       'superOptions': right[2].split(',')})
    return mounts


def within(path, parent):
    return path == parent or parent in path.parents


def containing_mount(path, mounts):
    candidates = [mount for mount in mounts if within(path, Path(mount['target']))]
    if not candidates:
        raise LayoutError('No active mount covers ' + str(path))
    # Last entry wins for overmounts at the same path.
    return max(enumerate(candidates), key=lambda item: (len(Path(item[1]['target']).parts), item[0]))[1]


def safe_path(value):
    path = Path(value)
    if (not path.is_absolute() or '..' in path.parts or str(path) != str(value)
            or not re.fullmatch(r'/[A-Za-z0-9._+/-]+', str(path))):
        raise LayoutError('Use a normalized absolute path with plain path characters: ' + str(value))
    return path


def real_directory_chain(path, missing_leaf=False):
    for part in reversed((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            if part == path and missing_leaf:
                return False
            raise LayoutError('Directory does not exist: ' + str(part))
        if not stat.S_ISDIR(info.st_mode):
            raise LayoutError('Symlinks and non-directories are not allowed: ' + str(part))
    return True


def trusted_parents(path, allowed_uids=()):
    """A persistent mount source must not be replaceable by an ordinary user."""
    for parent in path.parents:
        info = parent.lstat()
        if info.st_uid not in {0, *allowed_uids} or info.st_mode & 0o022:
            raise LayoutError('Mount path has an untrusted/writable parent: ' + str(parent))


def data_mount(path, mounts):
    mount = containing_mount(path, mounts)
    root = containing_mount(Path('/'), mounts)
    if (mount['target'] == '/' or mount['device'] == root['device']
            or mount['fstype'] not in LOCAL_FILESYSTEMS):
        raise LayoutError('Not an independently mounted local data filesystem (no root-disk fallback): ' + str(path))
    if 'ro' in mount['options'] or 'ro' in mount.get('superOptions', []):
        raise LayoutError('Data filesystem is read-only: ' + str(path))
    return mount


def check_fstab(target, fstab):
    # Do not create a competing unit over any existing fstab management.
    if not fstab.exists():
        return
    for line in fstab.read_text().splitlines():
        fields = line.strip().split()
        if fields and not fields[0].startswith('#') and len(fields) > 1:
            if unescape_mount(fields[1]) == str(target):
                raise LayoutError('Existing fstab entry manages ' + str(target) + '; preserve or review it manually')


def unit_text(source, target, source_mount):
    return (MARKER + '[Unit]\nDescription=GPUQ data storage entry point\n'
            'RequiresMountsFor=' + source_mount + '\n'
            'AssertPathIsMountPoint=' + source_mount + '\n'
            'AssertPathIsDirectory=' + str(source) + '\n\n'
            '[Mount]\nWhat=' + str(source) + '\nWhere=' + str(target) + '\n'
            'Type=none\nOptions=bind\nTimeoutSec=30\n\n'
            '[Install]\nWantedBy=multi-user.target\n')


def checked_unit(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or info.st_mode & 0o022:
        raise LayoutError('Unsafe mount unit: ' + str(path))
    content = path.read_text()
    if not content.startswith(MARKER):
        raise LayoutError('Existing mount unit is not managed by this tool: ' + str(path))
    return content


def build_plan(source=None, *, target=TARGET, mounts=None, fstab=Path('/etc/fstab'), unit_dir=UNIT_DIR,
               trusted_parent_uids=()):
    target = safe_path(str(target))
    trusted_parent_uids = sorted(set(trusted_parent_uids))
    if any(type(uid) is not int or uid < 1 or uid >= 2**32 - 1 for uid in trusted_parent_uids):
        raise LayoutError('Trusted parent UID must be an explicit positive local administrator UID')
    mounts = read_mounts() if mounts is None else mounts
    target_exists = real_directory_chain(target, missing_leaf=True)
    if source is None:
        if not target_exists:
            raise LayoutError(str(target) + ' is absent; supply --source on an already mounted data disk')
        current = data_mount(target, mounts)
        return {'action': 'preserve', 'target': str(target), 'filesystem': current,
                'note': 'Existing data directory/mount left unchanged; its boot persistence is not altered.'}

    source = safe_path(str(source))
    if within(source, target) or within(target, source):
        raise LayoutError('Source and target must be distinct, non-nested paths')
    source_exists = real_directory_chain(source, missing_leaf=True)
    trusted_parents(source, trusted_parent_uids)
    trusted_parents(target)
    current = data_mount(source, mounts)
    source_mount = safe_path(current['target'])
    if source == source_mount:
        raise LayoutError('Use a dedicated subdirectory, not the entire data mount')
    if any(within(Path(mount['target']), source) for mount in mounts):
        raise LayoutError('Source contains a nested mount; refusing to change its view')
    exact_target = any(Path(mount['target']) == target for mount in mounts)
    for mount in mounts:
        if Path(mount['target']) != target and within(Path(mount['target']), target):
            raise LayoutError('Target contains a nested mount; refusing to cover it')
    already_bound = (target_exists and source_exists and exact_target and os.path.samefile(source, target))
    if exact_target and not already_bound:
        raise LayoutError('Target is already a different mount; it will not be replaced')
    if target_exists and not already_bound and next(target.iterdir(), None) is not None:
        raise LayoutError('Target is non-empty; no existing data will be hidden or moved')
    check_fstab(target, fstab)
    # CLI target is fixed /data2. Tests may supply a private, temporary target.
    unit_path = unit_dir / 'data2.mount'
    old = checked_unit(unit_path)
    content = unit_text(source, target, str(source_mount))
    return {'action': 'bind', 'source': str(source), 'target': str(target),
            'sourceMount': str(source_mount), 'sourceDevice': current['device'],
            'sourceFilesystem': current['fstype'], 'createSource': not source_exists,
            'createTarget': not target_exists, 'alreadyBound': already_bound,
            'unit': str(unit_path), 'unitChanged': old != content,
            'unitContent': content,
            'trustedParentUids': trusted_parent_uids,
            'trustAssumption': ('Source-path parent owners listed in trustedParentUids are explicitly trusted host administrators; their existing ownership is preserved.' if trusted_parent_uids else 'Only root-owned source-path parents are trusted.'),
            'note': 'Source-disk boot mounting must already be configured; missing source mount fails closed. No data is moved or ownership changed.'}


def write_unit(path, content):
    old = checked_unit(path)
    if old == content:
        return None
    backup = None
    if old is not None:
        backup = path.with_name(path.name + '.backup-' + str(time.time_ns()))
        # Exclusive backup creation prevents accidental replacement of any file.
        with backup.open('x') as stream:
            stream.write(old)
        shutil.copystat(path, backup, follow_symlinks=False)
    descriptor, temporary = tempfile.mkstemp(prefix='.data2.mount-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return str(backup) if backup else None


def run_systemctl(*args):
    return subprocess.run(['systemctl', *args], check=True, text=True, capture_output=True, timeout=45)


def apply_plan(plan):
    if os.geteuid() != 0:
        raise LayoutError('--apply requires root')
    if plan['action'] == 'preserve':
        return {'status': 'preserved', 'target': plan['target'], 'changed': False}
    source, target, unit = Path(plan['source']), Path(plan['target']), Path(plan['unit'])
    real_directory_chain(unit.parent)
    trusted_parents(unit)
    # Re-read all mount and directory state immediately before the first mutation.
    fresh = build_plan(source, target=target, unit_dir=unit.parent,
                       trusted_parent_uids=plan.get('trustedParentUids', []))
    if (fresh['sourceMount'], fresh['sourceDevice']) != (plan['sourceMount'], plan['sourceDevice']):
        raise LayoutError('Source mount changed since inspection; nothing applied')
    for path, create in [(source, fresh['createSource']), (target, fresh['createTarget'])]:
        if create:
            path.mkdir(mode=0o755)
    backup = write_unit(unit, fresh['unitContent'])
    if fresh['unitChanged']:
        run_systemctl('daemon-reload')
    # Start only this mount, never mount -a, restart a service, or reboot a host.
    run_systemctl('start', 'data2.mount')
    live = read_mounts()
    data_mount(target, live)
    if not any(Path(item['target']) == target for item in live) or not os.path.samefile(source, target):
        raise LayoutError('Mount verification failed; unit left for review, existing data untouched')
    run_systemctl('enable', 'data2.mount')
    return {'status': 'mounted', 'source': str(source), 'target': str(target),
            'changed': not fresh['alreadyBound'] or fresh['unitChanged'], 'backup': backup,
            'trustedParentUids': fresh['trustedParentUids'], 'trustAssumption': fresh['trustAssumption'],
            'note': 'Enabled for boot; no reboot performed. Verify data2.mount before starting storage consumers.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', help='Dedicated directory on an already mounted local data disk')
    parser.add_argument('--trusted-parent-uid', type=int, action='append', default=[],
                        help='Explicitly trust this existing source-parent owner as a host administrator; never changes ownership. Repeat if needed. Default: root only.')
    parser.add_argument('--apply', action='store_true', help='Explicitly create/persist/start the mapping; default is read-only')
    args = parser.parse_args(argv)
    try:
        if not args.apply:
            print(json.dumps({'dryRun': True, **build_plan(args.source, trusted_parent_uids=args.trusted_parent_uid)}, indent=2))
            return 0
        if os.geteuid() != 0:
            raise LayoutError('--apply requires root')
        # Process lock protects concurrent invocations, without touching any data.
        lock = os.open('/run/lock/gpuq-storage-layout.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            lock_info = os.fstat(lock)
            if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1 or lock_info.st_uid != 0:
                raise LayoutError('Unsafe storage-layout process lock')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = apply_plan(build_plan(args.source, trusted_parent_uids=args.trusted_parent_uid))
        finally:
            os.close(lock)
        print(json.dumps(result, indent=2))
        return 0
    except (LayoutError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'error': str(error), 'note': 'No data moved/deleted or ownership changed. Review any prepared mount unit; do not reboot to test.'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
