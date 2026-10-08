"""Original copy journals, local TLS fixture and fake kernel route metadata."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import Mock,patch

HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
F=load('training_project_copy_fixture',HERE/'project-copy.test.py')
H=load('training_project_preparation',HERE.parent/'deploy/training-preparation.py')
S=load('training_project_storage_schema',HERE.parent/'deploy/training-storage.py')

class TrainingProjectPreparation(unittest.TestCase):
    def setUp(self):
        self.fixture=F.ProjectCopyTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.src,self.dst=self.fixture.src,self.fixture.dst;self.jobid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        for node,copies in ((self.fixture.source,self.src),(self.fixture.target,self.dst)):
            node.validate_job=Mock();node.dataset_read_mode=lambda job:job.get('datasetReadMode','cache')
            node.project_copies=lambda copies=copies:copies
        self.fixture.source.CONFIG['transferPeers']={'gpu-2':{'address':'192.168.77.4','port':18443,'certificateSha256':'a'*64}}
        probe=self.src.probe({'userId':F.USER,'project':F.PROJECT,'release':self.fixture.release})
        self.footprint={key:probe[key] for key in ('image','architecture','codeBytes','codeEntries','imageUnpackedBytes')}
        self.footprint.update(sourceMachine='gpu-1',imageEntries=4)
        original_probe=self.src.probe
        self.addCleanup(patch.stopall)
        patch.object(self.src,'probe',side_effect=lambda args:{**original_probe(args),'imageEntries':4}).start()
        self.plan=Mock(return_value={'fits':True,'noReclaim':True})
        self.storage=SimpleNamespace(validate=S.validate,plan=self.plan)
        original_load=H.load
        patch.object(H,'load',side_effect=lambda node,name:self.storage if name=='training-storage' else F.C.t if name=='transfer-jobs' else original_load(node,name)).start()
        self.route={'device':'eth-fixture','source':'127.0.0.1','gateway':None}
        patch.object(F.C.t.PeerClient,'campus_route',return_value=self.route).start()
        for copies in (self.src,self.dst):patch.object(copies,'training_helper',return_value=H).start()
        self.job={'id':self.jobid,'userId':F.USER,'username':'alice','cards':1,'argv':['train'],'name':'fixture','minVramGiB':0,
                  'project':F.PROJECT,'release':self.fixture.release}
        self.request={'userId':F.USER,'hostAdmin':False,'project':F.PROJECT,'release':self.fixture.release,
                      'datasetReadMode':'cache','datasets':[],'datasetFootprints':[],'projectFootprint':self.footprint}
        self.prep={'protocol':1,'id':self.fixture.key,'kind':'project','sourceMachine':'gpu-1','targetMachine':'gpu-2',
                   'reference':{'project':F.PROJECT,'release':self.fixture.release}}
    def envelope(self,operation,args):
        return {'job':copy.deepcopy(self.job),'planRequest':copy.deepcopy(self.request),'preparation':copy.deepcopy(self.prep),'operation':operation,'args':args}
    def prepare(self):
        return H.project_dispatch(self.fixture.source,self.envelope('projects.copy.prepare',
            {'id':self.fixture.key,'userId':F.USER,'project':F.PROJECT,'release':self.fixture.release,'targetMachine':'gpu-2'}))
    def start(self):
        self.prepare();self.assertEqual(self.src.worker(self.fixture.key,1,require_training=True),0)
        ticket=self.prepare()['source']
        args={'id':self.fixture.key,'userId':F.USER,'project':F.PROJECT,'release':self.fixture.release,'sourceMachine':'gpu-1','source':ticket}
        return H.project_dispatch(self.fixture.target,self.envelope('projects.copy.start',args)),args
    def test_original_uuid_private_receipt_precedes_same_runtime_one_shot_worker(self):
        first,args=self.start();self.assertEqual(first['state'],'UNKNOWN')
        self.assertEqual(len(self.fixture.calls),2)
        self.assertTrue(all(command[-3:] == ['--training-project-copy-worker',self.fixture.key,'1'] for command in self.fixture.calls))
        self.assertEqual(H.project_dispatch(self.fixture.target,self.envelope('projects.copy.start',args))['id'],self.fixture.key)
        self.assertEqual(len(self.fixture.calls),2)
        self.assertEqual(self.dst.worker(self.fixture.key,1,require_training=True),0)
        with self.assertRaisesRegex(ValueError,'cannot restart implicitly'):
            self.dst.worker(self.fixture.key,1,require_training=True)
        self.assertEqual(self.dst.status({'id':self.fixture.key,'userId':F.USER})['state'],'SUCCEEDED')
        self.fixture.target.projects().store.release(F.USER,F.PROJECT,self.fixture.release)
        callback=self.plan.call_args.kwargs['_existing_project_copy'];self.assertTrue(callback(self.dst.load(self.fixture.key)))
        changed=self.dst.load(self.fixture.key);changed['attempt']=2;self.assertFalse(callback(changed))
    def test_capacity_or_campus_route_failure_never_launches_target_or_reclaims(self):
        self.prepare();self.assertEqual(self.src.worker(self.fixture.key,1,require_training=True),0);ticket=self.prepare()['source']
        args={'id':self.fixture.key,'userId':F.USER,'project':F.PROJECT,'release':self.fixture.release,'sourceMachine':'gpu-1','source':ticket}
        self.plan.return_value={'fits':False,'noReclaim':True}
        with self.assertRaisesRegex(ValueError,'capacity changed'):H.project_dispatch(self.fixture.target,self.envelope('projects.copy.start',args))
        self.assertFalse(self.dst.path(self.fixture.key).exists());self.assertEqual(len(self.fixture.calls),1)
        self.plan.return_value={'fits':True,'noReclaim':True}
        with patch.object(F.C.t.PeerClient,'campus_route',side_effect=ValueError('tunnel')):
            with self.assertRaisesRegex(ValueError,'tunnel'):H.project_dispatch(self.fixture.target,self.envelope('projects.copy.start',args))
        self.assertEqual(len(self.fixture.calls),1)
    def test_legacy_or_mismatched_binding_cannot_be_upgraded_or_use_bare_rpc(self):
        args={'id':self.fixture.key,'userId':F.USER,'project':F.PROJECT,'release':self.fixture.release,'targetMachine':'gpu-2'}
        self.src.prepare(args)
        with self.assertRaisesRegex(ValueError,'Legacy'):self.prepare()
        self.assertEqual(len(self.fixture.calls),1)
        self.src.path(self.fixture.key).unlink()
        with self.assertRaisesRegex(ValueError,'Legacy'):self.prepare()
        self.fixture.key=str(uuid.uuid4());self.prep['id']=self.fixture.key;args['id']=self.fixture.key
        self.prepare();changed=self.envelope('projects.copy.prepare',args);changed['job']['argv']=['changed']
        with self.assertRaisesRegex(ValueError,'context changed'):H.project_dispatch(self.fixture.source,changed)
        with self.assertRaisesRegex(ValueError,'private context'):self.src.process('projects.copy.status',{'id':self.fixture.key,'userId':F.USER})
    def test_cancel_original_worker_requires_real_stop_and_fences_delayed_start(self):
        self.start();unit=self.dst.unit(self.fixture.key,1);self.fixture.states[unit]=True
        control={'id':self.fixture.key,'userId':F.USER}
        result=H.project_dispatch(self.fixture.target,self.envelope('projects.copy.cancel',control))
        self.assertFalse(result['cleaned'])
        self.fixture.states[unit]=False
        self.assertTrue(H.project_dispatch(self.fixture.target,self.envelope('projects.copy.cancel',control))['cleaned'])
        self.assertEqual(self.dst.worker(self.fixture.key,1,require_training=True),1)
    def test_foreign_owner_target_spec_or_runtime_rejects_without_launch(self):
        args={'id':self.fixture.key,'userId':F.USER,'project':F.PROJECT,'release':self.fixture.release,'targetMachine':'gpu-2'}
        for field,value in (('userId','demo-user-24'),('targetMachine','gpu-3'),('project','other')):
            with self.subTest(field=field):
                changed=dict(args);changed[field]=value
                with self.assertRaises(ValueError):H.project_dispatch(self.fixture.source,self.envelope('projects.copy.prepare',changed))
        self.assertEqual(self.fixture.calls,[])
        self.prepare();path=self.src.path(self.fixture.key,'.training.json');binding=H.read(path);binding['runtime']='/another/immutable/cohort'
        self.fixture.source.atomic_json(path,binding)
        self.assertEqual(self.src.worker(self.fixture.key,1,require_training=True),1)
    def test_missing_primary_journal_never_guesses_unknown_worker_stopped(self):
        control={'id':self.fixture.key,'userId':F.USER}
        for active in (True,None):
            self.fixture.states[self.dst.unit(self.fixture.key,1)]=active
            with self.assertRaisesRegex(ValueError,'unconfirmed original worker'):
                H.project_dispatch(self.fixture.target,self.envelope('projects.copy.cancel',control))
            self.assertFalse(self.dst.path(self.fixture.key,'.training.json').exists())
        self.fixture.states[self.dst.unit(self.fixture.key,1)]=False
        self.assertTrue(H.project_dispatch(self.fixture.target,self.envelope('projects.copy.cancel',control))['cleaned'])
        self.assertEqual(self.fixture.calls,[])
    def test_lost_journal_with_any_legacy_or_bound_history_rejects_empty_cleanup(self):
        control={'id':self.fixture.key,'userId':F.USER}
        for suffix in ('.result.json','.progress.json','.grant.json','.cleanup.json','.worker.lock','.started-1'):
            with self.subTest(suffix=suffix):
                path=self.dst.path(self.fixture.key,suffix);path.write_text('{}');path.chmod(0o600)
                with self.assertRaises(ValueError):H.project_dispatch(self.fixture.target,self.envelope('projects.copy.cancel',control))
                path.unlink()
        self.assertFalse(self.dst.path(self.fixture.key,'.cancel').exists());self.assertEqual(self.fixture.calls,[])

class CampusPeerRoute(unittest.TestCase):
    def setUp(self):
        self.peer=F.C.t.PeerClient({'address':'192.168.77.3','port':18443,'certificateSha256':'a'*64},{})
    def test_exact_physical_route_is_required_and_never_discovers_another_peer(self):
        done=subprocess.CompletedProcess([],0,stdout=json.dumps([{'dev':'enp1s0','prefsrc':'192.168.77.4'}]))
        with patch.object(F.C.t.subprocess,'run',return_value=done) as run,patch.object(Path,'is_file',return_value=True),patch.object(Path,'exists',return_value=True):
            self.assertEqual(self.peer.campus_route(),{'device':'enp1s0','source':'192.168.77.4','gateway':None})
            self.assertEqual(run.call_args.args[0][-4:],['-j','route','get','192.168.77.3'])
    def test_tunnel_loopback_missing_source_or_unknown_device_fails_closed(self):
        for route in ({'dev':'tailscale0','prefsrc':'192.168.77.4'},{'dev':'wg0','prefsrc':'192.168.77.4'},
                      {'dev':'lo','prefsrc':'127.0.0.1'},{'dev':'enp1s0'}):
            with self.subTest(route=route),patch.object(F.C.t.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=json.dumps([route]))),patch.object(Path,'is_file',return_value=True),patch.object(Path,'exists',return_value=True):
                with self.assertRaises(ValueError):self.peer.campus_route()
        self.peer.config['address']='127.0.0.1'
        with self.assertRaises(ValueError):self.peer.campus_route()
    def test_connection_binds_campus_source_and_route_change_sends_no_ticket(self):
        self.peer.campus_only=True
        connection=Mock();connection.sock.getpeercert.return_value=b'certificate';connection.sock.getsockname.return_value=('192.168.77.4',40000)
        self.peer.config['certificateSha256']=F.hashlib.sha256(b'certificate').hexdigest()
        before={'device':'enp1s0','source':'192.168.77.4','gateway':None};after={**before,'device':'tailscale0'}
        with patch.object(self.peer,'campus_route',side_effect=[before,after]),patch.object(F.C.t.http.client,'HTTPSConnection',return_value=connection) as create:
            with self.assertRaisesRegex(ValueError,'route changed'):self.peer.connect()
        self.assertEqual(create.call_args.kwargs['source_address'],('192.168.77.4',0));connection.close.assert_called_once();connection.request.assert_not_called()
    def test_keepalive_route_change_is_checked_before_a_payload_request(self):
        self.peer.campus_only=True;self.peer.campus_binding={'device':'enp1s0','source':'192.168.77.4','gateway':None}
        connection=Mock();connection.sock.getsockname.return_value=('192.168.77.4',40000);self.peer.connection=connection
        with patch.object(self.peer,'campus_route',return_value={'device':'tailscale0','source':'192.168.77.4','gateway':None}):
            with self.assertRaisesRegex(ValueError,'route changed'):self.peer.call('get',path='file',offset=0)
        connection.request.assert_not_called();connection.close.assert_called_once();self.assertIsNone(self.peer.connection)

if __name__=='__main__':unittest.main()
