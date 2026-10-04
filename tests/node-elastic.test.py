"""Elastic bridge admission and actual resource budgets, no real GPU/systemd."""
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
from gpuq.elastic import compatible_world_sizes,plan_elastic_batch

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

P=load('allocation_policy',ROOT/'deploy/scheduling-policy.py')
R=load('allocation_resources',ROOT/'deploy/job-resources.py')

class Elastic(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.job={'id':str(uuid.uuid4()),'userId':'demo-user-1','username':'alice','cards':8,'argv':['python','train.py'],'name':'test','minVramGiB':0,'scheduling':{'rank':'P1','yieldPolicy':'save','restartPolicy':'on-preempt','checkpointable':True},'elastic':{'minCards':1,'globalBatch':256,'microBatch':8,'autoExpand':True}}

    def test_exact_counts_match_native_sdk_and_effective_batch_at_each_count(self):
        for target,micro in ((256,8),(240,8),(2**53-1,2**53-1)):
            self.job['elastic'].update(globalBatch=target,microBatch=micro,autoExpand=False)
            allowed=P.elastic_allocation(self.job)
            self.assertEqual(allowed,list(compatible_world_sizes(target,micro,1,8)))
            for n in allowed:
                plan=plan_elastic_batch(target,micro,world_size=n)
                self.assertEqual(plan.effective_global_batch_size,target)

    def test_actual_allocation_drives_limits_without_mutating_reserved_spec(self):
        for n in (1,2,4,8):
            current=P.allocated_spec(self.job,[str(i) for i in range(n)],['GPU-'+str(i) for i in range(n)])
            self.assertEqual(R.requested_limits(current),{'cpu':n*4,'memory':n*32*R.GIB,'pids':2048})
            self.assertEqual(self.job['cards'],8)
        for indices,uuids in ((['0','1','2'],['GPU-0','GPU-1','GPU-2']),(['0','0'],['GPU-0','GPU-1']),(['0','1'],['GPU-0','GPU-0'])):
            with self.assertRaises(ValueError):P.allocated_spec(self.job,indices,uuids)

    def test_bridge_forwards_maximum_minimum_batch_and_checkpoint_expand_exactly(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name in ('platform-root-guard.py','node-executor.py','scheduling-policy.py'):shutil.copy2(ROOT/'deploy'/name,root/name)
            config={'root':str(root/'state'),'cards':8,'gpu':'/not/a/gpu','database':str(root/'db')};(root/'node-config.json').write_text(json.dumps(config))
            with closing(sqlite3.connect(config['database'])) as db:db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT)');db.commit()
            node=load('elastic_node_test',root/'node-executor.py');commands=[]
            def run(command,**_):
                args=command[2:];commands.append(args)
                if args[0]=='status':return json.dumps({'daemon':{'capabilities':['priority-policy-v1','preempt-idle-only-v1','elastic-batch-v1']}})
                if args[0]=='submit':return json.dumps({'job_id':'Jabc'})
                if args[0]=='show':return json.dumps({'job':{'state':'PENDING'},'attempts':[]})
                raise AssertionError(args)
            with patch.object(node,'run',side_effect=run),patch.object(node.SCHEDULING,'ready',return_value=True),patch.object(node.SCHEDULING,'allocation_ready',return_value=True):node.process('sync',{'job':self.job})
            submitted=next(c for c in commands if c[0]=='submit')
            self.assertEqual(submitted[1:12],['-g','8','--elastic-start','--min-gpus','1','--global-batch','256','--micro-batch','8','--auto-expand','-p'])
            self.assertIn('--checkpointable',submitted);self.assertIn('on-preempt',submitted)

    def test_old_runner_cannot_claim_allocation_capability(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'sandbox-runner.py').write_text('TRAINING_CONTROL_PROTOCOL=1\n')
            with patch.object(P,'ready',return_value=True):self.assertFalse(P.allocation_ready({},root))
            (root/'sandbox-runner.py').write_text('GPU_ALLOCATION_PROTOCOL=1\n')
            with patch.object(P,'ready',return_value=True):self.assertTrue(P.allocation_ready({},root))

if __name__=='__main__':unittest.main()
