#!/usr/bin/env python3
"""Preview/apply one trusted-host, read-only NFS dataset publication source.

Server: --peer RFC1918_IP (repeat), --service-user EXISTING_CACHE_USER.
Client: --server RFC1918_IP. The fixed NFSv4 root is mounted at /data2/library;
materialization sources are /data2/library/DATASET/VERSION/data. Training must
use a verified local cache, not this mount. Both cache services need matching
numeric UID/GID. This is trusted-host AUTH_SYS sharing, NOT tenant isolation.

Only a dedicated exports file or mount unit is created. Existing data and
permissions are never repaired, migrated or removed. Changing an installed
configuration requires an explicit operator review; this helper will not
silently replace it. Missing NFS packages must be installed separately.
"""
import argparse
import contextlib
import fcntl
import grp
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shlex
import stat
import subprocess


DATA_ROOT = Path('/data2')
EXPORTS = Path('/etc/exports')
EXPORTS_DIR = Path('/etc/exports.d')
UNIT_DIR = Path('/etc/systemd/system')
FSTAB = Path('/etc/fstab')
EXPORT_NAME = 'gpuq-datasets.exports'
UNIT_NAME = 'data2-library.mount'
MARKER = '# Managed by GPUQ Console dataset-nfs.py v1\n'
LOCAL_FS = {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'bcachefs'}
PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
MOUNT_OPTIONS = 'vers=4.2,proto=tcp,sec=sys,ro,nosuid,nodev,noexec,hard'


class SetupError(ValueError):
    pass


def private_ipv4(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError as error:
        raise SetupError('Require an explicit RFC1918 IPv4 host, not a hostname/subnet') from error
    if ip.version != 4 or not any(ip in net for net in PRIVATE_NETS):
        raise SetupError('Require an explicit RFC1918 IPv4 host, not public/loopback/link-local space')
    return str(ip)


def unescape(value):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), value)


def read_mounts():
    rows = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, sep, right = line.partition(' - ')
        a, b = left.split(), right.split()
        if not sep or len(a) < 6 or len(b) < 3:
            raise SetupError('Malformed mount table')
        rows.append({'id': a[0], 'device': a[2], 'target': unescape(a[4]),
                     'options': a[5].split(','), 'fstype': b[0],
                     'source': unescape(b[1]), 'superOptions': b[2].split(',')})
    return rows


@contextlib.contextmanager
def directory(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise SetupError('Directory must be absolute without traversal')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def device_id(fd):
    dev = os.fstat(fd).st_dev
    return f'{os.major(dev)}:{os.minor(dev)}'


def trusted_info(info, uids=()):
    if info.st_uid not in {0, *uids} or info.st_mode & 0o022:
        raise SetupError('Directory must have a trusted administrator owner and no group/other write')


def trusted_config_dir(path):
    path = Path(path)
    for parent in reversed((path, *path.parents)):
        with directory(parent) as fd:
            trusted_info(os.fstat(fd))


def storage_state(root, fd, rows, trusted_uids):
    exact = [r for r in rows if r['target'] == str(root)]
    system = [r for r in rows if r['target'] == '/']
    if not exact or not system:
        raise SetupError('/data2 must be an exact active mount, not a bare directory')
    entry = exact[-1]
    if entry['device'] == system[-1]['device'] or entry['fstype'] not in LOCAL_FS:
        raise SetupError('/data2 must be an independent local data filesystem, never the root device')
    if 'ro' in entry['options'] or 'ro' in entry['superOptions']:
        raise SetupError('/data2 must be writable')
    if device_id(fd) != entry['device']:
        raise SetupError('Opened data directory does not match mount table')
    info = os.fstat(fd)
    trusted_info(info, trusted_uids)
    return {'id': entry['id'], 'device': entry['device'], 'inode': info.st_ino}


def root_group_is_administrative():
    """Only UID 0 accounts may have primary/supplementary membership in GID 0."""
    try:
        group = grp.getgrgid(0)
        users = pwd.getpwall()
        if not users or group.gr_gid != 0:
            return False
        if any(user.pw_gid == 0 and user.pw_uid != 0 for user in users):
            return False
        return all(pwd.getpwnam(name).pw_uid == 0 for name in group.gr_mem)
    except (KeyError, OSError):
        return False


def safe_text(path, *, optional=True, allow_root_group_write=False):
    path = Path(path)
    trusted_config_dir(path.parent)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        if optional:
            return None
        raise
    try:
        info = os.fstat(fd)
        # Some existing systems have root:root 0664 /etc/fstab. We only read it
        # for mount conflicts: allow that exact case after checking GID 0 has
        # no non-root members. Never chmod it, and NEVER extend this exception
        # to our writable exports/unit configuration or a non-root group.
        safe_group_write = (allow_root_group_write and info.st_gid == 0
                            and stat.S_IMODE(info.st_mode) == 0o664
                            and root_group_is_administrative())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0
                or (info.st_mode & 0o022 and not safe_group_write)):
            raise SetupError(f'Unsafe configuration file: {path}')
        if info.st_size > 1024 * 1024:
            raise SetupError('Configuration file is unexpectedly large')
        with os.fdopen(fd, 'r') as stream:
            fd = None
            return stream.read(1024 * 1024 + 1)
    finally:
        if fd is not None:
            os.close(fd)


def active_lines(content):
    return [line.strip() for line in (content or '').splitlines() if line.strip() and not line.lstrip().startswith('#')]


def run(args):
    try:
        result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=40)
    except (OSError, subprocess.SubprocessError) as error:
        raise SetupError(f'Command failed: {args[0]} {args[1] if len(args) > 1 else ""}; inspect NFS/service logs') from error
    if len(result.stdout) > 1024 * 1024:
        raise SetupError('Command output is unexpectedly large')
    return result.stdout


def export_options(root):
    return f'ro,root_squash,sync,no_subtree_check,secure,sec=sys,fsid=0,mp={root}'


def export_text(root, peers):
    return MARKER + f'{root}/datasets/ready ' + ' '.join(f'{ip}({export_options(root)})' for ip in peers) + '\n'


def client_text(root, server):
    return MARKER + f'''[Unit]
Description=GPUQ read-only dataset publication source
RequiresMountsFor={root}
AssertPathIsMountPoint={root}
Wants=network-online.target
After=network-online.target

[Mount]
What={server}:/
Where={root}/library
Type=nfs
Options={MOUNT_OPTIONS}
TimeoutSec=30

[Install]
WantedBy=multi-user.target
'''


def check_identical(path, wanted):
    actual = safe_text(path)
    if actual is not None and actual != wanted:
        raise SetupError(f'Existing configuration differs; no automatic replacement: {path}')
    return actual is not None


def check_live_exports(text, root, peers, installed):
    lines = active_lines(text)
    if lines and not installed:
        raise SetupError('Existing live exports are not owned by this installation')
    required = {'ro', 'root_squash', 'sync', 'no_subtree_check', 'secure', 'sec=sys', 'fsid=0'}
    for line in lines:
        fields = shlex.split(line)
        if len(fields) != 2 or fields[0] != str(root / 'datasets/ready'):
            raise SetupError('Unrelated live NFS export; refusing to share its NFSv4 root')
        match = re.fullmatch(r'([^()]+)\(([^()]*)\)', fields[1])
        options = set(match[2].split(',')) if match else set()
        forbidden = {'rw', 'no_root_squash', 'async', 'insecure', 'crossmnt', 'nohide'}
        if (not match or match[1] not in peers or not required.issubset(options)
                or options.intersection(forbidden)):
            raise SetupError('Live NFS peers/options differ; operator review required')


def check_library_mount(rows, root, server):
    target = root / 'library'
    exact = [r for r in rows if r['target'] == str(target)]
    if any(target in Path(r['target']).parents for r in rows):
        raise SetupError('Nested mount under library is not managed')
    if not exact:
        return False
    entry = exact[-1]
    options = set(entry['options']) | set(entry['superOptions'])
    if (entry['fstype'] not in {'nfs', 'nfs4'} or entry['source'] != server + ':/'
            or not {'ro', 'nosuid', 'nodev', 'noexec', 'vers=4.2', 'proto=tcp', 'sec=sys', 'hard'}.issubset(options)):
        raise SetupError('Existing library mount has a different server or unsafe options')
    return True


def build_plan(mode, *, peers=(), server=None, service_user=None, trusted_parent_uids=(),
               root=DATA_ROOT, exports=EXPORTS, exports_dir=EXPORTS_DIR, unit_dir=UNIT_DIR, fstab=FSTAB):
    root, exports, exports_dir, unit_dir, fstab = map(Path, (root, exports, exports_dir, unit_dir, fstab))
    trusted = sorted(set(trusted_parent_uids))
    if any(type(uid) is not int or uid < 1 or uid >= 2**32 - 1 for uid in trusted):
        raise SetupError('Trusted parent UID must be a positive administrator UID')
    rows = read_mounts()
    with directory(root) as fd:
        state = storage_state(root, fd, rows, trusted)
    plan = {'mode': mode, 'root': str(root), 'mount': state, 'trustedParentUids': trusted,
            'paths': {'exports': str(exports), 'exportsDir': str(exports_dir), 'unitDir': str(unit_dir), 'fstab': str(fstab)},
            'trustBoundary': 'AUTH_SYS trusts these host administrators and matching cache-service numeric UID/GID; this is not multi-tenant NFS isolation.'}
    if mode == 'server':
        peers = sorted(set(private_ipv4(ip) for ip in peers))
        if not peers or len(peers) > 64:
            raise SetupError('Server needs between 1 and 64 explicit --peer hosts')
        try:
            user = pwd.getpwnam(service_user)
        except (KeyError, TypeError) as error:
            raise SetupError('Existing cache --service-user is required') from error
        if user.pw_uid == 0:
            raise SetupError('Cache service must not be root')
        cache = root / 'datasets'
        if any(Path(r['target']) == cache or cache in Path(r['target']).parents for r in rows):
            raise SetupError('Dataset subtree must not contain another mount')
        for path in (cache, cache / 'ready'):
            with directory(path) as fd:
                info = os.fstat(fd)
                if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (user.pw_uid, user.pw_gid, 0o700):
                    raise SetupError('datasets and ready must retain cache-service UID/GID and mode 0700; no permission changes')
                if device_id(fd) != state['device']:
                    raise SetupError('Published directory must remain on the data mount')
        if active_lines(safe_text(exports)):
            raise SetupError('Unrelated /etc/exports configuration; manual NFS integration required')
        config = exports_dir / EXPORT_NAME
        content = export_text(root, peers)
        if exports_dir.exists():
            trusted_config_dir(exports_dir)
            for path in exports_dir.glob('*.exports'):
                if path.name != EXPORT_NAME and active_lines(safe_text(path)):
                    raise SetupError('Unrelated exports.d configuration; manual NFS integration required')
            installed = check_identical(config, content)
        else:
            trusted_config_dir(exports_dir.parent)
            installed = False
        check_live_exports(run(['exportfs', '-s']), root, peers, installed)
        if run(['systemctl', 'show', 'nfs-server.service', '--property=LoadState', '--value']).strip() != 'loaded':
            raise SetupError('Install the NFS server package first; no package/service replacement performed')
        return {**plan, 'peers': peers, 'service': {'user': user.pw_name, 'uid': user.pw_uid, 'gid': user.pw_gid},
                'config': str(config), 'content': content, 'installed': installed,
                'export': str(cache / 'ready'), 'options': export_options(root)}
    if mode != 'client':
        raise SetupError('Unknown mode')
    server = private_ipv4(server)
    config, content = unit_dir / UNIT_NAME, client_text(root, server)
    installed = check_identical(config, content)
    for line in active_lines(safe_text(fstab, allow_root_group_write=True)):
        fields = line.split()
        if len(fields) >= 2 and unescape(fields[1]) == str(root / 'library'):
            raise SetupError('library already appears in fstab; no competing mount configuration allowed')
    unit = run(['systemctl', 'show', UNIT_NAME, '--property=FragmentPath', '--property=DropInPaths']).splitlines()
    unit = dict(line.split('=', 1) for line in unit if '=' in line)
    if unit.get('DropInPaths') or unit.get('FragmentPath', '') not in ('', str(config)):
        raise SetupError('Existing mount-unit override/drop-in; refusing to alter its behavior')
    run(['mount.nfs', '-V'])
    mounted = check_library_mount(rows, root, server)
    if not mounted:
        with directory(root) as fd:
            try:
                info = os.stat('library', dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                info = None
            if info is not None:
                if not stat.S_ISDIR(info.st_mode):
                    raise SetupError('library must not be a symlink or file')
                trusted_info(info)
                with directory(root / 'library') as child:
                    if os.listdir(child):
                        raise SetupError('library is not empty; nothing will be covered or moved')
    return {**plan, 'server': server, 'config': str(config), 'content': content,
            'installed': installed, 'mounted': mounted, 'target': str(root / 'library'),
            'sourcePattern': str(root / 'library/<dataset>/<sha256>/data')}


def create_config(path, content):
    """Create atomically without ever replacing an existing configuration."""
    path = Path(path)
    trusted_config_dir(path.parent)
    with directory(path.parent) as parent:
        temp = '.' + path.name + '.' + secrets.token_hex(8)
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644, dir_fd=parent)
        try:
            os.fchmod(fd, 0o644)
            with os.fdopen(fd, 'w') as stream:
                fd = None
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temp, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError:
                check_identical(path, content)
            os.fsync(parent)
        finally:
            if fd is not None:
                os.close(fd)
            os.unlink(temp, dir_fd=parent)


def apply_plan(plan):
    if os.geteuid() != 0:
        raise SetupError('--apply requires root')
    paths = plan['paths']
    fresh = build_plan(plan['mode'], peers=plan.get('peers', ()), server=plan.get('server'),
                       service_user=plan.get('service', {}).get('user'), trusted_parent_uids=plan['trustedParentUids'],
                       root=Path(plan['root']), exports=Path(paths['exports']), exports_dir=Path(paths['exportsDir']),
                       unit_dir=Path(paths['unitDir']), fstab=Path(paths['fstab']))
    if fresh != plan:
        raise SetupError('Storage/configuration changed after preview; nothing applied')
    root = Path(plan['root'])
    with directory(root) as fd:
        if storage_state(root, fd, read_mounts(), plan['trustedParentUids']) != plan['mount']:
            raise SetupError('Data mount changed; nothing applied')
        if plan['mode'] == 'client' and not plan['mounted']:
            try:
                os.mkdir('library', 0o755, dir_fd=fd)
            except FileExistsError:
                pass
            with directory(root / 'library') as child:
                trusted_info(os.fstat(child))
                if os.listdir(child):
                    raise SetupError('library became nonempty; refusing to mount over it')
        if plan['mode'] == 'server' and not Path(paths['exportsDir']).exists():
            Path(paths['exportsDir']).mkdir(mode=0o755)
        if not plan['installed']:
            create_config(Path(plan['config']), plan['content'])
        # Do not restart anything, reload all exports, flush NFS state, or modify
        # global NFS protocol settings. Only this source/mount is activated.
        if plan['mode'] == 'server':
            run(['systemctl', 'start', 'nfs-server.service'])
            for peer in plan['peers']:
                run(['exportfs', '-i', '-o', plan['options'], peer + ':' + plan['export']])
            live = run(['exportfs', '-s'])
            check_live_exports(live, root, plan['peers'], True)
            actual = {shlex.split(line)[1].split('(', 1)[0] for line in active_lines(live)}
            if actual != set(plan['peers']):
                raise SetupError('Not all requested peers are exported; installation is not verified')
            run(['systemctl', 'enable', 'nfs-server.service'])
        else:
            run(['systemctl', 'daemon-reload'])
            run(['systemctl', 'start', UNIT_NAME])
            if not check_library_mount(read_mounts(), root, plan['server']):
                raise SetupError('NFS mount is not active; installation is not verified')
            run(['systemctl', 'enable', UNIT_NAME])
        if storage_state(root, fd, read_mounts(), plan['trustedParentUids']) != plan['mount']:
            raise SetupError('Data mount changed during setup; recheck before consumption')
    return {**plan, 'dryRun': False, 'status': 'configured', 'dataPermissionsChanged': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='mode', required=True)
    server = sub.add_parser('server')
    server.add_argument('--peer', action='append', required=True)
    server.add_argument('--service-user', required=True)
    client = sub.add_parser('client')
    client.add_argument('--server', required=True)
    for child in (server, client):
        child.add_argument('--trusted-parent-uid', action='append', type=int, default=[])
        child.add_argument('--apply', action='store_true', help='Apply the verified plan; otherwise read-only preview')
    args = parser.parse_args(argv)
    try:
        kwargs = {'peers': getattr(args, 'peer', ()), 'server': getattr(args, 'server', None),
                  'service_user': getattr(args, 'service_user', None), 'trusted_parent_uids': args.trusted_parent_uid}
        if not args.apply:
            result = {'dryRun': True, **build_plan(args.mode, **kwargs)}
        else:
            if os.geteuid() != 0:
                raise SetupError('--apply requires root')
            fd = os.open('/run/lock/gpuq-dataset-nfs.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0:
                    raise SetupError('Unsafe setup lock')
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = apply_plan(build_plan(args.mode, **kwargs))
            finally:
                os.close(fd)
        print(json.dumps(result, indent=2))
        return 0
    except (SetupError, OSError) as error:
        print(json.dumps({'error': str(error), 'status': 'not-verified',
                          'note': 'Existing data was not deleted or repaired. A partially installed dedicated configuration may remain; review it before retry/removal.'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
