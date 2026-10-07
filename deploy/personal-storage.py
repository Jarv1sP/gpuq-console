#!/usr/bin/python3
"""Optional, pinned local HDD/SSD roots; never relocate an existing project."""
import hashlib
import ast
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

PROTOCOL = 'personal-storage-v1'
MODES = ('isolated', 'shared')
HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location('gpuq_personal_' + name.replace('-', '_'), HERE/(name+'.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def need(condition, message):
    if not condition:
        raise ValueError(message)


class PersonalStorage:
    def __init__(self, config):
        self.config = config
        self.policy = config.get('personalStorage')
        need(isinstance(self.policy, dict) and set(self.policy) == {'enabled', 'hdd', 'ssd'}
             and type(self.policy['enabled']) is bool, 'Personal storage is not configured')
        self.s = module('project-store')
        self.layout = module('storage-layout')
        self.guard = module('platform-root-guard')
        self.roots = {}
        self._runtime_ok = None
        for tier in ('hdd', 'ssd'):
            value = self.policy[tier]
            need(isinstance(value, dict) and set(value) ==
                 {'root', 'mountPoint', 'filesystemUuid', 'rootInode', 'reserveBytes'},
                 'Invalid personal storage volume')
            path, backing = self.s.absolute(value['root']), self.s.absolute(value['mountPoint'])
            need(backing in path.parents and path != backing and type(value['rootInode']) is int
                 and value['rootInode'] > 0 and type(value['reserveBytes']) is int
                 and 0 <= value['reserveBytes'] < 2**63, 'Invalid personal storage boundary')
            self.roots[tier] = path
        need(not (self.roots['hdd'] == self.roots['ssd'] or self.roots['hdd'] in self.roots['ssd'].parents
                  or self.roots['ssd'] in self.roots['hdd'].parents), 'Personal storage roots must be separate')
        need(self.policy['hdd']['filesystemUuid']!=self.policy['ssd']['filesystemUuid'],
             'HDD and SSD must use distinct filesystem identities')

    def check(self, tier=None):
        tiers = (tier,) if tier else ('hdd', 'ssd')
        mounts = self.layout.read_mounts()
        for key in tiers:
            need(key in self.roots, 'Unknown storage tier')
            definition = self.policy[key]
            root = self.roots[key]
            backing = Path(definition['mountPoint'])
            active = self.layout.data_mount(root, mounts)
            need(active['target'] == str(backing), 'Personal storage backing mount changed')
            expected = self.guard.uuid_device(definition['filesystemUuid'])
            need(active['device'] == f'{os.major(expected)}:{os.minor(expected)}',
                 'Personal storage filesystem identity changed')
            with self.s.directory(root) as fd:
                info = os.fstat(fd)
                need((info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)) ==
                     (expected, definition['rootInode'], os.geteuid(), 0o700),
                     'Personal storage root identity or ownership changed')
        return True

    def require(self, tier, needed=0):
        need(self.policy['enabled'], 'Personal storage is disabled for new writes')
        if self._runtime_ok is None:self._runtime_ok=self.runtime_ready()
        need(self._runtime_ok, 'Complete personal storage runtime is unavailable; no legacy fallback')
        need(type(needed) is int and 0 <= needed < 2**63, 'Invalid storage requirement')
        self.check(tier)
        with self.s.directory(self.roots[tier]) as fd:
            value = os.fstatvfs(fd)
            available = value.f_bavail * value.f_frsize
        reserve = self.policy[tier]['reserveBytes']
        need(available >= reserve + needed,
             f'Personal {tier} space reserve reached: availableBytes={available}, '
             f'reserveBytes={reserve}, requestedBytes={needed}.')

    def runtime_ready(self):
        for name in ('node-executor.py','project-store.py','personal-oci.py','sandbox-runner.py','sandbox-runner-common-p0.py'):
            path=HERE/name
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0,os.geteuid()) or info.st_nlink!=1 or info.st_mode&0o022 or info.st_size>1024**2:return False
                source=os.read(fd,1024**2+1)
            finally:os.close(fd)
            tree=ast.parse(source)
            constants={target.id:value.value.value for value in tree.body if isinstance(value,ast.Assign)
                       and isinstance(value.value,ast.Constant) for target in value.targets if isinstance(target,ast.Name)}
            if constants.get('PERSONAL_STORAGE_PROTOCOL')!=1:return False
        return True

    def owner(self, user):
        need(isinstance(user, str) and 0 < len(user) <= 128
             and not any(ord(c) < 32 for c in user), 'Invalid authenticated storage owner')
        return hashlib.sha256(user.encode()).hexdigest()

    def quota(self, user, path):
        if 'storageQuota' in self.config:
            module('storage-quota').ensure(self.config, user, path)

    def project_base(self, create=False):
        self.check('hdd')
        if create:
            self.require('hdd', 4096)
        return self.s.private_dir(self.roots['hdd']/'projects-v2', create=create)

    def data_path(self, user, tier, create=False):
        self.check(tier)
        base = self.roots[tier]/'personal-data'
        owner = base/self.owner(user)
        if create:
            self.require(tier, 8192)
        self.s.private_dir(base, create=create)
        self.s.private_dir(owner, create=create)
        if create:
            self.quota(user, owner)
            identity={'schema':1,'userId':user,'owner':self.owner(user)}
            marker=owner/'owner.json'
            if marker.exists() or marker.is_symlink():
                need(self.s.read_json(marker)==identity,'Personal data owner identity changed')
            else:self.s.atomic_json(marker,identity)
        return self.s.private_dir(owner/'data', create=create)

    def data_lifetime(self,user,tier):
        owner=self.data_path(user,tier,create=True).parent
        path=owner/'lifetime.lock'
        fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
        try:
            info=os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==os.geteuid()
                 and not info.st_mode&0o077,'Unsafe personal data lifetime lock')
            fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
            try:
                current=self.s.read_json(owner/'current.json')
            except FileNotFoundError:current=None
            if current is not None:
                key=current.get('operationId')
                need(isinstance(key,str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',key),
                     'Personal publication identity changed')
                record=self.s.read_json(owner/'operations'/(key+'.json'))
                need(record.get('state')!='PUBLISHING','Personal data publication is pending; keep its original UUID')
            return fd
        except BaseException:os.close(fd);raise

    def open_data(self, user):
        class Mounts(list):pass
        result = Mounts();result.locks=[]
        try:
            for tier in ('hdd', 'ssd'):
                path = self.data_path(user, tier, create=True)
                result.locks.append(self.data_lifetime(user,tier))
                with self.s.directory(path) as fd:
                    result.append((os.dup(fd), '/data-'+tier))
            return result
        except BaseException:
            for fd, _ in result: os.close(fd)
            for fd in result.locks:os.close(fd)
            raise

    def status(self):
        self.check()
        volumes = {}
        for tier, root in self.roots.items():
            with self.s.directory(root) as fd:
                value = os.fstatvfs(fd)
            available = value.f_bavail * value.f_frsize
            reserve = self.policy[tier]['reserveBytes']
            volumes[tier] = {'availableBytes': available, 'filesystemBytes': value.f_blocks*value.f_frsize,
                            'reserveBytes': reserve, 'usableBytes': max(0, available-reserve),
                            'mountPath': '/data-'+tier}
        return {'protocol': PROTOCOL, 'available': self.policy['enabled'] and self.runtime_ready(), 'workspaceTier': 'hdd',
                'workspaceModes': list(MODES), 'volumes': volumes}


def configured(config):
    return isinstance(config.get('personalStorage'), dict)


def publication(executor,user,tier,*,readonly=False):
    need(tier in ('hdd','ssd'),'Unknown personal publication tier')
    storage=PersonalStorage(executor.CONFIG)
    if readonly:storage.check(tier)
    else:storage.require(tier)
    definition=module('data-workspace')
    def provider(owner):
        storage.data_path(owner,tier,create=not readonly)
        owner_path=storage.roots[tier]/'personal-data'/storage.owner(owner)
        storage.s.private_dir(owner_path/'operations',create=not readonly)
        dataset_module,cache=executor.personal_dataset_cache(owner,tier,create=not readonly)
        return dataset_module,cache,owner_path
    result=definition.DataWorkspaces(executor,storage_provider=provider,
                                    dataset_prefix='h' if tier=='hdd' else 's',tier=tier)
    result.unit=lambda owner,key:'gpuq-personal-publish-'+hashlib.sha256((owner+'\0'+tier+'\0'+key).encode()).hexdigest()[:32]
    return result


class PersonalCopies:
    """Explicit, same-node copies of private drafts; never move or overwrite."""
    def __init__(self, executor):
        self.n = executor
        self.storage = PersonalStorage(executor.CONFIG)
        self.s = self.storage.s

    def relative(self, value):
        need(isinstance(value,str) and 0<len(value)<=1024 and '\\' not in value
             and not any(ord(c)<32 or ord(c)==127 for c in value)
             and all(p not in ('','.', '..') and len(p.encode())<=255 for p in value.split('/')),
             'Use a relative path inside your private data folder')
        return Path(value)

    def folder(self, user, key, create=False, tier='hdd'):
        need(isinstance(key,str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',key),
             'Use the original full copy UUID')
        self.storage.data_path(user,tier,create=create)
        owner=self.storage.roots[tier]/'personal-data'/self.storage.owner(user)
        parent=self.s.private_dir(owner/'copies',create=create)
        return self.s.private_dir(parent/key,create=create)

    def unit(self,user,key):
        return 'gpuq-personal-copy-'+hashlib.sha256((user+'\0'+key).encode()).hexdigest()[:32]

    def stopped(self,user,key):
        return module('data-workspace').DataWorkspaces(self.n).unit_stopped(self.unit(user,key)+'.service')

    def read(self,user,key):
        folder=self.folder(user,key)
        value=self.s.read_json(folder/'request.json')
        need(value.get('userId')==user and value.get('key')==key,'Copy ownership or identity changed')
        return folder,value

    def status(self,user,key,*,observe=False):
        folder,request=self.read(user,key)
        try:result=self.s.read_json(folder/'status.json')
        except FileNotFoundError:result={'state':'UNKNOWN','phase':'UNCONFIRMED'}
        need(result.get('state') in ('QUEUED','RUNNING','VERIFYING','COMMITTING','SUCCEEDED','FAILED','CANCELED','UNKNOWN'),
             'Copy status is invalid; preserve the original UUID')
        if result.get('state')=='QUEUED' and (folder/'launch.json').exists() and self.s.read_json(folder/'launch.json').get('unconfirmed') is True:
            result={**result,'state':'UNKNOWN','phase':'LAUNCH_UNCONFIRMED'}
        if observe and result.get('state') in ('QUEUED','RUNNING','VERIFYING','COMMITTING') and self.stopped(user,key):
            result={**result,'state':'UNKNOWN','phase':'STOP_UNCONFIRMED'}
        return {'protocol':'personal-copy-v1','key':key,'sourceTier':request['sourceTier'],
                'targetTier':request['targetTier'],'sourcePath':request['sourcePath'],
                'targetPath':request['targetPath'],'cancelRequested':(folder/'cancel.json').exists(),**result}

    def launch(self,user,key):
        folder,_=self.read(user,key)
        self.s.atomic_json(folder/'status.json',{'state':'QUEUED','phase':'WAITING','updatedAt':time.time()})
        self.s.atomic_json(folder/'launch.json',{'unconfirmed':False})
        command=['/usr/bin/systemd-run','--user','--quiet','--collect','--unit='+self.unit(user,key),
                 '--property=Type=exec','--property=MemoryMax=512M','--property=TasksMax=16',
                 '--property=CPUQuota=100%','--property=IOWeight=10','--property=KillMode=control-group',
                 '/usr/bin/python3',str(self.n.HERE/'node-executor.py'),'--personal-copy-worker',user,key]
        try:subprocess.run(command,env=self.n.ENV,capture_output=True,check=True,timeout=5)
        except (OSError,subprocess.SubprocessError):
            # Do not overwrite a worker's final receipt if it finished while
            # systemd's response was lost.
            self.s.atomic_json(folder/'launch.json',{'unconfirmed':True})
        return self.status(user,key)

    def list(self,user):
        self.storage.check('hdd')
        parent=self.storage.roots['hdd']/'personal-data'/self.storage.owner(user)/'copies'
        if not parent.exists():return {'protocol':'personal-copies-v1','copies':[],'truncated':False}
        with self.s.directory(parent) as fd:names=os.listdir(fd)
        if len(names)>10000:raise ValueError('Copy history needs administrator archival; no records deleted')
        rows=[]
        for key in names:
            need(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',key),'Invalid copy history entry')
        recent=sorted(names,key=lambda key:(parent/key).stat(follow_symlinks=False).st_mtime,reverse=True)[:256]
        for key in recent:
            if (parent/key/'request.json').exists():rows.append(self.status(user,key,observe=True))
        return {'protocol':'personal-copies-v1','copies':rows,'truncated':len(names)>256}

    def begin(self,args):
        user=args['userId'];key=args['key']
        self.n.workspace(user)
        need(set(args)=={'userId','key','sourceTier','targetTier','sourcePath','targetPath'},'Invalid copy fields')
        need(args['sourceTier'] in ('hdd','ssd') and args['targetTier'] in ('hdd','ssd')
             and args['sourceTier']!=args['targetTier'],'Copy must select different data tiers')
        source=self.relative(args['sourcePath']);target=self.relative(args['targetPath'])
        self.storage.require(args['targetTier'])
        folder=self.folder(user,key,create=True)
        with self._lock(folder/'.request.lock'):
            path=folder/'request.json'
            if path.exists() or path.is_symlink():
                if self.s.read_json(path)!=args:raise ValueError('Same UUID cannot change copy source or target')
                return self.status(user,key)  # never launch a second worker
            src=self.storage.data_path(user,args['sourceTier'])/source
            dst=self.storage.data_path(user,args['targetTier'],create=True)/target
            with self.s.directory(src):pass
            with self.s.directory(dst.parent):
                need(not os.path.lexists(dst),'Target already exists; no file will be overwritten')
            self.s.atomic_json(path,args)
            return self.launch(user,key)

    def _lock(self,path):
        from contextlib import contextmanager
        @contextmanager
        def locked():
            fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
            try:
                info=os.fstat(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==os.geteuid()
                     and not info.st_mode&0o077,'Unsafe copy lock')
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                yield
            finally:os.close(fd)
        return locked()

    def cancel(self,user,key):
        folder,_=self.read(user,key)
        with self._lock(folder/'.request.lock'):
            current=self.status(user,key)
            if current['state']=='SUCCEEDED':return current
            self.s.atomic_json(folder/'cancel.json',{'userId':user,'key':key})
            if self.stopped(user,key):
                self.s.atomic_json(folder/'status.json',{'state':'CANCELED','phase':'STOPPED','updatedAt':time.time()})
            return self.status(user,key)

    def resume(self,user,key):
        folder,_=self.read(user,key)
        with self._lock(folder/'.request.lock'):
            current=self.status(user,key)
            need(not (folder/'cancel.json').exists() and current['state']=='FAILED'
                 and self.stopped(user,key),'Only a confirmed stopped failed copy can resume the same UUID')
            return self.launch(user,key)

    def worker(self,user,key):
        folder,request=self.read(user,key)
        with self._lock(folder/'.worker.lock'):
            current=self.status(user,key)
            if current['state']=='SUCCEEDED':return 0
            if current['state']=='CANCELED':return 1
            return self._copy(folder,request)

    def _copy(self,folder,request):
        user,key=request['userId'],request['key']
        payload_folder=None
        holds=[]
        def report(state,phase,**extra):
            self.s.atomic_json(folder/'status.json',{'state':state,'phase':phase,'updatedAt':time.time(),**extra})
        def canceled():
            if (folder/'cancel.json').exists():raise InterruptedError('Copy canceled; partial files retained')
        try:
            canceled();self.storage.require(request['targetTier'])
            for tier in (request['sourceTier'],request['targetTier']):
                holds.append(self.storage.data_lifetime(user,tier))
            source=self.storage.data_path(user,request['sourceTier'])/self.relative(request['sourcePath'])
            target=self.storage.data_path(user,request['targetTier'])/self.relative(request['targetPath'])
            payload_folder=self.folder(user,key,create=True,tier=request['targetTier'])
            payload=payload_folder/'payload'
            copier=self.n.projects().store
            old_entries,old_bytes=copier.max_entries,copier.max_bytes
            copier.max_entries,copier.max_bytes=500000,1024**4
            try:
                report('RUNNING','SCANNING')
                records,stamps=copier._walk(source,'code')
                snapshot={'records':records,'stamps':{k:list(v) for k,v in stamps.items()}}
                manifest=folder/'manifest.json'
                if manifest.exists():
                    need(self.s.read_json(manifest,limit=64*1024**2)==snapshot,'Source changed; partial copy was not reused')
                else:self.s.atomic_json(manifest,snapshot)
                total=sum(r.get('bytes',0) for r in records);done=0
                commit=folder/'commit.json'
                if commit.exists() and os.path.lexists(target):
                    identity=self.s.read_json(commit)
                    with self.s.directory(target) as fd:info=os.fstat(fd)
                    need([info.st_dev,info.st_ino]==identity['identity'],'Target differs from original committed copy')
                    report('SUCCEEDED','COPIED',bytes=total,totalBytes=total);return 0
                need(not os.path.lexists(target),'Target already exists; no overwrite')
                self.s.private_dir(payload,create=True)
                for record in records:
                    canceled();relative=self.relative(record['path'])
                    src,dst=source/relative,payload/relative
                    if record['type']=='directory':self.s.private_dir(dst,create=True);continue
                    need(record['type']=='file','Copy accepts only regular files and directories')
                    with self.s.directory(src.parent) as parent:
                        infile=os.open(src.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
                    outfile=None
                    try:
                        before=os.fstat(infile)
                        need(self.s.stamp(before)==tuple(snapshot['stamps'][record['path']]),'Source file identity changed')
                        with self.s.directory(dst.parent) as parent:
                            outfile=os.open(dst.name,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=parent)
                        observed=os.fstat(outfile)
                        need(stat.S_ISREG(observed.st_mode) and observed.st_nlink==1 and observed.st_uid==os.geteuid()
                             and observed.st_size<=record['bytes'],'Unsafe partial copy')
                        checksum=hashlib.sha256();prefix=observed.st_size;offset=0
                        while offset<record['bytes']:
                            canceled();block=os.read(infile,min(1024**2,record['bytes']-offset))
                            need(bool(block),'Source file became shorter')
                            if offset<prefix:
                                check=min(len(block),prefix-offset)
                                need(os.pread(outfile,check,offset)==block[:check],'Partial prefix differs; no overwrite')
                            else:check=0
                            if check<len(block):
                                self.storage.require(request['targetTier'],len(block)-check)
                                view=memoryview(block)[check:];os.lseek(outfile,offset+check,os.SEEK_SET)
                                while view:
                                    written=os.write(outfile,view);need(written>0,'Copy write incomplete');view=view[written:]
                                os.fsync(outfile)
                            checksum.update(block);offset+=len(block)
                        need(checksum.hexdigest()==record['sha256'] and self.s.stamp(os.fstat(infile))==tuple(snapshot['stamps'][record['path']]),
                             'Source file changed while copying')
                        os.fchmod(outfile,0o700 if record['executable'] else 0o600);os.fsync(outfile)
                        done+=record['bytes'];report('RUNNING','COPYING',bytes=done,totalBytes=total)
                    finally:
                        os.close(infile)
                        if outfile is not None:os.close(outfile)
                report('VERIFYING','VERIFYING',bytes=done,totalBytes=total)
                fresh,fresh_stamps=copier._walk(source,'code')
                need(fresh==records and {k:list(v) for k,v in fresh_stamps.items()}==snapshot['stamps'],'Source changed before commit')
                target_records,_=copier._walk(payload,'code')
                need(target_records==records,'Copied files failed SHA256 verification')
                canceled()
                with self.s.directory(payload) as fd:info=os.fstat(fd)
                self.s.atomic_json(commit,{'identity':[info.st_dev,info.st_ino]})
                report('COMMITTING','COMMITTING',bytes=done,totalBytes=total)
                importer=module('project-local-import')
                with self._lock(folder/'.request.lock'):
                    canceled()
                    with self.s.directory(payload.parent) as src, self.s.directory(target.parent) as dst:
                        importer.rename_new(src,payload.name,dst,target.name)
                        os.fsync(dst);os.fsync(src)
                    report('SUCCEEDED','COPIED',bytes=done,totalBytes=total);return 0
            finally:copier.max_entries,copier.max_bytes=old_entries,old_bytes
        except InterruptedError:
            report('CANCELED','STOPPED');return 1
        except Exception as error:
            report('FAILED','STOPPED',error='Copy failed; source and partial bytes retained',errorClass=type(error).__name__)
            return 1
        finally:
            for fd in holds:os.close(fd)


class WorkspacePreparation:
    """One CPU-only preparation per immutable job, before any GPU dispatch."""
    def __init__(self, executor):
        self.n=executor
        self.s=module('project-store')

    def path(self, job):
        need(isinstance(job.get('id'),str) and self.s.JOB_ID.fullmatch(job['id']), 'Invalid preparation job identity')
        return self.n.ROOT/'jobs'/(job['id']+'.workspace.json')

    def unit(self, job):return 'gpuq-workspace-'+job['id']+'.service'

    def result(self, job):
        path=self.path(job)
        if not path.exists():return None
        record=self.s.read_json(path)
        need(record.get('jobId')==job['id'] and record.get('state') in ('QUEUED','READY','FAILED','CANCELED','UNKNOWN'),
             'Workspace preparation receipt changed')
        state=record['state']
        if state=='READY':return None
        if state=='QUEUED':
            launch=self.n.ROOT/'jobs'/(job['id']+'.workspace-launch.json')
            if launch.exists() and self.s.read_json(launch).get('unconfirmed') is True:state='UNKNOWN'
        if state=='QUEUED':
            stopped=module('data-workspace').DataWorkspaces(self.n).unit_stopped(self.unit(job))
            if stopped:state='UNKNOWN'
        if state=='QUEUED':return {'state':'PENDING','schedulerState':'WORKSPACE_PREPARING',
            'assignedIndices':[],'queueReason':'正在后台准备 HDD 工作区；尚未申请 GPU。'}
        return {'state':state,'assignedIndices':[],
            **({'notSubmitted':True,'failureCode':'WORKSPACE_PREPARATION_FAILED'} if state=='FAILED' else {}),
            'error':'工作区准备未完成；未申请 GPU，不会自动换编号重试。'}

    def ensure(self, job):
        path=self.path(job)
        if path.exists():return self.result(job)
        self.s.atomic_json(path,{'jobId':job['id'],'state':'QUEUED'})
        command=['/usr/bin/systemd-run','--user','--quiet','--collect','--unit='+self.unit(job),
            '--property=Type=exec','--property=KillMode=control-group','--property=UMask=0077',
            '--property=CPUQuota=100%','--property=MemoryMax=1G','--property=TasksMax=16','--property=IOWeight=10',
            '/usr/bin/python3',str(self.n.HERE/'node-executor.py'),'--personal-workspace-worker',job['id']]
        try:subprocess.run(command,env=self.n.ENV,capture_output=True,check=True,timeout=5)
        except (OSError,subprocess.SubprocessError):
            # A delayed systemd reply can still launch the original worker.
            # Only its durable READY receipt may lift this fence.
            self.s.atomic_json(self.n.ROOT/'jobs'/(job['id']+'.workspace-launch.json'),{'unconfirmed':True})
        return self.result(job)

    def worker(self, key):
        need(isinstance(key,str) and self.s.JOB_ID.fullmatch(key),'Invalid preparation identity')
        job=self.s.read_json(self.n.ROOT/'jobs'/(key+'.json'))
        self.n.validate_job(job)
        need(job['id']==key and job.get('project'),'Workspace preparation requires an immutable project job')
        store=self.n.projects().store
        need(store.project_is_personal(job['userId'],job['project']),'Personal workspace required')
        canceled=self.n.ROOT/'jobs'/(key+'.canceled')
        def check(*args):
            if canceled.exists():raise InterruptedError('Preparation canceled')
        def report(state):self.s.atomic_json(self.path(job),{'jobId':key,'state':state})
        with store.lifetime(job['userId'],job['project']), store._file_lock(self.n.ROOT/'jobs'/(key+'.workspace.lock')):
            try:
                record=self.s.read_json(self.path(job))
                need(record.get('jobId')==key,'Preparation receipt identity changed')
                if record['state']=='READY':return 0
                if record['state'] in ('FAILED','CANCELED'):return 1
                check()
                store._publication_chunk=store._publication_entry=check
                store.run_paths(job['userId'],job['project'],job['release'],key,
                    **({'workspace_mode':job['workspaceMode']} if 'workspaceMode' in job else {}))
                check();report('READY');return 0
            except InterruptedError:report('CANCELED');return 1
            except Exception:report('FAILED');return 1
            finally:store._publication_chunk=store._publication_entry=None
