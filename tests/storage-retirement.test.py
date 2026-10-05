"""Isolated native retirement with real cache, seals, TLS and normal REMOVAL."""
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import uuid

spec = importlib.util.spec_from_file_location('archive_retirement_fixture',Path(__file__).with_name('storage-archive.test.py'))
F = importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
M,A,D,USER,ADMIN = F.M,F.A,F.D,F.USER,F.ADMIN


class AuthorityRetirementTests(unittest.TestCase):
    setUp = F.ArchiveTests.setUp
    tearDown = F.ArchiveTests.tearDown
    executor = F.ArchiveTests.executor
    tls_target = F.ArchiveTests.tls_target
    provision = F.ArchiveTests.provision

    def prepared(self, *, remove=True):
        target = self.tls_target();target.worker_state = Mock(return_value='STOPPED')
        grant = self.provision()
        certify = str(uuid.uuid4())
        result = target.certify(dict(opId=certify,userId=USER,target=dict(dataset='replica',version=self.version),grant=grant))
        input_path = self.root/'input';(input_path/'extra').write_bytes(b'new union file')
        new = self.cold.register_source(ADMIN,'replacement','input',[USER])['version']
        self.cold.materialize(ADMIN,'replacement',new)
        replacement = self.store.seal(ADMIN,'replacement',new,str(uuid.uuid4()),'hot-node')
        op = str(uuid.uuid4())
        removed = self.hot.unregister(ADMIN,'replica',self.version) if remove else {'recoveryId':'unregister-'+'0'*32}
        args = dict(mode='authority-target-v1',opId=op,userId=USER,target=dict(dataset='replica',version=self.version),
            grantId=grant['id'],certifyId=certify,recoveryId=removed['recoveryId'],receiptSha256=result['receiptSha256'])
        state = {}
        def unregister(operation,request,*,_request_id,_expected_registration,_expected_owners):
            self.assertEqual(operation,'datasets.unregister')
            if _request_id not in state:
                state[_request_id] = dict(self.cold.unregister(ADMIN,request['dataset'],request['version'],_expected_registration=_expected_registration,_expected_owners=_expected_owners),
                    operationId=hashlib.sha256(_request_id.encode()).hexdigest(),state='UNREGISTERED')
            return state[_request_id]
        self.node._dataset_op = Mock(side_effect=unregister)
        self.activity = patch.object(M.J.TransferJobs,'activity',return_value=False)
        self.activity.start();self.addCleanup(self.activity.stop)
        return dict(target=target,grant=grant,replacement=replacement,args=args,new=new,state=state)

    def source_args(self,f,proof):
        return dict(mode='authority-source-v1',opId=f['args']['opId'],userId=USER,grantId=f['grant']['id'],
                    replacementGrantId=f['replacement']['id'],targetProof=proof)

    def test_full_retirement_fences_reads_install_and_reissue_preserving_replacement(self):
        f = self.prepared();proof = f['target'].retire(f['args']);source = self.source_args(f,proof)
        self.assertEqual(proof['state'],'REVOKED')
        with self.assertRaisesRegex(ValueError,'retired'): f['target'].remote.install_grant(f['grant'])
        with self.assertRaisesRegex(ValueError,'retired'):
            with f['target'].remote.guard(ADMIN,f['target'].remote._proof(f['grant'])): pass
        first = self.source.retire(source);self.assertEqual(first['state'],'RETIRED')
        self.assertEqual(self.source.retire(source),first)
        self.assertEqual(f['target'].retire(f['args']),proof)
        with self.assertRaises(FileNotFoundError): self.cold._record(ADMIN,'original',self.version)
        for ident in [f['grant']['id'],str(uuid.uuid4())]:
            with self.assertRaisesRegex(ValueError,'retired'):
                self.store.seal(ADMIN,'original',self.version,ident,'hot-node')
        with self.assertRaises((ValueError,FileNotFoundError)):
            self.store.read(dict(id=f['grant']['id'],action='guard',dataset='original',version=self.version,targetMachine='hot-node'),f['grant']['token'])
        self.assertEqual(self.cold.status(ADMIN,'replacement',f['new'])['state'],'READY')
        self.assertIn(f['replacement']['receipt']['pinId'],self.cold._tier('replacement',f['new'])['pins'])
        self.assertEqual(len(f['state']),1)

    def test_target_requires_normal_removal_and_exact_certification(self):
        f = self.prepared(remove=False)
        with self.assertRaisesRegex(ValueError,'Live or unknown'): f['target'].retire(f['args'])
        self.assertFalse(f['target'].remote.fence_path('original',self.version).exists())
        for fields in [dict(receiptSha256='0'*64),dict(grantId=str(uuid.uuid4())),dict(userId='demo-user-2')]:
            with self.assertRaises(ValueError): f['target'].retire({**f['args'],**fields})
        self.assertIn(f['grant']['receipt']['pinId'],self.cold._tier('original',self.version)['pins'])

    def test_target_rejects_old_running_peer_without_writing_any_fence(self):
        f = self.prepared()
        with patch.object(A.AuthorityClient,'call',return_value={'old':'peer'}):
            with self.assertRaisesRegex(ValueError,'running|Running'): f['target'].retire(f['args'])
        self.assertFalse(f['target'].remote.fence_path('original',self.version).exists())

    def test_exact_grant_consumer_blocks_retirement_without_touching_other_grants(self):
        f=self.prepared();proof=f['target'].remote._proof(f['grant'])
        with f['target'].remote.guard(ADMIN,proof):
            with self.assertRaisesRegex(ValueError,'grant is busy'):f['target'].retire(f['args'])
            self.assertFalse(f['target'].remote.fence_path('original',self.version).exists())
        self.assertEqual(f['target'].retire(f['args'])['state'],'REVOKED')

    def test_target_rejects_another_alias_and_unknown_workers(self):
        f = self.prepared();tier = self.hot._tier('replica',self.version)
        self.hot._write_tier('other-alias',self.version,tier)
        with self.assertRaisesRegex(ValueError,'Another cache'): f['target'].retire(f['args'])
        (self.hot.root/'.tiers'/'other-alias'/(self.version+'.json')).unlink()
        f['target'].worker_state.return_value='UNKNOWN'
        with self.assertRaisesRegex(ValueError,'unknown certification'): f['target'].retire(f['args'])
        self.assertFalse(f['target'].remote.fence_path('original',self.version).exists())

    def test_source_rejects_active_lease_unknown_preparation_other_pin_and_missing_union_file(self):
        f = self.prepared();proof = f['target'].retire(f['args']);args=self.source_args(f,proof)
        lease = self.cold.acquire_lease(ADMIN,'original',self.version,'job-fixture')
        with self.assertRaisesRegex(ValueError,'Leases'): self.source.retire(args)
        self.cold.release_lease(ADMIN,'original',self.version,lease['leaseId'])
        tier=self.cold._tier('original',self.version);tier['pins']['manual']=dict(owner=USER,createdAt=1);self.cold._write_tier('original',self.version,tier)
        with self.assertRaisesRegex(ValueError,'pins'): self.source.retire(args)
        del tier['pins']['manual'];self.cold._write_tier('original',self.version,tier)
        jobs=M.J.TransferJobs(self.node);ident=str(uuid.uuid4())
        D._write_json(jobs.path(ident,'.source-lease.json'),dict(reference=dict(kind='datasets',dataset='original',version=self.version),state='PREPARING'))
        with self.assertRaisesRegex(ValueError,'unknown source'): self.source.retire(args)
        jobs.path(ident,'.source-lease.json').unlink()
        self.assertFalse(self.store.reference_fence('original',self.version).exists())
        # A separately sealed version that omits the old file is not a replacement.
        (self.root/'input'/'file').unlink()
        missing=self.cold.register_source(ADMIN,'not-union','input',[USER])['version'];self.cold.materialize(ADMIN,'not-union',missing)
        bad=self.store.seal(ADMIN,'not-union',missing,str(uuid.uuid4()),'hot-node')
        with self.assertRaisesRegex(ValueError,'contain every old'):
            self.source.retire({**args,'replacementGrantId':bad['id']})
        self.assertIn(f['grant']['receipt']['pinId'],self.cold._tier('original',self.version)['pins'])

    def test_another_source_grant_is_not_silently_released(self):
        f=self.prepared();proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        other=self.store.seal(ADMIN,'original',self.version,str(uuid.uuid4()),'other-node')
        with self.assertRaisesRegex(ValueError,'Another authority grant'): self.source.retire(args)
        self.assertEqual(set(self.cold._tier('original',self.version)['pins']),{f['grant']['receipt']['pinId'],other['receipt']['pinId']})

    def test_crash_after_unpin_resumes_exact_durable_retirement_without_reissuing(self):
        f=self.prepared();proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        save=self.source._save;failed=[False]
        def fail_once(path,value):
            if path.name=='retirement.json' and value.get('state')=='REVOKED' and not failed[0]:
                failed[0]=True;raise OSError('lost durable completion')
            return save(path,value)
        with patch.object(self.source,'_save',side_effect=fail_once):
            with self.assertRaisesRegex(OSError,'lost durable'): self.source.retire(args)
        self.assertFalse(self.cold._tier('original',self.version)['pins'])
        self.assertTrue(self.store.reference_fence('original',self.version).exists())
        self.assertEqual(self.source.retire(args)['state'],'RETIRED')
        self.assertEqual(len(f['state']),1)

    def test_failed_or_unknown_normal_unregister_is_not_reported_retired(self):
        f=self.prepared();proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        self.node._dataset_op.side_effect=None
        for state in ('FAILED','UNKNOWN','UNREGISTERING'):
            self.node._dataset_op.return_value=dict(operationId='f'*64,state=state)
            result=self.source.retire(args)
            self.assertEqual(result['state'],'UNREGISTERING');self.assertEqual(result['unregister']['state'],state)
        self.assertEqual(self.cold.status(ADMIN,'original',self.version)['state'],'READY')

    def test_explicit_failed_retry_is_fixed_before_dispatch_and_unknown_is_not_retried(self):
        f=self.prepared();proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        original=self.node._dataset_op.side_effect
        f['state'][args['opId']]=dict(operationId='f'*64,state='FAILED')
        self.assertEqual(self.source.retire(args)['unregister']['state'],'FAILED')
        key=str(uuid.uuid4());lost=[False]
        def lose_reply(*a,**kw):
            result=original(*a,**kw)
            if kw['_request_id']==key and not lost[0]:lost[0]=True;raise TimeoutError('lost final ACK')
            return result
        self.node._dataset_op.side_effect=lose_reply
        with self.assertRaises(TimeoutError):self.source.retire({**args,'retryKey':key})
        self.assertEqual(self.source.retire({**args,'retryKey':key})['state'],'RETIRED')
        self.assertEqual(len(f['state']),2)

    def test_retry_rejects_unknown_or_live_failed_worker(self):
        f=self.prepared();proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        for state,activity in [('UNKNOWN',False),('FAILED',None),('FAILED',True)]:
            f['state'][args['opId']]=dict(operationId='f'*64,state=state)
            with patch.object(M.J.TransferJobs,'activity',return_value=activity):
                with self.assertRaisesRegex(ValueError,'confirmed failed and stopped'):
                    self.source.retire({**args,'retryKey':str(uuid.uuid4())})
            self.assertEqual(len(f['state']),1)
        self.assertEqual(self.cold.status(ADMIN,'original',self.version)['state'],'READY')

    def test_deferred_unregister_rejects_recreated_same_version(self):
        f=self.prepared();proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        original=self.node._dataset_op.side_effect
        manifest=self.cold._record(ADMIN,'original',self.version)['manifest']
        def replace_then_unregister(*a,**kw):
            self.cold.unregister(ADMIN,'original',self.version)
            self.cold.register_manifest(ADMIN,'original',manifest,[USER])
            return original(*a,**kw)
        self.node._dataset_op.side_effect=replace_then_unregister
        with self.assertRaisesRegex(ValueError,'original retirement identity'):self.source.retire(args)
        self.assertEqual(self.cold._record(ADMIN,'original',self.version)['manifest'],manifest)

    def test_successful_registration_journal_is_quiescent_only_when_worker_stopped(self):
        f=self.prepared();ident='e'*64;folder=self.node.ROOT/'dataset-ops'
        folder.mkdir(mode=0o700,exist_ok=True)
        D._write_json(folder/(ident+'.json'),dict(op='register',dataset='original',userId=USER))
        D._write_json(folder/(ident+'.result.json'),dict(state='REGISTERED'))
        proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        with patch.object(M.J.TransferJobs,'activity',return_value=None):
            with self.assertRaisesRegex(ValueError,'unknown dataset worker'):self.source.retire(args)
        self.assertEqual(self.source.retire(args)['state'],'RETIRED')

    def test_deferred_unregister_rejects_changed_owners_with_unchanged_version_stamp(self):
        f=self.prepared();proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        original=self.node._dataset_op.side_effect
        stamp=self.cold._record_identity('original',self.version)
        def share_then_unregister(*a,**kw):
            self.cold.set_owners(ADMIN,'original',[USER,'demo-user-2'])
            self.assertEqual(self.cold._record_identity('original',self.version),stamp)
            return original(*a,**kw)
        self.node._dataset_op.side_effect=share_then_unregister
        with self.assertRaisesRegex(ValueError,'ownership differs'):self.source.retire(args)
        self.assertEqual(self.cold.status(ADMIN,'original',self.version)['state'],'READY')


if __name__=='__main__':unittest.main()
