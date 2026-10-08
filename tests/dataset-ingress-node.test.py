"""Fixed owner/key lookup never creates an upload, workspace or false absence."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
from storage_test_helpers import local_data_mounts

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY/filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


D = module('ingress_node_dataset_cache', 'dataset-cache.py')
I = module('ingress_node_lookup', 'dataset-ingress-node.py')


class Lookup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = D.DatasetCache(Path(self.temp.name).resolve()/'cache', reserve_bytes=0)
        mount=local_data_mounts(Path(self.temp.name).resolve());mount.start();self.addCleanup(mount.stop)
        self.user = 'demo-user-1'
        self.upload = str(uuid.uuid4())
        self.node = SimpleNamespace(CONFIG={'machine': 'gpu-4', 'storageArchive': {
            'enabled': True, 'machine': 'gpu-4', 'authority': 'hdd'}, 'storageAuthority': {'enabled': True}},
            dataset_cache=lambda: (D, self.cache), workspace=lambda _: self.fail('lookup called workspace'),
            dataset_mount_check=lambda _:None,ROOT=Path(self.temp.name).resolve())
        self.node.CONFIG['datasets']={'root':str(self.cache.root),'mountPoint':str(self.node.ROOT),'reserveBytes':0}
        self.args = {'userId': self.user, 'uploadId': self.upload}
        self.folder = self.cache.root/'.uploads'/hashlib.sha256(self.user.encode()).hexdigest()/self.upload

    def seed(self, **changes):
        D._mkdir(self.cache.root/'.uploads');D._mkdir(self.folder.parent);D._mkdir(self.folder)
        value = {'schema': 1, **self.args, 'name': 'real-data', 'manifestBytes': 100,
                 'manifestSha256': 'a'*64, 'totalBytes': 12, 'entries': 2, **changes}
        D._write_json(self.folder/'session.json', value)

    def test_unknown_is_pure_read_and_authority_is_fixed(self):
        result = I.locate(self.node, self.args)
        self.assertFalse(result['present']);self.assertTrue(result['authority']['enabled'])
        self.assertFalse((self.cache.root/'.uploads').exists())
        self.node.CONFIG['storageTier'] = {'enabled': True}
        self.assertFalse(I.locate(self.node, self.args)['authority']['enabled'])

    def test_existing_identity_returns_only_fixed_spec_without_credentials(self):
        self.seed(transferToken='secret-do-not-return')
        result = I.locate(self.node, self.args)
        self.assertTrue(result['present'])
        self.assertEqual(set(result['specification']), {'name', 'manifestBytes', 'manifestSha256', 'totalBytes', 'entries'})
        self.assertNotIn('secret', str(result));self.assertNotIn('transferToken', str(result))

    def test_corrupt_cross_owner_and_transfer_sessions_never_mean_absent(self):
        for change in ({'userId': 'demo-user-2'}, {'entries': True}, {'archiveAdmission': {'schema': 1}}, {'manifestBytes': 0}):
            self.seed(**change)
            with self.assertRaises(ValueError):I.locate(self.node, self.args)

    def test_symlink_is_not_an_absence_and_input_is_not_a_path_or_role(self):
        self.seed();(self.folder/'session.json').unlink()
        (self.folder/'session.json').symlink_to(self.cache.root/'missing')
        with self.assertRaises(OSError):I.locate(self.node, self.args)
        for changes in ({'userId': '../../other'}, {'uploadId': '../x'}, {'hostAdmin': True}):
            with self.assertRaises(ValueError):I.locate(self.node, {**self.args, **changes})

    def capacity_args(self):
        return {**self.args, 'authority':'hdd', 'specification':{
            'name':'whole-corpus','manifestBytes':100,'manifestSha256':'a'*64,'totalBytes':12,'entries':2}}

    def disk(self, **changes):
        return SimpleNamespace(f_frsize=4096, f_bavail=10000, f_files=20000,
                               f_favail=10000, f_flag=0, **changes)

    def test_capacity_is_exact_admission_footprint_and_has_no_writes(self):
        args=self.capacity_args();self.node.CONFIG['datasets']['reserveBytes']=8192
        D._write_json(self.cache.root/'.upload-reservations'/('b'*64+'.json'),{'bytes':1234,'inodes':99})
        before={str(p.relative_to(self.cache.root)) for p in self.cache.root.rglob('*')}
        with patch.object(os,'fstatvfs',return_value=self.disk()):
            result=I.locate(self.node,args)
        self.assertFalse(result['present'])
        self.assertEqual(result['capacity'],dict(protocol='dataset-upload-capacity-v1',machine='gpu-4',authority='hdd',
            specificationSha256=hashlib.sha256(json.dumps(args['specification'],separators=(',',':')).encode()).hexdigest(),
            requiredBytes=12+100*4+2*8192+65536,availableBytes=4096*10000-8192-1234,
            requiredInodes=18,availableInodes=10000-1024-99,writable=True))
        self.assertEqual(before,{str(p.relative_to(self.cache.root)) for p in self.cache.root.rglob('*')})
        self.assertNotIn('capacity',I.locate(self.node,self.args))

    def test_capacity_rejects_partial_unknown_authority_spec_and_real_shortage(self):
        args=self.capacity_args()
        for bad in ({'authority':'hdd'}, {'specification':args['specification']},
                    {'authority':'other','specification':args['specification']},
                    {'authority':'hdd','specification':{**args['specification'],'entries':True}},
                    {'authority':'hdd','specification':{**args['specification'],'sourcePolicy':{}}}):
            with self.subTest(bad=bad),self.assertRaises((ValueError,PermissionError)):
                I.locate(self.node,{**self.args,**bad})
        for changes in ({'f_bavail':1},{'f_favail':1024},{'f_files':0},{'f_frsize':0},{'f_flag':getattr(os,'ST_RDONLY',1)}):
            disk=self.disk();disk.__dict__.update(changes)
            with self.subTest(disk=changes),patch.object(os,'fstatvfs',return_value=disk),self.assertRaises((ValueError,PermissionError)):
                I.locate(self.node,args)
        with patch.object(os,'access',return_value=False),self.assertRaises(PermissionError):I.locate(self.node,args)
        self.assertFalse((self.cache.root/'.uploads').exists())

    def test_capacity_keeps_present_and_incomplete_ids_out_of_candidate_pool(self):
        args=self.capacity_args();self.seed()
        result=I.locate(self.node,args)
        self.assertTrue(result['present']);self.assertNotIn('capacity',result)
        (self.folder/'session.json').unlink()
        D._mkdir(self.cache.root/'.upload-admissions')
        key=hashlib.sha256(json.dumps([self.user,self.upload],separators=(',',':')).encode()).hexdigest()
        D._write_json(self.cache.root/'.upload-admissions'/(key+'.json'),{})
        with self.assertRaisesRegex(ValueError,'incomplete'):I.locate(self.node,args)

    def test_capacity_rejects_incomplete_split_policy_and_same_media(self):
        self.node.CONFIG['storageTier']={'enabled':True,'budgetBytes':2**30}
        self.node.CONFIG['storageWarehouse']={'enabled':True}
        with self.assertRaises(ValueError):I.locate(self.node,self.capacity_args())
        cold=D.DatasetCache(self.node.ROOT/'warehouse',reserve_bytes=0)
        self.node.CONFIG['storageWarehouse'].update(root=str(cold.root),mountPoint=str(self.node.ROOT),reserveBytes=0)
        with self.assertRaisesRegex(ValueError,'distinct fixed roots and media'):I.locate(self.node,self.capacity_args())

    def test_capacity_split_root_reads_only_hdd_reservations_and_its_reserve(self):
        volume=self.node.ROOT/'cold-volume';volume.mkdir()
        cold=D.DatasetCache(volume/'warehouse',reserve_bytes=4096)
        self.node.CONFIG['storageTier']={'enabled':True,'budgetBytes':2**30}
        self.node.CONFIG['workspaceReserveBytes']=1000000
        self.node.CONFIG['storageWarehouse']={'enabled':True,'root':str(cold.root),
            'mountPoint':str(volume),'reserveBytes':4096}
        D._write_json(cold.root/'.upload-reservations'/('b'*64+'.json'),{'bytes':1234,'inodes':7})
        D._write_json(self.cache.root/'.upload-reservations'/('c'*64+'.json'),{'bytes':99999,'inodes':77})
        # Disposable roots use real directories/FDs with only separate disk
        # identity simulated; production still checks the actual mount table.
        inodes={p.stat().st_ino for p in [volume,cold.root,*cold.root.iterdir()]}
        fstat,stat=os.fstat,Path.stat
        def distinct(value):
            if value.st_ino not in inodes:return value
            fields=list(value);fields[2]+=4096
            return os.stat_result(fields)
        before={str(p.relative_to(self.node.ROOT)) for p in self.node.ROOT.rglob('*')}
        with patch.object(os,'fstat',side_effect=lambda fd:distinct(fstat(fd))), \
                patch.object(Path,'stat',new=lambda p,*a,**k:distinct(stat(p,*a,**k))), \
                local_data_mounts(self.node.ROOT,volume),patch.object(os,'fstatvfs',return_value=self.disk()):
            result=I.locate(self.node,self.capacity_args())
        self.assertTrue(result['authority']['enabled'])
        self.assertEqual(result['capacity']['availableBytes'],4096*10000-4096-1234)
        self.assertEqual(result['capacity']['availableInodes'],10000-1024-7)
        self.assertEqual(before,{str(p.relative_to(self.node.ROOT)) for p in self.node.ROOT.rglob('*')})

    def test_capacity_never_calls_a_creating_factory_and_missing_metadata_is_not_recreated(self):
        def forbidden():self.fail('capacity invoked a creating factory')
        self.node.dataset_source_cache=forbidden;self.node.dataset_cache=forbidden
        self.node.dataset_ingress_view=forbidden;self.node.storage_warehouse=forbidden
        with patch.object(os,'fstatvfs',return_value=self.disk()):
            self.assertTrue(I.locate(self.node,self.capacity_args())['capacity']['writable'])
        missing=self.cache.root/'.staging';missing.rmdir()
        with self.assertRaises(FileNotFoundError):I.locate(self.node,self.capacity_args())
        self.assertFalse(missing.exists())
        offline=self.cache.root.with_name('offline');self.cache.root.rename(offline)
        with self.assertRaises(FileNotFoundError):I.locate(self.node,self.capacity_args())
        self.assertFalse(self.cache.root.exists())

    def test_capacity_preserves_shared_workspace_safety_reserve_and_mount_guard(self):
        self.node.CONFIG['datasets']['reserveBytes']=8192
        self.node.CONFIG['workspaceReserveBytes']=16384
        with patch.object(os,'fstatvfs',return_value=self.disk()):
            capacity=I.locate(self.node,self.capacity_args())['capacity']
        self.assertEqual(capacity['availableBytes'],4096*10000-16384)
        with patch.object(self.node,'dataset_mount_check',side_effect=ValueError('fixed mount unavailable')):
            with self.assertRaisesRegex(ValueError,'fixed mount unavailable'):I.locate(self.node,self.capacity_args())
        with local_data_mounts():
            with self.assertRaises(ValueError):I.locate(self.node,self.capacity_args())

    def test_capacity_rejects_symlink_root_and_writable_by_others_metadata_without_repair(self):
        root=self.cache.root;offline=root.with_name('offline');root.rename(offline);root.symlink_to(offline)
        with self.assertRaises(OSError):I.locate(self.node,self.capacity_args())
        root.unlink();offline.rename(root)
        metadata=root/'.upload-reservations';metadata.chmod(0o777)
        with self.assertRaisesRegex(ValueError,'unsafe'):I.locate(self.node,self.capacity_args())
        self.assertEqual(metadata.stat().st_mode&0o777,0o777)

    def test_capacity_rejects_unsafe_sources_like_the_existing_cache_constructor(self):
        for source in ('/etc','/home/user',str(self.node.ROOT/'.ssh'),
                       str(self.cache.root),str(self.cache.root/'nested'),str(self.node.ROOT)):
            self.node.CONFIG['datasets']['sources']={'source':source}
            with self.subTest(source=source),self.assertRaisesRegex(ValueError,'source directory'):
                I.locate(self.node,self.capacity_args())
        self.node.CONFIG['datasets']['sources']={'../source':str(self.node.ROOT/'good-source')}
        with self.assertRaises(ValueError):I.locate(self.node,self.capacity_args())

    def test_capacity_rejects_invalid_workspace_reserve_in_single_and_split_policy(self):
        for split in (False,True):
            if split:self.node.CONFIG['storageWarehouse']={'enabled':True}
            for value in (True,None,-1,2**63):
                self.node.CONFIG['workspaceReserveBytes']=value
                with self.subTest(split=split,value=value),self.assertRaisesRegex(ValueError,'workspace free-space reserve'):
                    I.locate(self.node,self.capacity_args())


if __name__ == '__main__':unittest.main()
