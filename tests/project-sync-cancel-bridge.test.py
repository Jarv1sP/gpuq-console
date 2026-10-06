"""The actual fixed bridge: one literal cancellation RPC, no live transport."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

spec=importlib.util.spec_from_file_location('sync_cancel_bridge_fixture',Path(__file__).with_name('project-import-bridge.test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)


class SyncCancelBridge(unittest.TestCase):
    setUp=base.ProjectDraftBridge.setUp
    request=base.ProjectDraftBridge.request

    @staticmethod
    def args(operation):
        return {'userId':'fixture-owner','project':'draft','key':base.KEY,'snapshotId':'22345678-1234-4234-8234-123456789012',
                'source':{'kind':'git','commit':'a'*40},'manifestSha256':'b'*64,'revision':'c'*64}

    def test_exact_operation_preserves_identity_and_failed_node_envelope(self):
        for response in ({'ok':True,'result':{'state':'CANCELED','preservesBytes':True}},{'ok':False,'error':'Different sync owner'}):
            result,run,args,_,_=self.request('projects.sync.cancel',response=response)
            self.assertEqual(result,response);run.assert_called_once()
            import json
            self.assertEqual(json.loads(run.call_args.kwargs['input']),{'operation':'projects.sync.cancel','args':args})
            self.assertNotIn('hostAdmin',args)

    def test_nearby_operations_and_unknown_machine_are_not_forwarded(self):
        for op,machine in [('projects.sync.force-cancel','fixture-node'),('projects.sync.cancel.extra','fixture-node'),('projects.sync.*','fixture-node'),('projects.sync.cancel','unknown-node')]:
            result,run,_,control,master=self.request(op,machine)
            self.assertFalse(result['ok']);self.assertEqual(result['error'],'Invalid operation');run.assert_not_called();control.assert_not_called();master.assert_not_called()

    def test_timeout_is_unconfirmed_and_never_replayed(self):
        result,run,_,_,_=self.request('projects.sync.cancel',failure=subprocess.TimeoutExpired('fixture-rpc',1))
        self.assertFalse(result['ok']);run.assert_called_once()


if __name__=='__main__':unittest.main()
