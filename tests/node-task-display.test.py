"""Real Node executor + native CLI parsing/Coordinator/SQLite, no GPU starts."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[1];DEPLOY=ROOT/'deploy'
loader=importlib.util.spec_from_file_location('display_node_fixture',Path(__file__).with_name('gpuq-priority.test.py'))
F=importlib.util.module_from_spec(loader);loader.loader.exec_module(F)
from gpuq import cli

class NodeDisplay(unittest.TestCase):
    snapshot=F.SchedulerPriorityTests.snapshot
    submit=F.SchedulerPriorityTests.submit
    running=F.SchedulerPriorityTests.running
    def setUp(self):
        F.SchedulerPriorityTests.setUp(self)
        folder=self.root/'node';folder.mkdir()
        for name in ('node-executor.py','scheduling-policy.py','task-display.py'):shutil.copy2(DEPLOY/name,folder/name)
        self.configNode={'root':str(folder/'state'),'cards':4,'gpu':'/not/a/gpu','database':str(self.config.db_path)}
        (folder/'node-config.json').write_text(json.dumps(self.configNode))
        spec=importlib.util.spec_from_file_location('node_display_under_test',folder/'node-executor.py');self.node=importlib.util.module_from_spec(spec);sys.modules[spec.name]=self.node;spec.loader.exec_module(self.node)
        self.commands=[];self.node.gpu=self.gpu
        self.job={'id':str(uuid.uuid4()),'userId':'demo-user-8','username':'刘鹏亮','cards':1,
            'argv':['python','train.py'],'name':'fashion-hm-teachers0-20261003','minVramGiB':0}
        self.meta={'name':self.job['name'],'description':'任务内容','submitter':{'name':'刘鹏亮','username':'刘鹏亮'}}
    def gpu(self,*argv):
        self.commands.append(argv)
        if argv[0] in ('show','status'):return self.coordinator.handle_api(argv[0],{'job_id':argv[1]} if argv[0]=='show' else {})
        if argv[0]=='cancel':return self.coordinator.handle_api('cancel',{'job_id':argv[1]})
        parsed=cli.build_parser().parse_args(['--json',*argv])
        client=SimpleNamespace(call=self.coordinator.handle_api)
        if argv[0]=='submit':
            with patch.object(cli.Config,'from_json',return_value=self.config):
                _,submission=cli.prepare_submission(parsed)
            return client.call('submit',submission)
        if argv[0]=='set-display':
            with patch.object(cli,'get_client',return_value=client),patch.object(cli,'print_result') as output:
                parsed.func(parsed);return output.call_args.args[0]
        raise AssertionError(argv)
    def test_new_submit_and_existing_running_backfill_have_identical_specs_and_one_native_job(self):
        spec=deepcopy(self.job);result=self.node.process('sync',{'job':self.job,'metadata':self.meta})
        self.assertEqual(result['displaySync']['state'],'SYNCED');native=self.store.get_job(result['nodeJobId'])
        self.assertEqual(native['owner'],self.node.gpuq_owner(self.job));self.assertEqual(native['name'],'portal-'+self.job['id'][:8])
        self.assertEqual(native['display_metadata'],self.meta);self.assertEqual(self.job,spec)
        self.assertEqual(json.loads((self.node.ROOT/'jobs'/(self.job['id']+'.json')).read_text()),spec)
        again=self.node.process('sync',{'job':self.job,'metadata':self.meta});self.assertEqual(again['nodeJobId'],result['nodeJobId'])
        self.assertEqual(sum(c[0]=='submit' for c in self.commands),1);self.assertEqual(sum(c[0]=='set-display' for c in self.commands),1)
        self.store._get_connection().execute("UPDATE jobs SET display_json='{}' WHERE id=?",(native['id'],))
        self.store.update_job(native['id'],state='RUNNING');before=self.store.get_job(native['id'])
        repaired=self.node.process('sync',{'job':self.job,'metadata':self.meta});self.assertEqual(repaired['state'],'RUNNING')
        self.assertEqual(sum(c[0]=='submit' for c in self.commands),1);self.assertEqual(self.store.get_job(native['id'])['updated_at'],before['updated_at'])
    def test_wrong_name_or_submitter_rejected_before_submit_and_stored_spec_change(self):
        for meta in ({**self.meta,'name':'another'},{**self.meta,'submitter':{'name':'其他人','username':'other'}}):
            with self.assertRaisesRegex(ValueError,'another'):self.node.process('sync',{'job':self.job,'metadata':meta})
        self.assertEqual(self.commands,[]);self.assertEqual(self.store.list_jobs(),[])
    def test_display_rpc_failure_keeps_real_training_state_and_cancel_functional(self):
        real=self.node.gpu
        def fail(*args):
            if args[0]=='set-display':raise ValueError('display unavailable')
            return real(*args)
        self.node.gpu=fail
        result=self.node.process('sync',{'job':self.job,'metadata':self.meta});self.assertEqual(result['state'],'PENDING');self.assertEqual(result['displaySync']['state'],'UNAVAILABLE')
        canceled=self.node.process('cancel',{'job':self.job,'metadata':self.meta});self.assertEqual(canceled['state'],'CANCELED')
        self.assertEqual(sum(c[0]=='submit' for c in self.commands),1)
    def test_old_portal_request_never_uses_display_command(self):
        result=self.node.process('sync',{'job':self.job});self.assertNotIn('displaySync',result);self.assertFalse(any(c[0]=='set-display' for c in self.commands))

if __name__=='__main__':unittest.main()
