import importlib.util,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('root_guard',HERE.parent/'deploy'/'platform-root-guard.py');M=importlib.util.module_from_spec(s);s.loader.exec_module(M)
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
if __name__=='__main__':unittest.main()
