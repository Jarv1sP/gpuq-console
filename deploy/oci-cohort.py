"""Internal bridge-only scoped member sync, never quota or task administration."""
import fcntl,hashlib,json,os,re,stat,uuid
from pathlib import Path
OWNER=re.compile(r'(?:builtin-admin|demo-user-[0-9]+)\Z')
def need(value,message):
    if not value:raise ValueError(message)
def identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)

def current_policy(config, frozen):
    """Read membership only, from an administrator-bound live config.

    Immutable runtime bundles opt in via their own node-config.json. Request
    arguments cannot select this authority. The normal cohort sync remains
    the sole writer; no runtime files or capability paths are reloaded here.
    """
    binding = config.get('personalOciCohort')
    if binding is None:
        return frozen
    need(isinstance(binding, dict) and set(binding) == {
        'schema', 'configPath', 'parentDevice', 'parentInode', 'minimumRevision'}
        and type(binding['schema']) is int and binding['schema'] == 1,
        'Invalid live OCI cohort binding')
    need(all(type(binding[key]) is int and binding[key] >= 0
             for key in ('parentDevice', 'parentInode', 'minimumRevision'))
         and binding['parentInode'] > 0 and binding['minimumRevision'] <= 9007199254740991,
         'Invalid live OCI cohort identity')
    need(frozen.get('enabled') is True and frozen.get('autoOwners') is True
         and 'owners' in frozen, 'Live OCI cohort requires scoped automatic membership')
    raw_path = binding['configPath']
    need(isinstance(raw_path, str) and '\x00' not in raw_path,
         'Invalid live OCI configuration path')
    path = Path(raw_path)
    need(path.is_absolute() and '..' not in path.parts and path.name == 'node-config.json'
         and str(path) == raw_path, 'Invalid live OCI configuration path')
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        directory = os.fstat(parent)
        need(directory.st_uid == os.geteuid() and not directory.st_mode & 0o022
             and (directory.st_dev, directory.st_ino) == (binding['parentDevice'], binding['parentInode']),
             'Live OCI configuration parent changed')
        # No mkdir, touch, polling or repair in an admission read. A missing or
        # busy authority is unconfirmed, never permission from the frozen copy.
        lock = os.open('.oci-cohort.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        locked = os.fstat(lock)
        need(stat.S_ISREG(locked.st_mode) and locked.st_uid == os.geteuid()
             and stat.S_IMODE(locked.st_mode) == 0o600 and locked.st_nlink == 1,
             'Unsafe live OCI cohort lock')
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid()
                 and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600
                 and 0 < before.st_size <= 2 * 1024**2, 'Unsafe live OCI configuration')
            raw = os.read(fd, before.st_size + 1)
            need(len(raw) == before.st_size and identity(os.fstat(fd)) == identity(before)
                 and identity(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == identity(before),
                 'Live OCI configuration changed')
        finally:
            os.close(fd)
        current_directory = os.stat(path.parent, follow_symlinks=False)
        need(identity(os.stat('.oci-cohort.lock', dir_fd=parent, follow_symlinks=False)) == identity(locked)
             and (current_directory.st_dev, current_directory.st_ino) == (directory.st_dev, directory.st_ino),
             'Live OCI configuration authority changed')
        current = json.loads(raw)
        need(isinstance(current, dict) and isinstance(config.get('machine'), str)
             and current.get('machine') == config['machine']
             and isinstance(config.get('root'), str) and current.get('root') == config['root'],
             'Live OCI configuration machine/root mismatch')
        policy = current.get('personalOci')
        need(isinstance(policy, dict)
             and {k:v for k,v in policy.items() if k not in ('owners', 'autoOwnersRevision')}
             == {k:v for k,v in frozen.items() if k not in ('owners', 'autoOwnersRevision')},
             'Live OCI capability policy changed; publish a matching runtime')
        owners, revision = policy.get('owners'), policy.get('autoOwnersRevision', 0)
        need(isinstance(owners, list) and len(owners) <= 1000
             and all(isinstance(v, str) and OWNER.fullmatch(v) for v in owners)
             and owners == sorted(set(owners)), 'Invalid live OCI owner cohort')
        need(type(revision) is int and max(binding['minimumRevision'], frozen.get('autoOwnersRevision', 0))
             <= revision <= 9007199254740991, 'Stale live OCI membership revision')
        return {**frozen, 'owners': list(owners), 'autoOwnersRevision': revision}
    finally:
        if lock is not None:
            os.close(lock)
        os.close(parent)

def sync(config_path,args):
    need(isinstance(args,dict) and set(args)=={'hostAdmin','owners','revision'} and args['hostAdmin'] is True,'Internal OCI cohort authorization required')
    owners=args['owners'];revision=args['revision']
    need(isinstance(owners,list) and len(owners)<=1000 and all(isinstance(v,str) and OWNER.fullmatch(v) for v in owners) and owners==sorted(set(owners)),'Invalid derived OCI cohort')
    need(type(revision) is int and 1<=revision<=9007199254740991,'Invalid OCI cohort revision')
    path=Path(config_path);need(path.is_absolute() and '..' not in path.parts,'Invalid fixed OCI configuration')
    parent=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    lock=None;tmp=None
    try:
        directory=os.fstat(parent);need(directory.st_uid==os.getuid() and not directory.st_mode&0o022,'Unsafe OCI configuration parent')
        lock=os.open('.oci-cohort.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=parent)
        info=os.fstat(lock);need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1,'Unsafe OCI cohort lock')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        try:
            before=os.fstat(fd);need(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_nlink==1 and stat.S_IMODE(before.st_mode)==0o600 and before.st_size<=2*1024**2,'Unsafe OCI configuration')
            raw=os.read(fd,before.st_size+1);need(len(raw)==before.st_size and identity(os.fstat(fd))==identity(before),'OCI configuration changed')
        finally:os.close(fd)
        config=json.loads(raw);policy=config.get('personalOci',{})
        need(isinstance(policy,dict) and policy.get('enabled') is True and policy.get('autoOwners') is True and 'owners' in policy,'Automatic OCI cohort is not explicitly enabled in scoped mode')
        old_revision=policy.get('autoOwnersRevision',0)
        need(type(old_revision) is int and 0<=old_revision<=9007199254740991 and revision>=old_revision,'Stale OCI membership revision')
        digest=hashlib.sha256(json.dumps(owners,separators=(',',':')).encode()).hexdigest()
        if revision==old_revision:
            need(policy['owners']==owners,'OCI membership version conflict')
            return {'enabled':True,'changed':False,'revision':revision,'ownersSHA256':digest}
        # Preserve every other current key, including newly added config keys.
        candidate={**config,'personalOci':{**policy,'owners':owners,'autoOwnersRevision':revision}}
        data=(json.dumps(candidate,ensure_ascii=False,indent=2)+'\n').encode()
        tmp='.'+path.name+'.oci-cohort-'+uuid.uuid4().hex
        fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,stat.S_IMODE(before.st_mode),dir_fd=parent)
        try:
            os.fchmod(fd,stat.S_IMODE(before.st_mode));os.fchown(fd,before.st_uid,before.st_gid)
            view=memoryview(data)
            while view:
                count=os.write(fd,view);need(count>0,'Short OCI configuration write');view=view[count:]
            os.fsync(fd)
        finally:os.close(fd)
        need(identity(os.stat(path.name,dir_fd=parent,follow_symlinks=False))==identity(before),'OCI configuration changed before CAS')
        os.replace(tmp,path.name,src_dir_fd=parent,dst_dir_fd=parent);tmp=None;os.fsync(parent)
        return {'enabled':True,'changed':True,'revision':revision,'ownersSHA256':digest}
    finally:
        if tmp is not None:os.unlink(tmp,dir_fd=parent)
        if lock is not None:os.close(lock)
        os.close(parent)
