"""Review-3 stopped-worker retry and rollback regressions, real local bytes."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tests'/file)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
F=load('review3_actual_node','dataset-delete-node.test.py')
Q=load('review3_actual_routes','dataset-delete-route.test.py')
A=load('review3_actual_authority','dataset-delete-authority.test.py')

class RollbackRegression(unittest.TestCase):
    setUp=F.RetirementNodeTests.setUp
    tearDown=F.RetirementNodeTests.tearDown

    def test_NB1_cancel_failed_isolation_without_a_journal_never_calls_isolate(self):
        self.node.fence(F.OWNER,self.key)
        with patch.object(self.source,'inspect',side_effect=ValueError('temporary recovery reference read failure')):
            with self.assertRaisesRegex(ValueError,'temporary recovery'):
                self.node.isolate(F.OWNER,self.key,[])
        self.assertFalse(F.N.R.exists(self.source._folder(self.key)/'RETIREMENT.json'))
        with patch.object(self.source,'isolate',side_effect=AssertionError('cancellation may not move forward')):
            result=self.node.cancel(F.ADMIN,self.key)
        self.assertEqual(result['state'],'CANCELED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'RELEASED')

    def test_NB1_cancel_partial_move_only_rolls_back_and_survives_clock_reversal(self):
        rename=F.N.R.D._rename_new
        def crash(source,destination):
            rename(source,destination);raise OSError('after payload rename before journal save')
        with patch.object(F.N.R.D,'_rename_new',side_effect=crash),self.assertRaisesRegex(OSError,'after payload'):
            self.node.isolate(F.OWNER,self.key,[])
        journal=self.source._journal(self.key);self.source.clock=lambda:journal['createdAt']-100
        with patch.object(self.source,'isolate',side_effect=AssertionError('cancel must not finish isolation')):
            result=self.node.cancel(F.ADMIN,self.key)
        self.assertEqual(result['state'],'CANCELED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')
        self.assertEqual(self.cache.acquire_lease(F.OWNER,'sample',self.version,'after-cancel')['version'],self.version)

    def test_NB2_purged_complete_peer_releases_only_with_its_exact_restored_source(self):
        cache=self.empty.cache
        cache.sources['approved']=self.cache.sources['approved']
        with cache._locked():
            cache._register(F.D.Principal('owner',True),'sample',F.D._scan(cache.sources['approved']),['owner'],'approved',
                            _origin='upload',_receipt=str(uuid.uuid4()))
        cache.materialize(F.OWNER,'sample',self.version)
        self.empty.plan(F.OWNER,'sample',self.version,self.empty_key)
        peer=self.empty.isolate(F.OWNER,self.empty_key,[])
        source=self.node.isolate(F.OWNER,self.key,[peer])
        committed=self.empty.commit(F.ADMIN,self.empty_key,source)
        F.D._write_json(self.empty._phase_path(self.empty_key,'commit','result'),dict(ok=True,result=committed))
        self.empty.retirement.clock=lambda:peer['retainUntil']+1
        self.empty.retirement.clock_synchronized=lambda:True
        self.assertEqual(self.empty.retirement.purge(F.ADMIN,self.empty_key)['state'],'PURGED')
        restored=self.node.restore(F.ADMIN,self.key)
        for change in (dict(state='ISOLATED'),dict(machine='wrong'),dict(operationId=str(uuid.uuid4())),dict(generation='0'*64)):
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'source restore'):
                self.empty.release_absence(F.ADMIN,self.empty_key,{**restored,**change})
            self.assertEqual(cache._retirement_fence('sample',self.version)['state'],'PURGED')
        with self.assertRaisesRegex(PermissionError,'administrator'):
            self.empty.release_absence(F.OWNER,self.empty_key,restored)
        released=self.empty.release_absence(F.ADMIN,self.empty_key,restored)
        self.assertEqual(released['state'],'RELEASED')
        self.assertEqual(self.empty.release_absence(F.ADMIN,self.empty_key,restored),released)
        # A later collection scan cannot restore the obsolete PURGED fence.
        self.assertEqual(self.empty.retirement.purge(F.ADMIN,self.empty_key)['state'],'PURGED')
        cache.register_source(F.ADMIN,'sample','approved',['owner'])
        cache.materialize(F.OWNER,'sample',self.version)
        self.assertEqual(cache.acquire_lease(F.OWNER,'sample',self.version,'after-source-restore')['version'],self.version)

    def test_NB2_expired_unpurged_peer_recovers_only_after_fixed_source_restore(self):
        cache=self.empty.cache;cache.sources['approved']=self.cache.sources['approved']
        cache.register_source(F.ADMIN,'sample','approved',['owner']);cache.materialize(F.OWNER,'sample',self.version)
        self.empty.plan(F.ADMIN,'sample',self.version,self.empty_key)
        child=self.empty.isolate(F.ADMIN,self.empty_key,[])
        source=self.node.isolate(F.OWNER,self.key,[child])
        self.empty.commit(F.ADMIN,self.empty_key,source)
        self.empty.retirement.clock=lambda:child['retainUntil']+86400
        with self.assertRaisesRegex(ValueError,'retention'):
            self.empty.restore(F.ADMIN,self.empty_key)
        with self.assertRaisesRegex(ValueError,'source restore'):
            self.empty.release_absence(F.ADMIN,self.empty_key,source)
        restored=self.node.restore(F.ADMIN,self.key)
        self.assertEqual(self.empty.release_absence(F.ADMIN,self.empty_key,restored)['state'],'RESTORED')
        self.assertEqual((cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')
        self.assertEqual(cache.acquire_lease(F.OWNER,'sample',self.version,'late-recovered')['version'],self.version)

class RetryRoutes(unittest.TestCase):
    setUp=Q.RetirementRoutes.setUp
    tearDown=Q.RetirementRoutes.tearDown
    ready=Q.RetirementRoutes.ready
    call=Q.RetirementRoutes.call

    def test_NB1_admin_retry_restarts_same_failed_phase_once_and_keeps_audit(self):
        self.call('fence',operationId=self.key)
        node=self.node.dataset_retirement_node()
        self.node.atomic_json(node._phase_path(self.key,'fence','result'),dict(ok=False,error='temporary drain failure'))
        retry=str(uuid.uuid4())
        with patch.object(self.node,'dataset_retirement_activity',return_value='STOPPED'):
            result=self.call('fence',operationId=self.key,retryKey=retry)
            self.assertEqual(result['state'],'DISPATCHED')
            self.assertEqual(self.call('fence',operationId=self.key,retryKey=retry),result)
        self.assertEqual(len(self.starts),2)
        self.assertFalse(node._phase_path(self.key,'fence','result').exists())
        attempts=list((self.node.ROOT/'dataset-retirements').glob(self.key+'.fence.attempt-*'))
        self.assertTrue(attempts,'retry audit must be durable before worker start')
        self.assertEqual(self.node.dataset_retirement_worker(self.key,'fence'),0)

    def test_NB1_retry_requires_admin_stopped_worker_and_failed_or_missing_result(self):
        self.call('fence',operationId=self.key)
        for state in ('RUNNING','UNKNOWN'):
            with patch.object(self.node,'dataset_retirement_activity',return_value=state),self.assertRaisesRegex(ValueError,'termination'):
                self.call('fence',operationId=self.key,retryKey=str(uuid.uuid4()))
        with self.assertRaisesRegex((ValueError,PermissionError),'administrator|Administrator'):
            self.call('fence',user='demo-user-1',admin=False,operationId=self.key,retryKey=str(uuid.uuid4()))
        self.assertEqual(self.node.dataset_retirement_worker(self.key,'fence'),0)
        with patch.object(self.node,'dataset_retirement_activity',return_value='STOPPED'),self.assertRaisesRegex(ValueError,'confirmed|succeeded'):
            self.call('fence',operationId=self.key,retryKey=str(uuid.uuid4()))
        self.assertEqual(len(self.starts),1)

    def test_NB1_retirement_worker_has_no_short_runtime_deadline(self):
        self.call('fence',operationId=self.key)
        limits=[arg for arg in self.starts[0] if arg.startswith('--property=RuntimeMaxSec=')]
        self.assertTrue(not limits or int(limits[0].split('=')[-1])>=7*86400,limits)

    def test_SF8_v1_admin_proof_removes_a_full_cache_without_authority_but_preserves_original(self):
        self.cache.rebuild_guard=None
        request=dict(userId='builtin-admin',hostAdmin=True,dataset='example',version=self.version,
            protocol='dataset-delete-node-v1',portalProvedOtherCopy=dict(protocol='dataset-portal-copy-proof-v1',versions=[self.version]))
        with patch.object(self.node,'dataset_background_active',return_value=False):
            reply=self.node.process('datasets.unregister',request)
        folder=self.node.ROOT/'dataset-ops'
        task=self.module._read_json(folder/(reply['operationId']+'.json'))
        self.assertEqual(task['op'],'unregister-v1','legacy workers must refuse the new operation, not ignore its proof')
        self.assertEqual(self.node.dataset_worker(reply['operationId']),0)
        result=self.node.process('datasets.status',dict(userId='builtin-admin',hostAdmin=True,operationId=reply['operationId']))
        self.assertEqual(result['state'],'UNREGISTERED')
        self.assertEqual((self.source/'train.txt').read_text(),'small immutable training sample\n')

    def test_SF8_portal_proof_never_covers_a_new_version_added_before_worker(self):
        request=dict(userId='builtin-admin',hostAdmin=True,dataset='example',version=None,
            protocol='dataset-delete-node-v1',portalProvedOtherCopy=dict(protocol='dataset-portal-copy-proof-v1',versions=[self.version]))
        with patch.object(self.node,'dataset_background_active',return_value=False):
            reply=self.node.process('datasets.unregister',request)
        (self.source/'extra.txt').write_text('new version not in Portal proof')
        new=self.cache.register_source(self.admin,'example','approved',['demo-user-1'])
        self.cache.materialize(self.user,'example',new['version'])
        self.assertEqual(self.node.dataset_worker(reply['operationId']),1)
        result=self.node.process('datasets.status',dict(userId='builtin-admin',hostAdmin=True,operationId=reply['operationId']))
        self.assertEqual(result['state'],'FAILED');self.assertRegex(result['error'],'does not cover')
        self.assertEqual(self.cache.status(self.user,'example',self.version)['state'],'READY')
        self.assertEqual(self.cache.status(self.user,'example',new['version'])['state'],'READY')

    def test_SF3_protocol_and_proof_require_current_capability_and_authenticated_admin(self):
        base=dict(userId='builtin-admin',hostAdmin=True,dataset='example',version=self.version,protocol='dataset-delete-node-v1')
        with patch.object(self.node,'dataset_delete_capability',return_value=0),self.assertRaisesRegex(ValueError,'protocol'):
            self.node.process('datasets.unregister',base)
        with self.assertRaisesRegex(ValueError,'administrator'):
            self.node.process('datasets.unregister',{**base,'userId':'demo-user-1','hostAdmin':False,
                'portalProvedOtherCopy':dict(protocol='dataset-portal-copy-proof-v1',versions=[self.version])})
        self.assertEqual(self.starts,[])

class AuthorityRollback(unittest.TestCase):
    setUp=A.RetirementAuthorityTests.setUp
    tearDown=A.RetirementAuthorityTests.tearDown
    add_target=A.RetirementAuthorityTests.add_target
    target_receipts=A.RetirementAuthorityTests.target_receipts
    revoked=A.RetirementAuthorityTests.revoked
    request=A.RetirementAuthorityTests.request

    def test_NB1_cancel_after_grant_revocation_never_revokes_more_and_restores_new_registration(self):
        tier=A.T.DatasetTier(self.cache)
        node=F.N.RetirementNode(self.retirement,self.base/'source-operations',tier=tier,principal=A.ADMIN)
        node.plan(A.OWNER,'source-data',self.version,self.key)
        receipts=self.target_receipts()
        def busy(dataset,version):
            if any(self.revoked(t['grant']).exists() for t in self.targets):
                raise ValueError('temporary dependency unavailable after grant revocation')
        self.retirement.assert_quiescent=busy
        with self.assertRaisesRegex(ValueError,'after grant revocation'):
            node.isolate(A.OWNER,self.key,receipts)
        revoked={self.revoked(t['grant']):self.revoked(t['grant']).read_bytes() for t in self.targets}
        with patch.object(self.retirement,'isolate',side_effect=AssertionError('cancel cannot advance')),\
                patch.object(self.store,'revoke_for_retirement',side_effect=AssertionError('cancel cannot revoke')):
            self.assertEqual(node.cancel(A.ADMIN,self.key)['state'],'CANCELED')
        self.assertEqual(revoked,{path:path.read_bytes() for path in revoked})
        for target in self.targets:
            with self.assertRaisesRegex(PermissionError,'retired|revoked'):
                self.store.read(self.request(target['grant']),target['grant']['token'])
        self.assertNotEqual(list(self.cache._record_identity('source-data',self.version)),self.snapshot['registration'])
        self.assertEqual(self.cache.acquire_lease(A.OWNER,'source-data',self.version,'canceled-authority')['version'],self.version)

if __name__=='__main__':unittest.main()
