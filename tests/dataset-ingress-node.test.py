"""Fixed owner/key lookup never creates an upload, workspace or false absence."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
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


if __name__ == '__main__':unittest.main()
