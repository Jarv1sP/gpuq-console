"""No persistent cache: validate direct-parent closure and canonical-byte reuse."""
import copy
import hashlib
import importlib.util
import itertools
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('manifest_algorithm', Path(__file__).resolve().parents[1] / 'deploy/dataset-cache.py')
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
OWNER = D.Principal('demo-user-3')
ADMIN = D.Principal('test-admin', True)


def file(path, size=0):
    return dict(path=path, size=size, sha256='a' * 64)


def manifest(directories=(), files=()):
    return dict(schema=1, directories=list(directories), files=list(files))


class ManifestAlgorithmTests(unittest.TestCase):
    def test_legacy_fixed_version_and_normalization_unchanged(self):
        value = manifest(['资料/深', '資料', '资料'], [file('资料/深/样本.bin', 12), dict(path='root.txt', size=0, sha256='b' * 64)])
        normalized, raw = D._manifest_bytes(value)
        self.assertEqual(normalized, D._manifest(value))
        self.assertEqual(raw, D._json_bytes(normalized))
        self.assertEqual(hashlib.sha256(raw).hexdigest(), 'b18d1e23d0fa3d2c7c1634620f2735b35f2b07b8e6dc85bc28492c19210619d3')
        self.assertEqual(D._version(normalized), hashlib.sha256(raw).hexdigest())
        self.assertEqual(value['directories'], ['资料/深', '資料', '资料'])

    def test_direct_parent_equals_legacy_ancestor_walk_exhaustively(self):
        # All subsets of this deep/shared-prefix tree, including orphan dirs.
        paths = ['a', 'a/b', 'a/b/c', 'a/d', 'b', 'b/a', 'aa']
        for bits in itertools.product((False, True), repeat=len(paths)):
            dirs = {p for p, include in zip(paths, bits) if include}
            for leaf in ['root', 'a/f', 'a/b/f', 'a/b/c/f', 'b/a/f', 'aa/f']:
                expected = leaf not in dirs
                for path in dirs | {leaf}:
                    parent = Path(path).parent
                    while str(parent) != '.':
                        expected &= parent.as_posix() in dirs
                        parent = parent.parent
                value = manifest(sorted(dirs, reverse=True), [file(leaf)])
                with self.subTest(dirs=sorted(dirs), leaf=leaf):
                    if expected:
                        D._manifest(value)
                    else:
                        with self.assertRaises(D.CacheError): D._manifest(value)

    def test_missing_ancestor_and_file_as_parent_are_rejected(self):
        for value in [manifest(['a/b'], [file('a/b/f')]), manifest(['a', 'a/b/c'], [file('a/b/c/f')]), manifest([], [file('a'), file('a/f')]), manifest(['aa'], [file('a/f')])]:
            with self.subTest(value=value), self.assertRaises(D.CacheError): D._manifest(value)

    def test_duplicate_or_conflicting_entries_are_rejected(self):
        for value in [manifest(['a', 'a']), manifest(['a'], [file('a')]), manifest([], [file('a'), file('a')]), manifest(['a/b'], [file('a')])]:
            with self.subTest(value=value), self.assertRaises(D.CacheError): D._manifest(value)

    def test_all_existing_path_exclusions_apply_to_dirs_and_files(self):
        for path in ['', '/', '/a', '.', '..', 'a/../b', 'a/./b', 'a//b', 'a/', 'a\\b', 'a\x00b', 'a\nb', 'a\x7fb', '.ssh/f', 'a/.env/f', '.git', '.venv/x', 'anaconda3/x', 'miniconda3/x', '.conda/x', '长' * 1366]:
            for value in [manifest([path]), manifest([], [file(path)])]:
                with self.subTest(path=path), self.assertRaises(D.CacheError): D._manifest(value)

    def test_compiled_character_check_matches_original_ascii_and_unicode_rules(self):
        # C1 and non-ASCII are intentionally not newly rejected: preserve the
        # original byte-for-byte policy, not a broader Unicode control filter.
        for code in [*range(256),0x2028,0x202e,0x4e2d,0x1f642]:
            path='prefix'+chr(code)+'suffix'
            expected=(code<32 or code==127 or chr(code) in ('/','\\'))
            # A slash creates two safe components, unlike backslash/control.
            if code==47:expected=False
            with self.subTest(code=code):
                if expected:
                    with self.assertRaises(D.CacheError):D._relative(path)
                else:self.assertEqual(D._relative(path),path)

    def test_schema_entry_hash_and_size_validation_unchanged(self):
        valid = manifest([], [file('a')])
        mutations = [lambda v: v.update(schema=2), lambda v: v.update(extra=True), lambda v: v.update(files={}), lambda v: v['files'][0].update(size=-1), lambda v: v['files'][0].update(size=True), lambda v: v['files'][0].update(size=2**63), lambda v: v['files'][0].update(sha256='bad'), lambda v: v['files'][0].update(extra=1)]
        for mutate in mutations:
            value = copy.deepcopy(valid); mutate(value)
            with self.assertRaises(D.CacheError): D._manifest(value)

    def test_encoded_size_and_entry_limit_still_apply(self):
        value = manifest([], [file('a')]); raw = D._manifest_bytes(value)[1]
        with patch.object(D, 'MAX_JSON_BYTES', len(raw)):
            self.assertEqual(D._manifest_bytes(value)[1], raw)
        with patch.object(D, 'MAX_JSON_BYTES', len(raw)-1):
            with self.assertRaises(D.CacheError): D._manifest(value)
        with patch.object(D, 'MAX_ENTRIES', 1):
            with self.assertRaises(D.CacheError): D._manifest(manifest(['a'], [file('a/f')]))

    def test_record_uses_one_canonical_serialization_and_keeps_legacy_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = D.DatasetCache(Path(tmp).resolve()/'cache', reserve_bytes=0)
            value = manifest(['a'], [file('z'), file('a/f', 7)])
            version = cache.register_manifest(ADMIN, 'test', value, [OWNER.user_id])['version']
            with patch.object(D, '_json_bytes', wraps=D._json_bytes) as serialize:
                record = cache._record(OWNER, 'test', version)
            self.assertEqual(serialize.call_count, 1)
            self.assertEqual(record['manifest'], D._manifest(value))
            self.assertEqual(record['sourceId'], None)

    def test_record_revalidates_instead_of_memoizing_and_keeps_acl_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = D.DatasetCache(Path(tmp).resolve()/'cache', reserve_bytes=0)
            version = cache.register_manifest(ADMIN, 'test', manifest([], [file('a')]), [OWNER.user_id])['version']
            path = cache._paths('test')['.registry']/(version+'.json')
            for bad in [dict(schema=1, manifest=manifest([], [file('b')]), sourceId=None), dict(schema=1, manifest=manifest(['a/b']), sourceId=None), {'schema': 2}]:
                D._write_json(path, bad)
                with self.assertRaises(D.CacheError): cache._record(OWNER, 'test', version)
                with patch.object(D, '_manifest_bytes', side_effect=AssertionError('ACL must be checked first')):
                    with self.assertRaises(PermissionError): cache._record(D.Principal('demo-user-4'), 'test', version)


if __name__ == '__main__': unittest.main()
