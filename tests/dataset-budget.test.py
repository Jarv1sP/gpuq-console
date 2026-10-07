"""Hard cache admission on disposable trees; no nodes, user data or GPU jobs."""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


F = load('budget_cache_fixture', 'dataset-cache.test.py')
U = load('budget_upload_fixture', 'dataset-upload.test.py')
N = load('budget_node_fixture', 'node-datasets.test.py')
T = load('budget_tier_fixture', 'dataset-tier.test.py')
D = F.D


class CacheAdmission(unittest.TestCase):
    setUp = F.DatasetCacheTests.setUp
    tearDown = F.DatasetCacheTests.tearDown
    register = F.DatasetCacheTests.register
    fill = F.DatasetCacheTests.fill
    publish = F.DatasetCacheTests.publish
    stage = F.DatasetCacheTests.stage
    ready = F.DatasetCacheTests.ready

    def footprint(self, dataset='sample', version=None):
        version = version or self.register(dataset)
        return self.cache._footprint(self.cache.export_manifest(F.OWNER, dataset, version)['manifest'])

    def registration(self, dataset, version):
        return (self.root / '.registry' / dataset / (version + '.json')).read_bytes()

    def test_single_oversized_prepare_rejects_before_creating_stage_or_changing_registration(self):
        version = self.register()
        before = self.registration('sample', version)
        self.cache.budget_bytes = self.footprint(version=version) - 1
        with self.assertRaisesRegex(D.CacheError, 'exceeds cache budget'):
            self.cache.prepare(F.OWNER, 'sample', version)
        self.assertFalse(self.stage(version).exists())
        self.assertEqual(self.registration('sample', version), before)
        self.assertEqual(self.cache.status(F.OWNER, 'sample', version)['state'], 'REGISTERED')

    def test_ready_copy_counts_and_existing_ready_use_needs_no_new_budget(self):
        version = self.register()
        self.publish(version)
        footprint = self.footprint(version=version)
        self.cache.budget_bytes = footprint
        second = self.register('another')
        before = self.registration('another', second)
        with self.assertRaisesRegex(D.CacheError, 'cache budget reached'):
            self.cache.plan(F.OWNER, 'another', second)
        self.assertFalse(self.cache._paths('another', second)['.staging'].exists())
        self.assertEqual(self.registration('another', second), before)
        self.cache.budget_bytes = 1
        self.assertEqual(self.cache.plan(F.OWNER, 'sample', version)['state'], 'READY')
        self.assertEqual((self.ready(version) / 'data' / 'labels.txt').read_bytes(), b'cat\ndog\n')

    def test_partial_stage_counts_entire_reservation_and_resume_never_counts_total_twice(self):
        version = self.register()
        footprint = self.footprint(version=version)
        self.cache.budget_bytes = footprint
        plan = self.cache.plan(F.OWNER, 'sample', version)
        self.cache.put_chunk(F.OWNER, 'sample', version, 'labels.txt', 0, b'cat\n', plan['token'])
        before = (self.stage(version) / 'TRANSFER.json').read_bytes()
        second = self.register('another')
        with self.assertRaisesRegex(D.CacheError, 'cache budget reached'):
            self.cache.plan(F.OWNER, 'another', second)
        self.assertEqual((self.stage(version) / 'TRANSFER.json').read_bytes(), before)
        resumed = self.cache.plan(F.OWNER, 'sample', version)
        self.assertEqual(resumed['token'], plan['token'])
        self.assertEqual(next(f for f in resumed['files'] if f['path'] == 'labels.txt')['offset'], 4)

    def test_upload_reservation_is_included_before_manifest_is_available(self):
        version = self.register()
        footprint = self.footprint(version=version)
        self.cache.budget_bytes = footprint + 99
        D._write_json(self.root / '.upload-reservations' / ('a' * 64 + '.json'), {'bytes': 100, 'inodes': 4})
        with self.assertRaisesRegex(D.CacheError, 'cache budget reached'):
            self.cache.plan(F.OWNER, 'sample', version)
        self.assertFalse(self.stage(version).exists())

    def test_parallel_preparations_cannot_both_spend_one_copy_budget(self):
        version = self.register()
        second = self.register('another')
        self.cache.budget_bytes = self.footprint(version=version)

        def prepare(dataset):
            try:
                return self.cache.plan(F.OWNER, dataset, version)['state']
            except D.CacheError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(prepare, ('sample', 'another')))
        self.assertEqual(results.count('STAGING'), 1)
        self.assertEqual(sum('cache budget reached' in result for result in results), 1)
        present = [self.cache._paths(dataset, ver)['.staging'].exists() for dataset, ver in (('sample', version), ('another', second))]
        self.assertEqual(sum(present), 1)

    def test_corrupt_reservation_and_unregistered_payload_fail_closed_without_deletion(self):
        version = self.register()
        self.cache.budget_bytes = 1024 * 1024
        reservation = self.root / '.upload-reservations' / ('a' * 64 + '.json')
        D._write_json(reservation, {'bytes': -1})
        with self.assertRaisesRegex(D.CacheError, 'corrupt upload reservation'):
            self.cache.plan(F.OWNER, 'sample', version)
        reservation.unlink()
        orphan = self.root / 'ready' / 'unknown-dataset' / ('b' * 64)
        orphan.mkdir(parents=True)
        (orphan / 'valuable').write_bytes(b'do not delete unknown data')
        with self.assertRaises((D.CacheError, FileNotFoundError)):
            self.cache.plan(F.OWNER, 'sample', version)
        self.assertEqual((orphan / 'valuable').read_bytes(), b'do not delete unknown data')

    def test_immutable_total_mismatch_refuses_new_admission_without_rewriting_stage(self):
        version = self.register()
        self.cache.plan(F.OWNER, 'sample', version)
        fence = self.stage(version) / 'TRANSFER.json'
        value = json.loads(fence.read_text())
        value['totalBytes'] += 1
        D._write_json(fence, value)
        before = fence.read_bytes()
        self.cache.budget_bytes = 1024 * 1024
        second = self.register('another')
        with self.assertRaisesRegex(D.CacheError, 'differs from immutable manifest'):
            self.cache.plan(F.OWNER, 'another', second)
        self.assertEqual(fence.read_bytes(), before)

    def test_live_physical_reserve_still_blocks_even_when_dataset_budget_has_room(self):
        version = self.register()
        self.cache.budget_bytes = 1024 * 1024
        info = SimpleNamespace(f_bavail=self.cache.reserve_bytes - 1, f_frsize=1, f_files=10000, f_favail=10000)
        with patch.object(D.os, 'fstatvfs', return_value=info), self.assertRaisesRegex(D.CacheError, 'safety reserve'):
            self.cache.plan(F.OWNER, 'sample', version)
        self.assertFalse(self.stage(version).exists())

    def test_authorization_precedes_capacity_error_and_disabled_budget_keeps_legacy_behavior(self):
        version = self.register()
        self.cache.budget_bytes = 1
        with self.assertRaises(PermissionError):
            self.cache.plan(F.OTHER, 'sample', version)
        self.cache.budget_bytes = None
        self.assertEqual(self.cache.plan(F.OWNER, 'sample', version)['state'], 'STAGING')
        self.assertIsNone(self.cache.capacity(F.OWNER)['datasetBudgetBytes'])


class UploadAdmission(unittest.TestCase):
    setUp = U.PersonalUploads.setUp
    tearDown = U.PersonalUploads.tearDown
    call = U.PersonalUploads.call
    admit = U.PersonalUploads.admit
    seal = U.PersonalUploads.seal
    fill = U.PersonalUploads.fill

    def test_large_upload_rejects_before_private_session_or_payload_and_never_deletes_existing_session(self):
        original, _, _, _ = self.admit(name='retained')
        folder = self.u.folder(self.user, original['uploadId'])
        before = (folder / 'session.json').read_bytes()
        self.cache.budget_bytes = 1
        key = str(uuid.uuid4())
        with self.assertRaisesRegex(U.D.CacheError, 'exceeds cache budget'):
            self.admit(name='too-large', key=key)
        self.assertFalse(self.u.folder(self.user, key).exists())
        self.assertEqual((folder / 'session.json').read_bytes(), before)
        self.assertEqual(self.call('status', uploadId=original['uploadId'])['state'], 'RECEIVING_MANIFEST')

    def test_sealed_upload_payload_is_counted_once_and_resumes_when_already_reserved(self):
        # Deliberately make payload dominate metadata: a doubled total would
        # exceed this budget, while the conservative metadata overhead fits.
        self.cache.budget_bytes = 2 * 1024 * 1024
        state, args, files = self.seal(files={'sample.bin': b'a' * (1024 * 1024)})
        self.assertEqual(state['state'], 'UPLOADING')
        session = self.u.load(self.user, state['uploadId'])
        with self.cache._locked():
            self.cache._budget()
        self.assertEqual(self.call('begin', **args)['uploadId'], state['uploadId'])
        self.assertEqual(session['reserveBytes'], args['totalBytes'] + args['manifestBytes'] * 4 + args['entries'] * 8192 + 65536)

    def test_partial_upload_is_not_freed_budget_for_another_client(self):
        self.cache.budget_bytes = 1500000
        state, _, files = self.seal(files={'sample.bin': b'a' * 1000000})
        upload = state['uploadId']
        self.call('chunk', uploadId=upload, path='sample.bin', offset=0,
                  data=base64.b64encode(files['sample.bin'][:900000]).decode())
        session = self.u.load(self.user, upload)
        folder = self.u.folder(self.user, upload)
        fence = self.cache._paths(session['dataset'], session['version'])['.staging'] / 'TRANSFER.json'
        before = (folder / 'session.json').read_bytes(), fence.read_bytes()
        key = str(uuid.uuid4())
        with self.assertRaisesRegex(U.D.CacheError, 'cache budget reached'):
            self.admit(files={'another.bin': b'b' * 500000}, name='another', key=key)
        self.assertFalse(self.u.folder(self.user, key).exists())
        self.assertEqual(before, ((folder / 'session.json').read_bytes(), fence.read_bytes()))


class NodeAdmission(unittest.TestCase):
    setUp = N.NodeDatasets.setUp
    tearDown = N.NodeDatasets.tearDown
    call = N.NodeDatasets.call
    start_prepare = N.NodeDatasets.start_prepare
    ready = N.NodeDatasets.ready

    def test_all_three_ssd_policies_and_hdd_authority_disabled_policy(self):
        policies = {'amax-5090': 768 * 1024**3, 'amax-4090-8': 6 * 1024**4, 'amax-4090-6': 1536 * 1024**3}
        for machine, budget in policies.items():
            with self.subTest(machine=machine):
                self.node.CONFIG.update(machine=machine, storageTier={'enabled': True, 'budgetBytes': budget}, workspaceReserveBytes=200 * 1024**3)
                _, cache = self.node.dataset_cache()
                self.assertEqual(cache.budget_bytes, budget)
                self.assertEqual(cache.reserve_bytes, 200 * 1024**3)
                collector = Mock(return_value={'evicted': []})
                with patch.object(self.node, 'storage_node', return_value=SimpleNamespace(tier=SimpleNamespace(collect=collector))):
                    self.node.dataset_cache_admission(123, _exclude=(('example', self.version),))
                collector.assert_called_once_with(self.module.Principal('builtin-admin', True), dry_run=False,
                                                 needed_bytes=123, max_versions=16, _exclude=(('example', self.version),))
        self.node.CONFIG.update(machine='amax-3090', storageTier={'enabled': False})
        with patch.object(self.node, 'storage_node', side_effect=AssertionError('never collect HDD original')):
            self.assertEqual(self.node.dataset_cache_admission(10 * 1024**4)['state'], 'DISABLED')

    def test_single_too_large_request_performs_no_gc_and_invalid_trusted_policy_refuses(self):
        self.node.CONFIG['storageTier'] = {'enabled': True, 'budgetBytes': 100}
        with patch.object(self.node, 'storage_node', side_effect=AssertionError('oversize never collect')):
            with self.assertRaisesRegex(ValueError, 'exceeds cache budget'):
                self.node.dataset_cache_admission(101)
        for value in ({'enabled': True}, {'enabled': 'true'}, {'enabled': True, 'budgetBytes': True},
                      {'enabled': True, 'budgetBytes': 100, 'allowDeleteOriginals': True}):
            with self.subTest(policy=value), self.assertRaises(ValueError):
                self.node.CONFIG['storageTier'] = value
                self.node.dataset_cache()

    def test_separate_hdd_does_not_add_workspace_ssd_reserve(self):
        self.node.CONFIG['workspaceReserveBytes'] = 10000
        original_directory = self.module._directory
        original_stat = os.fstat
        marker = -9001

        @contextmanager
        def directory(path):
            if Path(path) == self.node.ROOT:
                yield marker
            else:
                with original_directory(path) as fd:
                    yield fd

        with patch.object(self.module, '_directory', directory), patch.object(os, 'fstat', side_effect=lambda fd: SimpleNamespace(st_dev=999999) if fd == marker else original_stat(fd)):
            _, cache = self.node.dataset_cache()
        self.assertEqual(cache.reserve_bytes, 0)

    def test_completed_prepare_worker_is_idempotent_without_inventory_gc(self):
        task, _ = self.start_prepare()
        self.ready()
        with patch.object(self.node, 'dataset_cache_admission', side_effect=AssertionError('READY must not collect')):
            self.assertEqual(self.node.dataset_worker(task['operationId']), 0)

    def test_partial_prepare_worker_uses_existing_reservation_and_excludes_target(self):
        task, _ = self.start_prepare()
        self.cache.plan(self.user, 'example', self.version)
        with patch.object(self.node, 'dataset_cache_admission') as admission:
            self.assertEqual(self.node.dataset_worker(task['operationId']), 0)
        admission.assert_called_once_with(0, _exclude=(('example', self.version),))


class TierAdmission(unittest.TestCase):
    setUp = T.TierTests.setUp
    tearDown = T.TierTests.tearDown
    certify = T.TierTests.certify

    def test_internal_target_exclusion_preserves_a_recoverable_idle_ready_copy(self):
        self.certify()
        result = self.tier.collect(T.ADMIN, dry_run=False, _exclude=(('sample', self.version),))
        self.assertEqual(result['evicted'], [])
        self.assertFalse(result['after']['sufficient'])
        self.assertEqual(self.hot.status(T.OWNER, 'sample', self.version)['state'], 'READY')
        self.assertEqual(self.cold.status(T.OWNER, 'sample', self.version)['state'], 'READY')


if __name__ == '__main__':
    unittest.main()
