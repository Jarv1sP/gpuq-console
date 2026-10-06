"""No cross-request cache: canonical READY comparison and live snapshot guards."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from dataset_retention_helpers import protected_original

SPEC = importlib.util.spec_from_file_location('dataset_catalog_performance',
    Path(__file__).resolve().parents[1] / 'deploy' / 'dataset-cache.py')
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
ADMIN, OWNER, OTHER = D.Principal('admin', True), D.Principal('owner'), D.Principal('other')


class DatasetCatalogPerformance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.cache = D.DatasetCache(self.base / 'cache', reserve_bytes=0)
        self.manifest = dict(schema=1, directories=['资料', '资料/深'], files=[
            dict(path=f'资料/深/样本-{n:05d}.bin', size=9, sha256=hashlib.sha256(b'123456789').hexdigest())
            for n in range(2000)])
        self.version = self.cache.register_manifest(ADMIN, 'large', self.manifest, [OWNER.user_id])['version']
        self.paths = self.cache._paths('large', self.version)
        # Metadata-only fixture: no publication or payload validation claim.
        p = self.paths['ready']; p.mkdir(); (p / 'data').mkdir()
        D._write_json(p / 'manifest.json', self.manifest)
        D._write_json(p / 'READY.json', dict(schema=1, version=self.version))
        (p / 'data').chmod(0o555); p.chmod(0o555)

    def tearDown(self):
        for root, dirs, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root) / name
                if not path.is_symlink(): path.chmod(0o600)
        self.temp.cleanup()

    def replace_ready(self, content):
        path = self.paths['ready'] / 'manifest.json'
        self.paths['ready'].chmod(0o700)
        path.chmod(0o600); path.write_bytes(content); path.chmod(0o444)
        self.paths['ready'].chmod(0o555)

    def test_ready_hash_matches_exact_canonical_utf8_version_without_second_parse(self):
        self.assertEqual(hashlib.sha256(D._json_bytes(self.manifest)).hexdigest(), self.version)
        read = D._read_json
        def registry_only(path):
            if path.name == 'manifest.json': raise AssertionError('READY JSON must not be reparsed')
            return read(path)
        with patch.object(D, '_read_json', side_effect=registry_only), \
                patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as validate, \
                patch.object(D, '_canonical_json_matches', wraps=D._canonical_json_matches) as compare:
            listing = self.cache.list_datasets(OWNER)
            state = self.cache.status(OWNER, 'large', self.version)
        self.assertEqual(listing['datasets'][0]['versions'][0]['state'], 'READY')
        self.assertEqual(state['state'], 'READY')
        self.assertEqual(validate.call_count, 2)  # Full registry validation every call.
        self.assertEqual(compare.call_count, 2)

    def test_ready_invalid_json_and_same_size_content_change_are_rejected(self):
        original = D._json_bytes(self.manifest)
        prefix=self.manifest['files'][0]['sha256'][:8].encode()
        for content in (b'{}', original.replace(prefix, b'bbbbbbbb', 1), b'not JSON'):
            with self.subTest(content=content[:20]):
                self.replace_ready(content)
                with self.assertRaisesRegex(D.CacheError, 'corrupt'):
                    self.cache.status(OWNER, 'large', self.version)

    def test_noncanonical_semantically_equal_replacement_is_rejected_not_normalized(self):
        self.replace_ready(json.dumps(self.manifest, ensure_ascii=True, indent=2).encode())
        with self.assertRaisesRegex(D.CacheError, 'corrupt'):
            self.cache.list_datasets(OWNER)

    def test_changed_registration_is_fully_rejected_before_ready_hash(self):
        path = self.paths['.registry'].parent / (self.version + '.json')
        record = D._read_json(path); record['manifest']['files'][0]['size'] += 1
        D._write_json(path, record)
        with patch.object(D, '_canonical_json_matches', side_effect=AssertionError('bad registry first')):
            with self.assertRaisesRegex(D.CacheError, 'registration'):
                self.cache.list_datasets(OWNER)

    def test_ready_hash_is_bounded_and_nofollow_single_link(self):
        path = self.paths['ready'] / 'manifest.json'
        with patch.object(D, 'MAX_JSON_BYTES', path.stat().st_size - 1):
            with self.assertRaisesRegex(D.CacheError, 'too large'):
                D._canonical_json_matches(path, self.version)
        outside = self.base / 'outside.json'; outside.write_bytes(path.read_bytes())
        self.paths['ready'].chmod(0o700); path.unlink(); path.symlink_to(outside)
        with self.assertRaises(OSError): D._canonical_json_matches(path, self.version)
        path.unlink(); os.link(outside, path)
        with self.assertRaisesRegex(D.CacheError, 'single link'):
            D._canonical_json_matches(path, self.version)

    def test_marker_readonly_modes_and_live_leases_are_not_bypassed_by_hash(self):
        source=self.base/'protected-large';(source/'资料/深').mkdir(parents=True)
        for n in range(2000):(source/f'资料/深/样本-{n:05d}.bin').write_bytes(b'123456789')
        protected_original(self.cache,D,self.base/'retention-original',source_trees={('large',self.version):source})
        p = self.paths['ready']; p.chmod(0o700)
        D._write_json(p / 'READY.json', dict(schema=1, version='b' * 64)); p.chmod(0o555)
        with self.assertRaisesRegex(D.CacheError, 'corrupt'):
            self.cache.acquire_lease(OWNER, 'large', self.version, 'test-job')
        self.assertEqual(self.cache._leases('large', self.version), [])
        p.chmod(0o700); D._write_json(p / 'READY.json', dict(schema=1, version=self.version))
        with self.assertRaisesRegex(D.CacheError, 'wrapper is not read-only'):
            self.cache.status(OWNER, 'large', self.version)
        p.chmod(0o555); (p / 'data').chmod(0o700)
        with self.assertRaisesRegex(D.CacheError, 'data is not read-only'):
            self.cache.status(OWNER, 'large', self.version)
        (p / 'data').chmod(0o555)
        lease = self.cache.acquire_lease(OWNER, 'large', self.version, 'test-job')
        with self.assertRaisesRegex(D.CacheError, 'lease'):
            self.cache.evict(ADMIN, 'large', self.version)
        self.cache.release_lease(ADMIN, 'large', self.version, lease['leaseId'])
        self.cache.evict(ADMIN, 'large', self.version)
        self.assertEqual(self.cache.status(OWNER, 'large', self.version)['state'], 'REGISTERED')

    def test_replacement_after_hash_and_mutation_during_hash_fail_closed(self):
        compare = D._canonical_json_matches
        def replace_after(path, digest):
            result = compare(path, digest)
            self.replace_ready(path.read_bytes())
            return result
        with patch.object(D, '_canonical_json_matches', side_effect=replace_after):
            with self.assertRaisesRegex(D.CacheError, 'metadata changed'):
                self.cache.status(OWNER, 'large', self.version)
        regular = D._regular; count = 0
        def change_during(fd):
            nonlocal count
            info = regular(fd); count += 1
            if count == 2:
                self.replace_ready((self.paths['ready'] / 'manifest.json').read_bytes())
            return info
        with patch.object(D, '_regular', side_effect=change_during):
            with self.assertRaisesRegex(D.CacheError, 'changed while being read'):
                compare(self.paths['ready'] / 'manifest.json', self.version)

    def test_same_request_snapshot_rechecks_acl_record_and_ready_every_use(self):
        listing, snapshots = self.cache._list_datasets_snapshot(OWNER)
        snapshot = snapshots[('large', self.version)]
        self.assertEqual(self.cache._status_catalog_snapshot(OWNER, 'large', self.version, snapshot)['state'], 'READY')
        self.cache.set_owners(ADMIN, 'large', [OTHER.user_id])
        with self.assertRaises(PermissionError):
            self.cache._status_catalog_snapshot(OWNER, 'large', self.version, snapshot)
        self.cache.set_owners(ADMIN, 'large', [OWNER.user_id])
        record = self.paths['.registry'].parent / (self.version + '.json')
        D._write_json(record, D._read_json(record))
        with self.assertRaisesRegex(D.CacheError, 'registration changed'):
            self.cache._status_catalog_snapshot(OWNER, 'large', self.version, snapshot)


if __name__ == '__main__': unittest.main()
