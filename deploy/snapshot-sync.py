#!/usr/bin/python3
"""Code-only, new-project imports and authenticated immutable snapshot reads.

The client relays bounded chunks; no shell, supplied host path or environment
migration. Existing dataset uploads perform data verification/publication.
"""
import base64
from contextlib import closing
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import uuid

CHUNK = 1024**2
HASH = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')


class SnapshotSync:
    def __init__(self, executor):
        self.n = executor
        self.ops = executor.projects()
        spec=importlib.util.spec_from_file_location('gpuq_snapshot_paths',executor.HERE/'dataset-cache.py')
        self.d=importlib.util.module_from_spec(spec);sys.modules[spec.name]=self.d;spec.loader.exec_module(self.d)
        self.root = executor.ROOT/'snapshot-sync'
        self.root.mkdir(mode=0o700, exist_ok=True)

    def owner(self, args):
        self.n.workspace(args['userId'])
        return self.d.Principal(args['userId'], args.get('hostAdmin') is True)

    def acquire_transfer_lease(self, args, transfer_id):
        """Internal control path; callers journal identity BEFORE acquiring."""
        if not isinstance(transfer_id, str) or not UUID.fullmatch(transfer_id):
            raise ValueError('Invalid transfer lease identity')
        module, cache = self.n.dataset_cache()
        actor = module.Principal(args['userId'], args.get('hostAdmin') is True)
        # UUID and its namespaced job ID both satisfy DatasetCache.USER_RE.
        return cache.acquire_lease(actor, args['dataset'], args['version'], 'transfer:'+transfer_id)

    def require_transfer_lease(self, args, transfer_id, lease_id):
        module, cache = self.n.dataset_cache()
        actor = module.Principal(args['userId'], args.get('hostAdmin') is True)
        with cache._locked():
            cache._dataset(actor, args['dataset'])
            if not any(lease['id'] == lease_id and lease['owner'] == actor.user_id
                       and lease['jobId'] == 'transfer:'+transfer_id
                       for lease in cache._leases(args['dataset'], args['version'])):
                raise ValueError('Persistent source transfer lease is missing; reconcile before reading')

    def release_transfer_lease(self, args, lease_id):
        """Internal ONLY: TransferJobs has checked the trusted target fence."""
        module, cache = self.n.dataset_cache()
        # A crash after unlinking the lease may be followed by legitimate
        # eviction/unregistration before the release receipt is saved. Absence
        # is already the desired state; do not require a surviving registry.
        with cache._locked():
            if not any(lease['id'] == lease_id for lease in cache._leases(args['dataset'], args['version'])):
                return {'released': False}
        return cache.release_lease(module.Principal('builtin-admin', True),
                                   args['dataset'], args['version'], lease_id)

    def metadata_space(self, needed):
        # Legacy snapshot metadata reads/writes keep their historical behavior.
        # Only explicitly configured nodes gain these additional write gates.
        if 'workspaceReserveBytes' in self.n.CONFIG:self.ops.store._space(needed)

    def index(self, folder, manifest):
        self.metadata_space(16384 + len(manifest['files']) * 4096)
        with closing(sqlite3.connect(folder/'index.sqlite')) as db:
            db.execute('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, sha256 TEXT, executable INTEGER, verified TEXT)')
            db.execute('DELETE FROM files')
            db.executemany('INSERT INTO files(path,size,sha256,executable) VALUES (?,?,?,?)',
                ((f['path'], f['size'], f['sha256'], int(f.get('executable', False))) for f in manifest['files']))
            db.commit()

    def file(self, folder, path):
        if not isinstance(path, str): raise ValueError('Invalid snapshot path')
        self.d._relative(path)
        with closing(sqlite3.connect(f'file:{folder / "index.sqlite"}?mode=ro', uri=True)) as db:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT * FROM files WHERE path=?', (path,)).fetchone()
            if row is None: raise ValueError('Path is not part of the fixed snapshot')
            return dict(row)

    def verified(self,folder,path,info):
        with closing(sqlite3.connect(folder/'index.sqlite')) as db:
            db.execute('UPDATE files SET verified=? WHERE path=?',(json.dumps(self.d._stamp(info)),path));db.commit()

    def complete_cache(self, folder, raw, info, manifest):
        """Accept a competing publication only if all fixed artifacts agree."""
        try:
            if (folder/'manifest.json').read_bytes()!=raw or json.loads((folder/'info.json').read_text())!=info:
                return False
            expected={f['path']:(f['size'],f['sha256'],int(f.get('executable',False))) for f in manifest['files']}
            with closing(sqlite3.connect(f'file:{folder / "index.sqlite"}?mode=ro',uri=True)) as db:
                count=0
                for path,size,sha256,executable in db.execute('SELECT path,size,sha256,executable FROM files'):
                    if expected.get(path)!=(size,sha256,executable):return False
                    count+=1
            return count==len(expected)
        except (OSError,ValueError,sqlite3.Error):
            return False

    def source(self, kind, args):
        actor = self.owner(args)
        if kind == 'projects':
            user, project = self.ops.identity(args)
            path, _ = self.ops.store._project(user, project)
            release = args.get('release')
            if not isinstance(release, str) or not HASH.fullmatch(release): raise ValueError('Pin a full READY release')
            folder = path/'releases'/release
            identity = ['code', user, project, release]
            source = folder/'code'
            cached=self.root/hashlib.sha256(json.dumps(identity).encode()).hexdigest()
            self.ops.store._release_summary(folder,release)
            with self.d._directory(source) as fd:
                if os.fstat(fd).st_mode&0o222:raise ValueError('Source code must remain immutable')
            if cached.exists():return cached,source
            meta = self.ops.store._release_meta(folder, release)
            records = meta['content']['code']
            manifest = {'schema':1, 'directories':[r['path'] for r in records if r['type']=='directory'],
                'files':[{'path':r['path'],'size':r['bytes'],'sha256':r['sha256'],'executable':r['executable']} for r in records if r['type']=='file']}
        else:
            module,self.cache=self.n.dataset_cache()
            actor=module.Principal(args['userId'],args.get('hostAdmin') is True)
            dataset, version = args.get('dataset'), args.get('version')
            paths=self.cache._paths(dataset,version);self.cache._dataset(actor,dataset)
            identity = ['data', actor.user_id, dataset, version]
            source = paths['ready']/'data'
            cached=self.root/hashlib.sha256(json.dumps(identity).encode()).hexdigest()
            if cached.exists():
                # Recheck authorization and READY without reparsing a 64 MiB
                # manifest for every one-MiB chunk. Content stays immutable.
                with self.d._directory(paths['.registry'].parent) as parent:
                    fd=os.open(paths['.registry'].name+'.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
                    try:self.d._regular(fd)
                    finally:os.close(fd)
                if self.d._read_json(paths['ready']/'READY.json')!={'schema':1,'version':version}:raise ValueError('Source data is no longer READY')
                with self.d._directory(source) as fd:
                    if os.fstat(fd).st_mode&0o222:raise ValueError('Source data must remain immutable')
                return cached,source
            if self.cache.status(actor, dataset, version)['state'] != 'READY': raise ValueError('Source dataset is not READY')
            manifest = self.cache.export_manifest(actor, dataset, version)['manifest']
        key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
        folder = self.root/key
        # Published manifests are immutable; their index is built once. Current
        # source authorization/readiness is rechecked above on every request.
        if not folder.exists():
            stage = self.root/('stage-'+uuid.uuid4().hex)
            raw = json.dumps(manifest, sort_keys=True, separators=(',',':'), ensure_ascii=False).encode()
            if len(raw)>64*CHUNK: raise ValueError('Snapshot manifest exceeds 64 MiB')
            self.metadata_space(len(raw) + 16384 + len(manifest['files']) * 4096)
            stage.mkdir(mode=0o700)
            (stage/'manifest.json').write_bytes(raw)
            self.index(stage, manifest)
            info={'manifestBytes':len(raw),'manifestSha256':hashlib.sha256(raw).hexdigest(),
                'totalBytes':sum(f['size'] for f in manifest['files']), 'entries':len(manifest['files'])+len(manifest['directories'])}
            self.n.atomic_json(stage/'info.json',info)
            try: os.rename(stage, folder)
            except OSError as error:
                if error.errno not in (errno.EEXIST,errno.ENOTEMPTY) or not self.complete_cache(folder,raw,info,manifest):
                    raise
                # Linux reports ENOTEMPTY when another immutable nonempty cache
                # won the rename. Never delete or replace the winner's files.
                for child in stage.iterdir(): child.unlink()
                stage.rmdir()
                return self.source(kind,args)  # Recheck live ownership/readiness.
        return folder, source

    def export(self, operation, args, *, _transfer_lease=None, _download_lease=None):
        if _transfer_lease is not None and _download_lease is not None:
            raise ValueError('Only one internal snapshot lease may be supplied')
        kind, _, action = operation.split('.')
        reference = {'project','release'} if kind=='projects' else {'dataset','version'}
        allowed = {'userId','hostAdmin'}|reference|({'offset'} if action=='manifest' else {'path','offset'} if action=='get' else set())
        if set(args)-allowed or action not in ('info','manifest','get'): raise ValueError('Invalid snapshot operation')
        if kind == 'datasets':
            module, cache = self.n.dataset_cache()
            actor = module.Principal(args['userId'], args.get('hostAdmin') is True)
            dataset = module._identifier(args.get('dataset'))
            version = module._identifier(args.get('version'), module.HASH_RE)
            with cache._locked():
                # Check ACL and a real registration before creating a lock
                # for an attacker-supplied dataset/version pair.
                cache._dataset(actor, dataset)
                cache._record_identity(dataset, version)
            # Do not parse/hash the full manifest for every one-MiB request.
            # The same version lock as GC spans admission AND this whole read.
            with cache._lock_file('.locks/'+dataset+'.'+version+'.lock'):
                with cache._locked():
                    cache._dataset(actor, dataset)
                    policy = self.n.CONFIG.get('storageTier', {})
                    if not isinstance(policy, dict) or type(policy.get('enabled', False)) is not bool:
                        raise ValueError('Invalid trusted storage tier configuration')
                    lease = _transfer_lease if _transfer_lease is not None else _download_lease
                    if lease is not None:
                        if (not isinstance(lease, tuple) or len(lease) != 2
                                or not isinstance(lease[0], str) or not UUID.fullmatch(lease[0])
                                or not isinstance(lease[1], str)):
                            raise ValueError('Invalid internal source transfer lease')
                        key, lease_id = lease
                        prefix = 'transfer:' if _transfer_lease is not None else 'download:'
                        if not any(lease['id'] == lease_id and lease['owner'] == actor.user_id
                                   and lease['jobId'] == prefix+key
                                   for lease in cache._leases(dataset, version)):
                            raise ValueError('Persistent source transfer lease is missing; reconcile before reading')
                    elif policy.get('enabled', False) and cache._tier(dataset, version)['role'] == 'cache':
                        raise ValueError('可回收缓存不支持无租约的旧下载或 sync data；请从受保护原件读取，或使用节点间 transfer copy。')
                return self._export(kind, action, args)
        if _transfer_lease is not None or _download_lease is not None:
            raise ValueError('Transfer leases protect datasets only')
        return self._export(kind, action, args)

    def _export(self, kind, action, args):
        folder, source = self.source(kind, args)
        info = json.loads((folder/'info.json').read_text())
        if action=='info': return {**info,'state':'READY'}
        offset = args.get('offset', 0)
        if type(offset)!=int or offset<0: raise ValueError('Invalid snapshot offset')
        if action=='manifest':
            path = folder/'manifest.json'; size = info['manifestBytes']
        else:
            entry = self.file(folder,args.get('path'));path=source/entry['path'];size=entry['size']
        if offset>size: raise ValueError('Snapshot offset beyond file size')
        with self.d._directory(path.parent) as parent:
            fd = os.open(path.name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
            try:
                before=self.d._regular(fd)
                if before.st_size!=size: raise ValueError('Source file no longer matches fixed snapshot')
                data=os.pread(fd,min(CHUNK,size-offset),offset)
                if self.d._stamp(before)!=self.d._stamp(os.fstat(fd)): raise ValueError('Source file changed during read')
            finally: os.close(fd)
        return {'data':base64.b64encode(data).decode(),'offset':offset+len(data),'size':size,'eof':offset+len(data)==size}

    def receipt(self, args):
        return self.ops.folder/(self.ops.key(args)+'.sync.json')

    def session(self, args):
        self.ops.identity(args)
        value=json.loads(self.receipt(args).read_text())
        if value.get('key')!=args.get('key') or value.get('userId')!=args['userId'] or value.get('project')!=args['project']:
            raise ValueError('Code sync identity mismatch; repeat the original command')
        folder=self.root/value['session']
        return value,folder

    def summary(self, session):
        return {k:session[k] for k in ('state','project','key','manifestOffset','source','manifestSha256') if k in session}

    def import_code(self, operation, args):
        action=operation.split('.')[-1]
        allowed={'userId','project','key'}|{'begin':{'manifestBytes','manifestSha256','totalBytes','entries','source'},
            'manifest':{'offset','data'},'seal':set(),'status':{'path'},'chunk':{'path','offset','data'},'finish':set()}.get(action,set())
        if action not in ('begin','manifest','seal','status','chunk','finish') or set(args)-allowed: raise ValueError('Invalid code sync fields')
        if not isinstance(args.get('key'),str) or not UUID.fullmatch(args['key']): raise ValueError('Code sync requires a UUID retry key')
        with self.ops.guard(args):
            if action=='begin': return self.begin(args)
            session,folder=self.session(args)
            if action=='status':
                out=self.summary(session)
                if args.get('path') is not None:
                    if session['state']!='COPYING': raise ValueError('Seal the manifest before inspecting files')
                    out['file']=self.copy_status(args,folder,args['path'])
                return out
            if session['state']=='CODE_READY':
                if action=='finish': return self.summary(session)
                raise ValueError('Code snapshot is already complete; no further sync writes')
            if action=='manifest':
                if session['state']!='RECEIVING_MANIFEST': raise ValueError('Manifest is already sealed')
                data=base64.b64decode(args.get('data',''),validate=True);offset=args.get('offset')
                if len(data)>CHUNK or type(offset)!=int or offset<0 or offset+len(data)>session['manifestBytes']: raise ValueError('Invalid manifest chunk')
                path=folder/'manifest.part';fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
                try:
                    size=self.d._regular(fd).st_size
                    if size>=offset+len(data) and os.pread(fd,len(data),offset)==data: pass
                    elif size==offset:
                        self.metadata_space(len(data))
                        os.lseek(fd,offset,0);os.write(fd,data);os.fsync(fd)
                    else: raise ValueError('Manifest offset mismatch')
                    session['manifestOffset']=os.fstat(fd).st_size
                finally: os.close(fd)
                self.n.atomic_json(self.receipt(args),session)
                return {'offset':session['manifestOffset']}
            if action=='seal':
                if session['state']=='COPYING': return self.summary(session)
                raw=(folder/('manifest.part' if (folder/'manifest.part').exists() else 'manifest.json')).read_bytes()
                if len(raw)!=session['manifestBytes'] or hashlib.sha256(raw).hexdigest()!=session['manifestSha256']: raise ValueError('Manifest SHA256 or size mismatch')
                manifest=json.loads(raw)
                if not isinstance(manifest,dict) or set(manifest)!={'schema','directories','files'}: raise ValueError('Invalid code manifest')
                plain={'schema':manifest['schema'],'directories':manifest['directories'],'files':[]}
                for file in manifest['files']:
                    if set(file)!={'path','size','sha256','executable'} or type(file['executable'])!=bool or file['size']>4*1024**3: raise ValueError('Invalid code file')
                    plain['files'].append({k:file[k] for k in ('path','size','sha256')})
                normalized=self.d._manifest(plain)
                if sum(f['size'] for f in normalized['files'])!=session['totalBytes'] or len(normalized['files'])+len(normalized['directories'])!=session['entries']: raise ValueError('Code manifest totals mismatch')
                # No symlinks, hidden environment payloads, or overwrite mirror.
                self.metadata_space(16384 + session['entries'] * 4096)
                code=self.ops.store.dev_paths(*self.ops.identity(args))['code']
                for path in sorted(normalized['directories'],key=lambda p:(p.count('/'),p)):
                    self.d._mkdir(code/path)
                self.index(folder,manifest)
                if (folder/'manifest.part').exists():os.rename(folder/'manifest.part',folder/'manifest.json')
                session['state']='COPYING';self.n.atomic_json(self.receipt(args),session)
                return self.summary(session)
            if session['state']!='COPYING': raise ValueError('Seal code manifest first')
            if action=='chunk':
                entry=self.file(folder,args.get('path'));upload=str(uuid.uuid5(uuid.UUID(session['key']),entry['path']))
                data=base64.b64decode(args.get('data',''),validate=True);offset=args.get('offset')
                if len(data)>CHUNK or type(offset)!=int or offset<0 or offset+len(data)>entry['size']: raise ValueError('Invalid code chunk')
                root=self.ops.store.dev_paths(*self.ops.identity(args))['code']
                target=root/entry['path']
                if target.exists() or target.is_symlink():
                    if not self.copy_status(args,folder,entry['path'])['complete']:raise ValueError('Existing code is not the fixed snapshot')
                    with self.d._directory(target.parent) as parent:
                        fd=os.open(target.name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
                        try:
                            if os.pread(fd,len(data),offset)!=data:raise ValueError('Retried chunk differs from copied file')
                        finally:os.close(fd)
                    return {'offset':offset+len(data),'complete':True}
                with self.ops.store.locked(*self.ops.identity(args)):
                    result=self.ops.upload({**args,'uploadId':upload,'totalSize':entry['size'],'sha256':entry['sha256'],'final':offset+len(data)==entry['size']},root)
                    if result.get('complete'):
                        with self.d._directory((root/entry['path']).parent) as parent:
                            fd=os.open(Path(entry['path']).name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
                            try:
                                os.fchmod(fd,0o700 if entry['executable'] else 0o600)
                                self.verified(folder,entry['path'],os.fstat(fd))
                            finally:os.close(fd)
                return {'offset':offset+len(data),'complete':result.get('complete',False)}
            # Each complete file already passed the existing SHA256 upload
            # verifier. Check its recorded inode/size/timestamps while the fence
            # excludes writers, instead of rehashing 50 GiB in one short RPC.
            root=self.ops.store.dev_paths(*self.ops.identity(args))['code']
            with closing(sqlite3.connect(folder/'index.sqlite')) as db:
                for path,verified in db.execute('SELECT path,verified FROM files'):
                    if verified is None or list(self.d._stamp((root/path).lstat()))!=json.loads(verified):raise ValueError('Copied file is incomplete or changed; repeat sync status before finishing')
            session['state']='CODE_READY';self.n.atomic_json(self.receipt(args),session)
            return self.summary(session)

    def begin(self,args):
        user,project=self.ops.identity(args)
        for name in ('manifestBytes','totalBytes','entries'):
            if type(args.get(name))!=int or args[name]<0: raise ValueError('Invalid code sync totals')
        if not 1<=args['manifestBytes']<=48*CHUNK or args['entries']>self.ops.store.max_entries or args['totalBytes']>self.ops.store.max_bytes:
            raise ValueError('Code sync exceeds project limits')
        if not isinstance(args.get('manifestSha256'),str) or not HASH.fullmatch(args['manifestSha256']): raise ValueError('Invalid code manifest checksum')
        source=args.get('source')
        if not isinstance(source,dict) or source.get('kind') not in ('git','release') or len(json.dumps(source))>4096 or set(source)-{'kind','commit','machine','project','release'}: raise ValueError('Invalid code provenance')
        receipt=self.receipt(args)
        if receipt.exists():
            session,_=self.session(args)
            if any(session.get(k)!=args[k] for k in ('manifestBytes','manifestSha256','totalBytes','entries','source')): raise ValueError('Same sync key cannot change the snapshot')
            if session['state']=='RECEIVING_MANIFEST':
                # Recover a crash after the durable fence but before the atomic
                # new-project rename. Existing projects are never overwritten.
                self.ops.store.create(user,project,environment_mode='isolated')
            return self.summary(session)
        if any(item['project']==project for item in self.ops.store.list(user)): raise ValueError('Sync needs a new project name; existing projects are never overwritten')
        self.ops.store._space(args['totalBytes'])
        folder=self.root/str(uuid.uuid4());folder.mkdir(mode=0o700)
        session={**args,'session':folder.name,'state':'RECEIVING_MANIFEST','manifestOffset':0}
        # Persist the fence before making the draft visible. A failed receipt
        # cannot leave an ordinary editable orphan; retry repairs an absent draft.
        self.n.atomic_json(receipt,session)
        self.ops.store.create(user,project,environment_mode='isolated')
        return self.summary(session)

    def copy_status(self,args,folder,path):
        entry=self.file(folder,path);root=self.ops.store.dev_paths(*self.ops.identity(args))['code'];target=root/path
        try:
            with self.d._directory(target.parent) as parent:
                fd=os.open(target.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
                try:
                    checksum,size=self.d._digest_fd(fd)
                    if size==entry['size'] and checksum==entry['sha256']:
                        os.fchmod(fd,0o700 if entry['executable'] else 0o600)
                        self.verified(folder,path,os.fstat(fd))
                finally:os.close(fd)
            if size!=entry['size'] or checksum!=entry['sha256']: raise ValueError('Existing copied code changed; sync does not overwrite it')
            return {k:v for k,v in {**entry,'offset':size,'complete':True}.items() if k!='verified'}
        except FileNotFoundError: pass
        staged=self.ops.transfer_dir(args)/(hashlib.sha256(path.encode()).hexdigest()+'.part')
        size=staged.stat().st_size if staged.exists() else 0
        if size>entry['size']: raise ValueError('Code staging exceeds file size')
        if size==entry['size'] and staged.exists():
            fd=os.open(staged,os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                checksum,_=self.d._digest_fd(fd)
                if checksum!=entry['sha256']:
                    # A failed final checksum may reset only this unfinished
                    # staging file. Published/draft destination files stay intact.
                    os.ftruncate(fd,0);os.fsync(fd);size=0
            finally:os.close(fd)
        return {k:v for k,v in {**entry,'offset':size,'complete':False}.items() if k!='verified'}

    def process(self,operation,args):
        if '.snapshot.' in operation:return self.export(operation,args)
        return self.import_code(operation,args)
