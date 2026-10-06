"""Private node steps: actual full data and fenced negative inventories."""
import copy
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,DEPLOY/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


N=load('retirement_node_test','dataset-retirement-node.py')
T=load('retirement_node_tier_test','dataset-tier.py')
D=T.D
ADMIN, OWNER, OTHER=D.Principal('administrator',True),D.Principal('owner'),D.Principal('other')


class RetirementNodeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name)
        source=self.base/'approved';source.mkdir()
        (source/'fixed.txt').write_bytes(b'fixed full data')
        self.cache=D.DatasetCache(self.base/'source',sources={'approved':source},reserve_bytes=0,lock_timeout=.02)
        with self.cache._locked():
            created=self.cache._register(D.Principal('owner',True),'sample',D._scan(source),['owner'],'approved',
                                         _origin='upload',_receipt=str(uuid.uuid4()))
        self.version=created['version'];self.cache.materialize(OWNER,'sample',self.version)
        tier=T.DatasetTier(self.cache)
        self.source=N.R.DatasetRetirement(self.cache,'source-node',recovery_references=tier.retirement_references)
        self.node=N.RetirementNode(self.source,self.base/'source-ops',tier=tier,principal=ADMIN)
        empty=D.DatasetCache(self.base/'empty',reserve_bytes=0,lock_timeout=.02)
        empty_tier=T.DatasetTier(empty)
        retirement=N.R.DatasetRetirement(empty,'empty-node',recovery_references=empty_tier.retirement_references)
        self.empty=N.RetirementNode(retirement,self.base/'empty-ops',tier=empty_tier,principal=ADMIN)
        self.key=str(uuid.uuid4());self.empty_key=str(uuid.uuid4())
        self.plan=self.node.plan(OWNER,'sample',self.version,self.key)
        self.authorization={key:self.plan[key] for key in ('operationId','machine','dataset','version','owners','memberAllowed','complete','snapshotSha256')}

    def tearDown(self):
        for root,_,files in os.walk(self.base):
            os.chmod(root,0o700)
            for name in files:
                path=Path(root)/name
                if not path.is_symlink():path.chmod(0o600)

    def empty_plan(self, authorization=None):
        return self.empty.plan(OWNER,'sample',self.version,self.empty_key,authorization=authorization or self.authorization)

    def test_fixed_plan_keeps_actual_local_identity_and_idempotency(self):
        path=self.node._path(self.key);before=path.read_bytes()
        self.assertEqual(self.node.plan(OWNER,'sample',self.version,self.key),self.plan)
        self.assertEqual(path.read_bytes(),before)
        self.assertTrue(self.plan['complete']);self.assertTrue(self.plan['memberAllowed']);self.assertFalse(self.plan['absent'])
        self.assertNotIn('registration',self.plan)
        for actor in (OTHER,ADMIN):
            with self.subTest(actor=actor),self.assertRaises(PermissionError):
                self.node.plan(actor,'sample',self.version,self.key)
        with self.assertRaises(ValueError):self.node.plan(OWNER,'another',self.version,self.key)

    def test_present_data_never_accepts_supplied_source_permissions(self):
        for kwargs in (dict(authorization=self.authorization),dict(references=[dict(force=True)])):
            with self.subTest(kwargs=kwargs),self.assertRaises(ValueError):
                self.node.plan(OWNER,'sample',self.version,str(uuid.uuid4()),**kwargs)

    def test_unknown_old_single_owner_cannot_be_upgraded_by_source_authorization(self):
        old=self.empty.cache
        old.register_manifest(ADMIN,'sample',self.cache._record(OWNER,'sample',self.version)['manifest'],['owner'])
        with self.assertRaisesRegex(PermissionError,'管理员'):
            self.empty.plan(OWNER,'sample',self.version,self.empty_key)
        with self.assertRaises(PermissionError):
            self.empty_plan()

    def test_absence_requires_actual_confirmed_complete_source_and_member_proof(self):
        for change in (dict(complete=False),dict(memberAllowed=False),dict(owners=['other']),dict(operationId='bad'),
                       dict(snapshotSha256='bad'),dict(force=True)):
            with self.subTest(change=change),self.assertRaises((ValueError,PermissionError)):
                self.empty_plan({**self.authorization,**change})
        with self.assertRaises(ValueError):
            self.empty.plan(OWNER,'sample',self.version,self.empty_key)
        self.assertEqual(list(self.empty.root.iterdir()),[])

    def test_missing_registration_with_ready_staging_tier_or_lease_is_not_absence(self):
        paths=self.empty.cache._paths('sample',self.version)
        for bucket in ('ready','.staging'):
            path=paths[bucket];D._mkdir(path.parent);D._mkdir(path)
            with self.subTest(bucket=bucket),self.assertRaisesRegex(ValueError,'unconfirmed'):
                self.empty_plan()
            path.rmdir()
        with self.empty.cache._locked():
            self.empty.cache._write_tier('sample',self.version,self.empty.cache._default_tier())
        with self.assertRaisesRegex(ValueError,'unconfirmed'):self.empty_plan()

    def test_absent_namespace_cannot_fence_another_owners_dataset(self):
        other=self.empty.cache
        other.register_manifest(ADMIN,'sample',{'schema':1,'directories':[],'files':[]},['other'])
        with self.assertRaises(PermissionError):self.empty_plan()
        self.assertIsNone(other._retirement_fence('sample',self.version))

    def test_negative_inventory_fence_blocks_new_registration_and_survives_reopen(self):
        self.empty_plan();self.empty.fence(OWNER,self.empty_key)
        manifest=self.cache._record(OWNER,'sample',self.version)['manifest']
        for target in (self.empty.cache,D.DatasetCache(self.empty.cache.root,reserve_bytes=0)):
            with self.subTest(target=target),self.assertRaisesRegex(ValueError,'锁定'):
                target.register_manifest(ADMIN,'sample',manifest,['owner'])
        self.assertEqual(self.empty.status(OWNER,self.empty_key)['state'],'FENCED')

    def test_new_registration_between_negative_plan_and_fence_stops_before_fencing(self):
        self.empty_plan()
        self.empty.cache.register_manifest(ADMIN,'sample',self.cache._record(OWNER,'sample',self.version)['manifest'],['owner'])
        with self.assertRaisesRegex(ValueError,'unconfirmed'):self.empty.fence(OWNER,self.empty_key)
        self.assertIsNone(self.empty.cache._retirement_fence('sample',self.version))

    def test_confirmed_absence_and_present_data_have_distinct_complete_flags(self):
        self.empty_plan();self.node.fence(OWNER,self.key)
        empty=self.empty.isolate(OWNER,self.empty_key,[])
        full=self.node.isolate(OWNER,self.key,[empty])
        self.assertTrue(empty['isolated']);self.assertFalse(empty['complete'])
        self.assertTrue(full['isolated']);self.assertTrue(full['complete'])
        self.assertEqual(self.empty.status(OWNER,self.empty_key)['result'],empty)
        self.assertEqual(self.node.status(OWNER,self.key)['result'],full)
        self.assertEqual((self.source._folder(self.key)/'payload/ready/data/fixed.txt').read_bytes(),b'fixed full data')

    def test_status_is_pure_during_fence_isolation_and_node_restart(self):
        self.empty_plan();self.empty.fence(OWNER,self.empty_key)
        files={p:p.read_bytes() for p in self.empty.root.iterdir()}
        fence=self.empty.cache.root/'.retirements'/'sample'/(self.version+'.json');before=fence.read_bytes()
        for _ in range(3):self.empty.status(OWNER,self.empty_key)
        self.assertEqual(files,{p:p.read_bytes() for p in self.empty.root.iterdir()})
        self.assertEqual(fence.read_bytes(),before)
        with self.assertRaises(PermissionError):self.empty.status(OTHER,self.empty_key)

    def test_isolation_retry_cannot_change_fixed_target_confirmations(self):
        self.node.fence(OWNER,self.key)
        self.node.isolate(OWNER,self.key,[])
        with self.assertRaisesRegex(ValueError,'cannot change'):
            self.node.isolate(OWNER,self.key,[dict(state='RETIRED')])
        with self.assertRaises(PermissionError):self.node.isolate(ADMIN,self.key,[])

    def test_unfinished_full_isolation_query_never_replays_or_claims_completion(self):
        self.node.fence(OWNER,self.key)
        with patch.object(N.R.D,'_rename_new',side_effect=OSError('crash')),self.assertRaises(OSError):
            self.node.isolate(OWNER,self.key,[])
        path=self.node._path(self.key);before=path.read_bytes()
        with patch.object(self.source,'isolate',side_effect=AssertionError('no automatic replay')):
            result=self.node.status(OWNER,self.key)
        self.assertEqual(result['state'],'ISOLATING');self.assertFalse(result['result']['isolated'])
        self.assertEqual(path.read_bytes(),before)
        self.assertTrue((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').exists())

    def test_admin_restore_requires_confirmed_isolation_and_keeps_scope(self):
        with self.assertRaises(ValueError):self.node.restore(ADMIN,self.key)
        self.node.fence(OWNER,self.key);self.node.isolate(OWNER,self.key,[])
        with self.assertRaises(PermissionError):self.node.restore(OWNER,self.key)
        restored=self.node.restore(ADMIN,self.key)
        self.assertEqual(restored['state'],'RESTORED')
        self.assertEqual(self.node.status(OWNER,self.key)['result'],restored)

    def test_absence_release_is_admin_only_after_exact_source_restore(self):
        self.empty_plan();self.node.fence(OWNER,self.key)
        self.empty.isolate(OWNER,self.empty_key,[]);self.node.isolate(OWNER,self.key,[])
        with self.assertRaises(ValueError):self.empty.restore(ADMIN,self.empty_key)
        pending=self.node.status(OWNER,self.key)['result']
        with self.assertRaises(ValueError):self.empty.release_absence(ADMIN,self.empty_key,pending)
        restored=self.node.restore(ADMIN,self.key)
        for changes in (dict(machine='other'),dict(operationId=str(uuid.uuid4())),dict(snapshotSha256='0'*64),dict(complete=False)):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                self.empty.release_absence(ADMIN,self.empty_key,{**restored,**changes})
        with self.assertRaises(PermissionError):self.empty.release_absence(OWNER,self.empty_key,restored)
        result=self.empty.release_absence(ADMIN,self.empty_key,restored)
        self.assertEqual(result['state'],'RESTORED');self.assertEqual(result['fenceState'],'RELEASED')
        self.assertEqual(self.empty.status(OWNER,self.empty_key)['result'],result)
        manifest=self.cache._record(OWNER,'sample',self.version)['manifest']
        self.empty.cache.register_manifest(ADMIN,'sample',manifest,['owner'])
        with self.assertRaises(ValueError):self.empty.fence(OWNER,self.empty_key)

    def test_corrupt_private_step_blocks_status_dispatch_and_restore(self):
        file=self.node._path(self.key);row=N.R.private_read(file)
        for change in (dict(actor='other'),dict(admin=1),dict(snapshotSha256='0'*64),dict(machine='other'),dict(state='READY')):
            D._write_json(file,{**row,**change})
            for callback in (lambda:self.node.status(OWNER,self.key),lambda:self.node.fence(OWNER,self.key),lambda:self.node.restore(ADMIN,self.key)):
                with self.subTest(change=change),self.assertRaises(ValueError):callback()
        D._write_json(file,row)
        self.assertTrue((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').exists())


if __name__=='__main__':
    unittest.main()
