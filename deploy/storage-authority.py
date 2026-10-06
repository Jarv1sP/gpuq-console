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
Version-data retirement separately requires each fixed dependent isolation.
There is no peer/public revoke endpoint and no archive-intent retirement here.
"""
import base64
import contextlib
import fcntl
import hashlib
import hmac
import importlib.util
import json
import math
import os
import re
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

    def _revocation(self, grant):
        try:
            row = _load(self.root/grant['id']/'revoked.json')
        except FileNotFoundError:
            return None
        fields = {'schema','protocol','operationId','sourceMachine','dataset','version','grantId',
                  'grantSha256','receiptSha256','targetsSha256','state','createdAt'}
        if (not isinstance(row,dict) or set(row)!=fields or type(row['schema']) is not int or row['schema']!=1
                or row['protocol']!='dataset-authority-revocation-v1' or row['state']!='REVOKED'
                or row['sourceMachine']!=self.machine or row['dataset']!=grant['dataset'] or row['version']!=grant['version']
                or row['grantId']!=grant['id'] or row['grantSha256']!=_sha(grant)
                or row['receiptSha256']!=_sha(grant['receipt'])
                or type(row['createdAt']) not in (int,float) or not math.isfinite(row['createdAt']) or row['createdAt']<0):
            raise ValueError('Corrupt permanent authority revocation; old grant remains unusable')
        J.identifier(row['operationId']); D._identifier(row['targetsSha256'],D.HASH_RE)
        return row

    def _assert_live(self, grant):
        self.assert_live(grant['dataset'],grant['version'])
        if self._revocation(grant) is not None:
            raise PermissionError('Authority grant was permanently revoked by version-data retirement')

    def deletion_dependencies(self, actor, dataset, version):
        """Private token-free dependency projection under caller's version lock.

        Enumerate every grant, not the caller's visible catalog. Unknown pins,
        incomplete issuers and damaged records require reconciliation. No file
        absence, archive RETIRED event or cached public receipt proves removal.
        """
        self.cache._actor(actor)
        self.assert_live(dataset,version)
        record, registration = self.cache._record_snapshot(actor,dataset,version)
        with self.cache._locked():
            self.cache._check_snapshot(actor,dataset,version,registration)
            owners = self.cache._dataset(actor,dataset)['owners']
            tier = self.cache._tier(dataset,version)
            if tier['role']!='protected' or not self.cache._ready(self.cache._paths(dataset,version),record['manifest'],version):
                raise ValueError('Authority retirement requires the fixed protected READY original')
            pins = sorted(pin for pin in tier['pins'] if pin.startswith('authority-'))
        with D._directory(self.root) as fd:
            names = sorted(os.listdir(fd))
        if len(names)>10000:raise ValueError('Authority dependency inventory requires reconciliation')
        grants=[]
        for key in names:
            # External replacement retirement owns these permanent reference
            # fences and its consumption locks. They are not grant folders.
            if re.fullmatch(r'\.reference-[a-f0-9]{64}\.lock',key):
                with D._directory(self.root) as parent:
                    child=os.open(key,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
                    try:
                        info=D._regular(child)
                        if info.st_uid!=os.getuid() or info.st_mode & 0o077 or info.st_nlink!=1 or info.st_size!=0:
                            raise ValueError('Unsafe permanent authority reference lock')
                    finally:os.close(child)
                continue
            if re.fullmatch(r'\.retired-[a-f0-9]{64}\.json',key):
                fence=_load(self.root/key)
                if (not isinstance(fence,dict) or set(fence)!={'binding','opId','grantId','replacementGrantId','targetProofSha256'}):
                    raise ValueError('Unknown external authority retirement fence')
                J.identifier(fence['opId']);J.identifier(fence['grantId']);J.identifier(fence['replacementGrantId'])
                D._identifier(fence['binding'],D.HASH_RE);D._identifier(fence['targetProofSha256'],D.HASH_RE)
                original=_load(self.root/fence['grantId']/'grant.json')
                original=_validate_grant(original,self.machine,original.get('targetMachine'))
                if self.reference_fence(original['dataset'],original['version']).name!=key:
                    raise ValueError('External authority fence belongs to another reference')
                continue
            J.identifier(key)
            grant=_load(self.root/key/'grant.json')
            grant=_validate_grant(grant,self.machine,grant.get('targetMachine'))
            if grant['id']!=key:raise ValueError('Authority grant folder identity differs')
            if grant['dataset']!=dataset or grant['version']!=version:continue
            revoked=self._revocation(grant)
            proof=_load(self.root/key/'sealed.json')
            # Old grants stay permanently revoked after administrator restore.
            # During a partially completed retirement their pins still exist;
            # keep them in this exact generation's dependency inventory.
            if revoked is not None and proof.get('registration')!=list(registration):continue
            if (_sha(proof)!=grant['receipt']['sealedSha256'] or proof.get('owners')!=owners
                    or grant['receipt']['owners']!=owners or grant['receipt']['pinId']!='authority-'+key):
                raise ValueError('Authority dependency seal or owner binding changed')
            with self.cache._locked():
                self.cache._check_snapshot(actor,dataset,version,registration)
                self.local._validate_locked(self.principal,proof)
            grants.append(dict(id=key,targetMachine=grant['targetMachine'],receiptSha256=_sha(grant['receipt']),
                               registration=list(registration),pinId=grant['receipt']['pinId']))
        if pins!=sorted(g['pinId'] for g in grants):
            raise ValueError('Unconfirmed or unknown authority pins block original retirement')
        return dict(protocol='dataset-authority-dependencies-v1',sourceMachine=self.machine,
                    dataset=dataset,version=version,registration=list(registration),pins=pins,grants=grants)

    def revoke_for_retirement(self, actor, row, targets):
        # Serialize our new data-deletion revocation with the unchanged
        # external replacement-retirement consumer and its reference fence.
        with self.reference_lock(row['dataset'],row['version']):
            self.assert_live(row['dataset'],row['version'])
            return self._revoke_for_retirement_locked(actor,row,targets)

    def _revoke_for_retirement_locked(self, actor, row, targets):
        """Private exact-operation revocation after all fixed targets isolate.

        targets are authenticated control-plane receipts, never public request
        fields. The caller has fenced the original and all nodes and owns the
        source version lock. This performs only local durable metadata writes.
        """
        self.cache._actor(actor)
        expected=row['snapshot'].get('authority')
        if expected is None or expected['sourceMachine']!=self.machine:
            raise ValueError('Retirement has no fixed authority dependency plan')
        fence=self.cache._check_retirement(row['dataset'],row['version'])
        if (fence is None or fence['operationId']!=row['operationId'] or fence['actor']!=row['actor']
                or fence['admin']!=row['admin'] or fence['snapshotSha256']!=_sha(row['snapshot'])
                or fence['state']!='FENCED'):
            raise ValueError('Authority revocation requires this active version fence')
        if not isinstance(targets,list) or len(targets)>10000:raise ValueError('Invalid confirmed target inventory')
        fields={'protocol','operationId','machine','dataset','version','state','isolated','complete',
                'snapshotSha256','generation','fenceState','retainUntil','proofSha256','authorityReferences','authorityAliases'}
        confirmed={};scopes=set()
        for target in targets:
            if (not isinstance(target,dict) or set(target)!=fields or target['protocol']!='dataset-version-retirement-v1'
                    or target['state']!='ISOLATED' or target['isolated'] is not True or target['fenceState']!='ISOLATED'
                    or target['version']!=row['version'] or type(target['complete']) is not bool
                    or type(target['retainUntil']) not in (int,float) or not math.isfinite(target['retainUntil'])
                    or target['retainUntil']<fence['createdAt']+7*86400-300 or not isinstance(target['authorityReferences'],list)):
                raise ValueError('Dependent data isolation is unconfirmed; original stays protected')
            J.identifier(target['operationId']);_machine(target['machine']);D._identifier(target['dataset'])
            for field in ('snapshotSha256','generation','proofSha256'):D._identifier(target[field],D.HASH_RE)
            for ref in target['authorityReferences']:
                ref_fields={'sourceMachine','targetMachine','sourceDataset','version','grantId','receiptSha256'}
                if not isinstance(ref,dict) or set(ref)!=ref_fields:raise ValueError('Invalid fixed dependent reference')
                if (ref['sourceMachine']!=self.machine or ref['sourceDataset']!=row['dataset']
                        or ref['version']!=row['version']):continue
                if ref['targetMachine']!=target['machine']:raise ValueError('Dependent target identity differs')
                J.identifier(ref['grantId']);D._identifier(ref['receiptSha256'],D.HASH_RE)
                scope=(ref['grantId'],target['machine'],target['dataset'])
                if scope in scopes:raise ValueError('Ambiguous dependent grant mapping')
                scopes.add(scope)
                confirmed.setdefault(ref['grantId'],[]).append((target,ref))
        # Each target node enumerates the grant's physical aliases itself,
        # including retained aliases whose registry was moved. Portal locations
        # alone cannot authorize revocation by omitting one of them.
        for target in targets:
            aliases=target['authorityAliases']
            if not isinstance(aliases,list) or len(aliases)>10000:
                raise ValueError('Node authority alias inventory is unconfirmed')
            for alias in aliases:
                if (not isinstance(alias,dict) or set(alias)!={'dataset','version','authorityReference'}
                        or alias['version']!=row['version'] or alias['authorityReference'] not in target['authorityReferences']):
                    raise ValueError('Invalid node authority alias inventory')
                D._identifier(alias['dataset']);ref=alias['authorityReference']
                if ref['sourceMachine']==self.machine and ref['sourceDataset']==row['dataset']:
                    if (ref['grantId'],target['machine'],alias['dataset']) not in scopes:
                        raise ValueError('Every physical authority alias must be ISOLATED before revocation')
        if set(confirmed)!=set(grant['id'] for grant in expected['grants']):
            raise ValueError('Every authority dependent needs a matching isolated generation')
        for planned in expected['grants']:
            for target,ref in confirmed[planned['id']]:
                if target['machine']!=planned['targetMachine'] or ref['receiptSha256']!=planned['receiptSha256']:
                    raise ValueError('Authority dependent receipt does not match its issued grant')
        # On recovery, already-revoked grants remain in the fixed plan. Compare
        # every private row and seal, then write only missing tombstones.
        known=[]
        for planned in expected['grants']:
            key=planned['id'];folder=self.root/key
            grant=_validate_grant(_load(folder/'grant.json'),self.machine,planned['targetMachine'])
            proof=_load(folder/'sealed.json')
            if (grant['dataset']!=row['dataset'] or grant['version']!=row['version']
                    or _sha(grant['receipt'])!=planned['receiptSha256'] or _sha(proof)!=grant['receipt']['sealedSha256']
                    or proof.get('registration')!=row['snapshot']['registration']):
                raise ValueError('Private authority dependency changed before revocation')
            revoked=self._revocation(grant)
            if revoked is not None and (revoked['operationId']!=row['operationId'] or revoked['targetsSha256']!=_sha(targets)):
                raise ValueError('Authority grant was revoked by another immutable operation')
            known.append((grant,revoked))
        live=self.deletion_dependencies(actor,row['dataset'],row['version'])
        if live!=expected:
            raise ValueError('New authority dependencies appeared; no retirement permitted')
        receipts=[]
        for grant,revoked in known:
            if revoked is None:
                revoked=dict(schema=1,protocol='dataset-authority-revocation-v1',operationId=row['operationId'],
                    sourceMachine=self.machine,dataset=row['dataset'],version=row['version'],grantId=grant['id'],
                    grantSha256=_sha(grant),receiptSha256=_sha(grant['receipt']),targetsSha256=_sha(targets),state='REVOKED',createdAt=time.time())
                D._write_json(self.root/grant['id']/'revoked.json',revoked)
            receipts.append(dict(id=grant['id'],proofSha256=_sha(revoked)))
        return receipts

    def verify_retirement_revocations(self, row):
        """Check permanent proofs after the original registry has been moved."""
        expected=row['snapshot'].get('authority')
        receipts=row['revocations']
        if (expected is None or expected['sourceMachine']!=self.machine
                or not isinstance(receipts,list) or any(not isinstance(r,dict) or set(r)!={'id','proofSha256'} for r in receipts)
                or len({r['id'] for r in receipts})!=len(receipts)
                or {r['id'] for r in receipts}!={g['id'] for g in expected['grants']}):
            raise ValueError('Permanent authority revocation proofs are incomplete')
        by_id={r['id']:r for r in receipts}
        for planned in expected['grants']:
            grant=_validate_grant(_load(self.root/planned['id']/'grant.json'),self.machine,planned['targetMachine'])
            proof=_load(self.root/planned['id']/'sealed.json')
            if (grant['dataset']!=row['dataset'] or grant['version']!=row['version']
                    or _sha(grant['receipt'])!=planned['receiptSha256'] or _sha(proof)!=grant['receipt']['sealedSha256']
                    or proof.get('registration')!=row['snapshot']['registration']
                    or proof.get('rootIdentity')!=row['snapshot']['rootIdentity'] or proof.get('owners')!=row['snapshot']['owners']):
                raise ValueError('Permanent authority revocation generation changed')
            revoked=self._revocation(grant)
            if revoked is None or revoked['operationId']!=row['operationId'] or _sha(revoked)!=by_id[planned['id']]['proofSha256']:
                raise ValueError('Old authority grant is not confirmed permanently revoked')
        return True

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
                self._assert_live(grant)
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
        self._assert_live(grant)
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

    def retirement_reference(self, actor, proof):
        """Private fixed binding from installed grant; no token or peer I/O.

        The original's frozen dependency plan verifies this ID and receipt
        again before revocation. No network is performed under a cache lock.
        """
        _admin(actor)
        grant=self._grant(proof.get('dataset'),proof.get('version'))
        if proof!=self._proof(grant):raise ValueError('Installed authority binding changed during deletion')
        return dict(sourceMachine=self.machine,targetMachine=self.target_machine,sourceDataset=grant['dataset'],
                    version=grant['version'],grantId=grant['id'],receiptSha256=_sha(grant['receipt']))

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
