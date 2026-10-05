"""Internal bridge-only scoped member sync, never quota or task administration."""
import fcntl,hashlib,json,os,re,stat,uuid
from pathlib import Path
OWNER=re.compile(r'(?:builtin-admin|demo-user-[0-9]+)\Z')
def need(value,message):
    if not value:raise ValueError(message)
def identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
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
