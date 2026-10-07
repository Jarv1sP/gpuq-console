"""Real node sync/spec/SQLite/ProjectStore; only native GPUQ and systemd are synthetic."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import uuid

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('node_storage_fixture',HERE/'personal-publish.test.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)


class NativePreparation(unittest.TestCase):
    cleanup=fixture.Publish.cleanup
    def setUp(self):
        fixture.Publish.setUp(self)
        (self.conda/'bin').mkdir();(self.conda/'bin/python').write_bytes(b'approved fixture')
        (self.conda/'conda-meta').mkdir();(self.conda/'lib').mkdir()
        self.database=self.base/'native.sqlite'
        with sqlite3.connect(self.database) as db:db.execute('CREATE TABLE jobs (id TEXT, submit_key TEXT)')
        self.n.CONFIG['database']=str(self.database)
        self.store=self.n.projects().store;self.store.create(self.user,'train-project')
        paths=self.store.dev_paths(self.user,'train-project');(paths['code']/'train.py').write_text('print("training")\n')
        (paths['env']/'pyvenv.cfg').write_text('home = /opt/conda/bin\n')
        (paths['env']/'bin').mkdir();(paths['env']/'bin/python').symlink_to('/opt/conda/bin/python')
        self.release=self.store.publish(self.user,'train-project')['release']
        self.job={'id':str(uuid.uuid4()),'userId':self.user,'username':'fixture','cards':1,'argv':['python','train.py'],
                  'name':'training','minVramGiB':0,'project':'train-project','release':self.release,'workspaceMode':'shared'}
        self.submits=[]
        def gpu(action,*args):
            if action=='submit':
                key=args[args.index('--submit-key')+1];self.submits.append(key)
                with sqlite3.connect(self.database) as db:db.execute('INSERT INTO jobs VALUES (?,?)',('J0123456789ab',key))
                return {'job_id':'J0123456789ab'}
            if action=='show':return {'job':{'state':'PENDING'},'attempts':[]}
            raise AssertionError('Unexpected native mutation '+action)
        self.n.gpu=gpu
        definition=importlib.util.spec_from_file_location('workspace_stopped_guard',self.code/'data-workspace.py')
        self.d=importlib.util.module_from_spec(definition);definition.loader.exec_module(self.d)
        # All dynamically loaded copies of this class use the same subprocess
        # observation. The live node logic remains unchanged.
        self.launches=[]
        def systemd(command,**kwargs):
            if 'systemd-run' in command[0]:self.launches.append(command);return SimpleNamespace(returncode=0)
            if 'systemctl' in command[0]:return SimpleNamespace(returncode=0,stdout='LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=1\nControlGroup=\n')
            raise AssertionError(command)
        guard=patch.object(self.n.subprocess,'run',side_effect=systemd);guard.start();self.addCleanup(guard.stop)

    def test_sync_prepares_once_before_native_submit_then_same_job_dispatches_once(self):
        result=self.n.process('sync',{'job':self.job})
        self.assertEqual(result['schedulerState'],'WORKSPACE_PREPARING');self.assertEqual(self.submits,[])
        self.assertEqual(self.n.process('sync',{'job':self.job})['state'],'PENDING');self.assertEqual(len(self.launches),1)
        self.assertEqual(self.n.process('watch',{'job':self.job})['schedulerState'],'WORKSPACE_PREPARING')
        self.assertEqual(self.p.WorkspacePreparation(self.n).worker(self.job['id']),0)
        self.assertEqual(self.n.process('sync',{'job':self.job})['nodeJobId'],'J0123456789ab')
        self.assertEqual(self.n.process('sync',{'job':self.job})['nodeJobId'],'J0123456789ab')
        self.assertEqual(self.submits,[self.job['id']]);self.assertEqual(json.loads((self.control/'jobs'/(self.job['id']+'.json')).read_text()),self.job)

    def test_cancel_during_preparation_blocks_late_completion_and_native_dispatch(self):
        self.n.process('sync',{'job':self.job})
        self.assertEqual(self.n.process('cancel',{'job':self.job})['state'],'CANCELED')
        self.assertEqual(self.p.WorkspacePreparation(self.n).worker(self.job['id']),1)
        self.assertEqual(self.n.process('sync',{'job':self.job})['state'],'CANCELED');self.assertEqual(self.submits,[])


if __name__=='__main__':unittest.main()
