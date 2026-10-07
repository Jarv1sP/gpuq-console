"""Persistent real cache holds, isolated fixture nodes; no SSH/systemd/GPU."""
import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
import importlib.util
import json
import os
from pathlib import Path
import shutil
import threading
import time
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


F = load('storage_holds_fixture', HERE / 'snapshot-sync.test.py')
S = load('storage_holds', HERE.parent / 'deploy/storage-leases.py')


class StorageLeaseTests(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.fixture = F.SnapshotSyncTests()
        self.fixture.setUp()
        self.node = self.fixture.nodes[0]
        shutil.copy2(HERE.parent / 'deploy/storage-leases.py', self.node.HERE / 'storage-leases.py')
        (self.node.ROOT / 'jobs').mkdir(mode=0o700, exist_ok=True)
        self.d, self.cache = self.node.dataset_cache()
        self.admin = self.d.Principal('builtin-admin', True)
        self.actor = self.d.Principal(F.USER, False)
        self.version = self.cache.register_source(self.admin, 'shared', 'fixture', [F.USER])['version']
        self.cache.materialize(self.actor, 'shared', self.version)
        self.job = {'id': str(uuid.uuid4()), 'userId': F.USER,
                    'datasets': [{'dataset': 'shared', 'version': self.version}]}
        self.ref = {'kind': 'datasets', 'dataset': 'shared', 'version': self.version}
        self.args = {'id': str(uuid.uuid4()), 'userId': F.USER, 'reference': self.ref}
        self.s = S.StorageLeases(self.node)

    def tearDown(self):
        try:
            self.fixture.tearDown()
        finally:
            self.fixture.doCleanups()

    def leases(self):
        return self.cache._leases('shared', self.version)

    def blocked(self):
        with self.assertRaisesRegex(self.d.CacheError, 'leases'):
            self.cache.evict(self.admin, 'shared', self.version)

    def journal(self, kind, key):
        return self.s.root / kind / key / 'record.json'

    def test_prepare_uses_final_job_id_and_concurrent_restart_is_idempotent(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            values = list(pool.map(lambda _: S.StorageLeases(self.node).prepare(self.job), range(3)))
        self.assertTrue(all(value == values[0] for value in values))
        self.assertEqual(len(self.leases()), 1)
        self.assertEqual(self.leases()[0]['jobId'], self.job['id'])
        self.assertEqual(S.StorageLeases(self.node).prepare(self.job), values[0])
        self.blocked()

    def contend_for_cache(self, operation, seconds=2.2):
        locked = threading.Event()
        def holder():
            with self.cache._locked():
                locked.set()
                time.sleep(seconds)  # Longer than the cache's legacy two-second wait.
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(holder)
            self.assertTrue(locked.wait(5))
            result = operation()
            pending.result(timeout=5)
        return result

    def test_prepare_waits_for_short_metadata_contention_without_replaying(self):
        original = self.d.DatasetCache.acquire_lease
        with patch.object(self.d.DatasetCache, 'acquire_lease', autospec=True, side_effect=original) as acquire:
            result = self.contend_for_cache(lambda: self.s.prepare(self.job))
        self.assertEqual(result['state'], 'HELD')
        self.assertEqual(acquire.call_count, 1)
        self.assertEqual(len(self.leases()), 1)

    def test_handoff_waits_for_short_contention_and_preserves_exact_hold(self):
        leases = self.s.prepare(self.job)['leases']
        before = self.leases()
        self.assertEqual(self.contend_for_cache(lambda: self.s.handoff_if_present(self.job)), leases)
        self.assertEqual(self.leases(), before)

    def test_handoff_large_manifest_validation_does_not_own_global_cache_lock(self):
        leases = self.s.prepare(self.job)['leases']
        record, ready = self.d.DatasetCache._record, self.d.DatasetCache._ready
        calls = []
        def concurrent_metadata_read():
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(self.cache.capacity, self.actor).result(timeout=3)
        def unlocked_record(cache, *args, **kwargs):
            # This independent metadata request would deadlock/time out if
            # handoff retained the global lock while parsing the manifest.
            concurrent_metadata_read()
            calls.append('record')
            return record(cache, *args, **kwargs)
        def unlocked_ready(cache, *args, **kwargs):
            concurrent_metadata_read()
            calls.append('ready')
            return ready(cache, *args, **kwargs)
        with patch.object(self.d.DatasetCache, '_record', new=unlocked_record), patch.object(self.d.DatasetCache, '_ready', new=unlocked_ready):
            self.assertEqual(self.s.handoff_if_present(self.job), leases)
        self.assertEqual(calls, ['record', 'ready'])

    def test_handoff_rechecks_acl_after_unlocked_ready_validation(self):
        self.s.prepare(self.job)
        original = self.d.DatasetCache._ready_snapshot
        def revoke(cache, *args, **kwargs):
            result = original(cache, *args, **kwargs)
            self.cache.set_owners(self.admin, 'shared', ['demo-user-9'])
            return result
        with patch.object(self.d.DatasetCache, '_ready_snapshot', new=revoke):
            with self.assertRaises(PermissionError):
                self.s.handoff_if_present(self.job)
        self.assertEqual(len(self.leases()), 1)
        self.assertEqual(json.loads(self.journal('training', self.job['id']).read_text())['state'], 'HELD')

    def test_handoff_rechecks_registration_after_unlocked_validation(self):
        self.s.prepare(self.job)
        original = self.d.DatasetCache._ready_snapshot
        def replace(cache, *args, **kwargs):
            result = original(cache, *args, **kwargs)
            registration = self.cache._paths('shared')['.registry'] / (self.version + '.json')
            self.d._write_json(registration, self.d._read_json(registration))
            return result
        with patch.object(self.d.DatasetCache, '_ready_snapshot', new=replace):
            with self.assertRaisesRegex(self.d.CacheError, 'registration changed'):
                self.s.handoff_if_present(self.job)
        self.assertEqual(len(self.leases()), 1)

    def test_handoff_rechecks_ready_identity_after_unlocked_validation(self):
        self.s.prepare(self.job)
        original = self.d.DatasetCache._ready_snapshot
        def replace(cache, *args, **kwargs):
            result = original(cache, *args, **kwargs)
            ready = self.cache._paths('shared', self.version)['ready'] / 'READY.json'
            os.chmod(ready.parent, 0o700)  # Trusted fixture-only metadata replacement.
            try:
                self.d._write_json(ready, self.d._read_json(ready))
            finally:
                os.chmod(ready.parent, 0o555)
            return result
        with patch.object(self.d.DatasetCache, '_ready_snapshot', new=replace):
            with self.assertRaisesRegex(self.d.CacheError, 'published version metadata changed'):
                self.s.handoff_if_present(self.job)
        self.assertEqual(len(self.leases()), 1)

    def test_handoff_missing_lease_during_unlocked_validation_is_not_reacquired(self):
        held = self.s.prepare(self.job)['leases'][0]
        original = self.d.DatasetCache._ready_snapshot
        def release(cache, *args, **kwargs):
            result = original(cache, *args, **kwargs)
            self.cache.release_lease(self.admin, 'shared', self.version, held['leaseId'])
            return result
        with patch.object(self.d.DatasetCache, '_ready_snapshot', new=release):
            with self.assertRaisesRegex(ValueError, 'lease is missing'):
                self.s.handoff_if_present(self.job)
        self.assertEqual(self.leases(), [])

    def test_long_contention_still_fails_without_replay_or_held_receipt(self):
        original = self.d.DatasetCache.acquire_lease
        with patch.object(self.d.DatasetCache, 'acquire_lease', autospec=True, side_effect=original) as acquire:
            with self.assertRaises(self.d.CacheBusy):
                self.contend_for_cache(lambda: self.s.prepare(self.job), seconds=5.4)
        self.assertEqual(acquire.call_count, 1)
        self.assertEqual(self.leases(), [])
        self.assertEqual(json.loads(self.journal('training', self.job['id']).read_text())['state'], 'ACQUIRING')

    def test_prepare_does_not_reset_outer_lock_budget_or_assume_ready(self):
        with self.cache._locked(), self.d.wait_for_locks(timeout=0, total=0):
            with self.assertRaises(self.d.CacheBusy):
                self.s.prepare(self.job)
        self.assertEqual(self.leases(), [])
        self.assertEqual(json.loads(self.journal('training', self.job['id']).read_text())['state'], 'ACQUIRING')

    def test_finalized_handoff_explains_retry_boundary_without_reopening(self):
        self.s.prepare(self.job)
        path = self.journal('training', self.job['id'])
        record = json.loads(path.read_text())
        for state in ('CANCELING', 'CANCELED', 'RELEASING', 'RELEASED'):
            record['state'] = state
            self.d._write_json(path, record)
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'Preparation hold is not ready for handoff: previous preparation was finalized; native same-ID retry cannot reopen it'):
                self.s.handoff_if_present(self.job)
            self.assertEqual(path.read_bytes(), before)

    def test_new_and_existing_locks_use_exclusive_create_then_nofollow_open(self):
        for name in ('.history.lock', '.lock'):
            with self.d._directory(self.s.root) as directory:
                with patch.object(os, 'open', wraps=os.open) as opening:
                    first = self.s._open_lock(directory, name)
                    os.close(first)
                    second = self.s._open_lock(directory, name)
                    os.close(second)
                flags = [call.args[1] for call in opening.call_args_list]
                self.assertEqual(len(flags), 3)
                self.assertTrue(flags[0] & os.O_CREAT and flags[0] & os.O_EXCL)
                self.assertFalse(flags[0] & os.O_NOFOLLOW)
                self.assertTrue(flags[2] & os.O_NOFOLLOW)
                self.assertFalse(flags[2] & os.O_CREAT)

    def test_prepare_fence_is_durable_before_cache_acquire(self):
        with patch.object(self.s, '_save', side_effect=OSError('intent unavailable')):
            with self.assertRaises(OSError): self.s.prepare(self.job)
        self.assertEqual(self.leases(), [])

    def test_crash_after_acquire_before_lease_receipt_reconciles_same_lease(self):
        original = self.s._save
        def failed(path, record):
            if record['leases']: raise OSError('lease receipt failed')
            original(path, record)
        with patch.object(self.s, '_save', side_effect=failed):
            with self.assertRaises(OSError): self.s.prepare(self.job)
        before = self.leases()
        self.blocked()
        self.s.prepare(self.job)
        self.assertEqual(self.leases(), before)

    def test_partial_multi_dataset_prepare_retains_earlier_hold(self):
        other = self.cache.register_source(self.admin, 'other', 'fixture', [F.USER])['version']
        job = {**self.job, 'datasets': [*self.job['datasets'], {'dataset': 'other', 'version': other}]}
        with self.assertRaises(self.d.CacheError): self.s.prepare(job)
        self.blocked()
        self.cache.materialize(self.actor, 'other', other)
        self.assertEqual(len(self.s.prepare(job)['leases']), 2)

    def test_changed_job_owner_reference_or_alias_is_rejected(self):
        self.s.prepare(self.job)
        for changed in ({'userId': 'demo-user-9'}, {'datasets': []},
                        {'datasets': [{**self.job['datasets'][0], 'mountAs': 'alias'}]}):
            with self.assertRaises(ValueError): self.s.prepare({**self.job, **changed})
        self.blocked()

    def test_handoff_does_not_release_or_reacquire_and_persists_scheduler_receipt(self):
        held = self.s.prepare(self.job)['leases']
        with patch.object(self.d.DatasetCache, 'acquire_lease', side_effect=AssertionError('must not reacquire')):
            self.assertEqual(self.s.handoff(self.job), held)
            self.assertEqual(self.s.handoff(self.job), held)
        receipt = self.node.ROOT / 'jobs' / (self.job['id'] + '.datasets.json')
        self.assertEqual(json.loads(receipt.read_text()), held)
        self.blocked()
        for action in (self.s.prepare, self.s.cancel_prepare):
            with self.assertRaises(ValueError): action(self.job)

    def test_handoff_receipt_failure_retains_hold_and_retry_finishes(self):
        held = self.s.prepare(self.job)['leases']
        with patch.object(self.node, 'atomic_json', side_effect=OSError('scheduler receipt failed')):
            with self.assertRaises(OSError): self.s.handoff(self.job)
        self.blocked()
        self.assertEqual(self.s.handoff(self.job), held)

    def test_handoff_if_present_only_absent_journal_is_legacy(self):
        self.assertIsNone(self.s.handoff_if_present(self.job))
        self.assertFalse((self.s.root / 'training' / self.job['id']).exists())
        self.s.cancel_prepare(self.job)
        with self.assertRaises(ValueError): self.s.handoff_if_present(self.job)
        path = self.journal('training', self.job['id'])
        path.write_text('broken journal')
        with self.assertRaises(ValueError): self.s.handoff_if_present(self.job)

    def test_handoff_missing_registration_is_not_legacy_and_revoked_acl_is_denied(self):
        self.s.prepare(self.job)
        with patch.object(self.d.DatasetCache, '_record', side_effect=FileNotFoundError('registration missing')):
            with self.assertRaises(FileNotFoundError): self.s.handoff_if_present(self.job)
        with patch.object(self.d.DatasetCache, '_record', side_effect=PermissionError('owner revoked')):
            with self.assertRaises(PermissionError): self.s.handoff_if_present(self.job)
        self.blocked()

    def test_handoff_rejects_corrupt_host_path_and_return_shapes(self):
        held = self.s.prepare(self.job)
        self.assertEqual((held['jobId'], held['state']), (self.job['id'], 'HELD'))
        path = self.journal('training', self.job['id'])
        record = json.loads(path.read_text())
        record['leases'][0]['path'] = '/etc'
        self.d._write_json(path, record)
        with self.assertRaisesRegex(ValueError, 'path changed'): self.s.handoff_if_present(self.job)
        canceled = self.s.cancel_prepare(self.job)
        self.assertEqual(canceled, {'jobId': self.job['id'], 'state': 'CANCELED', 'released': True})

    def test_executor_submit_and_runner_reuse_hold_with_policy_disabled(self):
        held = self.s.prepare(self.job)['leases']
        before = self.leases()
        self.node.CONFIG['storageArchive'] = {'enabled': False}
        self.assertEqual(self.node.acquire_datasets(self.job), held)
        self.assertEqual(self.node.acquire_datasets(self.job), held)
        self.assertEqual(self.leases(), before)

    def test_executor_never_falls_back_from_canceled_or_missing_prepared_lease(self):
        self.s.cancel_prepare(self.job)
        with self.assertRaises(ValueError): self.node.acquire_datasets(self.job)
        job = {**self.job, 'id': str(uuid.uuid4())}
        held = self.s.prepare(job)['leases'][0]
        self.cache.release_lease(self.admin, 'shared', self.version, held['leaseId'])
        with self.assertRaisesRegex(ValueError, 'missing'): self.node.acquire_datasets(job)
        self.assertEqual(self.leases(), [])

    def test_executor_legacy_job_without_journal_keeps_existing_path(self):
        self.assertIsNone(self.s.handoff_if_present(self.job))
        leases = self.node.acquire_datasets(self.job)
        self.assertEqual(leases[0]['leaseId'], self.leases()[0]['id'])
        self.assertFalse((self.s.root / 'training' / self.job['id']).exists())

    def test_handoff_journal_failure_cannot_allow_prepare_cancel(self):
        held = self.s.prepare(self.job)['leases']
        original = self.s._save
        def failed(path, record):
            if record['state'] == 'HANDED_OFF': raise OSError('handoff receipt failed')
            original(path, record)
        with patch.object(self.s, '_save', side_effect=failed):
            with self.assertRaises(OSError): self.s.handoff(self.job)
        with self.assertRaisesRegex(ValueError, 'Scheduler owns'): self.s.cancel_prepare(self.job)
        self.blocked()
        self.assertEqual(self.s.handoff(self.job), held)

    def test_cancel_before_prepare_permanently_fences_that_job(self):
        self.s.cancel_prepare(self.job)
        self.s.cancel_prepare(self.job)
        with self.assertRaisesRegex(ValueError, 'finalized'): self.s.prepare(self.job)
        self.assertEqual(self.leases(), [])

    def test_finalize_training_absent_journal_is_legacy_without_creation(self):
        self.assertIsNone(self.s.finalize_training(self.job))
        self.assertFalse((self.s.root / 'training' / self.job['id']).exists())

    def test_finalize_training_after_legacy_receipt_unlink_is_permanent_and_idempotent(self):
        held = self.s.prepare(self.job)['leases'][0]
        self.s.handoff(self.job)
        self.cache.release_lease(self.admin, 'shared', self.version, held['leaseId'])
        (self.node.ROOT / 'jobs' / (self.job['id'] + '.datasets.json')).unlink()
        result = {'jobId': self.job['id'], 'state': 'RELEASED', 'released': True}
        self.assertEqual(self.s.finalize_training(self.job), result)
        self.assertEqual(S.StorageLeases(self.node).finalize_training(self.job), result)
        for action in (self.s.prepare, self.s.handoff_if_present, self.s.cancel_prepare):
            with self.assertRaises(ValueError): action(self.job)
        self.assertEqual(self.leases(), [])

    def test_finalize_training_partial_release_lost_reply_retries_exact_namespace(self):
        version = self.cache.register_source(self.admin, 'other', 'fixture', [F.USER])['version']
        self.cache.materialize(self.actor, 'other', version)
        job = {**self.job, 'datasets': [*self.job['datasets'], {'dataset': 'other', 'version': version}]}
        self.s.prepare(job)
        self.s.handoff(job)
        peer = self.cache.acquire_lease(self.actor, 'shared', self.version, 'transfer:' + job['id'])
        download = self.cache.acquire_lease(self.actor, 'shared', self.version, 'download:' + job['id'])
        original = self.d.DatasetCache.release_lease
        def lost_reply(cache, *args):
            original(cache, *args)
            raise OSError('release accepted but reply lost')
        with patch.object(self.d.DatasetCache, 'release_lease', new=lost_reply):
            with self.assertRaises(OSError): self.s.finalize_training(job)
        self.assertEqual(json.loads(self.journal('training', job['id']).read_text())['state'], 'RELEASING')
        with self.assertRaises(ValueError): self.s.handoff_if_present(job)
        self.assertTrue(self.s.finalize_training(job)['released'])
        self.assertEqual({value['id'] for value in self.leases()}, {peer['leaseId'], download['leaseId']})
        self.assertEqual(self.cache._leases('other', version), [])

    def test_finalize_training_lost_terminal_write_retains_fence_after_unregister(self):
        self.s.prepare(self.job)
        original = self.s._save
        def failed(path, record):
            if record['state'] == 'RELEASED': raise OSError('terminal receipt lost')
            original(path, record)
        with patch.object(self.s, '_save', side_effect=failed):
            with self.assertRaises(OSError): self.s.finalize_training(self.job)
        self.assertEqual(self.leases(), [])
        self.cache.evict(self.admin, 'shared', self.version)
        self.cache.unregister(self.admin, 'shared', self.version)
        self.assertTrue(self.s.finalize_training(self.job)['released'])
        with self.assertRaises(ValueError): self.s.prepare(self.job)

    def test_finalize_training_rejects_changed_owner_refs_or_unknown_journal(self):
        self.s.prepare(self.job)
        for changed in ({'userId': 'demo-user-9'}, {'datasets': []},
                        {'datasets': [{**self.job['datasets'][0], 'mountAs': 'alias'}]}):
            with self.assertRaises(ValueError): self.s.finalize_training({**self.job, **changed})
        path = self.journal('training', self.job['id'])
        record = json.loads(path.read_text())
        record['state'] = 'UNKNOWN'
        self.d._write_json(path, record)
        with self.assertRaises(ValueError): self.s.finalize_training(self.job)
        self.blocked()

    def test_cancel_recovers_unjournaled_hold_without_releasing_another_job(self):
        own = self.cache.acquire_lease(self.actor, 'shared', self.version, self.job['id'])
        other = self.cache.acquire_lease(self.actor, 'shared', self.version, 'other-job')
        self.s.cancel_prepare(self.job)
        self.assertEqual([value['id'] for value in self.leases()], [other['leaseId']])
        self.assertNotEqual(own['leaseId'], other['leaseId'])

    def test_cancel_write_failure_after_unlink_remains_retriable_after_unregister(self):
        self.s.prepare(self.job)
        original = self.s._save
        def failed(path, record):
            if record['state'] == 'CANCELED': raise OSError('terminal receipt failed')
            original(path, record)
        with patch.object(self.s, '_save', side_effect=failed):
            with self.assertRaises(OSError): self.s.cancel_prepare(self.job)
        self.assertEqual(self.leases(), [])
        with self.assertRaises(ValueError): self.s.prepare(self.job)
        self.cache.evict(self.admin, 'shared', self.version)
        self.cache.unregister(self.admin, 'shared', self.version)
        self.assertTrue(self.s.cancel_prepare(self.job)['released'])

    def test_missing_held_training_lease_is_not_silently_recreated(self):
        hold = self.s.prepare(self.job)['leases'][0]
        self.cache.release_lease(self.admin, 'shared', self.version, hold['leaseId'])
        for action in (self.s.prepare, self.s.handoff):
            with self.assertRaisesRegex(ValueError, 'missing'): action(self.job)
        self.assertEqual(self.leases(), [])

    def test_held_journal_cannot_lose_lease_metadata_and_reacquire(self):
        self.s.prepare(self.job)
        self.s.download_open(self.args)
        before = self.leases()
        for kind, key, action, args in (
                ('training', self.job['id'], self.s.prepare, self.job),
                ('downloads', self.args['id'], self.s.download_open, self.args)):
            path = self.journal(kind, key)
            record = json.loads(path.read_text())
            record['leases'] = []
            self.d._write_json(path, record)
            with self.assertRaisesRegex(ValueError, 'incomplete lease metadata'): action(args)
        self.assertEqual(self.leases(), before)

    def test_download_holds_whole_lifetime_and_restart_keeps_identity(self):
        opened = self.s.download_open(self.args)
        before = self.leases()
        self.assertEqual(before[0]['jobId'], 'download:' + self.args['id'])
        self.assertEqual(S.StorageLeases(self.node).download_open(self.args), opened)
        self.assertEqual(self.leases(), before)
        self.blocked()
        read = self.s.download_export('datasets.snapshot.get', {**self.args, 'path': 'sample.txt', 'offset': 0})
        self.assertEqual(base64.b64decode(read['data']), b'data sample')
        self.blocked()
        with patch('time.time', return_value=999999999999):
            self.assertEqual(self.s.download_open(self.args), opened)
        self.blocked()

    def test_download_intent_crash_reconciles_same_persistent_lease(self):
        original = self.s._save
        def failed(path, record):
            if record['leases']: raise OSError('held receipt failed')
            original(path, record)
        with patch.object(self.s, '_save', side_effect=failed):
            with self.assertRaises(OSError): self.s.download_open(self.args)
        before = self.leases()
        self.s.download_open(self.args)
        self.assertEqual(self.leases(), before)

    def test_download_does_not_share_transfer_namespace_even_same_uuid(self):
        peer = self.cache.acquire_lease(self.actor, 'shared', self.version, 'transfer:' + self.args['id'])
        self.s.download_open(self.args)
        self.assertEqual(len(self.leases()), 2)
        self.s.download_finish({**self.args, 'state': 'COMPLETED'})
        self.assertEqual([value['id'] for value in self.leases()], [peer['leaseId']])
        self.blocked()

    def test_download_complete_and_cancel_permanently_fence_open_and_reads(self):
        for terminal in ('COMPLETED', 'CANCELED'):
            args = {**self.args, 'id': str(uuid.uuid4())}
            self.s.download_open(args)
            self.assertTrue(self.s.download_finish({**args, 'state': terminal})['released'])
            self.assertTrue(self.s.download_finish({**args, 'state': terminal})['released'])
            for action in (lambda: self.s.download_open(args),
                           lambda: self.s.download_export('datasets.snapshot.info', args)):
                with self.assertRaisesRegex(ValueError, 'finalized'): action()
        self.assertEqual(self.leases(), [])

    def test_download_cancel_before_open_is_permanent(self):
        self.s.download_finish({**self.args, 'state': 'CANCELED'})
        with self.assertRaisesRegex(ValueError, 'finalized'): self.s.download_open(self.args)
        with self.assertRaisesRegex(ValueError, 'terminal identity'):
            self.s.download_finish({**self.args, 'state': 'COMPLETED'})

    def test_download_reference_without_kind_and_open_shape(self):
        args = {**self.args, 'reference': {'dataset': 'shared', 'version': self.version}}
        self.assertEqual(self.s.download_open(args), {'id': args['id'], 'state': 'OPEN'})
        self.assertEqual(self.s.download_open(self.args), {'id': args['id'], 'state': 'OPEN'})
        self.assertEqual(self.s.download_export('datasets.snapshot.info', args)['state'], 'READY')

    def test_download_identity_and_external_internal_lease_injection_rejected(self):
        self.s.download_open(self.args)
        for change in ({'userId': 'demo-user-9'}, {'hostAdmin': True},
                       {'reference': {**self.ref, 'version': 'a' * 64}}, {'leaseId': str(uuid.uuid4())}):
            for action in (self.s.download_open, lambda args: self.s.download_finish({**args, 'state': 'CANCELED'})):
                with self.assertRaises(ValueError): action({**self.args, **change})
        self.blocked()

    def test_missing_download_lease_fails_without_reacquiring(self):
        self.s.download_open(self.args)
        self.cache.release_lease(self.admin, 'shared', self.version, self.leases()[0]['id'])
        for action in (self.s.download_open, lambda args: self.s.download_export('datasets.snapshot.info', args)):
            with self.assertRaisesRegex(ValueError, 'missing'): action(self.args)
        self.assertEqual(self.leases(), [])

    def test_gc_cache_download_requires_private_matching_namespace(self):
        with self.cache._locked():
            tier = self.cache._tier('shared', self.version)
            tier['role'] = 'cache'
            self.cache._write_tier('shared', self.version, tier)
        self.node.CONFIG['storageTier'] = {'enabled': True, 'budgetBytes': 1024**3}
        flat = {'userId': F.USER, 'dataset': 'shared', 'version': self.version}
        sync = self.s._snapshots()
        with self.assertRaisesRegex(ValueError, '受保护原件'): sync.export('datasets.snapshot.info', flat)
        self.s.download_open(self.args)
        hold = self.leases()[0]
        self.assertEqual(sync.export('datasets.snapshot.info', flat,
                                     _download_lease=(self.args['id'], hold['id']))['state'], 'READY')
        with self.assertRaisesRegex(ValueError, 'missing'):
            sync.export('datasets.snapshot.info', flat, _transfer_lease=(self.args['id'], hold['id']))
        for value in (True, [self.args['id'], hold['id']], (str(uuid.uuid4()), hold['id'])):
            with self.assertRaises(ValueError): sync.export('datasets.snapshot.info', flat, _download_lease=value)
        with self.assertRaisesRegex(ValueError, 'Only one'):
            sync.export('datasets.snapshot.info', flat, _download_lease=(self.args['id'], hold['id']), _transfer_lease=(self.args['id'], hold['id']))
        with self.assertRaisesRegex(ValueError, 'Invalid snapshot operation'):
            sync.export('datasets.snapshot.info', {**flat, '_download_lease': [self.args['id'], hold['id']]})

    def test_download_finalization_waits_for_inflight_read(self):
        self.s.download_open(self.args)
        entered, finish = threading.Event(), threading.Event()
        original = self.s._export
        def delayed(*args):
            entered.set()
            if not finish.wait(5): raise AssertionError('Read was not released')
            return original(*args)
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.s, '_export', side_effect=delayed):
            reading = pool.submit(self.s.download_export, 'datasets.snapshot.info', self.args)
            self.assertTrue(entered.wait(5))
            releasing = pool.submit(self.s.download_finish, {**self.args, 'state': 'COMPLETED'})
            try:
                with self.assertRaises(FutureTimeoutError): releasing.result(timeout=.05)
                self.blocked()
            finally:
                finish.set()
            self.assertEqual(reading.result()['state'], 'READY')
            self.assertTrue(releasing.result()['released'])
        self.assertEqual(self.leases(), [])

    def test_download_release_crash_fences_reads_and_retry_after_unregister(self):
        self.s.download_open(self.args)
        original = self.s._save
        def failed(path, record):
            if record['state'] == 'COMPLETED': raise OSError('final receipt failed')
            original(path, record)
        with patch.object(self.s, '_save', side_effect=failed):
            with self.assertRaises(OSError): self.s.download_finish({**self.args, 'state': 'COMPLETED'})
        self.assertEqual(self.leases(), [])
        with self.assertRaises(ValueError): self.s.download_open(self.args)
        self.cache.evict(self.admin, 'shared', self.version)
        self.cache.unregister(self.admin, 'shared', self.version)
        self.assertTrue(self.s.download_finish({**self.args, 'state': 'COMPLETED'})['released'])

    def test_release_failure_before_unlink_keeps_hold_but_blocks_future_use(self):
        self.s.prepare(self.job)
        self.s.download_open(self.args)
        before = self.leases()
        with patch.object(self.d.DatasetCache, 'release_lease', side_effect=OSError('unlink unavailable')):
            with self.assertRaises(OSError): self.s.cancel_prepare(self.job)
            with self.assertRaises(OSError): self.s.download_finish({**self.args, 'state': 'CANCELED'})
        self.assertEqual(self.leases(), before)
        for call in (lambda: self.s.prepare(self.job), lambda: self.s.handoff_if_present(self.job),
                     lambda: self.s.download_open(self.args),
                     lambda: self.s.download_export('datasets.snapshot.info', self.args)):
            with self.assertRaises(ValueError): call()
        self.s.cancel_prepare(self.job)
        self.s.download_finish({**self.args, 'state': 'CANCELED'})
        self.assertEqual(self.leases(), [])

    def test_each_download_read_rechecks_owner_acl(self):
        self.s.download_open(self.args)
        with patch.object(self.d.DatasetCache, '_dataset', side_effect=PermissionError('ACL revoked')):
            with self.assertRaises(PermissionError):
                self.s.download_export('datasets.snapshot.get', {**self.args, 'path': 'sample.txt'})
        self.blocked()
        self.s.download_finish({**self.args, 'state': 'CANCELED'})

    def test_dangling_preparation_directory_is_not_a_legacy_absence(self):
        path = self.s.root / 'training' / self.job['id']
        path.symlink_to(self.fixture.root / 'missing')
        with self.assertRaisesRegex(ValueError, 'Unsafe'): self.s.handoff_if_present(self.job)

    def test_journal_symlink_and_wrong_file_mode_fail_closed(self):
        self.s.prepare(self.job)
        path = self.journal('training', self.job['id'])
        raw = path.read_bytes()
        outside = self.fixture.root / 'outside.json'
        outside.write_bytes(raw)
        path.unlink()
        path.symlink_to(outside)
        with self.assertRaises(OSError): self.s.prepare(self.job)
        path.unlink()
        path.write_bytes(raw)
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'Unsafe'): self.s.prepare(self.job)
        self.blocked()


if __name__ == '__main__':
    unittest.main()
