"""Legacy snapshot admission vs GC, using disposable real node/cache trees."""
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


F = module('snapshot_storage_fixture', HERE/'snapshot-sync.test.py')
J = module('snapshot_storage_transfers', HERE.parent/'deploy/transfer-jobs.py')


class SnapshotStorageLeases(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.fixture = F.SnapshotSyncTests(); self.fixture.setUp()
        self.node = self.fixture.nodes[0]
        self.node.CONFIG['machine'] = 'gpu-source'
        self.d, self.cache = self.node.dataset_cache()
        self.admin = self.d.Principal('builtin-admin', True)
        self.owner = self.d.Principal(F.USER)
        self.version = self.cache.register_source(self.admin, 'shared', 'fixture', [F.USER])['version']
        self.cache.materialize(self.admin, 'shared', self.version)
        self.ref = {'userId': F.USER, 'dataset': 'shared', 'version': self.version}
        self.sync = module('snapshot_storage_sync', self.node.HERE/'snapshot-sync.py').SnapshotSync(self.node)

    def tearDown(self):
        try: self.fixture.tearDown()
        finally: self.fixture.doCleanups()

    def cache_role(self):
        with self.cache._locked():
            tier = self.cache._tier('shared', self.version)
            tier['role'] = 'cache'
            self.cache._write_tier('shared', self.version, tier)

    def enable_gc(self):
        self.node.CONFIG['storageTier'] = {'enabled': True, 'budgetBytes': 1}

    def read_all(self):
        self.assertEqual(self.node.process('datasets.snapshot.info', self.ref)['state'], 'READY')
        self.assertTrue(self.node.process('datasets.snapshot.manifest', {**self.ref, 'offset': 0})['eof'])
        result = self.node.process('datasets.snapshot.get', {**self.ref, 'path': 'sample.txt', 'offset': 0})
        self.assertEqual(base64.b64decode(result['data']), b'data sample')

    def test_default_and_explicit_disabled_gc_preserve_legacy_cache_reads(self):
        self.cache_role(); self.read_all()
        self.node.CONFIG['storageTier'] = {'enabled': False}; self.read_all()

    def test_enabled_gc_preserves_protected_original_and_project_code_reads(self):
        self.enable_gc(); self.read_all()
        self.fixture.test_fixed_published_code_export_excludes_env_and_unpublished_edits()

    def test_enabled_cache_rejects_every_legacy_action_even_with_admin_or_unrelated_lease(self):
        self.cache_role(); self.enable_gc()
        self.cache.acquire_lease(self.owner, 'shared', self.version, 'training-job')
        for admin in (False, True):
            for action, extra in (('info', {}), ('manifest', {'offset': 0}),
                                  ('get', {'path': 'sample.txt', 'offset': 0})):
                with self.assertRaisesRegex(ValueError, '受保护原件'):
                    self.node.process('datasets.snapshot.'+action, {**self.ref, 'hostAdmin': admin, **extra})

    def test_request_json_cannot_inject_internal_lease_or_gc_policy(self):
        self.cache_role(); self.enable_gc()
        for key, value in {'_transfer_lease': [str(uuid.uuid4()), str(uuid.uuid4())],
                           'leaseId': str(uuid.uuid4()), 'transferId': str(uuid.uuid4()),
                           'hasLease': True, 'enabled': False, 'role': 'protected'}.items():
            with self.assertRaisesRegex(ValueError, 'Invalid snapshot operation'):
                self.node.process('datasets.snapshot.info', {**self.ref, key: value})

    def test_exact_internal_transfer_lease_is_required_not_any_job_owner_or_reference(self):
        self.cache_role(); self.enable_gc()
        key = str(uuid.uuid4())
        lease = self.cache.acquire_lease(self.owner, 'shared', self.version, 'transfer:'+key)
        for proof in (True, {}, [key, lease['leaseId']], (key, str(uuid.uuid4())),
                      (str(uuid.uuid4()), lease['leaseId'])):
            with self.assertRaises(ValueError):
                self.sync.export('datasets.snapshot.info', self.ref, _transfer_lease=proof)
        with self.assertRaisesRegex(ValueError, 'lease is missing'):
            self.sync.export('datasets.snapshot.info', {**self.ref, 'userId': 'other-admin', 'hostAdmin': True},
                             _transfer_lease=(key, lease['leaseId']))
        other = self.cache.register_source(self.admin, 'other', 'fixture', [F.USER])['version']
        self.cache.materialize(self.admin, 'other', other)
        with self.assertRaisesRegex(ValueError, 'lease is missing'):
            self.sync.export('datasets.snapshot.info', {**self.ref, 'dataset': 'other'},
                             _transfer_lease=(key, lease['leaseId']))
        self.assertEqual(self.sync.export('datasets.snapshot.info', self.ref,
                         _transfer_lease=(key, lease['leaseId']))['state'], 'READY')

    def test_new_peer_prepare_and_every_read_keep_working_with_cache_gc_enabled(self):
        self.cache_role(); self.enable_gc()
        jobs = J.TransferJobs(self.node); key = str(uuid.uuid4())
        ticket = jobs.prepare({'id': key, 'userId': F.USER, 'targetMachine': 'gpu-target',
                              'reference': {'kind': 'datasets', 'dataset': 'shared', 'version': self.version}})
        for action, extra in (('info', {}), ('manifest', {'offset': 0}),
                              ('get', {'path': 'sample.txt', 'offset': 0})):
            result = jobs.read({'id': key, 'action': action, **extra}, ticket['token'])
            self.assertTrue(result)
        lease = self.cache._leases('shared', self.version)[0]
        self.cache.release_lease(self.admin, 'shared', self.version, lease['id'])
        with self.assertRaisesRegex(ValueError, 'lease is missing'):
            jobs.read({'id': key, 'action': 'get', 'path': 'sample.txt', 'offset': 0}, ticket['token'])

    def test_single_request_holds_version_lock_until_read_finished(self):
        entered, finish = threading.Event(), threading.Event()
        original = self.sync._export
        def blocked(*args):
            entered.set()
            if not finish.wait(5): raise AssertionError('fixture read was never released')
            return original(*args)
        self.cache.lock_timeout = .05
        with patch.object(self.sync, '_export', side_effect=blocked), ThreadPoolExecutor(max_workers=1) as pool:
            read = pool.submit(self.sync.export, 'datasets.snapshot.get', {**self.ref, 'path': 'sample.txt', 'offset': 0})
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaises(self.d.CacheBusy): self.cache.evict(self.admin, 'shared', self.version)
            finally: finish.set()
            self.assertEqual(base64.b64decode(read.result(5)['data']), b'data sample')
        self.cache.evict(self.admin, 'shared', self.version)

    def test_cached_chunks_do_not_reparse_large_manifest_or_create_unauthorized_locks(self):
        self.read_all()
        with patch.object(self.cache, '_record', side_effect=AssertionError('per-chunk full manifest parse')):
            self.read_all()
        unknown = 'a'*64
        with self.assertRaises(FileNotFoundError):
            self.node.process('datasets.snapshot.info', {**self.ref, 'version': unknown})
        self.assertFalse((self.cache.root/'.locks'/('shared.'+unknown+'.lock')).exists())
        with self.assertRaises(PermissionError):
            self.node.process('datasets.snapshot.info', {**self.ref, 'userId': 'unknown-user'})


if __name__ == '__main__': unittest.main()
