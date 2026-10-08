#!/usr/bin/python3
"""Kernel project quotas for managed private storage (disabled by default).

The root broker accepts only an authenticated owner and a path derived by the
trusted node runtime. Its independent root-owned policy re-derives the permitted
owner prefixes; neither a project ID nor a limit is accepted from a request.
Existing nonempty, unassigned trees require an explicit offline migration. No
automatic recursive chown, project-ID reassignment, mount, or quota enable.
"""
import contextlib
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import subprocess
import sys

POLICY = Path('/etc/gpuq-console/storage-quota.json')
BROKER = '/usr/local/libexec/gpuq-storage-quota'
FSGETXATTR, FSSETXATTR = 0x801c581f, 0x401c5820
PROJINHERIT = 0x200
OWNER = re.compile(r'(builtin-admin|demo-user-[0-9]+)\Z')
SLUG = re.compile(r'[a-z][a-z0-9_-]{0,47}\Z')
HEX = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')


def need(ok, message):
    if not ok:
        raise ValueError(message)


def scope(config):
    value = config.get('storageQuota', {'enabled': False})
    need(isinstance(value, dict) and {'enabled'} <= set(value) <= {'enabled', 'owners'}
         and type(value['enabled']) is bool,
         'Invalid storageQuota configuration')
    if 'owners' in value:
        owners = value['owners']
        need(value['enabled'] is True and isinstance(owners, list) and 1 <= len(owners) <= 10000
             and all(isinstance(owner, str) and OWNER.fullmatch(owner) for owner in owners)
             and len(set(owners)) == len(owners), 'Invalid hard-quota owner cohort')
    return value


def enabled(config, user=None):
    value = scope(config)
    if 'owners' in value:
        need(isinstance(user, str) and OWNER.fullmatch(user), 'Authenticated quota owner required for scoped policy')
        return user in value['owners']
    return value['enabled']


def dataset_owner(config, user, owners):
    """Choose a single registered billing owner, never guess shared ownership.

    Legacy datasets remain unchanged only when neither their actor nor any
    registered owner belongs to the explicitly activated quota cohort.
    """
    value = scope(config)
    if not value['enabled']:
        return None
    need(isinstance(user, str) and OWNER.fullmatch(user), 'Invalid authenticated dataset quota actor')
    need(isinstance(owners, list) and 1 <= len(owners) <= 10000
         and all(isinstance(owner, str) and OWNER.fullmatch(owner) for owner in owners)
         and len(set(owners)) == len(owners), 'Invalid dataset quota owners')
    cohort = value.get('owners')
    if cohort is not None and user not in cohort and not set(owners).intersection(cohort):
        return None
    need(len(owners) == 1, 'Shared dataset needs explicit storage billing policy')
    need(cohort is None or owners[0] in cohort, 'Dataset billing owner is not in the hard-quota cohort')
    return owners[0]


@contextlib.contextmanager
def directory(path):
    path = Path(path)
    need(path.is_absolute() and str(path) == os.fspath(path) and '..' not in path.parts,
         'Invalid quota directory')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def root_json(path):
    path = Path(path)
    with directory(path.parent) as parent:
        info = os.fstat(parent)
        need(info.st_uid == 0 and not info.st_mode & 0o022, 'Quota policy parent is not root protected')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                 and info.st_nlink == 1 and info.st_size <= 1024**2, 'Unsafe quota policy')
            raw = os.read(fd, 1024**2 + 1)
            need(len(raw) == info.st_size, 'Quota policy changed')
            return json.loads(raw)
        finally:
            os.close(fd)


def validate_policy(value):
    required = {'schema', 'serviceUid', 'platformRoot', 'datasetsRoot', 'volumes', 'owners'}
    need(isinstance(value, dict) and required <= set(value)
         and not (set(value) - required - {'controlRoot', 'database', 'logRoot'})
         and (not {'controlRoot', 'logRoot'}.intersection(value) or 'database' in value)
         and type(value['schema']) is int and value['schema'] == 1 and type(value['serviceUid']) is int and value['serviceUid'] > 0,
         'Invalid quota policy schema')
    for key in ('platformRoot', 'datasetsRoot', *[k for k in ('controlRoot', 'database', 'logRoot') if k in value]):
        path = Path(value[key])
        need(path.is_absolute() and str(path) == value[key] and '..' not in path.parts and len(path.parts) > 2,
             'Invalid quota storage root')
    need(isinstance(value['volumes'], dict) and 1 <= len(value['volumes']) <= 8, 'Invalid quota volumes')
    uuids = set()
    for name, volume in value['volumes'].items():
        need(SLUG.fullmatch(name) and isinstance(volume, dict)
             and set(volume) == {'uuid', 'mountPoint', 'filesystem'}
             and isinstance(volume['uuid'], str) and UUID.fullmatch(volume['uuid'])
             and volume['filesystem'] in ('ext4', 'xfs'), 'Invalid quota volume')
        mount = Path(volume['mountPoint'])
        need(mount.is_absolute() and str(mount) == volume['mountPoint'] and '..' not in mount.parts
             and mount != Path('/') and volume['uuid'] not in uuids, 'Duplicate/unsafe quota volume')
        uuids.add(volume['uuid'])
    need(isinstance(value['owners'], dict), 'Invalid quota owners')
    ids = set()
    for owner, row in value['owners'].items():
        need(OWNER.fullmatch(owner) and isinstance(row, dict) and set(row) == {'projectId', 'limits'}
             and type(row['projectId']) is int and 10000 <= row['projectId'] < 2**31
             and row['projectId'] not in ids, 'Invalid or reused quota project ID')
        ids.add(row['projectId'])
        need(isinstance(row['limits'], dict) and row['limits'] and not set(row['limits']) - set(value['volumes']),
             'Invalid owner quota volumes')
        for limit in row['limits'].values():
            need(isinstance(limit, dict) and set(limit) == {'bytes', 'inodes'}
                 and all(type(v) is int and 1 <= v < 2**63 for v in limit.values())
                 and limit['bytes'] % 1024 == 0, 'Hard byte/inode limits must be finite (bytes aligned to 1024)')
    return value


def quota_owner(policy, user):
    need(isinstance(user, str) and OWNER.fullmatch(user), 'Invalid authenticated quota owner')
    need(user in policy['owners'], 'No administrator-provisioned hard quota for this owner')
    return policy['owners'][user]


def allowed_path(policy, user, path):
    """Only service-private owner roots; no caller-selected arbitrary host tree."""
    quota_owner(policy, user)
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'Invalid quota target')
    root, data = Path(policy['platformRoot']), Path(policy['datasetsRoot'])
    digest = hashlib.sha256(user.encode()).hexdigest()
    prefixes = [root/'users'/digest[:32], root/'projects-v2'/digest,
                root/'oci'/digest, data/'.workspaces'/digest, data/'.uploads'/digest]
    # The project upload bucket is derived from the same existing identity key.
    if path.parent == root/'project-ops' and path.name.endswith('.uploads'):
        name = path.name[:-8]
        if HEX.fullmatch(name):
            # The caller additionally sends a slug, checked in broker().
            return 'project-upload'
    for prefix in prefixes:
        if path == prefix:
            return 'owner-root'
    if 'controlRoot' in policy and path.parent == Path(policy['controlRoot']):
        need(re.fullmatch('A[a-f0-9]{32}', path.name), 'Invalid scheduler quota attempt')
        database = Path(policy['database'])
        with directory(database.parent) as parent:
            info = os.stat(database.name, dir_fd=parent, follow_symlinks=False)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == policy['serviceUid']
                 and not info.st_mode & 0o022 and info.st_nlink == 1, 'Unsafe scheduler quota database')
            with contextlib.closing(sqlite3.connect(database.as_uri()+'?mode=ro', uri=True)) as db:
                row = db.execute('SELECT j.submit_key,a.control_dir FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?',
                                 (path.name,)).fetchone()
            need(os.stat(database.name, dir_fd=parent, follow_symlinks=False).st_ino == info.st_ino,
                 'Scheduler quota database changed')
        need(row and UUID.fullmatch(row[0]) and row[1] == str(path), 'Unknown scheduler quota attempt')
        need(job_owner(policy, row[0]) == user, 'Scheduler quota owner mismatch')
        return 'scheduler-control'
    if 'logRoot' in policy and path.parent == Path(policy['logRoot']):
        match = re.fullmatch(r'(J[a-f0-9]+)-(A[a-f0-9]{32})\.log', path.name)
        need(match is not None, 'Invalid scheduler log quota target')
        row = attempt_record(policy, match[2])
        need(row and row[0] == match[1] and row[2] == str(path)
             and job_owner(policy, row[1]) == user, 'Scheduler log quota owner mismatch')
        return 'scheduler-log'
    # The only writable diagnostics mount is bound to a stored authenticated
    # job, not a caller-selected job ID. Observer/control metadata stays outside.
    try:
        job, capture, leaf = path.relative_to(root/'diagnostics').parts
    except ValueError:
        pass
    else:
        need(UUID.fullmatch(job) and re.fullmatch('[a-f0-9]{32}', capture)
             and leaf == 'runtime', 'Invalid diagnostic quota target')
        need(job_owner(policy, job) == user, 'Diagnostic quota owner mismatch')
        return 'diagnostic-runtime'
    # Dataset staging is authorized by its existing immutable ACL/registration;
    # root never assigns an unknown or shared dataset to a guessed owner.
    try:
        dataset, version = path.relative_to(data/'.staging').parts
    except ValueError:
        raise ValueError('Quota target is outside the fixed owner roots') from None
    need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', dataset) and HEX.fullmatch(version),
         'Invalid dataset quota target')
    registry = data/'.registry'/dataset
    with directory(registry) as parent:
        def record(name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                info = os.fstat(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_uid == policy['serviceUid']
                     and not info.st_mode & 0o077 and info.st_nlink == 1 and info.st_size <= 64*1024**2,
                     'Unsafe quota dataset metadata')
                return json.loads(os.read(fd, info.st_size + 1))
            finally:
                os.close(fd)
        need(record('dataset.json').get('owners') == [user], 'Shared/unknown dataset needs explicit storage billing policy')
        registered = record(version+'.json')
        need(isinstance(registered, dict) and set(registered) == {'schema', 'manifest', 'sourceId'}
             and registered['schema'] == 1, 'Dataset version is not registered')
    return 'dataset-stage'


def attempt_record(policy, attempt):
    """Native scheduler identity and paths, never a client-selected log owner."""
    database = Path(policy['database'])
    with directory(database.parent) as parent:
        info = os.stat(database.name, dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == policy['serviceUid']
             and not info.st_mode & 0o022 and info.st_nlink == 1, 'Unsafe scheduler quota database')
        with contextlib.closing(sqlite3.connect(database.as_uri()+'?mode=ro', uri=True)) as db:
            row = db.execute('SELECT j.id,j.submit_key,a.log_path FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?',
                             (attempt,)).fetchone()
        need(os.stat(database.name, dir_fd=parent, follow_symlinks=False).st_ino == info.st_ino,
             'Scheduler quota database changed')
        need(row is None or UUID.fullmatch(row[1]), 'Invalid scheduler submission identity')
        return row


def job_owner(policy, job):
    with directory(Path(policy['platformRoot'])/'jobs') as parent:
        fd = os.open(job+'.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == policy['serviceUid']
                 and not info.st_mode & 0o077 and info.st_nlink == 1 and info.st_size <= 1024**2,
                 'Unsafe job quota identity')
            job_spec = json.loads(os.read(fd, info.st_size+1))
            need(job_spec.get('id') == job, 'Job quota identity mismatch')
            return job_spec.get('userId')
        finally:
            os.close(fd)


def volume_for(policy, path, *, file=False):
    result = subprocess.run(['/usr/bin/findmnt', '--json', '--target', str(path),
                             '--output', 'TARGET,FSTYPE,OPTIONS,UUID,MAJ:MIN'],
                            check=True, capture_output=True, text=True, timeout=5)
    rows = json.loads(result.stdout).get('filesystems', [])
    need(len(rows) == 1, 'Ambiguous quota mount')
    row = rows[0]
    matches = [(key, v) for key, v in policy['volumes'].items() if v['uuid'] == row.get('uuid')]
    need(len(matches) == 1, 'Quota target is not on an approved physical filesystem')
    key, volume = matches[0]
    options = set(row['options'].split(','))
    need(row['fstype'] == volume['filesystem'] and 'rw' in options
         and options.intersection({'prjquota', 'pquota'})
         and not options.intersection({'noquota', 'pqnoenforce', 'pquota=off'}),
         'Kernel project quota enforcement is not enabled')
    device = Path('/dev/disk/by-uuid')/volume['uuid']
    device_info = device.stat()
    with directory(Path(path).parent if file else path) as parent:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent) if file else os.dup(parent)
        try:
            info = os.fstat(fd)
            need(stat.S_ISBLK(device_info.st_mode) and device_info.st_rdev == info.st_dev
                 and info.st_dev != Path('/').stat().st_dev
                 and row['maj:min'] == str(os.major(info.st_dev))+':'+str(os.minor(info.st_dev)),
                 'Quota backing device identity changed')
        finally: os.close(fd)
    return key, device


class Dqblk(ctypes.Structure):
    _fields_ = [(key, ctypes.c_uint64) for key in ('bhard', 'bsoft', 'space', 'ihard', 'isoft', 'inodes', 'btime', 'itime')] + [('valid', ctypes.c_uint32)]


def quotactl(device, project_id, limit=None):
    """Linux generic project quota API, not a userspace byte-count estimate."""
    value = Dqblk()
    command = 0x800007
    if limit is not None:
        command = 0x800008
        value.bhard = value.bsoft = limit['bytes']//1024
        value.ihard = value.isoft = limit['inodes']
        value.valid = 1 | 4  # QIF_BLIMITS | QIF_ILIMITS; never modify usage.
    libc = ctypes.CDLL(None, use_errno=True)
    code = libc.quotactl(ctypes.c_int((command << 8) | 2), ctypes.c_char_p(os.fsencode(device)),
                         ctypes.c_int(project_id), ctypes.byref(value))
    if code:
        raise OSError(ctypes.get_errno(), 'Kernel project quota operation failed')
    return {'bytes': value.bhard*1024, 'inodes': value.ihard,
            'usedBytes': value.space, 'usedInodes': value.inodes}


def attribute(fd, project_id=None, *, inherit=True):
    raw = bytearray(28)
    fcntl.ioctl(fd, FSGETXATTR, raw, True)
    fields = list(struct.unpack('=IIIII8s', raw))
    if project_id is not None:
        if inherit: fields[0] |= PROJINHERIT
        fields[3] = project_id
        fcntl.ioctl(fd, FSSETXATTR, struct.pack('=IIIII8s', *fields))
        return attribute(fd)
    return fields[3], bool(fields[0] & PROJINHERIT)


def charge_attempt(fd, project_id, uid):
    """Before payload launch only: charge the scheduler's small control tree.

    This is not a legacy migration: max 64 entries / 16 MiB / depth 2, regular
    files with no hardlinks only. A partial quota failure remains charged and
    blocks launch. No chown, file rewrite or unrelated path traversal occurs.
    """
    counters = [0, 0]
    def walk(parent, depth):
        need(depth <= 2, 'Scheduler quota tree is too deep')
        info = os.fstat(parent)
        need(info.st_uid == uid and not info.st_mode & 0o077, 'Unsafe scheduler quota directory')
        before = attribute(parent)
        need(before in ((0, False), (project_id, True)), 'Attempt has a different quota owner')
        if before[0] == 0: attribute(parent, project_id)
        for name in os.listdir(parent):
            counters[0] += 1
            need(counters[0] <= 64, 'Scheduler quota tree is too large')
            child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                item = os.fstat(child)
                need(item.st_dev == info.st_dev and item.st_uid == uid and not item.st_mode & 0o022,
                     'Unsafe scheduler quota entry')
                if stat.S_ISDIR(item.st_mode): walk(child, depth+1)
                else:
                    counters[1] += item.st_size
                    need(stat.S_ISREG(item.st_mode) and item.st_nlink == 1 and counters[1] <= 16*1024**2,
                         'Scheduler quota entry requires explicit administration')
                    old = attribute(child)
                    need(old[0] in (0, project_id), 'Attempt file has a different quota owner')
                    if old[0] == 0: attribute(child, project_id, inherit=False)
                os.fsync(child)
            finally: os.close(child)
    walk(fd, 0)


def broker(request, policy=None):
    need(os.geteuid() == 0, 'Quota broker requires host administrator installation')
    policy = validate_policy(root_json(POLICY) if policy is None else policy)
    if isinstance(request, dict) and request.get('operation') in ('status', 'training-status'):
        need(set(request) == {'operation', 'userId'}, 'Invalid quota status request')
        return kernel_status(policy, request['userId'], training=request['operation'] == 'training-status')
    need(isinstance(request, dict) and set(request) <= {'userId', 'path', 'project'}
         and {'userId', 'path'} <= set(request), 'Invalid quota request')
    user, path = request['userId'], Path(request['path'])
    row = quota_owner(policy, user)
    kind = allowed_path(policy, user, path)
    if kind == 'project-upload':
        slug = request.get('project')
        need(isinstance(slug, str) and SLUG.fullmatch(slug), 'Invalid project quota request')
        key = hashlib.sha256(json.dumps([user, slug]).encode()).hexdigest()
        need(path.name == key+'.uploads', 'Upload quota owner mismatch')
    else:
        need('project' not in request, 'Unexpected quota project field')
    # The platform guard remains independent of quota/mount admission.
    observed = check_guard(policy)
    need(isinstance(observed, dict) and observed.get('guarded') is True,
         'Hard quota requires an enabled platform root identity guard')
    volume, device = volume_for(policy, path, file=kind == 'scheduler-log')
    need(volume in row['limits'], 'Owner has no hard quota on this volume')
    actual = quotactl(device, row['projectId'])
    expected = row['limits'][volume]
    need(all(actual[key] == expected[key] for key in ('bytes', 'inodes')), 'Kernel hard quota does not match administrator policy')
    with directory(path.parent if kind == 'scheduler-log' else path) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent) if kind == 'scheduler-log' else os.dup(parent)
        try:
            return admit_target(fd, kind, policy, row, volume, actual)
        finally:
            os.close(fd)


def admit_target(fd, kind, policy, row, volume, actual):
        info = os.fstat(fd)
        need(info.st_uid == policy['serviceUid'] and not info.st_mode & 0o077,
             'Quota owner root is not service-private')
        before = attribute(fd)
        if kind == 'scheduler-log':
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 16*1024**2,
                 'Scheduler log needs explicit quota migration')
            need(before[0] in (0, row['projectId']), 'Scheduler log has another quota owner')
            if before[0] == 0: attribute(fd, row['projectId'], inherit=False)
            need(attribute(fd)[0] == row['projectId'], 'Scheduler log quota assignment failed')
            os.fsync(fd)
            return {'enabled': True, 'enforcement': 'kernel-project-quota', 'kind': kind,
                    'projectId': row['projectId'], 'volume': volume, **actual}
        if kind == 'scheduler-control': charge_attempt(fd, row['projectId'], policy['serviceUid'])
        before = attribute(fd)
        if before != (row['projectId'], True):
            need(before == (0, False) and not os.listdir(fd),
                 'Existing storage needs offline quota assignment; automatic reassignment refused')
            need(attribute(fd, row['projectId']) == (row['projectId'], True), 'Kernel quota inheritance was not installed')
            os.fsync(fd)
        return {'enabled': True, 'enforcement': 'kernel-project-quota', 'projectId': row['projectId'],
                'volume': volume, **actual}


def ensure(config, user, path, *, project=None):
    if not enabled(config, user):
        return {'enabled': False, 'enforcement': None}
    request = {'userId': user, 'path': str(path)}
    if project is not None:
        request['project'] = project
    result = subprocess.run(['/usr/bin/sudo', '-n', BROKER], input=json.dumps(request),
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'},
                            text=True, capture_output=True, timeout=10)
    need(result.returncode == 0 and len(result.stdout) < 65536, 'Hard quota unavailable; write admission refused')
    value = json.loads(result.stdout)
    need(value.get('enabled') is True and value.get('enforcement') == 'kernel-project-quota'
         and type(value.get('projectId')) is int and value['projectId'] >= 10000
         and all(type(value.get(k)) is int and value[k] > 0 for k in ('bytes', 'inodes')),
         'Invalid hard quota verification response')
    kind = value.get('kind')
    need(kind in (None, 'scheduler-log'), 'Invalid hard quota target kind')
    with directory(Path(path).parent if kind == 'scheduler-log' else path) as parent:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent) if kind else os.dup(parent)
        try:
            need(attribute(fd)[0] == value['projectId'] and (kind == 'scheduler-log' or attribute(fd)[1]),
                 'Quota target changed after root verification')
        finally: os.close(fd)
    return value


def kernel_status(policy, user, *, training=False):
    """Read the owner's actual kernel counters; no tree admission or mutation."""
    row = quota_owner(policy, user)
    observed = check_guard(policy)
    need(isinstance(observed, dict) and observed.get('guarded') is True,
         'Hard quota requires an enabled platform root identity guard')
    volumes = []
    for key, expected in sorted(row['limits'].items()):
        volume, device = volume_for(policy, policy['volumes'][key]['mountPoint'])
        need(volume == key, 'Quota status mount identity changed')
        actual = quotactl(device, row['projectId'])
        need(set(actual) == {'bytes', 'inodes', 'usedBytes', 'usedInodes'}
             and all(type(v) is int and v >= 0 for v in actual.values())
             and all(actual[k] == expected[k] for k in ('bytes', 'inodes')),
             'Kernel hard quota does not match administrator policy')
        result = {'volume': key, **actual,
                  'remainingBytes': max(0, actual['bytes']-actual['usedBytes']),
                  'remainingInodes': max(0, actual['inodes']-actual['usedInodes'])}
        if training:
            with directory(policy['volumes'][key]['mountPoint']) as fd:
                identity = os.fstat(fd)
                need(identity.st_dev == os.stat(device).st_rdev, 'Quota volume device identity changed')
                result['volumeDeviceId'] = hashlib.sha256(str(identity.st_dev).encode()).hexdigest()
        volumes.append(result)
    return {'enabled': True, 'enforcement': 'kernel-project-quota', 'owner': user,
            'projectId': row['projectId'], 'volumes': volumes}


def check_guard(policy):
    spec = importlib.util.spec_from_file_location('gpuq_quota_platform_guard', Path(__file__).with_name('platform-root-guard.py'))
    guard = importlib.util.module_from_spec(spec)
    before = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(guard)
    finally: sys.dont_write_bytecode = before
    return guard.check(policy['platformRoot'], purpose='check-only')


def status(config, user, *, _training=False):
    """Authenticated read-only status; disabled/unknown is never zero usage."""
    need(isinstance(user, str) and OWNER.fullmatch(user), 'Invalid authenticated quota owner')
    if not enabled(config, user):
        value = {'enabled': False, 'enforcement': None, 'owner': user, 'volumes': None}
        if 'owners' in scope(config):
            value['reason'] = 'OWNER_NOT_ACTIVATED'
        return value
    result = subprocess.run(['/usr/bin/sudo', '-n', BROKER],
                            input=json.dumps({'operation': 'training-status' if _training else 'status', 'userId': user}),
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'},
                            text=True, capture_output=True, timeout=10)
    need(result.returncode == 0 and len(result.stdout) < 65536,
         'Hard quota status unavailable; usage is unknown')
    value = json.loads(result.stdout)
    need(isinstance(value, dict) and set(value) == {'enabled', 'enforcement', 'owner', 'projectId', 'volumes'}
         and value['enabled'] is True and value['enforcement'] == 'kernel-project-quota'
         and value['owner'] == user and type(value['projectId']) is int
         and 10000 <= value['projectId'] < 2**31
         and isinstance(value['volumes'], list) and 1 <= len(value['volumes']) <= 8,
         'Invalid hard quota status response')
    seen = set()
    for row in value['volumes']:
        fields = {'volume','bytes','inodes','usedBytes','usedInodes','remainingBytes','remainingInodes'}
        if _training:
            fields.add('volumeDeviceId')
        need(isinstance(row, dict) and set(row) == fields
             and isinstance(row['volume'], str) and SLUG.fullmatch(row['volume']) and row['volume'] not in seen
             and (not _training or isinstance(row.get('volumeDeviceId'), str) and HEX.fullmatch(row['volumeDeviceId']))
             and all(type(row[k]) is int and 0 <= row[k] < 2**64 for k in row if k not in ('volume','volumeDeviceId'))
             and row['bytes'] > 0 and row['inodes'] > 0
             and row['remainingBytes'] == max(0,row['bytes']-row['usedBytes'])
             and row['remainingInodes'] == max(0,row['inodes']-row['usedInodes']),
             'Invalid hard quota kernel counters')
        seen.add(row['volume'])
    return value


def training_status(config, user):
    """Distinct read-only request; an old broker fails closed without fallback."""
    return status(config, user, _training=True)


def ensure_attempt(config, spec, environment):
    if not enabled(config, spec.get('userId')): return
    attempt, job = environment.get('GPUQ_ATTEMPT_ID', ''), environment.get('GPUQ_JOB_ID', '')
    need(re.fullmatch(r'A[a-f0-9]{32}', attempt) and re.fullmatch(r'J[a-f0-9]+', job),
         'Missing scheduler log quota identity')
    with contextlib.closing(sqlite3.connect(Path(config['database']).as_uri()+'?mode=ro', uri=True)) as db:
        row = db.execute('SELECT a.log_path FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=? AND j.id=? AND j.submit_key=?',
                         (attempt, job, spec['id'])).fetchone()
    need(row and isinstance(row[0], str), 'Unconfirmed scheduler log identity')
    ensure(config, spec['userId'], row[0])


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16385)
        need(len(sys.argv) == 1 and len(raw) <= 16384, 'Invalid quota broker input')
        print(json.dumps(broker(json.loads(raw))))
    except Exception:
        # No policy paths/owner table or raw sudo/process errors in public RPC.
        print(json.dumps({'error': 'HARD_QUOTA_UNAVAILABLE'}))
        raise SystemExit(1)
