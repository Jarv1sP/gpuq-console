#!/usr/bin/python3
"""Node-local HTTPS downloads into the owner's mutable /data2 workspace.

Only fixed public headers are supported. URLs are private capabilities: never
put them in argv, journal output, exceptions, or public task receipts. Each
redirect is DNS-checked and connects to the checked address, with normal TLS
hostname verification. No requests library or environment proxy is involved.
"""
import fcntl
import hashlib
import http.client
import ipaddress
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import time
from urllib.parse import urljoin, urlsplit

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
TERMINAL = {'READY', 'FAILED', 'CANCELED', 'PAUSED'}
PUBLIC = ('operationId', 'state', 'path', 'bytes', 'totalBytes', 'sha256',
          'sha1', 'error', 'errorCode', 'createdAt', 'updatedAt', 'sourceKind')
BLOCK = 1024 * 1024
MAX_REDIRECTS = 5


class ImportFailure(ValueError):
    def __init__(self, code, message, state='FAILED'):
        super().__init__(message)
        self.code, self.state = code, state


def checked_url(value):
    if (not isinstance(value, str) or not value or len(value) > 16384
            or '\\' in value or any(ord(c) <= 32 or ord(c) >= 127 for c in value)):
        raise ImportFailure('URL', 'Use a valid HTTPS download link')
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if (parsed.scheme != 'https' or not host or parsed.username is not None
                or parsed.password is not None or parsed.fragment or parsed.port not in (None, 443)
                or '%' in host):
            raise ValueError()
        host = host.encode('idna').decode('ascii').lower()
        # Reject parser discrepancies, dotless service names and non-DNS forms.
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if (len(host) > 253 or '.' not in host or host.endswith('.')
                    or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', p) for p in host.split('.'))):
                raise ValueError()
        target = parsed.path or '/'
        if parsed.query:
            target += '?' + parsed.query
        return host, target
    except (ValueError, UnicodeError):
        raise ImportFailure('URL', 'Use a public HTTPS link on port 443 without embedded credentials') from None


def public_address(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if not address.is_global or address.is_multicast or address.is_reserved:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped or address.sixtofour or address.teredo:
            return False
        if any(address in ipaddress.ip_network(prefix) for prefix in ('64:ff9b::/96', '64:ff9b:1::/48')):
            return False
    return True


def resolve_public(host):
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        raise ImportFailure('NETWORK', 'Download host could not be resolved; retry later', 'PAUSED') from None
    if not records or any(not public_address(r[4][0]) for r in records):
        raise ImportFailure('PRIVATE_ADDRESS', 'Download links must resolve only to public Internet addresses')
    return records


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, records):
        super().__init__(host, 443, timeout=20, context=ssl.create_default_context())
        self.records = records

    def connect(self):
        # Do not resolve the hostname again after validation (DNS rebinding).
        for family, kind, protocol, _, address in self.records:
            sock = socket.socket(family, kind, protocol)
            try:
                sock.settimeout(20)
                sock.connect(address)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except ssl.SSLError:
                sock.close()
                raise ImportFailure('TLS', 'Download server TLS certificate verification failed') from None
            except OSError:
                sock.close()
        raise ImportFailure('NETWORK', 'Download server could not be reached; retry later', 'PAUSED')


def open_download(url, offset=0, etag=None, source_kind='https'):
    headers = {'User-Agent': 'GPUQ-DataImport/1.0', 'Accept-Encoding': 'identity'}
    if source_kind == 'aliyun':
        headers['Referer'] = 'https://www.alipan.com/'
    if offset:
        headers['Range'] = 'bytes=' + str(offset) + '-'
        if etag:
            headers['If-Range'] = etag
    for hop in range(MAX_REDIRECTS + 1):
        host, target = checked_url(url)
        connection = PinnedHTTPS(host, resolve_public(host))
        try:
            connection.request('GET', target, headers=headers)
            response = connection.getresponse()
        except ImportFailure:
            connection.close()
            raise
        except (OSError, http.client.HTTPException, ValueError):
            connection.close()
            raise ImportFailure('NETWORK', 'Download connection failed; retry later', 'PAUSED') from None
        if response.status in (301, 302, 303, 307, 308):
            location = response.getheader('Location')
            response.close(); connection.close()
            if not location or hop == MAX_REDIRECTS:
                raise ImportFailure('REDIRECT', 'Download redirect is missing or exceeds the redirect limit')
            # No body, cookies or authorization are carried across a redirect.
            url = urljoin(url, location)
            continue
        return connection, response
    raise ImportFailure('REDIRECT', 'Download redirect limit exceeded')


def strong_etag(value):
    return value if (isinstance(value, str) and re.fullmatch(r'"[\x21\x23-\x7e]{1,1024}"', value)) else None


class DataImports:
    def __init__(self, executor):
        self.n = executor
        self.w = executor.data_workspaces()
        configured = executor.CONFIG['datasets'].get('uploads', {})
        self.limits = {'maxUploadBytes': 1024**4, 'maxUserBytes': 2*1024**4,
                       'maxUserSessions': 1024, 'maxUserEntries': 2000000}
        for key in self.limits:
            value = configured.get(key, self.limits[key])
            if type(value) is not int or not 1 <= value <= 2**63-1:
                raise ValueError('Invalid personal data import limits')
            self.limits[key] = value

    def storage(self, user, key=None, create=False):
        module, cache, owner = self.w.storage(user)
        folder = owner/'imports'
        module._mkdir(folder)
        if key is not None:
            if not isinstance(key, str) or not UUID.fullmatch(key):
                raise ImportFailure('ID', 'A valid data import ID is required')
            folder = folder/key
            if create:
                module._mkdir(folder)
        return module, cache, owner, folder

    def load(self, user, key):
        module, _, _, folder = self.storage(user, key)
        task = module._read_json(folder/'task.json')
        if (not isinstance(task, dict) or task.get('schema') != 1 or task.get('userId') != user
                or task.get('operationId') != key or type(task.get('generation')) is not int
                or task.get('state') not in TERMINAL | {'QUEUED', 'RUNNING', 'CANCELING'}):
            raise ImportFailure('METADATA', 'Data import metadata is invalid; contact an administrator')
        return task

    def save(self, task):
        module, _, _, folder = self.storage(task['userId'], task['operationId'])
        task['updatedAt'] = time.time()
        module._write_json(folder/'task.json', task)

    @staticmethod
    def unit(task):
        return 'gpuq-import-'+hashlib.sha256((task['userId']+'\0'+task['operationId']).encode()).hexdigest()[:32]

    def stopped(self, task):
        try:
            return self.w.unit_stopped(self.unit(task)+'.service')
        except Exception:
            return False  # unknown is not permission to start a second writer

    def public(self, task, check=True):
        result = {key: task[key] for key in PUBLIC if key in task}
        stopped = self.stopped(task) if check else False
        if task['state'] not in TERMINAL and stopped:
            result.update(state='PAUSED', errorCode='INTERRUPTED',
                          error='Download worker stopped; resume the same import to continue')
        # Compact history is advisory; start always proves termination before
        # accepting a resume. Do not spawn systemctl for every old task in list.
        result['canResume'] = (stopped or not check) and result['state'] in ('PAUSED', 'FAILED', 'CANCELED')
        result['canDiscard'] = stopped
        return result

    def tasks(self, user):
        module, _, _, folder = self.storage(user)
        with module._directory(folder) as fd:
            names = os.listdir(fd)
        keys = sorted(name for name in names if UUID.fullmatch(name))
        if len(keys) > self.limits['maxUserSessions']:
            raise ImportFailure('QUOTA', 'Too many retained data imports; contact an administrator')
        return [self.load(user, key) for key in keys]

    def part_size(self, task):
        module, _, _, folder = self.storage(task['userId'], task['operationId'])
        try:
            with module._directory(folder) as fd:
                part = os.open('payload.part', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                info = os.fstat(part)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or info.st_mode & 0o077 or info.st_nlink not in (1, 2)):
                    raise ImportFailure('FILE', 'Import staging file is not safe')
                if info.st_nlink == 2 and task.get('phase') != 'COMMITTING':
                    raise ImportFailure('FILE', 'Import staging file has unexpected links')
                return info.st_size
            finally:
                os.close(part)
        except FileNotFoundError:
            return 0

    def reservation(self, task, remaining):
        module, cache, _, _ = self.storage(task['userId'], task['operationId'])
        name = hashlib.sha256(('import\0'+task['userId']+'\0'+task['operationId']).encode()).hexdigest()+'.json'
        location = cache.root/'.upload-reservations'/name
        with cache._locked():
            try:
                prior = module._read_json(location)['bytes']
            except FileNotFoundError:
                prior = 0
            if remaining:
                try:
                    cache._free(cache._reserved()-prior+remaining, needed_inodes=16)
                except Exception:
                    raise ImportFailure('SPACE', 'Insufficient free space including the safety reserve', 'PAUSED') from None
                module._write_json(location, {'bytes': remaining, 'inodes': 16})
            else:
                with module._directory(location.parent) as fd:
                    try:
                        os.unlink(name, dir_fd=fd)
                        os.fsync(fd)
                    except FileNotFoundError:
                        pass

    def usage(self, user, except_key):
        module, _, owner, _ = self.storage(user)
        total = entries = 0
        # One admission scan, never per chunk. Symlinks do not escape the root.
        def walk(parent, depth=0):
            nonlocal total, entries
            if depth > 64:
                raise ImportFailure('QUOTA', 'Personal data directory nesting exceeds the import limit')
            for name in os.listdir(parent):
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                entries += 1
                if entries > self.limits['maxUserEntries']:
                    raise ImportFailure('QUOTA', 'Personal data workspace contains too many entries')
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    try:
                        walk(child, depth+1)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    total += info.st_size
        with module._directory(owner/'data') as fd:
            walk(fd)
        for task in self.tasks(user):
            if task['operationId'] != except_key:
                total += self.part_size(task)
        return total

    def start(self, args):
        user, key = args['userId'], args.get('key')
        checked_url(args.get('url'))  # syntax only; worker resolves and validates every hop
        self.w.relative(args.get('path'))
        source = args.get('sourceKind', 'https')
        if source not in ('https', 'aliyun'):
            raise ImportFailure('SOURCE', 'Unsupported download source')
        identity = {name: args.get(name) for name in ('path', 'sha256', 'expectedSha1', 'expectedBytes')}
        identity['sourceKind'] = source
        for field, size in (('sha256', 64), ('expectedSha1', 40)):
            if identity[field] is not None and (not isinstance(identity[field], str)
                    or not re.fullmatch('[a-f0-9]{'+str(size)+'}', identity[field])):
                raise ImportFailure('HASH', 'Expected checksum must be lowercase hexadecimal')
        expected = identity['expectedBytes']
        if expected is not None and (type(expected) is not int or not 0 <= expected <= self.limits['maxUploadBytes']):
            raise ImportFailure('SIZE', 'Expected size exceeds the per-file import limit')
        module, _, _, folder = self.storage(user, key)
        try:
            previous = self.load(user, key)
        except FileNotFoundError:
            previous = None
        if previous:
            if previous['identity'] != identity:
                raise ImportFailure('CONFLICT', 'Import key belongs to a different destination, size or checksum')
            if previous['state'] == 'READY' or not self.stopped(previous):
                return self.public(previous)
            if (self.part_size(previous) and previous.get('url') != args['url']
                    and not (identity['sha256'] or identity['expectedSha1'])):
                old, new = urlsplit(previous['url']), urlsplit(args['url'])
                if (old.hostname, old.path) != (new.hostname, new.path):
                    raise ImportFailure('RESUME', 'Refreshing a different download resource requires an expected checksum; use a new import to restart')
        tasks = self.tasks(user)
        if not previous and len(tasks) >= self.limits['maxUserSessions']:
            raise ImportFailure('QUOTA', 'Too many retained data imports; contact an administrator')
        for task in tasks:
            if task['operationId'] != key and task['state'] not in TERMINAL:
                if not self.stopped(task):
                    raise ImportFailure('BUSY', 'Another data import is active in this personal workspace')
                task.update(state='PAUSED', errorCode='INTERRUPTED', error='Download worker stopped; resume this import to continue')
                self.reservation(task, 0); self.save(task)
        self.w.writable(args)
        self.w.no_terminals(user)
        lock = self.w.lifetime(user, exclusive=True)
        try:
            self.storage(user, key, create=True)
            task = previous or {'schema': 1, 'userId': user, 'operationId': key,
                'identity': identity, 'path': identity['path'], 'sourceKind': source,
                'generation': 0, 'createdAt': time.time(), 'bytes': 0}
            task.update(state='QUEUED', url=args['url'], generation=task['generation']+1, cancelRequested=False)
            task.pop('error', None); task.pop('errorCode', None)
            self.save(task)  # durable fence before an ambiguous systemd launch
            try:
                self.n.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit='+self.unit(task),
                    '--property=KillMode=control-group', '--property=UMask=0077', '--property=CPUQuota=100%',
                    '--property=MemoryMax=512M', '--property=TasksMax=32', '--property=IOWeight=10',
                    '--property=RuntimeMaxSec=172800', '--property=TimeoutStopSec=25',
                    '--property=StandardOutput=null', '--property=StandardError=null',
                    '/usr/bin/python3', str(self.n.HERE/'node-executor.py'), '--data-import-worker',
                    user, key, str(task['generation'])], timeout=8)
            except Exception:
                # Never reveal launcher stderr, host paths, or erase its fence.
                task.update(errorCode='START_UNCONFIRMED', error='Worker launch is unconfirmed; refresh status before retrying')
                self.save(task)
            return self.public(task, check=False)
        finally:
            os.close(lock)

    def progress(self, task, offset, **extra):
        with self.w.guard({'userId': task['userId']}, blocking=True):
            current = self.load(task['userId'], task['operationId'])
            if current['generation'] != task['generation']:
                raise ImportFailure('STALE', 'This download worker has been replaced', 'PAUSED')
            if current.get('cancelRequested'):
                raise ImportFailure('CANCELED', 'Download canceled; partial data is retained for a verified resume', 'CANCELED')
            task.update(bytes=offset, **extra)
            self.save(task)

    def response_info(self, task, response, offset):
        if response.status in (401, 403, 410):
            raise ImportFailure('EXPIRED', 'Download link expired or access was denied; refresh the link and resume', 'PAUSED')
        if response.status not in (200, 206):
            state = 'PAUSED' if response.status == 429 or response.status >= 500 else 'FAILED'
            raise ImportFailure('HTTP', 'Download server returned HTTP '+str(response.status), state)
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise ImportFailure('ENCODING', 'Download server must return uncompressed transfer bytes')
        length = response.getheader('Content-Length')
        if not isinstance(length, str) or not re.fullmatch(r'[0-9]{1,19}', length):
            raise ImportFailure('SIZE', 'A download link with a known Content-Length is required')
        length = int(length)
        etag = strong_etag(response.getheader('ETag'))
        identity = task['identity']
        if offset:
            match = re.fullmatch(r'bytes ([0-9]+)-([0-9]+)/([0-9]+)', response.getheader('Content-Range', ''))
            if response.status != 206 or not match:
                raise ImportFailure('RESUME', 'Server did not honor the byte range; use a new import to restart')
            begin, end, total = map(int, match.groups())
            if begin != offset or end != total-1 or length != total-offset or total != task.get('totalBytes'):
                raise ImportFailure('CHANGED', 'Download content size changed; do not resume this partial file')
            if task.get('etag') and task['etag'] != etag:
                raise ImportFailure('CHANGED', 'Download version changed; do not resume this partial file')
            if not task.get('etag') and not (identity['sha256'] or identity['expectedSha1']):
                raise ImportFailure('RESUME', 'Safe resume requires a stable ETag or an expected checksum')
        else:
            if response.status != 200:
                raise ImportFailure('RANGE', 'Download server returned an unexpected partial response')
            total = length
        if total > self.limits['maxUploadBytes']:
            raise ImportFailure('QUOTA', 'Download exceeds the per-file import limit')
        if identity['expectedBytes'] is not None and identity['expectedBytes'] != total:
            raise ImportFailure('CHANGED', 'Download size does not match the selected file')
        return total, etag

    def commit(self, task, module, owner, folder, recovery=False):
        parts = self.w.relative(task['path'])
        parent = owner/'data'
        for part in parts[:-1]:
            parent /= part
            module._mkdir(parent)
        # link/unlink is atomic-no-replace on the same filesystem. COMMITTING
        # plus the digest permits recovery if interrupted between these steps.
        with module._directory(parent) as dst, module._directory(folder) as src:
            if recovery:
                # A crash after link makes the file visible in the mutable
                # workspace. It may have been edited while the worker was down.
                try:
                    source_fd = os.open('payload.part', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=src)
                except FileNotFoundError:
                    source_fd = None
                if source_fd is not None:
                    try:
                        info = os.fstat(source_fd)
                        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                                or info.st_nlink not in (1, 2) or info.st_size != task['totalBytes']):
                            raise ImportFailure('CHANGED', 'Interrupted import changed; manual review is required')
                        digest = hashlib.sha256()
                        while True:
                            chunk = os.read(source_fd, BLOCK)
                            if not chunk:
                                break
                            digest.update(chunk)
                        if digest.hexdigest() != task['sha256']:
                            raise ImportFailure('CHANGED', 'Interrupted import changed; manual review is required')
                    finally:
                        os.close(source_fd)
            try:
                os.link('payload.part', parts[-1], src_dir_fd=src, dst_dir_fd=dst, follow_symlinks=False)
                os.fsync(dst)
            except FileExistsError:
                final = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dst)
                try:
                    info = os.fstat(final)
                    if not stat.S_ISREG(info.st_mode) or info.st_size != task['totalBytes']:
                        raise ImportFailure('EXISTS', 'Destination already exists; choose a different filename')
                    try:
                        source = os.stat('payload.part', dir_fd=src, follow_symlinks=False)
                    except FileNotFoundError:
                        source = None
                    if source is not None and (source.st_dev, source.st_ino) != (info.st_dev, info.st_ino):
                        raise ImportFailure('EXISTS', 'Destination already exists; choose a different filename')
                    if source is None:
                        digest = hashlib.sha256()
                        while True:
                            chunk = os.read(final, BLOCK)
                            if not chunk:
                                break
                            digest.update(chunk)
                        if digest.hexdigest() != task['sha256']:
                            raise ImportFailure('CHANGED', 'Completed destination changed; manual review is required')
                finally:
                    os.close(final)
            except FileNotFoundError:
                # Source may already have been unlinked by a previous commit.
                final = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dst)
                try:
                    info = module._regular(final)
                    digest = hashlib.sha256()
                    while True:
                        chunk = os.read(final, BLOCK)
                        if not chunk:
                            break
                        digest.update(chunk)
                    if info.st_size != task['totalBytes'] or digest.hexdigest() != task['sha256']:
                        raise ImportFailure('CHANGED', 'Completed destination changed; manual review is required')
                finally:
                    os.close(final)
            try:
                os.unlink('payload.part', dir_fd=src)
                os.fsync(src)
            except FileNotFoundError:
                pass

    def worker(self, user, key, generation):
        task = None
        lifetime = stream = connection = response = worker_lock = None
        owned = False
        try:
            module, _, _, folder = self.storage(user, key)
            with module._directory(folder) as parent:
                worker_lock = os.open('worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
            module._regular(worker_lock)
            try:
                fcntl.flock(worker_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
            with self.w.guard({'userId': user}, blocking=True):
                task = self.load(user, key)
                if str(task['generation']) != str(generation) or task['state'] not in ('QUEUED', 'CANCELING'):
                    return 0
                owned = True
                if task.get('cancelRequested'):
                    raise ImportFailure('CANCELED', 'Download canceled', 'CANCELED')
                self.w.writable({'userId': user})
                self.w.no_terminals(user)
                lifetime = self.w.lifetime(user, exclusive=True)
                task['state'] = 'RUNNING'
                self.save(task)
            module, _, owner, folder = self.storage(user, key)
            recovering_commit = task.get('phase') == 'COMMITTING'
            if task.get('phase') != 'COMMITTING':
                with module._directory(folder) as fd:
                    part = os.open('payload.part', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
                stream = os.fdopen(part, 'r+b')
                info = module._regular(stream.fileno())
                if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                    raise ImportFailure('FILE', 'Import staging file is not private')
                offset = info.st_size
                sha256, sha1 = hashlib.sha256(), hashlib.sha1()
                while True:
                    chunk = stream.read(BLOCK)
                    if not chunk:
                        break
                    sha256.update(chunk); sha1.update(chunk)
                self.progress(task, offset)
                if not (offset and offset == task.get('totalBytes')):
                    if offset and not task.get('etag') and not (task['identity']['sha256'] or task['identity']['expectedSha1']):
                        raise ImportFailure('RESUME', 'Safe resume requires a stable ETag or an expected checksum')
                    connection, response = open_download(task['url'], offset, task.get('etag'), task['sourceKind'])
                    total, etag = self.response_info(task, response, offset)
                    if self.usage(user, key)+total > self.limits['maxUserBytes']:
                        raise ImportFailure('QUOTA', 'Personal data storage limit would be exceeded')
                    self.reservation(task, total-offset+65536)
                    self.progress(task, offset, totalBytes=total, etag=etag)
                    last_saved = time.monotonic()
                    last_bytes = offset
                    while True:
                        chunk = response.read(min(BLOCK, total-offset+1))
                        if not chunk:
                            break
                        if offset+len(chunk) > total:
                            raise ImportFailure('SIZE', 'Download body exceeds the declared file size')
                        stream.write(chunk)
                        sha256.update(chunk); sha1.update(chunk)
                        offset += len(chunk)
                        if offset-last_bytes >= 8*BLOCK or time.monotonic()-last_saved >= 1:
                            stream.flush(); os.fsync(stream.fileno())
                            self.reservation(task, total-offset+65536)
                            self.progress(task, offset)
                            last_saved, last_bytes = time.monotonic(), offset
                    stream.flush(); os.fsync(stream.fileno())
                    if offset != total:
                        raise ImportFailure('NETWORK', 'Download connection ended before the complete file arrived', 'PAUSED')
                for field, actual in (('sha256', sha256.hexdigest()), ('expectedSha1', sha1.hexdigest())):
                    if task['identity'][field] and task['identity'][field] != actual:
                        raise ImportFailure('CHECKSUM', 'Downloaded file checksum does not match; use a new import to restart')
                self.progress(task, offset, sha256=sha256.hexdigest(), sha1=sha1.hexdigest(), phase='COMMITTING')
                stream.close(); stream = None
            with self.w.guard({'userId': user}, blocking=True):
                current = self.load(user, key)
                if current.get('cancelRequested'):
                    raise ImportFailure('CANCELED', 'Download canceled; verified partial data is retained', 'CANCELED')
                self.commit(task, module, owner, folder, recovery=recovering_commit)
                task.update(state='READY', bytes=task['totalBytes'])
                task.pop('error', None); task.pop('errorCode', None)
                task.pop('url', None)  # completed receipts no longer need the capability
                self.save(task)
            return 0
        except Exception as exc:
            if stream is not None:
                try:
                    stream.flush()
                    os.fsync(stream.fileno())
                except OSError:
                    pass
            if task is not None and owned:
                failure = exc if isinstance(exc, ImportFailure) else ImportFailure('IO', 'Download interrupted by a network, storage or workspace error; retry after checking the workspace', 'PAUSED')
                with self.w.guard({'userId': user}, blocking=True):
                    current = self.load(user, key)
                    if str(current['generation']) == str(generation):
                        current.update(state=failure.state, error=str(failure), errorCode=failure.code,
                                       bytes=self.part_size(current))
                        self.save(current)
            return 1
        finally:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()
            if stream is not None:
                stream.close()
            if task is not None and owned:
                try:
                    self.reservation(task, 0)
                except Exception:
                    pass  # stale reservation is conservative; next resume repairs it
            if lifetime is not None:
                os.close(lifetime)
            if worker_lock is not None:
                os.close(worker_lock)

    def process(self, operation, args):
        allowed = {
            'datasets.import.start': {'key', 'url', 'path', 'sourceKind', 'sha256', 'expectedSha1', 'expectedBytes'},
            'datasets.import.status': {'operationId'},
            'datasets.import.cancel': {'operationId'},
            'datasets.import.discard': {'operationId'},
            'datasets.import.list': set()}
        if (operation not in allowed or not isinstance(args, dict)
                or set(args)-allowed[operation]-{'userId', 'hostAdmin'}
                or args.get('hostAdmin', False) is not False):
            raise ValueError('Invalid personal data import request')
        try:
            self.n.workspace(args['userId'])
            with self.w.guard(args, blocking=True):
                if operation == 'datasets.import.start':
                    return self.start(args)
                if operation == 'datasets.import.list':
                    tasks = sorted(self.tasks(args['userId']), key=lambda t: t['createdAt'], reverse=True)
                    return {'imports': [self.public(t, check=t['state'] not in TERMINAL) for t in tasks[:50]],
                            'total': len(tasks), 'limit': 50}
                if operation == 'datasets.import.discard':
                    return self.discard(args['userId'], args.get('operationId'))
                task = self.load(args['userId'], args.get('operationId'))
                if operation == 'datasets.import.cancel' and task['state'] != 'READY':
                    task['cancelRequested'] = True
                    if self.stopped(task):
                        task.update(state='CANCELED', errorCode='CANCELED', error='Download canceled; partial data is retained')
                        self.reservation(task, 0)
                    else:
                        task['state'] = 'CANCELING'
                    self.save(task)
                return self.public(task)
        except ImportFailure:
            raise
        except FileNotFoundError:
            raise ValueError('Data import was not found in this personal workspace') from None
        except Exception:
            raise ValueError('Data import could not access this workspace; close its data terminals and retry') from None

    def discard(self, user, key):
        module, _, _, folder = self.storage(user, key)
        try:
            task = self.load(user, key)
        except FileNotFoundError:
            # Interrupted cleanup may have removed task.json already. The
            # directory is still derived exclusively from the authenticated ID.
            task = {'userId': user, 'operationId': key}
            try:
                with module._directory(folder):
                    pass
            except FileNotFoundError:
                return {'discarded': True, 'operationId': key}
        if not self.stopped(task):
            raise ImportFailure('BUSY', 'Import worker is running or its termination is unconfirmed; cancel and wait before discarding')
        lifetime = self.w.lifetime(user, exclusive=True)
        worker_lock = None
        try:
            with module._directory(folder) as fd:
                worker_lock = os.open('worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
                module._regular(worker_lock)
                try:
                    fcntl.flock(worker_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise ImportFailure('BUSY', 'Import worker has not released its files; retry shortly') from None
                names = os.listdir(fd)
                # Refuse unexpected contents before deleting anything. Never
                # recurse and never follow links out of this task directory.
                for name in names:
                    if name not in ('task.json', 'payload.part', 'worker.lock') and not re.fullmatch(r'\.write-[a-f0-9]{32}', name):
                        raise ImportFailure('METADATA', 'Unexpected import files require administrator review')
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    links = (1, 2) if name == 'payload.part' and task.get('phase') == 'COMMITTING' else (1,)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink not in links:
                        raise ImportFailure('FILE', 'Unsafe import files require administrator review')
                self.reservation(task, 0)
                for name in sorted(names, key=lambda name: name == 'task.json'):
                    os.unlink(name, dir_fd=fd)
                os.fsync(fd)
            with module._directory(folder.parent) as parent:
                os.rmdir(folder.name, dir_fd=parent)
                os.fsync(parent)
            return {'discarded': True, 'operationId': key}
        finally:
            if worker_lock is not None:
                os.close(worker_lock)
            os.close(lifetime)
