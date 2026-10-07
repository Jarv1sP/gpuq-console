"""Isolated certified-copy controls, no node access, services, or user data."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
T = module('cache_action_test_tier', 'deploy/dataset-tier.py')
C = module('cache_action_test_actions', 'deploy/dataset-cache-actions.py')
D = T.D
ADMIN, OWNER, OTHER = D.Principal('admin', True), D.Principal('owner'), D.Principal('other')


class CacheActionsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        source = self.root / 'source';source.mkdir();(source / 'item').write_bytes(b'warehouse original')
        self.hot = D.DatasetCache(self.root / 'hot', sources={'approved': source}, reserve_bytes=0)
        self.cold = D.DatasetCache(self.root / 'cold', sources={'approved': source}, reserve_bytes=0)
        self.version = self.hot.register_source(ADMIN, 'sample', 'approved', ['owner'])['version']
        self.cold.register_source(ADMIN, 'sample', 'approved', ['owner'])
        self.hot.materialize(OWNER, 'sample', self.version);self.cold.materialize(OWNER, 'sample', self.version)
        self.tier = T.DatasetTier(self.hot, authorities={'hdd': T.LocalAuthority(self.cold)})
        self.launched=[];self.running=set();self.native=[]
        self.node = C.CacheActionNode(D, self.hot, self.tier, self.root / 'control',
            prepare=lambda *args: self.native.append(args) or dict(operationId='a'*64,state='PREPARING'),
            prepare_identity=lambda *args:'a'*64,
            observe_prepare=lambda *args:dict(operationId='a'*64,dataset='sample',version=self.version,state='PREPARING'),
            cancel_prepare=lambda *args:True,
            launch=lambda key:self.launched.append(key) or self.running.add(key),
            active=lambda key:key in self.running,
            stop=lambda key:self.running.discard(key) or True)
    def tearDown(self):
        for folder, dirs, files in os.walk(self.root):
            os.chmod(folder,0o700)
            for name in files:
                if not (Path(folder)/name).is_symlink():os.chmod(Path(folder)/name,0o600)
        self.tmp.cleanup()
    def certify(self):self.tier.verify_authority(ADMIN,'sample',self.version,'hdd')
    def start(self, action='release', key=None):
        key=key or str(uuid.uuid4())
        return self.node.start(OWNER, action, 'sample', self.version, key)
    def test_member_can_release_only_certified_copy_and_original_registration_survives(self):
        self.certify();out=self.start();self.assertEqual(out['state'],'RUNNING')
        self.assertEqual(self.node.release_worker(out['key']),0)
        self.assertEqual(self.node.status(OWNER,out['key'])['state'],'RELEASED')
        self.assertNotEqual(self.hot.status(OWNER,'sample',self.version)['state'],'READY')
        self.assertEqual(self.cold.status(OWNER,'sample',self.version)['state'],'READY')
        self.assertTrue((self.hot.root/'.registry'/'sample'/(self.version+'.json')).exists())
        self.assertEqual(self.node.start(OWNER,'release','sample',self.version,out['key'])['state'],'RELEASED')
        self.assertEqual(len(self.launched),1)
    def test_protected_legacy_and_original_are_blocked_even_for_admin(self):
        self.assertFalse(self.node.capabilities(OWNER,'sample',self.version)['release'])
        out=self.start();self.assertEqual(out['state'],'BLOCKED');self.assertEqual(out['errorCode'],'CACHE_NOT_CERTIFIED')
        self.assertEqual(len(self.launched),0)
        self.assertEqual(self.hot.status(OWNER,'sample',self.version)['state'],'READY')
    def test_pin_lease_staging_and_unavailable_authority_never_release(self):
        self.certify()
        self.hot.pin(ADMIN,'sample',self.version,'manual')
        self.assertEqual(self.start()['errorCode'],'CACHE_PINNED')
        self.hot.unpin(ADMIN,'sample',self.version,'manual')
        lease=self.hot.acquire_lease(OWNER,'sample',self.version,'job')
        self.assertEqual(self.start()['errorCode'],'CACHE_IN_USE')
        self.hot.release_lease(ADMIN,'sample',self.version,lease['leaseId'])
        staging=self.hot._paths('sample',self.version)['.staging'];staging.mkdir()
        self.assertEqual(self.start()['errorCode'],'CACHE_STAGING_UNKNOWN');staging.rmdir()
        with patch.object(self.tier.authorities['hdd'],'guard',side_effect=OSError('offline')):
            self.assertEqual(self.start()['errorCode'],'CACHE_AUTHORITY_UNCONFIRMED')
        self.assertEqual(self.hot.status(OWNER,'sample',self.version)['state'],'READY')
    def test_final_checks_reject_a_lease_added_after_capability_read(self):
        self.certify();out=self.start();self.hot.acquire_lease(OWNER,'sample',self.version,'later-job')
        self.assertEqual(self.node.release_worker(out['key']),1)
        self.assertEqual(self.node.status(OWNER,out['key'])['state'],'BLOCKED')
        self.assertEqual(self.hot.status(OWNER,'sample',self.version)['state'],'READY')
    def test_cancel_before_release_does_not_remove_data_and_is_idempotent(self):
        self.certify();out=self.start();self.assertEqual(self.node.cancel(OWNER,out['key'])['state'],'CANCELED')
        self.node.release_worker(out['key']);self.assertEqual(self.hot.status(OWNER,'sample',self.version)['state'],'READY')
        self.assertEqual(self.node.cancel(OWNER,out['key'])['state'],'CANCELED')
    def test_lost_launch_reply_only_observes_original_worker_and_unknown_stop_is_not_success(self):
        self.certify()
        def lost(key):self.running.add(key);self.launched.append(key);raise OSError('lost reply')
        self.node.launch=lost;out=self.start();self.assertEqual(out['state'],'UNKNOWN')
        self.assertEqual(self.node.start(OWNER,'release','sample',self.version,out['key'])['state'],'RUNNING')
        self.assertEqual(len(self.launched),1)
        self.node.stop=lambda key:False
        self.assertEqual(self.node.cancel(OWNER,out['key'])['state'],'UNKNOWN')
        self.assertEqual(self.hot.status(OWNER,'sample',self.version)['state'],'READY')
    def test_cleanup_failure_keeps_uncertain_operation_not_false_release_or_cancel(self):
        self.certify();out=self.start()
        with patch.object(self.hot,'_remove_quarantined',side_effect=OSError('cleanup failed')):
            self.assertEqual(self.node.release_worker(out['key']),1)
        self.running.clear()
        self.assertEqual(self.node.status(OWNER,out['key'])['state'],'UNKNOWN')
        self.assertEqual(self.node.cancel(OWNER,out['key'])['state'],'UNKNOWN')
        self.assertEqual(self.cold.status(OWNER,'sample',self.version)['state'],'READY')
    def test_identity_and_fields_are_fixed_and_cross_owner_cannot_observe_or_cancel(self):
        out=self.start('prepare')
        for action in ('status','cancel'):
            with self.assertRaises(PermissionError):getattr(self.node,action)(OTHER,out['key'])
        with self.assertRaises(ValueError):self.node.start(OWNER,'release','sample',self.version,out['key'])
        for key in ('path','owner','hostAdmin','proof','source'):
            with self.assertRaises(ValueError):self.node.dispatch(OWNER,'prepare',dict(dataset='sample',version=self.version,key=str(uuid.uuid4()),**{key:True}))
        self.assertEqual(len(self.native),1)
    def test_prepare_status_never_relaunches_and_current_unknown_is_not_historical_ready(self):
        out=self.start('prepare')
        self.node.observe_prepare=lambda *args:dict(operationId='a'*64,dataset='sample',version=self.version,state='READY')
        self.assertEqual(self.node.status(OWNER,out['key'])['state'],'READY')
        self.node.observe_prepare=lambda *args:dict(operationId='a'*64,dataset='sample',version=self.version,state='UNKNOWN')
        self.assertEqual(self.node.status(OWNER,out['key'])['state'],'UNKNOWN')
        self.assertEqual(len(self.native),1)
    def test_two_actions_sharing_training_prepare_cannot_stop_shared_worker(self):
        first=self.start('prepare');second=self.start('prepare')
        stopped=[]
        self.node.cancel_prepare=lambda *args:stopped.append(args) or True
        for key in (first['key'],second['key']):
            result=self.node.cancel(OWNER,key)
            self.assertEqual(result['errorCode'],'CACHE_SHARED_WORKER')
            self.assertFalse(result['canCancel'])
        self.assertEqual(stopped,[])
        self.assertEqual(self.node.status(OWNER,first['key'])['state'],'RUNNING')
    def test_absent_target_registration_still_advertises_prepare_protocol_for_existing_transfer(self):
        caps=self.node.capabilities(OWNER,'not-local',self.version)
        self.assertEqual(caps['protocol'],1)
        self.assertTrue(caps['prepare'])
        self.assertFalse(caps['release'])
    def test_fresh_warehouse_original_without_cache_binding_is_not_deadlocked_by_capability_probe(self):
        warehouse=SimpleNamespace(contains=lambda *args:True,cache_name=lambda dataset:'wc-exact',
                                  binding=lambda *args:(_ for _ in ()).throw(FileNotFoundError()))
        executor=SimpleNamespace(dataset_cache=lambda:(D,self.hot),storage_node=lambda:SimpleNamespace(tier=self.tier),
                                 ROOT=self.root,HERE=ROOT/'deploy',storage_warehouse=lambda:warehouse)
        adapter=C.from_executor(executor)
        caps=adapter.capabilities(OWNER,'sample',self.version)
        self.assertTrue(caps['prepare'])
        self.assertFalse(caps['release'])
    def test_shared_owner_prepare_binds_actual_worker_and_observes_without_raw_id_acl_bypass(self):
        version=self.hot.register_source(ADMIN,'shared','approved',['owner','other'])['version']
        worker={'id':'b'*64,'state':'PREPARING'}
        calls=[]
        def dataset_op(operation,args):
            calls.append((operation,dict(args)))
            self.assertFalse(args['hostAdmin'])
            if 'operationId' in args:
                # The existing public operationId endpoint remains owner-only.
                raise PermissionError('shared worker belongs to another owner')
            self.assertEqual((args['dataset'],args['version']),('shared',version))
            current=self.hot.status(D.Principal(args['userId']),args['dataset'],args['version'])
            return {**current,'state':worker['state'],'operationId':worker['id']}
        executor=SimpleNamespace(dataset_cache=lambda:(D,self.hot),storage_node=lambda:SimpleNamespace(tier=self.tier),
                                 ROOT=self.root,HERE=ROOT/'deploy',storage_warehouse=lambda:None,dataset_op=dataset_op)
        adapter=C.from_executor(executor)
        key=str(uuid.uuid4())
        started=adapter.start(OTHER,'prepare','shared',version,key)
        self.assertEqual(started['state'],'RUNNING')
        self.assertEqual(adapter._read(OTHER,key)['nativeId'],worker['id'])
        self.assertEqual(adapter.status(OTHER,key)['state'],'RUNNING')
        # Restart observes the same durable identity and never dispatches work.
        restarted=C.from_executor(executor)
        self.assertEqual(restarted.status(OTHER,key)['state'],'RUNNING')
        self.assertEqual(restarted.cancel(OTHER,key)['errorCode'],'CACHE_SHARED_WORKER')
        self.assertFalse(any('operationId' in args for _,args in calls))
        self.assertEqual(sum(op=='datasets.prepare' for op,_ in calls),1)
        # A later worker cannot silently replace this original action binding.
        worker['id']='c'*64
        self.assertEqual(restarted.status(OTHER,key)['state'],'UNKNOWN')
        self.assertEqual(restarted._read(OTHER,key)['nativeId'],'b'*64)
        self.assertEqual(sum(op=='datasets.prepare' for op,_ in calls),1)
        # READY remains a current authorized cache fact, not a worker history.
        worker['state']='READY'
        self.assertEqual(restarted.status(OTHER,key)['state'],'READY')
        D._write_json(self.hot._paths('shared')['.registry']/'dataset.json',dict(schema=D.SCHEMA,owners=['owner']))
        self.assertEqual(restarted.status(OTHER,key)['state'],'UNKNOWN')
    def test_prepare_rejects_untrusted_native_identity_and_request_override(self):
        self.node.prepare=lambda *args:dict(operationId='not-a-worker',state='PREPARING')
        out=self.start('prepare')
        self.assertEqual(out['state'],'UNKNOWN')
        self.assertEqual(self.node._read(OWNER,out['key'])['nativeId'],'a'*64)
        with self.assertRaises(ValueError):
            self.node.dispatch(OWNER,'prepare',dict(dataset='sample',version=self.version,key=str(uuid.uuid4()),nativeId='b'*64))


if __name__=='__main__':unittest.main()
