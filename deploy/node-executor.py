#!/usr/bin/python3
"""Forced command. Fixed GPUQ wrapper; user commands only run inside the sandbox."""
import base64, fcntl, hashlib, importlib.util, json, os, re, sqlite3, stat, subprocess, sys, socket, tempfile, time, uuid
from pathlib import Path
from contextlib import closing
from types import SimpleNamespace
HERE=Path(__file__).resolve().parent
CONFIG=json.loads((HERE/'node-config.json').read_text())
ROOT=Path(CONFIG['root'])
RUNTIME=f'/run/user/{os.getuid()}'
ENV={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'LANG':'C.UTF-8','XDG_RUNTIME_DIR':RUNTIME,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+RUNTIME+'/bus'}
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
DATASET_ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
DATASET_VERSION=re.compile(r'^[a-f0-9]{64}$')
DATASET_MODULE=None
DATASET_UPLOADS=None
DATA_WORKSPACES=None
DATA_IMPORTS=None
CLOUD_FILES=None
PROJECT_OPS=None
STORAGE_NODE=None
STORAGE_AUTHORITY=None
STORAGE_AUTHORITY_MODULE=None
STORAGE_ARCHIVE=None
STORAGE_LEASES=None
ADMIN_COMMAND=None
HOST_COMMAND_CAPABILITY='host-command-v1'
TASK_DISPLAY_CAPABILITY='console-task-display-v1'
DIAGNOSTICS=None
PLATFORM_ROOT_GUARD=None
WORKSPACE_STORAGE=None
policy_module=importlib.util.spec_from_file_location('gpuq_console_scheduling',HERE/'scheduling-policy.py')
SCHEDULING=importlib.util.module_from_spec(policy_module);policy_module.loader.exec_module(SCHEDULING)
PRIORITIES=SCHEDULING.PRIORITY_PRESETS
PRIORITY_RANKS={'idle':0,'normal':2,'high':4,**{'P'+str(i):i for i in range(5)}}

def platform_root_check():
    global PLATFORM_ROOT_GUARD
    if PLATFORM_ROOT_GUARD is None:
        spec=importlib.util.spec_from_file_location('gpuq_platform_root_guard',HERE/'platform-root-guard.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        PLATFORM_ROOT_GUARD=module
    return PLATFORM_ROOT_GUARD.check(ROOT)

def workspace_storage_check(needed=0, *, target_fd=None, admission=False):
    """Only configured nodes gain new-start admission; controls stay available."""
    global WORKSPACE_STORAGE
    if 'workspaceReserveBytes' not in CONFIG:
        if admission:return
        # Preserve legacy policy and minimal legacy runtime dependencies. The
        # write caller supplies an already-open no-follow directory descriptor.
        space=os.statvfs(target_fd if target_fd is not None else ROOT)
        if space.f_bavail*space.f_frsize<10*1024**3+needed:raise ValueError('Workspace disk reserve reached')
        return
    if WORKSPACE_STORAGE is None:
        spec=importlib.util.spec_from_file_location('gpuq_workspace_storage',HERE/'project-store.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        WORKSPACE_STORAGE=module
    WORKSPACE_STORAGE.require_workspace_space(ROOT,WORKSPACE_STORAGE.workspace_reserve_bytes(CONFIG),needed,target_fd=target_fd)

def job_diagnostics(job,data):
    global DIAGNOSTICS
    if DIAGNOSTICS is None:
        spec=importlib.util.spec_from_file_location('gpuq_job_diagnostics',HERE/'job-diagnostics.py')
        DIAGNOSTICS=importlib.util.module_from_spec(spec);spec.loader.exec_module(DIAGNOSTICS)
    return DIAGNOSTICS.bundle(ROOT,job,data)

def job_log_result(job,data,text):
    try:
        package=job_diagnostics(job,data)
        footer=DIAGNOSTICS.summary(package)
    except Exception:
        footer='\n\n[GPUQ 诊断暂不可用；不据此判断 worker 健康或改变任务终态]\n查看：gpuctl diagnostics '+job['id']+' --json\n'
    return {'text':text+footer}

def host_command(operation,args):
    global ADMIN_COMMAND
    if ADMIN_COMMAND is None:
        spec=importlib.util.spec_from_file_location('gpuq_admin_command',HERE/'admin-command.py')
        ADMIN_COMMAND=importlib.util.module_from_spec(spec);sys.modules[spec.name]=ADMIN_COMMAND;spec.loader.exec_module(ADMIN_COMMAND)
    return ADMIN_COMMAND.process(CONFIG,operation,args)

def priority_capability(rank_only=False):
    capabilities=gpu('status').get('daemon',{}).get('capabilities',[])
    if not isinstance(capabilities,list) or not all(c in capabilities for c in ('priority-policy-v1','preempt-idle-only-v1')):
        raise ValueError('Scheduler priority capability is not available; no policy was changed')
    if rank_only and 'priority-rank-v1' not in capabilities:
        raise ValueError('Scheduler rank-only capability is not available; refusing a policy-changing fallback')

def scheduling_status(job,data):
    state=data.get('job',data);attempts=data.get('attempts',[])
    policy={k:state.get(k) for k in ('priority','yield_policy','restart_policy','dispatch_mode')}
    priority=next((name for name,level in PRIORITY_RANKS.items() if policy['priority']==level),None)
    # Classification never rewrites an old task. Editing is only enabled for
    # explicit new Console jobs whose persistent scheduler scope is verified.
    verified=job.get('preemptIdleOnly') is True and state.get('preempt_idle_only') is True
    if 'scheduling' in job:
        submitted=SCHEDULING.normalize_job_policy(job)
        # Rank is deliberately excluded: previous rank-only edits leave the
        # immutable submission unchanged. Verify the rest of the contract.
        verified=(all(state.get(key)==submitted[key] for key in ('yield_policy','restart_policy','dispatch_mode'))
                  and state.get('checkpoint_capability')==('epoch-v1' if submitted['checkpointable'] else 'none')
                  and state.get('preempt_idle_only') is submitted['preempt_idle_only']
                  and state.get('preempt_opt_in_only',False) is submitted.get('preempt_opt_in_only',False))
    mutable=state.get('state')=='PENDING' and verified
    opted_in='scheduling' in job or (job.get('preemptIdleOnly') is True and state.get('preempt_idle_only') is True)
    return {'schedulerState':state.get('state'),'schedulerPriority':state.get('priority'),
            'priority':priority,'schedulerPolicy':policy,'priorityMutable':mutable,
            'queueReason':state.get('state_reason'),
            'progress':data.get('progress'),
            'latestAttempt':({k:attempts[0].get(k) for k in ('id','ordinal','state','exit_code','failure_reason','started_at','finished_at')} if attempts else None),
            'preempted':opted_in and state.get('state')=='CANCELED' and bool(attempts) and attempts[0].get('state')=='PREEMPTED'}

def projects():
    global PROJECT_OPS
    if PROJECT_OPS is None:
        spec=importlib.util.spec_from_file_location('gpuq_project_operations',HERE/'project-ops.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        # Works both when imported for tests/runner and as the forced command.
        PROJECT_OPS=module.ProjectOperations(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return PROJECT_OPS

def atomic_json(path,data):
    fd,name=tempfile.mkstemp(prefix='.write-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as stream:json.dump(data,stream);stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)

def dataset_mount_check(config):
    point=config.get('mountPoint','/data2');cache=config.get('root','/data2/datasets')
    for path in (point,cache):
        if not isinstance(path,str) or not path.startswith('/') or '..' in Path(path).parts or str(Path(path))!=path:raise ValueError('Invalid dataset storage path')
    if point=='/' or Path(point) not in Path(cache).parents:raise ValueError('Dataset cache must be below its required data mount')
    # Exact mountpoint and a different device from /: directory existence alone
    # must never silently redirect dataset writes to a root-disk fallback.
    entries=[]
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left,right=line.split(' - ',1);a=left.split();b=right.split()
        target=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),a[4])
        entries.append((target,a[2],a[5].split(','),b[0]))
    root=next((entry for entry in reversed(entries) if entry[0]=='/'),None)
    mounted=next((entry for entry in reversed(entries) if entry[0]==point),None)
    if not root or not mounted or mounted[1]==root[1] or 'ro' in mounted[2] or mounted[3] not in ('ext4','xfs','btrfs','zfs'):
        raise ValueError('Required local dataset mount is unavailable; refusing root-disk fallback')
    # No symlink in the storage prefix, including ancestors.
    cursor=Path('/')
    for part in Path(cache).parts[1:-1]:
        cursor/=part
        if not stat.S_ISDIR(cursor.lstat().st_mode):raise ValueError('Dataset storage ancestors must be real directories')

def dataset_cache():
    global DATASET_MODULE
    config=CONFIG.get('datasets')
    if not isinstance(config,dict) or set(config)-{'root','mountPoint','sources','reserveBytes','uploads'}:raise ValueError('Dataset storage is not configured')
    dataset_mount_check(config)
    if DATASET_MODULE is None:
        module=importlib.util.spec_from_file_location('gpuq_dataset_cache',HERE/'dataset-cache.py')
        DATASET_MODULE=importlib.util.module_from_spec(module);sys.modules[module.name]=DATASET_MODULE;module.loader.exec_module(DATASET_MODULE)
    cache=DATASET_MODULE.DatasetCache(config.get('root','/data2/datasets'),sources=config.get('sources',{}),reserve_bytes=config.get('reserveBytes',10*1024**3),mount_point=config.get('mountPoint','/data2'))
    if 'storageQuota' in CONFIG:
        def quota_guard(actor,dataset,path):
            spec=importlib.util.spec_from_file_location('gpuq_dataset_quota',HERE/'storage-quota.py')
            quota=importlib.util.module_from_spec(spec);spec.loader.exec_module(quota)
            if not quota.scope(CONFIG)['enabled']:return
            owners=cache._dataset(actor,dataset)['owners']
            owner=quota.dataset_owner(CONFIG,actor.user_id,owners)
            if owner is not None:return storage_quota(owner,path)
        cache.quota_guard=quota_guard
    return DATASET_MODULE,cache

def dataset_uploads():
    global DATASET_UPLOADS
    if DATASET_UPLOADS is None:
        spec=importlib.util.spec_from_file_location('gpuq_dataset_upload',HERE/'dataset-upload.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        DATASET_UPLOADS=module.DatasetUploads(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    # Revalidate the current data mount even for compact upload status requests.
    dataset_mount_check(CONFIG['datasets'])
    return DATASET_UPLOADS

def data_workspaces():
    global DATA_WORKSPACES
    if DATA_WORKSPACES is None:
        spec=importlib.util.spec_from_file_location('gpuq_data_workspaces',HERE/'data-workspace.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        DATA_WORKSPACES=module.DataWorkspaces(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    dataset_mount_check(CONFIG['datasets'])
    return DATA_WORKSPACES

def data_imports():
    global DATA_IMPORTS
    if DATA_IMPORTS is None:
        spec=importlib.util.spec_from_file_location('gpuq_data_import',HERE/'data-import.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        DATA_IMPORTS=module.DataImports(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    dataset_mount_check(CONFIG['datasets'])
    return DATA_IMPORTS

def cloud_files():
    global CLOUD_FILES
    if CLOUD_FILES is None:
        spec=importlib.util.spec_from_file_location('gpuq_cloud_files',HERE/'cloud-files.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        CLOUD_FILES=module.CloudFiles(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    dataset_mount_check(CONFIG['datasets'])
    return CLOUD_FILES

def dataset_refs(job):
    refs=job.get('datasets',[])
    if not isinstance(refs,list) or len(refs)>16:raise ValueError('Invalid dataset selection')
    seen=set()
    for ref in refs:
        if not isinstance(ref,dict) or not {'dataset','version'}<=set(ref) or set(ref)-{'dataset','version','mountAs'} or not isinstance(ref['dataset'],str) or not DATASET_ID.fullmatch(ref['dataset']) or not isinstance(ref['version'],str) or not DATASET_VERSION.fullmatch(ref['version']):raise ValueError('Invalid immutable dataset reference')
        # mountAs is generated by the trusted portal for cross-node replicas;
        # public submission schemas never accept it. It changes only the name,
        # not the cache identity, owner authorization or read-only lease.
        alias=ref.get('mountAs',ref['dataset'])
        if not isinstance(alias,str) or not DATASET_ID.fullmatch(alias):raise ValueError('Invalid dataset mount alias')
        if alias in seen:raise ValueError('Only one dataset may use each mount name')
        seen.add(alias)
    return refs

def dataset_actor(module,args):
    # userId/hostAdmin originate at the authenticated VPS execution bridge, not
    # a client-provided Principal. Raw actor/admin/path fields are rejected below.
    workspace(args['userId'])
    if type(args.get('hostAdmin',False)) is not bool:raise ValueError('Invalid administrator identity')
    return module.Principal(args['userId'],args.get('hostAdmin',False))

def dataset_error(error):
    return os.strerror(error.errno) if isinstance(error,OSError) and error.errno else str(error)[:300]

def dataset_background_active(key):
    return subprocess.run(['/usr/bin/systemctl','--user','is-active','--quiet','gpuq-data-'+key[:32]],env=ENV,timeout=4).returncode==0

def dataset_background_status(folder,key,spec,cache,actor,*,catalog_snapshot=None):
    # READY is a current cache fact, never a historical worker receipt: a
    # completed transfer may since have been evicted or its mount removed.
    current={}
    if spec['op']=='prepare':
        current=(cache.status(actor,spec['dataset'],spec['version']) if catalog_snapshot is None
                 else cache._status_catalog_snapshot(actor,spec['dataset'],spec['version'],catalog_snapshot))
    if current.get('state')=='READY':return {**current,'operationId':key}
    if spec['op']=='prepare' and dataset_recovery_configured(cache,actor,spec['dataset'],spec['version']):current['recoveryConfigured']=True
    result=folder/(key+'.result.json')
    if result.exists():
        receipt=json.loads(result.read_text())
        return {**receipt,**current} if receipt.get('state')=='READY' else {**current,**receipt}
    if dataset_background_active(key):
        return {**current,'operationId':key,'state':{'prepare':'PREPARING','register':'REGISTERING','unregister':'UNREGISTERING'}[spec['op']]}
    if spec['op']=='unregister':
        return {'operationId':key,'dataset':spec['dataset'],'version':spec.get('version'),'state':'UNKNOWN','error':'Unregister worker outcome is unconfirmed; inspect this operation and its recovery journal before retrying'}
    return {**current,'operationId':key,'state':'FAILED','error':'Dataset worker is not running; retry the prepare or register operation'}

def dataset_prepare_pointer(folder,dataset,version):
    identity=hashlib.sha256(json.dumps([dataset,version]).encode()).hexdigest()
    return folder/('version-'+identity+'.current')

def dataset_current_prepare(folder,dataset,version):
    pointer=dataset_prepare_pointer(folder,dataset,version)
    if not pointer.exists():return None
    key=json.loads(pointer.read_text())['operationId']
    if not isinstance(key,str) or not DATASET_VERSION.fullmatch(key):raise ValueError('Invalid dataset worker pointer')
    spec=json.loads((folder/(key+'.json')).read_text())
    if spec.get('op')!='prepare' or spec.get('dataset')!=dataset or spec.get('version')!=version or hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()!=key:raise ValueError('Dataset worker identity mismatch')
    return key,spec


def dataset_recovery_configured(cache,actor,dataset,version):
    # Metadata-only capability hint, never a claim that a remote disk is live.
    # The detached prepare worker authenticates the fixed authority again.
    try:
        node=storage_node()
        with cache._locked():
            cache._dataset(actor,dataset)
            node.tier._receipt(actor,cache._tier(dataset,version),dataset,version)
        return True
    except (ValueError,OSError,TypeError,KeyError):return False

def dataset_op(operation,args):
    definitions={'datasets.capacity':set(),'datasets.list':set(),'datasets.status':{'dataset','version','operationId'},'datasets.prepare':{'dataset','version'},'datasets.register':{'dataset','sourceId','owners'},'datasets.unregister':{'dataset','version'}}
    if operation not in definitions or not isinstance(args,dict) or set(args)-definitions[operation]-{'userId','hostAdmin'}:raise ValueError('Invalid dataset operation fields')
    if operation=='datasets.unregister' and args.get('hostAdmin') is not True:raise ValueError('Administrator authorization required')
    module,cache=dataset_cache();actor=dataset_actor(module,args)
    if operation=='datasets.capacity':return cache.capacity(actor)
    folder=ROOT/'dataset-ops';folder.mkdir(mode=0o700,exist_ok=True)
    if operation=='datasets.list':
        listing,snapshots=cache._list_datasets_snapshot(actor)
        # Cache metadata does not know the detached worker's outcome. Dataset
        # permission was checked by list_datasets; shared owners may observe a
        # transfer without learning its initiating identity or host source.
        for item in listing['datasets']:
            for version in item['versions']:
                if version['state']=='READY':continue
                if dataset_recovery_configured(cache,actor,item['dataset'],version['version']):
                    version.update(canPrepare=True,recoveryConfigured=True)
                pending=dataset_current_prepare(folder,item['dataset'],version['version'])
                if pending:
                    current=dataset_background_status(folder,*pending,cache,actor,
                        catalog_snapshot=snapshots[(item['dataset'],version['version'])])
                    version.update({k:v for k,v in current.items() if k in ('state','operationId','error')})
        return listing
    if operation=='datasets.status' and 'operationId' in args:
        key=args['operationId']
        if set(args)-{'userId','hostAdmin','operationId'} or not isinstance(key,str) or not re.fullmatch('[a-f0-9]{64}',key):raise ValueError('Invalid dataset operation ID')
        spec=json.loads((folder/(key+'.json')).read_text())
        if hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()!=key:raise ValueError('Dataset worker identity mismatch')
        if spec.get('op')=='unregister' and not actor.is_admin:raise ValueError('Administrator authorization required')
        if not actor.is_admin and spec['userId']!=actor.user_id:raise ValueError('Dataset operation is not owned by this user')
        return dataset_background_status(folder,key,spec,cache,actor)
    dataset=args.get('dataset')
    if not isinstance(dataset,str) or not DATASET_ID.fullmatch(dataset):raise ValueError('Invalid dataset ID')
    if operation=='datasets.unregister':
        version=args.get('version')
        if version is not None and (not isinstance(version,str) or not DATASET_VERSION.fullmatch(version)):raise ValueError('Invalid immutable dataset version')
        # Each explicit removal gets its own receipt. Large replica cleanup runs
        # only in the detached worker, never inside the short SSH request.
        task={'op':'unregister','dataset':dataset,'version':version,'userId':actor.user_id,'hostAdmin':True,'requestId':str(uuid.uuid4())}
    elif operation=='datasets.register':
        if not actor.is_admin:raise ValueError('Administrator authorization required')
        source=args.get('sourceId');owners=args.get('owners')
        if not isinstance(source,str) or source not in CONFIG['datasets'].get('sources',{}):raise ValueError('Source ID is not approved in node configuration')
        if not isinstance(owners,list) or not owners or len(owners)>10000 or any(not isinstance(owner,str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',owner) for owner in owners):raise ValueError('Explicit valid dataset owners are required')
        task={'op':'register','dataset':dataset,'sourceId':source,'owners':sorted(set(owners)),'userId':actor.user_id,'hostAdmin':True}
    else:
        version=args.get('version')
        if not isinstance(version,str) or not DATASET_VERSION.fullmatch(version):raise ValueError('Invalid immutable dataset version')
        status=cache.status(actor,dataset,version)
        if status['state']=='READY':return status
        if dataset_recovery_configured(cache,actor,dataset,version):status['recoveryConfigured']=True
        task={'op':'prepare','dataset':dataset,'version':version,'userId':actor.user_id,'hostAdmin':actor.is_admin}
    key=hashlib.sha256(json.dumps(task,sort_keys=True).encode()).hexdigest();unit='gpuq-data-'+key[:32]
    spec=folder/(key+'.json');result=folder/(key+'.result.json')
    if operation=='datasets.status':
        pending=dataset_current_prepare(folder,dataset,version)
        return dataset_background_status(folder,*pending,cache,actor) if pending else status
    guard=dataset_prepare_pointer(folder,dataset,task['version']) if task['op']=='prepare' else folder/key
    with open(str(guard)+'.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if task['op']=='prepare':
            pending=dataset_current_prepare(folder,dataset,task['version'])
            if pending and dataset_background_active(pending[0]):return {'operationId':pending[0],'dataset':dataset,'version':task['version'],'state':'PREPARING'}
        active=dataset_background_active(key)
        if not active:
            atomic_json(spec,task);result.unlink(missing_ok=True)
            if task['op']=='prepare':atomic_json(dataset_prepare_pointer(folder,dataset,task['version']),{'operationId':key})
            run(['/usr/bin/systemd-run','--user','--collect','--unit='+unit,'--property=KillMode=control-group','--property=UMask=0077','--property=CPUQuota=100%','--property=MemoryMax=2G','--property=IOWeight=10','--property=RuntimeMaxSec=86400','--property=TimeoutStopSec=20','/usr/bin/python3',str(HERE/'node-executor.py'),'--dataset-worker',key],timeout=8)
    return {'operationId':key,'dataset':dataset,**({'version':task['version']} if task['op'] in ('prepare','unregister') else {}),'state':{'prepare':'PREPARING','register':'REGISTERING','unregister':'UNREGISTERING'}[task['op']]}

def dataset_worker(key):
    if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{64}',key):raise ValueError('Invalid background operation ID')
    folder=ROOT/'dataset-ops';task=json.loads((folder/(key+'.json')).read_text())
    if hashlib.sha256(json.dumps(task,sort_keys=True).encode()).hexdigest()!=key:raise ValueError('Background dataset request was modified')
    try:
        module,cache=dataset_cache();actor=dataset_actor(module,task)
        if task['op']=='register':out=cache.register_source(actor,task['dataset'],task['sourceId'],task['owners']);out['state']='REGISTERED'
        elif task['op']=='prepare':
            with cache._locked():
                cache._dataset(actor,task['dataset'])
                cached=cache._tier(task['dataset'],task['version'])['role']=='cache'
            # Only a service-verified authority receipt may recover an evicted
            # disposable copy. Never fall back to an old sourceId on failure.
            if cached:
                out=storage_node().tier.recover(module.Principal('builtin-admin',True),task['dataset'],task['version'])
            else:out=cache.materialize(actor,task['dataset'],task['version'])
        elif task['op']=='unregister':
            out=cache.unregister(actor,task['dataset'],task.get('version'));out['state']='UNREGISTERED'
        else:raise ValueError('Invalid background dataset action')
        # Never return transfer tokens, local paths, or source IDs to callers.
        out={k:v for k,v in out.items() if k in ('dataset','version','state','bytes','files','unregistered','registrationRetained','versions','recoveryId')}
    except Exception as error:out={'state':'FAILED','error':dataset_error(error)}
    atomic_json(folder/(key+'.result.json'),{**out,'operationId':key})
    return 0 if out['state']!='FAILED' else 1

class DatasetNotReady(ValueError):
    """An authorized cache status proved that a selected replica is absent."""

def acquire_datasets(job):
    refs=dataset_refs(job)
    if not refs:return []
    if CONFIG.get('storageArchive',{}).get('enabled') is True or os.path.lexists(ROOT/'storage-leases'):
        prepared=storage_leases().handoff_if_present(job)
        if prepared is not None:return prepared
    module,cache=dataset_cache();actor=module.Principal(job['userId'],False)
    for ref in refs:
        if cache.status(actor,ref['dataset'],ref['version'])['state']!='READY':raise DatasetNotReady('Dataset is not READY; prepare it before reserving GPUs')
    leases=[]
    for ref in refs:
        try:lease=cache.acquire_lease(actor,ref['dataset'],ref['version'],job['id'])
        except module.CacheError:
            # Eviction can win between the status check and lease acquisition.
            # Do not classify permission, mount, I/O or unknown errors by text.
            if cache.status(actor,ref['dataset'],ref['version'])['state']!='READY':
                raise DatasetNotReady('Dataset is not READY; prepare it before reserving GPUs')
            raise
        leases.append(lease)
        # Persist incrementally; errors deliberately retain existing leases.
        atomic_json(ROOT/'jobs'/(job['id']+'.datasets.json'),leases)
    return leases

def reject_unsubmitted_datasets(job,receipt):
    """Called only under the job flock with no native row or dispatch marker.

    Fence future retries before lease cleanup. Even a lost response or cleanup
    error must never turn this rejected immutable job into a later submission.
    """
    identity={'schema':1,'jobId':job['id'],'failureCode':'DATASET_NOT_READY'}
    if receipt.exists():
        if json.loads(receipt.read_text())!=identity:raise ValueError('Invalid dataset rejection receipt')
    else:atomic_json(receipt,identity)
    module,cache=dataset_cache();actor=module.Principal('scheduler',True)
    for ref in dataset_refs(job):
        with cache._locked():
            cache._record(actor,ref['dataset'],ref['version'])
            # Recover leases created before an interrupted receipt write too;
            # never release another job's or another owner's training lease.
            leases=[lease for lease in cache._leases(ref['dataset'],ref['version'])
                    if lease['jobId']==job['id'] and lease['owner']==job['userId']]
        for lease in leases:cache.release_lease(actor,ref['dataset'],ref['version'],lease['id'])
        with cache._locked():
            if any(lease['jobId']==job['id'] and lease['owner']==job['userId']
                   for lease in cache._leases(ref['dataset'],ref['version'])):
                raise ValueError('Unsubmitted dataset lease cleanup is not confirmed')
    (ROOT/'jobs'/(job['id']+'.datasets.json')).unlink(missing_ok=True)
    if os.path.lexists(ROOT/'storage-leases'/'training'/job['id']):
        storage_leases().finalize_training(job)
    return {'state':'FAILED','notSubmitted':True,'failureCode':'DATASET_NOT_READY','assignedIndices':[],
            'error':'数据副本在提交前已失效，未启动训练。请重新准备数据后新建任务。'}

def dataset_open_mounts(job):
    leases=acquire_datasets(job);opened=[]
    try:
        module,_=dataset_cache()
        for ref,lease in zip(dataset_refs(job),leases):
            if lease.get('readOnly') is not True:raise ValueError('Dataset lease is not read-only')
            with module._directory(Path(lease['path'])) as descriptor:fd=os.dup(descriptor)
            opened.append((fd,'/data2/'+ref.get('mountAs',lease['dataset'])))
        return opened
    except BaseException:
        for fd,_ in opened:os.close(fd)
        raise

def dataset_unit_stopped(attempt):
    if attempt.get('state') not in ('EXITED_SUCCESS','EXITED_FAILURE','CANCELED','PREEMPTED'):return False
    name=attempt.get('unit_name','')
    if not isinstance(name,str) or not re.fullmatch(r'gpuq-[a-z0-9_-]+(?:\.service)?',name):return False
    if not name.endswith('.service'):name+='.service'
    try:
        result=subprocess.run(['/usr/bin/systemctl','--user','show',name,'--property=LoadState,ActiveState,SubState,MainPID,ControlGroup'],env=ENV,text=True,capture_output=True,timeout=5)
        props=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        if set(props)!={'LoadState','ActiveState','SubState','MainPID','ControlGroup'}:return False
        if result.returncode and not (result.returncode==1 and props['LoadState']=='not-found'):return False
        # GPUQ uses RemainAfterExit=yes: active/exited with an empty cgroup is
        # finished too, and a collected exact unit can report not-found/code 1.
        quiet=props['ActiveState'] in ('inactive','failed') or (props['ActiveState']=='active' and props['SubState']=='exited')
        if props['MainPID']!='0' or not quiet:return False
        group=props['ControlGroup']
        if not group:return props['LoadState'] in ('loaded','not-found')
        if not group.startswith('/') or '..' in Path(group).parts or Path(group).name!=name:return False
        path=Path('/sys/fs/cgroup')/group.lstrip('/')
        try:events=path.joinpath('cgroup.events').read_text()
        except FileNotFoundError:return not path.exists()
        fields=dict(line.split() for line in events.splitlines())
        return fields.get('populated')=='0'
    except (OSError,ValueError,subprocess.SubprocessError):return False

def scheduler_terminal_confirmed(data):
    """A cancel receipt is not evidence that its attempt/leases have drained.

    Native GPUQ finalizes an attempt and releases its leases atomically. All
    jobs, including jobs without datasets and intentionally shared GPUs, use
    that same proof before the Portal may retire their card reservation.
    """
    if not isinstance(data,dict):return False
    native=data.get('job');attempts=data.get('attempts');leases=data.get('leases');reservations=data.get('scale_up_reservations')
    if not isinstance(native,dict) or native.get('state') not in ('SUCCEEDED','FAILED','CANCELED'):return False
    if native.get('active_attempt_id') not in (None,'') or data.get('active_attempt_id') not in (None,''):return False
    if not isinstance(attempts,list) or not isinstance(leases,list) or leases or not isinstance(reservations,list) or reservations:return False
    return all(isinstance(a,dict) and a.get('state') in ('EXITED_SUCCESS','EXITED_FAILURE','CANCELED','PREEMPTED') for a in attempts)

def release_datasets(job,data=None,never_dispatched=False):
    """Caller owns job flock and fresh no-dispatch or native terminal proof.

    A prepared HELD lease precedes the scheduler .datasets receipt. Absence of
    that receipt is not evidence of no hold. Private journal finalization also
    fences retries after the legacy receipt has already been removed.
    """
    if not dataset_refs(job):return True
    filename=ROOT/'jobs'/(job['id']+'.datasets.json')
    if not never_dispatched:
        if not scheduler_terminal_confirmed(data):return False
        if not all(dataset_unit_stopped(attempt) for attempt in data['attempts']):return False
    if os.path.lexists(filename):
        module,cache=dataset_cache();leases=json.loads(filename.read_text());actor=module.Principal('scheduler',True)
        for lease in leases:cache.release_lease(actor,lease['dataset'],lease['version'],lease['leaseId'])
    if os.path.lexists(ROOT/'storage-leases'/'training'/job['id']):
        storage_leases().finalize_training(job)
    filename.unlink(missing_ok=True);return True

def run(argv,timeout=18):
    p=subprocess.run(argv,env=ENV,text=True,capture_output=True,timeout=timeout)
    if p.returncode:raise ValueError((p.stderr or p.stdout or 'GPUQ failed')[-400:])
    if len(p.stdout)>2000000:raise ValueError('GPUQ response too large')
    return p.stdout

def gpu(*args):return json.loads(run([CONFIG['gpu'],'--json',*args]))

def gpuq_owner(job):
    # GPUQ labels are ASCII, but portal identity and ownership use immutable IDs.
    return job['username'] if re.fullmatch(r'[a-z][a-z0-9_-]{1,23}',job['username']) else 'portal-'+hashlib.sha256(job['userId'].encode()).hexdigest()[:24]

def storage_quota(user,path,**kwargs):
    spec=importlib.util.spec_from_file_location('gpuq_storage_quota',HERE/'storage-quota.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.ensure(CONFIG,user,path,**kwargs)

def storage_quota_status(user):
    spec=importlib.util.spec_from_file_location('gpuq_storage_quota',HERE/'storage-quota.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.status(CONFIG,user)

def workspace(user):
    if not isinstance(user,str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',user):raise ValueError('Invalid identity')
    path=ROOT/'users'/hashlib.sha256(user.encode()).hexdigest()[:32]
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    if 'storageQuota' in CONFIG:storage_quota(user,path)
    return path

def file_op(operation,args,root=None):
    root=workspace(args['userId']) if root is None else root
    path=args.get('path','.')
    if not isinstance(path,str) or len(path)>1024 or '\0' in path or path.startswith('/') or '\\' in path:raise ValueError('Invalid relative path')
    parts=path.split('/') if path!='.' else []
    if any(p in ('','.','..') or len(p)>255 for p in parts):raise ValueError('Invalid relative path')
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    fd=os.open(root,flags)
    try:
        if operation=='files.put':
            data=base64.b64decode(args.get('data',''),validate=True)
            if len(data)>1024*1024:raise ValueError('Chunk too large')
            workspace_storage_check(len(data),target_fd=fd)
        directories=parts if operation=='files.list' else parts[:-1]
        for part in directories:
            if operation=='files.put':
                try:os.mkdir(part,mode=0o700,dir_fd=fd)
                except FileExistsError:pass
            nxt=os.open(part,flags,dir_fd=fd);os.close(fd);fd=nxt
        if operation=='files.list':
            out=[]
            for name in sorted(os.listdir(fd))[:1000]:
                st=os.stat(name,dir_fd=fd,follow_symlinks=False)
                out.append({'name':name,'size':st.st_size,'type':'directory' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'unsupported'})
            return {'entries':out}
        if not parts:raise ValueError('File path required')
        offset=args.get('offset',0)
        if type(offset)!=int or not 0<=offset<=100*1024**3:raise ValueError('Invalid offset')
        f=os.open(parts[-1],(os.O_RDWR|os.O_CREAT if operation=='files.put' else os.O_RDONLY)|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=fd)
        try:
            st=os.fstat(f)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1:raise ValueError('Only unlinked regular files allowed')
            fcntl.flock(f,(fcntl.LOCK_EX if operation=='files.put' else fcntl.LOCK_SH)|fcntl.LOCK_NB)
            if operation=='files.put':
                workspace_storage_check(len(data),target_fd=fd)
                if args.get('truncate') is True:
                    if offset!=0:raise ValueError('Invalid truncate offset')
                    os.ftruncate(f,0);st=os.fstat(f)
                if offset!=st.st_size:raise ValueError('Upload offset mismatch; restart this file')
                if st.st_size+len(data)>100*1024**3:raise ValueError('File too large')
                os.lseek(f,offset,0)
                view=memoryview(data)
                while view:view=view[os.write(f,view):]
                os.fsync(f)
                return {'path':path,'size':os.fstat(f).st_size}
            os.lseek(f,offset,0);data=os.read(f,1024*1024)
            return {'path':path,'size':st.st_size,'offset':offset,'data':base64.b64encode(data).decode(),'eof':offset+len(data)>=st.st_size}
        finally:os.close(f)
    finally:os.close(fd)

def validate_job(job,readonly=False):
    required={'id','userId','username','cards','argv','name','minVramGiB'}
    if not isinstance(job,dict) or not required<=set(job) or set(job)-required-{'datasets','project','release','priority','preemptIdleOnly','scheduling','elastic','placement'}:raise ValueError('Invalid job specification')
    if not UUID.fullmatch(job['id']):raise ValueError('Invalid job ID')
    if readonly:
        if not isinstance(job['userId'],str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',job['userId']):raise ValueError('Invalid identity')
    else:workspace(job['userId'])
    if not re.fullmatch(r'[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}',job['username']):raise ValueError('Invalid username')
    if type(job['cards'])!=int or not 1<=job['cards']<=CONFIG.get('cards',64):raise ValueError('Invalid card count')
    if not isinstance(job['argv'],list) or not 1<=len(job['argv'])<=128 or any(not isinstance(a,str) or '\0' in a for a in job['argv']) or len(json.dumps(job['argv']))>12000:raise ValueError('Invalid argv')
    dataset_refs(job)
    policy=SCHEDULING.normalize_job_policy(job)
    SCHEDULING.elastic_allocation(job)
    SCHEDULING.gpu_placement(job)
    if 'project' in job or 'release' in job:
        if not isinstance(job.get('project'),str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,47}',job['project']) or not isinstance(job.get('release'),str) or not DATASET_VERSION.fullmatch(job['release']):raise ValueError('Invalid project release')
    return policy

def terminal_pointer(args):
    suffix='host' if args.get('hostAdmin') is True else 'private'
    if type(args.get('dataWorkspace',False)) is not bool:raise ValueError('Invalid personal data terminal scope')
    if args.get('dataWorkspace'):
        if args.get('hostAdmin') is True or args.get('project'):raise ValueError('Data terminal cannot be a project or host root terminal')
        suffix+=':data-workspace'
    if args.get('project'):
        if args.get('hostAdmin') is True:raise ValueError('Project terminal cannot be host root')
        projects().identity(args)
        suffix+=':project:'+args['project']
    identity=hashlib.sha256((args['userId']+suffix).encode()).hexdigest()[:20]
    return ROOT/'terminals'/(identity+'.current')

def terminal_pointers(args):
    """Legacy and every independent session fence for this exact context."""
    legacy=terminal_pointer(args)
    result=[legacy] if legacy.exists() else []
    for path in sorted(legacy.parent.glob(legacy.stem+'.*.current')):
        if not UUID.fullmatch(path.name[len(legacy.stem)+1:-8]):raise ValueError('Invalid terminal session pointer')
        result.append(path)
    return result

def terminal_metadata(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>16384:raise ValueError('Invalid terminal metadata')
        with os.fdopen(fd,'r',closefd=False) as stream:return json.load(stream)
    finally:os.close(fd)

def terminal_owned(args,jid):
    try:spec=terminal_metadata(ROOT/'terminals'/(jid+'.json'))
    except FileNotFoundError:raise ValueError('Terminal not found or not owned') from None
    if (spec.get('userId')!=args['userId'] or spec.get('project')!=args.get('project') or
            (spec.get('hostAdmin') is True)!=(args.get('hostAdmin') is True) or
            (spec.get('dataWorkspace') is True)!=(args.get('dataWorkspace') is True)):
        raise ValueError('Terminal not found or not owned')
    return spec

def terminal_alive(folder,jid):
    if not isinstance(jid,str) or not UUID.fullmatch(jid):return False
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(2);client.connect(str(folder/(jid+'.sock')));client.sendall(b'{"offset":2147483647}\n');raw=b''
            while b'\n' not in raw:
                part=client.recv(65536)
                if not part or len(raw)>1000000:return False
                raw+=part
            result=json.loads(raw)
            return not result.get('error') and result.get('exited') is False
    except (OSError,ValueError):return False

def stop_terminal(jid):
    # Stable unit protocol shared with existing terminal pointers; not branding.
    unit='amax-term-'+jid+'.service'
    result=subprocess.run(['/usr/bin/systemctl','--user','stop',unit],env=ENV,text=True,capture_output=True,timeout=12)
    if result.returncode:
        active=subprocess.run(['/usr/bin/systemctl','--user','is-active','--quiet',unit],env=ENV,timeout=5)
        if active.returncode==0:raise ValueError('Terminal could not be stopped')

def terminal_op(operation,args):
    if args.get('hostAdmin') is True and not CONFIG.get('hostRoot',False):raise ValueError('Host root terminal is disabled on this node')
    workspace(args['userId'])
    if not re.fullmatch(r'[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}',args['username']):raise ValueError('Invalid username')
    folder=ROOT/'terminals';folder.mkdir(mode=0o700,exist_ok=True)
    legacy=terminal_pointer(args)
    client_id=args.get('clientId')
    if not isinstance(client_id,str) or not UUID.fullmatch(client_id):
        raise ValueError('Terminal client upgrade required: use independent sessions and a writer lease')
    opening=operation=='terminal.open';mode=args.get('mode','new')
    if opening and mode not in ('new','reconnect'):raise ValueError('Choose terminal mode new or reconnect')
    if opening and (not isinstance(args.get('key'),str) or not UUID.fullmatch(args['key'])):raise ValueError('Invalid terminal attachment key')
    if type(args.get('takeover',False)) is not bool or (args.get('takeover') and (not opening or mode!='reconnect')):
        raise ValueError('Takeover requires an explicit reconnect')
    jid=args.get('key') if opening and mode=='new' else args.get('id')
    if not isinstance(jid,str) or not UUID.fullmatch(jid):raise ValueError('Invalid terminal ID')
    pointer=folder/(legacy.stem+'.'+jid+'.current')
    receipt_path=folder/(jid+'.session.json')
    with open(folder/(jid+'.lock'),'a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        now=time.time()
        receipt=terminal_metadata(receipt_path) if receipt_path.exists() else None
        if opening:
            if mode=='new' and not (folder/(jid+'.json')).exists():
                if args.get('hostAdmin') is not True:workspace_storage_check(admission=True)
                unit='amax-term-'+jid
                spec={'userId':args['userId'],'username':args['username'],'cards':0,'argv':['/bin/bash','--noprofile','--norc','-i'],'hostAdmin':args.get('hostAdmin') is True}
                if args.get('project'):spec['project']=args['project']
                if args.get('dataWorkspace') is True:spec['dataWorkspace']=True
                with open(folder/(jid+'.json'),'x') as f:json.dump(spec,f);f.flush();os.fsync(f.fileno())
                receipt={'schema':2,'originClient':client_id,'clientId':client_id,'attachKey':args['key'],'writerToken':str(uuid.uuid4()),'leaseExpiresAt':now+30,'state':'OPEN'}
                atomic_json(receipt_path,receipt)
                with open(pointer,'x') as f:f.write(jid);f.flush();os.fsync(f.fileno())
                directory=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(directory)
                finally:os.close(directory)
                command=['/usr/bin/systemd-run','--user','--collect','--unit',unit,'--property=RuntimeMaxSec=21600','--property=KillMode=control-group','--property=TimeoutStopSec=5']
                if not spec['hostAdmin']:command+=['--property=MemoryMax=8G','--property=CPUQuota=200%','--property=TasksMax=2048']
                run(command+['/usr/bin/python3',str(HERE/'terminal-helper.py'),jid])
                for _ in range(30):
                    if (folder/(jid+'.sock')).exists():break
                    time.sleep(0.1)
            else:
                terminal_owned(args,jid)
                if receipt and receipt.get('state')=='CLOSED':raise ValueError('Terminal has ended; create a new session')
                if not terminal_alive(folder,jid):raise ValueError('Terminal is not reachable; no replacement was started and no existing session was stopped')
                if mode=='new':
                    # Same-key retry only belongs to its original client. Never
                    # turn an unrelated open into an implicit reconnect/takeover.
                    if not receipt or receipt.get('originClient')!=client_id or receipt.get('clientId')!=client_id:
                        raise ValueError('Terminal key already exists; use a new key or explicit reconnect')
                    if receipt.get('state')!='OPEN' or receipt.get('leaseExpiresAt',0)<=now:
                        raise ValueError('Terminal attachment expired or detached; reconnect explicitly')
                elif receipt and receipt.get('clientId')==client_id and receipt.get('attachKey')==args.get('key') and receipt.get('state')=='OPEN' and receipt.get('leaseExpiresAt',0)>now:
                    # Retrying the exact attachment after a lost reply must not
                    # rotate its token again or grant a different client access.
                    receipt['leaseExpiresAt']=now+30;atomic_json(receipt_path,receipt)
                    return {'id':jid,'hostAdmin':args.get('hostAdmin') is True,'clientId':client_id,
                            'writerToken':receipt['writerToken'],'leaseExpiresAt':receipt['leaseExpiresAt'],'mode':mode}
                elif receipt is None:
                    if not args.get('takeover'):raise ValueError('Legacy terminal requires explicit takeover; upgrade all clients before reconnecting')
                    receipt={'schema':2,'originClient':None,'state':'OPEN'}
                elif receipt.get('leaseExpiresAt',0)>now and not args.get('takeover'):
                    if receipt.get('clientId')!=client_id or receipt.get('writerToken')!=args.get('writerToken'):
                        raise ValueError('Terminal has another active writer; detach it, wait for lease expiry, or explicitly take over')
                # Reconnect rotates the fencing token even for the same client.
                # A delayed close/exchange from the previous attachment is stale.
                if mode=='reconnect':receipt.update(clientId=client_id,attachKey=args.get('key'),writerToken=str(uuid.uuid4()),state='OPEN')
                receipt['leaseExpiresAt']=now+30
                atomic_json(receipt_path,receipt)
            return {'id':jid,'hostAdmin':args.get('hostAdmin') is True,'clientId':client_id,
                    'writerToken':receipt['writerToken'],'leaseExpiresAt':receipt['leaseExpiresAt'],'mode':mode}
        terminal_owned(args,jid)
        if (not receipt or receipt.get('clientId')!=client_id or receipt.get('writerToken')!=args.get('writerToken')
                or receipt.get('leaseExpiresAt',0)<=now or receipt.get('state')!='OPEN'):
            raise ValueError('Terminal writer lease expired or was taken over; reconnect explicitly (old clients must upgrade)')
        if operation=='terminal.detach':
            receipt.update(leaseExpiresAt=0,state='DETACHED');atomic_json(receipt_path,receipt)
            return {'detached':True,'id':jid}
        if operation=='terminal.close':
            stop_terminal(jid)
            if args.get('project') and not projects().terminal_stopped(jid):raise ValueError('Cannot confirm project terminal termination; retry when node services recover')
            if args.get('dataWorkspace') and not data_workspaces().unit_stopped('amax-term-'+jid+'.service'):raise ValueError('Cannot confirm data terminal termination; retry when node services recover')
            (folder/(jid+'.sock')).unlink(missing_ok=True);pointer.unlink(missing_ok=True)
            if legacy.exists() and legacy.read_text()==jid:legacy.unlink()
            receipt.update(leaseExpiresAt=0,state='CLOSED');atomic_json(receipt_path,receipt)
            return {'closed':True}
        if operation!='terminal.exchange':raise ValueError('Unknown terminal operation')
        if receipt['leaseExpiresAt']-now<15:
            receipt['leaseExpiresAt']=now+30;atomic_json(receipt_path,receipt)
        request={key:args[key] for key in ('input','offset','rows','cols') if key in args}
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(4);client.connect(str(folder/(jid+'.sock')));client.sendall((json.dumps(request)+'\n').encode());raw=b''
            while b'\n' not in raw:
                part=client.recv(65536)
                if not part:break
                raw+=part
                if len(raw)>1000000:raise ValueError('Terminal response too large')
            result=json.loads(raw)
            if result.get('error'):raise ValueError(result['error'])
            return result

def transfers():
    spec=importlib.util.spec_from_file_location('gpuq_transfer_jobs',HERE/'transfer-jobs.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.TransferJobs(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))


def storage_node():
    global STORAGE_NODE
    if STORAGE_NODE is None:
        spec=importlib.util.spec_from_file_location('gpuq_storage_node',HERE/'storage-node.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        configured=CONFIG.get('storageAuthorities',{})
        if not isinstance(configured,dict) or len(configured)>16:raise ValueError('Invalid configured storage authorities')
        authorities={}
        if configured:
            paths,_=dataset_cache();paths._mkdir(ROOT/'storage-grants')
        for key,value in configured.items():
            if (not isinstance(key,str) or not DATASET_ID.fullmatch(key) or not isinstance(value,dict)
                    or set(value)!={'machine'} or value['machine']==CONFIG.get('machine')
                    or value['machine'] not in CONFIG.get('transferPeers',{})):
                raise ValueError('Storage authority needs a fixed, different, pinned LAN peer')
            authorities[key]=storage_authority_module().RemoteAuthority(value['machine'],CONFIG['transferPeers'][value['machine']],ROOT/'storage-grants'/key,target_machine=CONFIG['machine'])
        STORAGE_NODE=module.StorageNode.from_executor(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),authorities=authorities)
    return STORAGE_NODE


def storage_authority_module():
    global STORAGE_AUTHORITY_MODULE
    if STORAGE_AUTHORITY_MODULE is None:
        spec=importlib.util.spec_from_file_location('gpuq_storage_authority',HERE/'storage-authority.py')
        STORAGE_AUTHORITY_MODULE=importlib.util.module_from_spec(spec);sys.modules[spec.name]=STORAGE_AUTHORITY_MODULE;spec.loader.exec_module(STORAGE_AUTHORITY_MODULE)
    return STORAGE_AUTHORITY_MODULE


def storage_authority():
    global STORAGE_AUTHORITY
    config=CONFIG.get('storageAuthority',{'enabled':False})
    if not isinstance(config,dict) or set(config)!={'enabled'} or type(config['enabled']) is not bool:raise ValueError('Invalid protected authority configuration')
    if not config['enabled']:return None
    if STORAGE_AUTHORITY is None:
        module,cache=dataset_cache()
        STORAGE_AUTHORITY=storage_authority_module().AuthorityStore(cache,CONFIG['machine'],ROOT/'storage-authority',principal=module.Principal('builtin-admin',True))
    return STORAGE_AUTHORITY


def storage_archive():
    global STORAGE_ARCHIVE
    if STORAGE_ARCHIVE is None:
        spec=importlib.util.spec_from_file_location('gpuq_storage_archive',HERE/'storage-archive.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        STORAGE_ARCHIVE=module.StorageArchive.from_executor(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return STORAGE_ARCHIVE


def storage_leases():
    global STORAGE_LEASES
    if STORAGE_LEASES is None:
        spec=importlib.util.spec_from_file_location('gpuq_storage_leases',HERE/'storage-leases.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        STORAGE_LEASES=module.StorageLeases(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return STORAGE_LEASES


def storage_lease_operation(operation,args):
    if operation.startswith('storage.download.'):
        action=operation.rsplit('.',1)[1]
        if action=='open':return storage_leases().download_open(args)
        if action=='finish':return storage_leases().download_finish(args)
        if action in ('info','manifest','get'):return storage_leases().download_export('datasets.snapshot.'+action,args)
        raise ValueError('Unknown protected download operation')
    if operation not in ('storage.lease.prepare','storage.lease.cancel') or not isinstance(args,dict) or set(args)!={'job'}:
        raise ValueError('Invalid data preparation lease request')
    job=args['job'];validate_job(job,readonly=True);jid=job['id']
    (ROOT/'jobs').mkdir(parents=True,exist_ok=True,mode=0o700)
    with open(ROOT/'jobs'/f'{jid}.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
            row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(jid,)).fetchone()
        spec=ROOT/'jobs'/f'{jid}.json'
        if spec.exists() and json.loads(spec.read_text())!=job:raise ValueError('Job identity mismatch')
        canceled=ROOT/'jobs'/f'{jid}.canceled'
        if operation=='storage.lease.cancel':
            if row:
                # Cleanup request is NOT permission to cancel an actual job.
                # Only its native terminal evidence and stopped units suffice.
                if not release_datasets(job,gpu('show',row[0])):
                    raise ValueError('Training termination is unconfirmed; prepared leases retained')
            else:
                if os.path.lexists(ROOT/'jobs'/f'{jid}.dataset-dispatch-attempted'):
                    raise ValueError('Training dispatch is unknown; prepared leases retained')
                canceled.touch(mode=0o600,exist_ok=True)
                if os.path.lexists(ROOT/'storage-leases'/'training'/jid) or os.path.lexists(ROOT/'jobs'/f'{jid}.datasets.json'):
                    release_datasets(job,never_dispatched=True)
                else:
                    storage_leases().cancel_prepare(job)
            return {'jobId':jid,'state':'CANCELED','released':True}
        if row or os.path.lexists(ROOT/'jobs'/f'{jid}.dataset-dispatch-attempted'):
            raise ValueError('Training may already be submitted; preparation cannot change its leases')
        if canceled.exists() or os.path.lexists(ROOT/'jobs'/f'{jid}.dataset-not-submitted.json'):
            raise ValueError('Preparation is permanently canceled or rejected')
        if CONFIG.get('storageArchive',{}).get('enabled') is not True:
            raise ValueError('Managed data preparation is not enabled')
        value=storage_leases().prepare(job)
        return {'jobId':jid,'state':value['state']}


def storage_archive_operation(operation,args):
    # Private trusted bridge only. No matching operation is present in the
    # public execution API, CLI, upload ticket or node peer allowlist.
    methods={'storage.archive.events':'outbox_list','storage.archive.ack':'outbox_ack',
             'storage.archive.original':'original','storage.archive.provision':'provision',
             'storage.archive.certify':'certify'}
    if operation not in methods:raise ValueError('Unknown internal archive operation')
    return getattr(storage_archive(),methods[operation])(args)


def storage_management(operation,args):
    # This is a control-plane route, not the LAN peer or a user supplied role.
    allowed=('datasets.storage.status','datasets.storage.plan','datasets.storage.pin','datasets.storage.unpin')
    if operation not in allowed or not isinstance(args,dict) or args.get('hostAdmin') is not True:
        raise ValueError('Administrator storage operation required')
    module,_=dataset_cache();actor=dataset_actor(module,args)
    request={k:v for k,v in args.items() if k not in ('userId','hostAdmin')}
    if 'op' in request:raise ValueError('Storage operation cannot be overridden')
    return storage_node().dispatch(actor,{'op':operation.rsplit('.',1)[1],**request})


def storage_collect():
    """Local service entry, deliberately absent from the RPC/peer allowlists."""
    storage=storage_node()
    if not storage.tier.enabled:
        return {'enabled':False,'state':'DISABLED','evicted':[]}
    module,_=dataset_cache()
    try:
        return storage.tier.collect(module.Principal('builtin-admin',True),dry_run=False,max_versions=16)
    except module.CacheBusy:
        # Foreground uploads/leases win. The existing timer retries after its
        # normal interval; do not spin or weaken the metadata lock. Contention
        # may occur during the final inventory after some safe evictions, so
        # deliberately do not claim an empty eviction list or zero side effects.
        return {'enabled':True,'state':'DEFERRED','reason':'CACHE_BUSY',
                'recheck':'NEXT_SCHEDULED_RUN','evictionOutcome':'CHECK_STATUS'}


def process(operation,args):
    platform_root_check()
    if operation=='projects.quota':
        if not isinstance(args,dict) or set(args)!={'userId'}:raise ValueError('Invalid quota status fields')
        return storage_quota_status(args['userId'])
    if operation.startswith(('storage.lease.','storage.download.')):return storage_lease_operation(operation,args)
    if operation.startswith('storage.archive.'):return storage_archive_operation(operation,args)
    if operation.startswith('datasets.storage.'):return storage_management(operation,args)
    if operation.startswith('transfers.'):return transfers().process(operation,args)
    if operation in ('diagnostics','watch'):
        if not isinstance(args,dict) or set(args)!={'job'}:raise ValueError('Invalid diagnostic operation fields')
        job=args['job'];validate_job(job,readonly=True)
        spec=ROOT/'jobs'/(job['id']+'.json')
        if spec.exists() and json.loads(spec.read_text())!=job:raise ValueError('Job identity mismatch')
        with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
            row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(job['id'],)).fetchone()
        if row and not spec.exists():raise ValueError('Job identity is unavailable')
        data=gpu('show',row[0]) if row else {'job':{'state':'NOT_SUBMITTED'},'attempts':[]}
        if operation=='diagnostics':return job_diagnostics(job,data)
        state=data.get('job',data);attempts=data.get('attempts',[])
        assigned=attempts[0].get('gpu_indices',[]) if attempts and state.get('state') not in ('SUCCEEDED','FAILED','CANCELED','LOST') else []
        if row and state.get('state') in ('SUCCEEDED','FAILED','CANCELED') and not scheduler_terminal_confirmed(data):
            return {'nodeJobId':row[0],'state':'UNKNOWN','assignedIndices':attempts[0].get('gpu_indices',[]) if attempts else [],
                    **scheduling_status(job,data),'error':'Job termination is not fully confirmed; card reservation retained'}
        if row and state.get('state') in ('SUCCEEDED','FAILED','CANCELED') and dataset_refs(job) and (ROOT/'jobs'/(job['id']+'.datasets.json')).exists():
            # The periodic lifecycle reconciliation must confirm process
            # cleanup and release leases. A viewer cannot release them.
            return {'nodeJobId':row[0],'state':'UNKNOWN','assignedIndices':[],
                    'error':'Dataset lease cleanup awaits scheduler reconciliation',**scheduling_status(job,data)}
        return {'nodeJobId':row[0] if row else None,'state':state['state'] if row else 'PENDING',
                'assignedIndices':assigned,**scheduling_status(job,data)}
    if operation in ('host.exec','host.status','host.cancel'):return host_command(operation,args)
    if operation.startswith(('projects.snapshot.','projects.sync.','datasets.snapshot.')):
        spec=importlib.util.spec_from_file_location('gpuq_snapshot_sync',HERE/'snapshot-sync.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        return module.SnapshotSync(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals())).process(operation,args)
    if operation.startswith('projects.'):return projects().process(operation,args)
    if operation.startswith('datasets.upload.'):return dataset_uploads().process(operation,args)
    if operation.startswith('datasets.workspace.'):return data_workspaces().process(operation,args)
    if operation.startswith('datasets.import.'):return data_imports().process(operation,args)
    if operation.startswith('datasets.cloud.'):return cloud_files().process(operation,args)
    if operation in ('datasets.capacity','datasets.list','datasets.status','datasets.prepare','datasets.register','datasets.unregister'):return dataset_op(operation,args)
    if operation in ('terminal.open','terminal.exchange','terminal.close','terminal.detach'):
        if args.get('dataWorkspace') is True and operation=='terminal.open':
            ops=data_workspaces()
            with ops.guard(args):
                ops.writable(args)
                return terminal_op(operation,args)
        if args.get('project') and operation=='terminal.open':
            ops=projects()
            with ops.guard(args):
                ops.writable(args);ops.store.dev_paths(*ops.identity(args))
                return terminal_op(operation,args)
        return terminal_op(operation,args)
    if operation.startswith('files.') and operation in ('files.list','files.put','files.get'):
        return projects().files(operation,args) if args.get('project') else file_op(operation,args)
    if operation not in ('sync','cancel','logs','priority'):raise ValueError('Unknown operation')
    if not isinstance(args,dict) or set(args)-({'job','priority','expected','rankOnly','metadata'} if operation=='priority' else {'job','metadata'}):raise ValueError('Invalid job operation fields')
    job=args['job'];policy=validate_job(job);jid=job['id']
    display=None;presentation={'state':'LEGACY'}
    # Cached capabilities can outlive a helper upgrade/downgrade. Presentation
    # must not gate execution reconciliation, and control/logs never spend their
    # request budget on an optional display RPC before the requested operation.
    if 'metadata' in args and operation=='sync':
        try:
            definition=importlib.util.spec_from_file_location('gpuq_console_task_display',HERE/'task-display.py')
            display=importlib.util.module_from_spec(definition);definition.loader.exec_module(display)
        except Exception:
            display=None
            presentation={'state':'UNAVAILABLE','error':'Native task display unavailable; execution identity unchanged'}
        else:
            # Keep the strict submit/sync envelope contract: a forged display
            # actor is rejected before spec persistence or native submission.
            display.validate(job,args['metadata'])
    (ROOT/'jobs').mkdir(parents=True,exist_ok=True,mode=0o700)
    with open(ROOT/'jobs'/f'{jid}.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        spec=ROOT/'jobs'/f'{jid}.json'
        if spec.exists():
            if json.loads(spec.read_text())!=job:raise ValueError('Job identity mismatch')
        else:
            with open(spec,'x') as f:json.dump(job,f);f.flush();os.fsync(f.fileno())
        # GPUQ is the source of truth for dispatch idempotency, including SSH failures.
        with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
            row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(jid,)).fetchone()
        canceled=ROOT/'jobs'/f'{jid}.canceled'
        attempted=ROOT/'jobs'/f'{jid}.dataset-dispatch-attempted'
        rejected=ROOT/'jobs'/f'{jid}.dataset-not-submitted.json'
        if not row:
            if operation=='priority':raise ValueError('Job is not yet registered with the scheduler; no priority was changed')
            if dataset_refs(job) and os.path.lexists(attempted):
                if operation=='cancel':canceled.touch(mode=0o600,exist_ok=True)
                result={'state':'UNKNOWN','error':'Submission may still be pending; dataset leases and card reservation retained'}
                return job_log_result(job,{'job':{'state':'UNKNOWN'},'attempts':[]},result['error']) if operation=='logs' else result
            if dataset_refs(job) and os.path.lexists(rejected):
                result=reject_unsubmitted_datasets(job,rejected)
                return job_log_result(job,{'job':{'state':'NOT_SUBMITTED'},'attempts':[]},result['error']) if operation=='logs' else result
            if operation=='cancel' or canceled.exists():
                canceled.touch(mode=0o600,exist_ok=True)
                release_datasets(job,never_dispatched=True)
                return {'state':'CANCELED'}
            if operation=='logs':return job_log_result(job,{'job':{'state':'NOT_SUBMITTED'},'attempts':[]},'任务尚未提交到 GPUQ。')
            workspace_storage_check(admission=True)
            if policy['kind']!='legacy':priority_capability()
            if policy['preempt_opt_in_only'] and 'preempt-opt-in-only-v1' not in gpu('status').get('daemon',{}).get('capabilities',[]):raise ValueError('Requester opt-in scope capability unavailable')
            if policy['kind']=='explicit' and not SCHEDULING.ready(CONFIG,HERE):raise ValueError('Training control channel is not ready; no submission attempted')
            if 'elastic' in job:
                if not SCHEDULING.allocation_ready(CONFIG,HERE) or 'elastic-batch-v1' not in gpu('status').get('daemon',{}).get('capabilities',[]):raise ValueError('Elastic scheduler/control channel is not ready; no submission attempted')
            if 'placement' in job:
                placement=job['placement'];caps=gpu('status').get('daemon',{}).get('capabilities',[])
                if not SCHEDULING.allocation_ready(CONFIG,HERE,2) or 'gpu-placement-v1' not in caps or placement['shared'] and 'gpu-sharing-v1' not in caps:raise ValueError('GPU placement/sharing channel is not ready; no submission attempted')
                if placement.get('hami') and not SCHEDULING.hami_ready(CONFIG,HERE,placement['smPercent']):raise ValueError('HAMi runtime is not ready; no submission attempted')
            if job.get('project'):
                projects().store.release(job['userId'],job['project'],job['release'])
                projects().store.run_paths(job['userId'],job['project'],job['release'],jid)
            if dataset_refs(job):
                try:acquire_datasets(job)
                except DatasetNotReady:
                    # The job lock serializes our submit/cancel calls. Re-read
                    # native evidence before issuing a terminal, quota-freeing
                    # result; any ambiguity remains nonterminal.
                    with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
                        native=db.execute('SELECT id FROM jobs WHERE submit_key=?',(jid,)).fetchone()
                    if native or os.path.lexists(attempted):
                        return {'state':'UNKNOWN','error':'Submission outcome is unconfirmed; dataset leases and card reservation retained'}
                    return reject_unsubmitted_datasets(job,rejected)
                # A timed-out submit must not allow cancellation to release a
                # lease while the scheduler may still accept the request.
                atomic_json(attempted,{'jobId':jid})
            scheduling=SCHEDULING.submit_arguments(policy)
            result=gpu('submit',*SCHEDULING.allocation_arguments(job),*scheduling,'-n','portal-'+jid[:8],'-u',gpuq_owner(job),'--cwd',str(workspace(job['userId'])),'--submit-key',jid,'--','/usr/bin/python3',str(HERE/'sandbox-runner.py'),jid)
            node_id=result['job_id']
        else:node_id=row[0]
        data=gpu('show',node_id);state=data.get('job',data)
        if display is not None:
            try:presentation=display.sync(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),job,args['metadata'],state)
            except Exception:
                presentation={'state':'UNAVAILABLE','error':'Native task display update unconfirmed; training state unchanged'}
        # Presentation failures must never block cancel or change job lifecycle.
        if operation=='priority':
            expected=args.get('expected');priority=args.get('priority')
            if args.get('rankOnly') is not True:raise ValueError('Rank-only priority update required; upgrade the portal before editing priorities')
            if not isinstance(priority,str) or priority not in PRIORITY_RANKS or not isinstance(expected,dict) or set(expected)!={'priority','yield_policy','restart_policy','dispatch_mode'}:raise ValueError('Invalid expected priority policy')
            if not scheduling_status(job,data)['priorityMutable']:raise ValueError('Only pending safe-policy Console jobs can change priority')
            if expected!={k:state.get(k) for k in expected}:raise ValueError('Priority changed; refresh before retrying')
            priority_capability(rank_only=True)
            gpu('set-rank',node_id,'P'+str(PRIORITY_RANKS[priority]),'--expected-priority','P'+str(expected['priority']),
                '--expected-yield',expected['yield_policy'],'--expected-restart-policy',expected['restart_policy'],'--expected-mode',expected['dispatch_mode'])
            data=gpu('show',node_id);state=data.get('job',data)
        if operation=='logs':
            if not data.get('attempts'):return job_log_result(job,data,'任务正在排队，尚未产生运行日志。')
            return job_log_result(job,data,run([CONFIG['gpu'],'logs','-n','200',node_id])[-200000:])
        if operation=='cancel' and state['state'] not in ('SUCCEEDED','FAILED','CANCELED'):
            gpu('cancel',node_id);data=gpu('show',node_id);state=data.get('job',data)
        attempts=data.get('attempts',[])
        assigned=attempts[0].get('gpu_indices',[]) if attempts and state['state'] not in ('SUCCEEDED','FAILED','CANCELED','LOST') else []
        if state['state'] in ('SUCCEEDED','FAILED','CANCELED') and not scheduler_terminal_confirmed(data):
            return {'nodeJobId':node_id,'state':'UNKNOWN','assignedIndices':attempts[0].get('gpu_indices',[]) if attempts else [],
                    **scheduling_status(job,data),'error':'Job termination is not fully confirmed; card reservation retained'}
        if dataset_refs(job) and state['state'] in ('SUCCEEDED','FAILED','CANCELED') and not release_datasets(job,data):
            return {'nodeJobId':node_id,'state':'UNKNOWN','assignedIndices':assigned,'error':'Job termination is not fully confirmed; dataset leases retained'}
        return {'nodeJobId':node_id,'state':state['state'],'assignedIndices':assigned,**scheduling_status(job,data),
                **({'displaySync':presentation} if 'metadata' in args else {})}

if __name__=='__main__':
    os.umask(0o077)
    platform_root_check()
    if len(sys.argv)==3 and sys.argv[1]=='--storage-archive-worker':sys.exit(storage_archive().worker(sys.argv[2]))
    if len(sys.argv)==2 and sys.argv[1]=='--storage-collect':
        print(json.dumps(storage_collect()));sys.exit(0)
    if len(sys.argv)==4 and sys.argv[1]=='--transfer-worker':sys.exit(transfers().worker(sys.argv[2],int(sys.argv[3])))
    if len(sys.argv)==2 and sys.argv[1]=='--transfer-peer-daemon':
        spec=importlib.util.spec_from_file_location('gpuq_transfer_peer',HERE/'transfer-peer.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        module.serve(sys.modules[__name__],transfers(),authority=storage_authority());sys.exit(0)
    if len(sys.argv)==2 and sys.argv[1]=='--direct-upload-daemon':
        spec=importlib.util.spec_from_file_location('gpuq_direct_upload',HERE/'direct-upload.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        module.serve(sys.modules[__name__],dataset_uploads());sys.exit(0)
    if len(sys.argv)==3 and sys.argv[1]=='--dataset-worker':sys.exit(dataset_worker(sys.argv[2]))
    if len(sys.argv)==5 and sys.argv[1]=='--dataset-upload-worker':sys.exit(dataset_uploads().worker(*sys.argv[2:]))
    if len(sys.argv)==4 and sys.argv[1]=='--data-workspace-worker':sys.exit(data_workspaces().worker(*sys.argv[2:]))
    if len(sys.argv)==5 and sys.argv[1]=='--data-import-worker':sys.exit(data_imports().worker(*sys.argv[2:]))
    if len(sys.argv)==5 and sys.argv[1]=='--cloud-files-worker':sys.exit(cloud_files().worker(*sys.argv[2:]))
    if len(sys.argv)==4 and sys.argv[1]=='--data-workspace-recover':
        print(json.dumps(data_workspaces().recover(*sys.argv[2:])));sys.exit(0)
    if len(sys.argv)==3 and sys.argv[1]=='--project-worker':sys.exit(projects().worker(sys.argv[2]))
    try:
        raw=sys.stdin.buffer.read(1600001)
        if len(raw)>1600000:raise ValueError('Request too large')
        data=json.loads(raw)
        result=process(data['operation'],data['args'])
        print(json.dumps({'ok':True,'result':result}))
    except Exception as e:print(json.dumps({'ok':False,'error':str(e)[:400]}))
