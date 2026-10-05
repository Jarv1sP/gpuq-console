"""Cloud admission and worker boundaries; no live account/network/systemd."""
import importlib.util
import hashlib
import io
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
        # This disposable fixture represents an independent node with no root
        # pin installed; do not consult or modify the test host's live pin.
        # Every other lstat and the production guard remain unchanged.
        original_lstat=Path.lstat
        def fixture_lstat(path,*args,**kwargs):
            if str(path)=='/etc/gpuq-platform-root':raise FileNotFoundError(path)
            return original_lstat(path,*args,**kwargs)
        guard=patch.object(Path,'lstat',new=fixture_lstat);guard.start();self.addCleanup(guard.stop)
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
    def test_shared_cloud_budget_is_still_finite_without_individual_byte_caps(self):
        self.n.CONFIG['cloudFiles'].update(maxUserBytes=0,maxTotalBytes=10,maxFileBytes=5)
        self.assertEqual(self.c.config()['maxUserBytes'],0)
        self.upload();self.upload()  # Same operation is charged once.
        self.call('upload',key=str(uuid.uuid4()),path='source.zip')
        with self.assertRaisesRegex(ValueError,'allowance'):
            self.call('upload',key=str(uuid.uuid4()),path='source.zip')
        ledger=self.module._read_json(self.cache.root/'.cloud-budget.json')
        self.assertEqual(sum(row['bytes'] for row in ledger.values()),10)

    def test_zero_is_only_allowed_for_cloud_personal_byte_budget(self):
        original=dict(self.n.CONFIG['cloudFiles'])
        for key in ('maxFileBytes','maxTotalBytes'):
            self.n.CONFIG['cloudFiles']={**original,key:0}
            with self.assertRaises(ValueError):self.c.config()
        for value in (False,-1,None,'0'):
            self.n.CONFIG['cloudFiles']={**original,'maxUserBytes':value}
            with self.assertRaises(ValueError):self.c.config()

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
    def test_verify_timeout_is_failed_and_retained_without_touching_source_or_budget(self):
        self.uploaded();source=(self.owner/'cloud-files'/self.key/'task.json').read_bytes()
        ledger=(self.cache.root/'.cloud-budget.json').read_bytes()
        key=str(uuid.uuid4());self.call('verify',key=key,fileId=self.key)
        module=sys.modules[self.c.__class__.__module__]
        with patch.object(self.c,'io',side_effect=module.CloudConfirmationTimeout()):
            self.assertEqual(self.c.worker(self.user,key,'1'),1)
        status=self.call('status',operationId=key)
        self.assertEqual(status['state'],'FAILED');self.assertEqual(status['phase'],'CLOUD_CONFIRMATION_TIMEOUT')
        self.assertIn('not retransmitted',status['error']);self.assertFalse(status['canResume'])
        self.assertNotIn('PRIVATE_SEALED',json.dumps(status))
        self.assertEqual((self.owner/'cloud-files'/self.key/'task.json').read_bytes(),source)
        self.assertEqual((self.cache.root/'.cloud-budget.json').read_bytes(),ledger)
        count=len(self.starts);self.call('verify',key=key,fileId=self.key);self.assertEqual(len(self.starts),count)
        failed=(self.owner/'cloud-files'/key/'task.json').read_bytes()
        fresh=str(uuid.uuid4());self.call('verify',key=fresh,fileId=self.key)
        self.assertEqual(len(self.starts),count+1)
        with patch.object(self.c,'io',return_value={'id':self.key,'state':'VERIFIED','receipt':'NEW_PRIVATE_SEALED'}):
            self.assertEqual(self.c.worker(self.user,fresh,'1'),0)
        self.assertEqual(self.c.load(self.user,self.key)['state'],'VERIFIED')
        self.assertEqual((self.owner/'cloud-files'/key/'task.json').read_bytes(),failed)
        self.assertEqual((self.cache.root/'.cloud-budget.json').read_bytes(),ledger)
    def test_verify_may_only_publish_verified_not_unattended_pending(self):
        self.uploaded();source=(self.owner/'cloud-files'/self.key/'task.json').read_bytes()
        key=str(uuid.uuid4());self.call('verify',key=key,fileId=self.key)
        with patch.object(self.c,'io',return_value={'id':self.key,'state':'VERIFYING','receipt':'PRIVATE_SEALED'}):
            self.assertEqual(self.c.worker(self.user,key,'1'),1)
        self.assertEqual(self.call('status',operationId=key)['state'],'FAILED')
        self.assertEqual((self.owner/'cloud-files'/self.key/'task.json').read_bytes(),source)
    def test_old_stopped_verifying_record_is_read_only_and_never_automatically_relaunched(self):
        self.uploaded();key=str(uuid.uuid4());self.call('verify',key=key,fileId=self.key)
        task=self.c.load(self.user,key);task['state']='VERIFYING';self.c.save(task)
        path=self.owner/'cloud-files'/key/'task.json';before=path.read_bytes();starts=len(self.starts)
        for unused in range(3):
            self.assertEqual(self.call('status',operationId=key)['state'],'VERIFYING')
            self.call('list');self.call('verify',key=key,fileId=self.key)
        self.assertEqual(path.read_bytes(),before);self.assertEqual(len(self.starts),starts)
    def test_fixed_timeout_frame_becomes_durable_safe_reason_and_progress_not_raw_worker_error(self):
        self.uploaded();key=str(uuid.uuid4());self.call('verify',key=key,fileId=self.key)
        read_fd,write_fd=os.pipe()
        frames=[{'kind':'progress','stage':'VERIFYING','bytes':0},
                {'kind':'error','errorCode':'CLOUD_CONFIRMATION_TIMEOUT','error':'UNTRUSTED_UPSTREAM_TOKEN_OR_PATH'}]
        os.write(write_fd,b''.join(json.dumps(frame).encode()+b'\n' for frame in frames));os.close(write_fd)
        class Process:
            def __init__(self):self.stdin=io.BytesIO();self.stdout=os.fdopen(read_fd,'rb');self.done=False
            def poll(self):return 1 if self.done else None
            def terminate(self):self.done=True
            def kill(self):self.done=True
            def wait(self,timeout=None):self.done=True;return 1
        process=Process()
        with patch('subprocess.Popen',return_value=process):self.assertEqual(self.c.worker(self.user,key,'1'),1)
        task=self.c.load(self.user,key)
        self.assertEqual(task['state'],'FAILED');self.assertEqual(task['phase'],'CLOUD_CONFIRMATION_TIMEOUT')
        self.assertGreater(task['updatedAt'],task['createdAt']);self.assertEqual(task['bytes'],0)
        self.assertNotIn('UNTRUSTED_UPSTREAM',json.dumps(self.call('list')))
    def test_timeout_cancellation_preserves_canceled_state_and_never_verifies_source(self):
        self.uploaded();key=str(uuid.uuid4());self.call('verify',key=key,fileId=self.key)
        module=sys.modules[self.c.__class__.__module__]
        def failed(task,fd):
            current=self.c.load(self.user,key);current['cancelRequested']=True;self.c.save(current)
            raise module.CloudConfirmationTimeout()
        with patch.object(self.c,'io',side_effect=failed):self.assertEqual(self.c.worker(self.user,key,'1'),1)
        status=self.call('status',operationId=key);self.assertEqual(status['state'],'CANCELED')
        self.assertNotEqual(status.get('phase'),'CLOUD_CONFIRMATION_TIMEOUT')
        self.assertEqual(self.c.load(self.user,self.key)['state'],'VERIFYING')
    def test_download_requires_verified_file(self):
        self.uploaded()
        with self.assertRaises(ValueError):self.call('download',key=str(uuid.uuid4()),fileId=self.key,path='out.zip')
    def test_identity_changed_download_is_retained_and_cannot_resume_or_rebind(self):
        source=self.uploaded();source['state']='VERIFIED';self.c.save(source)
        source_path=self.owner/'cloud-files'/self.key/'task.json';source_before=source_path.read_bytes()
        ledger_path=self.cache.root/'.cloud-budget.json';ledger=ledger_path.read_bytes()
        key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path='out.zip')
        module=sys.modules[self.c.__class__.__module__]
        with patch.object(self.c,'io',side_effect=module.CloudFileIdentityChanged('IDENTITY_BEFORE_TRANSFER')):
            self.assertEqual(self.c.worker(self.user,key,'1'),1)
        status=self.call('status',operationId=key)
        self.assertEqual(status['state'],'PAUSED');self.assertEqual(status['errorCode'],'CLOUD_FILE_IDENTITY_CHANGED')
        self.assertEqual(status['phase'],'IDENTITY_BEFORE_TRANSFER');self.assertFalse(status['canResume'])
        self.assertIn('reverify',status['error']);self.assertFalse((self.owner/'data'/'out.zip').exists())
        paused=self.owner/'cloud-files'/key/'task.json';old=paused.read_bytes();starts=len(self.starts)
        with self.assertRaisesRegex(ValueError,'new download operation'):self.call('download',key=key,fileId=self.key,path='out.zip')
        self.assertEqual(paused.read_bytes(),old);self.assertEqual(len(self.starts),starts)
        self.assertEqual(source_path.read_bytes(),source_before);self.assertEqual(ledger_path.read_bytes(),ledger)
        fresh_verify=str(uuid.uuid4());self.call('verify',key=fresh_verify,fileId=self.key)
        with patch.object(self.c,'io',return_value={'id':self.key,'state':'VERIFIED','receipt':'NEW_PRIVATE_SEALED'}):
            self.assertEqual(self.c.worker(self.user,fresh_verify,'1'),0)
        self.assertEqual(paused.read_bytes(),old);self.assertEqual(ledger_path.read_bytes(),ledger)
        fresh_download=str(uuid.uuid4());self.call('download',key=fresh_download,fileId=self.key,path='fresh.zip')
        self.assertEqual(self.c.load(self.user,fresh_download)['receipt'],'NEW_PRIVATE_SEALED')
        self.assertEqual(paused.read_bytes(),old)
    def test_ordinary_paused_download_does_not_adopt_later_verification_receipt(self):
        source=self.uploaded();source['state']='VERIFIED';self.c.save(source)
        key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path='out.zip')
        with patch.object(self.c,'io',side_effect=ValueError('upstream')):self.c.worker(self.user,key,'1')
        path=self.owner/'cloud-files'/key/'task.json';before=path.read_bytes();starts=len(self.starts)
        source=self.c.load(self.user,self.key);source['receipt']='NEW_SEALED';self.c.save(source)
        with self.assertRaisesRegex(ValueError,'instead of rebinding'):self.call('download',key=key,fileId=self.key,path='out.zip')
        self.assertEqual(path.read_bytes(),before);self.assertEqual(len(self.starts),starts)
    def test_fixed_identity_frame_is_safe_and_typed_only_for_download(self):
        for stage in ('IDENTITY_BEFORE_TRANSFER','IDENTITY_AFTER_TRANSFER'):
            source=self.uploaded();source['state']='VERIFIED';self.c.save(source)
            key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path=stage+'.zip')
            read_fd,write_fd=os.pipe()
            frame={'kind':'error','errorCode':'CLOUD_FILE_IDENTITY_CHANGED','errorStage':stage,'error':'UNTRUSTED_TOKEN_URL_AND_PATH'}
            os.write(write_fd,json.dumps(frame).encode()+b'\n');os.close(write_fd)
            class Process:
                def __init__(self):self.stdin=io.BytesIO();self.stdout=os.fdopen(read_fd,'rb');self.done=False
                def poll(self):return 1 if self.done else None
                def terminate(self):self.done=True
                def kill(self):self.done=True
                def wait(self,timeout=None):self.done=True;return 1
            with patch('subprocess.Popen',return_value=Process()):self.assertEqual(self.c.worker(self.user,key,'1'),1)
            out=self.call('status',operationId=key)
            self.assertEqual(out['errorCode'],'CLOUD_FILE_IDENTITY_CHANGED');self.assertEqual(out['phase'],stage)
            self.assertFalse(out['canResume']);self.assertNotIn('UNTRUSTED',json.dumps(out))
    def test_identity_frame_rejects_unknown_code_stage_fields_and_verify_action(self):
        frames=[{'kind':'error','errorCode':'OTHER','errorStage':'IDENTITY_BEFORE_TRANSFER'},
                {'kind':'error','errorCode':'CLOUD_FILE_IDENTITY_CHANGED','errorStage':'SECRET_PATH'},
                {'kind':'error','errorCode':'CLOUD_FILE_IDENTITY_CHANGED','errorStage':'IDENTITY_BEFORE_TRANSFER','secret':'RAW_TOKEN'}]
        source=self.uploaded();source['state']='VERIFIED';self.c.save(source)
        for action,frame in [('download',f) for f in frames]+[('verify',{'kind':'error','errorCode':'CLOUD_FILE_IDENTITY_CHANGED','errorStage':'IDENTITY_BEFORE_TRANSFER'})]:
            key=str(uuid.uuid4());args={'key':key,'fileId':self.key}
            if action=='download':args['path']=key+'.zip'
            self.call(action,**args);read_fd,write_fd=os.pipe()
            os.write(write_fd,json.dumps(frame).encode()+b'\n');os.close(write_fd)
            class Process:
                def __init__(self):self.stdin=io.BytesIO();self.stdout=os.fdopen(read_fd,'rb');self.done=False
                def poll(self):return 1 if self.done else None
                def terminate(self):self.done=True
                def kill(self):self.done=True
                def wait(self,timeout=None):self.done=True;return 1
            with patch('subprocess.Popen',return_value=Process()):self.assertEqual(self.c.worker(self.user,key,'1'),1)
            out=self.call('status',operationId=key)
            self.assertNotIn('errorCode',out);self.assertNotIn('SECRET',json.dumps(out));self.assertNotIn('TOKEN',json.dumps(out))
        module=sys.modules[self.c.__class__.__module__]
        with self.assertRaises(ValueError):module.CloudFileIdentityChanged('SECRET_PATH')
    def test_identity_error_after_cancellation_never_overwrites_cancel_state(self):
        source=self.uploaded();source['state']='VERIFIED';self.c.save(source)
        key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path='out.zip')
        module=sys.modules[self.c.__class__.__module__]
        def failed(task,fd):
            current=self.c.load(self.user,key);current['cancelRequested']=True;self.c.save(current)
            raise module.CloudFileIdentityChanged('IDENTITY_AFTER_TRANSFER')
        with patch.object(self.c,'io',side_effect=failed):self.assertEqual(self.c.worker(self.user,key,'1'),1)
        out=self.call('status',operationId=key)
        self.assertEqual(out['state'],'CANCELED');self.assertNotIn('errorCode',out)
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
    def test_download_without_personal_cap_still_reserves_physical_space(self):
        self.c.imports.limits['maxUserBytes']=0
        task=self.uploaded();task['state']='VERIFIED';self.c.save(task)
        key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path='shared.zip')
        def io(task,fd):
            os.write(fd,b'hello');return {'id':self.key,'state':'VERIFIED','bytes':5,'sha256Verified':True,'sha256':hashlib.sha256(b'hello').hexdigest()}
        with patch.object(self.c.imports,'usage',wraps=self.c.imports.usage) as usage:
            with patch.object(self.c.imports,'reservation',wraps=self.c.imports.reservation) as reservation:
                with patch.object(self.c,'io',side_effect=io):
                    self.assertEqual(self.c.worker(self.user,key,'1'),0)
                self.assertTrue(reservation.called)
                usage.assert_called_once_with(self.user,key)
        self.assertEqual((self.owner/'data'/'shared.zip').read_bytes(),b'hello')
        key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path='full.zip')
        with patch.object(self.c.imports,'reservation',side_effect=ValueError('Insufficient shared disk space')):
            with patch.object(self.c,'io') as io:
                self.assertEqual(self.c.worker(self.user,key,'1'),1);io.assert_not_called()
        self.assertFalse((self.owner/'data'/'full.zip').exists())
        self.c.imports.limits['maxUserEntries']=1
        key=str(uuid.uuid4());self.call('download',key=key,fileId=self.key,path='entries.zip')
        with patch.object(self.c,'io') as io:
            self.assertEqual(self.c.worker(self.user,key,'1'),1);io.assert_not_called()
        self.assertFalse((self.owner/'data'/'entries.zip').exists())
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
