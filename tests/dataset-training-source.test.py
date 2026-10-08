"""Fixed HDD training lifecycle; disposable roots only, no devices or daemons."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent / 'deploy'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


F = load('training_source_fixture', HERE / 'node-datasets.test.py')
L = load('training_source_leases', DEPLOY / 'storage-leases.py')
A = load('training_source_authority', DEPLOY / 'storage-authority.py')


class TrainingSourceTests(unittest.TestCase):
    def setUp(self):
        self.f = F.NodeDatasets()
        self.f.setUp()
        self.n, self.d, self.hot = self.f.node, self.f.module, self.f.cache
        for name in ('dataset-training-source.py', 'storage-leases.py'):
            shutil.copy2(DEPLOY / name, self.f.base / name)
        self.cold = self.d.DatasetCache(self.f.base / 'hdd-datasets', sources={'approved': self.f.source},
                                       reserve_bytes=0, mount_point=str(self.f.base))
        # Disposable mounts share an actual tempfile device. Production's
        # Warehouse factory verifies distinct media; all other guards stay real.
        self.n.CONFIG.update(machine='test-node', storageAuthority={'enabled': True},
            storageArchive={'enabled': True, 'machine': 'test-node', 'authority': 'hdd'},
            storageWarehouse={'enabled': True, 'root': str(self.cold.root),
                              'mountPoint': str(self.f.base), 'reserveBytes': 0})
        A.D = self.d
        self.store = A.AuthorityStore(self.cold, 'test-node', self.n.ROOT / 'authority', principal=self.f.admin)
        self.n.dataset_source_cache = lambda *args: (self.d, self.cold)
        self.n.storage_authority = lambda: self.store
        self.n.storage_warehouse = lambda: None
        self.cold.register_source(self.f.admin, 'example', 'approved', ['demo-user-1'])
        self.cold.materialize(self.f.user, 'example', self.f.version)
        self.job = {**self.f.job, 'datasetReadMode': 'warehouse'}
        self.sources = self.n.dataset_training_sources()
        self.leases = self.n.storage_leases()
        self.ref = self.job['datasets'][0]

    def tearDown(self):
        try:
            self.f.tearDown()
        finally:
            self.f.doCleanups()

    def status(self, mode='warehouse', **extra):
        return self.sources.status(dict(userId=self.job['userId'], hostAdmin=False,
                                        **self.ref, datasetReadMode=mode, **extra))

    def journal(self):
        return self.leases.root / 'training' / self.job['id'] / 'record.json'

    def cold_leases(self):
        return self.cold._leases(**self.ref)

    def test_verified_local_ready_status_has_exact_manifest_footprint_and_no_path(self):
        value = self.status()
        self.assertEqual(value['protocol'], 'dataset-training-source-v1')
        self.assertEqual(value['datasetWarehouseRead'], 1)
        self.assertTrue(value['warehouseReady'])
        self.assertEqual(value['reference'], self.ref)
        self.assertEqual(value['remainingBytes'], 0)
        self.assertEqual(value['bytes'], (self.f.source / 'train.txt').stat().st_size)
        self.assertEqual(value['files'], 1)
        self.assertEqual(value['directories'], 0)
        self.assertGreater(value['footprintBytes'], value['bytes'])
        manifest = self.cold._record(self.f.user, **self.ref)['manifest']
        self.assertEqual(value['manifestBytes'], len(self.d._json_bytes(manifest)))
        self.assertNotIn('path', value)
        self.assertNotIn('root', value)

    def test_ordinary_cache_status_does_not_require_warehouse_authority(self):
        self.n.CONFIG.pop('storageAuthority')
        value = self.status('cache')
        self.assertEqual(value['state'], 'REGISTERED')
        self.assertFalse(value['warehouseReady'])
        self.assertTrue(value['canPrepare'])
        self.assertEqual(value['remainingBytes'], value['bytes'])
        self.assertEqual(value['datasetWarehouseRead'], 0)

    def test_warehouse_unavailable_never_falls_back_to_identical_ready_ssd(self):
        self.f.ready()
        self.n.CONFIG['storageArchive']['machine'] = 'different-node'
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            self.leases.prepare(self.job)
        self.assertEqual(self.hot._leases(**self.ref), [])
        self.assertEqual(self.cold_leases(), [])

    def test_default_binding_and_lease_journal_are_unchanged(self):
        self.f.ready()
        self.leases.prepare(self.f.job)
        record = self.d._read_json(self.journal())
        self.assertEqual(record['binding'], {'id': self.job['id'], 'userId': self.job['userId'], 'references': [self.ref]})
        self.assertNotIn('sourceSnapshots', record)
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.leases.prepare(self.job)

    def test_cold_hold_handoff_and_fd_mount_do_not_create_ssd_copy(self):
        first = self.leases.prepare(self.job)
        self.assertEqual(self.leases.prepare(self.job), first)
        leases = self.leases.handoff(self.job)
        self.assertEqual(len(self.cold_leases()), 1)
        self.assertEqual(self.hot._leases(**self.ref), [])
        self.assertFalse(self.hot._paths(**self.ref)['ready'].exists())
        record = self.d._read_json(self.journal())
        self.assertEqual(record['binding']['datasetReadMode'], 'warehouse')
        self.assertEqual(record['binding']['source']['rootIdentity'], list(self.cold._root_identity))
        self.assertEqual(len(record['sourceSnapshots']), 1)
        opened = self.n._dataset_open_mounts(self.job, leases)
        try:
            self.assertEqual(opened[0][1], '/data2/example')
            expected = (self.cold._paths(**self.ref)['ready'] / 'data').stat()
            actual = os.fstat(opened[0][0])
            self.assertEqual((actual.st_dev, actual.st_ino), (expected.st_dev, expected.st_ino))
        finally:
            for fd, _ in opened:
                os.close(fd)

    def test_personal_admin_id_cannot_bypass_membership_or_supply_host_path(self):
        for update in ({'userId': 'builtin-admin'}, {'hostAdmin': True}, {'path': '/etc'}):
            args = dict(userId=self.job['userId'], hostAdmin=False, **self.ref, datasetReadMode='warehouse')
            args.update(update)
            with self.assertRaises((ValueError, PermissionError)):
                self.sources.status(args)
        self.assertEqual(self.cold_leases(), [])

    def test_unready_or_cache_role_cannot_be_used_as_original(self):
        ready = self.cold._paths(**self.ref)['ready']
        hidden = ready.with_name('unpublished-fixture')
        ready.rename(hidden)
        self.assertFalse(self.status()['warehouseReady'])
        with self.assertRaisesRegex(ValueError, 'not READY'):
            self.leases.prepare(self.job)
        self.assertEqual(self.cold_leases(), [])
        hidden.rename(ready)
        with self.cold._locked():
            tier = self.cold._tier(**self.ref)
            tier['role'] = 'cache'
            self.cold._write_tier(self.ref['dataset'], self.ref['version'], tier)
        with self.assertRaisesRegex(ValueError, 'protected original'):
            self.status()

    def test_permanent_authority_retirement_refuses_before_any_lease(self):
        self.d._write_json(self.store.reference_fence(**self.ref), {'retired': True})
        with self.assertRaisesRegex(ValueError, 'permanently retired'):
            self.leases.prepare(self.job)
        self.assertEqual(self.cold_leases(), [])

    def test_changed_registration_generation_refuses_handoff_and_retry(self):
        self.leases.prepare(self.job)
        leases = self.leases.handoff(self.job)
        registration = self.cold._paths(self.ref['dataset'])['.registry'] / (self.ref['version'] + '.json')
        data = registration.read_bytes()
        registration.unlink()
        registration.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.leases.handoff(self.job)
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.n._dataset_open_mounts(self.job, leases)
        self.assertEqual(len(self.cold_leases()), 1)

    def test_revoked_member_cannot_handoff_but_confirmed_cleanup_releases_cold(self):
        self.leases.prepare(self.job)
        self.cold.set_owners(self.f.admin, 'example', ['demo-user-2'])
        with self.assertRaises(PermissionError):
            self.leases.handoff(self.job)
        self.assertEqual(len(self.cold_leases()), 1)
        self.assertTrue(self.leases.cancel_prepare(self.job)['released'])
        self.assertEqual(self.cold_leases(), [])
        self.assertTrue(self.leases.cancel_prepare(self.job)['released'])

    def test_lost_journal_append_after_real_acquire_recovers_exact_cold_namespace(self):
        save = self.leases._save
        def lost(path, record):
            if record['leases']:
                raise OSError('lost append')
            save(path, record)
        with patch.object(self.leases, '_save', side_effect=lost):
            with self.assertRaisesRegex(OSError, 'lost append'):
                self.leases.prepare(self.job)
        record = self.d._read_json(self.journal())
        self.assertEqual(record['leases'], [])
        self.assertEqual(len(record['sourceSnapshots']), 1)
        self.assertEqual(len(self.cold_leases()), 1)
        self.assertTrue(self.leases.cancel_prepare(self.job)['released'])
        self.assertEqual(self.cold_leases(), [])
        self.assertEqual(self.hot._leases(**self.ref), [])

    def test_changed_authority_retains_hold_instead_of_cleaning_different_root(self):
        self.leases.prepare(self.job)
        self.n.CONFIG['storageArchive']['authority'] = 'other-hdd'
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.leases.cancel_prepare(self.job)
        self.assertEqual(len(self.cold_leases()), 1)

    def test_explicit_retry_uses_same_source_generation_and_distinct_hold(self):
        self.leases.prepare(self.job)
        self.leases.handoff(self.job)
        self.leases.finalize_training(self.job)
        proof = dict(nativeJobId='J0123456789ab', retry={'id': 1, 'createdAt': 1},
                     attemptId='A' + '1'*32, priorAttemptIds=[],
                     specSha256=hashlib.sha256(json.dumps(self.job, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
        leases = self.leases.runner_handoff(self.job, proof)
        self.assertEqual(len(leases), 1)
        self.assertEqual(self.cold_leases()[0]['jobId'], 'retry:' + self.job['id'] + ':1')
        self.assertEqual(self.hot._leases(**self.ref), [])
        opened = self.n._dataset_open_mounts(self.job, leases)
        for fd, _ in opened:
            os.close(fd)
        changed = {**self.job, 'datasetReadMode': 'cache'}
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.leases.runner_handoff(changed, proof)

    def test_unknown_consumer_retains_cold_hold_and_known_stopped_cleanup_is_idempotent(self):
        self.leases.prepare(self.job)
        self.leases.handoff(self.job)
        unknown = {'job': {'state': 'RUNNING'}, 'attempts': []}
        self.assertFalse(self.n.release_datasets(self.job, unknown))
        self.assertEqual(len(self.cold_leases()), 1)
        self.assertTrue(self.n.release_datasets(self.job, never_dispatched=True))
        self.assertEqual(self.cold_leases(), [])
        self.assertTrue(self.n.release_datasets(self.job, never_dispatched=True))

    def test_missing_source_journal_cannot_claim_cleanup_from_legacy_receipt(self):
        self.leases.prepare(self.job)
        self.leases.handoff(self.job)
        self.journal().unlink()
        with self.assertRaisesRegex(ValueError, 'durable source journal'):
            self.n.release_datasets(self.job, never_dispatched=True)
        self.assertEqual(len(self.cold_leases()), 1)

    def test_warehouse_cancel_without_source_journal_does_not_claim_released(self):
        with self.assertRaisesRegex(ValueError, 'durable source journal'):
            self.leases.cancel_prepare(self.job)
        self.assertFalse(self.journal().exists())
        self.leases.prepare(self.job)
        self.journal().unlink()
        with self.assertRaisesRegex(ValueError, 'source journal is missing'):
            self.leases.cancel_prepare(self.job)
        self.assertEqual(len(self.cold_leases()), 1)

    def test_legacy_cache_cancel_before_preparation_preserves_empty_permanent_fence(self):
        self.assertTrue(self.leases.cancel_prepare(self.f.job)['released'])
        record = self.d._read_json(self.journal())
        self.assertEqual(record['state'], 'CANCELED')
        self.assertNotIn('source', record['binding'])
        self.assertEqual(record['leases'], [])

    def test_post_yield_permission_rejection_closes_already_duplicated_fd(self):
        self.leases.prepare(self.job)
        leases = self.leases.handoff(self.job)
        original, duplicated = self.sources.guard, []
        @contextmanager
        def rejected(*args, **kwargs):
            with original(*args, **kwargs) as value:
                yield value
                raise PermissionError('revoked during FD acquisition')
        duplicate = os.dup
        def dup(fd):
            value = duplicate(fd)
            duplicated.append(value)
            return value
        with patch.object(self.sources, 'guard', side_effect=rejected), patch.object(os, 'dup', side_effect=dup):
            with self.assertRaises(PermissionError):
                self.n._dataset_open_mounts(self.job, leases)
        self.assertTrue(duplicated)
        for fd in duplicated:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_private_metadata_upload_keys_do_not_gain_training_rpc(self):
        for operation in ('datasets.training.status', 'storage.training.plan'):
            with self.assertRaises(ValueError):
                self.n.require_upload_ingress_operation(operation)
            with self.assertRaises(ValueError):
                self.n.dataset_files_rpc({'operation': operation, 'args': {}})

    def test_invalid_read_mode_and_empty_direct_selection_are_rejected(self):
        for mode in ('disk', None, True):
            with self.assertRaises(ValueError):
                self.n.validate_job({**self.f.job, 'datasetReadMode': mode})
        with self.assertRaises(ValueError):
            self.n.validate_job({**self.job, 'datasets': []})

    def test_training_cache_admission_refuses_pressure_without_automatic_collection(self):
        self.f.ready()
        manifest = self.hot._record(self.f.user, **self.ref)['manifest']
        footprint = self.hot._footprint(manifest)
        self.n.CONFIG['storageTier'] = {'enabled': True, 'budgetBytes': footprint + 100}
        with patch.object(self.n, 'storage_node', side_effect=AssertionError('implicit collection forbidden')):
            with self.assertRaisesRegex(ValueError, 'budget'):
                self.n.dataset_cache_admission(footprint)
        self.assertEqual(self.hot.status(self.f.user, **self.ref)['state'], 'READY')

    def test_cache_resume_counts_existing_stage_payload_reservation_only_once(self):
        self.n.CONFIG['storageTier'] = {'enabled': True, 'budgetBytes': 10**6}
        _, cache = self.n.dataset_cache()
        record = cache._record(self.f.user, **self.ref)
        cache.prepare_transfer(self.f.admin, **self.ref)
        footprint = cache._footprint(record['manifest'])
        total = sum(entry['size'] for entry in record['manifest']['files'])
        reserved = cache._reserved()
        with patch.object(self.d.DatasetCache, '_free', autospec=True, return_value=None) as free:
            result = self.n.dataset_cache_admission(footprint, _exclude=((self.ref['dataset'], self.ref['version']),))
        self.assertEqual(result['state'], 'CHECKED')
        self.assertEqual(free.call_args.args[1], reserved + footprint - total)


if __name__ == '__main__':
    unittest.main()
