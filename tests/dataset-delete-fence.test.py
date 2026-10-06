"""Persistent version fences stop old and newly arriving writers/read grants."""
import contextlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

D = load('fence_test_cache', 'dataset-cache.py')
R = load('fence_test_retirement', 'dataset-retirement.py')
T = load('fence_test_tier', 'dataset-tier.py')
A = load('fence_test_archive', 'storage-archive.py')
ADMIN, OWNER = D.Principal('administrator', True), D.Principal('owner')

class FenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        source = self.base/'source'
        source.mkdir()
        (source/'file.txt').write_bytes(b'complete bytes')
        self.cache = D.DatasetCache(self.base/'cache', sources={'source':source}, reserve_bytes=0, lock_timeout=.01)
        with self.cache._locked():
            row = self.cache._register(D.Principal('owner', True), 'sample', D._scan(source), ['owner'], 'source',
                                      _origin='upload', _receipt=str(uuid.uuid4()))
        self.version = row['version']
        self.cache.materialize(OWNER, 'sample', self.version)
        self.retirement = R.DatasetRetirement(self.cache, 'fixture-long-machine')
        self.snapshot = self.retirement.inspect(OWNER, 'sample', self.version)
        self.key = str(uuid.uuid4())

    def tearDown(self):
        for root, _, files in os.walk(self.base):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root)/name
                if not path.is_symlink():
                    path.chmod(0o600)

    def fence(self):
        return self.retirement.fence(OWNER, 'sample', self.version, self.key, self.snapshot)

    def test_restart_does_not_drop_fence_and_read_queries_never_lift_it(self):
        self.fence()
        cache = D.DatasetCache(self.cache.root, sources=self.cache.sources, reserve_bytes=0)
        path = cache.root/'.retirements'/'sample'/(self.version+'.json')
        before = path.read_bytes()
        self.assertEqual(cache.status(OWNER, 'sample', self.version)['state'], 'UNKNOWN')
        row = cache.list_datasets(OWNER)['datasets'][0]['versions'][0]
        self.assertTrue(row['deletionBlocked'])
        self.assertFalse(row['canPrepare'])
        self.assertEqual(cache.deletion_permissions(OWNER, 'sample', self.version)['reason'], 'DELETION_ACTIVE')
        self.assertEqual(path.read_bytes(), before)
        with self.assertRaisesRegex(ValueError, '锁定'):
            cache.materialize(OWNER, 'sample', self.version)

    def test_registration_acl_transfer_publish_recovery_lease_and_pin_all_reject_fenced_version(self):
        self.fence()
        manifest = D._scan(self.base/'source')
        actions = [
            lambda:self.cache.register_manifest(ADMIN, 'sample', manifest, ['owner']),
            lambda:self.cache.register_source(ADMIN, 'sample', 'source', ['owner']),
            lambda:self.cache.attach_source(ADMIN, 'sample', self.version, 'source'),
            lambda:self.cache.set_owners(ADMIN, 'sample', ['someone']),
            lambda:self.cache.plan(OWNER, 'sample', self.version),
            lambda:self.cache.prepare_transfer(ADMIN, 'sample', self.version),
            lambda:self.cache.materialize(OWNER, 'sample', self.version),
            lambda:self.cache.acquire_lease(OWNER, 'sample', self.version, 'new-job'),
            lambda:self.cache.pin(ADMIN, 'sample', self.version, 'new-use'),
            lambda:self.cache.evict(ADMIN, 'sample', self.version),
            lambda:self.cache.unregister(ADMIN, 'sample', self.version),
            lambda:self.cache.publish(OWNER, 'sample', self.version, str(uuid.uuid4())),
        ]
        for action in actions:
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, '锁定'):
                action()
        self.assertEqual((self.cache._paths('sample', self.version)['ready']/'data'/'file.txt').read_bytes(), b'complete bytes')

    def test_late_batch_with_old_registration_is_rejected_even_when_inode_matches(self):
        registered = tuple(self.snapshot['registration'])
        self.fence()
        with self.cache._locked(), self.assertRaisesRegex(ValueError, '锁定'):
            self.cache._check_snapshot(OWNER, 'sample', self.version, registered)
        archive = object.__new__(A.StorageArchive)
        archive.cache, archive.admin = self.cache, ADMIN
        with self.assertRaisesRegex(ValueError, '锁定'):
            archive._single('owner', {'dataset':'sample', 'version':self.version})

    def test_old_scopes_wrong_role_and_wrong_uuid_do_not_leak_an_override(self):
        self.fence()
        for actor, key, snapshot in ((ADMIN,self.key,self.snapshot),
                (OWNER,str(uuid.uuid4()),self.snapshot), (OWNER,self.key,{**self.snapshot,'complete':False})):
            with self.subTest(actor=actor,key=key), self.assertRaises(ValueError):
                with self.cache._retirement_scope(actor, key, 'sample', self.version, R.sha(snapshot)):
                    self.cache._record(OWNER, 'sample', self.version)
        with self.cache._retirement_scope(OWNER, self.key, 'sample', self.version, R.sha(self.snapshot)):
            self.assertEqual(self.cache._record(OWNER, 'sample', self.version)['manifest'], D._scan(self.base/'source'))
        with self.assertRaises(ValueError):
            self.cache._record(OWNER, 'sample', self.version)

    def test_new_lease_during_preflight_prevents_fence_and_every_move(self):
        inspect = self.retirement.inspect
        def race(*args):
            snapshot = inspect(*args)
            self.cache.acquire_lease(OWNER, 'sample', self.version, 'racing-job')
            return snapshot
        with patch.object(self.retirement, 'inspect', side_effect=race), self.assertRaisesRegex(ValueError, 'use changed'):
            self.fence()
        self.assertIsNone(self.cache._retirement_fence('sample', self.version))
        self.assertEqual(len(self.cache._leases('sample', self.version)), 1)

    def test_fence_survives_failed_worker_drain_and_blocks_future_writers(self):
        inspect = self.retirement.inspect
        with contextlib.ExitStack() as held:
            def race(*args):
                snapshot = inspect(*args)
                held.enter_context(self.cache._lock_file('.locks/sample.'+self.version+'.lock'))
                return snapshot
            with patch.object(self.retirement, 'inspect', side_effect=race), self.assertRaises(ValueError):
                self.fence()
            self.assertEqual(self.cache._retirement_fence('sample', self.version)['state'], 'FENCED')
            with self.assertRaisesRegex(ValueError, '锁定'):
                self.cache.acquire_lease(OWNER, 'sample', self.version, 'late-job')
        self.assertTrue(self.fence()['drained'])

    def test_protected_source_guard_cannot_allow_an_old_recovery_after_fence(self):
        local = T.LocalAuthority(self.cache)
        proof = local.seal(ADMIN, 'sample', self.version, 'authority-old-use')
        self.snapshot = self.retirement.inspect(OWNER, 'sample', self.version)
        self.fence()
        with self.assertRaisesRegex(ValueError, '锁定'):
            with local.guard(ADMIN, proof):
                self.fail('old original must not be readable through its grant')
        with self.assertRaises(ValueError):
            local.seal(ADMIN, 'sample', self.version, 'authority-new-use')

    def test_isolation_tombstone_survives_registry_removal_and_admin_restore_starts_new_generation(self):
        self.retirement.isolate(OWNER, 'sample', self.version, self.key, self.snapshot)
        with self.assertRaisesRegex(ValueError, '锁定'):
            self.cache.register_source(ADMIN, 'sample', 'source', ['owner'])
        result = self.retirement.restore(ADMIN, self.key)
        self.assertEqual(result['fenceState'], 'RESTORED')
        self.assertTrue(self.cache.acquire_lease(OWNER, 'sample', self.version, 'restored-job')['leaseId'])
        with self.assertRaises(ValueError):
            self.retirement.isolate(OWNER, 'sample', self.version, self.key, self.snapshot)

    def test_corrupt_fence_or_wrong_root_is_never_interpreted_as_open(self):
        self.fence()
        path = self.cache.root/'.retirements'/'sample'/(self.version+'.json')
        row = D._read_json(path)
        for change in ({'rootIdentity':[0,0]}, {'state':'RESTORED'}, {'snapshotSha256':'bad'}):
            D._write_json(path, {**row, **change})
            with self.assertRaises(ValueError):
                self.cache.plan(OWNER, 'sample', self.version)
        path.write_text('{broken')
        with self.assertRaises(ValueError):
            self.cache.plan(OWNER, 'sample', self.version)

    def test_private_override_flags_cannot_arrive_via_dispatch(self):
        self.fence()
        for field in ('_read_only', '_retirement_scope', 'is_admin', 'operationId', 'retentionDays'):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.cache.dispatch(OWNER, {'op':'plan', 'dataset':'sample', 'version':self.version, field:True})

if __name__ == '__main__':
    unittest.main()
