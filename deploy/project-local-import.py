"""Owner-only, node-local data-workspace -> new project draft directory.

No host paths are accepted. Persistent source and destination fences precede
the background launch; an unknown worker never grants permission to edit.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

PROTOCOL = 'project-local-import-v1'
FINAL = {'IMPORTED', 'FAILED', 'CANCELED'}
EXCLUDED = {'.git','.ssh','.aws','.azure','.venv','venv','node_modules','__pycache__','id_rsa','id_ed25519','.env'}
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')


def stamp(info):
    return [info.st_dev,info.st_ino,info.st_mode,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns]


def rename_new(source_fd, source, destination_fd, destination):
    """Kernel atomic no-replace; never degrade to a check-then-rename race."""
    function = getattr(ctypes.CDLL(None, use_errno=True), 'renameat2', None)
    if function is None: raise ValueError('Atomic no-replace directory import is unavailable on this node')
    function.argtypes = [ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(source_fd,os.fsencode(source),destination_fd,os.fsencode(destination),1):
        code=ctypes.get_errno()
        raise OSError(code,os.strerror(code),destination)


def atomic_import_available():
    function=getattr(ctypes.CDLL(None,use_errno=True),'renameat2',None)
    if function is None:return False
    function.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    function.restype=ctypes.c_int
    # Invalid relative directory FDs cannot touch the filesystem. EBADF proves
    # the kernel recognized the supported flag; ENOSYS/EPERM stays unavailable.
    return function(-1,b'gpuq-capability-source',-1,b'gpuq-capability-target',1)==-1 and ctypes.get_errno()==errno.EBADF


class LocalImports:
    def __init__(self, operations):
        self.ops=operations;self.n=operations.n;self.store=operations.store
        self.s=sys.modules[type(self.store).__module__]
        self.root=self.s.private_dir(self.ops.folder/'.local-imports',create=True)

    @property
    def data(self):return self.n.data_workspaces()

    @staticmethod
    def relative(value):
        if not isinstance(value,str) or len(value)>1024 or '\\' in value or any(ord(c)<32 or ord(c)==127 for c in value):raise ValueError('Use a relative workspace directory')
        parts=value.split('/')
        if any(not p or p in ('.','..') or len(p.encode())>255 for p in parts):raise ValueError('Use a relative workspace directory')
        return parts

    def identity(self,args,begin=False):
        allowed={'userId','project','key'}|({'sourcePath','destinationPath'} if begin else set())
        if not isinstance(args,dict) or set(args)!=allowed:raise ValueError('Invalid local import fields')
        self.ops.identity(args)
        if not isinstance(args['key'],str) or not UUID.fullmatch(args['key']):raise ValueError('Use a fixed import UUID')
        if begin:
            for field in ('sourcePath','destinationPath'):
                parts=self.relative(args[field])
                if any(part in EXCLUDED or part.startswith('.env.') and part!='.env.example' for part in parts):
                    raise ValueError('Secret and environment directories cannot be imported as project code')
        return args

    def folder(self,args,create=False):
        self.ops.identity(args)
        return self.s.private_dir(self.root/self.ops.key(args),create=create)

    def receipt_path(self,args):return self.folder(args)/ (args['key']+'.json')
    def project_pointer(self,args):return self.ops.folder/(self.ops.key(args)+'.local-import.json')
    def unit(self,args):return 'gpuq-project-local-import-'+hashlib.sha256((self.ops.key(args)+'\0'+args['key']).encode()).hexdigest()[:32]+'.service'

    def load(self,args):
        value=self.s.read_json(self.receipt_path(args))
        request=value.get('request')
        self.identity(request,True)
        if any(request[k]!=args[k] for k in ('userId','project','key')) or value.get('protocol')!=PROTOCOL:
            raise ValueError('Local import receipt belongs to another request')
        if value.get('state') not in FINAL|{'IMPORTING','COMMITTING'}:raise ValueError('Invalid local import state')
        return value

    def write(self,args,value):self.n.atomic_json(self.receipt_path(args),value)

    def project_writable(self,args):
        try:pointer=self.s.read_json(self.project_pointer(args))
        except FileNotFoundError:return
        self.identity(pointer)
        if any(pointer[k]!=args[k] for k in ('userId','project')) or self.load(pointer)['state'] not in FINAL:
            raise ValueError('Project local import is pending or unconfirmed; inspect its original operation ID')

    def data_writable(self,user):
        _,_,owner=self.data.storage(user)
        try:pointer=self.s.read_json(owner/'project-import.json')
        except FileNotFoundError:return
        self.identity(pointer)
        if pointer['userId']!=user or self.load(pointer)['state'] not in FINAL:
            raise ValueError('Personal data is fenced by a pending or unconfirmed project import')

    def _open(self,root,parts,directory=True):
        fd=os.dup(root)
        try:
            for index,part in enumerate(parts):
                flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
                if directory or index<len(parts)-1:flags|=os.O_DIRECTORY
                child=os.open(part,flags,dir_fd=fd);os.close(fd);fd=child
            return fd
        except BaseException:os.close(fd);raise

    def _source(self,args):
        module,_,owner=self.data.storage(args['userId'])
        with module._directory(owner/'data') as root:
            return self._open(root,self.data.relative(args['sourcePath']))

    def _target(self,args):
        path=self.store.dev_paths(args['userId'],args['project'])['code']
        parts=self.data.relative(args['destinationPath'])
        with self.s.directory(path) as root:parent=self._open(root,parts[:-1])
        try:
            try:os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
            except FileNotFoundError:return parent,parts[-1]
            raise ValueError('Import destination already exists; select a new draft directory')
        except BaseException:os.close(parent);raise

    def _quiet_project(self,args):
        for pointer in self.n.terminal_pointers(args):
            jid=pointer.read_text()
            if not UUID.fullmatch(jid) or not self.ops.terminal_stopped(jid):
                raise ValueError('Close all project terminals; running or unconfirmed writers block local import')
        if any(self.ops.transfer_dir(args).glob('*.json')):
            raise ValueError('Unfinished code uploads; inspect project uploads and cancel the exact pending IDs first')

    def begin(self,args):
        self.identity(args,True)
        if not atomic_import_available():raise ValueError('Atomic no-replace directory import is unavailable on this node')
        self.folder(args,True)
        try:existing=self.load(args)
        except FileNotFoundError:existing=None
        if existing is not None:
            if existing['request']!=args:raise ValueError('Import UUID belongs to different immutable paths')
            return self.status({k:args[k] for k in ('userId','project','key')})
        with os.fdopen(self.data.lifetime(args['userId'],exclusive=True),'rb'),self.data.guard(args),self.ops.guard(args):
            try:existing=self.load(args)
            except FileNotFoundError:existing=None
            if existing is not None:
                if existing['request']!=args:raise ValueError('Import UUID belongs to different immutable paths')
                return self.status({k:args[k] for k in ('userId','project','key')})
            self.data.writable(args);self.ops.writable(args)
            with self.store.locked(args['userId'],args['project']):
                self.data.no_terminals(args['userId']);self._quiet_project(args)
                source=self._source(args);target,name=self._target(args)
                try:source_stamp=stamp(os.fstat(source))
                finally:os.close(source);os.close(target)
                value={'protocol':PROTOCOL,'request':dict(args),'state':'IMPORTING','phase':'SCANNING',
                       'sourceStamp':source_stamp,'createdAt':time.time(),'files':0,'bytes':0}
                pointer={k:args[k] for k in ('userId','project','key')}
                self.write(args,value)
                self.n.atomic_json(self.project_pointer(args),pointer)
                self.n.atomic_json(self.data.storage(args['userId'])[2]/'project-import.json',pointer)
                try:
                    self.n.run(['/usr/bin/systemd-run','--user','--collect','--unit='+self.unit(args),
                        '--property=KillMode=control-group','--property=UMask=0077','--property=CPUQuota=100%',
                        '--property=MemoryMax=1G','--property=TasksMax=128','--property=IOWeight=10',
                        '--property=RuntimeMaxSec=86400','--property=TimeoutStopSec=20',
                        '/usr/bin/python3',str(self.n.HERE/'node-executor.py'),'--project-local-import-worker',
                        args['userId'],args['project'],args['key']],timeout=8)
                except (OSError,ValueError,subprocess.SubprocessError):pass  # launch may have succeeded
        return self.status(pointer)

    def status(self,args):
        self.identity(args);value=self.load(args)
        result={'protocol':PROTOCOL,'key':args['key'],'project':args['project'],
                **{k:value[k] for k in ('state','phase','files','bytes','totalFiles','totalBytes','warnings','manifestSha256','error','sourcePath','destinationPath') if k in value},
                'sourcePath':value['request']['sourcePath'],'destinationPath':value['request']['destinationPath'],
                'draftChanged':value['state']=='IMPORTED'}
        if value['state'] not in FINAL:
            if not self.worker_active(args):result.update(state='UNKNOWN',draftChanged=False,error='Worker outcome is unconfirmed; keep this ID and its fences')
        return result

    def worker_active(self,args):
        try:
            out=subprocess.run(['/usr/bin/systemctl','--user','show',self.unit(args),
                '--property=LoadState,ActiveState,SubState,MainPID'],env=self.n.ENV,text=True,capture_output=True,timeout=5)
            props=dict(line.split('=',1) for line in out.stdout.splitlines() if '=' in line)
            return (out.returncode==0 and set(props)=={'LoadState','ActiveState','SubState','MainPID'}
                and props['LoadState']=='loaded' and props['ActiveState']=='active'
                and props['SubState']=='running' and props['MainPID'].isdigit() and int(props['MainPID'])>0)
        except (OSError,ValueError,subprocess.SubprocessError):return False

    def _cancel_path(self,args):return self.folder(args)/(args['key']+'.cancel')
    def canceled(self,args):return self._cancel_path(args).exists()

    def cancel(self,args):
        self.identity(args);value=self.load(args)
        if value['state'] in FINAL:return self.status(args)
        self.n.atomic_json(self._cancel_path(args),{k:args[k] for k in ('userId','project','key')})
        try:self.n.run(['/usr/bin/systemctl','--user','stop',self.unit(args)],timeout=20)
        except (OSError,ValueError,subprocess.SubprocessError):return self.status(args)
        try:stopped=self.data.unit_stopped(self.unit(args))
        except (OSError,ValueError,subprocess.SubprocessError):stopped=False
        if not stopped:return self.status(args)
        with os.fdopen(self.data.lifetime(args['userId'],exclusive=True),'rb'),self.data.guard(args),self.ops.guard(args),self.store.locked(args['userId'],args['project']):
            value=self.load(args)
            if value['state'] in FINAL:return self.status(args)
            if value['state']=='COMMITTING':return self.status(args)  # never guess past atomic commit
            self.cleanup(args)
            self.write(args,{**value,'state':'CANCELED','phase':'CANCELED'})
        return self.status(args)

    def cleanup(self,args):
        stage=self.folder(args)/(args['key']+'.staging')
        try:fd=os.open(stage,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        except FileNotFoundError:return
        def remove(parent):
            for name in os.listdir(parent):
                info=os.stat(name,dir_fd=parent,follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                    try:remove(child)
                    finally:os.close(child)
                    os.rmdir(name,dir_fd=parent)
                else:os.unlink(name,dir_fd=parent)
        try:remove(fd)
        finally:os.close(fd)
        stage.rmdir()

    def scan(self,root,progress=None):
        rows=[];count=total=entries=0
        last=time.monotonic()
        def visit(fd,prefix=''):
            nonlocal count,total,entries,last
            before=stamp(os.fstat(fd));names=sorted(os.listdir(fd))
            rows.append({'path':prefix,'kind':'directory','stamp':before,'names':names})
            for name in names:
                entries+=1
                if entries>self.store.max_entries:raise ValueError('Local import exceeds project entry budget')
                self.data.relative(name)
                if name in EXCLUDED or name.startswith('.env.') and name!='.env.example':
                    raise ValueError('Remove secret, cache or environment entries before local code import')
                path=name if not prefix else prefix+'/'+name;self.data.relative(path)
                info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    try:visit(child,path)
                    finally:os.close(child)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink==1:
                    count+=1;total+=info.st_size
                    if count>self.store.max_entries:raise ValueError('Local import exceeds project file budget')
                    self.store.size_warnings(total)
                    rows.append({'path':path,'kind':'file','stamp':stamp(info),'size':info.st_size})
                else:raise ValueError('Only ordinary directories and single-link regular files can be imported')
                if progress is not None and time.monotonic()-last>=1:
                    progress(count,total);last=time.monotonic()
            if stamp(os.fstat(fd))!=before or sorted(os.listdir(fd))!=names:raise ValueError('Source directory changed during scan')
        visit(root)
        if not count:raise ValueError('Source contains no project files')
        return rows,total,count

    def worker(self,user,project,key):
        args={'userId':user,'project':project,'key':key};self.identity(args)
        value=self.load(args)
        if value['state'] in FINAL:return 0
        if value['state']!='IMPORTING':return 1  # never repeat an unconfirmed commit
        request=value['request'];source=stage=target=None
        with os.fdopen(self.data.lifetime(user,exclusive=True),'rb'),self.data.guard(args),self.ops.guard(args),self.store.locked(user,project):
            try:
                pointer={k:args[k] for k in ('userId','project','key')}
                if self.s.read_json(self.project_pointer(args))!=pointer or self.s.read_json(self.data.storage(user)[2]/'project-import.json')!=pointer:
                    raise ValueError('Source/destination import fences do not match')
                self.data.no_terminals(user);self._quiet_project(args)
                source=self._source(request)
                if stamp(os.fstat(source))!=value['sourceStamp']:raise ValueError('Source changed after import admission')
                rows,total,count=self.scan(source,lambda files,size:self.write(args,{**value,'phase':'SCANNING','files':files,'bytes':size}))
                dev=self.store.dev_paths(user,project)
                existing=self.store._scan_totals({'code':dev['code'],'env':dev['env']},lambda *args:None)
                if existing['entries']+len(rows)>self.store.max_entries:
                    raise ValueError('Existing draft plus local import exceeds the project entry budget')
                warnings=self.store.size_warnings(existing['bytes']+total)
                self.store._space(total)
                value={**value,'totalFiles':count,'totalBytes':total,'warnings':warnings,'phase':'COPYING','files':0,'bytes':0}
                self.write(args,value)
                folder=self.folder(args);stage_path=folder/(key+'.staging')
                self.s.private_dir(stage_path,create=True);self.store._quota(user,stage_path)
                stage=os.open(stage_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                if os.listdir(stage):raise ValueError('Import staging already exists; do not repeat this worker')
                manifest=[];copied=files=0;last=time.monotonic()
                for row in rows[1:]:
                    if self.canceled(args):raise InterruptedError('Import was canceled')
                    parts=row['path'].split('/')
                    parent=self._open(stage,parts[:-1])
                    try:
                        if row['kind']=='directory':os.mkdir(parts[-1],0o700,dir_fd=parent);continue
                        incoming=self._open(source,parts,False);outgoing=None
                        try:
                            executable=bool(row['stamp'][2]&stat.S_IXUSR)
                            outgoing=os.open(parts[-1],os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700 if executable else 0o600,dir_fd=parent)
                            if stamp(os.fstat(incoming))!=row['stamp']:raise ValueError('Source file changed before copying')
                            digest=hashlib.sha256();size=0
                            while True:
                                if self.canceled(args):raise InterruptedError('Import was canceled')
                                chunk=os.read(incoming,4*1024**2)
                                if not chunk:break
                                digest.update(chunk);size+=len(chunk);view=memoryview(chunk)
                                while view:view=view[os.write(outgoing,view):]
                                copied+=len(chunk)
                                if time.monotonic()-last>=1:
                                    self.write(args,{**value,'phase':'COPYING','files':files,'bytes':copied});last=time.monotonic()
                            os.fsync(outgoing)
                            if size!=row['size'] or stamp(os.fstat(incoming))!=row['stamp']:raise ValueError('Source file changed while copying')
                            checksum=digest.hexdigest();verify=hashlib.sha256();os.lseek(outgoing,0,0)
                            while True:
                                chunk=os.read(outgoing,4*1024**2)
                                if not chunk:break
                                verify.update(chunk)
                            if verify.hexdigest()!=checksum:raise ValueError('Copied project file checksum differs')
                            manifest.append({'path':row['path'],'size':size,'sha256':checksum,'executable':executable});files+=1
                        finally:
                            os.close(incoming)
                            if outgoing is not None:os.close(outgoing)
                    finally:os.close(parent)
                self.write(args,{**value,'phase':'VERIFYING','files':files,'bytes':copied})
                if self.scan(source)[0]!=rows:raise ValueError('Full source tree changed before final commit')
                current=self._source(request)
                try:
                    if stamp(os.fstat(current))!=value['sourceStamp']:raise ValueError('Source directory identity changed before final commit')
                finally:os.close(current)
                # Files are fsynced after copy; persist every newly created
                # directory entry as well before the atomic namespace commit.
                for row in reversed(rows):
                    if row['kind']!='directory':continue
                    directory=self._open(stage,row['path'].split('/') if row['path'] else [])
                    try:os.fsync(directory)
                    finally:os.close(directory)
                canonical=json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()
                if len(canonical)>64*1024**2:raise ValueError('Import manifest exceeds its bounded size')
                self.n.atomic_json(folder/(key+'.manifest.json'),manifest)
                if self.canceled(args):raise InterruptedError('Import was canceled')
                target,name=self._target(request)
                value={**value,'state':'COMMITTING','phase':'COMMITTING','files':count,'bytes':total,
                       'manifestSha256':hashlib.sha256(canonical).hexdigest()}
                self.write(args,value)
                try:
                    with self.s.directory(folder) as parent:rename_new(parent,key+'.staging',target,name)
                except OSError:
                    # The kernel refused the no-replace rename: no commit took
                    # place. Later fsync/receipt failures remain UNKNOWN.
                    value={**value,'state':'IMPORTING'}
                    raise
                os.fsync(target)
                self.write(args,{**value,'state':'IMPORTED','phase':'IMPORTED'})
                return 0
            except Exception as error:
                if value['state']=='COMMITTING':return 1  # preserve fences and potential committed data
                self.cleanup(args)
                self.write(args,{**value,'state':'CANCELED' if isinstance(error,InterruptedError) else 'FAILED',
                                 'phase':'STOPPED','error':str(error)[:500] if isinstance(error,(ValueError,InterruptedError)) else 'Local import failed; inspect this operation ID'})
                return 1
            finally:
                for fd in (source,stage,target):
                    if fd is not None:os.close(fd)

    def process(self,operation,args):
        action=operation.removeprefix('projects.local-import.')
        if action not in ('begin','status','cancel'):raise ValueError('Unknown local import action')
        return getattr(self,action)(args)
