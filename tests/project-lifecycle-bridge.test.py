"""Lifecycle operations cross the real bridge; final SSH is a fake transport."""
import importlib.util
from pathlib import Path
import json
import unittest

spec=importlib.util.spec_from_file_location('lifecycle_bridge_fixture',Path(__file__).with_name('project-import-bridge.test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)

class LifecycleBridge(unittest.TestCase):
    setUp=base.ProjectDraftBridge.setUp
    request=base.ProjectDraftBridge.request

    @staticmethod
    def args(operation):
        args={'userId':'fixture-owner','project':'my-project'}
        if operation in ('projects.archive','projects.unarchive','projects.retire'):args['revision']=0
        if operation in ('projects.retire','projects.retire.status'):args['key']=base.KEY
        if operation=='projects.retire':args['manifestSha256']='a'*64
        return args

    def test_exact_lifecycle_operations_pass_without_host_privileges_or_replay(self):
        for operation in ('projects.archive','projects.unarchive','projects.retire.plan','projects.retire','projects.retire.status'):
            with self.subTest(operation=operation):
                result,run,args,*_=self.request(operation)
                self.assertTrue(result['ok'],result);run.assert_called_once()
                self.assertEqual(json.loads(run.call_args.kwargs['input']),{'operation':operation,'args':args})
                self.assertNotIn('hostAdmin',args)

if __name__=='__main__':unittest.main()
