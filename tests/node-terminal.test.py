"""Native SQLite cancel/show -> node drain confirmation; no live GPU/systemd."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
import uuid

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'gpuq'))
from gpuq.backends import GpuDevice
from gpuq.config import Config
from gpuq.constants import AttemptState,JobState
from gpuq.coordinator import Coordinator
from gpuq.store import Store
from gpuq.submission import validate_submission


class NativeTerminal(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        config=Config(root=self.root,db_path=self.root/'native.db',log_dir=self.root/'logs',control_dir=self.root/'control',socket_path=Path(f'/run/user/{os.getuid()}/terminal-proof-test.sock'),managed_gpu_uuids=('GPU-test',),allowed_uid=os.getuid(),observe_only=False)
        config.log_dir.mkdir();config.control_dir.mkdir();self.store=Store(config.db_path).initialize();self.addCleanup(self.store.close)
        self.core=Coordinator(config,self.store,Mock(),Mock(),boot_id='test-boot');self.core._snapshot=(GpuDevice(3,'GPU-test',24576,0,24576,0,()),)
        for name in ('node-executor.py','scheduling-policy.py'):shutil.copy2(ROOT/'deploy'/name,self.root/name)
        (self.root/'node-config.json').write_text(json.dumps({'root':str(self.root/'console'),'cards':1,'gpu':'/not/a/gpu','database':str(config.db_path)}))
        module=importlib.util.spec_from_file_location('node_terminal_fixture',self.root/'node-executor.py');self.node=importlib.util.module_from_spec(module);module.loader.exec_module(self.node)
        self.job={'id':str(uuid.uuid4()),'userId':'demo-user-1','username':'alice','cards':1,'argv':['python','train.py'],'name':'terminal-test','minVramGiB':0,'priority':'normal','preemptIdleOnly':True}
        raw={'submit_key':self.job['id'],'name':'terminal-test','owner':'alice','priority':2,'dispatch_mode':'queue','yield_policy':'never','checkpoint_capability':'none','restart_policy':'never','gpu_count':1,'placement':'any','requested_gpu_uuids':[],'argv':[sys.executable,'-c','pass'],'cwd':str(self.root),'env':{}}
        self.native=self.store.submit_job(validate_submission(raw,1,managed_gpu_uuids=config.managed_gpu_uuids));self.commands=[]
        def gpu(*args):
            self.commands.append(args)
            if args[0]=='show':return self.core._api_show({'job_id':args[1]})
            if args[0]=='cancel':return self.core._api_cancel({'job_id':args[1]})
            raise AssertionError(args)
        self.patch=patch.object(self.node,'gpu',side_effect=gpu);self.patch.start();self.addCleanup(self.patch.stop)

    def running(self):
        aid='A'+uuid.uuid4().hex;control=self.root/'control'/aid;control.mkdir();log=self.root/'logs'/aid;log.touch()
        self.attempt=self.store.create_attempt(self.native['id'],attempt_id=aid,state='RUNNING',gpu_uuids=['GPU-test'],gpu_indices=[3],unit_name='gpuq-'+aid.lower(),unit_token='test-token',invocation_id='a'*32,boot_id='test-boot',control_dir=str(control),log_path=str(log))
        self.store.acquire_leases(self.native['id'],aid,{'GPU-test':3});self.store.update_job(self.native['id'],state=JobState.RUNNING)
        return self.attempt

    def drain(self):
        self.store.update_attempt(self.attempt['id'],state=AttemptState.DRAINING,exit_code=-15)
        self.core._statuses[self.attempt['id']]=SimpleNamespace(is_cleanup_ready=True,main_pid=0,control_group='')
        for _ in range(self.core.config.release_confirmations):self.core._finalize_draining_attempts()

    def test_no_dataset_cancel_receipt_retains_card_until_native_drain(self):
        self.running();result=self.node.process('cancel',{'job':self.job})
        self.assertEqual(result['state'],'UNKNOWN');self.assertEqual(result['assignedIndices'],[3]);self.assertEqual(result['schedulerState'],'CANCELED')
        data=self.core._api_show({'job_id':self.native['id']})
        self.assertEqual(data['job']['state'],'CANCELED');self.assertEqual(data['attempts'][0]['state'],'TERM_REQUESTED');self.assertEqual(len(data['leases']),1);self.assertIn('scale_up_reservations',data)
        self.drain();data=self.core._api_show({'job_id':self.native['id']});self.assertEqual(data['leases'],[])
        with patch.object(self.node.subprocess,'run',side_effect=OSError('not an extra state source')) as command:
            self.assertEqual(self.node.process('sync',{'job':self.job})['state'],'CANCELED');command.assert_not_called()

    def test_pending_never_started_and_gc_collected_units_can_confirm(self):
        result=self.node.process('cancel',{'job':self.job});self.assertEqual(result['state'],'CANCELED')
        data=self.core._api_show({'job_id':self.native['id']});self.assertEqual(data['attempts'],[]);self.assertTrue(self.node.scheduler_terminal_confirmed(data))
        # Existing dataset quiet verification also accepts a collected unit.
        self.store.update_job(self.native['id'],state=JobState.PENDING);self.running();self.core._api_cancel({'job_id':self.native['id']});self.drain()
        gone=SimpleNamespace(returncode=1,stdout='LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n')
        data=self.core._api_show({'job_id':self.native['id']})
        with patch.object(self.node.subprocess,'run',return_value=gone):self.assertTrue(self.node.dataset_unit_stopped(data['attempts'][0]))
        self.assertTrue(self.node.scheduler_terminal_confirmed(data))

    def test_missing_unknown_or_conflicting_proof_and_sql_error_never_retire(self):
        self.node.process('cancel',{'job':self.job});data=self.core._api_show({'job_id':self.native['id']})
        for key in ('job','attempts','leases','scale_up_reservations'):
            incomplete=deepcopy(data);del incomplete[key];self.assertFalse(self.node.scheduler_terminal_confirmed(incomplete))
        for change in ({'leases':[{}]},{'scale_up_reservations':[{}]},{'active_attempt_id':'Aunknown'},{'active_attempt_id':False},{'attempts':[{'state':'LOST'}]},{'attempts':[{'state':'DRAINING'}]},{'job':{'state':'LOST'}}):
            self.assertFalse(self.node.scheduler_terminal_confirmed({**data,**change}))
        with patch.object(self.node.sqlite3,'connect',side_effect=sqlite3.OperationalError('read unavailable')):
            with self.assertRaises(sqlite3.OperationalError):self.node.process('sync',{'job':self.job})


if __name__=='__main__':unittest.main()
