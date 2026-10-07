"""CPU preparation uses real ProjectStore; launch/systemd observations only are fixtures."""
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

HERE=Path(__file__).resolve().parent
definition=importlib.util.spec_from_file_location('workspace_fixture',HERE/'personal-storage.test.py')
fixture=importlib.util.module_from_spec(definition);definition.loader.exec_module(fixture)


class Preparation(fixture.PersonalStorageTests):
    def setUp(self):
        super().setUp()
        self.version=self.published()
        (self.control/'jobs').mkdir(mode=0o700)
        self.job={'id':str(uuid.uuid4()),'userId':self.user,'project':'new-project','release':self.version}
        definition=importlib.util.spec_from_file_location('workspace_preparation',HERE.parent/'deploy/personal-storage.py')
        self.p=importlib.util.module_from_spec(definition);definition.loader.exec_module(self.p)
        self.n=SimpleNamespace(ROOT=self.control,HERE=HERE.parent/'deploy',ENV={},CONFIG=self.config,
            validate_job=lambda job:None,projects=lambda:SimpleNamespace(store=self.store))
        self.ops=self.p.WorkspacePreparation(self.n)
        self.store_module=self.p.module
        original=self.p.module
        def loader(name):
            if name=='data-workspace':return SimpleNamespace(DataWorkspaces=lambda n:SimpleNamespace(unit_stopped=lambda unit:False))
            return original(name)
        self.p.module=loader
        self.save()

    def save(self):
        (self.control/'jobs'/(self.job['id']+'.json')).write_text(json.dumps(self.job))

    def test_prepare_is_background_once_without_early_working_copy(self):
        with patch.object(subprocess,'run',return_value=SimpleNamespace(returncode=0)) as launch:
            a=self.ops.ensure(self.job);b=self.ops.ensure(self.job)
            self.assertEqual(a['state'],'PENDING');self.assertEqual(b['schedulerState'],'WORKSPACE_PREPARING')
            self.assertEqual(launch.call_count,1)
            command=launch.call_args.args[0]
            self.assertIn('--personal-workspace-worker',command);self.assertNotIn('--gpu',command)
        with self.assertRaises(ValueError):self.store.existing_run_paths(self.user,'new-project',self.version,self.job['id'])
        self.assertEqual(self.ops.worker(self.job['id']),0);self.assertIsNone(self.ops.ensure(self.job))
        paths=self.store.existing_run_paths(self.user,'new-project',self.version,self.job['id'])
        (paths['output']/'checkpoint').write_bytes(b'optimizer and rng state')
        self.assertEqual(self.ops.worker(self.job['id']),0)
        self.assertEqual((paths['output']/'checkpoint').read_bytes(),b'optimizer and rng state')

    def test_lost_launch_reply_fences_original_id_and_never_replays(self):
        with patch.object(subprocess,'run',side_effect=subprocess.TimeoutExpired('systemd',5)) as launch:
            self.assertEqual(self.ops.ensure(self.job)['state'],'UNKNOWN')
            self.assertEqual(self.ops.ensure(self.job)['state'],'UNKNOWN');self.assertEqual(launch.call_count,1)
        self.assertEqual(self.ops.worker(self.job['id']),0)
        self.assertIsNone(self.ops.ensure(self.job))

    def test_worker_final_receipt_wins_over_lost_systemd_reply(self):
        def delayed(*args,**kwargs):
            self.assertEqual(self.ops.worker(self.job['id']),0)
            raise subprocess.TimeoutExpired('systemd',5)
        with patch.object(subprocess,'run',side_effect=delayed):self.assertIsNone(self.ops.ensure(self.job))

    def test_cancel_blocks_late_worker_and_preserves_release(self):
        with patch.object(subprocess,'run',return_value=SimpleNamespace(returncode=0)):self.ops.ensure(self.job)
        (self.control/'jobs'/(self.job['id']+'.canceled')).touch()
        self.assertEqual(self.ops.worker(self.job['id']),1)
        self.assertEqual(self.ops.result(self.job)['state'],'CANCELED')
        self.assertEqual((self.store.release(self.user,'new-project',self.version)['code']/'train.py').read_text(),'print("original")\n')

    def test_failure_is_terminal_unsubmitted_not_automatic_retry(self):
        with patch.object(subprocess,'run',return_value=SimpleNamespace(returncode=0)) as launch:self.ops.ensure(self.job)
        with patch.object(self.store,'run_paths',side_effect=OSError('space vanished')):self.assertEqual(self.ops.worker(self.job['id']),1)
        result=self.ops.ensure(self.job);self.assertEqual(result['state'],'FAILED');self.assertTrue(result['notSubmitted'])
        self.assertEqual(launch.call_count,1)

    def test_shared_mode_preparation_keeps_same_release_workspace(self):
        self.job['workspaceMode']='shared';self.save()
        with patch.object(subprocess,'run',return_value=SimpleNamespace(returncode=0)):self.ops.ensure(self.job)
        self.assertEqual(self.ops.worker(self.job['id']),0)
        first=self.store.existing_run_paths(self.user,'new-project',self.version,self.job['id'])
        other=self.store.run_paths(self.user,'new-project',self.version,str(uuid.uuid4()),workspace_mode='shared')
        self.assertEqual(first['output'],other['output'])


if __name__=='__main__':unittest.main()
