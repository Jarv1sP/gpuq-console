"""Read-only task feedback: no GPU, SSH, bot, or scheduling side effects."""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'

class ProgressBridge(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name)
        shutil.copy2(DEPLOY/'node-executor.py',self.base/'node-executor.py')
        self.config={'root':str(self.base/'state'),'cards':8,'gpu':'/synthetic-gpu','database':str(self.base/'gpuq.db')}
        (self.base/'node-config.json').write_text(json.dumps(self.config))
        with closing(sqlite3.connect(self.config['database'])) as db:db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT)');db.commit()
        spec=importlib.util.spec_from_file_location('node_progress_test',self.base/'node-executor.py');self.node=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.node)
        self.job={'id':str(uuid.uuid4()),'userId':'demo-user-1','username':'alice','cards':1,'argv':['python','train.py'],'name':'test','minVramGiB':0}
        self.data={'job':{'state':'RUNNING','priority':2},'attempts':[{'id':'Aabc','ordinal':1,'state':'RUNNING','exit_code':None,'gpu_indices':[2],'failure_reason':None,'control_dir':'/private'}],
                   'progress':{'reported':True,'snapshot':{'phase':'train','epochs_completed':3,'epochs_total':10}}}
        self.calls=[]
        def fake(*args):
            self.calls.append(args)
            if args!=('show','Jabc'):raise AssertionError('Watch called lifecycle operation')
            return self.data
        mock=patch.object(self.node,'gpu',side_effect=fake);mock.start();self.addCleanup(mock.stop)

    def register(self):
        (self.node.ROOT/'jobs').mkdir(parents=True)
        (self.node.ROOT/'jobs'/(self.job['id']+'.json')).write_text(json.dumps(self.job))
        with closing(sqlite3.connect(self.config['database'])) as db:db.execute('INSERT INTO jobs VALUES(?,?)',('Jabc',self.job['id']));db.commit()

    def test_unregistered_watch_does_not_create_files_or_register_task(self):
        result=self.node.process('watch',{'job':self.job})
        self.assertEqual(result['state'],'PENDING');self.assertIsNone(result['nodeJobId']);self.assertEqual(self.calls,[])
        self.assertFalse(self.node.ROOT.exists())

    def test_read_registered_progress_and_exit_only_show_and_bounded_attempt_fields(self):
        self.register()
        for state in ('RUNNING','FAILED','SUCCEEDED','LOST','PREEMPTING'):
            self.data['job']['state']=state;result=self.node.process('watch',{'job':self.job});self.assertEqual(result['state'],state)
            self.assertEqual(result['progress'],self.data['progress']);self.assertNotIn('control_dir',result['latestAttempt'])
        self.assertEqual(self.calls,[('show','Jabc')]*5)

    def test_owner_claim_mismatch_cannot_inspect(self):
        self.register()
        with self.assertRaisesRegex(ValueError,'identity mismatch'):self.node.process('watch',{'job':{**self.job,'userId':'demo-user-2'}})
        self.assertEqual(self.calls,[])

    def test_terminal_watch_retains_dataset_cleanup_and_does_not_release_leases(self):
        self.job['datasets']=[{'dataset':'sample','version':'a'*64}];self.register();self.data['job']['state']='SUCCEEDED'
        marker=self.node.ROOT/'jobs'/(self.job['id']+'.datasets.json');marker.write_text('[]')
        with patch.object(self.node,'release_datasets') as release:
            result=self.node.process('watch',{'job':self.job})
        self.assertEqual(result['state'],'UNKNOWN');self.assertEqual(result['schedulerState'],'SUCCEEDED');release.assert_not_called();self.assertTrue(marker.exists())

if __name__=='__main__':unittest.main()
