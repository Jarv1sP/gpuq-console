"""Fixed-version directory pages: no SSH, GPU, service or production writes."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('files_dataset_fixture', Path(__file__).with_name('node-datasets.test.py'))
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)


class DatasetFiles(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.NodeDatasets('test_all_legacy_dataset_owners_keep_existing_cohort_behavior')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.node, self.cache, self.module = self.fixture.node, self.fixture.cache, self.fixture.module
        self.node.CONFIG['machine'] = 'fixture-node'
        self.version = self.fixture.version

    def call(self, **args):
        return self.node.process('datasets.files.list', {'userId':'demo-user-1', 'hostAdmin':False,
            'dataset':'example', 'version':self.version, **args})

    def source(self, count):
        (self.fixture.source/'train.txt').unlink()
        for index in range(count):
            (self.fixture.source/('file-%04d.txt' % index)).write_text('x'*(index % 5+1))
        (self.fixture.source/'folder').mkdir()
        (self.fixture.source/'folder'/'child.txt').write_text('inside')
        self.version = self.cache.register_source(self.fixture.admin, 'example', 'approved', ['demo-user-1'])['version']
        self.cache.materialize(self.fixture.user, 'example', self.version)

    def test_ready_page_has_no_private_paths_and_no_persistent_lease(self):
        self.fixture.ready()
        before = list(self.cache.leases_root.rglob('*')) if hasattr(self.cache, 'leases_root') else None
        value = self.call()
        self.assertEqual(value, dict(protocol='dataset-files-list-v1', available=True, machine='fixture-node',
            dataset='example', version=self.version, path='', entries=[dict(name='train.txt', path='train.txt', type='file',
            bytes=len('small immutable training sample\n'))], nextCursor=None))
        self.assertNotIn(str(self.fixture.base), json.dumps(value))
        self.assertNotIn('token', json.dumps(value))
        if before is not None:
            self.assertEqual(list(self.cache.leases_root.rglob('*')), before)
        self.assertFalse(list(self.fixture.base.rglob('*.index.json')))

    def test_complete_paging_and_nested_directory_are_bounded_to_manifest(self):
        self.source(205)
        first = self.call(); self.assertEqual(len(first['entries']), 200)
        self.assertIsInstance(first['nextCursor'], str)
        last = self.call(cursor=first['nextCursor'])
        self.assertEqual(len(last['entries']), 6); self.assertIsNone(last['nextCursor'])
        names = [entry['name'] for entry in first['entries']+last['entries']]
        self.assertEqual(names, sorted(set(names)))
        self.assertEqual(len(json.dumps(first, ensure_ascii=False).encode()) < 65536, True)
        nested = self.call(path='folder')
        self.assertEqual(nested['entries'], [dict(name='child.txt', path='folder/child.txt', type='file', bytes=6)])
        with self.assertRaisesRegex(ValueError, 'Directory is not part'):
            self.call(path='unregistered')

    def test_acl_is_member_only_and_rejected_before_version_lock_creation(self):
        self.fixture.ready()
        original = self.cache._lock_file
        @contextmanager
        def guarded(name):
            self.assertFalse(name.startswith('.locks/'), 'unauthorized version lock creation')
            with original(name):
                yield
        with patch.object(self.cache, '_lock_file', guarded):
            with self.assertRaises(PermissionError):
                self.call(userId='demo-user-2')
        with self.assertRaisesRegex(ValueError, 'fields'):
            self.call(hostAdmin=True)
        with self.assertRaisesRegex(ValueError, 'fields'):
            self.call(owner='demo-user-1')

    def test_unready_and_unsafe_id_paths_reject_without_content_read(self):
        with self.assertRaisesRegex(ValueError, 'not READY'):
            self.call()
        for fields in [dict(dataset='../private'), dict(version='latest'), dict(userId='../user')]:
            with patch.object(self.node, 'dataset_source_cache', side_effect=AssertionError('invalid identity I/O')):
                with self.assertRaisesRegex(ValueError, 'identity'):
                    self.call(**fields)
        self.fixture.ready()
        for path in ['/etc', '..', 'a/../b', 'a\\b', 'a//b', '.ssh', 'x'*4097]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.call(path=path)

    def test_cursor_rebind_rejects_actor_directory_version_or_changed_registration(self):
        self.source(205); token = self.call()['nextCursor']
        for fields in [dict(path='folder'), dict(cursor=token+'='), dict(cursor='not-a-cursor')]:
            with self.assertRaises(ValueError):
                self.call(**{'cursor':token, **fields})
        self.cache.set_owners(self.fixture.admin, 'example', ['demo-user-1', 'demo-user-2'])
        with self.assertRaisesRegex(ValueError, 'cursor source changed'):
            self.call(cursor=token)
        with self.assertRaisesRegex(ValueError, 'cursor source changed'):
            self.call(userId='demo-user-2', cursor=token)

    def test_symlink_hardlink_and_changed_file_are_never_listed_as_regular_content(self):
        self.fixture.ready(); data = self.cache._paths('example', self.version)['ready']/'data'
        os.chmod(data, 0o700); original = (data/'train.txt').read_bytes(); (data/'train.txt').unlink()
        outside = self.fixture.base/'outside'; outside.write_bytes(original)
        os.chmod(outside, 0o444); (data/'train.txt').symlink_to(outside); os.chmod(data, 0o555)
        with self.assertRaises((ValueError, OSError)):
            self.call()
        os.chmod(data, 0o700); (data/'train.txt').unlink(); os.link(outside, data/'train.txt'); os.chmod(data, 0o555)
        with self.assertRaisesRegex(ValueError, 'single link'):
            self.call()
        os.chmod(data, 0o700); (data/'train.txt').unlink(); (data/'train.txt').write_bytes(original+b'changed'); os.chmod(data/'train.txt', 0o444); os.chmod(data, 0o555)
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.call()

    def test_version_lock_spans_the_complete_directory_page_and_release_is_nonpersistent(self):
        self.fixture.ready(); data = self.cache._paths('example', self.version)['ready']/'data'
        entered, release, contender = threading.Event(), threading.Event(), threading.Event()
        original = self.module._directory
        @contextmanager
        def paused(path):
            with original(path) as fd:
                if Path(path) == data:
                    entered.set(); self.assertTrue(release.wait(2))
                yield fd
        def acquire():
            with self.cache._version_locked(self.fixture.admin, 'example', self.version):
                contender.set()
        with patch.object(self.module, '_directory', paused), ThreadPoolExecutor() as pool:
            page = pool.submit(self.call); self.assertTrue(entered.wait(2))
            other = pool.submit(acquire); time.sleep(.05); self.assertFalse(contender.is_set())
            release.set(); self.assertEqual(page.result(2)['available'], True); other.result(2)
        self.assertTrue(contender.is_set())

    def test_acl_change_while_page_is_open_discards_result(self):
        self.fixture.ready(); data = self.cache._paths('example', self.version)['ready']/'data'
        original = self.module._directory
        changed = False
        @contextmanager
        def revoked(path):
            nonlocal changed
            with original(path) as fd:
                if Path(path) == data and not changed:
                    changed = True
                    self.cache.set_owners(self.fixture.admin, 'example', ['demo-user-2'])
                yield fd
        with patch.object(self.module, '_directory', revoked), self.assertRaises((ValueError, PermissionError)):
            self.call()

    def test_unrelated_real_global_writer_does_not_block_fixed_ready_page(self):
        self.fixture.ready()
        before = sorted(str(path) for path in (self.cache.root/'.leases').rglob('*'))
        with self.cache._locked(), patch.object(self.module.DatasetCache, '_locked',
                side_effect=AssertionError('directory metadata must not enter the payload writer lock')):
            value = self.call()
        self.assertTrue(value['available'])
        self.assertEqual(value['entries'][0]['name'], 'train.txt')
        self.assertEqual(sorted(str(path) for path in (self.cache.root/'.leases').rglob('*')), before)

    def test_actual_same_version_writer_lock_still_rejects_directory_page(self):
        self.fixture.ready(); self.cache.lock_timeout = .01
        name = '.locks/example.'+self.version+'.lock'
        with patch.object(self.node, 'dataset_source_cache', return_value=(self.module, self.cache)):
            with self.cache._lock_file(name), self.assertRaises(self.module.CacheBusy) as error:
                self.call()
        self.assertEqual(error.exception.lock_wait['scope'], 'VERSION')

    def retirement_fence(self):
        folder = self.cache.root/'.retirements'/'example'; self.module._mkdir(folder)
        self.module._write_json(folder/(self.version+'.json'), dict(schema=1,
            protocol='dataset-version-fence-v1', rootIdentity=list(self.cache._root_identity),
            dataset='example', version=self.version, operationId=str(uuid.uuid4()),
            actor=self.fixture.user.user_id, admin=False, snapshotSha256='a'*64,
            generation='b'*64, state='FENCED', createdAt=0, restoredRegistration=None))

    def test_fenced_ready_version_is_not_a_directory_read_capability(self):
        self.fixture.ready(); self.retirement_fence()
        with self.assertRaises(self.module.CacheError): self.call()

    def test_registration_ready_or_fence_change_while_page_is_open_discards_result(self):
        self.fixture.ready(); paths = self.cache._paths('example', self.version)
        data = paths['ready']/'data'; original = self.module._directory
        changed = False
        @contextmanager
        def replaced(path):
            nonlocal changed
            with original(path) as fd:
                if Path(path) == data and not changed:
                    changed = True
                    registration = paths['.registry'].parent/(self.version+'.json')
                    self.module._write_json(registration, self.module._read_json(registration))
                yield fd
        with patch.object(self.module, '_directory', replaced), self.assertRaises(self.module.CacheError):
            self.call()
        changed = False
        @contextmanager
        def ready_replaced(path):
            nonlocal changed
            with original(path) as fd:
                if Path(path) == data and not changed:
                    changed = True
                    os.chmod(paths['ready'], 0o700)
                    ready = paths['ready']/'READY.json'
                    self.module._write_json(ready, self.module._read_json(ready))
                    os.chmod(ready, 0o444); os.chmod(paths['ready'], 0o555)
                yield fd
        with patch.object(self.module, '_directory', ready_replaced), self.assertRaises(self.module.CacheError):
            self.call()
        changed = False
        @contextmanager
        def fenced(path):
            nonlocal changed
            with original(path) as fd:
                if Path(path) == data and not changed:
                    changed = True; self.retirement_fence()
                yield fd
        with patch.object(self.module, '_directory', fenced), self.assertRaises(self.module.CacheError):
            self.call()

    def test_separate_forced_path_has_only_fixed_metadata_reads_and_no_terminal_or_upload_fallback(self):
        with patch.object(self.node, 'process', return_value={'fixture':True}) as process:
            for operation in ('datasets.list', 'datasets.capacity', 'datasets.files.list'):
                self.assertEqual(self.node.dataset_files_rpc({'operation':operation,'args':{}}), {'fixture':True})
            self.assertEqual(process.call_count, 3)
            for operation in ('datasets.upload.begin','storage.upload.admit','datasets.prepare','datasets.unregister','host.exec','terminal.open','storage.download.open'):
                with self.subTest(operation=operation), self.assertRaisesRegex(ValueError, 'metadata RPC'):
                    self.node.dataset_files_rpc({'operation':operation,'args':{}})
            for value in ({'operation':'datasets.files.list','args':{},'force':True}, {'protocol':'terminal-stream-v1','context':{}}, [], None):
                with self.assertRaisesRegex(ValueError, 'metadata RPC'):
                    self.node.dataset_files_rpc(value)
            self.assertEqual(process.call_count, 3)


if __name__ == '__main__':
    unittest.main()
