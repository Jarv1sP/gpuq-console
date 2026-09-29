"""Dataset copy scaling, durable accounting and a real optional 450k manifest run.

GPUQ_DATASET_LARGE=1 python3 tests/dataset-performance.test.py runs the large
register/list/status check without creating 450,000 physical data files.
"""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import resource
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'deploy' / 'dataset-cache.py'
SPEC = importlib.util.spec_from_file_location('dataset_performance_test', SOURCE)
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
ADMIN = D.Principal('test-admin', True)
OWNER = D.Principal('demo-user-1')
OTHER = D.Principal('demo-user-2')


class DatasetPerformance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'source'
        self.source.mkdir()
        self.cache = D.DatasetCache(self.base / 'cache', sources={'approved': self.source}, reserve_bytes=1024)

    def tearDown(self):
        for folder, _dirs, files in os.walk(self.base):
            os.chmod(folder, 0o700)
            for name in files:
                path = Path(folder) / name
                if not path.is_symlink():
                    os.chmod(path, 0o600)
        self.temp.cleanup()

    def register(self, files=20, size=80):
        for number in range(files):
            (self.source / f'{number:04d}.bin').write_bytes(bytes([number % 256]) * size)
        return self.cache.register_source(ADMIN, 'sample', 'approved', [OWNER.user_id])['version']

    def stage(self, version):
        return self.cache.root / '.staging' / 'sample' / version

    def ready(self, version):
        return self.cache.root / 'ready' / 'sample' / version

    def test_materialize_parses_registry_once_and_batches_accounting_not_every_chunk(self):
        version = self.register()
        reads, writes, indices = [], [], []
        read, write = D._read_json, D._write_json
        stage_files = self.cache._stage_files
        def count_read(path):
            reads.append(Path(path))
            return read(path)
        def count_write(path, *args, **kwargs):
            writes.append(Path(path))
            return write(path, *args, **kwargs)
        def count_stage(*args, **kwargs):
            indices.append(kwargs.get('index'))
            return stage_files(*args, **kwargs)
        with patch.object(D, 'CHUNK_BYTES', 8), patch.object(D, 'TRANSFER_BATCH_BYTES', 64), \
                patch.object(D, 'TRANSFER_BATCH_FILES', 256), patch.object(D, 'TRANSFER_BATCH_SECONDS', 1e6), \
                patch.object(D, '_read_json', side_effect=count_read), patch.object(D, '_write_json', side_effect=count_write), \
                patch.object(self.cache, '_stage_files', side_effect=count_stage), \
                patch.object(self.cache, '_record', wraps=self.cache._record) as record, \
                patch.object(self.cache, '_put_chunk_data', wraps=self.cache._put_chunk_data) as chunks, \
                patch.object(self.cache, 'put_chunk', side_effect=AssertionError('no public per-chunk reparsing')):
            result = self.cache.materialize(OWNER, 'sample', version)
        self.assertEqual(result['state'], 'READY')
        self.assertEqual(record.call_count, 1)
        self.assertEqual(sum(path.name == version + '.json' for path in reads), 1)
        self.assertEqual(chunks.call_count, 200)
        fence_writes = sum(path.name == 'TRANSFER.json' for path in writes)
        self.assertEqual(fence_writes, 2 + math.ceil(1600 / 64))
        self.assertLess(fence_writes, chunks.call_count // 4)
        self.assertEqual(len(indices), 2)
        self.assertIsNotNone(indices[0])
        self.assertIs(indices[0], indices[1])
        for number in range(20):
            self.assertEqual((self.ready(version) / 'data' / f'{number:04d}.bin').read_bytes(), bytes([number]) * 80)

    def test_public_put_chunk_still_revalidates_authority_token_paths_and_offset(self):
        version = self.register(files=1, size=16)
        plan = self.cache.plan(OWNER, 'sample', version)
        token = plan['token']
        with patch.object(self.cache, '_record', wraps=self.cache._record) as record:
            self.cache.put_chunk(OWNER, 'sample', version, '0000.bin', 0, bytes(8), token)
            self.assertEqual(record.call_count, 1)
        before = (self.stage(version) / 'data' / '0000.bin').read_bytes()
        for actor, path, offset, data, given in [
            (OTHER, '0000.bin', 8, bytes(8), token),
            (OWNER, '0000.bin', 8, bytes(8), 'bad'),
            (OWNER, '../escaped', 0, b'x', token),
            (OWNER, 'missing', 0, b'x', token),
            (OWNER, '0000.bin', 9, b'x', token),
            (OWNER, '0000.bin', 8, bytes(9), token),
            (OWNER, '0000.bin', 0, b'bad', token),
        ]:
            with self.subTest(actor=actor, path=path, offset=offset), self.assertRaises((D.CacheError, PermissionError)):
                self.cache.put_chunk(actor, 'sample', version, path, offset, data, given)
            self.assertEqual((self.stage(version) / 'data' / '0000.bin').read_bytes(), before)
        self.cache.set_owners(ADMIN, 'sample', [OTHER.user_id])
        with self.assertRaises(PermissionError):
            self.cache.put_chunk(OWNER, 'sample', version, '0000.bin', 8, bytes(8), token)

    def test_crash_after_fsynced_unaccounted_chunk_recovers_exact_prefix(self):
        version = self.register(files=1, size=80)
        original = self.cache._put_chunk_data
        def crash(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError('simulated worker death after data fsync')
        with patch.object(D, 'CHUNK_BYTES', 8), patch.object(self.cache, '_put_chunk_data', side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, 'worker death'):
                self.cache.materialize(OWNER, 'sample', version)
        fence = D._read_json(self.stage(version) / 'TRANSFER.json')
        self.assertEqual(fence['remainingBytes'], 80)
        self.assertEqual((self.stage(version) / 'data' / '0000.bin').stat().st_size, 8)
        plan = self.cache.plan(OWNER, 'sample', version)
        self.assertEqual(plan['remainingBytes'], 72)
        self.assertEqual(plan['files'][0]['offset'], 8)
        self.assertEqual(plan['files'][0]['prefixSha256'], hashlib.sha256(bytes(8)).hexdigest())
        self.assertEqual(self.cache.materialize(OWNER, 'sample', version)['state'], 'READY')

    def test_batch_authorization_revocation_prevents_publication(self):
        version = self.register(files=2, size=8)
        original = self.cache._put_chunk_data
        def revoke(*args, **kwargs):
            result = original(*args, **kwargs)
            self.cache.set_owners(ADMIN, 'sample', [OTHER.user_id])
            return result
        with patch.object(D, 'TRANSFER_BATCH_BYTES', 1), patch.object(self.cache, '_put_chunk_data', side_effect=revoke):
            with self.assertRaises(PermissionError):
                self.cache.materialize(OWNER, 'sample', version)
        self.assertFalse(self.ready(version).exists())
        self.assertFalse((self.stage(version) / 'data' / '0001.bin').exists())
        self.assertEqual(D._read_json(self.stage(version) / 'TRANSFER.json')['remainingBytes'], 16)

    def test_registration_replacement_invalidates_in_memory_manifest(self):
        version = self.register(files=2, size=8)
        original = self.cache._put_chunk_data
        def replace_registration(*args, **kwargs):
            result = original(*args, **kwargs)
            self.cache.attach_source(ADMIN, 'sample', version, 'approved')
            return result
        with patch.object(D, 'TRANSFER_BATCH_BYTES', 1), patch.object(self.cache, '_put_chunk_data', side_effect=replace_registration):
            with self.assertRaisesRegex(D.CacheError, 'registration changed'):
                self.cache.materialize(OWNER, 'sample', version)
        self.assertFalse(self.ready(version).exists())

    def test_source_mutation_during_copy_is_still_rejected(self):
        version = self.register(files=1, size=80)
        original = self.cache._put_chunk_data
        mutated = False
        def mutate(*args, **kwargs):
            nonlocal mutated
            result = original(*args, **kwargs)
            if not mutated:
                (self.source / '0000.bin').write_bytes(b'x' * 80)
                mutated = True
            return result
        with patch.object(D, 'CHUNK_BYTES', 8), patch.object(self.cache, '_put_chunk_data', side_effect=mutate):
            with self.assertRaisesRegex(D.CacheError, 'source changed'):
                self.cache.materialize(OWNER, 'sample', version)
        self.assertFalse(self.ready(version).exists())

    def test_space_pressure_is_checked_before_each_chunk_not_only_at_batch_end(self):
        version = self.register(files=1, size=80)
        original = self.cache._put_chunk_data
        real_space = D.os.fstatvfs
        copied = False
        def write(*args, **kwargs):
            nonlocal copied
            result = original(*args, **kwargs)
            copied = True
            return result
        def space(fd):
            return SimpleNamespace(f_bavail=0, f_frsize=4096) if copied else real_space(fd)
        with patch.object(D, 'CHUNK_BYTES', 8), patch.object(D, 'TRANSFER_BATCH_BYTES', 1024), \
                patch.object(D.os, 'fstatvfs', side_effect=space), patch.object(self.cache, '_put_chunk_data', side_effect=write):
            with self.assertRaisesRegex(D.CacheError, 'free space'):
                self.cache.materialize(OWNER, 'sample', version)
        self.assertEqual((self.stage(version) / 'data' / '0000.bin').stat().st_size, 8)
        self.assertEqual(D._read_json(self.stage(version) / 'TRANSFER.json')['remainingBytes'], 80)
        self.assertFalse(self.ready(version).exists())

    def test_copy_holds_version_lock_but_status_and_other_versions_remain_usable(self):
        version = self.register(files=2, size=8)
        entered, release = threading.Event(), threading.Event()
        errors = []
        original = self.cache._put_chunk_data
        def blocked(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise AssertionError('test worker timed out')
            return original(*args, **kwargs)
        def materialize():
            try:
                self.cache.materialize(OWNER, 'sample', version)
            except BaseException as exc:
                errors.append(exc)
        other = D.DatasetCache(self.cache.root, sources={'approved': self.source}, reserve_bytes=1024, lock_timeout=0.02)
        with patch.object(self.cache, '_put_chunk_data', side_effect=blocked):
            worker = threading.Thread(target=materialize)
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(other.status(OWNER, 'sample', version)['state'], 'STAGING')
                token = D._read_json(self.stage(version) / 'TRANSFER.json')['token']
                for action in [lambda: other.put_chunk(OWNER, 'sample', version, '0000.bin', 0, bytes(8), token),
                               lambda: other.evict(ADMIN, 'sample', version)]:
                    with self.assertRaises(D.CacheBusy):
                        action()
                empty = {'schema': 1, 'directories': [], 'files': []}
                alternative = other.register_manifest(ADMIN, 'other', empty, [OWNER.user_id])['version']
                self.assertEqual(other.plan(OWNER, 'other', alternative)['state'], 'STAGING')
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_entry_limit_is_500000_and_one_more_is_rejected_without_normalizing(self):
        self.assertEqual(D.MAX_ENTRIES, 500000)
        with self.assertRaisesRegex(D.CacheError, 'entries'):
            D._manifest({'schema': 1, 'directories': [], 'files': [None] * 500001})

    @unittest.skipUnless(os.environ.get('GPUQ_DATASET_LARGE') == '1', 'set GPUQ_DATASET_LARGE=1 for real 450k-entry run')
    def test_real_450000_entry_register_list_status(self):
        count = 450000
        empty_hash = hashlib.sha256(b'').hexdigest()
        manifest = {'schema': 1, 'directories': [], 'files': [
            {'path': f'sample-{index:06d}.bin', 'size': 0, 'sha256': empty_hash}
            for index in range(count)
        ]}
        times = {}
        started = time.perf_counter()
        result = self.cache.register_manifest(ADMIN, 'large', manifest, [OWNER.user_id])
        times['register_seconds'] = round(time.perf_counter() - started, 3)
        version = result['version']
        manifest_bytes = (self.cache.root / '.registry' / 'large' / (version + '.json')).stat().st_size
        del manifest
        started = time.perf_counter()
        listing = self.cache.list_datasets(OWNER)
        times['list_seconds'] = round(time.perf_counter() - started, 3)
        started = time.perf_counter()
        status = self.cache.status(OWNER, 'large', version)
        times['status_seconds'] = round(time.perf_counter() - started, 3)
        self.assertEqual(result['files'], count)
        self.assertEqual(listing['datasets'][0]['versions'][0]['files'], count)
        self.assertEqual(status['state'], 'REGISTERED')
        self.assertEqual(status['remainingBytes'], 0)
        self.assertLess(manifest_bytes, D.MAX_JSON_BYTES)
        self.cache.attach_source(ADMIN, 'large', version, 'approved')
        (self.source / 'sample-000000.bin').write_bytes(b'')
        class PlanningProbeFinished(Exception):
            pass
        started = time.perf_counter()
        with patch.object(self.cache, '_put_chunk_data', side_effect=PlanningProbeFinished), \
                patch.object(self.cache, '_record', wraps=self.cache._record) as record:
            with self.assertRaises(PlanningProbeFinished):
                self.cache.materialize(OWNER, 'large', version)
        times['materialize_planning_seconds'] = round(time.perf_counter() - started, 3)
        self.assertEqual(record.call_count, 1)
        self.assertFalse((self.cache.root / 'ready' / 'large' / version).exists())
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        peak_bytes = peak if sys.platform == 'darwin' else peak * 1024
        print('\nLARGE_MANIFEST_RESULT=' + json.dumps({
            'entries': count, 'registry_bytes': manifest_bytes,
            'peak_rss_mib': round(peak_bytes / 1024**2, 1), **times,
            'physical_data_files_created': 1, 'materialize_registry_parses': record.call_count,
        }, sort_keys=True), flush=True)


if __name__ == '__main__':
    unittest.main()
