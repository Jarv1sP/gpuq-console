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
E = load('budget_empty_fixture', 'dataset-empty-registration.test.py')
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
        with self.assertRaisesRegex(D.CacheError, 'exceeds cache budget'):
            self.cache.prepare_transfer(F.ADMIN, 'sample', version)
        self.assertFalse(self.stage(version).exists())

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

    def test_legacy_reservations_fall_back_to_physical_bytes_and_new_budget_is_strict(self):
        path = self.root / '.upload-reservations' / ('a' * 64 + '.json')
        for value in ({'bytes': 100}, {'bytes': 100, 'inodes': 4}):
            D._write_json(path, value)
            self.assertEqual(self.cache._upload_reserved()[0], 100)
            self.assertEqual(self.cache._budget_usage(), 100)
        D._write_json(path, {'bytes': 100, 'inodes': 4, 'budgetBytes': 150})
        self.assertEqual(self.cache._upload_reserved(), (100, 4))
        self.assertEqual(self.cache._budget_usage(), 150)
        for budget in (-1, True, 2**63, '100'):
            D._write_json(path, {'bytes': 100, 'inodes': 4, 'budgetBytes': budget})
            with self.assertRaisesRegex(D.CacheError, 'corrupt upload reservation'):
                self.cache._upload_reserved()
        D._write_json(path, {'bytes': 100, 'budgetBytes': 150})
        with self.assertRaisesRegex(D.CacheError, 'corrupt upload reservation'):
            self.cache._budget_usage()

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

    def finish_seal(self, state, raw):
        upload = state['uploadId']
        self.call('manifest', uploadId=upload, offset=0, data=base64.b64encode(raw).decode())
        self.call('seal', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'seal'), 0)
        return self.call('status', uploadId=upload)

    def test_exact_admitted_budget_seals_resumes_and_publishes_without_double_count(self):
        state, args, raw, files = self.admit()
        upload = state['uploadId']
        reserve = self.u.load(self.user, upload)['reserveBytes']
        self.call('discard', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'discard'), 0)
        self.cache.budget_bytes = reserve
        state, args, raw, files = self.admit()
        upload = state['uploadId']
        state = self.finish_seal(state, raw)
        self.assertEqual(state['state'], 'UPLOADING')
        session = self.u.load(self.user, upload)
        record = self.cache.export_manifest(U.D.Principal(self.user), session['dataset'], session['version'])
        footprint = self.cache._footprint(record['manifest'])
        reservation = U.D._read_json(self.u.reservation(self.user, upload))
        self.assertEqual(reservation['bytes'], reserve-session['totalBytes'])
        self.assertEqual(reservation['inodes'], session['entries']+16)
        self.assertEqual(reservation['budgetBytes'], reserve-footprint)
        with self.cache._locked():
            self.assertEqual(self.cache._budget_usage(), reserve)
            self.cache._budget()
        self.assertEqual(self.call('begin', **args)['state'], 'UPLOADING')
        self.fill(upload, files)
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        with self.cache._locked():
            self.assertEqual(self.cache._budget_usage(), footprint)
        self.assertEqual(self.call('status', uploadId=upload)['state'], 'READY')

    def test_two_concurrent_seals_spend_only_their_durable_admitted_reservations(self):
        rows = [self.admit(name=name) for name in ('first', 'second')]
        reserve = sum(self.u.load(self.user, row[0]['uploadId'])['reserveBytes'] for row in rows)
        self.cache.budget_bytes = reserve
        for state, _, raw, _ in rows:
            self.call('manifest', uploadId=state['uploadId'], offset=0, data=base64.b64encode(raw).decode())
            self.call('seal', uploadId=state['uploadId'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda row: self.u.worker(self.user, row[0]['uploadId'], 'seal'), rows))
        self.assertEqual(results, [0, 0])
        with self.cache._locked():
            self.assertEqual(self.cache._budget_usage(), reserve)
        for state, args, _, _ in rows:
            self.assertEqual(self.call('begin', **args)['uploadId'], state['uploadId'])
        with self.assertRaisesRegex(U.D.CacheError, 'cache budget reached'):
            self.admit(name='third')

    def test_legacy_pending_reservation_is_migrated_without_changing_physical_preallocation(self):
        state, args, raw, _ = self.admit()
        upload = state['uploadId']
        session = self.u.load(self.user, upload)
        path = self.u.reservation(self.user, upload)
        legacy = {k: v for k, v in self.u.reservation_value(session).items() if k != 'budgetBytes'}
        U.D._write_json(path, legacy)
        self.cache.budget_bytes = session['reserveBytes']
        self.assertEqual(self.call('begin', **args)['uploadId'], upload)
        migrated = U.D._read_json(path)
        self.assertEqual({k: v for k, v in migrated.items() if k != 'budgetBytes'}, legacy)
        self.assertEqual(migrated['budgetBytes'], session['reserveBytes'])
        self.assertEqual(self.finish_seal(state, raw)['state'], 'UPLOADING')

    def test_interrupted_conversion_without_stage_retains_full_logical_commitment(self):
        state, _, _, _ = self.admit()
        upload = state['uploadId']
        session = self.u.load(self.user, upload)
        pending = self.u.reservation_value(session, sealed=True, budget_sealed=False)
        U.D._write_json(self.u.reservation(self.user, upload), pending)
        self.cache.budget_bytes = session['reserveBytes']
        with self.cache._locked():
            self.assertEqual(self.cache._budget_usage(), session['reserveBytes'])
            self.u.ensure_reservation(session)
        self.assertEqual(U.D._read_json(self.u.reservation(self.user, upload)), self.u.reservation_value(session))

    def test_interrupted_conversion_after_stage_creation_overcounts_then_resumes_exactly(self):
        state, _, raw, _ = self.admit()
        upload = state['uploadId']
        reserve = self.u.load(self.user, upload)['reserveBytes']
        self.cache.budget_bytes = reserve
        self.call('manifest', uploadId=upload, offset=0, data=base64.b64encode(raw).decode())
        self.call('seal', uploadId=upload)
        original = self.cache._plan
        def interrupted(*args, **kwargs):
            original(*args, **kwargs)
            raise KeyboardInterrupt('killed before logical reservation handoff')
        with patch.object(self.cache, '_plan', side_effect=interrupted), self.assertRaises(KeyboardInterrupt):
            self.u.worker(self.user, upload, 'seal')
        with self.cache._locked():
            self.assertGreater(self.cache._budget_usage(), reserve)
        self.assertEqual(self.u.worker(self.user, upload, 'seal'), 0)
        with self.cache._locked():
            self.assertEqual(self.cache._budget_usage(), reserve)
        self.assertEqual(self.call('status', uploadId=upload)['state'], 'UPLOADING')

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
                # Give the real pinned-FD free-space guard an explicit fixture
                # larger than every configured reserve, not the Mac host disk.
                volume = SimpleNamespace(f_bavail=2**50, f_frsize=1, f_files=2**40, f_favail=2**40)
                with patch.object(self.module.os, 'fstatvfs', return_value=volume), patch.object(
                        self.node, 'storage_node', return_value=SimpleNamespace(tier=SimpleNamespace(collect=collector))):
                    result = self.node.dataset_cache_admission(123, _exclude=(('example', self.version),))
                self.assertEqual(result, {'enabled': True, 'state': 'CHECKED', 'reclaimedBytes': 0})
                collector.assert_not_called()
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


class EmptyReservationBudget(unittest.TestCase):
    setUp = E.EmptyRegistrationTests.setUp
    tearDown = E.EmptyRegistrationTests.tearDown
    request = E.EmptyRegistrationTests.request
    reserved_session = E.EmptyRegistrationTests.reserved_session
    assert_kept = E.EmptyRegistrationTests.assert_kept

    def test_new_unrelated_records_match_exact_resource_formula_and_are_not_modified(self):
        rows = [self.reserved_session(name='unsealed'), self.reserved_session(name='sealed', sealed=True),
                self.reserved_session(name='converting', sealed=True)]
        for index, (path, session, reservation, value) in enumerate(rows):
            footprint = session['totalBytes']+4096*session['entries']+8192
            value['budgetBytes'] = session['reserveBytes']-(footprint if index == 1 else 0)
            self.module._write_json(reservation, value)
        before = [row[2].read_bytes() for row in rows]
        result = self.request()
        self.assertEqual(self.node.dataset_worker(result['operationId']), 0)
        self.assertEqual([row[2].read_bytes() for row in rows], before)

    def test_new_record_cannot_relax_target_or_unknown_reservation_protection(self):
        _, session, reservation, value = self.reserved_session()
        for budget in (-1, True, 1, 2**63):
            self.module._write_json(reservation, {**value, 'budgetBytes': budget})
            with self.assertRaisesRegex(ValueError, 'budget'):
                self.request()
            self.assert_kept()
        self.module._write_json(reservation, {**value, 'budgetBytes': session['reserveBytes']})
        path, session, target_reservation, value = self.reserved_session(self.user.user_id, 'discarded', state='DISCARDED')
        self.module._write_json(target_reservation, {**value, 'budgetBytes': session['reserveBytes']})
        with self.assertRaisesRegex(ValueError, 'reservation prevents'):
            self.request()
        self.assert_kept()


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
