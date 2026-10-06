"""Metadata-only enrollment fixtures: no GPU, production data, or listener.

Large fixture manifests intentionally have no payload files: these tests prove
admission identity/lock behavior, not publication or seal/payload correctness.
"""
import contextlib
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('archive_enrollment_performance',
    Path(__file__).resolve().parents[1]/'deploy/storage-archive.py')
M = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(M)
A, D = M.A, M.D
ADMIN = D.Principal('builtin-admin', True)
USER = 'demo-user-1'


class EnrollmentFixture:
    def __init__(self, count=32):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.cache = D.DatasetCache(self.root/'cache', reserve_bytes=0)
        self.manifest = dict(schema=1, directories=[], files=[
            dict(path=f'{n:08d}.bin', size=1, sha256='a'*64) for n in range(count)])
        self.version = self.cache.register_manifest(ADMIN, 'original', self.manifest, [USER])['version']
        self.paths = self.cache._paths('original', self.version)
        self.registration = self.cache._paths('original')['.registry']/(self.version+'.json')
        self.owners = self.registration.parent/'dataset.json'
        ready = self.paths['ready']; ready.mkdir(); (ready/'data').mkdir()
        D._write_json(ready/'manifest.json', self.manifest)
        D._write_json(ready/'READY.json', dict(schema=1, version=self.version))
        (ready/'data').chmod(0o555); ready.chmod(0o555)
        store = A.AuthorityStore(self.cache, 'cold-node', self.root/'authority', principal=ADMIN)
        self.node = SimpleNamespace(ROOT=self.root/'state', CONFIG={
            'machine':'cold-node', 'storageArchive':dict(enabled=True, machine='cold-node', authority='hdd'),
            'storageAuthority':{'enabled':True}}, dataset_cache=lambda:(D, self.cache), storage_authority=lambda:store)
        self.archive = M.StorageArchive(self.node)
        self.args = dict(userId=USER, dataset='original', version=self.version)

    def check(self): return self.archive.enrollment_check(self.args)

    def memo(self):
        files = list((self.archive.root/'control'/'enrollment-checks').glob('*.json'))
        assert len(files) == 1
        return files[0]

    def close(self):
        for root, _, files in os.walk(self.root, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root)/name
                if not path.is_symlink(): path.chmod(0o600)
        self.temp.cleanup()


class EnrollmentPerformanceTests(unittest.TestCase):
    def setUp(self): self.f = EnrollmentFixture()
    def tearDown(self): self.f.close()

    def test_repeat_rpc_reuses_full_validation_but_checks_live_small_metadata(self):
        f = self.f
        with patch.object(f.cache, '_record', wraps=f.cache._record) as record, \
                patch.object(f.cache, '_ready_snapshot', wraps=f.cache._ready_snapshot) as ready:
            first = f.check()
            self.assertEqual(record.call_count, 1); self.assertEqual(ready.call_count, 1)
            # A new per-RPC adapter, not just an in-memory instance cache.
            again = M.StorageArchive(f.node).enrollment_check(f.args)
            self.assertEqual(first, again)
            self.assertEqual(record.call_count, 1); self.assertEqual(ready.call_count, 1)
        self.assertEqual(first['manifestBytes'], len(D._json_bytes(f.manifest)))
        self.assertEqual(set(first), {'protocol','machine','userId','dataset','version','state',
                                     'role','manifestSha256','manifestBytes','registration'})

    def test_large_reads_and_private_memo_fsync_never_own_global_lock(self):
        f = self.f; locked = False
        original = f.cache._locked
        @contextlib.contextmanager
        def observe():
            nonlocal locked
            with original():
                self.assertFalse(locked); locked = True
                try: yield
                finally: locked = False
        def outside(fn):
            def call(*args, **kwargs):
                self.assertFalse(locked)
                return fn(*args, **kwargs)
            return call
        with patch.object(f.cache, '_locked', observe), \
                patch.object(f.cache, '_record', outside(f.cache._record)), \
                patch.object(f.cache, '_ready_snapshot', outside(f.cache._ready_snapshot)), \
                patch.object(f.archive, '_save', outside(f.archive._save)):
            f.check(); f.check()

    def test_slow_manifest_validation_does_not_make_peer_global_lock_busy(self):
        f = self.f; entered = threading.Event(); resume = threading.Event(); outcomes = []
        original = f.cache._record
        def slow(*args, **kwargs):
            entered.set()
            if not resume.wait(3): raise AssertionError('test peer never released parser')
            return original(*args, **kwargs)
        def check():
            try: outcomes.append(f.check())
            except BaseException as error: outcomes.append(error)
        with patch.object(f.cache, '_record', slow):
            thread = threading.Thread(target=check); thread.start()
            try:
                self.assertTrue(entered.wait(2))
                with D.wait_for_locks(timeout=0.05, total=0.05):
                    with f.cache._locked():
                        self.assertEqual(f.cache._dataset(ADMIN, 'original')['owners'], [USER])
            finally:
                resume.set(); thread.join(3)
        self.assertFalse(thread.is_alive()); self.assertEqual(len(outcomes), 1)
        self.assertIsInstance(outcomes[0], dict)

    def test_cold_validation_refuses_registration_replacement_and_owner_aba(self):
        f = self.f; original = f.cache._ready_snapshot
        for mutation in ('registration', 'owners'):
            def change(*args, **kwargs):
                result = original(*args, **kwargs)
                if mutation == 'registration': D._write_json(f.registration, D._read_json(f.registration))
                else:
                    f.cache.set_owners(ADMIN, 'original', ['another-user'])
                    f.cache.set_owners(ADMIN, 'original', [USER])
                return result
            with self.subTest(mutation=mutation), patch.object(f.cache, '_ready_snapshot', change):
                with self.assertRaisesRegex(ValueError, 'metadata changed'): f.check()
        self.assertEqual(list((f.archive.root/'control'/'enrollment-checks').glob('*.json')), [])

    def test_unregistration_can_finish_during_hash_but_check_cannot_admit_removed_object(self):
        f = self.f; original = f.cache._ready_snapshot; receipts = []
        def remove_after(*args, **kwargs):
            value = original(*args, **kwargs)
            receipts.append(f.cache.unregister(ADMIN, 'original', f.version))
            return value
        with patch.object(f.cache, '_ready_snapshot', remove_after):
            with self.assertRaises(FileNotFoundError): f.check()
        self.assertEqual(len(receipts), 1)
        self.assertFalse(f.registration.exists())
        # Empty native lifecycle directories may remain after removal. The
        # existing allowMissing rule must still refuse that ambiguous state.
        with self.assertRaisesRegex(ValueError, 'protected or unknown'):
            f.archive.enrollment_check({**f.args,'allowMissing':True})

    def test_normal_remove_and_reregister_same_version_during_cold_check_is_rejected(self):
        f = self.f; original = f.cache._ready_snapshot
        def replace_after(*args, **kwargs):
            result = original(*args, **kwargs)
            f.cache.unregister(ADMIN, 'original', f.version)
            f.cache.register_manifest(ADMIN, 'original', f.manifest, [USER])
            p = f.paths['ready']; p.mkdir(); (p/'data').mkdir()
            D._write_json(p/'manifest.json',f.manifest)
            D._write_json(p/'READY.json',dict(schema=1,version=f.version))
            (p/'data').chmod(0o555); p.chmod(0o555)
            return result
        with patch.object(f.cache, '_ready_snapshot', replace_after):
            with self.assertRaisesRegex(ValueError, 'metadata changed'): f.check()
        self.assertTrue(f.registration.exists())
        self.assertEqual(list((f.archive.root/'control'/'enrollment-checks').glob('*.json')), [])

    def test_warm_check_rechecks_permissions_staging_and_role_not_memoized(self):
        f = self.f; f.check()
        f.cache.set_owners(ADMIN, 'original', ['another-user'])
        with self.assertRaises(PermissionError): f.check()
        f.cache.set_owners(ADMIN, 'original', [USER]); f.check()
        f.paths['.staging'].mkdir()
        with self.assertRaisesRegex(ValueError, 'staging'): f.check()
        f.paths['.staging'].rmdir()
        tier = f.cache._tier('original', f.version); tier['role'] = 'cache'
        f.cache._write_tier('original', f.version, tier)
        with self.assertRaisesRegex(ValueError, 'protected original'): f.check()

    def test_warm_hot_pins_are_checked_even_when_summary_matches(self):
        # Build the trusted hot adapter without any TLS request.
        f = self.f; peer = dict(address='127.0.0.1',port=18443,certificateSha256='0'*64)
        remote = SimpleNamespace(machine='cold-node',target_machine='hot-node',peer=peer)
        node = SimpleNamespace(ROOT=f.root/'hot-state', CONFIG={
            'machine':'hot-node', 'storageArchive':dict(enabled=True,machine='cold-node',authority='hdd'),
            'storageAuthorities':{'hdd':{'machine':'cold-node'}}, 'transferPeers':{'cold-node':peer}},
            dataset_cache=lambda:(D,f.cache), storage_node=lambda:SimpleNamespace(
                tier=SimpleNamespace(cache=f.cache,authorities={'hdd':remote})))
        hot = M.StorageArchive(node); hot.enrollment_check(f.args)
        tier = f.cache._tier('original', f.version); tier['pins']['manual'] = dict(owner=USER,createdAt=1)
        f.cache._write_tier('original', f.version, tier)
        with self.assertRaisesRegex(ValueError, 'Pinned'): hot.enrollment_check(f.args)

    def test_warm_proof_never_masks_corruption_chmod_replacement_or_removed_ready(self):
        f = self.f; first = f.check()
        D._write_json(f.registration, D._read_json(f.registration))
        with patch.object(f.cache, '_record', wraps=f.cache._record) as record:
            second = f.check(); self.assertEqual(record.call_count, 1)
        self.assertNotEqual(first['registration'], second['registration'])
        # Same-size corruption with original mtime is still fenced by ctime.
        p = f.paths['ready']/'manifest.json'; info = p.stat(); raw = p.read_bytes()
        p.write_bytes(raw.replace(b'aaaaaaaa',b'bbbbbbbb',1)); os.utime(p,ns=(info.st_atime_ns,info.st_mtime_ns))
        with self.assertRaisesRegex(D.CacheError, 'corrupt'): f.check()
        p.write_bytes(raw); f.check()
        f.paths['ready'].chmod(0o700)
        with self.assertRaisesRegex(D.CacheError, 'read-only'): f.check()
        f.paths['ready'].chmod(0o555); f.check()
        f.cache.evict(ADMIN,'original',f.version)
        with self.assertRaisesRegex(ValueError, 'not READY'): f.check()

    def test_warm_hit_revalidates_after_private_read_even_if_summary_was_valid(self):
        f = self.f; f.check(); original = f.archive._load
        def revoke(path):
            value = original(path); f.cache.set_owners(ADMIN,'original',['another-user']); return value
        with patch.object(f.archive, '_load', revoke):
            with self.assertRaises(PermissionError): f.check()

    def test_same_bytes_ready_replacement_invalidates_warm_proof_and_race_is_rejected(self):
        f = self.f; first = f.check()
        def replace():
            p = f.paths['ready']; p.chmod(0o700)
            D._write_json(p/'manifest.json',f.manifest); p.chmod(0o555)
        replace()
        with patch.object(f.cache, '_ready_snapshot', wraps=f.cache._ready_snapshot) as ready:
            self.assertEqual(f.check(), first); self.assertEqual(ready.call_count,1)
        original = f.archive._load
        def replace_during_hit(path):
            value = original(path); replace(); return value
        with patch.object(f.archive, '_load', replace_during_hit):
            with self.assertRaisesRegex(ValueError, 'metadata changed'): f.check()

    def test_private_summary_unsafe_file_or_unknown_disk_error_fails_closed(self):
        f = self.f; f.check(); memo = f.memo(); memo.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'Unsafe private'): f.check()
        memo.chmod(0o600)
        with patch.object(f.archive, '_load', side_effect=OSError('disk unavailable')):
            with self.assertRaisesRegex(OSError, 'disk unavailable'): f.check()
        outside = f.root/'outside'; outside.write_bytes(memo.read_bytes()); memo.unlink(); memo.symlink_to(outside)
        with self.assertRaises(OSError): f.check()

    def test_wrong_or_outdated_summary_forces_full_validation_and_is_bounded(self):
        f = self.f; f.check(); memo = f.memo()
        self.assertRegex(memo.name, r'^[a-f0-9]{2}\.json$')
        for change in ({'stamp':'0'*64}, {'manifestBytes':True}, {'schema':2}):
            value = f.archive._load(memo); value.update(change); f.archive._save(memo,value)
            with patch.object(f.cache, '_record', wraps=f.cache._record) as record:
                f.check(); self.assertEqual(record.call_count, 1)
        self.assertLess(memo.stat().st_size, 1024)

    def test_broken_summary_cannot_mask_broken_ready_metadata(self):
        f = self.f; f.check(); memo = f.memo()
        memo.write_text('{not JSON')
        with self.assertRaises(ValueError): f.check()
        f.archive._save(memo, {'schema':999,'stamp':'bad','manifestBytes':1})
        p = f.paths['ready']; p.chmod(0o700)
        D._write_json(p/'READY.json',dict(schema=1,version='b'*64)); p.chmod(0o555)
        with self.assertRaisesRegex(D.CacheError, 'corrupt'): f.check()

    def test_memo_does_not_acquire_release_or_bypass_dataset_leases(self):
        f = self.f; f.check()
        lease = f.cache.acquire_lease(D.Principal(USER), 'original', f.version, 'active-fixture')
        f.check(); self.assertEqual(len(f.cache._leases('original',f.version)),1)
        with self.assertRaisesRegex(D.CacheError, 'lease'): f.cache.unregister(ADMIN,'original',f.version)
        f.cache.release_lease(ADMIN,'original',f.version,lease['leaseId'])
        f.cache.unregister(ADMIN,'original',f.version)
        with self.assertRaises(FileNotFoundError): f.check()


if __name__ == '__main__': unittest.main()
