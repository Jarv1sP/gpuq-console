import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('root_guard',HERE.parent/'deploy'/'platform-root-guard.py');M=importlib.util.module_from_spec(s);s.loader.exec_module(M)
READ_ENABLED_PIN=M.enabled_pin
class GuardTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name).resolve();self.root=self.base/'logical';self.root.mkdir(mode=0o700);self.disk=self.base/'disk';self.disk.mkdir(mode=0o700);self.st=self.root.stat();self.uid=os.geteuid() or 1000
  self.pin={'schema':1,'machine':'fixture','root':str(self.root),'backingMount':str(self.disk),'sourceDirectory':str(self.disk/'private'/'root'),'filesystemUuid':'4024f9b5-ccaf-4603-a747-ebfc51ca3e4b','rootInode':self.st.st_ino,'uid':self.st.st_uid,'fstype':'ext4'}
  self.entries=[{'target':str(self.disk),'root':'/','device':str(os.major(self.st.st_dev))+':'+str(os.minor(self.st.st_dev)),'options':['rw'],'fstype':'ext4'},{'target':str(self.root),'root':'/private/root','device':str(os.major(self.st.st_dev))+':'+str(os.minor(self.st.st_dev)),'options':['rw'],'fstype':'ext4'}]
  for p in (patch.object(M,'enabled_pin',side_effect=lambda:self.pin),patch.object(M,'mounts',side_effect=lambda:self.entries),patch.object(M,'uuid_device',return_value=self.st.st_dev),patch.object(M.socket,'gethostname',return_value='fixture')):p.start();self.addCleanup(p.stop)
 def tearDown(self):self.temp.cleanup()
 def reject(self):
  with self.assertRaises((M.RootUnavailable,OSError)):M.check(self.root)
 def test_good_bind_passes(self):self.assertTrue(M.check(self.root)['guarded'])
 def test_opt_out_unchanged(self):
  self.pin=None;self.assertIsNone(M.check('/nonexistent/legacy'))
 def test_missing_bind_rejects(self):self.entries.pop();self.reject()
 def test_missing_backing_rejects(self):self.entries.pop(0);self.reject()
 def test_wrong_filesystem_rejects(self):self.entries[1]['device']='1:999';self.reject()
 def test_wrong_inode_rejects(self):self.pin['rootInode']+=1;self.reject()
 def test_readonly_mount_rejects(self):self.entries[1]['options']=['ro'];self.reject()
 def test_wrong_bind_subtree_rejects(self):self.entries[1]['root']='/other';self.reject()
 def test_nested_project_mount_rejects(self):
  self.entries.append({**self.entries[1],'target':str(self.root/'projects-v2')});self.reject()
 def test_root_runtime_rejected_but_check_only_not_uid_gated(self):
  with patch.object(M.os,'geteuid',return_value=0):
   self.reject();self.assertTrue(M.check(self.root,purpose='check-only')['guarded'])
 def test_symlink_logical_root_rejects(self):
  self.root.rmdir();self.root.symlink_to(self.disk,target_is_directory=True);self.reject()
 def test_enabled_missing_pin_not_legacy(self):
  with patch.object(M,'enabled_pin',side_effect=FileNotFoundError):self.reject()
 def test_mount_ids_not_pinned_namespace_stable(self):
  self.entries[0]['namespaceMountID']=999;self.entries[1]['namespaceMountID']=1234;self.assertTrue(M.check(self.root)['guarded'])
 def test_wrong_host_unknown_fields_and_boolean_schema_reject(self):
  original=dict(self.pin)
  for change in ({'machine':'different-host'},{'schema':True},{'extra':'untrusted'},{'uid':True},{'rootInode':True}):
   with self.subTest(change=change):self.pin={**original,**change};self.reject()
 def test_root_replaced_during_admission_rejects(self):
  count=[0]
  def mounted():
   count[0]+=1
   if count[0]==2:
    self.root.rename(self.base/'previous');self.root.mkdir()
   return self.entries
  with patch.object(M,'mounts',side_effect=mounted):self.reject()
 def direct(self):
  self.root.rmdir();self.root=self.disk/'nested'/'platform';self.root.mkdir(parents=True,mode=0o700);self.st=self.root.stat()
  self.pin={key:value for key,value in self.pin.items() if key!='sourceDirectory'}
  self.pin.update(schema=2,mode='direct-directory',root=str(self.root),rootInode=self.st.st_ino)
  self.entries=self.entries[:1]
 def test_explicit_direct_directory_passes_without_a_bind(self):
  self.direct();value=M.check(self.root)
  self.assertTrue(value['guarded']);self.assertEqual(value['rootInode'],self.st.st_ino)
 def test_direct_missing_disk_cannot_fall_back_to_system_root(self):
  self.direct();self.entries=[{'target':'/','root':'/','device':'1:1','fstype':'ext4','options':['rw']}];self.reject()
 def test_direct_root_must_be_below_exact_backing(self):
  self.direct()
  for value in (str(self.root),str(self.base/'other'),str(self.disk.parent/'disk-prefix')):
   with self.subTest(backing=value):self.pin['backingMount']=value;self.reject()
 def test_direct_rejects_any_intermediate_or_exact_root_overmount(self):
  self.direct();original=list(self.entries)
  for target in (self.root.parent,self.root):
   for device in (self.entries[0]['device'],'1:999'):
    with self.subTest(target=target,device=device):
     self.entries=original+[{**original[0],'target':str(target),'device':device}];self.reject()
 def test_direct_rejects_nested_mount_but_not_prefix_sibling(self):
  self.direct();self.entries.append({**self.entries[0],'target':str(self.root)+'-sibling'})
  self.assertTrue(M.check(self.root)['guarded'])
  self.entries.append({**self.entries[0],'target':str(self.root/'projects')});self.reject()
 def test_direct_rejects_ambiguous_backing_and_wrong_filesystem_root(self):
  self.direct();self.entries.append(dict(self.entries[0]));self.reject()
  self.entries.pop();self.entries[0]['root']='/unapproved-subvolume';self.reject()
 def test_direct_rejects_wrong_device_type_or_readonly_mount(self):
  self.direct();original=dict(self.entries[0])
  for change in ({'device':'1:999'},{'fstype':'xfs'},{'options':['ro']}):
   with self.subTest(change=change):self.entries[0]={**original,**change};self.reject()
 def test_direct_rejects_wrong_root_inode_owner_and_write_permissions(self):
  self.direct();self.pin['rootInode']+=1;self.reject();self.pin['rootInode']-=1
  self.pin['uid']+=1
  with self.assertRaises(M.RootUnavailable):M.check(self.root,purpose='check-only')
  self.pin['uid']-=1
  for mode in (0o770,0o702):self.root.chmod(mode);self.reject()
 def test_direct_checks_directory_device_not_only_mountinfo(self):
  self.direct();wrong=self.st.st_dev+1;self.entries[0]['device']=str(os.major(wrong))+':'+str(os.minor(wrong))
  with patch.object(M,'uuid_device',return_value=wrong):self.reject()
 def test_direct_symlink_and_missing_root_are_not_created(self):
  self.direct();self.root.rmdir();self.reject();self.assertFalse(self.root.exists())
  self.root.symlink_to(self.disk,target_is_directory=True);self.reject()
 def test_direct_rejects_bad_mode_shape_or_implicit_schema_upgrade(self):
  self.direct();original=dict(self.pin)
  for change in ({'mode':'bind'},{'mode':None},{'schema':True},{'schema':3},{'schema':1},{'sourceDirectory':str(self.root)},{'uid':True},{'rootInode':True},{'extra':False}):
   with self.subTest(change=change):self.pin={**original,**change};self.reject()
  self.pin=dict(original);del self.pin['mode'];self.reject()
 def test_direct_mount_disappearing_during_check_is_rejected(self):
  self.direct();calls=[0]
  def changed():
   calls[0]+=1;return self.entries if calls[0]==1 else []
  with patch.object(M,'mounts',side_effect=changed):self.reject()
 def test_direct_root_mode_changing_during_admission_rejected(self):
  self.direct();calls=[0]
  def changed():
   calls[0]+=1
   if calls[0]==2:self.root.chmod(0o750)
   return self.entries
  with patch.object(M,'mounts',side_effect=changed):self.reject()
 def test_direct_namespace_mount_ids_are_not_persistent_identity(self):
  self.direct();self.entries[0]['namespaceMountID']=1000;self.assertTrue(M.check(self.root)['guarded'])
 def test_direct_root_runtime_denied_but_root_readonly_check_allowed(self):
  self.direct()
  with patch.object(M.os,'geteuid',return_value=0):
   self.reject();self.assertTrue(M.check(self.root,purpose='check-only')['guarded'])
 def test_schema1_bind_cannot_silently_become_direct_when_bind_disappears(self):
  self.entries.pop();self.reject()
  self.pin['mode']='direct-directory';self.reject()
 def test_enabled_null_or_other_malformed_pin_never_becomes_opt_out(self):
  enabled=self.base/'enabled';enabled.mkdir(mode=0o755);pin=enabled/'pin.json'
  fstat=os.fstat
  def root_owned(fd):
   value=fstat(fd)
   return SimpleNamespace(**{key:(0 if key=='st_uid' else getattr(value,key)) for key in ('st_dev','st_ino','st_mode','st_uid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')})
  info=enabled.stat();fake=SimpleNamespace(st_mode=info.st_mode,st_uid=0)
  with patch.object(M,'ENABLE',enabled),patch.object(M,'enabled_pin',READ_ENABLED_PIN),patch.object(M.Path,'lstat',return_value=fake),patch.object(M.os,'fstat',side_effect=root_owned):
   for value in (None,[],False,'legacy',{}):
    with self.subTest(pin=value):pin.write_text(json.dumps(value));pin.chmod(0o600);self.reject()
   pin.unlink();self.reject()
if __name__=='__main__':unittest.main()
