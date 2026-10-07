"""Real node HDD publication, leases and read-only mount FDs; no GPU/systemd."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
from storage_test_helpers import local_data_mounts,isolated_platform_pin

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'


class Publish(unittest.TestCase):
    def setUp(self):
        isolated_platform_pin(self)
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name).resolve()
        self.addCleanup(self.cleanup)
        self.code=self.base/'runtime';self.code.mkdir(mode=0o700)
        for p in DEPLOY.glob('*.py'):shutil.copy2(p,self.code/p.name)
        self.control=self.base/'control';self.control.mkdir(mode=0o700)
        (self.control/'jobs').mkdir(mode=0o700)
        self.conda=self.base/'conda';self.conda.mkdir()
        volumes={};mounts=[self.base]
        for i,tier in enumerate(('hdd','ssd')):
            mount=self.base/tier;mount.mkdir(mode=0o700);mounts.append(mount)
            root=mount/'personal';root.mkdir(mode=0o700)
            volumes[tier]={'root':str(root),'mountPoint':str(mount),'filesystemUuid':str(uuid.UUID(int=i+1)),
                           'rootInode':root.stat().st_ino,'reserveBytes':0}
        config={'root':str(self.control),'conda':str(self.conda),'personalStorage':{'enabled':True,**volumes},
                'datasets':{'root':str(self.base/'legacy'),'mountPoint':str(self.base),'reserveBytes':0,'sources':{}}}
        (self.code/'node-config.json').write_text(json.dumps(config))
        table=local_data_mounts(*mounts);table.start();self.addCleanup(table.stop)
        original=os.stat;device=self.base.stat().st_dev
        def probe(path,*args,**kwargs):
            if isinstance(path,(str,Path)) and str(path).startswith('/dev/disk/by-uuid/'):
                return SimpleNamespace(st_mode=stat.S_IFBLK|0o600,st_uid=0,st_rdev=device)
            return original(path,*args,**kwargs)
        guard=patch.object(os,'stat',side_effect=probe);guard.start();self.addCleanup(guard.stop)
        spec=importlib.util.spec_from_file_location('personal_publish_node',self.code/'node-executor.py')
        self.n=importlib.util.module_from_spec(spec);sys.modules[spec.name]=self.n;spec.loader.exec_module(self.n)
        self.n.run=lambda *a,**kw:''
        definition=importlib.util.spec_from_file_location('personal_publish_helpers',self.code/'personal-storage.py')
        self.p=importlib.util.module_from_spec(definition);definition.loader.exec_module(self.p)
        self.storage=self.p.PersonalStorage(config);self.user='demo-user-8'
        self.raw=self.storage.data_path(self.user,'hdd',create=True)/'samples';self.raw.mkdir()
        (self.raw/'train.csv').write_bytes(b'row,value\n1,2\n')
        self.key=str(uuid.uuid4())
        self.publisher=self.p.publication(self.n,self.user,'hdd')

    def cleanup(self):
        for root,dirs,_ in os.walk(self.base,followlinks=False):
            Path(root).chmod(0o700)
            for name in dirs:
                p=Path(root)/name
                if not p.is_symlink():p.chmod(0o700)
        self.temp.cleanup()

    def publish(self):
        result=self.publisher.publish({'userId':self.user,'key':self.key,'name':'samples','path':'samples'})
        self.assertEqual(result['state'],'PUBLISHING')
        self.assertEqual(self.publisher.worker(self.user,self.key),0)
        return self.publisher.status(self.user,self.key)

    def test_hdd_publication_is_fixed_verified_and_never_materializes_on_ssd(self):
        result=self.publish();self.assertEqual(result['state'],'READY')
        dataset=result['dataset'];version=result['version']
        self.assertTrue(dataset.startswith('h-'))
        _,cache=self.n.dataset_cache_for(dataset)
        self.assertEqual(cache.personalTier,'hdd')
        self.assertIn(Path(self.storage.roots['hdd']),cache.root.parents)
        module,legacy=self.n.dataset_cache()
        self.assertFalse(legacy._paths(dataset)['.registry'].exists())
        self.assertEqual((self.raw/'train.csv').read_bytes(),b'row,value\n1,2\n')
        published=cache._paths(dataset,version)['ready']/'data/train.csv'
        (self.raw/'train.csv').write_bytes(b'new draft')
        self.assertEqual(published.read_bytes(),b'row,value\n1,2\n')
        status=self.n.process('datasets.status',{'userId':self.user,'dataset':dataset,'version':version,'hostAdmin':False})
        self.assertEqual(status['state'],'READY')
        listing=self.n.process('datasets.list',{'userId':self.user,'hostAdmin':False})
        self.assertEqual(next(r for r in listing['datasets'] if r['dataset']==dataset)['storageTier'],'hdd')

    def test_hdd_unused_project_retirement_keeps_same_volume_and_original_receipt(self):
        ops=self.n.projects();ops.store.create(self.user,'empty-project')
        args={'userId':self.user,'project':'empty-project'}
        path=ops.store._project(self.user,'empty-project')[0]
        (path/'dev/code/keep.txt').write_bytes(b'preserved bytes')
        lifecycle=ops.lifecycle();plan=lifecycle.plan(args)
        self.assertEqual(plan['state'],'ELIGIBLE')
        request={**args,'key':str(uuid.uuid4()),'revision':plan['lifecycle']['revision'],'manifestSha256':plan['manifestSha256']}
        result=lifecycle.retire(request);self.assertEqual(result['state'],'RETIRED')
        target=path.parent/'.trash'/request['key']
        self.assertFalse(path.exists());self.assertEqual((target/'dev/code/keep.txt').read_bytes(),b'preserved bytes')
        self.assertEqual(target.stat().st_dev,Path(self.storage.roots['hdd']).stat().st_dev)
        self.assertEqual(lifecycle.retire(request)['state'],'RETIRED')
        with self.assertRaises(ValueError):ops.store.create(self.user,'empty-project')

    def test_hdd_training_lease_mount_and_release_use_same_root(self):
        result=self.publish();dataset,version=result['dataset'],result['version']
        job={'id':str(uuid.uuid4()),'userId':self.user,'datasets':[{'dataset':dataset,'version':version}]}
        leases=self.n.acquire_datasets(job);self.assertEqual(len(leases),1)
        self.assertIn(str(self.storage.roots['hdd']),leases[0]['path'])
        opened=self.n._dataset_open_mounts(job,leases)
        try:
            self.assertEqual(opened[0][1],'/data2/'+dataset)
            self.assertEqual(os.fstat(opened[0][0]).st_ino,Path(leases[0]['path']).stat().st_ino)
        finally:
            for fd,_ in opened:os.close(fd)
        _,cache=self.n.dataset_cache_for(dataset);actor=self.n.DATASET_MODULE.Principal('builtin-admin',True)
        cache.release_lease(actor,dataset,version,leases[0]['leaseId'])
        self.assertFalse(cache._leases(dataset,version))

    def test_personal_originals_never_offer_managed_cache_release(self):
        result=self.publish();ref={'dataset':result['dataset'],'version':result['version']}
        args={**ref,'userId':self.user,'hostAdmin':False}
        cap=self.n.process('storage.cache-action.capabilities',args)
        self.assertEqual(cap['protocol'],0);self.assertFalse(cap['release']);self.assertFalse(cap['prepare'])
        for action in ['prepare','release']:
            with self.assertRaisesRegex(ValueError,'Personal immutable originals'):
                self.n.process('storage.cache-action.'+action,{**args,'key':str(uuid.uuid4())})
        with self.assertRaises(PermissionError):self.n.process('storage.cache-action.capabilities',{**args,'userId':'demo-user-9'})
        with self.assertRaises(ValueError):self.n.process('storage.cache-action.capabilities',{**args,'force':True})
        _,cache=self.n.dataset_cache_for(ref['dataset']);self.assertEqual(cache.status(self.n.DATASET_MODULE.Principal(self.user,False),**ref)['state'],'READY')

    def test_live_raw_writer_prevents_publication_and_pending_publication_prevents_new_writer(self):
        lock=self.storage.data_lifetime(self.user,'hdd')
        try:
            with self.assertRaises((ValueError,BlockingIOError)):
                self.publisher.publish({'userId':self.user,'key':self.key,'name':'samples','path':'samples'})
        finally:os.close(lock)
        self.publisher.publish({'userId':self.user,'key':self.key,'name':'samples','path':'samples'})
        with self.assertRaises(ValueError):self.storage.data_lifetime(self.user,'hdd')

    def test_other_user_cannot_read_published_version_or_owner_raw_directory(self):
        result=self.publish();dataset,version=result['dataset'],result['version']
        with self.assertRaises(PermissionError):
            self.n.process('datasets.status',{'userId':'demo-user-9','hostAdmin':False,'dataset':dataset,'version':version})
        listing=self.n.process('datasets.list',{'userId':'demo-user-9','hostAdmin':False})
        self.assertFalse(any(r['dataset']==dataset for r in listing['datasets']))
        self.assertNotEqual(self.storage.data_path(self.user,'hdd'),self.storage.data_path('demo-user-9','hdd',create=True))


    def test_explicit_personal_tiers_do_not_override_legacy_cache_only_policy(self):
        self.n.CONFIG['storageTier']={'enabled':True,'budgetBytes':1024**3}
        result=self.publish();self.assertEqual(result['state'],'READY')
        ssd=self.storage.data_path(self.user,'ssd',create=True)/'ssd-samples';ssd.mkdir(mode=0o700)
        (ssd/'sample.bin').write_bytes(b'explicit SSD choice')
        publisher=self.p.publication(self.n,self.user,'ssd');key=str(uuid.uuid4())
        publisher.publish({'userId':self.user,'key':key,'name':'ssd-samples','path':'ssd-samples'})
        self.assertEqual(publisher.worker(self.user,key),0)
        result=publisher.status(self.user,key);self.assertEqual(result['state'],'READY')
        _,cache=self.n.dataset_cache_for(result['dataset']);self.assertEqual(cache.personalTier,'ssd')
        self.assertIn(Path(self.storage.roots['ssd']),cache.root.parents)
        definition=importlib.util.spec_from_file_location('legacy_workspace_policy',self.code/'data-workspace.py')
        module=importlib.util.module_from_spec(definition);definition.loader.exec_module(module)
        with self.assertRaisesRegex(PermissionError,'HDD warehouse'):
            module.DataWorkspaces(self.n).publish({'userId':self.user,'key':str(uuid.uuid4()),'name':'not-hdd','path':'samples'})


if __name__=='__main__':unittest.main()
