"""Real node boundary and durable detached phases; no GPU/SSH/systemd writes."""
import importlib.util
import json
from pathlib import Path
import shutil
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('retirement_route_fixture',ROOT/'tests/node-datasets.test.py')
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)


class RetirementRoutes(unittest.TestCase):
    def setUp(self):
        F.NodeDatasets.setUp(self)
        for name in ('dataset-retirement.py','dataset-retirement-node.py','dataset-rebuild-proof.py','dataset-tier.py','storage-node.py','storage-authority.py'):
            shutil.copy2(ROOT/'deploy'/name,self.base/name)
        self.node.CONFIG['machine']='node-a'
        self.ready()
        self.key=str(uuid.uuid4())
        self.starts=[]
        p=patch.object(self.node,'run',side_effect=lambda argv,**kwargs:self.starts.append(argv))
        p.start();self.addCleanup(p.stop)
        self.plan=self.call('plan',dataset='example',version=self.version,operationId=self.key)

    tearDown=F.NodeDatasets.tearDown
    ready=F.NodeDatasets.ready

    def call(self,action,user='builtin-admin',admin=True,**args):
        return self.node.process('storage.dataset-delete.'+action,{'userId':user,'hostAdmin':admin,**args})

    def test_capability_requires_full_helpers_and_valid_minimum_retention(self):
        self.assertEqual(self.call('capabilities')['datasetDelete'],1)
        helper=self.base/'dataset-retirement-node.py';saved=helper.read_bytes();helper.unlink()
        self.assertEqual(self.call('capabilities')['datasetDelete'],0)
        with self.assertRaisesRegex(ValueError,'不支持'):self.call('fence',operationId=self.key)
        helper.write_bytes(saved)
        for value in (False,0,6,366,'7',None):
            self.node.CONFIG['datasets']['retireRetentionDays']=value
            self.assertEqual(self.call('capabilities')['datasetDelete'],0)
        self.assertEqual(self.starts,[])

    def test_private_route_rejects_public_paths_roles_missing_fields_and_invalid_uuid(self):
        for operation in ('datasets.delete','datasets.delete.restore','datasets.retire_authority'):
            with self.subTest(operation=operation),self.assertRaises(ValueError):self.node.process(operation,{})
        for change in (dict(path='/outside'),dict(role='admin'),dict(force=True),dict(hostAdmin=1),dict(operationId='bad')):
            with self.subTest(change=change),self.assertRaises(ValueError):
                self.call('fence',**{'operationId':self.key,**change})
        for args in ({'userId':'builtin-admin','hostAdmin':True},{'operationId':self.key,'userId':'builtin-admin'}):
            with self.assertRaises(ValueError):self.node.process('storage.dataset-delete.fence',args)
        self.assertEqual(self.starts,[])

    def test_legacy_single_owner_remains_admin_only_at_real_node_route(self):
        with self.assertRaisesRegex(PermissionError,'管理员'):
            self.call('plan',user='demo-user-1',admin=False,dataset='example',version=self.version,operationId=str(uuid.uuid4()))
        self.assertFalse(self.plan['memberAllowed'])

    def test_member_unregister_uses_actual_personal_proof_and_original_worker(self):
        with self.cache._locked():
            registered=self.cache._register(self.module.Principal('demo-user-1',True),'personal',self.module._scan(self.source),['demo-user-1'],'approved',
                _origin='upload',_receipt=str(uuid.uuid4()))
        version=registered['version'];self.cache.materialize(self.user,'personal',version)
        request={'userId':'demo-user-1','hostAdmin':False,'dataset':'personal','version':version}
        with patch.object(self.node,'dataset_background_active',return_value=False):
            result=self.node.process('datasets.unregister',request)
        self.assertEqual(result['state'],'UNREGISTERING')
        self.assertEqual(self.node.dataset_worker(result['operationId']),0)
        status=self.node.process('datasets.status',{'userId':'demo-user-1','hostAdmin':False,'operationId':result['operationId']})
        self.assertTrue(status['unregistered']);self.assertEqual(status['state'],'UNREGISTERED')
        self.assertEqual((self.source/'train.txt').read_text(),'small immutable training sample\n')
        with self.assertRaisesRegex(ValueError,'Administrator'):
            self.node.process('datasets.unregister',{'userId':'demo-user-1','hostAdmin':False,'dataset':'example'})

    def test_dispatch_is_durable_once_across_lost_reply_and_new_adapter(self):
        with patch.object(self.node,'run',side_effect=TimeoutError('systemd reply lost')) as run:
            with self.assertRaises(TimeoutError):self.call('fence',operationId=self.key)
        run.assert_called_once()
        folder=self.node.ROOT/'dataset-retirements'
        path=folder/(self.key+'.fence.launch.json')
        before=path.read_bytes()
        self.assertEqual(self.call('fence',operationId=self.key)['state'],'DISPATCHED')
        self.assertEqual(before,path.read_bytes());self.assertEqual(self.starts,[])
        with patch.object(self.node,'dataset_retirement_activity',return_value='STOPPED'):
            result=self.call('status',operationId=self.key)
        self.assertEqual(result['unconfirmedPhases'],['fence']);self.assertEqual(result['phases'],{})
        self.assertEqual(self.starts,[])

    def test_worker_fences_then_isolates_complete_data_and_status_does_not_mutate(self):
        self.call('fence',operationId=self.key)
        self.assertEqual(self.node.dataset_retirement_worker(self.key,'fence'),0)
        with self.assertRaisesRegex(ValueError,'删除已锁定'):
            self.cache.acquire_lease(self.user,'example',self.version,'new-job')
        result=self.call('status',operationId=self.key)
        self.assertTrue(result['phases']['fence']['result']['drained'])
        self.call('isolate',operationId=self.key,targets=[])
        self.assertEqual(self.node.dataset_retirement_worker(self.key,'isolate'),0)
        result=self.call('status',operationId=self.key)
        self.assertTrue(result['result']['complete']);self.assertTrue(result['result']['isolated'])
        paths=list((self.node.ROOT/'dataset-retirements').glob('*.json'))
        before={p:p.read_bytes() for p in paths}
        with patch.object(self.node,'run',side_effect=AssertionError('query cannot dispatch')):
            self.assertEqual(self.call('status',operationId=self.key),result)
        self.assertEqual(before,{p:p.read_bytes() for p in paths})
        self.assertEqual(len(self.starts),2)

    def test_result_written_while_sampling_inactive_worker_is_seen_in_same_status(self):
        self.call('fence',operationId=self.key)
        def stopped(key,phase):
            if phase=='fence':self.assertEqual(self.node.dataset_retirement_worker(key,phase),0)
            return 'STOPPED'
        with patch.object(self.node,'dataset_retirement_activity',side_effect=stopped):
            result=self.call('status',operationId=self.key)
        self.assertEqual(result['unconfirmedPhases'],[])
        self.assertEqual(result['pendingPhases'],[])
        self.assertTrue(result['phases']['fence']['ok'])

    def test_running_worker_status_does_not_wait_for_version_or_retirement_lock(self):
        # Behavior-preservation coverage: this already passed on 1f95188.
        # It is not claimed as an old-FAIL regression for phase retry.
        self.call('fence',operationId=self.key)
        node=self.node.dataset_retirement_node()
        with node.cache._lock_file('.locks/example.'+self.version+'.lock'),\
                patch.object(self.node,'dataset_retirement_activity',return_value='RUNNING'):
            result=self.call('status',operationId=self.key)
        self.assertEqual(result['pendingPhases'],['fence'])
        self.assertEqual(result['unconfirmedPhases'],[])
        self.assertEqual(result['phases'],{})

    def test_cancel_refuses_running_or_unknown_old_workers_before_dispatch(self):
        self.call('fence',operationId=self.key)
        for state in ('RUNNING','UNKNOWN'):
            with patch.object(self.node,'dataset_retirement_activity',return_value=state),self.assertRaisesRegex(ValueError,'termination'):
                self.call('cancel',operationId=self.key)
        self.assertEqual(len(self.starts),1)
        self.assertFalse((self.node.ROOT/'dataset-retirements'/(self.key+'.cancel.launch.json')).exists())

    def test_isolation_before_confirmed_fence_and_mutated_launch_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'fence'):self.call('isolate',operationId=self.key,targets=[])
        self.assertEqual(self.starts,[])
        self.call('fence',operationId=self.key)
        path=self.node.ROOT/'dataset-retirements'/(self.key+'.fence.launch.json')
        row=json.loads(path.read_text());row['userId']='demo-user-1';self.node.atomic_json(path,row)
        with self.assertRaisesRegex(ValueError,'change'):self.call('fence',operationId=self.key)
        self.assertEqual(len(self.starts),1)

    def test_role_changed_old_step_cannot_dispatch_or_be_restored_by_member(self):
        for action in ('fence','restore','release-absence'):
            with self.subTest(action=action),self.assertRaises((ValueError,PermissionError)):
                self.call(action,user='demo-user-1',admin=False,operationId=self.key,
                          **({'sourceResult':{}} if action=='release-absence' else {}))
        self.assertEqual(self.starts,[])

    def test_live_worker_state_uses_native_pid_evidence_and_fails_closed(self):
        cases=[(0,'LoadState=loaded\nActiveState=active\nMainPID=41\nControlPID=0\n','RUNNING'),
               (0,'LoadState=loaded\nActiveState=failed\nMainPID=0\nControlPID=0\n','STOPPED'),
               (1,'LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlPID=0\n','STOPPED'),
               (0,'LoadState=loaded\nActiveState=inactive\nMainPID=12\nControlPID=0\n','UNKNOWN'),
               (1,'LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlPID=0\n','UNKNOWN'),
               (0,'ActiveState=inactive\n','UNKNOWN')]
        for code,out,expected in cases:
            with self.subTest(out=out),patch.object(self.node.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=out)):
                self.assertEqual(self.node.dataset_retirement_activity(self.key,'fence'),expected)
        with patch.object(self.node.subprocess,'run',side_effect=OSError):
            self.assertEqual(self.node.dataset_retirement_activity(self.key,'fence'),'UNKNOWN')

    def test_corrupt_or_foreign_worker_reply_is_never_success(self):
        self.call('fence',operationId=self.key);self.node.dataset_retirement_worker(self.key,'fence')
        path=self.node.ROOT/'dataset-retirements'/(self.key+'.fence.result.json')
        actual=json.loads(path.read_text())
        for change in (dict(machine='other'),dict(operationId=str(uuid.uuid4())),dict(snapshotSha256='a'*64)):
            self.node.atomic_json(path,dict(ok=True,result={**actual['result'],**change}))
            with self.assertRaisesRegex(ValueError,'differs'):self.call('status',operationId=self.key)


if __name__=='__main__':unittest.main()
