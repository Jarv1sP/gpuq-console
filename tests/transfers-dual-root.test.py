"""Real TLS copies into disposable, distinct HDD/cache roots; no services."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from storage_test_helpers import local_data_mounts

HERE=Path(__file__).resolve().parent
DEPLOY=HERE.parent/'deploy'


def module(name,path):
    definition=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(definition);definition.loader.exec_module(value)
    return value


F=module('dual_root_transfer_fixture',HERE/'transfers.test.py')
TF=module('dual_root_training_fixture',HERE/'training-preparation-worker.test.py')
U=module('dual_root_uploads',DEPLOY/'dataset-upload.py')


def dual_roots(test,node,jobs):
    d,hot=node.dataset_cache()
    cold=d.DatasetCache(node.HERE/'warehouse',reserve_bytes=0)
    node.CONFIG.update(storageWarehouse={'enabled':True},storageAuthority={'enabled':True},
                       storageTier={'enabled':True,'budgetBytes':2**30},
                       storageArchive={'enabled':True,'machine':'gpu-2','authority':'local-hdd'},
                       storageAuthorities={'remote-hdd':{'machine':'gpu-1'}})
    node.transfers=lambda:jobs
    cache_view=SimpleNamespace(**vars(node));cache_view.storage_authority=lambda:None
    cold_view=SimpleNamespace(**vars(node));cold_view.CONFIG={**node.CONFIG,'storageTier':{'enabled':False},
        'datasets':{**node.CONFIG['datasets'],'root':str(cold.root)}}
    cold_view.dataset_cache=lambda:(d,cold)
    cold_uploads=U.DatasetUploads(cold_view)
    warehouse=SimpleNamespace(hot=hot,cold=cold,cache_view=cache_view)
    guards=[patch.object(node,'storage_warehouse',return_value=warehouse),
            patch.object(node,'dataset_uploads',return_value=cold_uploads),
            patch.object(node,'dataset_cache_admission',return_value={'evicted':[]}),
            patch.object(cold_uploads,'active',return_value=True)]
    for guard in guards:guard.start();test.addCleanup(guard.stop)
    hot_uploads=node.dataset_training_uploads()
    guard=patch.object(hot_uploads,'active',return_value=True);guard.start();test.addCleanup(guard.stop)
    return warehouse,cold_uploads,hot_uploads


class DualRootCopy(unittest.TestCase):
    def setUp(self):
        self.f=F.Transfers();self.f.setUp();self.addCleanup(self.f.tearDown);self.addCleanup(self.f.fixture.doCleanups)
        self.node,self.jobs=self.f.target,self.f.dst
        self.w,self.cold,self.hot=dual_roots(self,self.node,self.jobs)

    def test_manual_prepare_real_tls_hits_only_hot_root_and_exact_spec_digest(self):
        self.jobs.start(self.f.args);spec=self.jobs.load(self.f.key)
        self.assertEqual(spec['targetStorage']['root'],str(self.w.hot.root))
        self.assertEqual(spec['targetStorage']['rootIdentity'],list(self.w.hot._root_identity))
        self.assertEqual(spec['targetStorage']['mount'],list(self.w.hot.mount))
        self.assertEqual(spec['digest'],F.T.digest({k:spec[k] for k in
            ('userId','sourceMachine','source','name','reference','timeoutSec','targetStorage')}))
        self.assertEqual(self.jobs.worker(self.f.key,1),0,self.jobs.load(self.f.key,'.result.json'))
        result=self.jobs.status(self.f.control())
        self.assertEqual(result['state'],'SUCCEEDED')
        self.assertEqual(self.hot.load(F.USER,self.f.key)['state'],'READY')
        self.assertFalse(self.cold.folder(F.USER,self.f.key).exists())
        self.assertEqual(list((self.w.cold.root/'.registry').iterdir()),[])
        data=self.w.hot._paths(result['dataset'],result['version'])['ready']/'data'/'sample.txt'
        self.assertEqual(data.read_bytes(),(self.f.source.HERE/'source'/'sample.txt').read_bytes())
        before=self.jobs.load(self.f.key);self.jobs.start(self.f.args)
        self.assertEqual(self.jobs.load(self.f.key),before)

    def test_resume_keeps_hot_root_and_rejects_root_or_volume_change(self):
        self.jobs.start(self.f.args);spec=self.jobs.load(self.f.key)
        self.node.atomic_json(self.jobs.path(self.f.key,'.result.json'),{'attempt':1,'state':'PAUSED'})
        with local_data_mounts(*(self.f.fixture.root/str(i) for i in range(2)),mount_id_offset=20):
            with self.assertRaisesRegex(ValueError,'mount changed'):self.jobs.resume(self.f.control())
        root=self.w.hot.root;offline=root.with_name(root.name+'-offline')
        root.rename(offline);root.mkdir()
        try:
            with self.assertRaisesRegex(ValueError,'root changed'):self.jobs.resume(self.f.control())
        finally:root.rmdir();offline.rename(root)
        self.jobs.resume({**self.f.control(),'source':self.f.args['source']})
        resumed=self.jobs.load(self.f.key)
        self.assertEqual(resumed['targetStorage'],spec['targetStorage'])
        self.assertEqual(resumed['digest'],spec['digest'])
        self.assertEqual(self.jobs.worker(self.f.key,2),0,self.jobs.load(self.f.key,'.result.json'))
        self.assertFalse(self.cold.folder(F.USER,self.f.key).exists())

    def test_old_journal_retries_same_hdd_ingress_without_new_root_binding(self):
        self.node.CONFIG['storageWarehouse']['enabled']=False
        self.jobs.start(self.f.args);old=self.jobs.load(self.f.key)
        self.assertNotIn('targetStorage',old)
        source=old['source']
        self.jobs.upload(old,'begin',name=old['name'],key=self.f.key,
                         **{k:source[k] for k in ('manifestBytes','manifestSha256','totalBytes','entries')})
        self.assertTrue(self.cold.folder(F.USER,self.f.key).exists())
        self.node.CONFIG['storageWarehouse']['enabled']=True
        self.node.atomic_json(self.jobs.path(self.f.key,'.result.json'),{'attempt':1,'state':'PAUSED'})
        self.jobs.resume({**self.f.control(),'source':self.f.args['source']})
        self.assertNotIn('targetStorage',self.jobs.load(self.f.key))
        self.assertEqual(self.jobs.worker(self.f.key,2),0,self.jobs.load(self.f.key,'.result.json'))
        self.assertEqual(self.cold.load(F.USER,self.f.key)['state'],'READY')
        self.assertFalse(self.hot.folder(F.USER,self.f.key).exists())

    def test_request_cannot_supply_root_and_archive_lane_never_selects_cache(self):
        with self.assertRaisesRegex(ValueError,'Invalid LAN transfer'):
            self.jobs.start({**self.f.args,'targetStorage':{'root':'/tmp/other'}})
        self.assertIsNone(self.jobs.new_target_storage({**self.f.args,'archiveLane':{}}))
        self.jobs.start(self.f.args);spec=self.jobs.load(self.f.key)
        altered={**spec,'targetStorage':{**spec['targetStorage'],'root':'/tmp/other'}}
        with self.assertRaisesRegex(ValueError,'target changed'):self.jobs.target_uploads(altered)

    def test_new_non_authority_copy_rejected_before_journal_or_hdd_session(self):
        self.node.CONFIG['storageAuthorities']={}
        with self.assertRaisesRegex(PermissionError,'authoritative warehouse'):
            self.jobs.start(self.f.args)
        self.assertFalse(self.jobs.path(self.f.key).exists())
        self.assertFalse(self.cold.folder(F.USER,self.f.key).exists())
        self.assertFalse(self.hot.folder(F.USER,self.f.key).exists())
        self.assertEqual(self.f.calls,[])

    def test_bound_target_is_not_an_authority_bypass(self):
        self.jobs.start(self.f.args);spec=self.jobs.load(self.f.key)
        self.node.CONFIG['storageAuthorities']={}
        with self.assertRaises(PermissionError):
            with self.hot._peer_cache_preparation(spec):pass
        with self.assertRaises(PermissionError):self.jobs.resume(self.f.control())
        self.assertFalse(self.cold.folder(F.USER,self.f.key).exists())

    def test_missing_bound_root_is_not_misread_as_a_missing_journal(self):
        self.jobs.start(self.f.args)
        before=self.jobs.path(self.f.key).read_bytes();calls=len(self.f.calls)
        root=self.w.hot.root;offline=root.with_name(root.name+'-offline')
        root.rename(offline)
        try:
            with self.assertRaises(FileNotFoundError):self.jobs.start(self.f.args)
            self.assertEqual(self.jobs.path(self.f.key).read_bytes(),before)
            self.assertEqual(len(self.f.calls),calls)
            self.assertFalse(root.exists())
        finally:offline.rename(root)


class DualRootTraining(TF.TrainingTransfer):
    # Run inherited original-journal regression tests too. This class adds one
    # actual bound training-worker transfer through the new cache adapter.
    def test_training_prepare_real_tls_uses_hot_session_and_retains_job_binding(self):
        warehouse,cold,hot=dual_roots(self,self.node,self.jobs)
        self.call('transfers.start',self.f.args)
        spec=self.jobs.load(self.f.key)
        self.assertEqual(spec['digest'],F.T.digest({k:spec[k] for k in
            ('userId','sourceMachine','source','name','reference','timeoutSec','targetStorage')}))
        binding=TF.H.read(self.jobs.path(self.f.key,'.training.json'))
        actual=module('dual_worker_plan',DEPLOY/'training-storage.py')
        utility=importlib.util.spec_from_file_location
        plans=[]
        def loader(name,path,*args,**kwargs):
            definition=utility(name,path,*args,**kwargs)
            if name=='gpuq_training_training_storage':
                class PlanLoader:
                    def create_module(self,s):return None
                    def exec_module(self,m):
                        m.validate=actual.validate
                        m.plan=lambda n,a,**kw:(plans.append(copy.deepcopy(a)) or {'fits':True,'noReclaim':True})
                definition.loader=PlanLoader()
            return definition
        campus_route=TF.F.T.PeerClient.campus_route
        with (patch('importlib.util.spec_from_file_location',side_effect=loader),
              patch.object(TF.F.T.PeerClient,'campus_route',side_effect=campus_route) as route):
            self.assertEqual(self.jobs.worker(self.f.key,1,require_training=True),0,self.jobs.load(self.f.key,'.result.json'))
            self.assertGreater(route.call_count,1,'bound cache writes must retain repeated campus route checks')
        self.assertEqual(hot.load(F.USER,self.f.key)['state'],'READY')
        self.assertFalse(cold.folder(F.USER,self.f.key).exists())
        self.assertEqual(TF.H.transfer_binding(self.node,self.f.key),binding)
        self.assertEqual(self.jobs.load(self.f.key),spec)
        self.assertEqual(plans[0]['datasets'][0]['version'],self.f.version)

    def test_bound_cache_transfer_cannot_use_legacy_worker_or_retarget_hdd(self):
        warehouse,cold,hot=dual_roots(self,self.node,self.jobs)
        self.call('transfers.start',self.f.args)
        spec=self.jobs.load(self.f.key)
        binding=TF.H.read(self.jobs.path(self.f.key,'.training.json'))
        with (patch.object(TF.F.T.PeerClient,'call',side_effect=AssertionError('no source RPC')),
              patch.object(self.jobs,'upload',side_effect=AssertionError('no target payload'))):
            self.assertEqual(self.jobs.worker(self.f.key,1),1)
        self.assertIn('cannot use a legacy worker',self.jobs.status(self.f.control())['error'])
        self.assertEqual(self.jobs.load(self.f.key),spec)
        self.assertEqual(TF.H.transfer_binding(self.node,self.f.key),binding)
        self.assertFalse(hot.folder(F.USER,self.f.key).exists())
        self.assertFalse(cold.folder(F.USER,self.f.key).exists())


if __name__=='__main__':unittest.main()
