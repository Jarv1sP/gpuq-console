"""Real disposable journals/cache reservations; never devices, units or users."""
import fcntl
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


F = module('training_commitments_fixture', HERE/'training-storage.test.py')
C = module('training_commitments_copies', HERE.parent/'deploy/project-copy.py')


class TrainingCommitments(unittest.TestCase):
    def setUp(self):
        self.fixture = F.TrainingStorage()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.node, self.cache = self.fixture.node, self.fixture.cache
        self.node.CONFIG['datasets'] = {'root': str(self.cache.root)}
        self.node.ENV = {}
        original = F.t.load
        loader = patch.object(F.t, 'load', side_effect=lambda executor, name:
                              C if name == 'project-copy' else original(executor, name))
        loader.start()
        self.addCleanup(loader.stop)
        self.units = []
        self.activity = False
        def activity(copies, unit):
            self.units.append(unit)
            return self.activity
        guard = patch.object(C.ProjectCopies, 'activity', new=activity)
        guard.start()
        self.addCleanup(guard.stop)
        for name in ('status', '__init__'):
            guard = patch.object(C.ProjectCopies, name, side_effect=AssertionError('no writing copy API'))
            guard.start()
            self.addCleanup(guard.stop)

    def args(self, warehouse=False, datasets=False):
        args = self.fixture.args(datasets or warehouse)
        if warehouse:
            args['datasetReadMode'] = 'warehouse'
            self.node.CONFIG['storageArchive'] = {'authority': 'local-authority'}
            state = self.fixture.status({**args['datasets'][0], 'datasetReadMode': 'warehouse'})
            state.update(state='READY', warehouseReady=True, authority='local-authority')
            self.node.dataset_training_sources = lambda: SimpleNamespace(status=lambda unused: state)
        return args

    def reserve(self):
        self.cache.prepare_transfer(F.d.Principal(F.OWNER, True), 'data', self.fixture.version)
        with self.cache._locked():
            return self.cache._reserved(), self.cache._reserved_inodes()

    def copy(self, role='import', state='SUCCEEDED', *, attempt=1, started=True, result=True, slots=True):
        folder = self.node.ROOT/'project-copies'
        folder.mkdir(mode=0o700, exist_ok=True)
        key = str(uuid.uuid4())
        payload = {'role': role, 'userId': F.OWNER, 'project': 'vision', 'release': 'a'*64}
        if role == 'import':
            payload.update(sourceMachine='gpu-2', source={'totalBytes': 1024**3, 'entries': 1000})
        else:
            payload['targetMachine'] = 'gpu-2'
        spec = {**payload, 'id': key, 'digest': C.t.digest(payload), 'attempt': attempt, 'createdAt': 1}
        F.s.atomic_json(folder/(key+'.json'), spec)
        if result:
            F.s.atomic_json(folder/(key+'.result.json'), {'attempt': attempt, 'state': state})
        if started:
            F.s.atomic_json(folder/(key+'.started-'+str(attempt)), {'attempt': attempt})
        (folder/(key+'.worker.lock')).touch(mode=0o600)
        if slots:
            F.s.atomic_json(folder/'00000000-0000-0000-0000-000000000000.slots.json',
                            {'slots': [{'id': key, 'userId': F.OWNER}]})
        return folder, key

    def tree(self):
        return {str(path.relative_to(self.fixture.base)): path.read_bytes()
                for path in self.fixture.base.rglob('*') if path.is_file()}

    def test_project_only_subtracts_real_same_device_dataset_commitments(self):
        reserved, inodes = self.reserve()
        args = self.args()
        args.update(project='vision', release='a'*64,
                    projectFootprint={'sourceMachine': 'gpu-1', 'image': 'sha256:'+'b'*64,
                                      'architecture': 'amd64', 'codeBytes': 1, 'codeEntries': 1,
                                      'imageUnpackedBytes': 1024, 'imageEntries': 10})
        engine = SimpleNamespace(portable_image=lambda *unused: {'image': 'sha256:'+'b'*64, 'architecture': 'amd64'})
        ready = {'meta': {'environmentMode': 'oci', 'bytes': 1, 'entries': 1, 'oci': {}}}
        self.node.projects = lambda: SimpleNamespace(store=SimpleNamespace(release=lambda *unused: ready, _oci=lambda owner: engine))
        self.fixture.space.f_frsize = 1
        self.fixture.space.f_bavail = 8192+65536+reserved-1
        value = F.t.plan(self.node, args)
        volume = value['volumes'][0]
        self.assertEqual(volume['roles'], ['project'])
        self.assertEqual(volume['activeReservedBytes'], reserved)
        self.assertEqual(volume['activeReservedInodes'], inodes)
        self.assertEqual(volume['requiredBytes'], 65536)
        self.assertEqual(volume['usableBytes'], volume['availableBytes']-8192-reserved)
        self.assertFalse(value['fits'], 'the real outstanding bytes cannot be spent by a READY project')
        self.assertFalse((self.node.ROOT/'project-copies').exists())

    def test_warehouse_subtracts_same_device_commitments_without_allocating_cache(self):
        reserved, inodes = self.reserve()
        args = self.args(warehouse=True)
        before = self.tree()
        value = F.t.plan(self.node, args)
        self.assertEqual(value['volumes'][0]['roles'], ['project'])
        self.assertEqual(value['volumes'][0]['activeReservedBytes'], reserved)
        self.assertEqual(value['volumes'][0]['activeReservedInodes'], inodes)
        self.assertEqual(value['cacheBudget']['requiredBytes'], 0)
        self.assertEqual(self.tree(), before)

    def test_dataset_roles_share_one_commitment_and_never_double_count_it(self):
        reserved, inodes = self.reserve()
        value = F.t.plan(self.node, self.args(datasets=True))
        self.assertEqual(len(value['volumes']), 1)
        self.assertEqual(value['volumes'][0]['roles'], ['project', 'cache'])
        self.assertEqual(value['volumes'][0]['activeReservedBytes'], reserved)
        self.assertEqual(value['volumes'][0]['activeReservedInodes'], inodes)
        self.assertEqual(value['volumes'][0]['requiredBytes'], 65536)

    def test_unused_separate_cache_does_not_reduce_project_or_read_its_reservations(self):
        self.reserve()
        original = F.t.os.fstat
        def fstat(fd):
            info = original(fd)
            if info.st_ino == self.cache._root_identity[1]:
                fields = list(info)
                fields[2] += 1
                return os.stat_result(fields)
            return info
        with patch.object(F.t.os, 'fstat', side_effect=fstat), \
             patch.object(self.cache, '_reserved', side_effect=AssertionError('separate unused cache')):
            value = F.t.plan(self.node, self.args())
        self.assertEqual(len(value['volumes']), 1)
        self.assertEqual(value['volumes'][0]['activeReservedBytes'], 0)

    def test_requested_separate_cache_charges_only_its_own_volume_once(self):
        reserved, inodes = self.reserve()
        original = F.t.os.fstat
        workspace_inode = self.node.ROOT.stat().st_ino
        def fstat(fd):
            info = original(fd)
            if info.st_ino == workspace_inode:
                fields = list(info)
                fields[2] += 1
                return os.stat_result(fields)
            return info
        with patch.object(F.t.os, 'fstat', side_effect=fstat):
            value = F.t.plan(self.node, self.args(datasets=True))
        self.assertEqual(len(value['volumes']), 2)
        self.assertEqual(value['volumes'][0]['roles'], ['project'])
        self.assertEqual(value['volumes'][0]['activeReservedBytes'], 0)
        self.assertEqual(value['volumes'][0]['activeReservedInodes'], 0)
        self.assertEqual(value['volumes'][1]['roles'], ['cache'])
        self.assertEqual(value['volumes'][1]['activeReservedBytes'], reserved)
        self.assertEqual(value['volumes'][1]['activeReservedInodes'], inodes)

    def test_same_volume_future_dataset_inodes_gate_a_project_only_job(self):
        _, inodes = self.reserve()
        self.fixture.space.f_favail = 1024+16+inodes-1
        value = F.t.plan(self.node, self.args())
        self.assertFalse(value['fits'])
        self.assertEqual(value['volumes'][0]['usableInodes'], 15)

    def test_active_and_unknown_copy_never_become_zero_future_commitment(self):
        for activity in (True, None):
            with self.subTest(activity=activity):
                self.copy()
                self.activity = activity
                with self.assertRaisesRegex(ValueError, 'Active or unconfirmed project copy'):
                    F.t.plan(self.node, self.args())

    def test_stopped_terminal_copy_has_no_extra_future_charge_or_receipt_writes(self):
        for role, state in (('import', 'SUCCEEDED'), ('export', 'READY')):
            with self.subTest(role=role):
                self.copy(role, state)
                before = self.tree()
                value = F.t.plan(self.node, self.args())
                self.assertTrue(value['fits'])
                self.assertEqual(value['volumes'][0]['activeReservedBytes'], 0)
                self.assertEqual(self.tree(), before)
        self.assertTrue(self.units)

    def test_terminal_receipt_with_live_worker_lock_still_blocks(self):
        folder, key = self.copy()
        fd = os.open(folder/(key+'.worker.lock'), os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, 'Active or unconfirmed project copy'):
                F.t.plan(self.node, self.args())
        finally:
            os.close(fd)

    def test_cancel_without_cleanup_or_wrong_owner_cleanup_does_not_release(self):
        folder, key = self.copy(result=False)
        F.s.atomic_json(folder/(key+'.cancel'), {'userId': F.OWNER, 'at': 1})
        before = self.tree()
        with self.assertRaisesRegex(ValueError, 'Unconfirmed project copy commitment'):
            F.t.plan(self.node, self.args())
        self.assertEqual(self.tree(), before)
        F.s.atomic_json(folder/(key+'.cleanup.json'), {'at': 1, 'transportFilesReleased': True})
        F.s.atomic_json(folder/(key+'.cancel'), {'userId': 'demo-user-2', 'at': 1})
        with self.assertRaisesRegex(ValueError, 'Unconfirmed project copy commitment'):
            F.t.plan(self.node, self.args())

    def test_normally_reaped_never_started_cancel_is_finished_only_with_live_stop_proof(self):
        folder, key = self.copy(result=False, started=False)
        F.s.atomic_json(folder/(key+'.cancel'), {'userId': F.OWNER, 'at': 1})
        F.s.atomic_json(folder/(key+'.cleanup.json'), {'at': 1, 'transportFilesReleased': True})
        before = self.tree()
        value = F.t.plan(self.node, self.args())
        self.assertEqual(value['volumes'][0]['activeReservedBytes'], 0)
        self.assertEqual(self.tree(), before)
        self.assertFalse((folder/(key+'.result.json')).exists())
        self.assertFalse((folder/(key+'.started-1')).exists())
        for activity in (True, None):
            self.activity = activity
            with self.assertRaisesRegex(ValueError, 'Active or unconfirmed project copy'):
                F.t.plan(self.node, self.args())

    def test_canceled_result_does_not_release_an_unconfirmed_unit(self):
        folder, key = self.copy(state='CANCELED')
        F.s.atomic_json(folder/(key+'.cancel'), {'userId': F.OWNER, 'at': 1})
        self.activity = None
        with self.assertRaisesRegex(ValueError, 'Active or unconfirmed project copy'):
            F.t.plan(self.node, self.args())

    def test_old_result_or_missing_worker_lock_cannot_prove_current_stop(self):
        folder, key = self.copy()
        F.s.atomic_json(folder/(key+'.result.json'), {'attempt': 2, 'state': 'SUCCEEDED'})
        with self.assertRaisesRegex(ValueError, 'Unconfirmed project copy commitment'):
            F.t.plan(self.node, self.args())
        F.s.atomic_json(folder/(key+'.result.json'), {'attempt': 1, 'state': 'SUCCEEDED'})
        (folder/(key+'.worker.lock')).unlink()
        before = self.tree()
        with self.assertRaisesRegex(ValueError, 'Unconfirmed project copy worker'):
            F.t.plan(self.node, self.args())
        self.assertEqual(self.tree(), before, 'a capacity read must not create the missing lock')

    def test_slot_without_installed_journal_is_unconfirmed_not_absent(self):
        folder, key = self.copy()
        (folder/(key+'.json')).unlink()
        with self.assertRaisesRegex(ValueError, 'Unconfirmed project copy admission'):
            F.t.plan(self.node, self.args())

    def test_replaced_symlink_or_malformed_copy_journal_fails_closed(self):
        folder, key = self.copy()
        path = folder/(key+'.json')
        original = path.read_bytes()
        path.unlink()
        other = folder/'unexpected.json'
        other.write_bytes(original)
        other.chmod(0o600)
        path.symlink_to(other)
        with self.assertRaises(OSError): F.t.plan(self.node, self.args())
        path.unlink()
        F.s.atomic_json(path, {'id': key, 'attempt': True})
        with self.assertRaisesRegex(ValueError, 'Unknown project copy commitment'):
            F.t.plan(self.node, self.args())

    def test_bounded_journal_sampling_stops_before_unit_probe(self):
        self.copy()
        with patch.object(F.t.time, 'monotonic', side_effect=[0, 6]):
            with self.assertRaisesRegex(ValueError, 'read limit reached'):
                F.t._project_copies_idle(self.node, F.s)
        self.assertEqual(self.units, [])


if __name__ == '__main__':
    unittest.main()
