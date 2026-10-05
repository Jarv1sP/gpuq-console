"""Disposable catalog summaries never replace current ACL or data validation."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('dataset_catalog_summary',
    Path(__file__).resolve().parents[1] / 'deploy' / 'dataset-cache.py')
D = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(D)
ADMIN, OWNER, OTHER = D.Principal('admin', True), D.Principal('owner'), D.Principal('other')


class CatalogSummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.base = Path(self.temp.name).resolve()
        self.cache = D.DatasetCache(self.base / 'cache', reserve_bytes=0)
        self.manifest = dict(schema=1, directories=[], files=[
            dict(path=f'file-{n:06d}.bin', size=9, sha256='a' * 64) for n in range(2000)])
        self.version = self.cache.register_manifest(ADMIN, 'large', self.manifest, [OWNER.user_id])['version']
        self.paths = self.cache._paths('large', self.version)
        # Synthetic metadata fixture, not a real payload publication claim.
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

    def warm(self):
        return self.cache.list_datasets(OWNER)

    def summary(self):
        return next((self.cache.root / '.catalog').glob('*.json'))

    def test_first_call_full_validation_then_new_rpc_instance_avoids_all_large_reads(self):
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse, \
                patch.object(D, '_canonical_json_matches', wraps=D._canonical_json_matches) as compare:
            first = self.warm()
        self.assertEqual(parse.call_count, 1); self.assertEqual(compare.call_count, 1)
        other = D.DatasetCache(self.cache.root, reserve_bytes=0)
        with patch.object(D, '_manifest_bytes', side_effect=AssertionError('must not parse')), \
                patch.object(D, '_canonical_json_matches', side_effect=AssertionError('must not hash')):
            self.assertEqual(other.list_datasets(OWNER), first)
        self.assertEqual(stat.S_IMODE(self.summary().stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.summary().parent.stat().st_mode), 0o700)
        self.assertLess(self.summary().stat().st_size, D.CATALOG_SUMMARY_BYTES)
        value = json.loads(self.summary().read_text()); self.assertEqual(set(value['summary']), {'bytes', 'files', 'ready', 'sourceId'})
        self.assertNotIn('owners', value['summary']); self.assertNotIn('manifest', value['summary'])

    def test_status_and_lease_still_fully_validate_every_call(self):
        self.warm()
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse, \
                patch.object(D, '_canonical_json_matches', wraps=D._canonical_json_matches) as compare:
            self.assertEqual(self.cache.status(OWNER, 'large', self.version)['state'], 'READY')
        self.assertEqual(parse.call_count, 1); self.assertEqual(compare.call_count, 1)
        with patch.object(self.cache, '_record_snapshot', side_effect=AssertionError('lease full path')):
            with self.assertRaisesRegex(AssertionError, 'lease full path'):
                self.cache.acquire_lease(OWNER, 'large', self.version, 'own-job')

    def test_revoked_acl_excluded_and_revocation_during_hit_rejected(self):
        self.warm(); self.cache.set_owners(ADMIN, 'large', [OTHER.user_id])
        self.assertEqual(self.cache.list_datasets(OWNER), {'datasets': []})
        self.cache.set_owners(ADMIN, 'large', [OWNER.user_id]); self.warm()
        read = self.cache._catalog_summary
        def revoke(binding, value=None):
            row = read(binding, value)
            if value is None: D._write_json(self.paths['.registry'].parent / 'dataset.json', {'schema': 1, 'owners': [OTHER.user_id]})
            return row
        with patch.object(self.cache, '_catalog_summary', side_effect=revoke):
            with self.assertRaises((PermissionError, D.CacheError)): self.warm()

    def test_registry_byte_identical_replace_misses_and_corruption_never_hidden(self):
        self.warm(); registry = self.paths['.registry'].parent / (self.version + '.json')
        D._write_json(registry, D._read_json(registry))
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
        self.assertEqual(parse.call_count, 1)
        registry.write_text('{}')
        with self.assertRaisesRegex(D.CacheError, 'registration'): self.warm()

    def test_ready_change_and_readonly_mode_change_invalidate_summary(self):
        self.warm(); p = self.paths['ready']; p.chmod(0o700)
        D._write_json(p / 'READY.json', {'schema': 1, 'version': 'b' * 64}); p.chmod(0o555)
        with self.assertRaisesRegex(D.CacheError, 'corrupt'): self.warm()
        p.chmod(0o700); D._write_json(p / 'READY.json', {'schema': 1, 'version': self.version}); p.chmod(0o555)
        self.warm(); (p / 'data').chmod(0o700)
        with self.assertRaisesRegex(D.CacheError, 'read-only'): self.warm()

    def test_source_capability_recomputed_from_current_config(self):
        registry = self.paths['.registry'].parent / (self.version + '.json')
        record = D._read_json(registry); record['sourceId'] = 'approved'; D._write_json(registry, record)
        self.cache.sources['approved'] = self.base / 'approved'
        self.assertTrue(self.warm()['datasets'][0]['versions'][0]['canPrepare'])
        other = D.DatasetCache(self.cache.root, reserve_bytes=0)
        with patch.object(D, '_manifest_bytes', side_effect=AssertionError('warm')):
            self.assertFalse(other.list_datasets(OWNER)['datasets'][0]['versions'][0]['canPrepare'])

    def test_corrupt_oversized_and_invalid_schema_or_bounds_are_misses(self):
        self.warm(); summary = self.summary(); original = summary.read_bytes()
        valid = json.loads(original)
        bad = [b'not json', b'x' * (D.CATALOG_SUMMARY_BYTES + 1)]
        for field, value in [('files', -1), ('files', D.MAX_ENTRIES + 1), ('bytes', True), ('ready', 'yes'), ('sourceId', '/outside')]:
            current = json.loads(original); current['summary'][field] = value; bad.append(json.dumps(current).encode())
        current = json.loads(original); current['unknown'] = 1; bad.append(json.dumps(current).encode())
        current = json.loads(original); current['schema'] = True; bad.append(json.dumps(current).encode())
        for raw in bad:
            with self.subTest(raw=raw[:20]):
                summary.write_bytes(raw)
                with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
                self.assertEqual(parse.call_count, 1)
        self.assertEqual(json.loads(summary.read_bytes()), valid)

    def test_summary_symlink_hardlink_modes_and_wrong_owner_are_misses(self):
        self.warm(); summary = self.summary(); outside = self.base / 'outside'; outside.write_bytes(summary.read_bytes())
        summary.unlink(); summary.symlink_to(outside)
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
        self.assertEqual(parse.call_count, 1); self.assertFalse(summary.is_symlink())
        summary.unlink(); os.link(outside, summary)
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
        self.assertEqual(parse.call_count, 1); self.assertEqual(summary.stat().st_nlink, 1)
        summary.chmod(0o644)
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
        self.assertEqual(parse.call_count, 1)
        # The production owner guard itself, without requiring root/chown.
        with patch.object(D.os, 'geteuid', return_value=os.geteuid() + 1):
            self.assertIsNone(self.cache._catalog_summary(self.cache._catalog_binding('large', self.version)))

    def test_bad_private_directory_is_not_followed_or_required_for_valid_catalog(self):
        self.warm(); directory = self.summary().parent; saved = self.base / 'saved'; directory.rename(saved)
        directory.symlink_to(saved, target_is_directory=True)
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
        self.assertEqual(parse.call_count, 1); self.assertTrue(directory.is_symlink())
        directory.unlink(); saved.rename(directory); directory.chmod(0o755)
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
        self.assertEqual(parse.call_count, 1)

    def test_cache_is_bounded_and_foreign_root_binding_not_accepted(self):
        self.warm(); summary = self.summary(); value = json.loads(summary.read_text())
        value['binding']['root'][1] += 1; summary.write_text(json.dumps(value))
        with patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
        self.assertEqual(parse.call_count, 1)
        other = self.cache.register_manifest(ADMIN, 'other', {'schema': 1, 'directories': [], 'files': []}, [OWNER.user_id])
        with patch.object(D, 'CATALOG_SUMMARY_ROWS', 1): self.warm()
        self.assertEqual(len(list(summary.parent.glob('*.json'))), 1)

    def test_file_replaced_during_summary_read_is_miss(self):
        self.warm(); summary = self.summary(); read = os.read; replaced = False
        def change(fd, amount):
            nonlocal replaced
            raw = read(fd, amount)
            if not replaced and amount == D.CATALOG_SUMMARY_BYTES + 1:
                replaced = True; copy = summary.with_suffix('.replace'); copy.write_bytes(summary.read_bytes()); copy.chmod(0o600); copy.replace(summary)
            return raw
        with patch.object(D.os, 'read', side_effect=change), patch.object(D, '_manifest_bytes', wraps=D._manifest_bytes) as parse: self.warm()
        self.assertTrue(replaced); self.assertEqual(parse.call_count, 1)


if __name__ == '__main__': unittest.main()
