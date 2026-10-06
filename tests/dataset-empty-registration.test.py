"""Real cache/worker empty-shell removal; no GPU, SSH or systemd writes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('empty_shell_node_fixture', ROOT/'tests/node-datasets.test.py')
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)


class EmptyRegistrationTests(unittest.TestCase):
    def setUp(self):
        F.NodeDatasets.setUp(self)
        for name in ('dataset-retirement.py', 'dataset-retirement-node.py', 'dataset-rebuild-proof.py',
                     'dataset-tier.py', 'storage-node.py', 'storage-authority.py'):
            shutil.copy2(ROOT/'deploy'/name, self.base/name)
        self.node.CONFIG['machine'] = 'node-a'
        self.dataset = 'u-'+hashlib.sha256(self.user.user_id.encode()).hexdigest()[:16]+'-discarded'
        registry = self.cache._paths(self.dataset)['.registry']
        self.module._mkdir(registry)
        self.module._write_json(registry/'dataset.json', dict(schema=1, owners=[self.user.user_id]))
        self.orphan = 'f'*64
        with self.cache._locked():
            self.cache._write_tier(self.dataset, self.orphan, self.cache._default_tier())
        self.tier = self.cache.root/'.tiers'/self.dataset/(self.orphan+'.json')
        self.starts = []
        p = patch.object(self.node, 'run', side_effect=lambda argv, **kw: self.starts.append(argv))
        p.start(); self.addCleanup(p.stop)
        p = patch.object(self.node, 'dataset_background_active', return_value=False)
        p.start(); self.addCleanup(p.stop)

    tearDown = F.NodeDatasets.tearDown

    def request(self, **extra):
        return self.node.dataset_op('datasets.unregister', dict(userId='builtin-admin', hostAdmin=True,
            dataset=self.dataset, protocol='dataset-delete-node-v1',
            portalProvedOtherCopy=dict(protocol='dataset-portal-copy-proof-v1', versions=[]), **extra))

    def assert_kept(self):
        self.assertTrue((self.cache._paths(self.dataset)['.registry']/'dataset.json').is_file())
        self.assertEqual(self.starts, [])

    def reserved_session(self, owner='demo-user-99', name='unrelated', *, sealed=False, state='UPLOADING'):
        upload = str(uuid.uuid4())
        parent = self.cache.root/'.uploads'/hashlib.sha256(owner.encode()).hexdigest()/upload
        self.module._mkdir(parent.parent.parent); self.module._mkdir(parent.parent); self.module._mkdir(parent)
        session = dict(schema=1, userId=owner, uploadId=upload, name=name, state=state,
                       manifestBytes=100, manifestSha256='a'*64, totalBytes=700, entries=2,
                       reserveBytes=700+100*4+2*8192+65536)
        path = parent/'session.json'; self.module._write_json(path, session)
        key = hashlib.sha256(json.dumps([owner, upload], separators=(',', ':')).encode()).hexdigest()+'.json'
        reservation = self.cache.root/'.upload-reservations'/key
        value = dict(bytes=session['reserveBytes']-(session['totalBytes'] if sealed else 0), inodes=18)
        self.module._write_json(reservation, value)
        return path, session, reservation, value

    def proof(self):
        with self.cache._locked(): return self.cache._empty_unregister_snapshot(self.admin, self.dataset)

    def test_trusted_same_and_foreign_owner_reservations_are_preserved(self):
        rows = [self.reserved_session(self.user.user_id, sealed=False),
                self.reserved_session('demo-user-99', sealed=True)]
        before = [(path.read_bytes(), path.stat(), reserve.read_bytes(), reserve.stat())
                  for path, session, reserve, value in rows]
        result = self.request(); self.assertEqual(self.node.dataset_worker(result['operationId']), 0)
        for row, expected in zip(rows, before):
            path, session, reserve, value = row
            self.assertEqual((path.read_bytes(), path.stat(), reserve.read_bytes(), reserve.stat()), expected)
        self.assertEqual(self.module._read_json(self.tier), self.cache._default_tier())

    def test_target_reservation_is_not_safe_even_with_discarded_receipt(self):
        path, session, reserve, value = self.reserved_session(self.user.user_id, 'discarded', state='DISCARDED')
        with self.assertRaisesRegex(ValueError, 'reservation prevents'): self.request()
        self.assert_kept(); self.assertEqual(self.module._read_json(reserve), value)

    def test_reservation_reverse_identity_and_budget_refuse_unknown(self):
        changes = [dict(schema=True), dict(userId='unknown'), dict(uploadId=str(uuid.uuid4())),
                   dict(name='../other'), dict(state='UNKNOWN'), dict(manifestBytes=0),
                   dict(manifestBytes=self.module.MAX_JSON_BYTES+1), dict(manifestSha256='bad'),
                   dict(totalBytes=-1), dict(entries=self.module.MAX_ENTRIES+1), dict(entries=True),
                   dict(reserveBytes=1), dict(dataset='unrelated'), dict(version='bad'),
                   dict(archiveAdmission={})]
        path, session, reserve, value = self.reserved_session()
        for change in changes:
            with self.subTest(change=change):
                self.module._write_json(path, {**session, **change})
                with self.assertRaises(ValueError): self.request()
                self.assert_kept(); self.assertEqual(self.module._read_json(reserve), value)
        self.module._write_json(path, session)
        for changed in ({'bytes': value['bytes']}, {**value, 'inodes': 17}, {**value, 'bytes': True},
                        {**value, 'bytes': 2**63}, {**value, 'unexpected': 1}):
            with self.subTest(reservation=changed):
                self.module._write_json(reserve, changed)
                with self.assertRaisesRegex(ValueError, 'budget'): self.request()
                self.assert_kept()

    def test_orphan_moved_missing_and_unsafe_reservation_metadata_refuse(self):
        path, session, reserve, value = self.reserved_session()
        original = reserve.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'missing'): self.request()
        self.assert_kept()
        self.module._write_json(path, session)
        wrong = reserve.with_name('e'*64+'.json'); reserve.rename(wrong)
        with self.assertRaisesRegex(ValueError, 'unconfirmed upload reservations'): self.request()
        wrong.rename(reserve)
        linked = reserve.with_name('link'); os.link(reserve, linked)
        with self.assertRaises((ValueError, OSError)): self.request()
        linked.unlink()
        os.chmod(reserve, 0o644)
        with self.assertRaisesRegex(ValueError, 'unsafe'): self.request()
        os.chmod(reserve, 0o600)
        reserve.unlink(); reserve.symlink_to(path)
        with self.assertRaises(OSError): self.request()
        reserve.unlink(); reserve.write_bytes(original); os.chmod(reserve, 0o600)
        temp = reserve.with_name('.write-'+'f'*32); temp.write_text('{}'); os.chmod(temp, 0o600)
        with self.assertRaisesRegex(ValueError, 'unconfirmed upload reservations'): self.request()
        self.assert_kept()

    def test_reverse_scan_rejects_duplicate_and_changed_directory_membership(self):
        path, session, reserve, value = self.reserved_session()
        parent_inode = path.parent.parent.stat().st_ino
        original = os.listdir
        def duplicate(fd):
            rows = original(fd)
            return rows+rows if isinstance(fd, int) and os.fstat(fd).st_ino == parent_inode else rows
        with patch.object(self.module.os, 'listdir', side_effect=duplicate), self.assertRaisesRegex(ValueError, 'duplicate'):
            self.request()
        changed = False
        def late_member(fd):
            nonlocal changed
            rows = original(fd)
            if isinstance(fd, int) and os.fstat(fd).st_ino == parent_inode and not changed:
                changed = True
                self.module._mkdir(path.parent.parent/str(uuid.uuid4()))
            return rows
        with patch.object(self.module.os, 'listdir', side_effect=late_member), self.assertRaisesRegex(ValueError, 'unconfirmed upload reservations'):
            self.request()
        self.assert_kept()

    def test_late_target_or_orphan_reservation_rejects_final_move(self):
        expected = self.proof()
        def late_dependency(transaction): self.reserved_session(self.user.user_id, 'discarded')
        with patch.object(self.cache, '_unregister_cleanup', side_effect=late_dependency), self.assertRaisesRegex(ValueError, 'reservation prevents'):
            self.cache.unregister(self.admin, self.dataset, _portal_proved_versions=[], _expected_empty_registration=expected)
        self.assertTrue(self.cache._paths(self.dataset)['.registry'].exists())

    def test_late_orphan_reservation_before_worker_refuses_without_replaying(self):
        result = self.request()
        path = self.cache.root/'.upload-reservations'/('e'*64+'.json')
        self.module._write_json(path, dict(bytes=1, inodes=16))
        self.assertEqual(self.node.dataset_worker(result['operationId']), 1)
        self.assertTrue(self.cache._paths(self.dataset)['.registry'].exists())
        self.assertEqual(self.module._read_json(path), dict(bytes=1, inodes=16))
        self.assertEqual(len(self.starts), 1)

    def test_private_session_parent_hash_links_and_scan_budget_refuse(self):
        path, session, reserve, value = self.reserved_session()
        parent = path.parent.parent; wrong = parent.with_name('e'*64)
        parent.rename(wrong)
        with self.assertRaisesRegex(ValueError, 'ownership'): self.request()
        wrong.rename(parent)
        outside = self.base/'outside-upload-session.json'; outside.write_bytes(path.read_bytes())
        path.unlink(); path.symlink_to(outside)
        with self.assertRaises(OSError): self.request()
        path.unlink(); self.module._write_json(path, session)
        linked = path.with_name('extra'); os.link(path, linked)
        with self.assertRaises((ValueError, OSError)): self.request()
        linked.unlink()
        inode = parent.stat().st_ino; original = os.listdir
        def over_budget(fd):
            return ['f'*64]*10001 if isinstance(fd, int) and os.fstat(fd).st_ino == inode else original(fd)
        with patch.object(self.module.os, 'listdir', side_effect=over_budget), self.assertRaisesRegex(ValueError, 'entry budget'):
            self.request()
        self.assert_kept(); self.assertEqual(self.module._read_json(reserve), value)

    def test_archive_reservation_uses_upload_load_identity_without_side_effects(self):
        path, session, reserve, value = self.reserved_session()
        lane = dict(schema=1, transferId=session['uploadId'], targetMachine='node-a', authority='node-b',
                    sourceMachine='node-b', reference=dict(kind='datasets', dataset='original-data', version='f'*64))
        session['archiveAdmission'] = lane; self.module._write_json(path, session)
        loaded = self.node.dataset_uploads().load(session['userId'], session['uploadId'])
        self.assertEqual(loaded, session)
        before = path.read_bytes(), reserve.read_bytes()
        self.proof(); self.assertEqual((path.read_bytes(), reserve.read_bytes()), before)
        for change in (dict(schema=True), dict(transferId=str(uuid.uuid4())), dict(sourceMachine='node-a'),
                       dict(reference=dict(kind='projects', dataset='original-data', version='f'*64))):
            session['archiveAdmission'] = {**lane, **change}; self.module._write_json(path, session)
            with self.assertRaisesRegex(ValueError, 'archive identity'): self.request()
            self.assert_kept()

    def test_unrelated_progress_is_reproved_not_frozen_as_static_metadata(self):
        path, session, reserve, value = self.reserved_session()
        expected = self.proof()
        self.assertFalse(any(item[0].startswith('.uploads/') or item[0].startswith('.upload-reservations/') for item in expected['dependencies']))
        def progress(transaction): self.module._write_json(path, {**session, 'state': 'PUBLISHING', 'updatedAt': 500})
        with patch.object(self.cache, '_unregister_cleanup', side_effect=progress):
            result = self.cache.unregister(self.admin, self.dataset, _portal_proved_versions=[], _expected_empty_registration=expected)
        self.assertTrue(result['unregistered']); self.assertEqual(self.module._read_json(reserve), value)

    def test_normal_worker_moves_only_registry_retains_default_tier_and_queries_original_receipt(self):
        before = self.tier.read_bytes(), self.tier.stat()
        result = self.request(version=None)
        self.assertEqual(result['state'], 'UNREGISTERING')
        self.assertEqual(self.node.dataset_worker(result['operationId']), 0)
        receipt = self.node.dataset_op('datasets.status', dict(userId='builtin-admin', hostAdmin=True, operationId=result['operationId']))
        self.assertEqual(receipt['state'], 'UNREGISTERED')
        self.assertTrue(receipt['unregistered'])
        self.assertEqual(receipt['versions'], [])
        self.assertFalse(self.cache._paths(self.dataset)['.registry'].exists())
        self.assertEqual(self.tier.read_bytes(), before[0])
        self.assertEqual(self.tier.stat(), before[1])
        journal = self.module._read_json(self.cache.root/'.trash'/receipt['recoveryId']/'REMOVAL.json')
        self.assertEqual(journal['emptyRegistrationProof']['owners'], [self.user.user_id])
        self.assertTrue(any(row[0].startswith('.tiers/') for row in journal['emptyRegistrationProof']['dependencies']))
        self.assertEqual(journal['versions'], [])

    def test_members_single_versions_forged_fields_and_old_capability_never_dispatch(self):
        base = dict(userId='builtin-admin', hostAdmin=True, dataset=self.dataset,
                    protocol='dataset-delete-node-v1', portalProvedOtherCopy=dict(protocol='dataset-portal-copy-proof-v1', versions=[]))
        for change in (dict(hostAdmin=False, userId=self.user.user_id), dict(version=self.orphan),
                       dict(emptyRegistrationSnapshot={}), dict(force=True)):
            with self.subTest(change=change), self.assertRaises((ValueError, PermissionError)):
                self.node.dataset_op('datasets.unregister', {**base, **change})
            self.assert_kept()
        (self.base/'dataset-retirement-node.py').unlink()
        with self.assertRaisesRegex(ValueError, 'protocol'):
            self.request()
        self.assert_kept()

    def test_new_version_before_worker_is_not_covered_by_empty_proof(self):
        result = self.request()
        record = self.cache.register_source(self.admin, self.dataset, 'approved', [self.user.user_id])
        self.assertEqual(self.node.dataset_worker(result['operationId']), 1)
        self.assertEqual(self.cache.status(self.user, self.dataset, record['version'])['state'], 'REGISTERED')
        self.assertTrue(self.cache._paths(self.dataset)['.registry'].exists())

    def test_ownership_change_before_worker_refuses_without_moving_new_registration(self):
        result = self.request()
        self.module._write_json(self.cache._paths(self.dataset)['.registry']/'dataset.json', dict(schema=1, owners=['demo-user-2']))
        self.assertEqual(self.node.dataset_worker(result['operationId']), 1)
        self.assertTrue(self.cache._paths(self.dataset)['.registry'].exists())

    def test_each_payload_provenance_fence_and_reopen_area_refuses_before_dispatch(self):
        for area in ('ready', '.staging', '.leases', '.provenance', '.retirements', '.reopens'):
            with self.subTest(area=area):
                parent = self.cache.root/area/self.dataset
                self.module._mkdir(parent)
                entry = parent/self.orphan if area in ('ready', '.staging', '.leases') else parent/(self.orphan+'.json')
                if area in ('ready', '.staging', '.leases'): self.module._mkdir(entry)
                else: self.module._write_json(entry, {'preserve': True})
                with self.assertRaises(ValueError): self.request()
                self.assert_kept()
                if entry.is_dir(): entry.rmdir()
                else: entry.unlink()

    def test_any_nondefault_or_unsafe_orphan_tier_is_preserved_and_refused(self):
        for update in (dict(pins={'authority-x': {'owner': self.user.user_id, 'createdAt': 1}}),
                       dict(recovery={}), dict(role='cache'), dict(lastUsedAt=1), dict(schema=True)):
            with self.subTest(update=update):
                self.module._write_json(self.tier, {**self.cache._default_tier(), **update})
                before = self.tier.read_bytes()
                with self.assertRaises(ValueError): self.request()
                self.assert_kept(); self.assertEqual(self.tier.read_bytes(), before)
        self.module._write_json(self.tier, self.cache._default_tier())
        linked = self.tier.with_suffix('.hardlink'); os.link(self.tier, linked)
        with self.assertRaises(ValueError): self.request()
        self.assert_kept(); linked.unlink()

    def test_upload_history_requires_discarded_no_reservation_or_binding(self):
        upload = str(uuid.uuid4())
        owner = self.user.user_id
        parent = self.cache.root/'.uploads'/hashlib.sha256(owner.encode()).hexdigest()/upload
        self.module._mkdir(parent.parent.parent); self.module._mkdir(parent.parent); self.module._mkdir(parent)
        session = dict(schema=1, userId=owner, uploadId=upload, name='discarded', dataset=self.dataset,
                       version=self.orphan, state='UPLOADING')
        self.module._write_json(parent/'session.json', session)
        with self.assertRaisesRegex(ValueError, 'unfinished'): self.request()
        self.assert_kept()
        session['state'] = 'DISCARDED'; self.module._write_json(parent/'session.json', session)
        reservation = self.cache.root/'.upload-reservations'/('a'*64+'.json')
        self.module._write_json(reservation, dict(bytes=1, inodes=1))
        with self.assertRaisesRegex(ValueError, 'reservations'): self.request()
        self.assert_kept(); reservation.unlink()
        bindings = parent.parent.parent/'bindings'; self.module._mkdir(bindings)
        binding = bindings/(hashlib.sha256((self.dataset+'@'+self.orphan).encode()).hexdigest()+'.json')
        self.module._write_json(binding, dict(userId=owner, uploadId=upload))
        with self.assertRaisesRegex(ValueError, 'binding'): self.request()
        self.assert_kept(); binding.unlink()
        result = self.request()
        self.assertEqual(self.node.dataset_worker(result['operationId']), 0)
        self.assertEqual(self.module._read_json(parent/'session.json'), session)

    def test_late_tier_dependency_during_cleanup_rejects_final_registry_move(self):
        with self.cache._locked(): expected = self.cache._empty_unregister_snapshot(self.admin, self.dataset)
        def late_dependency(transaction):
            self.module._write_json(self.tier, {**self.cache._default_tier(), 'recovery': {'preserve': True}})
        with patch.object(self.cache, '_unregister_cleanup', side_effect=late_dependency), self.assertRaises(ValueError):
            self.cache.unregister(self.admin, self.dataset, _portal_proved_versions=[], _expected_empty_registration=expected)
        self.assertTrue(self.cache._paths(self.dataset)['.registry'].exists())

    def test_orphan_or_missing_version_binding_refuses_without_mutating_it(self):
        uploads = self.cache.root/'.uploads'; bindings = uploads/'bindings'
        self.module._mkdir(uploads); self.module._mkdir(bindings)
        upload = str(uuid.uuid4()); owner = self.user.user_id
        path = bindings/(hashlib.sha256((self.dataset+'@'+self.orphan).encode()).hexdigest()+'.json')
        self.module._write_json(path, dict(userId=owner, uploadId=upload))
        original = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'session or version'): self.request()
        self.assert_kept(); self.assertEqual(path.read_bytes(), original)
        parent = uploads/hashlib.sha256(owner.encode()).hexdigest()/upload
        self.module._mkdir(parent.parent); self.module._mkdir(parent)
        self.module._write_json(parent/'session.json', dict(schema=1, userId=owner, uploadId=upload,
            name='discarded', dataset=self.dataset, state='DISCARDED'))
        with self.assertRaisesRegex(ValueError, 'session or version'): self.request()
        self.assert_kept(); self.assertEqual(path.read_bytes(), original)

    def test_malformed_or_binding_namespace_mismatch_is_not_an_absence_proof(self):
        uploads = self.cache.root/'.uploads'; bindings = uploads/'bindings'
        self.module._mkdir(uploads); self.module._mkdir(bindings)
        path = bindings/('e'*64+'.json')
        for value in ({}, {'userId': self.user.user_id, 'uploadId': 'unknown'},
                      {'userId': 'other', 'uploadId': str(uuid.uuid4())}):
            self.module._write_json(path, value)
            with self.assertRaises(ValueError): self.request()
            self.assert_kept(); self.assertEqual(self.module._read_json(path), value)
        upload = str(uuid.uuid4()); owner = self.user.user_id
        parent = uploads/hashlib.sha256(owner.encode()).hexdigest()/upload
        self.module._mkdir(parent.parent); self.module._mkdir(parent)
        self.module._write_json(parent/'session.json', dict(schema=1, userId=owner, uploadId=upload,
            name='unrelated', state='DISCARDED', version=self.orphan))
        self.module._write_json(path, dict(userId=owner, uploadId=upload))
        with self.assertRaisesRegex(ValueError, 'namespace'): self.request()
        self.assert_kept()

    def test_confirmed_foreign_owner_binding_is_retained_not_deleted(self):
        uploads = self.cache.root/'.uploads'; bindings = uploads/'bindings'
        self.module._mkdir(uploads); self.module._mkdir(bindings)
        owner = 'demo-user-99'; upload = str(uuid.uuid4())
        target = 'u-'+hashlib.sha256(owner.encode()).hexdigest()[:16]+'-unrelated'
        path = bindings/(hashlib.sha256((target+'@'+self.orphan).encode()).hexdigest()+'.json')
        self.module._write_json(path, dict(userId=owner, uploadId=upload))
        with self.assertRaisesRegex(ValueError, 'session or version'): self.request()
        self.assert_kept()
        parent = uploads/hashlib.sha256(owner.encode()).hexdigest()/upload
        self.module._mkdir(parent.parent); self.module._mkdir(parent)
        self.module._write_json(parent/'session.json', dict(schema=1, userId=owner, uploadId=upload,
            name='unrelated', dataset=target, version=self.orphan, state='READY'))
        before = path.read_bytes(), path.stat()
        result = self.request(); self.assertEqual(self.node.dataset_worker(result['operationId']), 0)
        self.assertEqual(path.read_bytes(), before[0]); self.assertEqual(path.stat(), before[1])

    def test_binding_appearing_after_admission_refuses_final_move(self):
        uploads = self.cache.root/'.uploads'; bindings = uploads/'bindings'
        self.module._mkdir(uploads); self.module._mkdir(bindings)
        with self.cache._locked(): expected = self.cache._empty_unregister_snapshot(self.admin, self.dataset)
        path = bindings/(hashlib.sha256((self.dataset+'@'+self.orphan).encode()).hexdigest()+'.json')
        def late_binding(transaction):
            self.module._write_json(path, dict(userId=self.user.user_id, uploadId=str(uuid.uuid4())))
        with patch.object(self.cache, '_unregister_cleanup', side_effect=late_binding), self.assertRaises(ValueError):
            self.cache.unregister(self.admin, self.dataset, _portal_proved_versions=[], _expected_empty_registration=expected)
        self.assertTrue(self.cache._paths(self.dataset)['.registry'].exists()); self.assertTrue(path.exists())

    def test_empty_proof_never_removes_a_registered_version_or_accepts_a_raw_client_assertion(self):
        for expected in (None, {}, dict(registry=[], owners=[self.user.user_id], dependencies=[])):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                self.cache.unregister(self.admin, self.dataset, _portal_proved_versions=[], _expected_empty_registration=expected)
            self.assert_kept()

    def test_unsafe_registry_or_dependency_symlinks_reject_without_following(self):
        original = self.cache._paths(self.dataset)['.registry']/'dataset.json'
        old = original.read_bytes(); original.unlink()
        outside = self.base/'outside-owner.json'; outside.write_bytes(old); original.symlink_to(outside)
        with self.assertRaises(OSError): self.request()
        self.assertEqual(outside.read_bytes(), old); self.assertEqual(self.starts, [])
        original.unlink(); self.module._write_json(original, dict(schema=1, owners=[self.user.user_id]))
        dependency = self.cache.root/'.provenance'/self.dataset
        outside_dir = self.base/'outside-dependency'; outside_dir.mkdir()
        dependency.symlink_to(outside_dir)
        with self.assertRaises((ValueError, OSError)): self.request()
        self.assertEqual(list(outside_dir.iterdir()), []); self.assert_kept(); dependency.unlink()

    def test_launch_lost_ack_keeps_fixed_worker_intent_and_original_status_until_confirmed(self):
        with patch.object(self.node, 'run', side_effect=subprocess.TimeoutExpired('systemd-run', 8)):
            with self.assertRaises(subprocess.TimeoutExpired): self.request()
        tasks = list((self.node.ROOT/'dataset-ops').glob('*.json'))
        self.assertEqual(len(tasks), 1)
        key = tasks[0].stem
        status = self.node.dataset_op('datasets.status', dict(userId='builtin-admin', hostAdmin=True, operationId=key))
        self.assertEqual(status['state'], 'UNKNOWN')
        self.assertEqual(self.node.dataset_worker(key), 0)
        status = self.node.dataset_op('datasets.status', dict(userId='builtin-admin', hostAdmin=True, operationId=key))
        self.assertEqual(status['state'], 'UNREGISTERED')
        self.assertEqual(status['operationId'], key)
        self.assertEqual(set((self.node.ROOT/'dataset-ops').glob('*.json')), {tasks[0], tasks[0].with_suffix('.result.json')})


if __name__ == '__main__': unittest.main()
