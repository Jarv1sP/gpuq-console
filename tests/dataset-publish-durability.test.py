"""Local-only publication durability; no production paths, services or GPUs.

Injected flushes check the publication ordering, not Linux disk durability.
The Linux-only case additionally invokes the real libc syncfs on a temp tree.
No test replaces os.fsync or changes the atomic rename implementation.
"""
import ctypes
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'deploy' / 'dataset-cache.py'
SPEC = importlib.util.spec_from_file_location('dataset_publish_durability', SOURCE)
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)
ADMIN = D.Principal('test-admin', True)
OWNER = D.Principal('demo-user-1')
OTHER = D.Principal('demo-user-2')


class PublishDurability(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'source'
        self.source.mkdir()
        (self.source / 'nested').mkdir()
        (self.source / 'empty').mkdir()
        (self.source / 'nested' / 'sample.bin').write_bytes(b'verified-sample')
        (self.source / 'zero').write_bytes(b'')
        self.cache = D.DatasetCache(self.base / 'cache', sources={'approved': self.source}, reserve_bytes=1024)

    def tearDown(self):
        for folder, _dirs, files in os.walk(self.base, followlinks=False):
            os.chmod(folder, 0o700)
            for name in files:
                path = Path(folder) / name
                if not path.is_symlink():
                    os.chmod(path, 0o600)
        self.temp.cleanup()

    def fill(self):
        version = self.cache.register_source(ADMIN, 'sample', 'approved', [OWNER.user_id])['version']
        plan = self.cache.plan(OWNER, 'sample', version)
        for entry in plan['files']:
            self.cache.put_chunk(OWNER, 'sample', version, entry['path'], 0,
                                 (self.source / entry['path']).read_bytes(), plan['token'])
        return version, plan['token']

    def stage(self, version):
        return self.cache.root / '.staging' / 'sample' / version

    def ready(self, version):
        return self.cache.root / 'ready' / 'sample' / version

    def assert_modes(self, root, readonly=True):
        for folder, _dirs, files in os.walk(root):
            self.assertEqual(stat.S_IMODE(Path(folder).stat().st_mode), 0o555 if readonly else 0o700)
            for name in files:
                self.assertEqual(stat.S_IMODE((Path(folder) / name).stat().st_mode), 0o444 if readonly else 0o600)

    def test_bulk_flush_once_on_retained_root_after_every_mode_before_rename(self):
        version, token = self.fill()
        stage, ready = self.stage(version), self.ready(version)
        before = stage.stat()
        calls = []

        def flush(fd):
            info = os.fstat(fd)
            self.assertEqual((info.st_dev, info.st_ino), (before.st_dev, before.st_ino))
            self.assertFalse(ready.exists())
            self.assertTrue((stage / 'TRANSFER.json').is_file())
            self.assert_modes(stage)
            calls.append(fd)

        with patch.object(D, '_linux_syncfs', return_value=flush) as resolver:
            result = self.cache.publish(OWNER, 'sample', version, token)
            self.assertEqual(self.cache.publish(OWNER, 'sample', version, token), result)
        self.assertEqual(resolver.call_count, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result['state'], 'READY')
        self.assertFalse(stage.exists())
        self.assertFalse((ready / 'TRANSFER.json').exists())
        self.assert_modes(ready)
        self.assertTrue(self.cache.verify(OWNER, 'sample', version)['verified'])

    def test_default_mode_changes_never_resolve_bulk_capability(self):
        with patch.object(D, '_linux_syncfs', side_effect=AssertionError('legacy path must stay legacy')):
            D._modes(self.source, True)
            self.assert_modes(self.source)
            D._modes(self.source, False)
            self.assert_modes(self.source, False)

    def test_absent_bulk_capability_falls_back_and_still_publishes_verified_readonly(self):
        version, token = self.fill()
        with patch.object(D, '_linux_syncfs', return_value=None) as resolver:
            self.assertEqual(self.cache.publish(OWNER, 'sample', version, token)['state'], 'READY')
        self.assertEqual(resolver.call_count, 1)
        self.assert_modes(self.ready(version))
        self.assertTrue(self.cache.verify(OWNER, 'sample', version)['verified'])

    def test_actual_flush_error_never_renames_and_same_token_can_resume(self):
        version, token = self.fill()
        before = (self.stage(version) / 'TRANSFER.json').read_bytes()
        with patch.object(D, '_linux_syncfs', return_value=lambda _fd: (_ for _ in ()).throw(OSError(errno.EIO, 'flush failed'))) as resolver:
            with self.assertRaises(OSError) as failure:
                self.cache.publish(OWNER, 'sample', version, token)
        self.assertEqual(failure.exception.errno, errno.EIO)
        self.assertEqual(resolver.call_count, 1)  # recovery does not opt in
        self.assertFalse(self.ready(version).exists())
        self.assertTrue((self.stage(version) / 'READY.json').exists())
        self.assertEqual((self.stage(version) / 'TRANSFER.json').read_bytes(), before)
        self.assert_modes(self.stage(version), False)
        self.assertEqual(self.cache.status(OWNER, 'sample', version)['state'], 'STAGING')
        restored = D.DatasetCache(self.cache.root, sources={'approved': self.source}, reserve_bytes=1024)
        self.assertEqual(restored.plan(OWNER, 'sample', version)['token'], token)
        self.assertEqual(restored.publish(OWNER, 'sample', version, token)['state'], 'READY')

    def test_wrong_sha_fails_before_bulk_or_ready_marker(self):
        version, token = self.fill()
        (self.stage(version) / 'data' / 'nested' / 'sample.bin').write_bytes(b'corrupt')
        with patch.object(D, '_linux_syncfs', side_effect=AssertionError('checksum precedes durability')):
            with self.assertRaisesRegex(D.CacheError, 'checksum/tree'):
                self.cache.publish(OWNER, 'sample', version, token)
        self.assertFalse(self.ready(version).exists())
        self.assertFalse((self.stage(version) / 'READY.json').exists())

    def test_owner_or_token_rejection_never_reaches_bulk(self):
        version, token = self.fill()
        with patch.object(D, '_linux_syncfs', side_effect=AssertionError('authority precedes durability')):
            for actor, given in ((OTHER, token), (OWNER, 'invalid')):
                with self.subTest(actor=actor.user_id), self.assertRaises((PermissionError, D.CacheError)):
                    self.cache.publish(actor, 'sample', version, given)
        self.assertFalse(self.ready(version).exists())

    def test_revoke_during_flush_cannot_publish_or_change_transfer_identity(self):
        version, token = self.fill()
        before = (self.stage(version) / 'TRANSFER.json').read_bytes()

        def revoke(_fd):
            self.cache.set_owners(ADMIN, 'sample', [OTHER.user_id])

        with patch.object(D, '_linux_syncfs', return_value=revoke):
            with self.assertRaises(PermissionError):
                self.cache.publish(OWNER, 'sample', version, token)
        self.assertFalse(self.ready(version).exists())
        self.assertEqual((self.stage(version) / 'TRANSFER.json').read_bytes(), before)

    def test_atomic_rename_failure_after_flush_keeps_fenced_resume(self):
        version, token = self.fill()
        calls = []
        with patch.object(D, '_linux_syncfs', return_value=lambda fd: calls.append(fd)), \
                patch.object(D, '_rename_new', side_effect=OSError(errno.EEXIST, 'existing destination')):
            with self.assertRaises(OSError):
                self.cache.publish(OWNER, 'sample', version, token)
        self.assertEqual(len(calls), 1)
        self.assertFalse(self.ready(version).exists())
        self.assertEqual(self.cache.plan(OWNER, 'sample', version)['token'], token)
        self.assertEqual(self.cache.publish(OWNER, 'sample', version, token)['state'], 'READY')

    def test_process_death_before_flush_completion_leaves_staging_not_ready(self):
        version, token = self.fill()
        code = '''
import importlib.util, json, os, pathlib, sys
s=importlib.util.spec_from_file_location('crash_fixture',sys.argv[1]); d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
p=json.loads(sys.argv[2]); c=d.DatasetCache(p['root'],sources={'approved':p['source']},reserve_bytes=1024)
d._linux_syncfs=lambda: (lambda _fd: os._exit(71))
c.publish(d.Principal('demo-user-1'),'sample',p['version'],p['token'])
'''
        result = subprocess.run([sys.executable, '-c', code, str(SOURCE), json.dumps({
            'root': str(self.cache.root), 'source': str(self.source), 'version': version, 'token': token,
        })], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 71, result.stderr)
        self.assertFalse(self.ready(version).exists())
        self.assertTrue((self.stage(version) / 'READY.json').exists())
        self.assertEqual(self.cache.status(OWNER, 'sample', version)['state'], 'STAGING')
        self.assertEqual(self.cache.plan(OWNER, 'sample', version)['token'], token)
        self.assertEqual(self.cache.publish(OWNER, 'sample', version, token)['state'], 'READY')

    def test_bulk_modes_still_reject_symlink_and_hardlink_without_flushing(self):
        outside = self.base / 'outside'
        outside.write_bytes(b'unchanged')
        outside.chmod(0o600)
        for kind in ('symlink', 'hardlink'):
            root = self.base / kind
            root.mkdir()
            linked = root / 'linked'
            if kind == 'symlink':
                linked.symlink_to(outside)
            else:
                os.link(outside, linked)
            calls = []
            with self.subTest(kind=kind), patch.object(D, '_linux_syncfs', return_value=lambda fd: calls.append(fd)):
                with self.assertRaises((OSError, D.CacheError)):
                    D._modes(root, True, bulk_durability=True)
            self.assertEqual(calls, [])
            self.assertEqual(outside.read_bytes(), b'unchanged')
            self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o600)
            linked.unlink()

    def test_bulk_rejects_a_file_on_another_device_before_flush(self):
        original = D._regular
        calls = []

        def other_device(fd):
            info = original(fd)
            return SimpleNamespace(st_dev=info.st_dev + 1)

        with patch.object(D, '_regular', side_effect=other_device), \
                patch.object(D, '_linux_syncfs', return_value=lambda fd: calls.append(fd)):
            with self.assertRaisesRegex(D.CacheError, 'cross filesystems'):
                D._modes(self.source, True, bulk_durability=True)
        self.assertEqual(calls, [])

    def test_bulk_rejects_a_nested_directory_device_before_flush(self):
        original = os.fstat
        nested = (self.source / 'nested').stat().st_ino
        calls = []

        def directory_device(fd):
            info = original(fd)
            if info.st_ino == nested and stat.S_ISDIR(info.st_mode):
                fields = list(info)
                fields[2] += 1
                return os.stat_result(fields)
            return info

        with patch.object(D.os, 'fstat', side_effect=directory_device), \
                patch.object(D, '_linux_syncfs', return_value=lambda fd: calls.append(fd)):
            with self.assertRaisesRegex(D.CacheError, 'cross filesystems'):
                D._modes(self.source, True, bulk_durability=True)
        self.assertEqual(calls, [])

    def test_resolver_absent_platform_or_symbol_keeps_legacy_available(self):
        with patch.object(D.sys, 'platform', 'darwin'), patch.object(D.ctypes, 'CDLL', side_effect=AssertionError('not Linux')):
            self.assertIsNone(D._linux_syncfs())
        with patch.object(D.sys, 'platform', 'linux'), patch.object(D.ctypes, 'CDLL', return_value=SimpleNamespace()):
            self.assertIsNone(D._linux_syncfs())

    def test_resolved_syscall_reports_errno_without_fallback(self):
        def failed(_fd):
            ctypes.set_errno(errno.EIO)
            return -1
        with patch.object(D.sys, 'platform', 'linux'), patch.object(D.ctypes, 'CDLL', return_value=SimpleNamespace(syncfs=failed)):
            flush = D._linux_syncfs()
        self.assertEqual(failed.argtypes, [ctypes.c_int])
        self.assertEqual(failed.restype, ctypes.c_int)
        with self.assertRaises(OSError) as failure:
            flush(123)
        self.assertEqual(failure.exception.errno, errno.EIO)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'real syncfs requires Linux')
    def test_real_linux_syncfs_publishes_and_verifies_temp_version(self):
        self.assertIsNotNone(D._linux_syncfs(), 'supported Linux test host must expose syncfs')
        version, token = self.fill()
        self.assertEqual(self.cache.publish(OWNER, 'sample', version, token)['state'], 'READY')
        self.assertTrue(self.cache.verify(OWNER, 'sample', version)['verified'])
        self.assert_modes(self.ready(version))


if __name__ == '__main__':
    unittest.main()
