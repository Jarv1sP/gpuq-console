"""Synthetic missing-parent catalog checks; never reads a real account."""
import hashlib,importlib.util,json,os,shutil,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('incomplete_catalog',HERE.parent/'deploy/dataset-cache.py');D=importlib.util.module_from_spec(spec);spec.loader.exec_module(D)
ADMIN=D.Principal('test-admin',True);OWNER=D.Principal('owner');OTHER=D.Principal('other')
class IncompleteCatalog(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
  self.cache=D.DatasetCache(self.root/'cache',reserve_bytes=0)
  self.manifest={'schema':1,'directories':[],'files':[{'path':'x.bin','size':3,'sha256':hashlib.sha256(b'abc').hexdigest()}]}
  self.version=self.cache.register_manifest(ADMIN,'incomplete',self.manifest,['owner'])['version']
  self.paths=self.cache._paths('incomplete',self.version)
  self.good=self.cache.register_manifest(ADMIN,'healthy',{'schema':1,'directories':[],'files':[]},['owner'])['version']
 def tearDown(self):
  for root,dirs,files in os.walk(self.root):
   os.chmod(root,0o700)
   for name in files:
    p=Path(root)/name
    if not p.is_symlink():p.chmod(0o600)
  self.temp.cleanup()
 def remove_parent(self,role):
  shutil.rmtree(self.paths[role].parent)
 def row(self):
  listing,snapshots=self.cache._list_datasets_snapshot(OWNER)
  item=next(r for r in listing['datasets'] if r['dataset']=='incomplete')
  row=item['versions'][0]
  self.assertEqual(row['state'],'UNKNOWN');self.assertFalse(row['canPrepare']);self.assertTrue(row['deletionBlocked'])
  self.assertEqual(row['errorCode'],'CACHE_METADATA_INCOMPLETE');self.assertEqual((row['bytes'],row['files']),(3,1))
  self.assertNotIn(('incomplete',self.version),snapshots)
  self.assertEqual(next(r for r in listing['datasets'] if r['dataset']=='healthy')['versions'][0]['state'],'REGISTERED')
  self.assertNotIn(str(self.root),json.dumps(listing));return row
 def test_missing_ready_parent_is_unknown_without_recreation(self):
  self.remove_parent('ready');self.row();self.assertFalse(self.paths['ready'].parent.exists())
 def test_missing_staging_parent_is_unknown_without_recreation(self):
  self.remove_parent('.staging');self.row();self.assertFalse(self.paths['.staging'].parent.exists())
 def test_missing_both_parents_and_warm_summary_do_not_claim_absence(self):
  self.cache.list_datasets(OWNER);self.remove_parent('ready');self.remove_parent('.staging');self.row();self.row()
 def test_foreign_acl_cannot_see_unknown_registration(self):
  self.remove_parent('ready');self.assertEqual(self.cache.list_datasets(OTHER),{'datasets':[]})
 def test_admin_sees_same_unknown_and_counts(self):
  self.remove_parent('ready');rows=self.cache.list_datasets(ADMIN)['datasets'];self.assertEqual(next(r for r in rows if r['dataset']=='incomplete')['versions'][0]['state'],'UNKNOWN')
 def test_prepare_status_lease_and_absence_remain_strict(self):
  self.remove_parent('ready');self.row()
  for call in [lambda:self.cache.plan(OWNER,'incomplete',self.version),lambda:self.cache.status(OWNER,'incomplete',self.version),lambda:self.cache.acquire_lease(OWNER,'incomplete',self.version,'test-job'),lambda:self.cache._version_entry_exists(self.paths['ready'])]:
   with self.assertRaises(D.CacheMetadataIncomplete):call()
  self.assertFalse(self.paths['ready'].parent.exists())
 def test_unregister_is_not_enabled_by_unknown_display(self):
  self.remove_parent('ready');self.row()
  with self.assertRaises(D.CacheError):self.cache.unregister(ADMIN,'incomplete',self.version)
  self.assertTrue((self.paths['.registry'].parent/(self.version+'.json')).exists())
 def test_valid_source_never_enables_prepare_for_incomplete_storage(self):
  p=self.paths['.registry'].parent/(self.version+'.json');r=D._read_json(p);r['sourceId']='allowed';D._write_json(p,r);self.cache.sources['allowed']=self.root/'allowed';self.remove_parent('ready');self.row()
 def test_corrupt_registry_is_not_downgraded_to_unknown(self):
  p=self.paths['.registry'].parent/(self.version+'.json');p.write_text('{}');self.remove_parent('ready')
  with self.assertRaises(D.CacheError):self.cache.list_datasets(OWNER)
 def test_acl_revocation_during_unknown_validation_rejects(self):
  self.remove_parent('ready');old=self.cache._record_snapshot
  def revoke(*a,**k):
   r=old(*a,**k)
   if a[1]=='incomplete':D._write_json(self.paths['.registry'].parent/'dataset.json',{'schema':1,'owners':['other']})
   return r
  with patch.object(self.cache,'_record_snapshot',side_effect=revoke):
   with self.assertRaises((PermissionError,D.CacheError)):self.cache.list_datasets(OWNER)
 def test_parent_disappears_after_summary_stays_unknown(self):
  old=self.cache._catalog_version
  def disappear(*a):
   r=old(*a)
   if a[1]=='incomplete':self.remove_parent('.staging')
   return r
  with patch.object(self.cache,'_catalog_version',side_effect=disappear):self.row()
 def test_unsafe_parent_link_is_not_absence(self):
  self.remove_parent('ready');self.paths['ready'].parent.symlink_to(self.root,target_is_directory=True)
  with self.assertRaises((D.CacheError,OSError)):self.cache.list_datasets(OWNER)
if __name__=='__main__':unittest.main()
