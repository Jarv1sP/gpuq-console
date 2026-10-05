"""Pre-sealed, permanently pinned authority grants and pinned-TLS recovery.

No listener, background job, GC switch, or public management API is installed.
AuthorityStore.seal and RemoteAuthority.install_grant are trusted ADMIN entry
points only. seal hashes/indexes the entire version and belongs in an explicit
maintenance/background job, never an HTTP request. The peer calls read ONLY.

Construct the source from an explicitly configured protected HDD DatasetCache;
do not infer media, root paths, machines, grants or endpoints from request JSON.
Permanent authority-* pins freeze source ACL/registration and prohibit ordinary
unpin. Explicit private retirement must reconcile every dependent cache and
write permanent source/target fences before releasing any authority pin.
"""
import base64
import contextlib
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sqlite3
import stat
import time


def _module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


T = _module('gpuq_authority_tier', 'dataset-tier.py')
D = T.D
J = _module('gpuq_authority_peer_client', 'transfer-jobs.py')
PROTOCOL = 'storage-authority-v1'
CHUNK = 1024**2
MAX_MANIFEST = 64*CHUNK


def _machine(value):
    if not isinstance(value, str) or not J.MACHINE.fullmatch(value):
        raise ValueError('An exact configured machine is required')
    return value


def _admin(actor):
    if getattr(actor, 'is_admin', None) is not True:
        raise PermissionError('Trusted administrator authority required')


def _private_root(path):
    root = D._absolute(path)
    missing = []; parent = root
    while not parent.exists():
        missing.append(parent); parent = parent.parent
    for folder in reversed(missing): D._mkdir(folder)
    with D._directory(root) as fd:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Authority/grant state must be service-owned and private')
    return root


def _load(path):
    with D._directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
        try:
            info = D._regular(fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 65536:
                raise ValueError('Unsafe private authority receipt')
            return json.loads(os.read(fd, 65537))
        finally:
            os.close(fd)


def _sha(value):
    return hashlib.sha256(D._json_bytes(value)).hexdigest()


@contextlib.contextmanager
def _grant_lock(root, name='.install.lock', timeout=None):
    with D._directory(root) as parent:
        # Separate exclusive creation from opening an existing lock. In
        # particular, concurrent O_CREAT|O_NOFOLLOW can report ENOENT on macOS.
        try:
            fd = os.open(name,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600,dir_fd=parent)
        except FileExistsError:
            fd = os.open(name,os.O_RDWR|os.O_NOFOLLOW,dir_fd=parent)
        try:
            info = D._regular(fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError('Unsafe grant installation lock')
            if timeout is None:
                fcntl.flock(fd,fcntl.LOCK_EX)
            else:
                deadline = time.monotonic()+timeout
                while True:
                    try:
                        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise ValueError('Authority grant is busy; no retirement or replacement is permitted')
                        time.sleep(.02)
            yield
        finally: os.close(fd)


def _validate_grant(grant, machine, target):
    if len(D._json_bytes(grant)) > 65536: raise ValueError('Authority grant metadata exceeds 64 KiB')
    if (not isinstance(grant, dict) or set(grant) != {'schema','id','sourceMachine','targetMachine','dataset','version','token','receipt'}
            or grant['schema'] != 1 or grant['sourceMachine'] != machine or grant['targetMachine'] != target
            or not isinstance(grant['token'], str) or len(grant['token']) != 43
            or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-' for c in grant['token'])):
        raise ValueError('Invalid fixed private authority grant')
    J.identifier(grant['id']); D._identifier(grant['dataset']); D._identifier(grant['version'], D.HASH_RE)
    receipt = grant['receipt']
    if (not isinstance(receipt, dict) or set(receipt) != {'protocol','id','sourceMachine','targetMachine','dataset','version','owners','pinId','manifestBytes','manifestSha256','totalBytes','entries','sealedSha256'}
            or receipt['protocol'] != PROTOCOL or any(receipt[k] != grant[k] for k in ('id','sourceMachine','targetMachine','dataset','version'))
            or not isinstance(receipt['owners'], list) or not receipt['owners']
            or receipt['owners'] != sorted(set(receipt['owners']))
            or not isinstance(receipt['pinId'], str) or not receipt['pinId'].startswith('authority-')
            or type(receipt['manifestBytes']) is not int or not 1 <= receipt['manifestBytes'] <= MAX_MANIFEST
            or type(receipt['totalBytes']) is not int or not 0 <= receipt['totalBytes'] <= 2**53-1
            or type(receipt['entries']) is not int or not 0 <= receipt['entries'] <= 500000):
        raise ValueError('Invalid sealed authority receipt')
    for owner in receipt['owners']: D._identifier(owner, D.USER_RE)
    D._identifier(receipt['pinId'])
    for key in ('manifestSha256', 'sealedSha256'): D._identifier(receipt[key], D.HASH_RE)
    return grant


class AuthorityStore:
    """Trusted protected source; principal is its internal cache-module admin."""
    def __init__(self, cache, machine, private_root, *, principal):
        cache._actor(principal, admin=True)
        self.cache, self.machine, self.principal = cache, _machine(machine), principal
        self.root = _private_root(private_root)
        self.local = T.LocalAuthority(cache)

    def reference_lock(self, dataset, version):
        D._identifier(dataset); D._identifier(version,D.HASH_RE)
        return _grant_lock(self.root, '.reference-'+_sha([dataset,version])+'.lock', timeout=2)

    def reference_fence(self, dataset, version):
        D._identifier(dataset); D._identifier(version,D.HASH_RE)
        return self.root/('.retired-'+_sha([dataset,version])+'.json')

    def assert_live(self, dataset, version):
        try:
            _load(self.reference_fence(dataset,version))
        except FileNotFoundError:
            return
        raise ValueError('Authority reference was permanently retired; it cannot be reissued')

    def seal(self, actor, dataset, version, grant_id, target_machine):
        """Offline/long-running ADMIN operation; never reachable via read()."""
        self.cache._actor(actor, admin=True)
        D._identifier(dataset); D._identifier(version, D.HASH_RE); J.identifier(grant_id)
        target_machine = _machine(target_machine)
        if target_machine == self.machine: raise ValueError('Remote grant requires another target machine')
        folder = self.root/grant_id
        # A source-cache lock file serializes retrying issuers without scanning
        # or rewriting any existing dataset or unrelated grant.
        with self.reference_lock(dataset,version), self.cache._lock_file('.locks/authority-issue-'+grant_id+'.lock'):
            self.assert_live(dataset,version)
            try:
                grant = _load(folder/'grant.json')
            except FileNotFoundError:
                grant = None
            if grant is not None:
                grant = _validate_grant(grant, self.machine, target_machine)
                if grant['dataset'] != dataset or grant['version'] != version:
                    raise ValueError('Authority grant ID cannot change fixed content')
                self.read({'id':grant_id,'action':'guard','dataset':dataset,'version':version,
                           'targetMachine':target_machine}, grant['token'])
                return grant
            proof = self.local.seal(actor, dataset, version, 'authority-'+grant_id)
            # Seal's permanent pin protects the source across this lock handoff
            # and a crash. No HTTP reader can see a grant until publication.
            with self.local.guard(self.principal, proof):
                record = self.cache._record(self.principal, dataset, version)
                manifest = record['manifest']
                raw = D._json_bytes(manifest)
                if len(raw) > MAX_MANIFEST: raise ValueError('Authority manifest exceeds 64 MiB')
                D._mkdir(folder)
                D._write_json(folder/'manifest.json', manifest)
                with contextlib.closing(sqlite3.connect(folder/'index.sqlite')) as db:
                    os.chmod(folder/'index.sqlite', 0o600)
                    db.execute('CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER NOT NULL)')
                    db.execute('DELETE FROM files')
                    db.executemany('INSERT INTO files(path,size) VALUES (?,?)', ((r['path'],r['size']) for r in manifest['files']))
                    db.commit()
                with open(folder/'index.sqlite', 'rb') as stream: os.fsync(stream.fileno())
                D._write_json(folder/'sealed.json', proof)
                receipt = dict(protocol=PROTOCOL,id=grant_id,sourceMachine=self.machine,targetMachine=target_machine,
                    dataset=dataset,version=version,owners=proof['owners'],pinId=proof['pinId'],
                    manifestBytes=len(raw),manifestSha256=hashlib.sha256(raw).hexdigest(),
                    totalBytes=sum(f['size'] for f in manifest['files']),
                    entries=len(manifest['files'])+len(manifest['directories']),sealedSha256=_sha(proof))
                grant = dict(schema=1,id=grant_id,sourceMachine=self.machine,targetMachine=target_machine,
                             dataset=dataset,version=version,token=secrets.token_urlsafe(32),receipt=receipt)
                _validate_grant(grant,self.machine,target_machine)
                D._write_json(folder/'grant.json', grant)
                return grant

    def read(self, request, token):
        """ONLY peer operation: fixed grant guard/manifest/get, never mutations."""
        if not isinstance(request, dict): raise ValueError('Invalid authority request')
        action = request.get('action')
        base = {'id','action','dataset','version','targetMachine'}
        extra = {'guard': set(), 'retirement-guard': set(), 'manifest': {'offset'}, 'get': {'path','offset'}}.get(action)
        if extra is None or set(request) != base|extra: raise ValueError('Authority endpoint is read-only')
        key = J.identifier(request['id']); folder = self.root/key
        grant = _validate_grant(_load(folder/'grant.json'), self.machine, request['targetMachine'])
        if (not isinstance(token, str) or not hmac.compare_digest(token, grant['token'])
                or request['dataset'] != grant['dataset'] or request['version'] != grant['version']):
            raise PermissionError('Authority grant does not authorize this fixed reference')
        proof = _load(folder/'sealed.json')
        if _sha(proof) != grant['receipt']['sealedSha256']:
            raise ValueError('Authority seal changed')
        with self.local.guard(self.principal, proof):
            self.assert_live(grant['dataset'],grant['version'])
            if action == 'guard': return grant['receipt']
            if action == 'retirement-guard':
                return dict(protocol='authority-retirement-v1',receipt=grant['receipt'])
            offset = request['offset']
            if type(offset) is not int or offset < 0: raise ValueError('Invalid authority offset')
            if action == 'manifest':
                path, size = folder/'manifest.json', grant['receipt']['manifestBytes']
            else:
                D._relative(request['path'])
                with contextlib.closing(sqlite3.connect(f'file:{folder / "index.sqlite"}?mode=ro', uri=True)) as db:
                    entry = db.execute('SELECT size FROM files WHERE path=?', (request['path'],)).fetchone()
                if entry is None: raise ValueError('Path is outside the sealed manifest')
                path = self.cache._paths(grant['dataset'],grant['version'])['ready']/'data'/request['path']; size = entry[0]
            if offset > size: raise ValueError('Authority offset exceeds fixed file size')
            with D._directory(path.parent) as parent:
                fd = os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
                try:
                    before = D._regular(fd)
                    if before.st_size != size: raise ValueError('Sealed authority file size changed')
                    data = os.pread(fd,min(CHUNK,size-offset),offset)
                    if D._stamp(before) != D._stamp(os.fstat(fd)): raise ValueError('Sealed authority changed during read')
                finally: os.close(fd)
            return dict(data=base64.b64encode(data).decode(),offset=offset+len(data),size=size,eof=offset+len(data)==size)


class AuthorityClient(J.PeerClient):
    """Reuse the existing DER-pin-before-bearer TLS connection implementation."""
    def call(self, action, **fields):
        try:
            self.connect()
            grant = self.ticket
            payload = json.dumps(dict(id=grant['id'],action=action,dataset=grant['dataset'],
                version=grant['version'],targetMachine=grant['targetMachine'],**fields)).encode()
            self.connection.request('POST','/authority',body=payload,
                headers={'Content-Type':'application/json','Authorization':'Bearer '+grant['token']})
            response = self.connection.getresponse(); raw = response.read(1500001)
            if len(raw) > 1500000: raise ValueError('Authority response exceeds bound')
            value = json.loads(raw)
            if response.status != 200 or not isinstance(value,dict) or value.get('ok') is not True:
                raise ValueError('Protected authority is unavailable')
            return value['result']
        except Exception:
            self.close(); raise


class RemoteAuthority:
    recovery_protocol = 'dataset-tier-recovery-v1'

    def __init__(self, machine, peer_config, grant_root, *, target_machine):
        self.machine, self.target_machine = _machine(machine), _machine(target_machine)
        if self.machine == self.target_machine: raise ValueError('Remote authority requires another machine')
        self.peer = dict(peer_config)
        J.PeerClient(self.peer, {}).close()  # Fixed administrator config only.
        self.root = _private_root(grant_root)

    def _path(self, dataset, version):
        D._identifier(dataset); D._identifier(version,D.HASH_RE)
        return self.root/(_sha([self.machine,self.target_machine,dataset,version])+'.json')

    def scope(self, dataset, version):
        return _grant_lock(self.root,'.grant-'+self._path(dataset,version).stem+'.lock',timeout=2)

    def fence_path(self, dataset, version):
        return self.root/('.retired-'+self._path(dataset,version).stem+'.json')

    def assert_live(self, dataset, version):
        try:
            _load(self.fence_path(dataset,version))
        except FileNotFoundError:
            return
        raise ValueError('Installed authority grant was permanently retired')

    def install_grant(self, grant):
        """Trusted administrator provisioning ONLY, never a peer/public action."""
        grant = _validate_grant(grant,self.machine,self.target_machine)
        path = self._path(grant['dataset'],grant['version'])
        with self.scope(grant['dataset'],grant['version']):
            self.assert_live(grant['dataset'],grant['version'])
            try:
                previous = _load(path)
                if previous != grant: raise ValueError('Installed authority grant cannot be silently replaced')
            except FileNotFoundError:
                D._write_json(path,grant)
        return dict(installed=True,dataset=grant['dataset'],version=grant['version'])

    def _grant(self, dataset, version):
        self.assert_live(dataset,version)
        return _validate_grant(_load(self._path(dataset,version)),self.machine,self.target_machine)

    def _proof(self, grant):
        receipt = grant['receipt']
        return dict(schema=1,kind='remote-protected-v1',machine=self.machine,targetMachine=self.target_machine,
            dataset=grant['dataset'],version=grant['version'],owners=receipt['owners'],pinId=receipt['pinId'],
            grantId=grant['id'],receiptSha256=_sha(receipt),certificateSha256=self.peer['certificateSha256'])

    def _authenticated(self, client, grant):
        if client.call('guard') != grant['receipt']: raise ValueError('Remote sealed authority identity changed')

    def seal(self, actor, dataset, version, pin_id):
        _admin(actor); D._identifier(pin_id)
        if not pin_id.startswith('authority-'): raise ValueError('Authority retention pin required')
        grant = self._grant(dataset,version)
        client = AuthorityClient(self.peer,grant)
        try: self._authenticated(client,grant)
        finally: client.close()
        return self._proof(grant)

    @contextlib.contextmanager
    def guard(self, actor, proof):
        _admin(actor)
        if not isinstance(proof,dict): raise ValueError('Invalid remote authority receipt')
        # The same grant's retirement waits for an actual consumer, rather than
        # assuming a previously returned network guard remains valid forever.
        with self.scope(proof.get('dataset'),proof.get('version')):
            grant = self._grant(proof.get('dataset'),proof.get('version'))
            if proof != self._proof(grant): raise ValueError('Remote authority configuration or receipt changed')
            client = AuthorityClient(self.peer,grant)
            try:
                self._authenticated(client,grant)
                yield
            finally: client.close()

    @staticmethod
    def _chunk(value, offset, size):
        if not isinstance(value,dict) or set(value) != {'data','offset','size','eof'}:
            raise ValueError('Invalid authority chunk response')
        if not isinstance(value['data'],str) or len(value['data']) > 4*((CHUNK+2)//3):
            raise ValueError('Authority chunk exceeds bound')
        data = base64.b64decode(value['data'],validate=True)
        if (len(data) != min(CHUNK,size-offset) or value['size'] != size
                or value['offset'] != offset+len(data) or value['eof'] is not (offset+len(data)==size)):
            raise ValueError('Authority chunk does not match fixed range')
        return data

    def recover(self, actor, proof, target_cache, target_dataset, *, validate_target):
        """One bounded TLS stream, existing reserved staging, full atomic publish."""
        with self.scope(proof.get('dataset'),proof.get('version')):
            return self._recover_locked(actor,proof,target_cache,target_dataset,validate_target=validate_target)

    def _recover_locked(self, actor, proof, target_cache, target_dataset, *, validate_target):
        target_cache._actor(actor,admin=True)
        grant = self._grant(proof.get('dataset'),proof.get('version'))
        if proof != self._proof(grant): raise ValueError('Remote authority receipt changed')
        client = AuthorityClient(self.peer,grant)
        version = proof['version']
        try:
            self._authenticated(client,grant)
            raw = bytearray(); size = grant['receipt']['manifestBytes']
            while len(raw) < size:
                raw.extend(self._chunk(client.call('manifest',offset=len(raw)),len(raw),size))
            if hashlib.sha256(raw).hexdigest() != grant['receipt']['manifestSha256']:
                raise ValueError('Authority manifest checksum mismatch')
            manifest = D._manifest(json.loads(raw)); del raw
            if D._version(manifest) != version: raise ValueError('Authority manifest differs from fixed content version')
            with target_cache._version_locked(actor,target_dataset,version,snapshot=True) as snapshot:
                record, identity = snapshot
                if record['manifest'] != manifest: raise ValueError('Target registration differs from authority manifest')
                index = {entry['path']:entry for entry in manifest['files']}
                with target_cache._locked():
                    validate_target(); target_cache._check_snapshot(actor,target_dataset,version,identity)
                    paths = target_cache._paths(target_dataset,version)
                    if target_cache._ready(paths,manifest,version):
                        return dict(dataset=target_dataset,version=version,state='READY')
                    plan = target_cache._plan(actor,target_dataset,version,record=record,index=index)
                    fence = target_cache._transfer(paths['.staging'])
                remaining = plan['remainingBytes']; stage = paths['.staging']
                batch_bytes = batch_files = 0; checked_at = time.monotonic()

                def checkpoint():
                    nonlocal fence, batch_bytes, batch_files, checked_at
                    with target_cache._locked():
                        validate_target()
                        _, _, current = target_cache._authorize_transfer(actor,target_dataset,version,plan['token'],snapshot=snapshot)
                        if current != fence: raise ValueError('Recovery staging accounting changed')
                        target_cache._free(target_cache._reserved(except_stage=stage)+remaining+8192)
                        if current['remainingBytes'] != remaining:
                            fence = dict(current,remainingBytes=remaining)
                            D._write_json(stage/'TRANSFER.json',fence)
                    batch_bytes = batch_files = 0; checked_at = time.monotonic()

                checkpoint()
                for entry in plan['files']:
                    offset = entry['offset']
                    while offset < entry['size'] or entry['size'] == 0 and not entry['complete']:
                        data = self._chunk(client.call('get',path=entry['path'],offset=offset),offset,entry['size'])
                        # No network I/O or hashing under the target global lock.
                        with target_cache._locked():
                            validate_target(); target_cache._check_snapshot(actor,target_dataset,version,identity)
                            target_cache._free(target_cache._reserved(except_stage=stage)+remaining+8192)
                        _, written = target_cache._put_chunk_data(stage,index[entry['path']],offset,data,remaining)
                        remaining -= written; offset += len(data); batch_bytes += written
                        if batch_bytes >= D.TRANSFER_BATCH_BYTES or time.monotonic()-checked_at >= D.TRANSFER_BATCH_SECONDS:
                            checkpoint()
                        if entry['size'] == 0: break
                    batch_files += 1
                    if batch_files >= D.TRANSFER_BATCH_FILES or time.monotonic()-checked_at >= D.TRANSFER_BATCH_SECONDS:
                        checkpoint()
                checkpoint()
                self._authenticated(client,grant)
                del index, plan['files'], manifest
                # All resumed bytes, directories and complete files are hashed
                # again before READY. Corrupt partials never publish as valid.
                return target_cache._publish_locked(actor,target_dataset,version,plan['token'],snapshot,_guard=validate_target)
        finally: client.close()
