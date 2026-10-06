"""Version-data isolation failures, with local disposable bytes only."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch
from dataset_retention_helpers import protected_original

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, DEPLOY/file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


D = module('retirement_test_cache', 'dataset-cache.py')
R = module('retirement_tests', 'dataset-retirement.py')
ADMIN = D.Principal('administrator', True)
OWNER = D.Principal('owner')
OTHER = D.Principal('other')


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = self.root/'source'
        source.mkdir()
        (source/'train.txt').write_bytes(b'fixed complete data')
        self.cache = D.DatasetCache(self.root/'cache', sources={'source':source}, reserve_bytes=0, lock_timeout=.01)
        self.now = 1000000.0
        self.retirement = R.DatasetRetirement(self.cache, 'test-long-machine', clock=lambda:self.now,clock_synchronized=lambda:True)
        self.key = str(uuid.uuid4())
        with self.cache._locked():
            registered = self.cache._register(D.Principal('owner', True), 'sample', D._scan(source), ['owner'], 'source',
                                             _origin='upload', _receipt=str(uuid.uuid4()))
        self.version = registered['version']
        self.cache.materialize(OWNER, 'sample', self.version)
        self.snapshot = self.retirement.inspect(OWNER, 'sample', self.version)

    def tearDown(self):
        for root, _, files in os.walk(self.root):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root)/name
                if not path.is_symlink():
                    path.chmod(0o600)

    def isolate(self, actor=OWNER, snapshot=None, **kwargs):
        return self.retirement.isolate(actor, 'sample', self.version, self.key, snapshot or self.snapshot, **kwargs)

    def retained(self):
        return self.retirement._folder(self.key)/'payload'/'ready'/'data'/'train.txt'

    def test_last_complete_data_is_retained_for_seven_days_and_query_is_pure(self):
        result = self.isolate()
        self.assertEqual(result['state'], 'ISOLATED')
        self.assertTrue(result['complete'])
        self.assertEqual(self.retained().read_bytes(), b'fixed complete data')
        self.assertFalse(self.cache._paths('sample', self.version)['ready'].exists())
        journal = self.retirement._folder(self.key)/'RETIREMENT.json'
        before = journal.read_bytes()
        self.assertEqual(self.retirement.status(OWNER, self.key), result)
        self.assertEqual(journal.read_bytes(), before)
        with self.assertRaises(PermissionError):
            self.retirement.status(OTHER, self.key)
        for timestamp in (result['retainUntil']-1, self.now):
            self.now = timestamp
            with self.assertRaises(ValueError):
                self.retirement.purge(ADMIN, self.key)
            self.assertTrue(self.retained().exists())

    def test_restore_ready_crash_can_finish_after_original_retention_deadline(self):
        isolated=self.isolate()
        original=R.D._rename_new
        def crash(source,destination):
            original(source,destination)
            if destination==self.cache._paths('sample',self.version)['ready']:
                raise OSError('crash after restore-ready')
        with patch.object(R.D,'_rename_new',side_effect=crash),self.assertRaisesRegex(OSError,'restore-ready'):
            self.retirement.restore(ADMIN,self.key)
        self.assertEqual(self.retirement.status(ADMIN,self.key)['state'],'RESTORING')
        self.now=isolated['retainUntil']+86400
        result=self.retirement.restore(ADMIN,self.key)
        self.assertEqual(result['state'],'RESTORED')
        self.assertEqual((self.cache._paths('sample',self.version)['ready']/'data/train.txt').read_bytes(),b'fixed complete data')
        self.assertFalse(self.retained().exists())

    def test_forward_wall_clock_jump_without_ntp_proof_never_purges_full_bytes(self):
        result=self.isolate();self.now=result['retainUntil']+30*86400
        for probe in (lambda:False,lambda:None,lambda:(_ for _ in ()).throw(OSError('no clock evidence'))):
            self.retirement.clock_synchronized=probe
            with self.assertRaisesRegex(ValueError,'NTP'):
                self.retirement.purge(ADMIN,self.key)
            self.assertTrue(self.retained().exists())
            self.assertEqual(self.retirement.status(ADMIN,self.key)['state'],'ISOLATED')
        self.retirement.clock_synchronized=lambda:True
        self.assertEqual(self.retirement.purge(ADMIN,self.key)['state'],'PURGED')

    def test_clock_or_commit_lost_during_long_hash_never_reaches_payload_cleanup(self):
        result=self.isolate();self.now=result['retainUntil']+1
        verify=self.retirement._verify_payload
        for kind in ('clock','commit'):
            self.retirement.clock_synchronized=lambda:True
            self.retirement.collection_allowed=lambda key:True
            def lose_evidence(row,**kwargs):
                verify(row,**kwargs)
                if kind=='clock':self.retirement.clock_synchronized=lambda:False
                else:self.retirement.collection_allowed=lambda key:None
            with self.subTest(kind=kind),patch.object(self.retirement,'_verify_payload',side_effect=lose_evidence),\
                    self.assertRaisesRegex(ValueError,'NTP|not committed'):
                self.retirement.purge(ADMIN,self.key)
            self.assertTrue(self.retained().exists())
            self.assertEqual(self.retirement.status(ADMIN,self.key)['state'],'ISOLATED')

    def test_ordinary_admin_or_personal_delete_never_erases_last_complete_copy(self):
        before = (self.cache._paths('sample', self.version)['ready']/'data'/'train.txt').read_bytes()
        for actor, whole in ((ADMIN, False), (ADMIN, True), (OWNER, False)):
            with self.subTest(actor=actor, whole=whole), self.assertRaisesRegex(ValueError, '最后一份'):
                self.cache.unregister(actor, 'sample', None if whole else self.version)
        with self.assertRaisesRegex(ValueError, '最后一份'):
            self.cache.evict(ADMIN, 'sample', self.version)
        self.assertEqual((self.cache._paths('sample', self.version)['ready']/'data'/'train.txt').read_bytes(), before)
        self.assertEqual(list((self.cache.root/'.trash').iterdir()), [])

    def test_real_protected_original_allows_personal_cache_removal_but_stale_source_does_not(self):
        original = protected_original(self.cache, D, self.root/'original')
        proof = original._paths('sample', self.version)['ready']/'READY.json'
        saved = proof.read_bytes()
        proof.chmod(0o600)
        proof.write_bytes(saved)  # Even equal bytes invalidate its immutable receipt.
        with self.assertRaises(ValueError):
            self.cache.unregister(OWNER, 'sample', self.version)
        self.assertTrue(self.cache._paths('sample', self.version)['ready'].exists())

    def test_positive_personal_unregister_requires_another_actual_full_original(self):
        original = protected_original(self.cache, D, self.root/'original')
        self.assertTrue(self.cache.unregister(OWNER, 'sample', self.version)['unregistered'])
        self.assertEqual((original._paths('sample', self.version)['ready']/'data'/'train.txt').read_bytes(), b'fixed complete data')

    def test_interrupted_ordinary_cleanup_rechecks_original_before_erasing_quarantined_bytes(self):
        original = protected_original(self.cache, D, self.root/'original')
        with patch.object(D.shutil, 'rmtree', side_effect=OSError('stop after quarantine')), self.assertRaises(OSError):
            self.cache.unregister(OWNER, 'sample', self.version)
        retained = next((self.cache.root/'.trash').glob('unregister-*/replicas/ready/*/data/train.txt'))
        ready = original._paths('sample', self.version)['ready']
        D._rename_new(ready, original.root/'offline')
        with self.assertRaises((ValueError, OSError)):
            self.cache.unregister(OWNER, 'sample', self.version)
        self.assertEqual(retained.read_bytes(), b'fixed complete data')

    def test_corrupted_isolated_receipt_cannot_be_replayed_as_success(self):
        self.isolate()
        self.retained().chmod(0o600)
        self.retained().write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'verification'):
            self.isolate()
        self.assertTrue(self.retained().exists())

    def test_cross_filesystem_rename_failure_keeps_registration_and_complete_data(self):
        import errno
        with patch.object(R.D, '_rename_new', side_effect=OSError(errno.EXDEV, 'different filesystem')):
            with self.assertRaises(OSError):
                self.isolate()
        self.assertTrue(self.cache._paths('sample', self.version)['ready'].exists())
        self.assertTrue((self.cache._paths('sample')['.registry']/(self.version+'.json')).exists())
        self.assertEqual(self.retirement.status(OWNER, self.key)['state'], 'ISOLATING')

    def test_non_owner_shared_admin_and_unknown_provenance_never_allow_member_isolation(self):
        with self.assertRaises(PermissionError):
            self.retirement.inspect(OTHER, 'sample', self.version)
        proof = self.cache.root/'.provenance'/'sample'/(self.version+'.json')
        saved = proof.read_bytes()
        proof.unlink()
        with self.assertRaisesRegex(PermissionError, '管理员'):
            self.retirement.inspect(OWNER, 'sample', self.version)
        proof.write_bytes(saved)
        proof.chmod(0o600)
        self.cache.set_owners(ADMIN, 'sample', ['owner','other'])
        with self.assertRaisesRegex(PermissionError, '管理员'):
            self.retirement.inspect(OWNER, 'sample', self.version)
        self.assertTrue(self.retirement.inspect(ADMIN, 'sample', self.version)['complete'])

    def test_uuid_cannot_change_account_target_snapshot_or_admin_role(self):
        self.isolate()
        for actor in (OTHER, ADMIN):
            with self.subTest(actor=actor), self.assertRaises(PermissionError):
                self.isolate(actor)
        with self.assertRaises(PermissionError):
            self.isolate(snapshot={**self.snapshot, 'complete':False})
        self.assertTrue(self.retained().exists())

    def test_lease_use_pin_and_unfinished_writer_block_before_any_data_move(self):
        lease = self.cache.acquire_lease(OWNER, 'sample', self.version, 'job')
        with self.assertRaisesRegex(ValueError, 'leases'):
            self.isolate()
        self.cache.release_lease(ADMIN, 'sample', self.version, lease['leaseId'])
        self.cache.pin(ADMIN, 'sample', self.version, 'manual-use')
        with self.assertRaisesRegex(ValueError, 'pins'):
            self.isolate()
        self.cache.unpin(ADMIN, 'sample', self.version, 'manual-use')
        stage = self.cache._paths('sample', self.version)['.staging']
        D._mkdir(stage)
        with self.assertRaisesRegex(ValueError, 'staging'):
            self.isolate()
        self.assertTrue(self.cache._paths('sample', self.version)['ready'].exists())

    def test_existing_authority_pin_without_complete_dependency_revocation_refuses_isolation(self):
        self.cache.pin(ADMIN, 'sample', self.version, 'authority-test')
        self.snapshot = self.retirement.inspect(ADMIN, 'sample', self.version)
        with self.assertRaisesRegex(ValueError, 'dependent removal'):
            self.isolate(ADMIN)
        self.assertTrue(self.cache._paths('sample', self.version)['ready'].exists())
        with self.assertRaisesRegex(ValueError, 'reconciliation'):
            self.cache.unpin(ADMIN, 'sample', self.version, 'authority-test')

    def test_stale_registration_preflight_and_different_cache_identity_fail_closed(self):
        path = self.cache._paths('sample')['.registry']/(self.version+'.json')
        D._write_json(path, D._read_json(path))
        with self.assertRaises((ValueError, PermissionError)):
            self.isolate()
        snapshot = self.retirement.inspect(ADMIN, 'sample', self.version)
        self.retirement.isolate(ADMIN, 'sample', self.version, self.key, snapshot)
        journal = self.retirement._folder(self.key)/'RETIREMENT.json'
        value = D._read_json(journal)
        D._write_json(journal, {**value, 'rootIdentity':[0,0]})
        self.now += 8*86400
        with self.assertRaisesRegex(ValueError, 'corrupt'):
            self.retirement.purge(ADMIN, self.key)
        self.assertTrue(self.retained().exists())

    def test_crash_after_ready_rename_resumes_only_same_fixed_transaction(self):
        rename = R.D._rename_new
        calls = []
        def crash(source, destination):
            rename(source, destination)
            calls.append(destination)
            raise OSError('kill after payload rename and fsync')
        with patch.object(R.D, '_rename_new', side_effect=crash), self.assertRaisesRegex(OSError, 'kill'):
            self.isolate()
        self.assertEqual(len(calls), 1)
        self.assertTrue(self.retained().exists())
        self.assertEqual(self.retirement.status(OWNER, self.key)['state'], 'ISOLATING')
        self.assertEqual(self.isolate()['state'], 'ISOLATED')
        self.assertTrue(self.retained().exists())

    def test_early_expired_or_nonadmin_restore_does_not_mutate_retained_data(self):
        result = self.isolate()
        with self.assertRaises(PermissionError):
            self.retirement.restore(OWNER, self.key)
        self.now = result['retainUntil']
        with self.assertRaisesRegex(ValueError, 'retention'):
            self.retirement.restore(ADMIN, self.key)
        self.assertEqual(self.retained().read_bytes(), b'fixed complete data')

    def test_restore_uses_new_registration_identity_and_refuses_existing_user_data(self):
        old = self.snapshot['registration']
        self.isolate()
        restored = self.retirement.restore(ADMIN, self.key)
        self.assertEqual(restored['state'], 'RESTORED')
        self.assertNotEqual(list(self.cache._record_identity('sample', self.version)), old)
        self.assertEqual((self.cache._paths('sample', self.version)['ready']/'data'/'train.txt').read_bytes(), b'fixed complete data')
        self.assertTrue(self.cache.deletion_permissions(OWNER, 'sample', self.version)['memberAllowed'])
        with self.assertRaises(ValueError):
            self.retirement.purge(ADMIN, self.key)
        with self.assertRaises(ValueError):
            self.isolate()

    def test_restore_will_never_overwrite_a_new_registration(self):
        self.isolate()
        filename = self.cache._paths('sample')['.registry']/(self.version+'.json')
        D._write_json(filename, {'new':'user data'})
        before = filename.read_bytes()
        with self.assertRaisesRegex(ValueError, 'overwrites'):
            self.retirement.restore(ADMIN, self.key)
        self.assertEqual(filename.read_bytes(), before)
        self.assertTrue(self.retained().exists())

    def test_clock_rollback_or_corrupt_deadline_never_enables_cleanup(self):
        self.isolate()
        self.now -= 1
        with self.assertRaisesRegex(ValueError, 'backwards'):
            self.retirement.purge(ADMIN, self.key)
        self.now += 9*86400
        journal = self.retirement._folder(self.key)/'RETIREMENT.json'
        row = D._read_json(journal)
        D._write_json(journal, {**row, 'retainUntil':0})
        with self.assertRaisesRegex(ValueError, 'deadline'):
            self.retirement.purge(ADMIN, self.key)
        self.assertTrue(self.retained().exists())

    def test_links_and_unknown_payload_or_final_hash_failure_are_never_deleted(self):
        result = self.isolate()
        self.now = result['retainUntil']
        payload = self.retirement._folder(self.key)/'payload'
        (payload/'unknown').write_bytes(b'keep')
        with self.assertRaises(ValueError):
            self.retirement.purge(ADMIN, self.key)
        self.assertTrue(self.retained().exists())
        (payload/'unknown').unlink()
        self.retained().chmod(0o600)
        self.retained().write_bytes(b'corrupted data')
        with self.assertRaisesRegex(ValueError, 'verification'):
            self.retirement.purge(ADMIN, self.key)
        self.assertTrue(self.retained().exists())

    def test_expired_isolation_purges_payload_but_keeps_journal_and_timer_is_opt_in(self):
        result = self.isolate()
        self.now = result['retainUntil']
        self.assertEqual(self.retirement.collect_expired(ADMIN), {'enabled':False,'purged':[],'skipped':[]})
        self.assertTrue(self.retained().exists())
        self.assertEqual(self.retirement.purge(ADMIN, self.key)['state'], 'PURGED')
        self.assertFalse(self.retained().exists())
        self.assertTrue((self.retirement._folder(self.key)/'RETIREMENT.json').exists())
        with self.assertRaises(ValueError):
            self.retirement.restore(ADMIN, self.key)

    def test_link_or_special_file_in_retained_tree_never_crosses_a_cleanup_boundary(self):
        result = self.isolate()
        self.now = result['retainUntil']
        parent = self.retained().parent
        parent.chmod(0o755)
        outside = self.root/'outside'
        outside.write_bytes(b'never delete')
        link = parent/'unexpected'
        for kind in ('symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind):
                if kind == 'symlink':
                    link.symlink_to(outside)
                elif kind == 'hardlink':
                    os.link(outside, link)
                else:
                    os.mkfifo(link)
                with self.assertRaises((ValueError, OSError)):
                    self.retirement.purge(ADMIN, self.key)
                self.assertEqual(outside.read_bytes(), b'never delete')
                self.assertTrue(self.retained().exists())
                link.unlink()

    def test_each_registration_metadata_move_can_resume_after_post_rename_crash(self):
        move = self.cache._unregister_move_record
        count = 0
        def crash(source, destination):
            nonlocal count
            move(source, destination)
            count += 1
            raise OSError('kill after committed metadata rename')
        for _ in range(3):
            with patch.object(self.cache, '_unregister_move_record', side_effect=crash), self.assertRaises(OSError):
                self.isolate()
            self.assertTrue(self.retained().exists())
            self.assertEqual(self.retirement.status(OWNER, self.key)['state'], 'ISOLATING')
        self.assertEqual(count, 3)
        self.assertEqual(self.isolate()['state'], 'ISOLATED')

    def test_corrupt_private_journal_and_changed_filesystem_never_allow_purge(self):
        result = self.isolate()
        self.now = result['retainUntil']
        journal = self.retirement._folder(self.key)/'RETIREMENT.json'
        before = journal.read_bytes()
        journal.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            self.retirement.purge(ADMIN, self.key)
        journal.chmod(0o600)
        journal.write_text('{broken')
        with self.assertRaisesRegex(ValueError, 'corrupt'):
            self.retirement.purge(ADMIN, self.key)
        journal.write_bytes(before)
        row = D._read_json(journal)
        D._write_json(journal, {**row, 'mountIdentity':['changed']})
        with self.assertRaisesRegex(ValueError, 'corrupt'):
            self.retirement.purge(ADMIN, self.key)
        self.assertTrue(self.retained().exists())

    def test_restore_resumes_post_rename_crash_without_overwriting_new_data(self):
        self.isolate()
        move = self.cache._unregister_move_record
        def crash(source, destination):
            move(source, destination)
            if Path(source).name == 'restore-registration.json':
                raise OSError('crash after restored registration rename')
        with patch.object(self.cache, '_unregister_move_record', side_effect=crash), self.assertRaises(OSError):
            self.retirement.restore(ADMIN, self.key)
        registered = list(self.cache._record_identity('sample', self.version, _read_only=True))
        self.assertEqual(self.retirement.restore(ADMIN, self.key)['state'], 'RESTORED')
        self.assertEqual(list(self.cache._record_identity('sample', self.version)), registered)
        filename = self.cache._paths('sample')['.registry']/(self.version+'.json')
        D._write_json(filename, D._read_json(filename))
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.retirement.restore(ADMIN, self.key)

    def test_restore_and_purge_share_exclusive_durable_operation_lock(self):
        result = self.isolate()
        with self.retirement._lock(self.key):
            for action in (lambda:self.retirement.restore(ADMIN, self.key), lambda:self.retirement.purge(ADMIN, self.key)):
                with self.assertRaises(ValueError):
                    action()
        self.assertEqual(self.retained().read_bytes(), b'fixed complete data')
        self.now = result['retainUntil']
        with self.retirement._lock(self.key), self.assertRaises(ValueError):
            self.retirement.purge(ADMIN, self.key)
        self.assertTrue(self.retained().exists())


if __name__ == '__main__':
    unittest.main()
