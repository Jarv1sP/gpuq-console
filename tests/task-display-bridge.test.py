"""Actual bridge allowlist and handler; synthetic inventory and SSH only."""
import io
import json
from pathlib import Path
import runpy
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

class TaskDisplayBridge(unittest.TestCase):
    def setUp(self):
        original=Path.read_text
        def read(path,*args,**kwargs):
            if str(path)=='/opt/gpuq-console/inventory.json':
                return json.dumps({'nodes':[{'id':'fixture-node','user':'fixture','address':'127.0.0.1'}]})
            return original(path,*args,**kwargs)
        with patch.object(Path,'read_text',read):
            self.worker=runpy.run_path(str(Path(__file__).resolve().parents[1]/'deploy/execution-worker.py'),run_name='task_display_bridge_test')
    def request(self,operation,machine='fixture-node',failure=None,response=None):
        args={'userId':'demo-user-1','hostAdmin':False,'nodeJobId':'J123456789abc','job':{'id':'12345678-1234-4234-8234-123456789012','userId':'demo-user-1'}}
        if operation=='tasks.display.set':args.update(name='中文任务',description='仅显示',revision='a'*64)
        handler=self.worker['Handler'].__new__(self.worker['Handler']);handler.request=SimpleNamespace(settimeout=lambda _:None)
        handler.rfile=io.BytesIO((json.dumps({'machine':machine,'operation':operation,'args':args})+'\n').encode());handler.wfile=io.BytesIO()
        response=response or {'ok':True,'result':{'protocol':'task-display-edit-v1','nodeJobId':args['nodeJobId'],'available':False}}
        with patch.object(self.worker['SSH_CONNECTIONS'],'control_path',return_value=Path('/fixture-private/control')) as control,patch.object(self.worker['SSH_CONNECTIONS'],'ensure_master') as master,patch.object(self.worker['subprocess'],'run',side_effect=failure,return_value=SimpleNamespace(returncode=0,stdout=json.dumps(response))) as run:
            handler.handle()
        return json.loads(handler.wfile.getvalue()),run,args,control,master
    def test_exact_get_set_cross_actual_handler_without_identity_rewriting(self):
        for operation in ('tasks.display.get','tasks.display.set'):
            with self.subTest(operation=operation):
                result,run,args,_,_=self.request(operation);self.assertTrue(result['ok']);run.assert_called_once()
                self.assertEqual(json.loads(run.call_args.kwargs['input']),{'operation':operation,'args':args})
                command=run.call_args.args[0];self.assertEqual(command[:4],['/usr/bin/ssh','-F','/dev/null','-T'])
                self.assertIn('StrictHostKeyChecking=yes',command);self.assertIn('ForwardAgent=no',command);self.assertNotIn('shell',run.call_args.kwargs)
    def test_unknown_ops_and_machine_do_not_connect(self):
        for operation,machine in [('tasks.display.force','fixture-node'),('tasks.display.set.extra','fixture-node'),('tasks.display.*','fixture-node'),('tasks.display.set','unknown-node')]:
            result,run,_,control,master=self.request(operation,machine);self.assertFalse(result['ok']);run.assert_not_called();control.assert_not_called();master.assert_not_called()
    def test_node_rejection_and_lost_write_reply_are_not_retried(self):
        rejection={'ok':False,'error':'Original native task binding changed'}
        result,run,*_=self.request('tasks.display.set',response=rejection);self.assertEqual(result,rejection);run.assert_called_once()
        result,run,*_=self.request('tasks.display.set',failure=subprocess.TimeoutExpired('fixture',1));self.assertFalse(result['ok']);run.assert_called_once()

if __name__=='__main__':unittest.main()
