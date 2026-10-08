"""Disposable dual-root contracts, no real nodes/configurations/datasets."""
import contextlib
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,DEPLOY/file)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value
A=module('warehouse_test_authority','storage-authority.py');D=A.D
W=module('warehouse_test_factory','storage-warehouse.py')
S=module('warehouse_test_storage','storage-node.py')
U=module('warehouse_test_upload','dataset-upload.py')
L=module('warehouse_test_leases','storage-leases.py')
I=module('warehouse_test_ingress','dataset-ingress-node.py')
DW=module('warehouse_test_data_workspace','data-workspace.py')
ADMIN=D.Principal('demo-user-3',True);OWNER=D.Principal('demo-user-3')


class WarehouseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
        (self.root/'hdd').mkdir(mode=0o700)
        self.hot=D.DatasetCache(self.root/'ssd',reserve_bytes=0,budget_bytes=10**7)
        self.config=dict(machine='test-node',datasets=dict(root=str(self.hot.root),sources={},uploads={},retireRetentionDays=7),
            storageWarehouse=dict(enabled=True,root=str(self.root/'hdd'/'datasets'),mountPoint=str(self.root/'hdd'),reserveBytes=0),
            storageAuthority={'enabled':True},storageArchive={'enabled':True,'machine':'test-node','authority':'hdd'},
            storageTier={'enabled':True,'budgetBytes':10**7},storageAuthorities={'hdd':{'machine':'test-node'}})
        self.node=SimpleNamespace(CONFIG=self.config,ROOT=self.root/'control',HERE=DEPLOY,
            dataset_cache=lambda:(D,self.hot),dataset_mount_check=lambda config:None,
            workspace=lambda user:self.root/user,dataset_cache_admission=lambda *args,**kwargs:None,
            storage_authority=lambda:self.store,storage_archive=lambda:None)
        self.node.ROOT.mkdir(mode=0o700)
        # Production's factory requires separate, verified mounts. Disposable
        # tests exercise byte/root isolation on one temporary filesystem only.
        real=D.DatasetCache
        with patch.object(D,'DatasetCache',side_effect=lambda root,**kwargs:real(root,**{k:v for k,v in kwargs.items() if k!='mount_point'})):
            self.w=W.Warehouse(self.node)
        self.store=A.AuthorityStore(self.w.cold,'test-node',self.node.ROOT/'authority',principal=ADMIN)
        self.adapter=A.LocalStoredAuthority(self.store,self.hot,self.node.ROOT/'grants')
        self.storage=S.StorageNode(self.hot,policy=self.config['storageTier'],authorities={'hdd':self.adapter})
        self.node.storage_authority=lambda:self.store;self.w.view.storage_authority=self.node.storage_authority
        self.node.storage_node=lambda:self.storage;self.w.cache_view.storage_node=self.node.storage_node
        self.node.dataset_source_cache=lambda dataset=None,version=None:(D,self.w.cold) if dataset in (None,'tiny') else (D,self.hot)
        self.node.dataset_upload_location_cache=lambda:(D,self.w.cold)
        self.node.projects=lambda:SimpleNamespace()
        self.node.atomic_json=D._write_json
        self.node.storage_archive=lambda:None
        self.node.dataset_rebuild_guard_for=lambda *args:contextlib.nullcontext()
        self.w.view.storage_archive=self.node.storage_archive
        data=self.root/'input';data.mkdir();(data/'sample').write_bytes(b'warehouse original')
        self.w.cold.sources['fixture']=data
        manifest=D._scan(data)
        self.version=self.w.cold._register(ADMIN,'tiny',manifest,[OWNER.user_id],'fixture',_origin='upload',_receipt=str(uuid.uuid4()))['version']
        self.w.cold.materialize(OWNER,'tiny',self.version)

    def tearDown(self):
        for folder,_,files in os.walk(self.root):
            os.chmod(folder,0o700)
            for file in files:os.chmod(Path(folder)/file,0o600)
        self.tmp.cleanup()

    def test_archive_declaration_is_forwarded_only_to_fixed_hdd_view(self):
        self.node.CONFIG['datasets']['archiveUpload']={'enabled':True,'maxExpandedBytes':1024,'maxEntries':20}
        real=D.DatasetCache
        with patch.object(D,'DatasetCache',side_effect=lambda root,**kwargs:real(root,**{key:value for key,value in kwargs.items() if key!='mount_point'})):
            warehouse=W.Warehouse(self.node)
        self.assertEqual(warehouse.view.CONFIG['datasets']['archiveUpload'],self.node.CONFIG['datasets']['archiveUpload'])
        self.assertEqual(U.DatasetUploads(warehouse.view).archive.capability()['protocol'],1)
        self.assertIsNone(U.DatasetUploads(self.node).archive.capability(),'The SSD training cache must not claim archive intake')

    def test_hdd_ready_does_not_claim_ssd_ready(self):
        result=self.w.status(OWNER,'tiny',self.version)
        self.assertEqual(result['state'],'REGISTERED');self.assertTrue(result['warehouseReady'])
        self.assertNotIn('storageReference',result)
        self.assertEqual(self.hot.list_datasets(OWNER)['datasets'],[])

    def test_catalog_uses_confirmed_original_while_both_writer_locks_are_held(self):
        with self.hot._locked(), self.w.cold._locked():
            with patch.object(self.w,'status',side_effect=AssertionError('display must not enter strict status')):
                result=self.w.list(OWNER)
        row=result['datasets'][0]['versions'][0]
        self.assertEqual(row['version'],self.version)
        self.assertEqual(row['state'],'REGISTERED');self.assertTrue(row['warehouseReady'])
        self.assertTrue(row['canPrepare']);self.assertTrue(row['warehouseCanPrepare'])
        self.assertNotIn('storageReference',row)
        self.assertEqual(self.w.list(D.Principal('demo-user-4')),{'datasets':[]})

    def test_warm_catalog_never_reparses_cold_or_hot_manifest(self):
        self.w.prepare(OWNER,'tiny',self.version)
        expected=self.w.list(OWNER)
        # Simulate the separate per-RPC cache objects used by the executor.
        self.w.cold=D.DatasetCache(self.w.cold.root,reserve_bytes=0)
        self.w.hot=D.DatasetCache(self.hot.root,reserve_bytes=0)
        with self.hot._locked(),self.w.cold._locked(),\
            patch.object(D,'_manifest_bytes',side_effect=AssertionError('warm catalog manifest parse')),\
            patch.object(D,'_canonical_json_matches',side_effect=AssertionError('warm catalog READY parse')):
            result=self.w.list(OWNER)
        self.assertEqual(result,expected)
        row=result['datasets'][0]['versions'][0]
        self.assertEqual(row['state'],'READY');self.assertTrue(row['warehouseReady'])
        self.assertEqual(row['storageReference'],{'dataset':W.Warehouse.cache_name('tiny'),'version':self.version})

    def test_retirement_fence_between_source_and_permission_hint_rejects_ready(self):
        permissions=self.w.cold.deletion_permissions
        def fence(*args):
            result=permissions(*args)
            folder=self.w.cold.root/'.retirements'/'tiny';D._mkdir(folder)
            D._write_json(folder/(self.version+'.json'),dict(schema=1,protocol='dataset-version-fence-v1',
                rootIdentity=list(self.w.cold._root_identity),dataset='tiny',version=self.version,
                operationId=str(uuid.uuid4()),actor=OWNER.user_id,admin=False,snapshotSha256='a'*64,
                generation='b'*64,state='FENCED',createdAt=0,restoredRegistration=None))
            return result
        with self.w.cold._locked(),patch.object(self.w.cold,'deletion_permissions',side_effect=fence):
            with self.assertRaisesRegex(D.CacheError,'catalog metadata changed'):self.w.list(OWNER)

    def test_cold_unknown_acl_revoked_during_hot_read_is_not_returned(self):
        parent=self.w.cold._paths('tiny',self.version)['ready'].parent
        parent.rename(self.root/'preserved-cold-ready')
        read=self.hot._list_datasets_snapshot
        changed=False
        def revoke(actor):
            nonlocal changed
            result=read(actor)
            if not changed:
                changed=True
                D._write_json(self.w.cold._paths('tiny')['.registry']/'dataset.json',
                    {'schema':1,'owners':['demo-user-4']})
            return result
        with self.w.cold._locked(),patch.object(self.hot,'_list_datasets_snapshot',side_effect=revoke):
            with self.assertRaises((PermissionError,D.CacheError)):self.w.list(OWNER)
        self.assertTrue(changed);self.assertFalse(parent.exists())

    def assert_catalog_unknown(self, warehouse_ready=False):
        result=self.w.list(OWNER)
        row=next(item for item in result['datasets'] if item['dataset']=='tiny')['versions'][0]
        self.assertEqual(row['state'],'UNKNOWN')
        self.assertEqual(row['errorCode'],'CACHE_METADATA_INCOMPLETE')
        self.assertFalse(row['canPrepare']);self.assertIs(row['warehouseReady'],warehouse_ready)
        self.assertIs(row['warehouseCanPrepare'],warehouse_ready);self.assertTrue(row['deletionBlocked'])
        self.assertEqual(row['deletionPermissions'],{'allowed':False,'memberAllowed':False,'reason':'CACHE_METADATA_INCOMPLETE'})
        self.assertNotIn('storageReference',row)
        self.assertEqual((row['bytes'],row['files']),(len(b'warehouse original'),1))
        self.assertNotIn(str(self.root),json.dumps(result))
        return result

    def test_cold_unknown_skips_strict_status_and_permissions_without_repair(self):
        healthy=self.w.cold.register_manifest(ADMIN,'healthy',{'schema':1,'directories':[],'files':[]},[OWNER.user_id])['version']
        self.w.list(OWNER)  # Exercise the existing warm display-summary path.
        parent=self.w.cold._paths('tiny',self.version)['ready'].parent
        preserved=self.root/'preserved-cold-ready';parent.rename(preserved)
        registry=self.w.cold._paths('tiny',self.version)['.registry'].parent/(self.version+'.json')
        before=registry.read_bytes()
        old_status=self.w.status;old_permissions=self.w.cold.deletion_permissions
        def status(actor,dataset,version):
            if dataset=='tiny':raise AssertionError('UNKNOWN cannot enter strict status')
            return old_status(actor,dataset,version)
        def permissions(actor,dataset,version):
            if dataset=='tiny':raise AssertionError('UNKNOWN cannot gain deletion permission')
            return old_permissions(actor,dataset,version)
        with patch.object(self.w,'status',side_effect=status),patch.object(self.w.cold,'deletion_permissions',side_effect=permissions):
            result=self.assert_catalog_unknown()
        row=next(item for item in result['datasets'] if item['dataset']=='healthy')['versions'][0]
        self.assertEqual((row['version'],row['state']),(healthy,'REGISTERED'))
        self.assertFalse(parent.exists());self.assertEqual(registry.read_bytes(),before)
        self.assertEqual((preserved/self.version/'data'/'sample').read_bytes(),b'warehouse original')
        with self.assertRaises(D.CacheMetadataIncomplete):self.w.status(OWNER,'tiny',self.version)
        with self.assertRaises(D.CacheMetadataIncomplete):self.w.prepare(OWNER,'tiny',self.version)
        self.assertFalse(parent.exists())

    def test_fixed_hot_binding_missing_ready_parent_is_display_unknown_only(self):
        self.w.prepare(OWNER,'tiny',self.version)
        physical=W.Warehouse.cache_name('tiny')
        parent=self.hot._paths(physical,self.version)['ready'].parent
        preserved=self.root/'preserved-hot-ready';parent.rename(preserved)
        binding=self.w.bindings/(physical+'-'+self.version+'.json');before=binding.read_bytes()
        with patch.object(self.w.cold,'deletion_permissions',side_effect=AssertionError('UNKNOWN cannot gain deletion permission')):
            self.assert_catalog_unknown(warehouse_ready=True)
        self.assertFalse(parent.exists());self.assertEqual(binding.read_bytes(),before)
        self.assertTrue(self.w.cold._paths('tiny',self.version)['ready'].exists())
        self.assertEqual((preserved/self.version/'data'/'sample').read_bytes(),b'warehouse original')
        with self.assertRaises(D.CacheMetadataIncomplete):self.w.status(OWNER,'tiny',self.version)
        with self.assertRaises(D.CacheMetadataIncomplete):self.hot.plan(OWNER,physical,self.version)
        self.assertFalse(parent.exists())
        self.assertEqual(self.w.list(D.Principal('demo-user-4')),{'datasets':[]})
        with self.assertRaises(PermissionError):self.w.status(D.Principal('demo-user-4'),'tiny',self.version)

    def test_fixed_hot_binding_missing_staging_parent_is_display_unknown_only(self):
        self.w.prepare(OWNER,'tiny',self.version)
        physical=W.Warehouse.cache_name('tiny');self.hot.evict(ADMIN,physical,self.version)
        parent=self.hot._paths(physical,self.version)['.staging'].parent
        parent.rename(self.root/'preserved-hot-staging')
        self.assert_catalog_unknown(warehouse_ready=True)
        self.assertFalse(parent.exists())
        with self.assertRaises(D.CacheMetadataIncomplete):self.w.status(OWNER,'tiny',self.version)
        self.assertTrue(self.w.cold._paths('tiny',self.version)['ready'].exists())

    def broken_hot(self):
        self.w.prepare(OWNER,'tiny',self.version)
        physical=W.Warehouse.cache_name('tiny')
        self.hot._paths(physical,self.version)['ready'].parent.rename(self.root/'preserved-broken-hot')
        return physical

    def test_broken_hot_preserves_cold_proof_across_warm_processes_without_parse(self):
        self.broken_hot();expected=self.assert_catalog_unknown(warehouse_ready=True)
        self.w.hot=D.DatasetCache(self.hot.root,reserve_bytes=0)
        self.w.cold=D.DatasetCache(self.w.cold.root,reserve_bytes=0)
        with self.hot._locked(),self.w.cold._locked(),patch.object(D,'_manifest_bytes',side_effect=AssertionError('warm parsed manifest')):
            self.assertEqual(self.assert_catalog_unknown(warehouse_ready=True),expected)

    def test_broken_hot_does_not_upgrade_unready_cold(self):
        self.broken_hot();ready=self.w.cold._paths('tiny',self.version)['ready']
        # Darwin also requires write access to the moved directory itself.
        # Change only this disposable fixture, not the production READY guard.
        os.chmod(ready.parent,0o700);os.chmod(ready,0o700)
        ready.rename(self.root/'preserved-unready-cold')
        self.assert_catalog_unknown()

    def test_broken_hot_cold_acl_revoked_during_display_rejects(self):
        self.broken_hot();original=self.hot._record_identity
        def revoke(*args,**kwargs):
            result=original(*args,**kwargs)
            D._write_json(self.w.cold._paths('tiny')['.registry']/'dataset.json',{'schema':1,'owners':['demo-user-4']})
            return result
        with patch.object(self.hot,'_record_identity',side_effect=revoke),self.assertRaises((PermissionError,D.CacheError)):
            self.w.list(OWNER)

    def test_broken_hot_cold_ready_changed_during_display_rejects(self):
        self.broken_hot();original=self.hot._record_identity;changed=False
        ready=self.w.cold._paths('tiny',self.version)['ready']
        os.chmod(ready.parent,0o700);os.chmod(ready,0o700)
        def move(*args,**kwargs):
            nonlocal changed
            result=original(*args,**kwargs)
            if not changed:
                changed=True;self.w.cold._paths('tiny',self.version)['ready'].rename(self.root/'preserved-cold-changed')
            return result
        with patch.object(self.hot,'_record_identity',side_effect=move),self.assertRaises(D.CacheError):self.w.list(OWNER)

    def test_broken_hot_cold_retirement_fence_rejects(self):
        self.broken_hot();original=self.hot._record_identity;changed=False
        def fence(*args,**kwargs):
            nonlocal changed
            result=original(*args,**kwargs)
            if not changed:
                changed=True;folder=self.w.cold.root/'.retirements'/'tiny';D._mkdir(folder)
                D._write_json(folder/(self.version+'.json'),dict(schema=1,protocol='dataset-version-fence-v1',
                    rootIdentity=list(self.w.cold._root_identity),dataset='tiny',version=self.version,
                    operationId=str(uuid.uuid4()),actor=OWNER.user_id,admin=False,snapshotSha256='a'*64,
                    generation='b'*64,state='FENCED',createdAt=0,restoredRegistration=None))
            return result
        with patch.object(self.hot,'_record_identity',side_effect=fence),self.assertRaises(D.CacheError):self.w.list(OWNER)

    def test_corrupt_cold_registration_is_not_display_unknown(self):
        parent=self.w.cold._paths('tiny',self.version)['ready'].parent
        parent.rename(self.root/'preserved-cold-ready')
        registry=self.w.cold._paths('tiny',self.version)['.registry'].parent/(self.version+'.json')
        registry.write_text('{}')
        with self.assertRaisesRegex(D.CacheError,'corrupt version registration'):self.w.list(OWNER)
        self.assertFalse(parent.exists())

    def test_corrupt_hot_registration_is_not_display_unknown(self):
        self.w.prepare(OWNER,'tiny',self.version)
        physical=W.Warehouse.cache_name('tiny')
        parent=self.hot._paths(physical,self.version)['ready'].parent
        parent.rename(self.root/'preserved-hot-ready')
        registry=self.hot._paths(physical,self.version)['.registry'].parent/(self.version+'.json')
        registry.write_text('{}')
        with self.assertRaisesRegex(D.CacheError,'corrupt version registration'):self.w.list(OWNER)
        self.assertFalse(parent.exists())

    def test_corrupt_binding_is_not_display_unknown(self):
        self.w.prepare(OWNER,'tiny',self.version)
        physical=W.Warehouse.cache_name('tiny')
        D._write_json(self.w.bindings/(physical+'-'+self.version+'.json'),{})
        with self.assertRaisesRegex(ValueError,'binding changed'):self.w.list(OWNER)

    def test_unsafe_hot_parent_link_is_not_display_unknown(self):
        self.w.prepare(OWNER,'tiny',self.version)
        parent=self.hot._paths(W.Warehouse.cache_name('tiny'),self.version)['ready'].parent
        preserved=self.root/'preserved-hot-ready';parent.rename(preserved)
        parent.symlink_to(preserved,target_is_directory=True)
        with self.assertRaises((D.CacheError,OSError)):self.w.list(OWNER)
        self.assertTrue(parent.is_symlink())

    def test_upload_factory_writes_only_fixed_hdd(self):
        uploads=U.DatasetUploads(self.w.view)
        self.assertEqual(uploads.cache.root,self.w.cold.root)
        self.assertFalse(uploads.cache_only())
        self.assertTrue(self.node.CONFIG['storageTier']['enabled'])
        self.assertFalse((self.hot.root/'.uploads').exists())

    def test_private_location_proves_hdd_without_creating_upload(self):
        key=str(uuid.uuid4())
        result=I.locate(self.node,dict(userId=OWNER.user_id,uploadId=key))
        self.assertTrue(result['authority']['enabled']);self.assertFalse(result['present'])
        self.assertFalse((self.hot.root/'.uploads').exists())
        self.assertFalse((self.w.cold.root/'.uploads').exists())

    def test_download_lease_reads_and_releases_hdd_not_training_cache(self):
        args=dict(id=str(uuid.uuid4()),userId=OWNER.user_id,
            reference=dict(kind='datasets',dataset='tiny',version=self.version))
        leases=L.StorageLeases(self.node)
        self.assertEqual(leases.download_open(args)['state'],'OPEN')
        self.assertTrue(self.w.cold._leases('tiny',self.version))
        self.assertEqual(self.hot._leases('tiny',self.version),[])
        result=leases.download_export('datasets.snapshot.get',{**args,'path':'sample','offset':0})
        self.assertEqual(__import__('base64').b64decode(result['data']),b'warehouse original')
        self.assertTrue(leases.download_finish({**args,'state':'COMPLETED'})['released'])
        self.assertEqual(self.w.cold._leases('tiny',self.version),[])

    def test_same_node_prepare_evict_restart_recover_and_fixed_reference(self):
        result=self.w.prepare(OWNER,'tiny',self.version)
        physical=W.Warehouse.cache_name('tiny')
        self.assertEqual(result['state'],'READY')
        self.assertEqual(result['storageReference'],{'dataset':physical,'version':self.version})
        self.assertEqual((self.hot._paths(physical,self.version)['ready']/'data'/'sample').read_bytes(),b'warehouse original')
        with self.hot._locked():self.assertEqual(self.hot._tier(physical,self.version)['role'],'cache')
        self.hot.evict(ADMIN,physical,self.version)
        self.assertEqual(self.w.status(OWNER,'tiny',self.version)['state'],'REGISTERED')
        self.storage.tier.recover(ADMIN,physical,self.version)
        self.assertEqual(self.w.status(OWNER,'tiny',self.version)['state'],'READY')
        refs=self.storage.tier.retirement_references(ADMIN,physical,self.version)
        self.assertEqual(refs[0]['sourceMachine'],refs[0]['targetMachine'])
        self.assertEqual(refs[0]['sourceDataset'],'tiny')

    def test_public_remote_self_grant_still_rejected(self):
        with self.assertRaisesRegex(ValueError,'another target'):
            self.store.seal(ADMIN,'tiny',self.version,str(uuid.uuid4()),'test-node')
        with self.assertRaisesRegex(ValueError,'another machine'):
            A.RemoteAuthority('test-node',{},self.root/'remote',target_machine='test-node')

    def test_other_owner_cannot_prepare_or_claim_local_cache(self):
        with self.assertRaises(PermissionError):self.w.prepare(D.Principal('demo-user-4'),'tiny',self.version)
        self.assertEqual(self.hot.list_datasets(ADMIN)['datasets'],[])

    def test_fixed_policy_no_public_role_or_path_overrides(self):
        self.config['storageWarehouse']['role']='hdd'
        with self.assertRaises(ValueError):W.policy(self.node)

    def test_workspace_publication_cannot_create_an_ssd_original(self):
        with self.assertRaises(PermissionError):DW.DataWorkspaces(self.node).publish({})
        # The factory's HDD view retains the ordinary validation contract.
        with self.assertRaises(ValueError):DW.DataWorkspaces(self.w.view).publish({'userId':OWNER.user_id})

    def test_two_roots_retirement_preserves_source_until_target_isolated(self):
        self.w.prepare(OWNER,'tiny',self.version)
        physical=W.Warehouse.cache_name('tiny')
        source=self.w.retirement(dataset='tiny',version=self.version)
        target=self.w.retirement(dataset=physical,version=self.version)
        source.retirement.clock_synchronized=target.retirement.clock_synchronized=lambda:True
        sid,tid=str(uuid.uuid4()),str(uuid.uuid4())
        self.assertEqual(self.w.retirement(dataset='tiny',version=self.version,operation_id=sid).cache.root,self.w.cold.root)
        self.assertEqual(self.w.retirement(dataset=physical,version=self.version,operation_id=tid).cache.root,self.hot.root)
        splan=source.plan(OWNER,'tiny',self.version,sid)
        tplan=target.plan(OWNER,physical,self.version,tid)
        self.assertIsNotNone(splan['authority']);self.assertEqual(len(tplan['authorityReferences']),1)
        source.fence(OWNER,sid);target.fence(OWNER,tid)
        self.assertTrue(self.w.cold._paths('tiny',self.version)['ready'].exists())
        isolated=target.isolate(OWNER,tid,[])
        done=source.isolate(OWNER,sid,[isolated])
        self.assertTrue(done['isolated']);self.assertTrue(isolated['isolated'])
        self.assertNotEqual(source.cache.root,target.cache.root)
        self.assertEqual(self.w.retirement(operation_id=sid).cache.root,self.w.cold.root)
        self.assertEqual(self.w.retirement(operation_id=tid).cache.root,self.hot.root)

    def test_source_retirement_without_target_receipt_keeps_both_roots(self):
        self.w.prepare(OWNER,'tiny',self.version)
        source=self.w.retirement(dataset='tiny',version=self.version)
        source.retirement.clock_synchronized=lambda:True
        sid=str(uuid.uuid4())
        source.plan(OWNER,'tiny',self.version,sid)
        with self.assertRaises(ValueError):source.isolate(OWNER,sid,[])
        self.assertTrue(self.w.cold._paths('tiny',self.version)['ready'].exists())
        self.assertTrue(self.hot._paths(W.Warehouse.cache_name('tiny'),self.version)['ready'].exists())

    def test_retirement_restore_can_prepare_again_without_reviving_old_grant(self):
        self.w.prepare(OWNER,'tiny',self.version)
        physical=W.Warehouse.cache_name('tiny')
        old_proof=self.hot._tier(physical,self.version)['recovery']['proof']
        source=self.w.retirement(dataset='tiny',version=self.version)
        target=self.w.retirement(dataset=physical,version=self.version)
        source.retirement.clock_synchronized=target.retirement.clock_synchronized=lambda:True
        sid,tid=str(uuid.uuid4()),str(uuid.uuid4())
        source.plan(OWNER,'tiny',self.version,sid);target.plan(OWNER,physical,self.version,tid)
        source.fence(OWNER,sid);target.fence(OWNER,tid)
        isolated=target.isolate(OWNER,tid,[]);source.isolate(OWNER,sid,[isolated])
        restored=source.restore(ADMIN,sid,_cancel_uncommitted=True)
        target.release_absence(ADMIN,tid,restored)
        result=self.w.prepare(OWNER,'tiny',self.version)
        self.assertEqual(result['state'],'READY')
        new_proof=self.hot._tier(physical,self.version)['recovery']['proof']
        self.assertNotEqual(old_proof['grantId'],new_proof['grantId'])
        with self.assertRaises(PermissionError):
            with self.adapter.guard(ADMIN,old_proof):pass
        with self.adapter.guard(ADMIN,new_proof):pass


F=module('warehouse_node_routing_fixture','../tests/node-datasets.test.py')


class LegacyCacheRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.fixture=F.NodeDatasets();self.fixture.setUp()
        self.node=self.fixture.node
        self.node.CONFIG['storageTier']={'enabled':True,'budgetBytes':1024**3}

    def tearDown(self):
        try:self.fixture.tearDown()
        finally:self.fixture.doCleanups()

    def test_public_legacy_source_registration_is_blocked_for_cache_nodes(self):
        with self.assertRaises(PermissionError):
            self.node.dataset_op('datasets.register',dict(userId='builtin-admin',hostAdmin=True,
                dataset='blocked',sourceId='approved',owners=['demo-user-1']))
        self.assertFalse(self.fixture.cache._paths('blocked')['.registry'].exists())

    def test_old_registration_worker_cannot_continue_writing_an_ssd_registry(self):
        folder=self.node.ROOT/'dataset-ops';folder.mkdir()
        task=dict(op='register',dataset='blocked',sourceId='approved',owners=['demo-user-1'],
            userId='builtin-admin',hostAdmin=True)
        key=hashlib.sha256(json.dumps(task,sort_keys=True).encode()).hexdigest()
        self.node.atomic_json(folder/(key+'.json'),task)
        self.assertEqual(self.node.dataset_worker(key),1)
        self.assertEqual(json.loads((folder/(key+'.result.json')).read_text())['state'],'FAILED')
        self.assertFalse(self.fixture.cache._paths('blocked')['.registry'].exists())


if __name__=='__main__':unittest.main()
