"""Cloud admission and worker boundaries; no live account/network/systemd."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
from storage_test_helpers import local_data_mounts

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'

class CloudFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name).resolve()
        mount=local_data_mounts(self.base);mount.start();self.addCleanup(mount.stop)
        for name in ('platform-root-guard.py','node-executor.py','scheduling-policy.py','dataset-cache.py','data-workspace.py','data-import.py','cloud-files.py'):
            shutil.copy2(DEPLOY/name,self.base/name)
        (self.base/'node-config.json').write_text(json.dumps({'root':str(self.base/'state'),
            'datasets':{'root':str(self.base/'cache'),'mountPoint':str(self.base),'sources':{},'reserveBytes':0},
            'cloudFiles':{'enabled':True,'nodeExecutable':'/approved/node','worker':'/approved/worker.mjs','privateConfig':'/approved/private.json',
                          'maxFileBytes':100,'maxUserBytes':200,'maxTotalBytes':300}}))
        spec=importlib.util.spec_from_file_location('cloud_files_node_test',self.base/'node-executor.py');self.n=importlib.util.module_from_spec(spec);sys.modules[spec.name]=self.n;spec.loader.exec_module(self.n)
        self.mount=patch.object(self.n,'dataset_mount_check');self.mount.start();self.addCleanup(self.mount.stop)
        self.c=self.n.cloud_files();self.user='demo-user-1';self.key=str(uuid.uuid4());self.starts=[]
        self.launch=patch.object(self.n,'run',side_effect=lambda argv,**kw:self.starts.append(argv));self.launch.start();self.addCleanup(self.launch.stop)
        self.stopped=patch.object(self.c.w,'unit_stopped',return_value=True);self.stopped.start();self.addCleanup(self.stopped.stop)
        self.module,self.cache,self.owner,_=self.c.storage(self.user)
        (self.owner/'data'/'source.zip').write_bytes(b'hello');os.chmod(self.owner/'data'/'source.zip',0o600)
        self.addCleanup(self.temp.cleanup)
    def call(self,action,**kw):return self.n.process('datasets.cloud.'+action,{'userId':self.user,'hostAdmin':False,**kw})
    def upload(self):return self.call('upload',key=self.key,path='source.zip')
    def uploaded(self):
        self.upload();task=self.c.load(self.user,self.key);task.update(state='VERIFYING',receipt='PRIVATE_SEALED',sha256=hashlib.sha256(b'hello').hexdigest());self.c.save(task);return task
    def test_private_detached_launch_and_idempotency(self):
        self.assertEqual(self.upload()['state'],'QUEUED');self.upload();self.assertEqual(len(self.starts),1)
        self.assertEqual(self.starts[0][-4:],['--cloud-files-worker',self.user,self.key,'1'])
        with self.assertRaises(ValueError):self.call('upload',key=self.key,path='different.zip')
        self.assertNotIn('receipt',self.call('status',operationId=self.key));self.assertFalse(self.call('info')['vpsRelay'])
    def test_cross_owner_and_privilege_fields_rejected(self):
        self.uploaded()
        with self.assertRaises((ValueError,FileNotFoundError)):self.c.process('datasets.cloud.verify',{'userId':'demo-user-2','key':str(uuid.uuid4()),'fileId':self.key})
        for extra in ({'hostAdmin':True},{'token':'not-allowed'},{'receipt':'not-allowed'},{'hostAdmin':0}):
            with self.assertRaises(ValueError):self.c.process('datasets.cloud.upload',{'userId':self.user,'key':str(uuid.uuid4()),'path':'source.zip',**extra})
    def test_symlink_and_hardlink_sources_rejected(self):
        (self.owner/'data'/'linked').symlink_to(self.owner/'data'/'source.zip')
        with self.assertRaises((OSError,ValueError)):self.call('upload',key=self.key,path='linked')
        os.link(self.owner/'data'/'source.zip',self.owner/'data'/'hard')
        with self.assertRaises(ValueError):self.upload()
        self.assertEqual(self.starts,[])
    def test_retained_budget_no_second_charge_same_key(self):
        self.upload();self.upload();ledger=self.module._read_json(self.cache.root/'.cloud-budget.json')
        self.assertEqual(sum(r['bytes'] for r in ledger.values()),5)
        self.n.CONFIG['cloudFiles']['maxUserBytes']=5
        with self.assertRaises(ValueError):self.call('upload',key=str(uuid.uuid4()),path='source.zip')
    def test_terminal_lock_blocks_upload(self):
        lock=self.c.w.lifetime(self.user)
        try:
            with self.assertRaises(ValueError):self.upload()
        finally:os.close(lock)
        self.assertEqual(self.starts,[])
    def test_upload_worker_result_and_no_receipt_in_public(self):
        self.upload()
        with patch.object(self.c,'io',return_value={'id':self.key,'state':'VERIFYING','size':5,'sha256':hashlib.sha256(b'hello').hexdigest(),'receipt':'PRIVATE_SEALED'}):
            self.assertEqual(self.c.worker(self.user,self.key,'1'),0)
        self.assertEqual(self.call('status',operationId=self.key)['state'],'VERIFYING')
        self.assertNotIn('PRIVATE_SEALED',json.dumps(self.call('list')))
    def test_changed_source_before_worker_never_calls_cloud(self):
        self.upload();(self.owner/'data'/'source.zip').write_bytes(b'changed')
        with patch.object(self.c,'io') as io:
            self.assertEqual(self.c.worker(self.user,self.key,'1'),1);io.assert_not_called()
        count=len(self.starts);self.upload();self.assertEqual(count,len(self.starts))
    def test_verify_updates_owner_file_only(self):
        self.uploaded();key=str(uuid.uuid4());self.call('verify',key=key,fileId=self.key)
        with patch.object(self.c,'io',return_value={'id':self.key,'state':'VERIFIED','receipt':'NEW_PRIVATE'}):
            self.assertEqual(self.c.worker(self.user,key,'1'),0)
        self.assertEqual(self.c.load(self.user,self.key)['state'],'VERIFIED')
        self.assertNotIn('NEW_PRIVATE',json.dumps(self.call('list')))
    def test_download_requires_verified_file(self):
        self.uploaded()
        with self.assertRaises(ValueError):self.call('download',key=str(uuid.uuid4()),fileId=self.key,path='out.zip')
    def test_download_commits_without_overwriting_existing(self):
        task=self.uploaded();task['state']='VERIFIED';self.c.save(task)
        key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path='out.zip')
        def io(task,fd):
            os.write(fd,b'hello');return {'id':self.key,'state':'VERIFIED','bytes':5,'sha256Verified':True,'sha256':hashlib.sha256(b'hello').hexdigest()}
        with patch.object(self.c,'io',side_effect=io):self.assertEqual(self.c.worker(self.user,key,'1'),0)
        self.assertEqual((self.owner/'data'/'out.zip').read_bytes(),b'hello')
        key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path='out.zip')
        with patch.object(self.c,'io',side_effect=io):self.assertEqual(self.c.worker(self.user,key,'1'),1)
        self.assertEqual((self.owner/'data'/'out.zip').read_bytes(),b'hello')
    def test_cancel_fence_and_stale_generation(self):
        self.upload();self.call('cancel',operationId=self.key)
        with patch.object(self.c,'io') as io:
            self.c.worker(self.user,self.key,'1');io.assert_not_called()
        self.assertEqual(self.call('status',operationId=self.key)['state'],'CANCELED')
    def test_runtime_configuration_disabled_keeps_status_visible(self):
        self.upload();self.n.CONFIG['cloudFiles']['enabled']=False
        self.assertFalse(self.call('info')['enabled']);self.assertEqual(len(self.call('list')['files']),1)
        with self.assertRaises(ValueError):self.call('upload',key=str(uuid.uuid4()),path='source.zip')

if __name__=='__main__':unittest.main()
