"""Bounded, cached allocated-byte observation of managed project roots only.

No du, user-selected root, link following, RPC, lease or project mutation. A
short-lived read-only child makes even a blocking scandir an unknown result;
the parent never waits unboundedly for that child. The private cache lock also
prevents concurrent refreshes (including across forced-command processes).
"""
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import stat
import threading
import time

TTL_SECONDS = 300
MAX_ENTRIES = 100000
MAX_SECONDS = 0.5
ROOTS = ('projects-v2', 'oci', 'users')
MAX_BYTES = 2**53-1
MAX_OBSERVATION_BYTES = 1024**2
MAX_GROUPS = 4096
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
EMPTY_BREAKDOWN = dict(protocol=1, complete=False, owners=[], projects=[])
UNKNOWN = dict(projectBytes=None, projectUsageComplete=False, projectCollectedAt=None,
               projectUsage=EMPTY_BREAKDOWN)
OWNER = re.compile(r'(?:[a-f0-9]{64}|[a-f0-9]{32})\Z')
PROJECT = re.compile(r'[a-z0-9][a-z0-9_-]{0,47}\Z')


class ProjectBreakdown:
    """Attribute the existing walk, never scan a second time or split OCI layers.

    Owners are the node's fixed SHA-256 directory identities, not usernames.
    Common owner-directory blocks count only in the owner total. Files outside
    a proven project (OCI graph/home included) make that owner's total unknown.
    Hardlinks in two projects/owners make both allocations unknown, not halves.
    """
    def __init__(self):
        self.inodes, self.projects, self.owners = {}, {}, set()
        self.unknown_owners, self.complete = set(), True

    def add(self, info, path, parent=None):
        if len(path) < 2:
            return
        if path[:2] == ('projects-v2', '.run-claims'):
            # ProjectStore's fixed, private control directory is not an owner.
            # The walk still validates/scans it and counts its physical blocks
            # in the existing all-account total, never in an owner's project.
            return
        owner = path[1]
        if not OWNER.fullmatch(owner) or path[0] != 'users' and len(owner) != 64:
            self.complete = False
            return
        self.owners.add(owner)
        if len(self.owners) > MAX_GROUPS:
            raise ValueError('Project owner bound reached')
        project = None
        if path[0] == 'projects-v2' and len(path) >= 3 and PROJECT.fullmatch(path[2]):
            project = (owner, path[2])
            self.projects.setdefault(project, dict(valid=False, mode=None))
            if len(self.projects) > MAX_GROUPS:
                raise ValueError('Project breakdown bound reached')
            if len(path) == 4 and path[3] == 'project.json':
                # The file is already an entry in this walk. Read only bounded
                # metadata through its no-follow parent descriptor.
                fd = os.open(path[3], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    if (not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 16384
                            or stamp(os.fstat(fd)) != stamp(info)):
                        raise ValueError('Unsafe project ownership metadata')
                    raw = os.read(fd, 16385)
                    if len(raw) != info.st_size or stamp(os.fstat(fd)) != stamp(info):
                        raise ValueError('Project ownership metadata changed')
                    meta = json.loads(raw)
                    if (not isinstance(meta, dict) or meta.get('schema') != 2
                            or meta.get('owner') != owner or meta.get('project') != path[2]
                            or meta.get('environmentMode', 'shared') not in ('shared', 'isolated', 'oci')):
                        raise ValueError('Unproven project owner')
                    self.projects[project] = dict(valid=True, mode=meta.get('environmentMode', 'shared'))
                except (OSError, ValueError):
                    self.unknown_owners.add(owner)
                finally:
                    os.close(fd)
        elif stat.S_ISREG(info.st_mode) and info.st_blocks:
            self.unknown_owners.add(owner)
        key = (info.st_dev, info.st_ino)
        entry = self.inodes.setdefault(key, dict(bytes=info.st_blocks*512, owners=set(), projects=set()))
        entry['owners'].add(owner)
        if project is not None:
            entry['projects'].add(project)

    def result(self):
        # Legacy users/<32 hex> and projects-v2/<64 hex> are one identity only
        # when the observed full identities prove a unique prefix match.
        full = {owner for owner in self.owners if len(owner) == 64}
        prefixes = {}
        for owner in full:
            prefixes.setdefault(owner[:32], []).append(owner)
        aliases = {}
        for owner in self.owners:
            matches = prefixes.get(owner, []) if len(owner) == 32 else [owner]
            aliases[owner] = matches[0] if len(matches) == 1 else owner
        totals = {aliases[owner]: 0 for owner in self.owners}
        unknown = {aliases[owner] for owner in self.unknown_owners}
        sizes = {key: 0 for key in self.projects}
        uncertain = {key for key, meta in self.projects.items() if not meta['valid'] or meta['mode'] == 'oci'}
        for entry in self.inodes.values():
            owners = {aliases[owner] for owner in entry['owners']}
            if len(owners) != 1:
                unknown.update(owners)
                uncertain.update(entry['projects'])
                continue
            totals[next(iter(owners))] += entry['bytes']
            if len(entry['projects']) == 1:
                sizes[next(iter(entry['projects']))] += entry['bytes']
            elif entry['projects']:
                uncertain.update(entry['projects'])
        unknown.update(aliases[owner] for owner, project in uncertain)
        projects = [dict(owner=owner, project=project, name=project,
                         bytes=None if (owner, project) in uncertain else sizes[(owner, project)])
                    for owner, project in sorted(self.projects) if self.projects[(owner, project)]['valid']]
        return dict(protocol=1, complete=self.complete,
                    owners=[dict(owner=owner, complete=owner not in unknown,
                                 projectBytes=None if owner in unknown else total)
                            for owner, total in sorted(totals.items())], projects=projects)


def valid_breakdown(value):
    if (not isinstance(value, dict) or set(value) != {'protocol', 'complete', 'owners', 'projects'}
            or type(value['protocol']) is not int or value['protocol'] != 1
            or type(value['complete']) is not bool
            or not isinstance(value['owners'], list) or len(value['owners']) > MAX_GROUPS
            or not isinstance(value['projects'], list) or len(value['projects']) > MAX_GROUPS):
        return False
    for row in value['owners']:
        if (not isinstance(row, dict) or set(row) != {'owner', 'complete', 'projectBytes'}
                or not isinstance(row['owner'], str) or not OWNER.fullmatch(row['owner'])
                or type(row['complete']) is not bool
                or row['projectBytes'] is not None and (type(row['projectBytes']) is not int or not 0 <= row['projectBytes'] <= MAX_BYTES)
                or row['complete'] != (row['projectBytes'] is not None)):
            return False
    for row in value['projects']:
        if (not isinstance(row, dict) or set(row) != {'owner', 'project', 'name', 'bytes'}
                or not isinstance(row['owner'], str) or not re.fullmatch('[a-f0-9]{64}', row['owner'])
                or not isinstance(row['project'], str) or not PROJECT.fullmatch(row['project'])
                or row['name'] != row['project']
                or row['bytes'] is not None and (type(row['bytes']) is not int or not 0 <= row['bytes'] <= MAX_BYTES)):
            return False
    return True


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            getattr(info, 'st_blocks', None))


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)


def open_directory(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path == Path('/'):
        raise ValueError('Invalid observation root')
    fd = os.open('/', DIR_FLAGS)
    try:
        for name in path.parts[1:]:
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def mount_signature(root):
    """Linux proof, including same-device binds; missing proof is unknown.

    Mounted ancestors pin the root's view. Any mount in a managed subtree is
    refused, even on the same device: it may expose shared dataset/base bytes.
    Unrelated system mounts do not invalidate this bounded project sample.
    """
    root = Path(root)
    fd = os.open('/proc/self/mountinfo', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        chunks, size = [], 0
        while size <= 2*1024**2:
            part = os.read(fd, min(65536, 2*1024**2+1-size))
            if not part:
                break
            chunks.append(part)
            size += len(part)
        raw = b''.join(chunks)
    finally:
        os.close(fd)
    if len(raw) > 2*1024**2 or not raw.endswith(b'\n'):
        raise ValueError('Incomplete mount proof')
    selected = []
    managed = tuple(root/name for name in ROOTS)
    for line in raw.decode('utf-8', errors='strict').splitlines():
        left, right = line.split(' - ', 1)
        fields, filesystem = left.split(), right.split()
        if len(fields) < 6 or len(filesystem) < 3:
            raise ValueError('Invalid mount proof')
        target = Path(re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4]))
        if not target.is_absolute() or '..' in target.parts:
            raise ValueError('Invalid mount target')
        if any(target == path or path in target.parents for path in managed):
            raise ValueError('Nested managed mount')
        if target == root or target in root.parents:
            selected.append(line)
    if not selected:
        raise ValueError('Missing mounted ancestor')
    return tuple(sorted(selected))


def sample(root_fd, *, root_path, maximum=MAX_ENTRIES, seconds=MAX_SECONDS, breakdown=False):
    deadline = time.monotonic() + seconds
    before = os.fstat(root_fd)
    mounts = mount_signature(root_path)
    seen, directories, roots = set(), [], {}
    count, total = 0, 0
    detail = ProjectBreakdown() if breakdown else None

    def check_bound():
        if count > maximum or time.monotonic() >= deadline:
            raise ValueError('Project sample bound reached')

    def add(info):
        nonlocal total
        if info.st_dev != before.st_dev:
            raise ValueError('Project sample crosses a mount')
        if type(getattr(info, 'st_blocks', None)) is not int or info.st_blocks < 0:
            raise ValueError('Allocated blocks unavailable')
        key = (info.st_dev, info.st_ino)
        if key in seen:
            return False
        seen.add(key)
        total += info.st_blocks * 512
        if total > MAX_BYTES:
            raise ValueError('Project byte sum exceeds API bound')
        return True

    def visit(fd, path):
        nonlocal count, detail
        check_bound()
        if len(path) > 128:
            raise ValueError('Project depth bound reached')
        first = stamp(os.fstat(fd))
        directories.append((path, first))
        with os.scandir(fd) as entries:
            for entry in entries:
                count += 1
                check_bound()
                info = entry.stat(follow_symlinks=False)
                if info.st_dev != before.st_dev:
                    raise ValueError('Project sample crosses a mount')
                if path == ('projects-v2',) and entry.name == '.run-claims' and (
                        not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o700):
                    raise ValueError('Unsafe project run-claim directory')
                if stat.S_ISLNK(info.st_mode):
                    pass  # Do not traverse or count an external link's target.
                elif stat.S_ISDIR(info.st_mode):
                    if add(info):
                        child = os.open(entry.name, DIR_FLAGS, dir_fd=fd)
                        try:
                            if stamp(os.fstat(child)) != stamp(info):
                                raise ValueError('Project directory changed')
                            visit(child, path+(entry.name,))
                        finally:
                            os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    add(info)
                else:
                    raise ValueError('Unexpected project entry type')
                if detail is not None and not stat.S_ISLNK(info.st_mode):
                    try:
                        detail.add(info, path+(entry.name,), fd)
                    except (OSError, ValueError):
                        # A breakdown-specific bound or unavailable ownership
                        # proof must not change the existing all-account total.
                        detail = None
                # Duplicate inodes and symlinks still receive a change check.
                if stamp(os.stat(entry.name, dir_fd=fd, follow_symlinks=False)) != stamp(info):
                    raise ValueError('Project entry changed')
                check_bound()
        if stamp(os.fstat(fd)) != first:
            raise ValueError('Project directory membership changed')

    for name in ROOTS:
        check_bound()
        try:
            info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            roots[name] = None
            continue
        roots[name] = stamp(info)
        fd = os.open(name, DIR_FLAGS, dir_fd=root_fd)
        try:
            if stamp(os.fstat(fd)) != roots[name]:
                raise ValueError('Managed project root changed')
            if add(info):
                visit(fd, (name,))
        finally:
            os.close(fd)

    # Recheck earlier directories after *all* roots, not just on recursion exit.
    for path, expected in directories:
        check_bound()
        fd = os.dup(root_fd)
        try:
            for name in path:
                check_bound()
                child = os.open(name, DIR_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = child
            if stamp(os.fstat(fd)) != expected:
                raise ValueError('Project directory changed during full sample')
        finally:
            os.close(fd)
    for name, expected in roots.items():
        check_bound()
        try:
            now = stamp(os.stat(name, dir_fd=root_fd, follow_symlinks=False))
        except FileNotFoundError:
            now = None
        if now != expected:
            raise ValueError('Managed project root membership changed')
    current = open_directory(root_path)
    try:
        if stamp(os.fstat(root_fd)) != stamp(before) or stamp(os.fstat(current)) != stamp(before):
            raise ValueError('Project observation root changed')
    finally:
        os.close(current)
    if mount_signature(root_path) != mounts:
        raise ValueError('Project mounts changed')
    check_bound()
    if not breakdown:
        return total
    projection = detail.result() if detail is not None else EMPTY_BREAKDOWN
    check_bound()
    return dict(total=total, projectUsage=projection)


def reap(pid):
    try:
        if os.waitpid(pid, os.WNOHANG)[0] == 0:
            # Only reaping, never scanning: do not block the capacity request
            # on a killed child stuck in kernel I/O. At most one refresh holds
            # this cache lock until that child actually exits.
            def finish():
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
            threading.Thread(target=finish, daemon=True).start()
    except ChildProcessError:
        pass


def bounded_sample(root, path):
    deadline = time.monotonic() + MAX_SECONDS
    reader, writer = os.pipe()
    try:
        pid = os.fork()
    except BaseException:
        os.close(reader)
        os.close(writer)
        raise
    if pid == 0:
        os.close(reader)
        try:
            result = sample(root, root_path=path, seconds=max(0, deadline-time.monotonic()), breakdown=True)
            raw = json.dumps(result, separators=(',', ':')).encode()
            if len(raw) > MAX_OBSERVATION_BYTES:
                raw = json.dumps(dict(total=result['total'], projectUsage=EMPTY_BREAKDOWN)).encode()
            view = memoryview(raw)
            while view:
                view = view[os.write(writer, view):]
        except BaseException:
            pass
        finally:
            os._exit(0)
    os.close(writer)
    try:
        parts, size = [], 0
        while True:
            ready, _, _ = select.select([reader], [], [], max(0, deadline-time.monotonic()))
            if not ready:
                raise ValueError('Project sample timed out')
            part = os.read(reader, 65536)
            if not part:
                break
            parts.append(part)
            size += len(part)
            if size > MAX_OBSERVATION_BYTES:
                raise ValueError('Project observation response bound reached')
        raw = b''.join(parts)
        value = json.loads(raw)
        if (set(value) != {'total', 'projectUsage'} or type(value['total']) is not int
                or not 0 <= value['total'] <= MAX_BYTES or not valid_breakdown(value['projectUsage'])
                or time.monotonic() >= deadline):
            raise ValueError('Incomplete project sample')
        return value
    finally:
        os.close(reader)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        reap(pid)


def private_file(fd, device):
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_dev != device or info.st_size > MAX_OBSERVATION_BYTES+4096):
        raise ValueError('Unsafe observation cache file')
    return info


def read_prior(folder, binding, device):
    try:
        fd = os.open('projects.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
    except FileNotFoundError:
        return None
    try:
        first = private_file(fd, device)
        raw = os.read(fd, MAX_OBSERVATION_BYTES+4097)
        if (len(raw) != first.st_size or len(raw) > MAX_OBSERVATION_BYTES+4096 or stamp(os.fstat(fd)) != stamp(first)
                or stamp(os.stat('projects.json', dir_fd=folder, follow_symlinks=False)) != stamp(first)):
            raise ValueError('Observation cache changed')
        prior = json.loads(raw)
    finally:
        os.close(fd)
    if (not isinstance(prior, dict) or set(prior) != {'protocol', 'binding', 'mountBinding', 'attemptedAt', 'value'}
            or type(prior['protocol']) is not int or prior['protocol'] != 1 or prior['binding'] != binding
            or type(prior['attemptedAt']) not in (int, float) or not 0 < prior['attemptedAt'] <= time.time()
            or not math.isfinite(prior['attemptedAt'])
            or not isinstance(prior['value'], dict)
            or set(prior['value']) not in (set(UNKNOWN), set(UNKNOWN)-{'projectUsage'})):
        raise ValueError('Invalid observation cache proof')
    value = prior['value']
    if 'projectUsage' not in value:
        value['projectUsage'] = EMPTY_BREAKDOWN
    if not valid_breakdown(value['projectUsage']):
        raise ValueError('Invalid cached project breakdown')
    if (type(value['projectUsageComplete']) is not bool
            or value['projectBytes'] is not None and (type(value['projectBytes']) is not int or not 0 <= value['projectBytes'] <= MAX_BYTES)
            or value['projectUsageComplete'] != (value['projectBytes'] is not None)):
        raise ValueError('Invalid project usage value')
    if (prior['mountBinding'] is not None and (not isinstance(prior['mountBinding'], str)
            or not re.fullmatch('[a-f0-9]{64}', prior['mountBinding']))
            or value['projectUsageComplete'] and prior['mountBinding'] is None):
        raise ValueError('Invalid cached mount binding')
    collected = value['projectCollectedAt']
    if collected is not None:
        if not isinstance(collected, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', collected):
            raise ValueError('Invalid project collection time')
        parsed = time.strptime(collected, '%Y-%m-%dT%H:%M:%SZ')
        if time.strftime('%Y-%m-%dT%H:%M:%SZ', parsed) != collected:
            raise ValueError('Noncanonical project collection time')
        import calendar
        if calendar.timegm(parsed) > prior['attemptedAt']:
            raise ValueError('Future project collection time')
    elif value['projectUsageComplete']:
        raise ValueError('Missing successful collection time')
    return prior


def check_current(node, root, folder, root_info, folder_info):
    node.platform_root_check()
    current = open_directory(node.ROOT)
    try:
        if identity(os.fstat(root)) != identity(root_info) or identity(os.fstat(current)) != identity(root_info):
            raise ValueError('Observation root changed')
        actual = os.stat('.storage-observations', dir_fd=current, follow_symlinks=False)
        if identity(actual) != identity(folder_info) or identity(os.fstat(folder)) != identity(folder_info):
            raise ValueError('Observation cache directory changed')
    finally:
        os.close(current)


def project_usage(node):
    value = dict(UNKNOWN)
    last_collected = None
    try:
        node.platform_root_check()
        with_fd = open_directory(node.ROOT)
        try:
            info = os.fstat(with_fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise ValueError('Unsafe project observation root')
            binding = hashlib.sha256(json.dumps([str(node.ROOT), identity(info)], separators=(',', ':')).encode()).hexdigest()
            try:
                os.mkdir('.storage-observations', 0o700, dir_fd=with_fd)
                os.fsync(with_fd)
            except FileExistsError:
                pass
            folder = os.open('.storage-observations', DIR_FLAGS, dir_fd=with_fd)
            try:
                safety = os.fstat(folder)
                if safety.st_dev != info.st_dev or safety.st_uid != os.geteuid() or stat.S_IMODE(safety.st_mode) != 0o700:
                    raise ValueError('Unsafe observation cache')
                lock = os.open('projects.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=folder)
                try:
                    lock_info = private_file(lock, info.st_dev)
                    if lock_info.st_size != 0:
                        raise ValueError('Invalid observation cache lock')
                    locked = True
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        locked = False
                    if stamp(os.stat('projects.lock', dir_fd=folder, follow_symlinks=False)) != stamp(lock_info):
                        raise ValueError('Observation cache lock changed')
                    prior = read_prior(folder, binding, info.st_dev)
                    if prior is not None:
                        last_collected = prior['value']['projectCollectedAt']
                        value['projectCollectedAt'] = last_collected
                    check_current(node, with_fd, folder, info, safety)
                    if prior is not None and time.time()-prior['attemptedAt'] < TTL_SECONDS:
                        if prior['value']['projectUsageComplete']:
                            actual = hashlib.sha256(repr(mount_signature(node.ROOT)).encode()).hexdigest()
                            if actual != prior['mountBinding']:
                                raise ValueError('Cached project mounts changed')
                        return prior['value']
                    if not locked:
                        return value
                    mount_binding = None
                    try:
                        mount_binding = hashlib.sha256(repr(mount_signature(node.ROOT)).encode()).hexdigest()
                        measurement = bounded_sample(with_fd, node.ROOT)
                        check_current(node, with_fd, folder, info, safety)
                        if hashlib.sha256(repr(mount_signature(node.ROOT)).encode()).hexdigest() != mount_binding:
                            raise ValueError('Project mounts changed during observation')
                        value = dict(projectBytes=measurement['total'], projectUsageComplete=True,
                                     projectCollectedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                     projectUsage=measurement['projectUsage'])
                    except (OSError, ValueError, RuntimeError):
                        pass
                    check_current(node, with_fd, folder, info, safety)
                    raw = json.dumps(dict(protocol=1, binding=binding, mountBinding=mount_binding,
                                          attemptedAt=time.time(), value=value), separators=(',', ':')).encode()
                    name = '.projects.'+os.urandom(16).hex()+'.tmp'
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
                    try:
                        try:
                            if os.write(fd, raw) != len(raw):
                                raise ValueError('Incomplete observation cache write')
                            os.fsync(fd)
                        finally:
                            os.close(fd)
                        check_current(node, with_fd, folder, info, safety)
                        os.replace(name, 'projects.json', src_dir_fd=folder, dst_dir_fd=folder)
                        os.fsync(folder)
                    finally:
                        try:
                            os.unlink(name, dir_fd=folder)
                        except FileNotFoundError:
                            pass
                    return value
                finally:
                    # Close only: a timed-out child in kernel I/O keeps the
                    # inherited lock until exit, preventing more hung scans.
                    os.close(lock)
            finally:
                os.close(folder)
        finally:
            os.close(with_fd)
    except (OSError, ValueError, RuntimeError):
        return dict(UNKNOWN, projectCollectedAt=last_collected)
