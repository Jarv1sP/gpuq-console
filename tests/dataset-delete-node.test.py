"""Private node steps: actual full data and fenced negative inventories."""
import copy
import contextlib
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

    def test_cancel_releases_exact_unisolated_fence_without_erasing_last_complete_bytes(self):
        self.node.fence(OWNER,self.key)
        with self.assertRaises(PermissionError):self.node.cancel(OWNER,self.key)
        result=self.node.cancel(ADMIN,self.key)
        self.assertEqual(result['state'],'CANCELED');self.assertTrue(result['available'])
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'RELEASED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')
        self.assertEqual(self.node.status(OWNER,self.key)['result'],result)
        with self.assertRaisesRegex(ValueError,'Canceled'):self.node.fence(OWNER,self.key)
        lease=self.cache.acquire_lease(OWNER,'sample',self.version,'normal-prepare')
        self.assertTrue(lease['readOnly']);self.assertEqual(lease['version'],self.version)

    def test_cancel_restores_real_isolated_full_bytes_and_empty_namespace(self):
        self.empty_plan();self.node.fence(OWNER,self.key);self.empty.isolate(OWNER,self.empty_key,[])
        self.node.isolate(OWNER,self.key,[])
        self.assertEqual(self.node.cancel(ADMIN,self.key)['state'],'CANCELED')
        self.assertEqual(self.empty.cancel(ADMIN,self.empty_key)['state'],'CANCELED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')
        self.empty.cache.register_manifest(ADMIN,'sample',self.cache._record(OWNER,'sample',self.version)['manifest'],['owner'])
        self.assertEqual(self.empty.cache._retirement_fence('sample',self.version)['state'],'RELEASED')

    def test_registered_evicted_step_restores_registration_and_releases_fence(self):
        with self.empty.cache._locked():
            self.empty.cache._register(type(OWNER)('owner',True),'sample',self.cache._record(OWNER,'sample',self.version)['manifest'],['owner'],None,
                _origin='replica',_receipt=str(uuid.uuid4()))
        plan=self.empty.plan(OWNER,'sample',self.version,self.empty_key)
        self.assertFalse(plan['complete']);self.assertFalse(plan['absent'])
        isolated=self.empty.isolate(OWNER,self.empty_key,[]);self.assertFalse(isolated['complete'])
        result=self.empty.restore(ADMIN,self.empty_key);self.assertEqual(result['state'],'RESTORED')
        self.assertEqual(self.empty.cache._retirement_fence('sample',self.version)['state'],'RESTORED')
        self.assertTrue(self.empty.cache._paths('sample')['.registry'].joinpath(self.version+'.json').exists())

    def test_cancel_before_first_move_releases_fence_instead_of_replaying_failed_isolate(self):
        self.node.fence(OWNER,self.key)
        with patch.object(N.R.D,'_rename_new',side_effect=OSError('before any move')),self.assertRaises(OSError):
            self.node.isolate(OWNER,self.key,[])
        with patch.object(self.source,'isolate',side_effect=AssertionError('no replay needed')):
            self.assertEqual(self.node.cancel(ADMIN,self.key)['state'],'CANCELED')
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'RELEASED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')

    def test_cancel_after_payload_move_completes_exact_local_transaction_then_restores(self):
        rename=N.R.D._rename_new
        def crash(source,destination):
            rename(source,destination)
            raise OSError('after first move')
        with patch.object(N.R.D,'_rename_new',side_effect=crash),self.assertRaises(OSError):
            self.node.isolate(OWNER,self.key,[])
        result=self.node.cancel(ADMIN,self.key)
        self.assertEqual(result['state'],'CANCELED')
        self.assertEqual(self.cache._retirement_fence('sample',self.version)['state'],'RESTORED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')

    def test_cancel_uncommitted_parent_after_deadline_recovers_retained_complete_bytes(self):
        result=self.node.isolate(OWNER,self.key,[])
        self.source.clock=lambda:result['retainUntil']+86400
        with self.assertRaisesRegex(ValueError,'retention'):
            self.node.restore(ADMIN,self.key)
        self.assertEqual(self.node.cancel(ADMIN,self.key)['state'],'CANCELED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')

    def test_corrupt_commit_proof_cannot_authorize_gc_or_expired_restore_override(self):
        result=self.node.isolate(OWNER,self.key,[])
        self.source.clock=lambda:result['retainUntil']+1;self.source.clock_synchronized=lambda:True
        D._write_json(self.node._phase_path(self.key,'commit','result'),dict(ok=True,result=dict(state='ISOLATED',operationId=self.key)))
        self.assertIsNone(self.node._collection_allowed(self.key))
        with self.assertRaisesRegex(ValueError,'not committed'):
            self.source.purge(ADMIN,self.key)
        with self.assertRaisesRegex(ValueError,'retention'):
            self.node.cancel(ADMIN,self.key)
        self.assertEqual((self.source._folder(self.key)/'payload/ready/data/fixed.txt').read_bytes(),b'fixed full data')

    def test_uncommitted_parent_cannot_expire_child_payload(self):
        result=self.node.isolate(OWNER,self.key,[])
        self.source.clock=lambda:result['retainUntil']+1;self.source.clock_synchronized=lambda:True
        with self.assertRaisesRegex(ValueError,'not committed'):
            self.source.purge(ADMIN,self.key)
        self.assertEqual((self.source._folder(self.key)/'payload/ready/data/fixed.txt').read_bytes(),b'fixed full data')
        with self.assertRaisesRegex(ValueError,'Complete original'):
            self.node.commit(ADMIN,self.key,{**result,'state':'RETIRED'})
        committed=self.node.commit(ADMIN,self.key,result)
        D._write_json(self.node._phase_path(self.key,'commit','result'),dict(ok=True,result=committed))
        self.assertEqual(self.source.purge(ADMIN,self.key)['state'],'PURGED')

    def test_corrupt_private_step_blocks_status_dispatch_and_restore(self):
        file=self.node._path(self.key);row=N.R.private_read(file)
        for change in (dict(actor='other'),dict(admin=1),dict(snapshotSha256='0'*64),dict(machine='other'),dict(state='READY')):
            D._write_json(file,{**row,**change})
            for callback in (lambda:self.node.status(OWNER,self.key),lambda:self.node.fence(OWNER,self.key),lambda:self.node.restore(ADMIN,self.key)):
                with self.subTest(change=change),self.assertRaises(ValueError):callback()
        D._write_json(file,row)
        self.assertTrue((self.cache._paths('sample',self.version)['ready']/'data/fixed.txt').exists())


    def test_interrupted_ordinary_ready_or_staging_payload_cannot_disappear_from_grant_inventory(self):
        for bucket in ('ready','staging'):
            root=self.empty.cache.root/'.trash'/('unregister-'+uuid.uuid4().hex)
            D._mkdir(root);D._write_json(root/'REMOVAL.json',{'dataset':'sample','versions':[self.version]})
            D._mkdir(root/'replicas');D._mkdir(root/'replicas'/bucket);D._mkdir(root/'replicas'/bucket/self.version)
            with self.assertRaisesRegex(ValueError,'payload'):self.empty.grant_locations(self.version,[])
            with self.assertRaisesRegex(ValueError,'unconfirmed'):self.empty_plan()
            (root/'replicas'/bucket/self.version).rmdir()


class FixedRemovedAuthority:
    """Configured, local-only fixture. No network or minted replacement grant."""
    recovery_protocol='dataset-tier-recovery-v1'

    def __init__(self,reference,owners):
        self.reference=reference
        self.proof=dict(schema=1,kind='fixture-fixed-authority',owners=owners,version=reference['version'],grantId=reference['grantId'])
        self.revoked=False

    def seal(self,*args):raise AssertionError('No grant is issued during removal reconciliation')
    def recover(self,*args,**kwargs):raise AssertionError('Removed data is never recovered during retirement')
    @contextlib.contextmanager
    def guard(self,*args,**kwargs):yield
    def retirement_reference(self,actor,proof):
        if self.revoked:raise ValueError('Old fixed grant was permanently revoked')
        if proof!=self.proof:raise ValueError('Fixed installed grant proof differs')
        return copy.deepcopy(self.reference)


class CompletedRemovalAliasTests(RetirementNodeTests):
    def setUp(self):
        super().setUp()
        self.alias='removed-alias';cache=self.empty.cache
        self.ref=dict(sourceMachine='source-node',targetMachine='empty-node',sourceDataset='sample',
                      version=self.version,grantId=str(uuid.uuid4()),receiptSha256='a'*64)
        self.adapter=FixedRemovedAuthority(self.ref,['owner'])
        self.empty.tier.authorities['approved']=self.adapter
        with cache._locked():
            cache._register(D.Principal('owner',True),self.alias,self.cache._record(OWNER,'sample',self.version)['manifest'],
                            ['owner'],None,_origin='replica',_receipt=str(uuid.uuid4()))
            tier=cache._default_tier();tier.update(role='cache',recovery=dict(schema=1,authorityId='approved',version=self.version,
                registration=list(cache._record_identity(self.alias,self.version)),owners=['owner'],proof=self.adapter.proof))
            cache._write_tier(self.alias,self.version,tier)
        # Use the real ordinary removal, including its final archived inode.
        removed=cache.unregister(ADMIN,self.alias,self.version)
        self.assertTrue(removed['unregistered'])
        self.folder=cache.root/'.trash'/removed['recoveryId']
        # Reconciliation never accepts live provenance. This fixture models
        # the actual completed removal which retains only its recovery tier.
        provenance=cache.root/'.provenance'/self.alias/(self.version+'.json')
        if provenance.exists():provenance.unlink()
        self.key_alias=str(uuid.uuid4())

    def alias_plan(self,authorization=None,references=None):
        return self.empty.plan(OWNER,self.alias,self.version,self.key_alias,
            authorization=authorization or self.authorization,references=[self.ref] if references is None else references)

    def test_completed_removal_projects_exact_grant_and_pins_archived_inode(self):
        before=self._metadata()
        self.assertEqual(self.empty.grant_locations(self.version,[self.ref]),
                         [dict(dataset=self.alias,version=self.version,authorityReference=self.ref)])
        self.assertEqual(self._metadata(),before)
        value=self.alias_plan();self.assertTrue(value['absent']);self.assertFalse(value['complete'])
        self.assertEqual(value['authorityReferences'],[self.ref])
        snapshot=self.empty._load(self.key_alias)['snapshot'];proof=snapshot['retainedRemoval']
        self.assertEqual(proof['protocol'],'completed-removal-alias-v1')
        self.assertEqual(proof['registrationIdentity'][:4],self.empty.cache._tier(self.alias,self.version)['recovery']['registration'][:4])
        self.assertNotIn('manifest',proof)
        self.assertEqual(self.alias_plan(),value)

    def _metadata(self):
        return {str(p.relative_to(self.empty.cache.root)):p.read_bytes() for p in self.empty.cache.root.rglob('*.json')}

    def test_incomplete_corrupt_ambiguous_or_cross_owner_removal_is_never_absence(self):
        file=self.folder/'REMOVAL.json';row=N.R.private_read(file)
        for change in (dict(unregistered=False),dict(schema=True),dict(owners=['other']),dict(version='0'*64),
                       dict(versions=[self.version,self.version]),dict(createdAt=float('nan'))):
            with self.subTest(change=change):
                D._write_json(file,{**row,**change})
                with self.assertRaises((ValueError,PermissionError)):self.alias_plan()
                self.assertIsNone(self.empty.cache._retirement_fence(self.alias,self.version))
        D._write_json(file,row)
        with self.assertRaises(PermissionError):self.alias_plan({**self.authorization,'owners':['other']})
        with self.assertRaises(ValueError):self.alias_plan(references=[{**self.ref,'grantId':str(uuid.uuid4())}])
        self.assertEqual(list(self.empty.root.iterdir()),[])

    def test_fixed_archive_manifest_inode_and_grant_cannot_be_replaced(self):
        file=self.folder/'registration'/(self.version+'.json')
        row=N.R.private_read(file);D._write_json(file,row)
        with self.assertRaisesRegex(ValueError,'inode'):self.alias_plan()
        self.assertEqual(list(self.empty.root.iterdir()),[])

    def test_fence_and_isolate_recheck_proof_and_never_clear_pins_or_recover(self):
        self.alias_plan();self.empty.fence(OWNER,self.key_alias)
        before=self._metadata();result=self.empty.isolate(OWNER,self.key_alias,[])
        self.assertFalse(result['complete']);self.assertTrue(result['isolated'])
        self.assertEqual(result['authorityAliases'],[dict(dataset=self.alias,version=self.version,authorityReference=self.ref)])
        for p,raw in before.items():
            if '/.retirements/' not in '/'+p:self.assertEqual((self.empty.cache.root/p).read_bytes(),raw)
        for action in (lambda:self.empty.cache.register_manifest(ADMIN,self.alias,self.cache._record(OWNER,'sample',self.version)['manifest'],['owner']),
                       lambda:self.empty.cache._check_retirement(self.alias,self.version)):
            with self.assertRaisesRegex(ValueError,'锁定'):action()
        self.assertEqual(self.empty.status(OWNER,self.key_alias)['result'],result)
        reopened=N.RetirementNode(self.empty.retirement,self.empty.root,tier=self.empty.tier,principal=ADMIN)
        self.assertEqual(reopened.status(OWNER,self.key_alias)['result'],result)

    def test_frozen_phases_use_identity_without_reparsing_archived_manifest(self):
        self.alias_plan();read=N.R.private_read;record=self.folder/'registration'/(self.version+'.json')
        def guarded(path):
            if path==record:raise AssertionError('Immutable full manifest must not be reparsed')
            return read(path)
        # First fence reconstructs the frozen negative snapshot; reuse the
        # certified registration identity instead of loading its large JSON.
        with patch.object(N.R,'private_read',side_effect=guarded):
            self.empty.fence(OWNER,self.key_alias)
            self.empty.isolate(OWNER,self.key_alias,[])
            self.empty.status(OWNER,self.key_alias)

    def test_metadata_changed_after_plan_prevents_fence_and_isolation(self):
        self.alias_plan()
        tier=self.empty.cache.root/'.tiers'/self.alias/(self.version+'.json');value=N.R.private_read(tier)
        D._write_json(tier,value)
        with self.assertRaisesRegex(ValueError,'changed'):self.empty.fence(OWNER,self.key_alias)
        self.assertIsNone(self.empty.cache._retirement_fence(self.alias,self.version))

    def test_unknown_or_live_removal_residue_blocks_all_retirement(self):
        cache=self.empty.cache
        for bucket in ('ready','.staging'):
            folder=cache._paths(self.alias,self.version)[bucket];D._mkdir(folder.parent);D._mkdir(folder)
            with self.subTest(bucket=bucket),self.assertRaisesRegex(ValueError,'unconfirmed'):self.alias_plan()
            folder.rmdir()
        file=cache.root/'.provenance'/self.alias/(self.version+'.json');D._mkdir(file.parent);D._write_json(file,{'unknown':True})
        with self.assertRaisesRegex(ValueError,'unconfirmed'):self.alias_plan()
        file.unlink()
        with cache._locked():
            value=cache._tier(self.alias,self.version);value['pins']['in-use']={'owner':'owner','createdAt':1};cache._write_tier(self.alias,self.version,value)
        with self.assertRaisesRegex(ValueError,'unpinned'):self.alias_plan()
        self.assertIsNone(cache._retirement_fence(self.alias,self.version))

    def test_cancel_retains_audit_and_does_not_issue_or_resurrect_grants(self):
        self.alias_plan();self.empty.isolate(OWNER,self.key_alias,[])
        old=self.folder.joinpath('REMOVAL.json').read_bytes();proof=copy.deepcopy(self.adapter.proof)
        self.assertEqual(self.empty.cancel(ADMIN,self.key_alias)['state'],'CANCELED')
        self.assertEqual(self.folder.joinpath('REMOVAL.json').read_bytes(),old);self.assertEqual(self.adapter.proof,proof)
        self.assertEqual(self.empty.cache._retirement_fence(self.alias,self.version)['state'],'RELEASED')
        self.empty.cache.register_manifest(ADMIN,self.alias,self.cache._record(OWNER,'sample',self.version)['manifest'],['owner'])
        self.assertEqual(self.empty.cache._tier(self.alias,self.version),self.empty.cache._default_tier())
        self.assertEqual(self.empty.status(OWNER,self.key_alias)['result']['state'],'CANCELED')

    def test_revoked_or_changed_adapter_grant_never_releases_old_fence(self):
        self.alias_plan();self.empty.isolate(OWNER,self.key_alias,[]);self.adapter.revoked=True
        with self.assertRaisesRegex(ValueError,'revoked'):self.empty.cancel(ADMIN,self.key_alias)
        self.assertEqual(self.empty.cache._retirement_fence(self.alias,self.version)['state'],'ISOLATED')
        with self.assertRaisesRegex(ValueError,'revoked'):self.empty.status(OWNER,self.key_alias)

    def test_source_restore_releases_only_exact_absence_and_new_registration_resets_old_recovery(self):
        self.alias_plan();self.empty.isolate(OWNER,self.key_alias,[])
        self.node.isolate(OWNER,self.key,[]);restored=self.node.restore(ADMIN,self.key)
        value=self.empty.release_absence(ADMIN,self.key_alias,restored);self.assertEqual(value['state'],'RESTORED')
        self.empty.cache.register_manifest(ADMIN,self.alias,self.cache._record(OWNER,'sample',self.version)['manifest'],['owner'])
        self.assertIsNone(self.empty.cache._tier(self.alias,self.version)['recovery'])
        self.assertEqual(self.empty.status(OWNER,self.key_alias)['result'],value)

    def test_every_physical_alias_is_projected_from_registered_and_completed_removal(self):
        cache=self.empty.cache;live='live-alias'
        with cache._locked():
            cache._register(D.Principal('owner',True),live,self.cache._record(OWNER,'sample',self.version)['manifest'],['owner'],None,_origin='replica',_receipt=str(uuid.uuid4()))
            tier=cache._default_tier();tier.update(role='cache',recovery=dict(schema=1,authorityId='approved',version=self.version,
                registration=list(cache._record_identity(live,self.version)),owners=['owner'],proof=self.adapter.proof));cache._write_tier(live,self.version,tier)
        plan=self.empty.plan(OWNER,live,self.version,str(uuid.uuid4()))
        self.assertEqual({row['dataset'] for row in plan['authorityAliases']},{live,self.alias})

    def test_all_existing_data_consumers_remain_fenced_no_rebuild_escape(self):
        self.alias_plan();self.empty.isolate(OWNER,self.key_alias,[]);cache=self.empty.cache
        before=self._metadata()
        actions=(lambda:cache.materialize(ADMIN,self.alias,self.version),
                 lambda:cache.prepare_transfer(ADMIN,self.alias,self.version),
                 lambda:cache.publish(ADMIN,self.alias,self.version,'0'*64),
                 lambda:cache.acquire_lease(ADMIN,self.alias,self.version,'consumer'),
                 lambda:self.empty.tier.recover(ADMIN,self.alias,self.version),
                 lambda:cache.register_manifest(ADMIN,self.alias,self.cache._record(OWNER,'sample',self.version)['manifest'],['owner']))
        for action in actions:
            with self.subTest(action=action),self.assertRaises((ValueError,FileNotFoundError)):action()
        self.assertEqual(self._metadata(),before)
        self.assertEqual(cache._retirement_fence(self.alias,self.version)['state'],'ISOLATED')

    def test_payload_lease_and_changed_removal_between_fence_and_isolate_stay_protected(self):
        self.alias_plan();self.empty.fence(OWNER,self.key_alias);cache=self.empty.cache
        lease=cache._paths(self.alias,self.version)['.leases'];D._mkdir(lease.parent);D._mkdir(lease)
        D._write_json(lease/'consumer.json',dict(unknown=True))
        with self.assertRaises(ValueError):self.empty.isolate(OWNER,self.key_alias,[])
        self.assertEqual(cache._retirement_fence(self.alias,self.version)['state'],'FENCED')
        (lease/'consumer.json').unlink()
        file=self.folder/'REMOVAL.json';row=N.R.private_read(file);D._write_json(file,{**row,'unregistered':False})
        with self.assertRaises(ValueError):self.empty.isolate(OWNER,self.key_alias,[])
        self.assertIsNone(self.empty._load(self.key_alias)['result'])

    def test_same_inode_write_permissions_and_hardlink_are_not_frozen_proof(self):
        self.alias_plan();record=self.folder/'registration'/(self.version+'.json')
        raw=record.read_bytes()
        with record.open('r+b') as f:f.write(raw);f.flush();os.fsync(f.fileno())
        with self.assertRaisesRegex(ValueError,'archived registration'):self.empty.fence(OWNER,self.key_alias)
        self.assertIsNone(self.empty.cache._retirement_fence(self.alias,self.version))
        record.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'Unsafe'):self.empty.grant_locations(self.version,[self.ref])
        record.chmod(0o600)
        alias=record.with_name('extra-link.json');os.link(record,alias)
        with self.assertRaisesRegex(ValueError,'single link'):self.empty.grant_locations(self.version,[self.ref])

    def test_source_references_cannot_assert_extra_or_unknown_consumer(self):
        with self.assertRaisesRegex(ValueError,'only its actual'):
            self.alias_plan(references=[self.ref,{**self.ref,'grantId':str(uuid.uuid4())}])
        original=copy.deepcopy(self.adapter.reference);self.adapter.reference={**self.adapter.reference,'targetMachine':'different-node'}
        with self.assertRaisesRegex(ValueError,'identity'):self.alias_plan()
        self.adapter.reference=original
        self.adapter.proof['owners']=['other']
        with self.assertRaisesRegex(ValueError,'identity|proof differs'):self.alias_plan()

    def test_interrupted_metadata_only_isolate_cancel_is_not_payload_replay(self):
        self.alias_plan();self.empty.fence(OWNER,self.key_alias)
        row=self.empty._load(self.key_alias);row['state']='ISOLATING';self.empty._write(row)
        with patch.object(self.empty.retirement,'isolate',side_effect=AssertionError('No replay')):
            self.assertEqual(self.empty.cancel(ADMIN,self.key_alias)['state'],'CANCELED')
        self.assertEqual(self.empty.cache._retirement_fence(self.alias,self.version)['state'],'RELEASED')
        self.assertTrue((self.folder/'registration'/(self.version+'.json')).is_file())

if __name__=='__main__':
    unittest.main()
