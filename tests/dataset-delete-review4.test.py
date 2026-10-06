"""Review-4 crash boundaries and repeated explicit-registration recovery."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tests'/file)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
F=load('review4_actual_nodes','dataset-delete-node.test.py')

class Review4(unittest.TestCase):
    setUp=F.RetirementNodeTests.setUp
    tearDown=F.RetirementNodeTests.tearDown

    def recovered(self):
        with patch.object(self.source,'isolate',side_effect=AssertionError('cancel must never advance isolate')):
            self.assertEqual(self.node.cancel(F.ADMIN,self.key)['state'],'CANCELED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')
        self.assertEqual(self.cache.acquire_lease(F.OWNER,'sample',self.version,'first-cancel')['version'],self.version)
        self.assertTrue(self.cache.deletion_permissions(F.OWNER,'sample',self.version)['memberAllowed'])

    def test_NBA_cancel_repairs_isolated_journal_after_fence_cache_busy_without_isolate(self):
        self.node.fence(F.OWNER,self.key);write=self.source._set_fence
        def busy(row,state,restored=None):
            if state=='ISOLATED':raise F.D.CacheBusy('dataset cache is busy; retry shortly')
            return write(row,state,restored)
        with patch.object(self.source,'_set_fence',side_effect=busy),self.assertRaisesRegex(ValueError,'busy'):
            self.node.isolate(F.OWNER,self.key,[])
        self.assertEqual(self.node._load(self.key)['state'],'ISOLATING')
        self.assertEqual(self.source._journal(self.key)['state'],'ISOLATED')
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'FENCED')
        self.recovered()

    def test_NBA_cancel_projects_completed_journal_after_node_row_write_failure(self):
        write=self.node._write
        def crash(row):
            if row['state']=='ISOLATED':raise OSError('killed after isolated journal')
            return write(row)
        with patch.object(self.node,'_write',side_effect=crash),self.assertRaisesRegex(OSError,'killed'):
            self.node.isolate(F.OWNER,self.key,[])
        self.assertEqual(self.node._load(self.key)['state'],'ISOLATING')
        self.assertEqual(self.source._journal(self.key)['state'],'ISOLATED')
        self.recovered()

    def test_R4_1_first_cancel_after_all_metadata_moves_preserves_personal_provenance(self):
        with patch.object(self.source,'_verify_payload',side_effect=OSError('killed during final hash')),self.assertRaisesRegex(OSError,'killed'):
            self.node.isolate(F.OWNER,self.key,[])
        self.assertIn('provenance',self.source._journal(self.key)['moves'])
        self.recovered()

    def purge(self,key,actor):
        result=self.node.isolate(actor,key,[])
        committed=self.node.commit(F.ADMIN,key,result)
        F.D._write_json(self.node._phase_path(key,'commit','result'),dict(ok=True,result=committed))
        self.source.clock=lambda:result['retainUntil']+1;self.source.clock_synchronized=lambda:True
        self.assertEqual(self.source.purge(F.ADMIN,key)['state'],'PURGED')

    def test_NBB_explicit_registration_remains_available_after_two_deleted_purged_generations(self):
        self.purge(self.key,F.OWNER)
        self.cache.register_source(F.ADMIN,'sample','approved',['owner']);self.cache.materialize(F.OWNER,'sample',self.version)
        old=self.cache.new_registration_proof(F.OWNER,'sample',self.version)
        second=str(uuid.uuid4());self.node.plan(F.ADMIN,'sample',self.version,second)
        self.purge(second,F.ADMIN)
        self.cache.register_source(F.ADMIN,'sample','approved',['owner']);self.cache.materialize(F.OWNER,'sample',self.version)
        fresh=self.cache.new_registration_proof(F.OWNER,'sample',self.version)
        self.assertEqual(fresh['operationId'],second);self.assertNotEqual(fresh['generation'],old['generation'])
        self.assertNotEqual(fresh['registrationSha256'],old['registrationSha256'])
        self.assertEqual(self.node.restore(F.ADMIN,second)['state'],'RESTORED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')

    def test_NBB_only_admin_can_audit_discard_an_uninstalled_admission_then_register_again(self):
        self.purge(self.key,F.OWNER)
        with patch.object(self.cache,'_free',side_effect=F.D.CacheError('not enough free space')),self.assertRaisesRegex(ValueError,'free space'):
            self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        intent=self.cache._reopen_path('sample',self.version);before=intent.read_bytes()
        with self.assertRaisesRegex(PermissionError,'administrator'):
            self.cache.discard_new_registration(F.OWNER,'sample',self.version,self.key)
        self.assertEqual(intent.read_bytes(),before)
        with self.assertRaisesRegex(ValueError,'generation|operation'):
            self.cache.discard_new_registration(F.ADMIN,'sample',self.version,str(uuid.uuid4()))
        result=self.cache.discard_new_registration(F.ADMIN,'sample',self.version,self.key)
        self.assertEqual(result['state'],'DISCARDED');self.assertEqual(result['operationId'],self.key)
        self.assertTrue(list((self.cache.root/'.reopens').rglob('DISCARD.json')),'administrator audit must be durable')
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'PURGED')
        self.cache.register_source(F.D.Principal('another-admin',True),'sample','approved',['owner'])
        self.cache.materialize(F.OWNER,'sample',self.version)
        with self.assertRaisesRegex(ValueError,'installed|live'):
            self.cache.discard_new_registration(F.ADMIN,'sample',self.version,self.key)
        self.assertEqual(self.cache.status(F.OWNER,'sample',self.version)['state'],'READY')

    def test_NBB_discard_resumes_after_metadata_move_crash_and_fixed_key_replay_cannot_discard_a_new_intent(self):
        self.purge(self.key,F.OWNER)
        with patch.object(self.cache,'_free',side_effect=F.D.CacheError('capacity refused')),self.assertRaisesRegex(ValueError,'capacity'):
            self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        request=str(uuid.uuid4());move=self.cache._unregister_move_record;count=0
        def interrupted(source,target):
            nonlocal count
            count+=1;move(source,target)
            if count==1:raise OSError('killed after prepared inode move')
        with patch.object(self.cache,'_unregister_move_record',side_effect=interrupted),self.assertRaisesRegex(OSError,'killed'):
            self.cache.discard_new_registration(F.ADMIN,'sample',self.version,self.key,request)
        result=self.cache.discard_new_registration(F.ADMIN,'sample',self.version,self.key,request)
        self.assertEqual(result['state'],'DISCARDED')
        self.cache.register_source(F.ADMIN,'sample','approved',['owner']);self.cache.materialize(F.OWNER,'sample',self.version)
        before=self.cache._record_identity('sample',self.version)
        self.assertEqual(self.cache.discard_new_registration(F.ADMIN,'sample',self.version,self.key,request),result)
        self.assertEqual(self.cache._record_identity('sample',self.version),before)
        self.assertEqual(self.cache.status(F.OWNER,'sample',self.version)['state'],'READY')

    def test_NBB_discard_audit_failure_has_zero_moves_and_preserves_the_original_prepared_inode(self):
        self.purge(self.key,F.OWNER)
        with patch.object(self.cache,'_free',side_effect=F.D.CacheError('capacity refused')),self.assertRaisesRegex(ValueError,'capacity'):
            self.cache.register_source(F.ADMIN,'sample','approved',['owner'])
        path=self.cache._reopen_path('sample',self.version);before=path.read_bytes()
        prepared=path.with_suffix('.registration.json');identity=F.N.R.identity(prepared)
        write=F.D._write_json
        def full(path,value):
            if path.name=='DISCARD.json':raise OSError('audit storage full')
            return write(path,value)
        with patch.object(F.D,'_write_json',side_effect=full),self.assertRaisesRegex(OSError,'audit storage full'):
            self.cache.discard_new_registration(F.ADMIN,'sample',self.version,self.key,str(uuid.uuid4()))
        self.assertEqual(path.read_bytes(),before);self.assertEqual(F.N.R.identity(prepared),identity)

    def test_NBB_previous_generation_intents_remain_immutable_and_cannot_be_adopted_by_a_later_actor(self):
        self.purge(self.key,F.OWNER)
        self.cache.register_source(F.ADMIN,'sample','approved',['owner']);self.cache.materialize(F.OWNER,'sample',self.version)
        path=self.cache._reopen_path('sample',self.version);before=path.read_bytes()
        second=str(uuid.uuid4());self.node.plan(F.ADMIN,'sample',self.version,second);self.purge(second,F.ADMIN)
        self.cache.register_source(F.D.Principal('other-admin',True),'sample','approved',['owner'])
        self.assertEqual(path.read_bytes(),before)
        self.assertNotEqual(path,self.cache._reopen_path('sample',self.version))
        self.cache.materialize(F.OWNER,'sample',self.version)
        self.assertEqual(self.cache.new_registration_proof(F.OWNER,'sample',self.version)['operationId'],second)

    def test_R4_5_unknown_commit_cannot_be_treated_as_an_uncommitted_peer(self):
        cache=self.empty.cache;cache.sources['approved']=self.cache.sources['approved']
        cache.register_source(F.ADMIN,'sample','approved',['owner']);cache.materialize(F.OWNER,'sample',self.version)
        self.empty.plan(F.ADMIN,'sample',self.version,self.empty_key);peer=self.empty.isolate(F.ADMIN,self.empty_key,[])
        self.node.isolate(F.OWNER,self.key,[peer]);restored=self.node.restore(F.ADMIN,self.key)
        F.D._write_json(self.empty._phase_path(self.empty_key,'commit','launch'),{'unknown':'durable lost dispatch'})
        with self.assertRaisesRegex(ValueError,'unconfirmed'):
            self.empty.release_absence(F.ADMIN,self.empty_key,restored)
        self.assertEqual(self.empty._load(self.empty_key)['state'],'ISOLATED')
        self.assertTrue((self.empty.retirement._folder(self.empty_key)/'payload/ready').is_dir())

    def uncommitted_peer(self,delta):
        cache=self.empty.cache;cache.sources['approved']=self.cache.sources['approved']
        cache.register_source(F.ADMIN,'sample','approved',['owner']);cache.materialize(F.OWNER,'sample',self.version)
        self.empty.plan(F.ADMIN,'sample',self.version,self.empty_key)
        peer=self.empty.isolate(F.ADMIN,self.empty_key,[])
        self.node.isolate(F.OWNER,self.key,[peer]);restored=self.node.restore(F.ADMIN,self.key)
        self.empty.retirement.clock=lambda:peer['retainUntil']+delta
        self.assertFalse((self.empty.root/(self.empty_key+'.commit-source.json')).exists())
        self.assertEqual(self.empty.release_absence(F.ADMIN,self.empty_key,restored)['state'],'RESTORED')
        self.assertEqual(cache.acquire_lease(F.OWNER,'sample',self.version,'uncommitted-peer')['version'],self.version)
        self.assertEqual((cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')

    def test_R4_5_uncommitted_complete_peer_restores_at_deadline(self):self.uncommitted_peer(0)
    def test_R4_5_uncommitted_complete_peer_restores_after_deadline(self):self.uncommitted_peer(86400)

Routes=load('review4_actual_worker_status','dataset-delete-route.test.py')
class WorkerProjection(unittest.TestCase):
    setUp=Routes.RetirementRoutes.setUp
    tearDown=Routes.RetirementRoutes.tearDown
    ready=Routes.RetirementRoutes.ready
    call=Routes.RetirementRoutes.call

    def test_R4_4_completed_receipt_still_projects_actual_running_worker_without_writes(self):
        self.call('fence',operationId=self.key)
        self.assertEqual(self.node.dataset_retirement_worker(self.key,'fence'),0)
        folder=self.node.ROOT/'dataset-retirements';before={p:p.read_bytes()for p in folder.glob('*.json')}
        with patch.object(self.node,'dataset_retirement_activity',return_value='RUNNING'):
            result=self.call('status',operationId=self.key)
        self.assertTrue(result['phases']['fence']['ok']);self.assertEqual(result['pendingPhases'],[])
        self.assertEqual(result.get('runningPhases'),['fence'])
        self.assertEqual(before,{p:p.read_bytes()for p in folder.glob('*.json')})

if __name__=='__main__':unittest.main()
