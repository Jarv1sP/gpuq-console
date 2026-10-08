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
        self.user = 'demo-user-1'
        self.upload = str(uuid.uuid4())
        self.node = SimpleNamespace(CONFIG={'machine': 'gpu-4', 'storageArchive': {
            'enabled': True, 'machine': 'gpu-4', 'authority': 'hdd'}, 'storageAuthority': {'enabled': True}},
            dataset_cache=lambda: (D, self.cache), workspace=lambda _: self.fail('lookup called workspace'))
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
        args=self.capacity_args();self.cache.reserve_bytes=8192
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

    def test_capacity_uses_guarded_warehouse_view_not_training_cache_policy(self):
        self.node.CONFIG['storageTier']={'enabled':True}
        self.node.CONFIG['storageWarehouse']={'enabled':True}
        self.node.dataset_ingress_view=lambda:SimpleNamespace(CONFIG={**self.node.CONFIG,'storageTier':{'enabled':False}})
        with patch.object(os,'fstatvfs',return_value=self.disk()):
            self.assertTrue(I.locate(self.node,self.capacity_args())['capacity']['writable'])
        self.node.dataset_ingress_view=lambda:self.node
        with self.assertRaises(PermissionError):I.locate(self.node,self.capacity_args())


if __name__ == '__main__':unittest.main()
