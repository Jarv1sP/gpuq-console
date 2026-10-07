"""Real temporary files/FDs; synthetic mounts only. No GPU, SSH or services."""
import copy
import importlib.util
import json
import os
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parents[1]/'deploy'
spec = importlib.util.spec_from_file_location('personal_store_tests', HERE/'project-store.py')
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
helpers = __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))


class PersonalStorageTests(unittest.TestCase):
    def setUp(self):
        helpers['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.control = self.root/'control'; self.control.mkdir(mode=0o700)
        self.base = self.root/'conda'; (self.base/'bin').mkdir(parents=True)
        (self.base/'bin/python').write_bytes(b'synthetic approved interpreter; never execute')
        (self.base/'conda-meta').mkdir()
        (self.base/'lib').mkdir()
        self.config = {'root':str(self.control),'conda':str(self.base),'workspaceReserveBytes':0}
        self.store = s.ProjectStore(self.control,self.base,reserve_bytes=0,config=self.config)
        self.user = 'storage-test-user'; self.legacy = 'legacy'
        self.store.create(self.user,self.legacy)
        self.mounted = []
        volumes = {}
        for index,tier in enumerate(('hdd','ssd')):
            mount = self.root/tier; mount.mkdir(mode=0o700)
            path = mount/'personal'; path.mkdir(mode=0o700)
            self.mounted.append(mount)
            volumes[tier] = {'root':str(path),'mountPoint':str(mount),
                'filesystemUuid':str(uuid.UUID(int=index+1)), 'rootInode':path.stat().st_ino,'reserveBytes':0}
        self.config['personalStorage'] = {'enabled':True,**volumes}
        guard = helpers['local_data_mounts'](*self.mounted); guard.start(); self.addCleanup(guard.stop)
        storage = self.store.personal_storage()
        # Each temporary mount represents a dedicated data volume. Only its
        # UUID->device lookup is synthetic; actual no-follow FD/inode checks stay.
        lookup = patch.object(storage.guard,'uuid_device',return_value=self.root.stat().st_dev)
        lookup.start(); self.addCleanup(lookup.stop)

    def cleanup(self):
        for current, dirs, _ in os.walk(self.root,followlinks=False):
            Path(current).chmod(0o700)
            for name in dirs:
                p=Path(current)/name
                if not p.is_symlink():p.chmod(0o700)
        self.temp.cleanup()

    def published(self,name='new-project',text='print("original")\n'):
        self.store.create(self.user,name)
        dev=self.store.dev_paths(self.user,name)
        (dev['code']/'train.py').write_text(text)
        (dev['env']/'pyvenv.cfg').write_text('home = /opt/conda/bin\n')
        if not (dev['env']/'bin').exists():
            (dev['env']/'bin').mkdir()
            (dev['env']/'bin/python').symlink_to('/opt/conda/bin/python')
        return self.store.publish(self.user,name)['release']

    def test_new_project_defaults_hdd_without_moving_legacy(self):
        legacy=self.store.dev_paths(self.user,self.legacy)
        before={k:str(v) for k,v in legacy.items()}
        result=self.store.create(self.user,'new-project')
        self.assertEqual(result['storageLayout'],'personal-storage-v1')
        self.assertEqual(result['workspaceTier'],'hdd')
        self.assertEqual(result['workspaceModes'],['isolated','shared'])
        for path in self.store.dev_paths(self.user,'new-project').values():
            self.assertIn(Path(self.config['personalStorage']['hdd']['root']),path.parents)
        self.assertEqual(before,{k:str(v) for k,v in self.store.dev_paths(self.user,self.legacy).items()})
        self.assertNotIn('storageLayout',self.store.create(self.user,self.legacy))
        self.assertEqual({p['project'] for p in self.store.list(self.user)},{self.legacy,'new-project'})

    def test_isolated_workspace_is_writable_and_resume_does_not_reset_outputs(self):
        version=self.published(); jid=str(uuid.uuid4())
        result=self.store.run_paths(self.user,'new-project',version,jid)
        self.assertFalse(result['readonly']);self.assertEqual(result['code'],result['output'])
        (result['code']/'train.py').write_text('user edit in own working copy')
        (result['output']/'my-checkpoint.pt').write_bytes(b'resume-state')
        release=self.store.release(self.user,'new-project',version)
        self.assertEqual((release['code']/'train.py').read_text(),'print("original")\n')
        again=self.store.run_paths(self.user,'new-project',version,jid)
        self.assertEqual(again,result)
        self.assertEqual((again['output']/'my-checkpoint.pt').read_bytes(),b'resume-state')
        self.assertEqual((again['code']/'train.py').read_text(),'user edit in own working copy')
        other=self.store.run_paths(self.user,'new-project',version,str(uuid.uuid4()))
        self.assertNotEqual(other['code'],result['code'])
        self.assertFalse((other['output']/'my-checkpoint.pt').exists())

    def test_shared_workspace_is_opt_in_and_fixed_to_one_release(self):
        version=self.published()
        a=self.store.run_paths(self.user,'new-project',version,str(uuid.uuid4()),workspace_mode='shared')
        (a['output']/'shared.pt').write_bytes(b'shared-by-choice')
        b=self.store.run_paths(self.user,'new-project',version,str(uuid.uuid4()),workspace_mode='shared')
        self.assertEqual(a['output'],b['output']);self.assertEqual((b['output']/'shared.pt').read_bytes(),b'shared-by-choice')
        dev=self.store.dev_paths(self.user,'new-project');(dev['code']/'train.py').write_text('print("second")\n')
        next_version=self.store.publish(self.user,'new-project')['release']
        c=self.store.run_paths(self.user,'new-project',next_version,str(uuid.uuid4()),workspace_mode='shared')
        self.assertNotEqual(c['output'],a['output']);self.assertFalse((c['output']/'shared.pt').exists())

    def test_same_job_mode_conflict_and_cross_owner_are_rejected_without_overwrite(self):
        version=self.published();jid=str(uuid.uuid4())
        a=self.store.run_paths(self.user,'new-project',version,jid,workspace_mode='isolated')
        (a['output']/'result').write_bytes(b'keep')
        with self.assertRaises(ValueError):self.store.run_paths(self.user,'new-project',version,jid,workspace_mode='shared')
        with self.assertRaises(ValueError):self.store.existing_run_paths('other-owner','new-project',version,jid)
        self.assertEqual((a['output']/'result').read_bytes(),b'keep')
        for mode in (True,'auto','',[],{}):
            with self.subTest(mode=mode),self.assertRaises(ValueError):
                self.store.run_paths(self.user,'new-project',version,str(uuid.uuid4()),workspace_mode=mode)

    def test_existing_output_reader_uses_hdd_without_current_base_or_reinitialization(self):
        version=self.published();jid=str(uuid.uuid4())
        paths=self.store.run_paths(self.user,'new-project',version,jid)
        (paths['output']/'result.pt').write_bytes(b'original-result')
        self.config['personalStorage']['enabled']=False
        with patch.object(self.store,'base_fingerprint',side_effect=AssertionError('must not require base')):
            result=self.store.existing_run_paths(self.user,'new-project',version,jid)
        self.assertEqual(result['output'],paths['output'])
        self.assertEqual((result['output']/'result.pt').read_bytes(),b'original-result')
        self.assertEqual(self.store.create(self.user,'new-project')['storageLayout'],'personal-storage-v1')

    def test_private_data_roots_are_user_isolated_and_not_host_disks(self):
        storage=self.store.personal_storage();fds=storage.open_data(self.user)
        try:
            self.assertEqual([p for _,p in fds],['/data-hdd','/data-ssd'])
            for tier,(fd,_) in zip(('hdd','ssd'),fds):
                expected=storage.data_path(self.user,tier)
                self.assertEqual(os.fstat(fd).st_ino,expected.stat().st_ino)
                self.assertNotEqual(expected,storage.roots[tier])
                other=storage.data_path('other-owner',tier,create=True)
                self.assertNotEqual(expected,other)
        finally:
            for fd,_ in fds:os.close(fd)
            for fd in fds.locks:os.close(fd)

    def test_capability_requires_complete_selected_runtime_not_unused_profile(self):
        storage=self.store.personal_storage();runtime=self.root/'selected-runtime';runtime.mkdir(mode=0o700)
        for name in ['node-executor.py','project-store.py','personal-oci.py','sandbox-runner.py']:
            shutil.copy2(HERE/name,runtime/name)
        with patch.dict(storage.runtime_ready.__func__.__globals__,{'HERE':runtime}):
            self.assertTrue(storage.runtime_ready());self.assertTrue(storage.status()['available'])
            # An incomplete active helper cohort never enables the profile.
            (runtime/'sandbox-runner.py').write_text('PERSONAL_STORAGE_PROTOCOL=0\n')
            self.assertFalse(storage.runtime_ready());self.assertFalse(storage.status()['available'])

    def test_shared_control_volume_reserve_cannot_be_lowered_by_new_alias(self):
        storage=self.store.personal_storage();self.config['workspaceReserveBytes']=100
        self.config['personalStorage']['ssd']['reserveBytes']=1
        self.assertEqual(storage.reserve('ssd'),100)
        with patch.object(os,'fstatvfs',return_value=type('Space',(),{'f_bavail':99,'f_frsize':1})()):
            with self.assertRaisesRegex(ValueError,'reserveBytes=100'):storage.require('ssd')

    def test_concurrent_claim_waits_for_short_metadata_lock_instead_of_failing_job(self):
        version=self.published();claims=s.private_dir(self.store.path/'.run-claims',create=True)
        entered,released=threading.Event(),threading.Event()
        def hold():
            with self.store._file_lock(claims/'.lock',blocking=True):
                entered.set();self.assertTrue(released.wait(5))
        with ThreadPoolExecutor(max_workers=2) as pool:
            holder=pool.submit(hold);self.assertTrue(entered.wait(5))
            run=pool.submit(self.store.run_paths,self.user,'new-project',version,str(uuid.uuid4()))
            try:self.assertFalse(run.done(),'claim contention must wait, not permanently fail a new preparation')
            finally:released.set()
            holder.result(timeout=5);result=run.result(timeout=5)
            self.assertEqual(result['storageLayout'],'personal-storage-v1')

    def test_mount_root_identity_and_unsafe_links_fail_closed(self):
        storage=self.store.personal_storage()
        self.config['personalStorage']['hdd']['rootInode']+=1
        with self.assertRaisesRegex(ValueError,'identity'):storage.check('hdd')
        self.config['personalStorage']['hdd']['rootInode']-=1
        with helpers['local_data_mounts'](self.mounted[1]):
            with self.assertRaises(ValueError):storage.check('hdd')
        raw=storage.data_path(self.user,'hdd',create=True)
        raw.rename(raw.with_name('original-data'));raw.symlink_to(self.control,target_is_directory=True)
        with self.assertRaises((ValueError,OSError)):storage.open_data(self.user)

    def test_capacity_check_uses_target_tier_and_disabled_does_not_create_new_hdd_project(self):
        storage=self.store.personal_storage();self.config['personalStorage']['hdd']['reserveBytes']=100
        free=type('Space',(),{'f_bavail':109,'f_frsize':1})()
        with patch.object(os,'fstatvfs',return_value=free),self.assertRaisesRegex(ValueError,'requestedBytes=10'):
            storage.require('hdd',10)
        self.config['personalStorage']['enabled']=False
        result=self.store.create(self.user,'legacy-new')
        self.assertNotIn('storageLayout',result)
        self.assertIn(self.control,self.store.dev_paths(self.user,'legacy-new')['code'].parents)


if __name__=='__main__':unittest.main()
