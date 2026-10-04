"""Explicit yield bridge and original core consent matrix, no GPU/SSH."""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'gpuq'))
from gpuq.policy import VictimCandidate,select_victims,preemption_mode
spec=importlib.util.spec_from_file_location('policy_test',ROOT/'deploy/scheduling-policy.py')
P=importlib.util.module_from_spec(spec);spec.loader.exec_module(P)

class ExplicitPolicy(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        for name in ('platform-root-guard.py','node-executor.py','scheduling-policy.py'):shutil.copy2(ROOT/'deploy'/name,self.root/name)
        (self.root/'control').mkdir();(self.root/'sdk.pyz').touch();(self.root/'training-control.py').touch();(self.root/'sandbox-runner.py').write_text('# gpuq_training_control')
        config={'root':str(self.root/'state'),'cards':4,'gpu':'/not/a/gpu','database':str(self.root/'db'),'controlRoot':str(self.root/'control'),'gpuqArchive':str(self.root/'sdk.pyz')}
        (self.root/'node-config.json').write_text(json.dumps(config))
        with closing(sqlite3.connect(config['database'])) as db:db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT)');db.commit()
        spec=importlib.util.spec_from_file_location('explicit_node_test',self.root/'node-executor.py');self.node=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.node)
        self.policy={'rank':'P1','yieldPolicy':'save','restartPolicy':'on-preempt','checkpointable':True}
        self.job={'id':str(uuid.uuid4()),'userId':'demo-user-1','username':'alice','cards':1,'argv':['python','train.py'],'name':'test','minVramGiB':0,'scheduling':self.policy}
        self.commands=[]
        def run(command,**_):
            args=command[2:];self.commands.append(args)
            if args[0]=='status':return json.dumps({'daemon':{'capabilities':['priority-policy-v1','preempt-idle-only-v1']}})
            if args[0]=='submit':return json.dumps({'job_id':'Jabc'})
            if args[0]=='show':return json.dumps({'job':{'state':'PENDING','priority':1,'yield_policy':'save','restart_policy':'on-preempt','dispatch_mode':'queue'},'attempts':[]})
            raise AssertionError(args)
        mock=patch.object(self.node,'run',side_effect=run);mock.start();self.addCleanup(mock.stop)

    def test_node_forwards_exact_policy_without_enrolling_legacy_jobs(self):
        with patch.object(self.node.SCHEDULING,'ready',return_value=True):
            self.node.process('sync',{'job':self.job})
        submit=next(cmd for cmd in self.commands if cmd[0]=='submit')
        self.assertEqual(submit[3:12],['-p','P1','-m','queue','--yield','save','--restart-policy','on-preempt','--checkpointable'])
        self.assertNotIn('--preempt-idle-only',submit)
        self.assertEqual(submit[submit.index('--submit-key')+1],self.job['id'])

    def test_node_requires_live_control_readiness(self):
        (self.root/'training-control.py').unlink()
        with self.assertRaisesRegex(ValueError,'not ready'):self.node.process('sync',{'job':self.job})
        self.assertNotIn('submit',[cmd[0] for cmd in self.commands])

    def test_requester_mode_requires_live_native_scope_capability(self):
        request={**self.job,'scheduling':{**self.policy,'mode':'preempt-now'}}
        with patch.object(self.node.SCHEDULING,'ready',return_value=True),self.assertRaisesRegex(ValueError,'capability'):
            self.node.process('sync',{'job':request})
        self.assertNotIn('submit',[cmd[0] for cmd in self.commands])

    def test_requester_mode_is_forwarded_with_native_opt_in_guard(self):
        commands=self.commands
        original=self.node.run
        def run(command,**kwargs):
            if command[2]=='status':
                commands.append(command[2:]);return json.dumps({'daemon':{'capabilities':['priority-policy-v1','preempt-idle-only-v1','preempt-opt-in-only-v1']}})
            return original(command,**kwargs)
        request={**self.job,'scheduling':{**self.policy,'mode':'preempt-save'}}
        with patch.object(self.node.SCHEDULING,'ready',return_value=True),patch.object(self.node,'run',side_effect=run):
            self.node.process('sync',{'job':request})
        submitted=next(cmd for cmd in commands if cmd[0]=='submit')
        self.assertEqual(submitted[submitted.index('-m')+1],'preempt-save')
        self.assertIn('--preempt-opt-in-only',submitted);self.assertIn('--checkpointable',submitted)

    def test_node_rejects_mixed_or_incomplete_contract(self):
        for policy in ({**self.policy,'checkpointable':False},{**self.policy,'yieldPolicy':'now'},{**self.policy,'rank':'P5'},{'rank':'P1'}):
            with self.subTest(policy=policy),self.assertRaises(ValueError):self.node.validate_job({**self.job,'scheduling':policy})
        with self.assertRaises(ValueError):self.node.validate_job({**self.job,'priority':'idle','preemptIdleOnly':True})

    def test_queue_honors_explicit_lower_rank_now_and_save_but_never_legacy(self):
        for yielding in ('never','legacy','now','save'):
            for priority in range(5):
                victim=VictimCandidate('A1','J1',priority,1,'epoch-v1',yield_policy=yielding)
                selected=select_victims(requester_priority=3,requester_gpu_count=1,free_gpu_count=0,dispatch_mode='queue',candidates=[victim])
                self.assertEqual(bool(selected),priority<3 and yielding in ('now','save'))
                if selected:self.assertEqual(preemption_mode('queue',victim),'preempt-save' if yielding=='save' else 'preempt-now')

    def test_finished_preemption_is_not_mislabeled_as_manual_cancel(self):
        self.assertTrue(self.node.scheduling_status(self.job,{'job':{'state':'CANCELED'},'attempts':[{'state':'PREEMPTED'}]})['preempted'])
        self.assertFalse(self.node.scheduling_status(self.job,{'job':{'state':'PENDING'},'attempts':[{'state':'PREEMPTED'}]})['preempted'])

if __name__=='__main__':unittest.main()
