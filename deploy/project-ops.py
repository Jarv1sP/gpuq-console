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
        self.store = module.ProjectStore(executor.ROOT, executor.CONFIG['conda'])
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
        pending = self.pending(args)
        if pending.get('state') == 'PUBLISHING' and self.active(args):
            raise ValueError('Project publication is running; wait before editing or uploading')
        self.store.fail_if_publishing(*self.identity(args))

    def status(self, args):
        result = self.store.status(*self.identity(args))
        pending = self.pending(args)
        if pending.get('state') == 'PUBLISHING':
            pending = {'state':'PUBLISHING'} if self.active(args) else {
                'state':'FAILED','error':'Publication worker stopped; retry publication'}
        if pending.get('state') in ('PUBLISHING', 'FAILED'):
            result.update({k: pending[k] for k in ('state','error') if k in pending})
        return result

    def transfer_dir(self, args):
        path = self.folder/(self.key(args)+'.uploads')
        path.mkdir(mode=0o700, exist_ok=True)
        return path

    def process(self, operation, args):
        allowed = {'userId'} if operation == 'projects.list' else {'userId','project'}
        if operation == 'projects.verify': allowed.add('release')
        if not isinstance(args, dict) or set(args)-allowed:
            raise ValueError('Invalid project fields')
        if operation == 'projects.list':
            self.n.workspace(args['userId'])
            result = {'projects':self.store.list(args['userId'])}
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
            if operation == 'projects.create': return self.store.create(*identity)
            if operation != 'projects.publish': raise ValueError('Unknown project operation')
            self.writable(args)
            # A clean exit may leave a pointer. Confirm the entire unit is
            # stopped before copying; an unavailable socket is not enough.
            pointer = self.n.terminal_pointer(args)
            if pointer.exists():
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
            task = {'userId':identity[0],'project':identity[1],'state':'PUBLISHING'}
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
            return {**self.store.status(*identity),'state':'PUBLISHING','operationId':self.key(args)}

    def worker(self, key):
        if not HASH.fullmatch(key): raise ValueError('Invalid project worker key')
        args = json.loads((self.folder/(key+'.json')).read_text())
        if self.key(args) != key: raise ValueError('Project worker identity mismatch')
        try:
            out = self.store.publish(*self.identity(args))
            self.n.atomic_json(self.receipt_path(args), {**args,**out,'state':'READY'})
            return 0
        except Exception as error:
            self.n.atomic_json(self.receipt_path(args), {**args,'state':'FAILED',
                'error':str(error)[:300] if isinstance(error,ValueError) else 'Publication failed; inspect node logs'})
            return 1

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
                free=os.statvfs(folder)
                if free.f_bavail*free.f_frsize<10*1024**3+len(data): raise ValueError('Workspace disk reserve reached')
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
