"""Owner-only node-local imports on synthetic data/project stores; no services."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest.mock import patch
import uuid
from storage_test_helpers import local_data_mounts

spec=importlib.util.spec_from_file_location('local_import_base',Path(__file__).with_name('project-security.test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)


class LocalImportTests(base.ProjectSecurity):
    def setUp(self):
        super().setUp()
        for name in ('project-local-import.py','dataset-cache.py','data-workspace.py'):
            shutil.copy2(base.DEPLOY/name,self.root/name)
        mounts=local_data_mounts(self.root);mounts.start();self.addCleanup(mounts.stop)
        self.node.CONFIG['datasets']={'root':str(self.root/'cache'),'mountPoint':str(self.root),'sources':{},'reserveBytes':0}
        self.node.dataset_mount_check=lambda *args:None
        self.imports=self.ops.local_imports()
        self.node.projects=lambda:self.ops
        self.ops.local_imports=lambda:self.imports
        self.launch=patch.object(self.node,'run',return_value='');self.launch_mock=self.launch.start();self.addCleanup(self.launch.stop)
        self.module=sys.modules.get(type(self.imports).__module__)
        # Dynamically loaded helpers do not register themselves. Their globals
        # are still the same trusted test module, so patch only this fixture.
        self.globals=self.imports.begin.__globals__
        self.available=patch.dict(self.globals,{'atomic_import_available':lambda:True})
        self.available.start();self.addCleanup(self.available.stop)
        self.imports.worker_active=lambda args:True
        self.imports.data.unit_stopped=lambda unit:True
        self.source=self.imports.data.storage(self.args['userId'])[2]/'data'/'source'
        self.source.mkdir(mode=0o700)
        (self.source/'train.py').write_bytes(b'print("training")\n')
        (self.source/'train.py').chmod(0o700)
        (self.source/'nested').mkdir(mode=0o700)
        (self.source/'nested'/'weights.bin').write_bytes(b'fixture'*300000)
        self.code=self.ops.store.dev_paths(*self.ops.identity(self.args))['code']
        self.request={**self.args,'sourcePath':'source','destinationPath':'imported','key':str(uuid.uuid4())}

    def begin(self,**extra):return self.node.process('projects.local-import.begin',{**self.request,**extra})
    def reference(self,**extra):return {**self.args,'key':self.request['key'],**extra}
    def worker(self):
        def fixture_rename(source_fd,source,destination_fd,destination):
            try:os.stat(destination,dir_fd=destination_fd,follow_symlinks=False)
            except FileNotFoundError:pass
            else:raise FileExistsError(destination)
            # Offline Mac fixture only; Linux kernel no-replace is separately
            # tested below. Production never uses this fallback.
            os.rename(source,destination,src_dir_fd=source_fd,dst_dir_fd=destination_fd)
        with patch.dict(self.globals,{'rename_new':fixture_rename}):
            return self.imports.worker(*self.ops.identity(self.args),self.request['key'])

    def test_node_rpc_begins_fenced_and_full_local_copy_never_uses_chunk_rpc(self):
        self.ops.store.warning_bytes=1
        start=self.begin();self.assertEqual(start['state'],'IMPORTING');self.assertFalse(start['draftChanged'])
        self.assertTrue(self.imports.project_pointer(self.request).exists())
        with self.assertRaisesRegex(ValueError,'pending'):self.ops.writable(self.args)
        with self.assertRaisesRegex(ValueError,'fenced'):self.imports.data.writable(self.args)
        self.assertEqual(self.worker(),0)
        result=self.node.process('projects.local-import.status',self.reference())
        self.assertEqual((result['state'],result['files'],result['draftChanged']),('IMPORTED',2,True))
        self.assertEqual(result['warnings'][0]['code'],'LARGE_PROJECT')
        self.assertEqual(result['warnings'][0]['warningBytes'],1)
        self.assertFalse(result['warnings'][0]['blocking'])
        self.assertGreaterEqual(result['warnings'][0]['bytes'],result['totalBytes'])
        self.assertEqual((self.code/'imported'/'nested'/'weights.bin').read_bytes(),(self.source/'nested'/'weights.bin').read_bytes())
        self.assertEqual((self.code/'imported'/'train.py').stat().st_mode&0o777,0o700)
        self.assertFalse((self.code/'imported').is_symlink())
        self.assertFalse((self.code/'source').exists())
        self.ops.writable(self.args);self.imports.data.writable(self.args)
        manifest=json.loads((self.imports.folder(self.request)/(self.request['key']+'.manifest.json')).read_text())
        self.assertEqual(next(row for row in manifest if row['path']=='nested/weights.bin')['sha256'],hashlib.sha256((self.source/'nested'/'weights.bin').read_bytes()).hexdigest())
        self.assertEqual(self.ops.store.status(*self.ops.identity(self.args))['releases'],[])
        self.assertNotIn(str(self.root),json.dumps(result))

    def test_fixed_uuid_replay_does_not_launch_again_and_paths_cannot_change(self):
        self.begin();self.assertEqual(self.begin()['key'],self.request['key'])
        self.assertEqual(self.launch_mock.call_count,1)
        with self.assertRaisesRegex(ValueError,'immutable'):self.begin(destinationPath='changed')
        with self.assertRaisesRegex(ValueError,'pending'):self.begin(key=str(uuid.uuid4()))

    def test_host_paths_traversal_secret_entries_links_and_other_owner_rejected(self):
        for field,value in [('sourcePath','/data1/cyx/stage'),('sourcePath','../other'),('destinationPath','.'),('sourcePath','.ssh'),('sourcePath','source\\escape')]:
            with self.subTest(value=value),self.assertRaises(ValueError):self.begin(**{field:value})
        for extra in ({'hostAdmin':True},{'root':'/data1'},{'owner':self.args['userId']}):
            with self.assertRaises(ValueError):self.begin(**extra)
        with self.assertRaises(ValueError):self.begin(userId='demo-user-9')
        (self.source/'unsafe').symlink_to('/etc/passwd')
        self.begin();self.assertEqual(self.worker(),1)
        self.assertEqual(self.imports.status(self.reference())['state'],'FAILED')
        self.assertFalse((self.code/'imported').exists());self.assertTrue((self.source/'unsafe').is_symlink())

    def test_source_change_after_admission_never_publishes_partial_directory(self):
        self.begin();(self.source/'later.txt').write_text('new')
        self.assertEqual(self.worker(),1)
        self.assertEqual(self.imports.status(self.reference())['state'],'FAILED')
        self.assertFalse((self.code/'imported').exists())

    def test_new_destination_no_replace_and_busy_writers_block_admission(self):
        (self.code/'imported').mkdir()
        with self.assertRaisesRegex(ValueError,'already exists'):self.begin()
        (self.code/'imported').rmdir()
        pointer=self.node.terminal_pointer(self.args);pointer.parent.mkdir(exist_ok=True);pointer.write_text(str(uuid.uuid4()))
        with patch.object(self.ops,'terminal_stopped',return_value=False),self.assertRaisesRegex(ValueError,'terminals'):self.begin()
        self.assertFalse(self.imports.project_pointer(self.request).exists())

    def test_launch_failure_is_unknown_and_keeps_both_fences(self):
        self.imports.worker_active=lambda args:False
        with patch.object(self.node,'run',side_effect=OSError('launch uncertain')):result=self.begin()
        self.assertEqual(result['state'],'UNKNOWN')
        with self.assertRaises(ValueError):self.ops.writable(self.args)
        with self.assertRaises(ValueError):self.imports.data.writable(self.args)
        self.assertEqual(self.imports.load(self.reference())['state'],'IMPORTING')

    def test_old_publication_receipt_cannot_hide_pending_or_unknown_local_import(self):
        self.begin()
        ready='a'*64
        publication_id=str(uuid.uuid4())
        catalog={'state':'READY','latestReadyRelease':ready,'releases':[{'release':ready}]}
        for stored,active,expected in [('IMPORTING',True,'IMPORTING'),('COMMITTING',True,'COMMITTING'),('IMPORTING',False,'UNKNOWN')]:
            value=self.imports.load(self.reference());self.imports.write(self.reference(),{**value,'state':stored})
            self.imports.worker_active=lambda args:active
            for publication_state,committed in [('PUBLISHING',False),('FAILED',False),('UNKNOWN',False),('UNKNOWN',True),('FAILED',True)]:
                with self.subTest(import_state=expected,publication_state=publication_state,committed=committed):
                    pending={**self.args,'state':publication_state,'publicationId':publication_id,'error':'old publication error',
                             'projectUUID':self.ops.store.project_uuid(*self.ops.identity(self.args)),
                             'projectGeneration':self.ops.store.generation(*self.ops.identity(self.args))}
                    if committed:pending['committedRelease']=ready
                    self.node.atomic_json(self.ops.receipt_path(self.args),pending)
                    with patch.object(self.ops.store,'status',return_value=dict(catalog)),patch.object(self.ops,'active',return_value=True):
                        result=self.ops.status(self.args)
                    self.assertEqual(result['state'],expected)
                    self.assertEqual(result['localImport']['state'],expected)
                    self.assertEqual(result['localImport']['key'],self.request['key'])
                    self.assertIn('original operation ID',result['error'])
                    self.assertEqual(result['publication']['state'],'READY' if committed else publication_state)
                    with self.assertRaises(ValueError):self.ops.writable(self.args)
                    with self.assertRaises(ValueError):self.imports.data.writable(self.args)

    def test_cancel_discards_private_stage_only_and_unconfirmed_commit_remains_fenced(self):
        self.begin();self.assertEqual(self.imports.cancel(self.reference())['state'],'CANCELED')
        self.assertTrue(self.source.exists());self.assertFalse((self.code/'imported').exists())
        self.assertEqual(self.worker(),0)
        fresh={**self.request,'key':str(uuid.uuid4())};self.imports.begin(fresh)
        value=self.imports.load(fresh);self.imports.write(fresh,{**value,'state':'COMMITTING'})
        self.imports.worker_active=lambda args:False
        self.assertEqual(self.imports.cancel({k:fresh[k] for k in ('userId','project','key')})['state'],'UNKNOWN')
        with self.assertRaises(ValueError):self.ops.writable(self.args)

    def test_entry_bound_includes_empty_directories(self):
        for index in range(4):(self.source/('empty'+str(index))).mkdir()
        self.ops.store.max_entries=3
        self.begin();self.assertEqual(self.worker(),1)
        self.assertIn('entry budget',self.imports.load(self.reference())['error'])

    def test_post_rename_receipt_loss_keeps_commit_unknown_and_cannot_cancel_committed_code(self):
        self.begin();original=self.node.atomic_json
        def fail_final(path,value):
            if isinstance(value,dict) and value.get('state')=='IMPORTED':raise OSError('synthetic final receipt loss')
            return original(path,value)
        with patch.object(self.node,'atomic_json',side_effect=fail_final):self.assertEqual(self.worker(),1)
        self.imports.worker_active=lambda args:False
        self.assertEqual(self.imports.status(self.reference())['state'],'UNKNOWN')
        self.assertTrue((self.code/'imported'/'train.py').exists())
        self.assertEqual(self.imports.cancel(self.reference())['state'],'UNKNOWN')
        self.assertTrue((self.code/'imported'/'train.py').exists())
        with self.assertRaises(ValueError):self.ops.writable(self.args)

    def test_source_file_change_during_copy_is_rejected_without_partial_commit(self):
        self.begin();original=os.read;changed=False
        def mutate(fd,size):
            nonlocal changed
            value=original(fd,size)
            if value and not changed and len(value)>1024:
                changed=True;(self.source/'nested'/'weights.bin').write_bytes(b'changed')
            return value
        with patch.object(os,'read',side_effect=mutate):self.assertEqual(self.worker(),1)
        self.assertFalse((self.code/'imported').exists());self.assertEqual(self.imports.status(self.reference())['state'],'FAILED')

    @unittest.skipUnless(sys.platform.startswith('linux'),'real renameat2 requires Linux')
    def test_real_kernel_atomic_no_replace(self):
        self.begin();self.assertEqual(self.imports.worker(*self.ops.identity(self.args),self.request['key']),0)
        self.assertEqual(self.imports.status(self.reference())['state'],'IMPORTED')
        (self.code/'another').mkdir();(self.code/'another'/'sentinel').write_text('preserved')
        (self.code/'staging').mkdir();(self.code/'staging'/'new').write_text('pending')
        fd=os.open(self.code,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            with self.assertRaises(FileExistsError):self.globals['rename_new'](fd,'staging',fd,'another')
        finally:os.close(fd)
        self.assertEqual((self.code/'another'/'sentinel').read_text(),'preserved')
        self.assertEqual((self.code/'staging'/'new').read_text(),'pending')


if __name__=='__main__':unittest.main()
