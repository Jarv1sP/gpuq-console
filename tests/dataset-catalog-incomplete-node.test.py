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
if __name__=='__main__':unittest.main()
