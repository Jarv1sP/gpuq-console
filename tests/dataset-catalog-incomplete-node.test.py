"""UNKNOWN display rows never enter recovery, deletion or worker overlays."""
import importlib.util,json,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
H=Path(__file__).resolve().parent
class NodeOverlay(unittest.TestCase):
 def test_unknown_row_has_no_privileged_overlays(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t).resolve();(p/'node-executor.py').write_bytes((H.parent/'deploy/node-executor.py').read_bytes());(p/'scheduling-policy.py').write_bytes((H.parent/'deploy/scheduling-policy.py').read_bytes());(p/'node-config.json').write_text(json.dumps({'root':str(p/'state')}));(p/'state').mkdir()
   s=importlib.util.spec_from_file_location('incomplete_overlay_node',p/'node-executor.py');n=importlib.util.module_from_spec(s);sys.modules[s.name]=n;s.loader.exec_module(n)
   row={'version':'a'*64,'state':'UNKNOWN','canPrepare':False,'deletionBlocked':True,'errorCode':'CACHE_METADATA_INCOMPLETE','error':'fixed'}
   cache=SimpleNamespace(list_datasets=Mock(return_value={'datasets':[{'dataset':'old','versions':[row]}]}),_list_datasets_snapshot=Mock(return_value=({'datasets':[{'dataset':'old','versions':[row]}]},{})),deletion_permissions=Mock(side_effect=AssertionError('no deletion admission')))
   with patch.object(n,'storage_warehouse',return_value=None),patch.object(n,'dataset_cache',return_value=(object(),cache)),patch.object(n,'dataset_actor',return_value=object()),patch.object(n,'dataset_delete_capability',return_value=1),patch.object(n,'dataset_recovery_configured',side_effect=AssertionError('no recovery admission')),patch.object(n,'dataset_current_prepare',side_effect=AssertionError('no worker overlay')):
    result=n._dataset_op('datasets.list',{'userId':'fixture-owner','hostAdmin':True})
   self.assertEqual(result['datasets'][0]['versions'][0]['state'],'UNKNOWN');self.assertFalse(row['canPrepare'])
   self.assertEqual(row['deletionPermissions'],{'allowed':False,'memberAllowed':False,'reason':'CACHE_METADATA_INCOMPLETE'})
   cache.deletion_permissions.assert_not_called()

class WarehouseOverlay(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  p=Path(self.temp.name).resolve()
  for name in ('node-executor.py','scheduling-policy.py'):(p/name).write_bytes((H.parent/'deploy'/name).read_bytes())
  (p/'node-config.json').write_text(json.dumps({'root':str(p/'state')}));(p/'state').mkdir()
  s=importlib.util.spec_from_file_location('warehouse_incomplete_overlay_node',p/'node-executor.py');self.n=importlib.util.module_from_spec(s);sys.modules[s.name]=self.n;s.loader.exec_module(self.n)
  s=importlib.util.spec_from_file_location('warehouse_incomplete_cache',H.parent/'deploy/dataset-cache.py');self.d=importlib.util.module_from_spec(s);s.loader.exec_module(self.d)
  self.version='a'*64
  self.cache=SimpleNamespace(_list_datasets_snapshot=Mock(return_value=({'datasets':[]},{})),
   _catalog_incomplete=self.d.DatasetCache._catalog_incomplete,
   deletion_permissions=Mock(return_value={'allowed':True,'memberAllowed':True,'reason':None}))
  self.warehouse=SimpleNamespace(list=Mock(),binding=Mock(side_effect=FileNotFoundError),status=Mock())
  for name,value in [('dataset_cache',(self.d,self.cache)),('dataset_actor',object()),('storage_warehouse',self.warehouse),('dataset_delete_capability',1),('dataset_recovery_configured',False)]:
   p=patch.object(self.n,name,return_value=value);p.start();self.addCleanup(p.stop)
 def call(self):return self.n._dataset_op('datasets.list',{'userId':'fixture-owner','hostAdmin':True})
 def unknown(self):return {'version':self.version,'state':'UNKNOWN','canPrepare':False,'deletionBlocked':True,
  'warehouseReady':False,'warehouseCanPrepare':False,'errorCode':'CACHE_METADATA_INCOMPLETE','error':'fixed',
  'deletionPermissions':{'allowed':False,'memberAllowed':False,'reason':'CACHE_METADATA_INCOMPLETE'}}
 def assert_unknown(self,row):
  self.assertEqual(row['state'],'UNKNOWN');self.assertFalse(row['canPrepare']);self.assertTrue(row['deletionBlocked'])
  self.assertEqual(row['errorCode'],'CACHE_METADATA_INCOMPLETE')
  self.assertEqual(row['deletionPermissions'],{'allowed':False,'memberAllowed':False,'reason':'CACHE_METADATA_INCOMPLETE'})
  self.assertNotIn('storageReference',row);self.assertNotIn('operationId',row)
  self.assertNotIn('recoveryConfigured',row)
 def test_warehouse_unknown_cannot_enter_worker_overlay(self):
  row=self.unknown();self.warehouse.list.return_value={'datasets':[{'dataset':'cold','versions':[row]}]}
  with patch.object(self.n,'dataset_current_prepare',side_effect=AssertionError('no worker lookup')),\
    patch.object(self.n,'dataset_background_status',side_effect=AssertionError('no strict warehouse status')):
   result=self.call()
  self.assert_unknown(result['datasets'][0]['versions'][0]);self.warehouse.status.assert_not_called()
 def test_warehouse_parent_lost_during_overlay_is_unknown_not_historical_ready(self):
  row={'version':self.version,'state':'REGISTERED','canPrepare':True,'warehouseReady':True,
   'warehouseCanPrepare':True,'storageReference':{'dataset':'fixed-cache','version':self.version},
   'deletionPermissions':{'allowed':True,'memberAllowed':True,'reason':None}}
  self.warehouse.list.return_value={'datasets':[{'dataset':'cold','versions':[row]}]}
  task={'op':'prepare','warehouse':True,'dataset':'cold','version':self.version}
  self.warehouse.status.side_effect=self.d.CacheMetadataIncomplete('private path must not escape')
  folder=self.n.ROOT/'dataset-ops';folder.mkdir()
  (folder/('b'*64+'.result.json')).write_text(json.dumps({'state':'READY','operationId':'b'*64}))
  with patch.object(self.n,'dataset_current_prepare',return_value=('b'*64,task)):
   result=self.call()
  self.assert_unknown(result['datasets'][0]['versions'][0]);self.assertFalse(row['warehouseReady']);self.assertFalse(row['warehouseCanPrepare'])
  self.assertNotIn('private path',json.dumps(result))
  # The exact same worker status remains strict outside the display overlay.
  with self.assertRaises(self.d.CacheMetadataIncomplete):self.n.dataset_background_status(folder,'b'*64,task,self.cache,object())
 def test_ordinary_cache_parent_lost_during_overlay_is_unknown(self):
  row={'version':self.version,'state':'REGISTERED','canPrepare':True}
  self.cache._list_datasets_snapshot.return_value=({'datasets':[{'dataset':'hot','versions':[row]}]},{('hot',self.version):object()})
  self.warehouse.list.return_value={'datasets':[]}
  with patch.object(self.n,'dataset_current_prepare',return_value=('b'*64,{'op':'prepare'})),\
    patch.object(self.n,'dataset_recovery_configured',return_value=True),\
    patch.object(self.n,'dataset_background_status',side_effect=self.d.CacheMetadataIncomplete('fixed')):
   result=self.call()
  self.assert_unknown(result['datasets'][0]['versions'][0])
 def test_non_typed_warehouse_overlay_errors_still_fail_closed(self):
  self.warehouse.list.return_value={'datasets':[{'dataset':'cold','versions':[{'version':self.version,'state':'REGISTERED'}]}]}
  for error in (self.d.CacheError('corrupt metadata'),PermissionError('ACL revoked'),ValueError('bad binding'),OSError('I/O unconfirmed')):
   with self.subTest(error=type(error).__name__),patch.object(self.n,'dataset_current_prepare',return_value=('b'*64,{'op':'prepare'})),\
     patch.object(self.n,'dataset_background_status',side_effect=error):
    with self.assertRaises(type(error)):self.call()
 def test_unknown_hot_row_does_not_hide_unsafe_binding(self):
  row=self.unknown();self.cache._list_datasets_snapshot.return_value=({'datasets':[{'dataset':'hot','versions':[row]}]}, {})
  self.warehouse.binding.side_effect=ValueError('Fixed local cache binding changed')
  with self.assertRaisesRegex(ValueError,'binding changed'):self.call()
if __name__=='__main__':unittest.main()
