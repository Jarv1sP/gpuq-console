#!/usr/bin/env python3
"""Opt-in platform bind guard; no mkdir/chmod/mount/service writes.

The root-owned /etc/gpuq-platform-root DIRECTORY enables the guard. Other nodes
without that directory retain the legacy behavior. Once enabled, a missing pin
is an error, not a legacy fallback. Runtime entrypoints must call check(...)
before any ROOT write; long-lived request handlers repeat it per operation.
System ExecStartPre may use purpose='check-only'; runtime cannot run as root.
This is not a sandbox against host root or a replacement for root-owned 000
underlying mountpoints, mount-unit dependencies, and stopped cutover consumers.
"""
import json,os,re,socket,stat,sys
from pathlib import Path
ENABLE=Path('/etc/gpuq-platform-root')
DIR=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
class RootUnavailable(ValueError):pass
def need(ok,message):
 if not ok:raise RootUnavailable(message)
def absolute(value):
 need(isinstance(value,str) and value.startswith('/') and value!='/' and str(Path(value))==value and '..' not in Path(value).parts,'Invalid fixed platform path')
 return Path(value)
def open_directory(path):
 path=absolute(str(path));fd=os.open('/',DIR)
 try:
  for name in path.parts[1:]:
   child=os.open(name,DIR,dir_fd=fd);os.close(fd);fd=child
  return fd
 except BaseException:os.close(fd);raise
def enabled_pin():
 try:info=ENABLE.lstat()
 except FileNotFoundError:return None
 need(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'Invalid platform guard directory')
 parent=open_directory(ENABLE)
 try:
  fd=os.open('pin.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
  try:
   before=os.fstat(fd);need(stat.S_ISREG(before.st_mode) and before.st_uid==0 and before.st_nlink==1 and not before.st_mode&0o022 and before.st_size<=16384,'Unsafe platform root pin')
   data=os.read(fd,16385);after=os.fstat(fd)
   need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'Platform pin changed during read')
   pin=json.loads(data)
  finally:os.close(fd)
 finally:os.close(parent)
 return pin
def mounts():
 out=[]
 for line in Path('/proc/self/mountinfo').read_text().splitlines():
  left,right=line.split(' - ',1);a,b=left.split(),right.split()
  unescape=lambda s:re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),s)
  out.append({'target':unescape(a[4]),'root':unescape(a[3]),'device':a[2],'options':a[5].split(','),'fstype':b[0]})
 return out
def uuid_device(value):
 need(isinstance(value,str) and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',value),'Invalid filesystem UUID')
 # This is the one intentional system-maintained symlink: final target must
 # be an actual root-owned block device; never treat a regular file as one.
 info=os.stat('/dev/disk/by-uuid/'+value)
 need(stat.S_ISBLK(info.st_mode) and info.st_uid==0,'Filesystem UUID does not resolve to a block device')
 return info.st_rdev
def check(root,*,purpose='runtime'):
 need(purpose in ('runtime','check-only'),'Invalid platform guard purpose')
 pin=enabled_pin()
 if pin is None:return None
 fields={'schema','machine','root','backingMount','sourceDirectory','filesystemUuid','rootInode','uid','fstype'}
 need(isinstance(pin,dict) and set(pin)==fields and type(pin['schema']) is int and pin['schema']==1 and pin['machine']==socket.gethostname(),'Platform pin identity mismatch')
 root=absolute(str(root));backing=absolute(pin['backingMount']);source=absolute(pin['sourceDirectory'])
 need(str(root)==pin['root'] and backing in source.parents and root!=backing,'Platform root path changed')
 need(type(pin['uid']) is int and pin['uid']>0 and type(pin['rootInode']) is int and pin['rootInode']>0 and pin['fstype'] in ('ext4','xfs'),'Invalid platform root pin')
 if purpose=='runtime':need(os.geteuid()==pin['uid'],'Platform runtime must use its pinned non-root service UID')
 device=uuid_device(pin['filesystemUuid']);major_minor=str(os.major(device))+':'+str(os.minor(device))
 expected_fsroot='/'+str(source.relative_to(backing))
 def mounted():
  entries=mounts();a=[v for v in entries if v['target']==str(backing)];b=[v for v in entries if v['target']==str(root)]
  need(not any(v['target'].startswith(str(root)+'/') for v in entries),'Unapproved nested platform mount')
  need(len(a)==len(b)==1,'Required platform bind/backing mount is missing or ambiguous')
  need(a[0]['root']=='/' and b[0]['root']==expected_fsroot,'Platform bind source changed')
  for v in (a[0],b[0]):need(v['device']==major_minor and v['fstype']==pin['fstype'] and 'rw' in v['options'],'Platform mounted device is wrong or read-only')
 mounted();fd=open_directory(root)
 try:
  info=os.fstat(fd)
  need((info.st_dev,info.st_ino,info.st_uid)==(device,pin['rootInode'],pin['uid']) and not info.st_mode&0o022,'Platform directory identity or ownership changed')
  mounted();fresh=open_directory(root)
  try:need((os.fstat(fresh).st_dev,os.fstat(fresh).st_ino)==(info.st_dev,info.st_ino),'Platform root changed during admission')
  finally:os.close(fresh)
 finally:os.close(fd)
 return {'guarded':True,'root':str(root),'filesystemUuid':pin['filesystemUuid'],'rootInode':pin['rootInode'],'uid':pin['uid']}

if __name__=='__main__':
 if len(sys.argv)!=3 or sys.argv[1]!='--check':raise SystemExit('Usage: platform-root-guard.py --check ROOT')
 print(json.dumps(check(sys.argv[2],purpose='check-only')))
