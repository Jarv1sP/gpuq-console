"""Immutable runtimes read current server-authorized membership, never paths."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'deploy'


def load(name):
    spec = importlib.util.spec_from_file_location('live_' + name, HERE / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


c, o = load('oci-cohort'), load('personal-oci')
SHA = 'a' * 64
OLD, NEW = 'demo-user-3', 'demo-user-23'


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'node-config.json'
        self.path.parent.chmod(0o700)
        self.original = {
            'machine': 'test-node', 'root': '/srv/gpuq', 'storageQuota': {'enabled': False},
            'personalOci': {'enabled': True, 'autoOwners': True, 'autoOwnersRevision': 1,
                'owners': [OLD], 'baseImage': 'docker.io/library/ubuntu@sha256:' + SHA,
                'podmanSHA256': SHA, 'runtimeSHA256': SHA, 'cdiSHA256': SHA}}
        self.write(self.original)
        c.sync(self.path, {'hostAdmin': True, 'owners': [OLD], 'revision': 1})
        st = self.path.parent.stat()
        self.fixed = copy.deepcopy(self.original)
        self.fixed['personalOciCohort'] = {'schema': 1, 'configPath': str(self.path),
            'parentDevice': st.st_dev, 'parentInode': st.st_ino, 'minimumRevision': 1}

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, value):
        self.path.write_text(json.dumps(value))
        self.path.chmod(0o600)

    def sync(self, owners, revision):
        return c.sync(self.path, {'hostAdmin': True, 'owners': owners, 'revision': revision})

    def test_new_grant_immediately_works_without_mutating_bundle(self):
        snapshot = copy.deepcopy(self.fixed)
        with self.assertRaisesRegex(ValueError, 'Authenticated owner'):
            o.policy(self.fixed, NEW)
        self.sync([NEW, OLD], 2)
        files_before = {p.name: p.read_bytes() for p in self.path.parent.iterdir()}
        result = o.policy(self.fixed, NEW)
        self.assertEqual(result['owners'], [NEW, OLD])
        self.assertEqual(result['autoOwnersRevision'], 2)
        self.assertEqual(self.fixed, snapshot)
        self.assertEqual(files_before, {p.name: p.read_bytes() for p in self.path.parent.iterdir()})

    def test_revocation_and_zero_owners_never_fall_back_to_frozen_cohort(self):
        self.assertEqual(o.policy(self.fixed, OLD)['owners'], [OLD])
        self.sync([NEW], 2)
        with self.assertRaisesRegex(ValueError, 'Authenticated owner'):
            o.policy(self.fixed, OLD)
        self.sync([], 3)
        for owner in (OLD, NEW, 'builtin-admin'):
            with self.subTest(owner=owner), self.assertRaisesRegex(ValueError, 'Authenticated owner'):
                o.policy(self.fixed, owner)

    def test_revoked_queued_owner_denied_at_real_execute_before_any_container_call(self):
        manager = o.PersonalOCI.__new__(o.PersonalOCI)
        manager.config, manager.user = self.fixed, OLD
        manager.policy = o.policy(self.fixed, OLD)
        self.sync([], 2)
        with patch.object(o.subprocess, 'run', side_effect=AssertionError('no container invocation')):
            with self.assertRaisesRegex(ValueError, 'Authenticated owner'):
                manager.execute({}, {}, False, [], [])

    def test_capability_root_machine_changes_do_not_enter_immutable_runtime(self):
        for key in ('machine', 'root', 'baseImage', 'podmanSHA256', 'runtimeSHA256', 'cdiSHA256', 'extraFlag'):
            current = copy.deepcopy(self.original)
            if key in ('machine', 'root'):
                current[key] = 'different'
            else:
                current['personalOci'][key] = 'different'
            self.write(current)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'mismatch|capability policy'):
                o.policy(self.fixed, OLD)

    def test_unrelated_live_config_not_imported(self):
        current = copy.deepcopy(self.original)
        current.update(database='/attacker/db', conda='/attacker/conda', anything={'unsafe': True})
        self.write(current)
        self.assertEqual(o.policy(self.fixed, OLD), self.original['personalOci'])
        self.assertNotIn('database', self.fixed)

    def test_disabled_or_manual_authority_does_not_grant_frozen_owner(self):
        for change in ({'enabled': False}, {'autoOwners': False}, {'owners': None}, {'owners': ['all']}):
            value = copy.deepcopy(self.original)
            value['personalOci'].update(change)
            self.write(value)
            with self.subTest(change=change), self.assertRaises(ValueError):
                o.policy(self.fixed, OLD)

    def test_malformed_stale_or_unsorted_membership_rejected(self):
        for change in ({'autoOwnersRevision': 0}, {'autoOwnersRevision': True},
                       {'owners': [OLD, OLD]}, {'owners': [OLD, NEW]}):
            value = copy.deepcopy(self.original)
            value['personalOci'].update(change)
            self.write(value)
            with self.subTest(change=change), self.assertRaises(ValueError):
                o.policy(self.fixed, OLD)

    def test_absent_authority_or_lock_rejected_without_repair(self):
        self.path.unlink()
        with self.assertRaises(FileNotFoundError):
            o.policy(self.fixed, OLD)
        self.write(self.original)
        lock = self.path.with_name('.oci-cohort.lock')
        lock.unlink()
        with self.assertRaises(FileNotFoundError):
            o.policy(self.fixed, OLD)
        self.assertFalse(lock.exists())

    def test_busy_authority_fails_without_wait_or_old_grant(self):
        with self.path.with_name('.oci-cohort.lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                o.policy(self.fixed, OLD)

    def test_symlink_hardlink_world_mode_and_parent_identity_rejected(self):
        for kind in ('symlink', 'hardlink', 'mode', 'parent', 'parent-mode'):
            other = self.path.with_name('other')
            if kind == 'symlink':
                self.path.rename(other)
                self.path.symlink_to(other)
            elif kind == 'hardlink':
                os.link(self.path, other)
            elif kind == 'mode':
                self.path.chmod(0o644)
            elif kind == 'parent':
                self.fixed['personalOciCohort']['parentInode'] += 1
            else:
                self.path.parent.chmod(0o777)
            with self.subTest(kind=kind), self.assertRaises((ValueError, OSError)):
                o.policy(self.fixed, OLD)
            if self.path.is_symlink():
                self.path.unlink()
                other.rename(self.path)
            if other.exists():
                other.unlink()
            self.path.chmod(0o600)
            self.path.parent.chmod(0o700)
            self.fixed['personalOciCohort']['parentInode'] = self.path.parent.stat().st_ino

    def test_explicit_null_extra_field_or_client_like_path_rejected(self):
        binding = copy.deepcopy(self.fixed['personalOciCohort'])
        for changed in (None, {**binding, 'owners': [OLD]}, {**binding, 'configPath': '../node-config.json'},
                        {**binding, 'configPath': str(self.path.parent / 'requested.json')},
                        {**binding, 'minimumRevision': True}):
            self.fixed['personalOciCohort'] = changed
            with self.subTest(binding=changed), self.assertRaises(ValueError):
                o.policy(self.fixed, OLD)

    def test_legacy_policy_keeps_existing_behavior_no_authority_io(self):
        with patch.object(c.os, 'open', side_effect=AssertionError('legacy should not read authority')):
            self.assertEqual(o.policy(self.original, OLD), self.original['personalOci'])
            with self.assertRaisesRegex(ValueError, 'Authenticated owner'):
                o.policy(self.original, NEW)


if __name__ == '__main__':
    unittest.main()
