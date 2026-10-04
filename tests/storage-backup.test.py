import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'deploy/storage-backup.py'
spec = importlib.util.spec_from_file_location('storage_backup', MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class BackupSafety(unittest.TestCase):
    def test_relative_and_parent_traversal_rejected(self):
        for value in ('relative', '/tmp/../etc/passwd'):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'ABSOLUTE_PATH'):
                m.path_check(value)

    def test_symlinks_are_not_control_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'real').write_text('private')
            (root / 'link').symlink_to(root / 'real')
            with self.assertRaisesRegex(RuntimeError, 'SYMLINK_COMPONENT'):
                m.path_check(root / 'link')

    def test_enclosing_uses_path_components(self):
        self.assertEqual(m.enclosing('/data-backup/repo', {'/': {}, '/data': {}, '/data-backup': {}}), '/data-backup')
        with self.assertRaisesRegex(RuntimeError, 'UNPINNED'):
            m.enclosing('/data-backup/repo', {'/data': {}})

    def test_wrong_uuid_or_bind_root_denied(self):
        config = {'mounts': {'/data-backup': {'uuid': '1234', 'fstype': 'ext4'}}}
        for value in (dict(uuid='wrong', fsroot='/'), dict(uuid='1234', fsroot='/subdir')):
            row = dict(target='/data-backup', fstype='ext4', options='rw', **value)
            with patch.object(m, 'path_check'), patch.object(m.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps({'filesystems': [row]}))):
                with self.assertRaisesRegex(RuntimeError, 'WRONG_OR_MISSING_MOUNT'):
                    m.mounts(config)

    def fixture(self):
        config = dict(repository='/data-backup/repo', stateDirectory='/data-backup/state',
                      passwordFile='/etc/gpuq-backup/password', sources=['/data/work'],
                      reserveBytes=20*1024**3, reserveInodes=10000)
        mounts = {'/data': {'maj:min': '8:1'}, '/data-backup': {'maj:min': '8:2'}}
        return config, mounts

    def test_same_volume_source_and_destination_rejected(self):
        config, mounts = self.fixture(); mounts['/data']['maj:min'] = '8:2'
        with patch.object(m, 'mounts', return_value=mounts), patch.object(m, 'path_check'), patch.object(m, 'actual_mount'):
            with self.assertRaisesRegex(RuntimeError, 'SAME_PHYSICAL_VOLUME'):
                m.guard(config)

    def test_mount_drift_refused_during_copy(self):
        config, mounts = self.fixture()
        with patch.object(m, 'mounts', return_value=mounts):
            with self.assertRaisesRegex(RuntimeError, 'MOUNT_CHANGED'):
                m.guard(config, {'different': {}})

    def test_capacity_and_inode_reserve(self):
        config, mounts = self.fixture()
        for space in (SimpleNamespace(f_bavail=1, f_frsize=4096, f_favail=1000000),
                      SimpleNamespace(f_bavail=10**12, f_frsize=4096, f_favail=1)):
            with patch.object(m, 'mounts', return_value=mounts), patch.object(m, 'path_check'), patch.object(m, 'actual_mount'), patch.object(m, 'no_nested_source_mounts'), patch.object(m.Path, 'read_text', return_value=''), patch.object(m.os, 'statvfs', return_value=space):
                with self.assertRaisesRegex(RuntimeError, 'RESERVE_REACHED'):
                    m.guard(config)

    def test_nested_or_same_device_bind_is_not_the_pinned_parent(self):
        expected = dict(target='/data-backup', uuid='1234', fstype='ext4', fsroot='/', **{'maj:min': '8:1', 'options': 'rw'})
        for change in ({'target': '/data-backup/repo', 'fsroot': '/other'}, {'uuid': 'wrong'}):
            actual = {**expected, **change}
            with patch.object(m.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps({'filesystems': [actual]}))):
                with self.assertRaisesRegex(RuntimeError, 'UNEXPECTED_PATH_MOUNT'):
                    m.actual_mount('/data-backup/repo', expected)

    def test_payload_submount_is_not_silently_skipped(self):
        with self.assertRaisesRegex(RuntimeError, 'NESTED_SOURCE_MOUNT'):
            m.no_nested_source_mounts(['/data/ready'], '10 9 8:1 /other /data/ready/child rw - ext4 /dev/sda rw')
        m.no_nested_source_mounts(['/data/ready'], '10 9 8:1 /other /data/readymore rw - ext4 /dev/sda rw')

    def test_run_failure_terminates_only_owned_process_and_keeps_failure_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            config, _ = self.fixture(); config.update(stateDirectory=temporary, host='fixture')
            child = unittest.mock.Mock()
            child.poll.return_value = None; child.returncode = -15
            with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.os, 'fstat', return_value=SimpleNamespace(st_mode=0o100600, st_uid=0, st_nlink=1)), patch.object(m, 'guard', side_effect=[{}, RuntimeError('MOUNT_CHANGED_DURING_BACKUP')]), patch.object(m.subprocess, 'Popen', return_value=child):
                with self.assertRaisesRegex(RuntimeError, 'MOUNT_CHANGED'):
                    m.run(config, 'backup')
            child.terminate.assert_called_once_with(); child.kill.assert_not_called()
            self.assertEqual(json.loads((Path(temporary)/'latest.json').read_text())['phase'], 'REVIEW_REQUIRED')

    def test_run_nonzero_never_reports_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            config, _ = self.fixture(); config.update(stateDirectory=temporary, host='fixture')
            child = unittest.mock.Mock(); child.poll.return_value = 3; child.returncode = 3
            with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.os, 'fstat', return_value=SimpleNamespace(st_mode=0o100600, st_uid=0, st_nlink=1)), patch.object(m, 'guard', return_value={}), patch.object(m.subprocess, 'Popen', return_value=child):
                with self.assertRaisesRegex(RuntimeError, 'RESTIC_INCOMPLETE'):
                    m.run(config, 'backup')
            self.assertEqual(json.loads((Path(temporary)/'latest.json').read_text())['phase'], 'REVIEW_REQUIRED')

    def test_no_shell_no_proxy_no_password_on_command_line(self):
        config, _ = self.fixture(); args = m.restic(config, ['backup', '--one-file-system', '/data/work'])
        self.assertEqual(args[0], '/usr/bin/restic')
        self.assertIn('--password-file', args)
        self.assertNotIn('sh', args)
        self.assertNotIn('--no-lock', args)
        self.assertNotIn('forget', MODULE.read_text())
        self.assertNotIn("'prune'", MODULE.read_text())

    def test_persist_is_atomic_private_and_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'receipt.json'
            m.persist(path, {'phase': 'RUNNING'})
            m.persist(path, {'phase': 'BACKUP_COMPLETE'})
            self.assertEqual(json.loads(path.read_text())['phase'], 'BACKUP_COMPLETE')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(path.parent.iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
