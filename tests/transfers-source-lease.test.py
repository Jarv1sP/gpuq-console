"""Real persistent DatasetCache leases; mocked target service lifecycle only."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
import importlib.util
import json
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
F = module('source_lease_fixture', HERE/'snapshot-sync.test.py')
T = module('source_lease_jobs', HERE.parent/'deploy/transfer-jobs.py')
USER = F.USER


class SourceLeases(unittest.TestCase):
    def setUp(self):
        self.fixture = F.SnapshotSyncTests(); self.fixture.setUp()
        self.source, self.target = self.fixture.nodes
        self.source.CONFIG['machine'] = 'gpu-source'; self.target.CONFIG['machine'] = 'gpu-target'
        self.target.CONFIG['transferPeers'] = {'gpu-source': {
            'address': '127.0.0.1', 'port': 18443, 'certificateSha256': 'a'*64}}
        self.d, self.cache = self.source.dataset_cache(); self.admin = self.d.Principal('builtin-admin', True)
        self.version = self.cache.register_source(self.admin, 'shared', 'fixture', [USER])['version']
        self.cache.materialize(self.admin, 'shared', self.version)
        self.src, self.dst = T.TransferJobs(self.source), T.TransferJobs(self.target)
        self.key = str(uuid.uuid4())
        self.ref = {'kind': 'datasets', 'dataset': 'shared', 'version': self.version}
        self.args = {'id': self.key, 'reference': self.ref, 'userId': USER, 'targetMachine': 'gpu-target'}
        self.control = {'id': self.key, 'userId': USER}
        self.patches = [patch.object(self.dst, 'activity', return_value=False), patch.object(self.target, 'run', return_value='')]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in self.patches: p.stop()
        self.fixture.tearDown()

    def leases(self):
        return self.cache._leases('shared', self.version)

    def evict_blocked(self):
        with self.assertRaisesRegex(self.d.CacheError, 'leases'):
            self.cache.evict(self.admin, 'shared', self.version)

    def prepared(self):
        self.ticket = self.src.prepare(self.args)
        return self.ticket

    def terminal(self, state='SUCCEEDED'):
        self.prepared()
        self.start = {**self.control, 'sourceMachine': 'gpu-source', 'source': self.ticket,
                      'reference': self.ref, 'name': 'copied'}
        self.dst.start(self.start)
        self.target.atomic_json(self.dst.path(self.key, '.result.json'), {'attempt': 1, 'state': state})
        return self.dst.confirm_source_release(self.control)

    def release(self, proof):
        return self.src.process('transfers.release-source', {**self.control, 'confirmation': proof})

    def test_lease_precedes_first_info_and_blocks_eviction(self):
        original = self.src.source
        def info(*args, **kwargs):
            self.assertEqual(self.leases()[0]['jobId'], 'transfer:'+self.key)
            self.evict_blocked()
            return original(*args, **kwargs)
        with patch.object(self.src, 'source', side_effect=info): self.prepared()
        self.assertEqual(len(self.leases()), 1)

    def test_concurrent_and_restarted_prepare_is_one_persistent_lease(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            tickets = list(pool.map(lambda _: T.TransferJobs(self.source).prepare(self.args), range(3)))
        self.assertTrue(all(ticket == tickets[0] for ticket in tickets))
        before = self.leases()
        self.assertEqual(T.TransferJobs(self.source).prepare(self.args), tickets[0])
        self.assertEqual(self.leases(), before)
        self.evict_blocked()

    def test_info_failure_retains_reconcilable_lease_and_retry_identity(self):
        with patch.object(self.src, 'source', side_effect=OSError('interrupted info')):
            with self.assertRaisesRegex(OSError, 'interrupted'): self.prepared()
        journal = self.src.load(self.key, '.source-lease.json')
        self.assertEqual(journal['leaseId'], self.leases()[0]['id'])
        self.assertFalse(self.src.path(self.key, '.ticket.json').exists())
        before = self.leases(); self.prepared(); self.assertEqual(self.leases(), before)

    def test_crash_between_acquire_and_journal_lease_id_is_recovered(self):
        atomic = self.source.atomic_json
        def fail(path, value):
            if path.name.endswith('.source-lease.json') and 'leaseId' in value: raise OSError('receipt failed')
            return atomic(path, value)
        with patch.object(self.source, 'atomic_json', side_effect=fail):
            with self.assertRaisesRegex(OSError, 'receipt failed'): self.prepared()
        self.assertNotIn('leaseId', self.src.load(self.key, '.source-lease.json'))
        before = self.leases(); self.evict_blocked(); self.prepared(); self.assertEqual(self.leases(), before)

    def test_ticket_persistence_failure_does_not_orphan_unidentifiable_lease(self):
        atomic = self.source.atomic_json
        def fail(path, value):
            if path.name.endswith('.ticket.json'): raise OSError('ticket failed')
            return atomic(path, value)
        with patch.object(self.source, 'atomic_json', side_effect=fail):
            with self.assertRaisesRegex(OSError, 'ticket failed'): self.prepared()
        self.assertEqual(self.src.load(self.key, '.source-lease.json')['leaseId'], self.leases()[0]['id'])
        before = self.leases(); self.prepared(); self.assertEqual(self.leases(), before)

    def test_expiry_and_renewal_never_release_or_replace_lease(self):
        ticket = self.prepared(); before = self.leases()
        stored = self.src.load(self.key, '.ticket.json'); stored['expiresAt'] = 0
        self.source.atomic_json(self.src.path(self.key, '.ticket.json'), stored)
        restarted = T.TransferJobs(self.source)
        with self.assertRaisesRegex(ValueError, 'expired'): restarted.read({'id': self.key, 'action': 'info'}, ticket['token'])
        with self.assertRaisesRegex(ValueError, 'expired'): restarted.prepare(self.args)
        renewed = restarted.prepare({**self.args, 'renew': True})
        self.assertNotEqual(renewed['token'], ticket['token']); self.assertEqual(self.leases(), before)
        self.evict_blocked()

    def test_changed_identity_owner_or_machine_never_rebinds_lease(self):
        self.prepared(); before = self.leases()
        for change in ({'targetMachine': 'other'}, {'userId': 'demo-user-9'}, {'timeoutSec': 3}):
            with self.assertRaises(ValueError): self.src.prepare({**self.args, **change})
        self.source.CONFIG.pop('machine')
        with self.assertRaisesRegex(ValueError, 'machine identity'): self.src.prepare(self.args)
        self.assertEqual(self.leases(), before)

    def test_peer_bearer_and_cross_owner_cannot_release(self):
        proof = self.terminal(); before = self.leases()
        with self.assertRaises(ValueError): self.src.read({'id': self.key, 'action': 'release-source'}, self.ticket['token'])
        with self.assertRaises(ValueError): self.release({**proof, 'targetMachine': 'other'})
        with self.assertRaisesRegex(ValueError, 'another user'):
            self.src.release_source({'id': self.key, 'userId': 'demo-user-9', 'confirmation': proof})
        with self.assertRaisesRegex(ValueError, 'fields'):
            self.src.release_source({**self.control, 'confirmation': proof, 'token': self.ticket['token']})
        self.assertEqual(self.leases(), before)

    def test_success_release_is_idempotent_and_permanently_fences_restart(self):
        proof = self.terminal()
        self.assertEqual(self.release(proof), {'id': self.key, 'released': True})
        self.assertEqual(self.release(proof), {'id': self.key, 'released': True})
        self.assertEqual(self.leases(), [])
        self.assertEqual(T.TransferJobs(self.target).confirm_source_release(self.control), proof)
        for call in (lambda: self.src.prepare({**self.args, 'renew': True}),
                     lambda: self.dst.start(self.start), lambda: self.dst.resume(self.control)):
            with self.assertRaisesRegex(ValueError, 'finalized'): call()
        self.assertEqual(self.dst.worker(self.key, 1), 1)
        with self.assertRaisesRegex(ValueError, 'invalid or expired'):
            self.src.read({'id': self.key, 'action': 'info'}, self.ticket['token'])
        self.cache.evict(self.admin, 'shared', self.version)

    def test_active_unknown_and_paused_targets_retain_lease(self):
        self.prepared()
        self.start = {**self.control, 'sourceMachine': 'gpu-source', 'source': self.ticket, 'reference': self.ref, 'name': 'copy'}
        self.dst.start(self.start)
        for active in (True, None, False):
            with patch.object(self.dst, 'activity', return_value=active):
                with self.assertRaisesRegex(ValueError, 'confirmed stopped'): self.dst.confirm_source_release(self.control)
        self.target.atomic_json(self.dst.path(self.key, '.result.json'), {'attempt': 1, 'state': 'PAUSED'})
        with self.assertRaisesRegex(ValueError, 'confirmed stopped'): self.dst.confirm_source_release(self.control)
        self.assertFalse(self.dst.path(self.key, '.source-release.json').exists()); self.evict_blocked()

    def test_cancel_requires_stopped_and_pre_dispatch_cancel_can_finalize(self):
        self.prepared(); self.dst.cancel(self.control)
        binding = {**self.control, 'sourceMachine': 'gpu-source', 'reference': self.ref,
                   'manifestSha256': self.ticket['manifestSha256']}
        with patch.object(self.dst, 'activity', return_value=None):
            with self.assertRaisesRegex(ValueError, 'confirmed stopped'): self.dst.confirm_source_release(binding)
        proof = self.dst.confirm_source_release(binding)
        self.assertEqual((proof['attempt'], proof['state']), (0, 'CANCELED'))
        self.release(proof); self.assertEqual(self.leases(), [])

    def test_failed_is_retained_until_explicit_finalization_then_cannot_resume(self):
        self.prepared(); before = self.leases(); proof = self.terminal('FAILED')
        self.assertEqual(self.leases(), before)
        self.release(proof)
        with self.assertRaisesRegex(ValueError, 'finalized'): self.dst.resume(self.control)

    def test_release_crash_keeps_fence_and_retry_finishes(self):
        proof = self.terminal(); before = self.leases()
        with patch.object(self.src, 'snapshots', side_effect=OSError('release interrupted')):
            with self.assertRaisesRegex(OSError, 'interrupted'): self.release(proof)
        self.assertEqual(self.leases(), before)
        self.assertEqual(self.src.load(self.key, '.source-lease.json')['state'], 'RELEASING')
        with self.assertRaisesRegex(ValueError, 'finalized'): self.src.prepare({**self.args, 'renew': True})
        self.release(proof); self.assertEqual(self.leases(), [])

    def test_crash_after_actual_release_before_receipt_is_idempotent(self):
        proof = self.terminal(); atomic = self.source.atomic_json
        def fail(path, value):
            if path.name.endswith('.source-lease.json') and value['state'] == 'RELEASED': raise OSError('final receipt failed')
            return atomic(path, value)
        with patch.object(self.source, 'atomic_json', side_effect=fail):
            with self.assertRaisesRegex(OSError, 'final receipt'): self.release(proof)
        self.assertEqual(self.leases(), [])
        self.cache.evict(self.admin, 'shared', self.version)
        self.cache.unregister(self.admin, 'shared', self.version)
        self.release(proof)
        self.assertEqual(self.src.load(self.key, '.source-lease.json')['state'], 'RELEASED')

    def test_missing_lease_cannot_be_hidden_by_still_valid_ticket(self):
        ticket = self.prepared(); lease = self.leases()[0]
        self.cache.release_lease(self.admin, 'shared', self.version, lease['id'])
        with self.assertRaisesRegex(ValueError, 'lease is missing'):
            self.src.read({'id': self.key, 'action': 'info'}, ticket['token'])

    def test_each_transfer_has_its_own_lease_and_release_preserves_others(self):
        proof = self.terminal()
        other = {**self.args, 'id': str(uuid.uuid4())}
        self.src.prepare(other); self.assertEqual(len(self.leases()), 2)
        self.release(proof)
        self.assertEqual([lease['jobId'] for lease in self.leases()], ['transfer:'+other['id']])
        self.evict_blocked()

    def test_release_waits_for_inflight_read_before_unlinking_lease(self):
        proof = self.terminal(); entered, proceed = threading.Event(), threading.Event()
        original = self.src.source
        def slow(*args, **kwargs):
            entered.set()
            if not proceed.wait(5): raise AssertionError('test release did not unblock read')
            return original(*args, **kwargs)
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.src, 'source', side_effect=slow):
            reading = pool.submit(self.src.read, {'id': self.key, 'action': 'info'}, self.ticket['token'])
            self.assertTrue(entered.wait(5))
            releasing = pool.submit(self.release, proof)
            try:
                with self.assertRaises(FutureTimeoutError): releasing.result(timeout=.05)
                self.evict_blocked()
            finally:
                proceed.set()
            self.assertEqual(reading.result()['state'], 'READY')
            self.assertTrue(releasing.result()['released'])
        self.assertEqual(self.leases(), [])


if __name__ == '__main__': unittest.main()
