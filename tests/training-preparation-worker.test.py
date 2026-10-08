"""Original transfer journals and actual local TLS bytes; no nodes or GPUs."""
import copy
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import uuid

HERE=Path(__file__).resolve().parent
DEPLOY=HERE.parent/'deploy'


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value


F=module('training_transfer_fixture',HERE/'transfers.test.py')
H=module('training_prepare_helper',DEPLOY/'training-preparation.py')


class TrainingTransfer(unittest.TestCase):
    def setUp(self):
        self.f=F.Transfers();self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.addCleanup(self.f.fixture.doCleanups)
        self.node,self.jobs=self.f.target,self.f.dst
        # The real pinned local TLS fixture is not a campus interface. Keep its
        # route as explicit fake kernel metadata; campus rejection/route-change
        # tests exercise the real verifier separately, never production peers.
        self.route_patch=patch.object(F.T.PeerClient,'campus_route',return_value={'device':'fixture-physical','source':'127.0.0.1','gateway':None})
        self.route_patch.start();self.addCleanup(self.route_patch.stop)
        self.node.transfers=lambda:self.jobs
        for name in ('training-preparation.py','training-storage.py'):
            shutil.copy2(DEPLOY/name,self.node.HERE/name)
        self.job={'id':str(uuid.uuid4()),'userId':F.USER,'username':'alice','cards':1,'argv':['python','train.py'],
                  'name':'training','minVramGiB':0,'datasets':[{'dataset':'shared','version':self.f.version}]}
        manifest=self.f.source.dataset_cache()[1].export_manifest(self.f.source.dataset_cache()[0].Principal(F.USER,False),'shared',self.f.version)['manifest']
        self.request={'userId':F.USER,'hostAdmin':False,'datasets':self.job['datasets'],'datasetReadMode':'cache','projectFootprint':None,
                      'datasetFootprints':[{'dataset':'shared','version':self.f.version,'bytes':self.f.args['source']['totalBytes'],
                                            'manifestBytes':self.f.args['source']['manifestBytes'],'files':len(manifest['files']),
                                            'directories':len(manifest['directories'])}]}
        self.envelope={'job':self.job,'planRequest':self.request,'preparation':{'protocol':1,'id':self.f.key,'kind':'transfer',
                       'sourceMachine':'gpu-1','targetMachine':'gpu-2','logicalReference':self.job['datasets'][0],
                       'reference':self.job['datasets'][0]},'operation':'transfers.start','args':self.f.args}
        self.plans=[]
        self.plan_patch=patch.object(H,'admission',side_effect=lambda node,binding,physical=None:self.plans.append(copy.deepcopy((binding,physical))))
        self.plan_patch.start();self.addCleanup(self.plan_patch.stop)

    def call(self,operation,args=None):
        return H.dispatch(self.node,{**self.envelope,'operation':operation,'args':args or self.f.control()})

    def test_real_copy_uses_forced_training_worker_and_keeps_original_digest_session(self):
        self.call('transfers.start',self.f.args)
        spec=self.jobs.load(self.f.key)
        self.assertEqual(spec['digest'],F.T.digest({k:spec[k] for k in ('userId','sourceMachine','source','name','reference','timeoutSec')}))
        self.assertEqual(self.f.calls[0][-3],'--training-transfer-worker')
        real_plan=module('actual_worker_plan',self.node.HERE/'training-storage.py')
        observed=[]
        # Worker imports its own helper. Intercept only the expensive plan; its
        # full schema/binding validation and real source/upload guards stay real.
        utility=importlib.util.spec_from_file_location
        def spec_loader(name,path,*a,**kw):
            spec=utility(name,path,*a,**kw)
            if name=='gpuq_training_training_storage':
                class Loader:
                    def create_module(self,s):return None
                    def exec_module(self,m):
                        m.validate=real_plan.validate
                        m.plan=lambda n,args,**kw:(observed.append(copy.deepcopy(args)) or {'fits':True,'noReclaim':True})
                spec.loader=Loader()
            return spec
        with patch('importlib.util.spec_from_file_location',side_effect=spec_loader),patch.object(self.node,'storage_node',side_effect=AssertionError('never collect')):
            self.assertEqual(self.jobs.worker(self.f.key,1,require_training=True),0)
        result=self.jobs.status(self.f.control())
        self.assertEqual(result['state'],'SUCCEEDED')
        self.assertEqual(result['version'],self.f.version)
        self.assertEqual(self.jobs.load(self.f.key),spec)
        self.assertEqual(observed[0]['datasets'][0],{'dataset':result['dataset'],'version':self.f.version})
        session=self.node.dataset_uploads().load(F.USER,self.f.key)
        self.assertEqual(session['state'],'READY')
        self.assertEqual(self.plans[0][0]['preparation']['id'],self.f.key)

    def test_missing_bound_sidecar_cannot_fall_back_to_legacy_payload_worker(self):
        self.call('transfers.start',self.f.args)
        self.jobs.path(self.f.key,'.training.json').unlink()
        with (patch.object(F.T.PeerClient,'call',side_effect=AssertionError('no source RPC')),
                patch.object(self.jobs,'upload',side_effect=AssertionError('no target payload'))):
            self.assertEqual(self.jobs.worker(self.f.key,1,require_training=True),1)
        self.assertIn('Missing training receipt',self.jobs.status(self.f.control())['error'])

    def test_marked_sidecar_cannot_use_legacy_worker_entry(self):
        self.call('transfers.start',self.f.args)
        with patch.object(F.T.PeerClient,'call',side_effect=AssertionError('no source RPC')):
            self.assertEqual(self.jobs.worker(self.f.key,1),1)
        self.assertIn('cannot use a legacy worker',self.jobs.status(self.f.control())['error'])

    def test_mismatch_owner_reference_runtime_and_legacy_journal_rejected(self):
        for mutate in (lambda a:a['args'].update(userId='demo-user-2'),lambda a:a['preparation'].update(targetMachine='gpu-3'),
                       lambda a:a['preparation']['reference'].update(version='a'*64),lambda a:a['job'].update(datasetReadMode='warehouse')):
            bad=copy.deepcopy(self.envelope);mutate(bad)
            with self.assertRaises(ValueError):H.dispatch(self.node,bad)
        self.assertFalse(self.jobs.path(self.f.key).exists());self.assertEqual(self.f.calls,[])
        self.jobs.start(self.f.args)
        with self.assertRaisesRegex(ValueError,'Legacy transfer'):self.call('transfers.start',self.f.args)

    def test_lost_launch_ack_observes_same_attempt_and_cancel_never_restarts(self):
        with patch.object(self.node,'run',side_effect=OSError('lost launch ACK')) as run:
            self.call('transfers.start',self.f.args)
            self.call('transfers.start',self.f.args)
        self.assertEqual(run.call_count,1);self.assertEqual(self.jobs.load(self.f.key)['attempt'],1)
        self.f.active=True
        self.assertEqual(self.call('transfers.cancel')['state'],'CANCELING')
        with self.assertRaises(ValueError):self.call('transfers.resume')
        self.f.active=False
        self.assertEqual(self.call('transfers.cancel')['state'],'CANCELED')
        with self.assertRaises(ValueError):self.call('transfers.start',self.f.args)

    def test_concurrent_same_operation_starts_once_and_retains_one_journal(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _:self.call('transfers.start',self.f.args),range(2)))
        self.assertEqual(len(self.f.calls),1)
        self.assertEqual(self.jobs.load(self.f.key)['attempt'],1)
        self.assertEqual(H.read(self.jobs.path(self.f.key,'.training.json'))['job'],self.job)

    def test_worker_capacity_change_and_footprint_mismatch_write_no_payload_or_gc(self):
        self.call('transfers.start',self.f.args)
        utility=importlib.util.spec_from_file_location
        actual=module('worker_plan_validator',DEPLOY/'training-storage.py')
        def spec_loader(name,path,*a,**kw):
            spec=utility(name,path,*a,**kw)
            if name=='gpuq_training_training_storage':
                class Loader:
                    def create_module(self,s):return None
                    def exec_module(self,m):
                        m.validate=actual.validate;m.plan=lambda n,args,**kw:{'fits':False,'noReclaim':True}
                spec.loader=Loader()
            return spec
        with (patch('importlib.util.spec_from_file_location',side_effect=spec_loader),
              patch.object(self.jobs,'upload',side_effect=AssertionError('no payload')),
              patch.object(self.node,'storage_node',side_effect=AssertionError('no reclaim'))):
            self.assertEqual(self.jobs.worker(self.f.key,1,require_training=True),1)
        self.assertIn('capacity changed',self.jobs.status(self.f.control())['error'])
        self.assertFalse(self.node.dataset_uploads().folder(F.USER,self.f.key).exists())

    def test_existing_upload_credit_is_private_fixed_and_validated_under_plan_lock(self):
        self.call('transfers.start',self.f.args)
        spec=self.jobs.load(self.f.key);source=spec['source']
        state=self.jobs.upload(spec,'begin',name=spec['name'],key=self.f.key,
                               **{k:source[k] for k in ('manifestBytes','manifestSha256','totalBytes','entries')})
        uploads=self.node.dataset_uploads();reservation=uploads.reservation(F.USER,self.f.key)
        before=reservation.read_bytes()
        binding=H.read(self.jobs.path(self.f.key,'.training.json'))
        physical={'dataset':'u-'+__import__('hashlib').sha256(F.USER.encode()).hexdigest()[:16]+'-'+spec['name'],'version':self.f.version}
        validator=module('worker_credit_validator',DEPLOY/'training-storage.py')
        d,cache=self.node.dataset_cache()
        def plan(n,args,**kw):
            with cache._locked():
                self.assertTrue(kw['_existing_upload'](physical,args['datasetFootprints'][0]))
                wrong={**args['datasetFootprints'][0],'bytes':source['totalBytes']+1}
                with self.assertRaisesRegex(ValueError,'identity changed'):kw['_existing_upload'](physical,wrong)
            return {'fits':True,'noReclaim':True}
        self.plan_patch.stop()
        with patch.object(H,'load',return_value=type('Plan',(),{'validate':staticmethod(validator.validate),'plan':staticmethod(plan)})):
            H.admission(self.node,binding,physical)
        self.assertEqual(reservation.read_bytes(),before)


if __name__=='__main__':unittest.main()
