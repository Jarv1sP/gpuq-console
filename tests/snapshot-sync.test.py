"""Two disposable nodes, immutable code/data, no SSH/GPU/systemd."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
USER='demo-user-42'

class SnapshotSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.nodes=[];self.patches=[]
        for i in range(2):
            base=self.root/str(i);base.mkdir()
            for name in ('node-executor.py','scheduling-policy.py','project-ops.py','project-store.py','snapshot-sync.py','dataset-cache.py','dataset-upload.py'):
                shutil.copy2(DEPLOY/name,base/name)
            conda=base/'conda';(conda/'bin').mkdir(parents=True);(conda/'bin/python').write_text('fixture python');(conda/'conda-meta').mkdir();(conda/'lib').mkdir();(conda/'conda-meta/python-3.10.json').write_text(json.dumps({'name':'python','version':'3.10'}))
            source=base/'source';source.mkdir();(source/'sample.txt').write_text('data sample')
            (base/'node-config.json').write_text(json.dumps({'root':str(base/'state'),'conda':str(conda),'datasets':{'root':str(base/'datasets'),'mountPoint':str(base),'sources':{'fixture':str(source)},'reserveBytes':0}}))
            spec=importlib.util.spec_from_file_location('snapshot_node_'+str(i),base/'node-executor.py');node=importlib.util.module_from_spec(spec);sys.modules[spec.name]=node;spec.loader.exec_module(node)
            guard=patch.object(node,'dataset_mount_check');guard.start();self.patches.append(guard);node.workspace(USER);node.projects().store.reserve_bytes=0;self.nodes.append(node)
        self.key=str(uuid.uuid4());data=b'snapshot content';self.manifest={'schema':1,'directories':['sub'],'files':[{'path':'sub/train.py','size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'executable':True}]};self.data=data;self.raw=json.dumps(self.manifest).encode()
        self.begin={'userId':USER,'project':'imported','key':self.key,'manifestBytes':len(self.raw),'manifestSha256':hashlib.sha256(self.raw).hexdigest(),'totalBytes':len(data),'entries':2,'source':{'kind':'git','commit':'a'*40}}
    def tearDown(self):
        for guard in self.patches:guard.stop()
        for folder,_,files in os.walk(self.root):
            os.chmod(folder,0o700)
            for file in files:
                path=Path(folder)/file
                if not path.is_symlink():os.chmod(path,0o600)
        self.temp.cleanup()
    def call(self,action,**args):return self.nodes[1].process('projects.sync.'+action,{'userId':USER,'project':'imported','key':self.key,**args})
    def seal(self):
        self.nodes[1].process('projects.sync.begin',self.begin)
        self.call('manifest',offset=0,data=base64.b64encode(self.raw).decode());return self.call('seal')
    def test_partial_code_resume_fence_and_executable_completion(self):
        self.seal();self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(self.data[:4]).decode())
        self.assertEqual(self.call('status',path='sub/train.py')['file']['offset'],4)
        n=self.nodes[1];args={'userId':USER,'project':'imported'}
        self.assertEqual(n.process('projects.status',args)['state'],'SYNCING')
        for op in ('projects.publish','files.put','terminal.open'):
            with self.assertRaisesRegex(ValueError,'incomplete'):n.process(op,args)
        self.assertEqual(n.process('projects.sync.begin',self.begin)['state'],'COPYING')
        self.call('chunk',path='sub/train.py',offset=4,data=base64.b64encode(self.data[4:]).decode())
        self.assertEqual(self.call('finish')['state'],'CODE_READY');self.assertEqual(self.call('finish')['state'],'CODE_READY')
        paths=n.projects().store.dev_paths(USER,'imported');self.assertEqual((paths['code']/'sub/train.py').read_bytes(),self.data);self.assertTrue((paths['code']/'sub/train.py').stat().st_mode&0o111)
        self.assertEqual(list(paths['env'].iterdir()),[],'No environment migration');n.projects().writable(args)
        # CODE_READY is not a runnable release: the owner prepares a target-local
        # environment before the existing explicit publish operation.
        (paths['env']/'bin').mkdir();(paths['env']/'bin/python').write_text('target venv')
        (paths['env']/'pyvenv.cfg').write_text('home = /opt/conda/bin\ninclude-system-site-packages = false\n')
        with patch.object(n,'run',return_value=''),patch.object(n.projects(),'active',return_value=False):
            publishing=n.process('projects.publish',args)
            self.assertEqual(publishing['state'],'PUBLISHING')
            self.assertEqual(n.projects().worker(publishing['operationId']),0)
            published=n.process('projects.status',args)
        self.assertEqual(published['state'],'READY')
        fixed=n.projects().store.release(USER,'imported',published['latestReadyRelease'])
        self.assertEqual((fixed['code']/'sub/train.py').read_bytes(),self.data)
        self.assertEqual((fixed['env']/'bin/python').read_text(),'target venv')
    def test_old_project_and_changed_key_cannot_be_overwritten(self):
        self.nodes[1].process('projects.create',{'userId':USER,'project':'imported'})
        with self.assertRaisesRegex(ValueError,'new project'):self.nodes[1].process('projects.sync.begin',self.begin)
        self.begin['project']='new-project';self.nodes[1].process('projects.sync.begin',self.begin)
        with self.assertRaisesRegex(ValueError,'identity'):self.nodes[1].process('projects.sync.begin',{**self.begin,'key':str(uuid.uuid4())})
        with self.assertRaisesRegex(ValueError,'change'):self.nodes[1].process('projects.sync.begin',{**self.begin,'totalBytes':123})
    def test_begin_receipt_failure_cannot_leave_an_editable_project(self):
        node=self.nodes[1]
        with patch.object(node,'atomic_json',side_effect=OSError('receipt unavailable')):
            with self.assertRaisesRegex(OSError,'receipt unavailable'):node.process('projects.sync.begin',self.begin)
        self.assertEqual(node.projects().store.list(USER),[])
        self.assertEqual(node.process('projects.sync.begin',self.begin)['state'],'RECEIVING_MANIFEST')
        self.assertEqual(node.process('projects.status',{'userId':USER,'project':'imported'})['state'],'SYNCING')
    def test_begin_retries_after_durable_fence_before_new_project_creation(self):
        node=self.nodes[1];store=node.projects().store
        with patch.object(store,'create',side_effect=OSError('synthetic interrupted create')):
            with self.assertRaisesRegex(OSError,'interrupted create'):node.process('projects.sync.begin',self.begin)
        self.assertEqual(store.list(USER),[])
        with self.assertRaisesRegex(ValueError,'incomplete'):node.projects().writable(self.begin)
        self.assertEqual(node.process('projects.sync.begin',self.begin)['state'],'RECEIVING_MANIFEST')
        with self.assertRaisesRegex(ValueError,'incomplete'):node.projects().writable(self.begin)
        self.seal();self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(self.data).decode())
        self.assertEqual(self.call('finish')['state'],'CODE_READY')
    def test_invalid_manifest_and_retry_cannot_replace_completed_file(self):
        self.seal();payload=base64.b64encode(self.data).decode();self.call('chunk',path='sub/train.py',offset=0,data=payload)
        self.assertTrue(self.call('chunk',path='sub/train.py',offset=0,data=payload)['complete'])
        with self.assertRaisesRegex(ValueError,'differs'):self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(b'other').decode())
        for path in ('../outside','.env','missing.py'):
            with self.assertRaises(ValueError):self.call('chunk',path=path,offset=0,data='')
        self.assertEqual(self.call('finish')['state'],'CODE_READY')
    def test_changed_copy_blocks_fence_release(self):
        self.seal();self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(self.data).decode())
        target=self.nodes[1].projects().store.dev_paths(USER,'imported')['code']/'sub/train.py';target.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'changed'):self.call('finish')
        with self.assertRaisesRegex(ValueError,'does not overwrite'):self.call('status',path='sub/train.py')
    def test_failed_final_checksum_can_resume_without_overwriting_any_destination(self):
        self.seal()
        with self.assertRaisesRegex(ValueError,'SHA256'):self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(b'x'*len(self.data)).decode())
        status=self.call('status',path='sub/train.py')['file'];self.assertEqual(status['offset'],0);self.assertFalse(status['complete'])
        self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(self.data).decode());self.assertEqual(self.call('finish')['state'],'CODE_READY')
    def test_data_export_rechecks_authorization_and_ready_content(self):
        n=self.nodes[0];module,cache=n.dataset_cache();admin=module.Principal('builtin-admin',True);record=cache.register_source(admin,'shared','fixture',[USER]);version=record['version'];cache.materialize(admin,'shared',version)
        ref={'userId':USER,'dataset':'shared','version':version};info=n.process('datasets.snapshot.info',ref);self.assertEqual(info['state'],'READY')
        raw=base64.b64decode(n.process('datasets.snapshot.manifest',{**ref,'offset':0})['data']);self.assertEqual(hashlib.sha256(raw).hexdigest(),info['manifestSha256'])
        with patch.object(module.DatasetCache,'_record',side_effect=AssertionError('Per-chunk large manifest parse')):
            self.assertEqual(base64.b64decode(n.process('datasets.snapshot.get',{**ref,'path':'sample.txt','offset':0})['data']),b'data sample')
        cache.set_owners(admin,'shared',['demo-user-2'])
        with self.assertRaises(PermissionError):n.process('datasets.snapshot.get',{**ref,'path':'sample.txt','offset':0})
    def test_two_nodes_data_copy_resumes_existing_upload_and_verifies_same_ready_version(self):
        source,target=self.nodes;module,cache=source.dataset_cache()
        admin=module.Principal('builtin-admin',True)
        version=cache.register_source(admin,'shared','fixture',[USER])['version']
        cache.materialize(admin,'shared',version)
        reference={'userId':USER,'dataset':'shared','version':version}
        info=source.process('datasets.snapshot.info',reference)
        raw=base64.b64decode(source.process('datasets.snapshot.manifest',{**reference,'offset':0})['data'])
        begin={'userId':USER,'hostAdmin':False,'name':'samples','key':self.key,
            **{k:info[k] for k in ('manifestBytes','manifestSha256','totalBytes','entries')}}
        uploads=target.dataset_uploads()
        with patch.object(target,'run',return_value=''),patch.object(uploads,'active',return_value=True):
            admitted=target.process('datasets.upload.begin',begin);upload=admitted['uploadId']
            def call(action,**args):
                return target.process('datasets.upload.'+action,{'userId':USER,'hostAdmin':False,'uploadId':upload,**args})
            call('manifest',offset=0,data=base64.b64encode(raw).decode())
            self.assertEqual(call('seal')['state'],'SEALING')
            self.assertEqual(uploads.worker(USER,upload,'seal'),0)
            initial=source.process('datasets.snapshot.get',{**reference,'path':'sample.txt','offset':0})
            payload=base64.b64decode(initial['data'])
            call('chunk',path='sample.txt',offset=0,data=base64.b64encode(payload[:3]).decode())
            self.assertEqual(target.process('datasets.upload.begin',begin)['uploadId'],upload)
            self.assertEqual(call('status',path='sample.txt')['file']['offset'],3)
            tail=source.process('datasets.snapshot.get',{**reference,'path':'sample.txt','offset':3})
            call('chunk',path='sample.txt',offset=3,data=tail['data'])
            self.assertEqual(call('commit')['state'],'PUBLISHING')
            self.assertEqual(uploads.worker(USER,upload,'commit'),0)
            ready=call('status');self.assertEqual(ready['state'],'READY')
        self.assertEqual(ready['version'],version,'Source content version survives the existing upload pipeline')
        self.assertNotEqual(ready['dataset'],'shared','Shared source becomes an explicit private target copy')
        target_module,target_cache=target.dataset_cache()
        paths=target_cache._paths(ready['dataset'],ready['version'])
        self.assertEqual((paths['ready']/'data/sample.txt').read_bytes(),payload)
        self.assertEqual((paths['ready']/'data/sample.txt').stat().st_mode&0o777,0o444)
        with self.assertRaises(PermissionError):target_cache.status(target_module.Principal('demo-user-2'),ready['dataset'],version)
    def test_fixed_published_code_export_excludes_env_and_unpublished_edits(self):
        n=self.nodes[0];n.process('projects.create',{'userId':USER,'project':'source'});store=n.projects().store;paths=store.dev_paths(USER,'source');(paths['code']/'train.py').write_bytes(b'fixed');(paths['env']/'bin').mkdir();(paths['env']/'bin/python').write_text('venv');(paths['env']/'pyvenv.cfg').write_text('home = /opt/conda/bin\n');release=store.publish(USER,'source')['release'];(paths['code']/'train.py').write_bytes(b'new draft')
        args={'userId':USER,'project':'source','release':release};info=n.process('projects.snapshot.info',args);self.assertEqual(info['totalBytes'],5)
        with patch.object(store,'_release_meta',side_effect=AssertionError('Per-chunk large manifest parse')):
            result=n.process('projects.snapshot.get',{**args,'path':'train.py','offset':0});self.assertEqual(base64.b64decode(result['data']),b'fixed')
        with self.assertRaises(ValueError):n.process('projects.snapshot.get',{**args,'path':'../env/bin/python','offset':0})
    def test_seal_recovers_after_manifest_rename_before_receipt_commit(self):
        self.seal();n=self.nodes[1];receipt=n.projects().folder/(n.projects().key(self.begin)+'.sync.json');session=json.loads(receipt.read_text());session['state']='RECEIVING_MANIFEST';n.atomic_json(receipt,session)
        self.assertEqual(self.call('seal')['state'],'COPYING')
        self.call('chunk',path='sub/train.py',offset=0,data=base64.b64encode(self.data).decode());self.assertEqual(self.call('finish')['state'],'CODE_READY')

if __name__=='__main__':unittest.main()
