"""Local fixtures: READY needs no staging; damaged layouts stay fail-closed."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'dataset_optional_dirs', Path(__file__).resolve().parents[1] / 'deploy' / 'dataset-cache.py')
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
ADMIN, OWNER, OTHER = D.Principal('admin', True), D.Principal('owner'), D.Principal('other')


class OptionalDatasetDirectories(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'source'
        self.source.mkdir()
        (self.source / 'sample.txt').write_bytes(b'local-only sample')
        self.cache = D.DatasetCache(self.base / 'cache', sources={'approved': self.source}, reserve_bytes=0)
        self.version = self.cache.register_source(ADMIN, 'sample', 'approved', ['owner'])['version']
        self.paths = self.cache._paths('sample', self.version)

    def tearDown(self):
        for root, dirs, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                p = Path(root) / name
                if not p.is_symlink():
                    p.chmod(0o600)
        self.temp.cleanup()

    def status(self):
        return self.cache.status(OWNER, 'sample', self.version)

    def listing(self):
        return self.cache.list_datasets(OWNER)['datasets'][0]['versions'][0]

    def assert_incomplete_listing(self):
        row = self.listing()
        self.assertEqual(row['version'], self.version)
        self.assertEqual(row['state'], 'UNKNOWN')
        self.assertIs(row['canPrepare'], False)
        self.assertIs(row['deletionBlocked'], True)
        self.assertEqual(row['errorCode'], 'CACHE_METADATA_INCOMPLETE')
        self.assertEqual(row['error'], '数据缓存元数据不完整；请管理员核验。')
        self.assertNotIn(str(self.base), str(row))

    def publish(self):
        self.assertEqual(self.cache.materialize(OWNER, 'sample', self.version)['state'], 'READY')

    def test_ready_does_not_require_an_empty_staging_parent(self):
        self.publish()
        self.assertEqual(self.listing()['state'], 'READY')  # Also test a warm catalog.
        staging = self.paths['.staging'].parent
        staging.rmdir()
        for operation in (self.status, self.listing):
            with self.subTest(operation=operation.__name__):
                self.assertEqual(operation()['state'], 'READY')
                self.assertFalse(staging.exists())
        self.assertEqual(self.status()['remainingBytes'], 0)

    def test_missing_registered_parents_is_an_explicit_layout_error(self):
        parents = [self.paths[k].parent for k in ('ready', '.staging')]
        for parent in parents:
            parent.rmdir()
        with self.assertRaisesRegex(D.CacheMetadataIncomplete, 'storage metadata is incomplete'):
            self.status()
        self.assert_incomplete_listing()
        self.assertTrue(all(not p.exists() for p in parents))
        with self.assertRaisesRegex(D.CacheError, 'storage metadata is incomplete'):
            self.cache._ready(self.paths, {}, self.version)

    def test_nonready_missing_staging_parent_is_not_hidden(self):
        self.paths['.staging'].parent.rmdir()
        with self.assertRaisesRegex(D.CacheMetadataIncomplete, 'storage metadata is incomplete'):
            self.status()
        self.assert_incomplete_listing()
        self.assertFalse(self.paths['.staging'].parent.exists())

    def test_actual_incomplete_publication_is_still_rejected(self):
        self.paths['ready'].mkdir()
        for operation in (self.status, self.listing):
            with self.subTest(operation=operation.__name__), self.assertRaisesRegex(D.CacheError, 'READY'):
                operation()

    def test_parent_symlinks_are_not_treated_as_absent(self):
        for key in ('ready', '.staging'):
            parent = self.paths[key].parent
            parent.rmdir()
            outside = self.base / ('outside-' + key.strip('.'))
            outside.mkdir()
            parent.symlink_to(outside, target_is_directory=True)
            for operation in (self.status, self.listing):
                with self.subTest(key=key, operation=operation.__name__), self.assertRaises(OSError):
                    operation()
            parent.unlink()
            parent.mkdir(mode=0o700)

    def test_missing_required_cache_area_is_still_rejected(self):
        for key in ('ready', '.staging'):
            parent = self.paths[key].parent
            parent.rmdir()
            area = parent.parent
            area.rmdir()
            with self.subTest(key=key), self.assertRaisesRegex(D.CacheError, 'storage metadata is incomplete'):
                self.status()
            area.mkdir(mode=0o700)
            parent.mkdir(mode=0o700)

    def test_staging_transfer_keeps_remaining_bytes_and_state(self):
        plan = self.cache.plan(OWNER, 'sample', self.version)
        self.cache.put_chunk(OWNER, 'sample', self.version, 'sample.txt', 0, b'local', plan['token'])
        self.assertEqual(self.status()['state'], 'STAGING')
        self.assertEqual(self.status()['remainingBytes'], len(b'local-only sample') - 5)
        self.assertEqual(self.listing()['state'], 'STAGING')

    def test_missing_optional_paths_do_not_bypass_owner_or_registration_checks(self):
        for key in ('ready', '.staging'):
            self.paths[key].parent.rmdir()
        self.assertEqual(self.cache.list_datasets(OTHER), {'datasets': []})
        with self.assertRaises(PermissionError):
            self.cache.status(OTHER, 'sample', self.version)
        with self.assertRaisesRegex(FileNotFoundError, 'registration or version does not exist or was removed'):
            self.cache.status(OWNER, 'sample', 'a' * 64)

    def test_unregistered_version_explains_removal_without_raw_os_path(self):
        self.cache.unregister(ADMIN, 'sample', self.version)
        with self.assertRaisesRegex(FileNotFoundError, 'refresh the dataset list') as error:
            self.status()
        self.assertNotIn('Errno', str(error.exception))
        self.assertNotIn(str(self.base), str(error.exception))

    def test_unregistered_dataset_explains_removal_without_recreating_it(self):
        self.cache.unregister(ADMIN, 'sample')
        self.assertEqual(self.cache.list_datasets(OWNER), {'datasets': []})
        with self.assertRaisesRegex(FileNotFoundError, 'registration or version does not exist or was removed'):
            self.status()
        self.assertFalse(self.paths['.registry'].parent.exists())


if __name__ == '__main__':
    unittest.main()
