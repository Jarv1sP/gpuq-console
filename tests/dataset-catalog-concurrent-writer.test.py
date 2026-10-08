"""Display snapshots do not join a real writer's global durability lock."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('catalog_concurrent_writer',
    Path(__file__).resolve().parents[1] / 'deploy' / 'dataset-cache.py')
D = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(D)
ADMIN, OWNER, OTHER = D.Principal('admin', True), D.Principal('owner'), D.Principal('other')


class CatalogConcurrentWriter(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.base = Path(self.temp.name).resolve()
        source = self.base / 'source'; source.mkdir()
        (source / 'sample.bin').write_bytes(b'actual isolated payload')
        self.cache = D.DatasetCache(self.base / 'cache', sources={'approved': source},
                                    reserve_bytes=0, lock_timeout=.01)
        self.version = self.cache.register_source(ADMIN, 'tiny', 'approved', [OWNER.user_id])['version']
        self.cache.materialize(OWNER, 'tiny', self.version)
        self.paths = self.cache._paths('tiny', self.version)
        self.other = D.DatasetCache(self.cache.root, reserve_bytes=0, lock_timeout=.01)

    def tearDown(self):
        for root, _, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root) / name
                if not path.is_symlink(): path.chmod(0o600)
        self.temp.cleanup()

    def assert_ready(self, result):
        self.assertEqual(result['datasets'][0]['dataset'], 'tiny')
        self.assertEqual(result['datasets'][0]['ownerIds'], [OWNER.user_id])
        row = result['datasets'][0]['versions'][0]
        self.assertEqual((row['version'], row['state'], row['bytes'], row['files']),
                         (self.version, 'READY', len(b'actual isolated payload'), 1))

    def test_cold_and_warm_display_pass_while_real_global_writer_lock_is_held(self):
        with self.other._locked():
            with patch.object(self.cache, '_locked', side_effect=AssertionError('display must not acquire writer lock')):
                first, snapshot = self.cache._list_datasets_snapshot(OWNER)
                self.assert_ready(first)
                self.assertIn(('tiny', self.version), snapshot)
                with patch.object(D, '_manifest_bytes', side_effect=AssertionError('warm display reparsed manifest')), \
                     patch.object(D, '_canonical_json_matches', side_effect=AssertionError('warm display reread READY manifest')):
                    self.assertEqual(self.cache.list_datasets(OWNER), first)
            # The display snapshot cannot skip any strict admission/status lock.
            for call in (lambda: self.cache.status(OWNER, 'tiny', self.version),
                         lambda: self.cache._status_catalog_snapshot(OWNER, 'tiny', self.version, snapshot[('tiny', self.version)]),
                         lambda: self.cache.acquire_lease(OWNER, 'tiny', self.version, 'isolated-job')):
                with self.assertRaises(D.CacheBusy): call()
        self.assertEqual(self.cache._leases('tiny', self.version), [])

    def test_real_writer_lock_never_grants_foreign_catalog_access(self):
        with self.other._locked():
            self.assertEqual(self.cache.list_datasets(OTHER), {'datasets': []})

    def test_acl_revocation_during_summary_read_rejects_under_writer_lock(self):
        self.cache.list_datasets(OWNER)
        read = self.cache._catalog_summary
        def revoke(binding, value=None):
            result = read(binding, value)
            if value is None:
                D._write_json(self.paths['.registry'].parent / 'dataset.json', {'schema': 1, 'owners': [OTHER.user_id]})
            return result
        with self.other._locked(), patch.object(self.cache, '_catalog_summary', side_effect=revoke):
            with self.assertRaises((PermissionError, D.CacheError)): self.cache.list_datasets(OWNER)

    def test_byte_identical_registration_replacement_after_snapshot_rejects(self):
        read = self.cache._catalog_version
        def replace(*args):
            result = read(*args)
            record = self.paths['.registry'].parent / (self.version + '.json')
            D._write_json(record, D._read_json(record))
            return result
        with self.other._locked(), patch.object(self.cache, '_catalog_version', side_effect=replace):
            with self.assertRaises(D.CacheError): self.cache.list_datasets(OWNER)

    def test_registration_inventory_change_is_not_an_absence_proof(self):
        read = self.cache._catalog_version
        def register(*args):
            result = read(*args)
            folder = self.cache.root / '.registry' / 'later'
            D._mkdir(folder); D._write_json(folder / 'dataset.json', {'schema': 1, 'owners': [OWNER.user_id]})
            return result
        with self.other._locked(), patch.object(self.cache, '_catalog_version', side_effect=register):
            with self.assertRaisesRegex(D.CacheError, 'inventory changed'): self.cache.list_datasets(OWNER)

    def test_missing_parent_stays_unknown_without_repair_while_writer_is_active(self):
        self.cache.list_datasets(OWNER)
        parent = self.paths['ready'].parent
        parent.rename(self.base / 'preserved-ready')
        with self.other._locked():
            result, snapshots = self.cache._list_datasets_snapshot(OWNER)
        row = result['datasets'][0]['versions'][0]
        self.assertEqual(row['state'], 'UNKNOWN'); self.assertFalse(row['canPrepare'])
        self.assertEqual(row['errorCode'], 'CACHE_METADATA_INCOMPLETE')
        self.assertNotIn(('tiny', self.version), snapshots)
        self.assertFalse(parent.exists())
        with self.assertRaises(D.CacheMetadataIncomplete): self.cache.status(OWNER, 'tiny', self.version)

    def test_root_replacement_during_display_is_rejected(self):
        self.cache.list_datasets(OWNER)
        read = self.cache._catalog_summary
        def replace(binding, value=None):
            result = read(binding, value)
            if value is None:
                self.cache.root.rename(self.base / 'preserved-root')
                self.cache.root.mkdir(mode=0o700)
            return result
        with self.other._locked(), patch.object(self.cache, '_catalog_summary', side_effect=replace):
            with self.assertRaises((D.CacheError, OSError)): self.cache.list_datasets(OWNER)


if __name__ == '__main__': unittest.main()
