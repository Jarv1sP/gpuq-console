"""Bounded local project observation; no devices, RPC, GPUs or business writes."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1] / 'deploy'
spec = importlib.util.spec_from_file_location('project_observation_fixture', HERE/'storage-observation.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ProjectObservation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/private/tmp' if Path('/private/tmp').is_dir() else None)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base/'root'
        self.root.mkdir(mode=0o700)
        self.node = SimpleNamespace(ROOT=self.root, HERE=HERE, platform_root_check=Mock())
        # Production never invents mount proof on macOS. These local POSIX
        # tests inject an explicit, fixed Linux-mounted-ancestor observation.
        self.mounts = patch.object(observer, 'mount_signature', return_value=('fixed-root-mount',))
        self.mounts.start()
        self.addCleanup(self.mounts.stop)

    def file(self, relative, body=b'project bytes'):
        target = self.root/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        return target

    def scan(self, **kwargs):
        fd = observer.open_directory(self.root)
        try:
            return observer.sample(fd, root_path=self.root, **kwargs)
        finally:
            os.close(fd)

    def expected(self):
        seen, total = set(), 0
        for name in observer.ROOTS:
            root = self.root/name
            if not root.exists():
                continue
            for path in [root, *root.rglob('*')]:
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode):
                    continue
                key = (info.st_dev, info.st_ino)
                if key not in seen:
                    total += info.st_blocks*512
                    seen.add(key)
        return total

    def success(self):
        value = observer.project_usage(self.node)
        self.assertTrue(value['projectUsageComplete'])
        self.assertEqual(value['projectBytes'], self.expected())
        self.assertRegex(value['projectCollectedAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        return value

    def proof(self):
        return json.loads((self.root/'.storage-observations/projects.json').read_text())

    def write_proof(self, value):
        path = self.root/'.storage-observations/projects.json'
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def expire(self):
        value = self.proof()
        value['attemptedAt'] -= observer.TTL_SECONDS+1
        # Keep the successful observation genuinely older than that attempt.
        value['value']['projectCollectedAt'] = '2000-01-01T00:00:00Z'
        self.write_proof(value)
        return value['value']['projectCollectedAt']

    def assert_unknown(self, value, collected=None):
        self.assertEqual(value, dict(projectBytes=None, projectUsageComplete=False,
                                     projectCollectedAt=collected))

    def test_all_accounts_allocated_blocks_sparse_and_hardlink_dedup(self):
        source = self.file('projects-v2/alice/p/code/train.py', b'x'*8192)
        self.file('projects-v2/bob/p/env/package', b'y'*4096)
        self.file('oci/alice/layers/image', b'z'*8192)
        target = self.file('users/bob/job/output', b'run output')
        target.unlink()
        os.link(source, target)
        sparse = self.file('users/alice/sparse', b'')
        with sparse.open('r+b') as stream:
            stream.truncate(256*1024**2)
        value = self.success()
        self.assertLess(value['projectBytes'], sparse.stat().st_size)
        self.assertEqual(self.scan(), self.expected())

    def test_external_shared_dataset_and_base_are_not_walked(self):
        self.file('datasets/shared/payload', b'd'*65536)
        self.file('base/conda/package', b'e'*65536)
        self.file('projects-v2/alice/code', b'owned')
        (self.root/'projects-v2/alice/dataset').symlink_to(self.root/'datasets', target_is_directory=True)
        (self.root/'projects-v2/alice/conda').symlink_to(self.root/'base', target_is_directory=True)
        before = (self.root/'datasets/shared/payload').read_bytes()
        self.success()
        self.assertEqual((self.root/'datasets/shared/payload').read_bytes(), before)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()),
                         ['.storage-observations', 'base', 'datasets', 'projects-v2'])

    def test_verified_absent_managed_roots_are_real_zero(self):
        self.assertEqual(self.success()['projectBytes'], 0)

    def test_cached_success_skips_new_scan_for_300_seconds(self):
        self.file('users/alice/file')
        value = self.success()
        with patch.object(observer, 'bounded_sample', side_effect=AssertionError('no per-page scan')):
            self.assertEqual(observer.project_usage(self.node), value)

    def test_failed_expired_sample_is_unknown_preserves_last_success_and_caches_failure(self):
        self.success()
        collected = self.expire()
        with patch.object(observer, 'bounded_sample', side_effect=ValueError('incomplete')) as scan:
            self.assert_unknown(observer.project_usage(self.node), collected)
            self.assert_unknown(observer.project_usage(self.node), collected)
            self.assertEqual(scan.call_count, 1)

    def test_busy_expired_cache_never_waits_or_scans(self):
        self.success()
        collected = self.expire()
        lock = os.open(self.root/'.storage-observations/projects.lock', os.O_RDWR)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        started = time.monotonic()
        with patch.object(observer, 'bounded_sample', side_effect=AssertionError('busy no fork')):
            self.assert_unknown(observer.project_usage(self.node), collected)
        self.assertLess(time.monotonic()-started, 0.2)

    def test_busy_fresh_cache_can_return_only_valid_previous_complete_sample(self):
        value = self.success()
        lock = os.open(self.root/'.storage-observations/projects.lock', os.O_RDWR)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with patch.object(observer, 'bounded_sample', side_effect=AssertionError('busy no fork')):
            self.assertEqual(observer.project_usage(self.node), value)

    def test_single_blocked_scandir_is_stopped_by_parent_deadline_and_failure_ttl(self):
        self.file('users/alice/file')
        real = observer.os.scandir
        def blocked(fd):
            time.sleep(10)
            return real(fd)
        started = time.monotonic()
        with patch.object(observer.os, 'scandir', side_effect=blocked):
            self.assert_unknown(observer.project_usage(self.node))
        self.assertLess(time.monotonic()-started, 0.85)
        with patch.object(observer, 'bounded_sample', side_effect=AssertionError('no second blocked child')):
            self.assert_unknown(observer.project_usage(self.node))

    def test_entry_and_elapsed_bounds_refuse_partial_totals(self):
        self.file('users/a/one')
        self.file('users/a/two')
        with self.assertRaisesRegex(ValueError, 'bound'):
            self.scan(maximum=1)
        with self.assertRaisesRegex(ValueError, 'bound'):
            self.scan(seconds=0)

    def test_earlier_directory_change_during_later_root_is_not_complete(self):
        self.file('projects-v2/a/early/file')
        self.file('oci/b/later/file')
        later_inode = (self.root/'oci').stat().st_ino
        real = observer.os.scandir
        changed = False
        def modify(fd):
            nonlocal changed
            if os.fstat(fd).st_ino == later_inode and not changed:
                changed = True
                self.file('projects-v2/a/early/new')
            return real(fd)
        with patch.object(observer.os, 'scandir', side_effect=modify):
            with self.assertRaisesRegex(ValueError, 'full sample'):
                self.scan()

    def test_root_path_replacement_after_open_cannot_prove_complete(self):
        self.success()
        self.expire()
        def replace(fd, path):
            self.root.rename(self.base/'old-root')
            self.root.mkdir(mode=0o700)
            return 0
        with patch.object(observer, 'bounded_sample', side_effect=replace):
            self.assert_unknown(observer.project_usage(self.node), '2000-01-01T00:00:00Z')
        self.assertFalse((self.root/'.storage-observations').exists())

    def test_managed_root_symlink_is_unknown_not_zero(self):
        outside = self.base/'outside'
        outside.mkdir()
        (outside/'file').write_bytes(b'outside')
        (self.root/'users').symlink_to(outside, target_is_directory=True)
        self.assert_unknown(observer.project_usage(self.node))

    def test_any_nested_same_device_bind_is_unknown_and_cached_success_rechecks_mounts(self):
        value = self.success()
        with patch.object(observer, 'mount_signature', side_effect=ValueError('same-device nested bind')):
            self.assert_unknown(observer.project_usage(self.node), value['projectCollectedAt'])
        self.expire()
        with patch.object(observer, 'mount_signature', side_effect=ValueError('same-device nested bind')):
            self.assert_unknown(observer.project_usage(self.node), '2000-01-01T00:00:00Z')

    def test_mount_change_during_sample_refuses_total(self):
        with patch.object(observer, 'mount_signature', side_effect=[('initial',), ('changed',)]):
            with self.assertRaisesRegex(ValueError, 'mounts changed'):
                self.scan()

    def test_mountinfo_reads_all_chunks_and_rejects_hidden_same_device_bind(self):
        # Exercise the real parser even on macOS. A partial first read must
        # never hide the later nested mount's bytes on the same dev.
        self.mounts.stop()
        ancestor = b'1 0 8:1 / / rw - ext4 /dev/example rw\n'
        target = str(self.root/'oci/owner/merged/data').replace(' ', '\\040')
        nested = ('2 1 8:1 /datasets '+target+' rw - ext4 /dev/example rw\n').encode()
        with patch.object(observer.os, 'open', return_value=999), patch.object(observer.os, 'close'), patch.object(observer.os, 'read', side_effect=[ancestor, nested, b'']):
            with self.assertRaisesRegex(ValueError, 'Nested managed mount'):
                observer.mount_signature(self.root)
        self.mounts.start()

    def test_missing_mount_proof_is_unknown_not_a_fake_mac_success(self):
        self.mounts.stop()
        with patch.object(observer.os, 'open', side_effect=FileNotFoundError('no /proc proof')):
            with self.assertRaises(FileNotFoundError):
                observer.mount_signature(self.root)
        self.mounts.start()
        with patch.object(observer, 'mount_signature', side_effect=FileNotFoundError('no proof')):
            self.assert_unknown(observer.project_usage(self.node))

    def test_untrusted_root_and_cache_folder_are_never_written_through(self):
        self.root.chmod(0o777)
        self.assert_unknown(observer.project_usage(self.node))
        self.assertFalse((self.root/'.storage-observations').exists())
        self.root.chmod(0o700)
        external = self.base/'outside-cache'
        external.mkdir()
        (self.root/'.storage-observations').symlink_to(external, target_is_directory=True)
        self.assert_unknown(observer.project_usage(self.node))
        self.assertEqual(list(external.iterdir()), [])

    def test_symlink_or_hardlink_cache_files_and_lock_are_not_followed(self):
        self.success()
        cache = self.root/'.storage-observations/projects.json'
        external = self.base/'external'
        external.write_bytes(cache.read_bytes())
        cache.unlink()
        cache.symlink_to(external)
        self.assert_unknown(observer.project_usage(self.node))
        cache.unlink()
        os.link(external, cache)
        self.assert_unknown(observer.project_usage(self.node))
        cache.unlink()
        lock = self.root/'.storage-observations/projects.lock'
        lock.unlink()
        lock.symlink_to(external)
        before = external.read_bytes()
        self.assert_unknown(observer.project_usage(self.node))
        self.assertEqual(external.read_bytes(), before)

    def test_invalid_cached_proofs_never_claim_complete_or_trigger_scan(self):
        self.success()
        valid = self.proof()
        changes = [
            {'attemptedAt': float('nan')}, {'attemptedAt': float('inf')},
            {'attemptedAt': 10**1000}, {'attemptedAt': True}, {'protocol': True},
            {'binding': 'a'*64}, {'mountBinding': None}, {'mountBinding': 'wrong'},
            {'value': dict(valid['value'], projectBytes=True)},
            {'value': dict(valid['value'], projectCollectedAt=None)},
            {'value': dict(valid['value'], projectCollectedAt='2026-02-30T00:00:00Z')},
            {'value': dict(valid['value'], projectCollectedAt='2999-01-01T00:00:00Z')},
        ]
        for change in changes:
            with self.subTest(change=repr(change)[:100]):
                proof = copy.deepcopy(valid)
                proof.update(change)
                self.write_proof(proof)
                with patch.object(observer, 'bounded_sample', side_effect=AssertionError('invalid cache no scan')):
                    self.assert_unknown(observer.project_usage(self.node))

    def test_cache_binding_does_not_transfer_to_replaced_root_inode(self):
        self.success()
        self.root.rename(self.base/'previous')
        self.root.mkdir(mode=0o700)
        cache = self.root/'.storage-observations'
        cache.mkdir(mode=0o700)
        (cache/'projects.json').write_bytes((self.base/'previous/.storage-observations/projects.json').read_bytes())
        (cache/'projects.json').chmod(0o600)
        with patch.object(observer, 'bounded_sample', side_effect=AssertionError('wrong root cache no scan')):
            self.assert_unknown(observer.project_usage(self.node))

    def test_cache_write_failure_returns_unknown_preserves_last_time_and_cleans_tmp(self):
        self.success()
        collected = self.expire()
        with patch.object(observer.os, 'replace', side_effect=OSError('cache disk failure')):
            self.assert_unknown(observer.project_usage(self.node), collected)
        self.assertEqual(list((self.root/'.storage-observations').glob('.projects.*.tmp')), [])

    def test_platform_guard_failure_is_unknown_and_does_not_create_cache(self):
        self.node.platform_root_check.side_effect = ValueError('root not mounted')
        self.assert_unknown(observer.project_usage(self.node))
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
