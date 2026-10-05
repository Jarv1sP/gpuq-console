#!/usr/bin/env python3
"""Node-local project RPCs. No supplied commands execute on the host.

Slow publication runs in a bounded background unit, before GPU reservation.
Uploaded files are staged outside user mounts and atomically committed only
after their declared size and SHA256 match. Publication never reads an upload
in progress or a live development terminal.
"""
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

PROJECT = re.compile(r'^[a-z][a-z0-9_-]{0,47}$')
HASH = re.compile(r'^[a-f0-9]{64}$')
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')


class ProjectOperations:
    def __init__(self, executor):
        self.n = executor
        spec = importlib.util.spec_from_file_location('gpuq_project_store', executor.HERE/'project-store.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        self.store = module.ProjectStore(executor.ROOT, executor.CONFIG['conda'],
                                        reserve_bytes=module.workspace_reserve_bytes(executor.CONFIG), config=executor.CONFIG)
        self.folder = executor.ROOT/'project-ops'
        self.folder.mkdir(mode=0o700, exist_ok=True)

    def identity(self, args):
        user, project = args.get('userId'), args.get('project')
        self.n.workspace(user)  # validates trusted portal identity
        if not isinstance(project, str) or not PROJECT.fullmatch(project):
            raise ValueError('Invalid project name')
        return user, project

    def key(self, args):
        return hashlib.sha256(json.dumps(self.identity(args)).encode()).hexdigest()

    @contextmanager
    def guard(self, args):
        with open(self.folder/(self.key(args)+'.lock'), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def receipt_path(self, args):
        return self.folder/(self.key(args)+'.json')

    def active(self, args):
        return subprocess.run(['/usr/bin/systemctl', '--user', 'is-active', '--quiet',
                               'gpuq-project-'+self.key(args)[:32]], env=self.n.ENV,
                              timeout=4, stdout=subprocess.DEVNULL).returncode == 0

    def pending(self, args):
        path = self.receipt_path(args)
        return json.loads(path.read_text()) if path.exists() else {}

    def terminal_stopped(self, jid):
        unit='amax-term-'+jid+'.service'
        result=subprocess.run(['/usr/bin/systemctl','--user','show',unit,
            '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup'],
            env=self.n.ENV,text=True,capture_output=True,timeout=5)
        props=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        if set(props)!={'LoadState','ActiveState','SubState','MainPID','ControlGroup'}:return False
        if result.returncode and not (result.returncode==1 and props['LoadState']=='not-found'):return False
        quiet=props['ActiveState'] in ('inactive','failed') or (props['ActiveState']=='active' and props['SubState']=='exited')
        if props['MainPID']!='0' or not quiet:return False
        group=props['ControlGroup']
        if not group:return props['LoadState'] in ('loaded','not-found')
        if not group.startswith('/') or '..' in Path(group).parts or Path(group).name!=unit:return False
        path=Path('/sys/fs/cgroup')/group.lstrip('/')
        try:events=dict(line.split() for line in (path/'cgroup.events').read_text().splitlines())
        except FileNotFoundError:return not path.exists()
        return events.get('populated')=='0'

    def writable(self, args):
        sync=self.folder/(self.key(args)+'.sync.json')
        if sync.exists() and json.loads(sync.read_text()).get('state')!='CODE_READY':
            raise ValueError('Code synchronization is incomplete; repeat the original sync before editing, opening a terminal or publishing')
        pending = self.pending(args)
        if pending.get('state') == 'PUBLISHING' and self.active(args):
            raise ValueError('Project publication is running; wait before editing or uploading')
        self.store.fail_if_publishing(*self.identity(args))

    def status(self, args):
        result = self.store.status(*self.identity(args))
        result['publicationProtocol'] = 1
        sync=self.folder/(self.key(args)+'.sync.json')
        if sync.exists():
            session=json.loads(sync.read_text())
            result['codeSync']={k:session[k] for k in ('state','source','manifestSha256')}
            if session['state']!='CODE_READY':result.update(state='SYNCING',error='Code sync incomplete; repeat the same sync command')
        pending = self.pending(args)
        observed = pending
        if pending.get('state') == 'PUBLISHING':
            pending = pending if self.active(args) else {
                **pending,'state':'UNKNOWN','error':'Publication worker stopped without a final receipt; inspect READY versions before retrying'}
        # A complete callback is emitted only after the immutable release and
        # latest pointer are committed. It is a durable per-publication proof,
        # unlike merely finding some older READY version in this project.
        committed = pending.get('committedRelease')
        if (pending.get('state') in ('UNKNOWN','FAILED') and
                isinstance(committed, str) and HASH.fullmatch(committed) and
                committed == result.get('latestReadyRelease') and
                any(item['release'] == committed for item in result['releases'])):
            recovered = {k:v for k,v in pending.items() if k not in ('error','errorDetails')}
            recovered.update(state='READY',release=committed)
            try:
                with self.guard(args):
                    if self.pending(args) == observed:
                        self.n.atomic_json(self.receipt_path(args), recovered)
            except Exception: pass  # The on-disk commit proof remains authoritative.
            result.update(state='READY',progress=pending.get('progress',{}))
            return self.publication_status(result, recovered)
        if pending.get('state') in ('PUBLISHING', 'FAILED', 'UNKNOWN'):
            result.update({k: pending[k] for k in ('state','error','errorDetails','progress') if k in pending})
        return self.publication_status(result, pending)

    def publication_status(self, result, pending):
        """Only this publication's durable commit proof, never an older READY."""
        identity = pending.get('publicationId')
        if identity is None: return result  # Historical unkeyed receipts.
        if not isinstance(identity, str) or not UUID.fullmatch(identity):
            raise ValueError('Invalid publication identity')
        state = pending.get('state')
        if state not in ('PUBLISHING', 'READY', 'FAILED', 'UNKNOWN'):
            raise ValueError('Invalid publication state')
        proof = {'id':identity, 'state':state}
        if state == 'READY':
            release = pending.get('committedRelease')
            if (not isinstance(release, str) or not HASH.fullmatch(release) or
                    pending.get('release') != release or
                    not any(item['release'] == release for item in result['releases'])):
                raise ValueError('Publication has no matching committed READY release')
            proof['release'] = release
        result['publication'] = proof
        return result

    def transfer_dir(self, args):
        path = self.folder/(self.key(args)+'.uploads')
        path.mkdir(mode=0o700, exist_ok=True)
        if 'storageQuota' in self.n.CONFIG:
            self.n.storage_quota(args['userId'], path, project=args['project'])
        return path

    def environment_modes(self, user):
        """Configured admission capability, not an engine/network probe.

        Merely listing projects must not create a private OCI graph, prime an
        image or run a container. The same strict policy used at admission
        determines whether this authenticated owner may choose OCI.
        """
        modes = ['shared', 'isolated']
        if self.n.CONFIG.get('personalOci', {}).get('enabled') is not True:
            return modes
        spec = importlib.util.spec_from_file_location('gpuq_project_oci_capability', self.n.HERE/'personal-oci.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            module.policy(self.n.CONFIG, user)
        except ValueError:
            return modes
        return [*modes, 'oci']

    def process(self, operation, args):
        allowed = {'userId'} if operation == 'projects.list' else {'userId','project'}
        if operation == 'projects.create': allowed.add('environmentMode')
        if operation == 'projects.publish': allowed.add('key')
        if operation == 'projects.verify': allowed.add('release')
        if not isinstance(args, dict) or set(args)-allowed:
            raise ValueError('Invalid project fields')
        if 'environmentMode' in args and args['environmentMode'] not in ('shared','isolated','oci'):
            raise ValueError('Environment mode must be shared, isolated or oci')
        if 'key' in args and (not isinstance(args['key'],str) or not UUID.fullmatch(args['key'])):
            raise ValueError('Invalid publication key')
        if operation == 'projects.list':
            self.n.workspace(args['userId'])
            result = {'projects':self.store.list(args['userId']),
                      'environmentModes':self.environment_modes(args['userId'])}
            # Store does not know detached-worker state.
            for item in result['projects']:
                item.update(self.status({'userId':args['userId'],'project':item['project']}))
            return result
        identity = self.identity(args)
        if operation == 'projects.status': return self.status(args)
        if operation == 'projects.verify':
            release = self.store.release(*identity, args['release'])
            return {'project':args['project'],'release':args['release'],'state':'READY'}
        with self.guard(args):
            if operation == 'projects.create': return self.store.create(*identity, environment_mode=args.get('environmentMode'))
            if operation != 'projects.publish': raise ValueError('Unknown project operation')
            pending = self.pending(args)
            if 'key' in args and pending.get('publicationId') == args['key']:
                return self.status(args)  # Lost reply: never start a second worker.
            self.writable(args)
            # A clean exit may leave a pointer. Confirm the entire unit is
            # stopped before copying; an unavailable socket is not enough.
            for pointer in self.n.terminal_pointers(args):
                jid = pointer.read_text()
                if not UUID.fullmatch(jid): raise ValueError('Invalid project terminal pointer')
                if self.n.terminal_alive(self.n.ROOT/'terminals', jid):
                    raise ValueError('Close the project development terminal before publishing')
                self.n.stop_terminal(jid)
                if not self.terminal_stopped(jid):
                    raise ValueError('Cannot confirm development terminal termination; publication blocked')
                pointer.unlink(missing_ok=True)
            uploads = self.transfer_dir(args)
            if any(uploads.glob('*.json')):
                raise ValueError('Unfinished project upload; retry that file or discard pending uploads')
            self.store.status(*identity)
            task = {'userId':identity[0],'project':identity[1],'state':'PUBLISHING',
                    'publicationId':args.get('key',str(uuid.uuid4()))}
            self.n.atomic_json(self.receipt_path(args), task)
            try:
                self.n.run(['/usr/bin/systemd-run','--user','--collect',
                            '--unit=gpuq-project-'+self.key(args)[:32],
                            '--property=KillMode=control-group','--property=UMask=0077',
                            '--property=CPUQuota=100%','--property=MemoryMax=1G',
                            '--property=IOWeight=10','--property=RuntimeMaxSec=7200',
                            '/usr/bin/python3',str(self.n.HERE/'node-executor.py'),
                            '--project-worker',self.key(args)], timeout=8)
            except Exception:
                self.n.atomic_json(self.receipt_path(args), {**task,'state':'FAILED','error':'Unable to start publication worker'})
                raise
            return {**self.store.status(*identity),'state':'PUBLISHING','operationId':self.key(args),
                    'publicationProtocol':1,'publication':{'id':task['publicationId'],'state':'PUBLISHING'}}

    def worker(self, key):
        if not HASH.fullmatch(key): raise ValueError('Invalid project worker key')
        args = json.loads((self.folder/(key+'.json')).read_text())
        if self.key(args) != key: raise ValueError('Project worker identity mismatch')
        args = {name:args[name] for name in ('userId','project','publicationId') if name in args}
        last_progress, committed = {}, {}
        def progress(value):
            last_progress.update(value)
            if value.get('phase') == 'complete':
                status = self.store.status(*self.identity(args))
                release = status.get('latestReadyRelease')
                if (isinstance(release,str) and HASH.fullmatch(release) and
                        any(item['release'] == release for item in status['releases'])):
                    committed.update(project=args['project'],release=release,state='READY')
            self.n.atomic_json(self.receipt_path(args), {**args,'state':'PUBLISHING','progress':value,
                **({'committedRelease':committed['release']} if committed else {})})
        try:
            out = self.store.publish(*self.identity(args), progress=progress)
        except Exception as error:
            if not committed:
                self.n.atomic_json(self.receipt_path(args), {**args,'state':'FAILED',
                    'error':str(error)[:500] if isinstance(error,ValueError) else 'Publication failed; inspect node logs',
                    'errorDetails':getattr(error,'details',{}),'progress':last_progress})
                return 1
            # Post-commit cleanup cannot revoke a published immutable snapshot.
            print('GPUQ project publication committed; post-commit cleanup needs inspection',file=sys.stderr)
            out = committed
        try:
            self.n.atomic_json(self.receipt_path(args), {**args,**out,'state':'READY',
                'committedRelease':out['release'],'progress':last_progress})
        except Exception:
            print('GPUQ project publication committed; final receipt unavailable, query project status',file=sys.stderr)
        return 0

    def files(self, operation, args):
        user, project = self.identity(args)
        area = args.get('area','code')
        if area == 'output':
            if operation == 'files.put': raise ValueError('Job outputs cannot be overwritten via upload')
            jid = args.get('runId')
            if not isinstance(jid,str) or not UUID.fullmatch(jid): raise ValueError('Invalid run ID')
            spec = json.loads((self.n.ROOT/'jobs'/(jid+'.json')).read_text())
            if spec.get('userId') != user or spec.get('project') != project:
                raise ValueError('Run is not owned by this project')
            root = self.store.existing_run_paths(user, project, spec['release'], jid)['output']
            return self.n.file_op(operation,args,root=root)
        if area != 'code' or args.get('runId') is not None: raise ValueError('Invalid project file area')
        root = self.store.dev_paths(user,project)['code']
        if operation != 'files.put': return self.n.file_op(operation,args,root=root)
        with self.guard(args):
            self.writable(args)
            with self.store.locked(user, project):
                return self.upload(args, root)

    def upload(self, args, root):
        path, upload = args.get('path'), args.get('uploadId')
        if not isinstance(path,str) or len(path)>1024 or '\\' in path or '\0' in path:
            raise ValueError('Invalid project upload path')
        parts = path.split('/')
        if any(p in ('','.','..') or len(p)>255 for p in parts): raise ValueError('Invalid project upload path')
        if not isinstance(upload,str) or not UUID.fullmatch(upload): raise ValueError('Invalid upload ID')
        total, offset, digest = args.get('totalSize'), args.get('offset'), args.get('sha256')
        if type(total)!=int or not 0<=total<=4*1024**3 or type(offset)!=int or not 0<=offset<=total:
            raise ValueError('Code upload size/offset invalid (maximum 4 GiB per file; datasets use /data2)')
        if not isinstance(digest,str) or not HASH.fullmatch(digest) or type(args.get('final')) is not bool:
            raise ValueError('Upload requires checksum and final marker')
        data = base64.b64decode(args.get('data',''),validate=True)
        if len(data)>1024**2 or offset+len(data)>total: raise ValueError('Invalid upload chunk')
        folder = self.transfer_dir(args)
        # At most one in-flight version of a path; retrying with a new UUID
        # replaces only its unfinished staging, never the published code file.
        key = hashlib.sha256(path.encode()).hexdigest()
        meta, part = folder/(key+'.json'), folder/(key+'.part')
        record = {'path':path,'uploadId':upload,'totalSize':total,'sha256':digest}
        prior = json.loads(meta.read_text()) if meta.exists() else None
        if prior != record:
            if offset: raise ValueError('Upload identity changed; restart this file')
            if len(list(folder.glob('*.json')))>=64 and prior is None: raise ValueError('Too many unfinished uploads')
            self.store._space(len(data))
            self.n.atomic_json(meta, record)
            part.unlink(missing_ok=True)
        fd = os.open(part,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise ValueError('Unsafe upload staging')
            # A retried already-accepted chunk is harmless and not appended twice.
            if info.st_size >= offset+len(data) and os.pread(fd,len(data),offset)==data:
                pass
            elif info.st_size == offset:
                self.store._space(len(data))
                os.lseek(fd,offset,0)
                view=memoryview(data)
                while view: view=view[os.write(fd,view):]
                os.fsync(fd)
            else: raise ValueError('Upload offset mismatch; restart this file')
            size=os.fstat(fd).st_size
            if not args['final']: return {'path':path,'size':size,'complete':False}
            if size!=total or offset+len(data)!=total: raise ValueError('Final upload size mismatch')
            os.lseek(fd,0,0);hasher=hashlib.sha256()
            while True:
                chunk=os.read(fd,1024**2)
                if not chunk:break
                hasher.update(chunk)
            if hasher.hexdigest()!=digest: raise ValueError('Upload SHA256 mismatch; retry the file')
            parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                for component in parts[:-1]:
                    try:os.mkdir(component,mode=0o700,dir_fd=parent)
                    except FileExistsError:pass
                    child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                    os.close(parent);parent=child
                os.replace(part,parts[-1],dst_dir_fd=parent);os.fsync(parent)
            finally:os.close(parent)
            meta.unlink()
            return {'path':path,'size':total,'complete':True,'sha256':digest}
        finally:os.close(fd)
