"""Storage safety tests: temporary files and mocked mount/systemd state only."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import contextlib
import io


spec = importlib.util.spec_from_file_location('storage_layout', Path(__file__).resolve().parents[1] / 'deploy/storage-layout.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageLayout(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.disk = self.base / 'data-disk'
        self.disk.mkdir()
        self.source = self.disk / 'gpuq-data2'
        self.target = self.base / 'data2'
        self.units = self.base / 'systemd'
        self.units.mkdir()
        self.fstab = self.base / 'fstab'
        self.fstab.write_text('# existing unrelated entry\n')
        self.mounts = [self.mount('/', '8:1'), self.mount(self.disk, '8:2')]
        self.real_trusted_parents = storage.trusted_parents
        self.trust = patch.object(storage, 'trusted_parents')
        self.trust.start()
        self.addCleanup(self.trust.stop)

    @staticmethod
    def mount(target, device, fstype='ext4', options=None):
        return {'target': str(target), 'device': device, 'root': '/', 'fstype': fstype,
                'options': options or ['rw'], 'source': '/dev/example'}

    def plan(self, source=True):
        return storage.build_plan(self.source if source else None, target=self.target,
                                  mounts=self.mounts, fstab=self.fstab, unit_dir=self.units)

    def test_preview_missing_target_writes_nothing(self):
        before = self.fstab.read_bytes()
        plan = self.plan()
        self.assertEqual(plan['action'], 'bind')
        self.assertTrue(plan['createSource'])
        self.assertTrue(plan['createTarget'])
        self.assertFalse(self.source.exists())
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.units.iterdir()), [])
        self.assertEqual(self.fstab.read_bytes(), before)
        self.assertIn('AssertPathIsMountPoint=' + str(self.disk), plan['unitContent'])
        self.assertIn('RequiresMountsFor=' + str(self.disk), plan['unitContent'])

    def test_cli_is_dry_run_by_default(self):
        with patch.object(storage, 'build_plan', return_value={'action': 'preserve'}), patch.object(storage, 'apply_plan') as apply, contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(storage.main([]), 0)
        self.assertTrue(json.loads(stdout.getvalue())['dryRun'])
        apply.assert_not_called()

    def test_missing_target_requires_explicit_source(self):
        with self.assertRaisesRegex(storage.LayoutError, 'supply --source'):
            self.plan(False)

    def test_existing_real_data_mount_is_preserved_with_data_and_permissions(self):
        self.target.mkdir(mode=0o750)
        file = self.target / 'existing-data'
        file.write_bytes(b'never touch')
        file.chmod(0o640)
        self.mounts.append(self.mount(self.target, '8:3'))
        plan = self.plan(False)
        with patch.object(storage.os, 'geteuid', return_value=0), patch.object(storage, 'run_systemctl') as systemctl:
            self.assertEqual(storage.apply_plan(plan)['status'], 'preserved')
        systemctl.assert_not_called()
        self.assertEqual(file.read_bytes(), b'never touch')
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o640)
        self.assertEqual(list(self.units.iterdir()), [])

    def test_existing_directory_on_data_filesystem_is_preserved(self):
        target = self.disk / 'existing'
        target.mkdir()
        plan = storage.build_plan(None, target=target, mounts=self.mounts)
        self.assertEqual(plan['action'], 'preserve')

    def test_root_filesystem_is_never_accepted_as_data(self):
        self.target.mkdir()
        with self.assertRaisesRegex(storage.LayoutError, 'no root-disk fallback'):
            self.plan(False)
        self.mounts = [self.mount('/', '8:1')]
        with self.assertRaisesRegex(storage.LayoutError, 'no root-disk fallback'):
            self.plan()

    def test_bind_alias_of_root_disk_is_not_a_data_disk(self):
        self.mounts[1]['device'] = '8:1'
        with self.assertRaisesRegex(storage.LayoutError, 'no root-disk fallback'):
            self.plan()

    def test_pseudo_or_readonly_filesystems_are_rejected(self):
        for fstype, options in [('tmpfs', ['rw']), ('overlay', ['rw']), ('ext4', ['ro'])]:
            with self.subTest(fstype=fstype, options=options):
                self.mounts[1] = self.mount(self.disk, '8:2', fstype, options)
                with self.assertRaises(storage.LayoutError):
                    self.plan()
        self.mounts[1] = self.mount(self.disk, '8:2')
        self.mounts[1]['superOptions'] = ['ro']
        with self.assertRaisesRegex(storage.LayoutError, 'read-only'):
            self.plan()

    def test_entire_disk_and_missing_parent_are_rejected(self):
        self.source = self.disk
        with self.assertRaisesRegex(storage.LayoutError, 'dedicated subdirectory'):
            self.plan()
        self.source = self.disk / 'absent' / 'child'
        with self.assertRaisesRegex(storage.LayoutError, 'does not exist'):
            self.plan()

    def test_existing_source_data_is_allowed_without_mutation(self):
        self.source.mkdir(mode=0o750)
        file = self.source / 'dataset'
        file.write_text('data')
        file.chmod(0o600)
        self.assertFalse(self.plan()['createSource'])
        self.assertEqual(file.read_text(), 'data')
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)

    def test_nonempty_target_cannot_be_covered(self):
        self.target.mkdir()
        (self.target / 'data').write_text('existing')
        with self.assertRaisesRegex(storage.LayoutError, 'non-empty'):
            self.plan()
        self.assertEqual((self.target / 'data').read_text(), 'existing')

    def test_symlink_source_target_and_parent_are_rejected(self):
        self.source.symlink_to(self.disk)
        with self.assertRaisesRegex(storage.LayoutError, 'Symlinks'):
            self.plan()
        self.source.unlink()
        self.target.symlink_to(self.disk)
        with self.assertRaisesRegex(storage.LayoutError, 'Symlinks'):
            self.plan()
        self.target.unlink()
        alias = self.base / 'alias'
        alias.symlink_to(self.disk)
        self.source = alias / 'new'
        with self.assertRaisesRegex(storage.LayoutError, 'Symlinks'):
            self.plan()

    def test_different_target_mount_and_nested_mounts_are_rejected(self):
        self.target.mkdir()
        self.mounts.append(self.mount(self.target, '8:3'))
        with self.assertRaisesRegex(storage.LayoutError, 'different mount'):
            self.plan()
        self.mounts[-1]['target'] = str(self.target / 'nested')
        with self.assertRaisesRegex(storage.LayoutError, 'nested mount'):
            self.plan()
        self.mounts[-1]['target'] = str(self.source / 'nested')
        with self.assertRaisesRegex(storage.LayoutError, 'nested mount'):
            self.plan()

    def test_target_source_nesting_rejected(self):
        self.source = self.target / 'source'
        with self.assertRaisesRegex(storage.LayoutError, 'non-nested'):
            self.plan()

    def test_fstab_conflicts_are_not_rewritten(self):
        self.fstab.write_text('/dev/example ' + str(self.target) + ' ext4 defaults 0 2\n')
        before = self.fstab.read_bytes()
        with self.assertRaisesRegex(storage.LayoutError, 'fstab entry'):
            self.plan()
        self.assertEqual(before, self.fstab.read_bytes())

    def test_unmanaged_units_and_unit_symlinks_are_rejected(self):
        unit = self.units / 'data2.mount'
        unit.write_text('[Mount]\nWhat=/something\n')
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_nlink=1, st_uid=0)), self.assertRaisesRegex(storage.LayoutError, 'not managed'):
            storage.checked_unit(unit)
        unit.unlink()
        unit.symlink_to(self.fstab)
        with self.assertRaisesRegex(storage.LayoutError, 'Unsafe mount unit'):
            self.plan()

    def test_untrusted_or_writable_parent_is_rejected_without_chown(self):
        for uid, mode in [(1000, 0o755), (0, 0o777), (0, 0o775)]:
            with self.subTest(uid=uid, mode=mode), patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=uid, st_mode=stat.S_IFDIR | mode)), patch.object(storage.os, 'chown') as chown, self.assertRaisesRegex(storage.LayoutError, 'untrusted/writable parent'):
                self.real_trusted_parents(self.source)
            chown.assert_not_called()

    def test_explicit_administrator_uid_is_trusted_without_relaxing_write_modes(self):
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=1000, st_mode=stat.S_IFDIR | 0o755)), patch.object(storage.os, 'chown') as chown:
            self.real_trusted_parents(self.source, [1000])
        chown.assert_not_called()
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=1000, st_mode=stat.S_IFDIR | 0o777)), self.assertRaisesRegex(storage.LayoutError, 'untrusted/writable'):
            self.real_trusted_parents(self.source, [1000])

    def test_trusted_uid_assumption_is_reported_and_rechecked_on_apply(self):
        plan = storage.build_plan(self.source, target=self.target, mounts=self.mounts,
                                  fstab=self.fstab, unit_dir=self.units, trusted_parent_uids=[1000])
        self.assertEqual(plan['trustedParentUids'], [1000])
        self.assertIn('trusted host administrators', plan['trustAssumption'])
        live = self.mounts + [self.mount(self.target, '8:2')]
        with patch.object(storage.os, 'geteuid', return_value=0), patch.object(storage, 'build_plan', return_value=plan) as refresh, patch.object(storage, 'read_mounts', return_value=live), patch.object(storage.os.path, 'samefile', return_value=True), patch.object(storage, 'run_systemctl'):
            result = storage.apply_plan(plan)
        self.assertEqual(refresh.call_args.kwargs['trusted_parent_uids'], [1000])
        self.assertEqual(result['trustedParentUids'], [1000])

    def test_invalid_trust_uid_is_rejected(self):
        for uid in [-1, 0, 2**32 - 1, '1000', True]:
            with self.subTest(uid=uid), self.assertRaisesRegex(storage.LayoutError, 'administrator UID'):
                storage.build_plan(self.source, target=self.target, mounts=self.mounts, trusted_parent_uids=[uid])

    def test_unit_hardlink_and_wrong_ownership_are_rejected(self):
        for nlink, uid in [(2, 0), (1, 1000)]:
            with self.subTest(nlink=nlink, uid=uid), patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_nlink=nlink, st_uid=uid)), self.assertRaisesRegex(storage.LayoutError, 'Unsafe mount unit'):
                storage.checked_unit(self.units / 'data2.mount')

    def test_plain_absolute_paths_only(self):
        for value in ['relative', '/data/../etc', '/data//nested', '/data/%n', '/data/a b', '/data/a\nWhat=/etc']:
            with self.subTest(value=value), self.assertRaises(storage.LayoutError):
                storage.safe_path(value)

    def test_parse_mountinfo_escapes_and_optional_fields(self):
        path = self.base / 'mountinfo'
        path.write_text('31 22 8:2 / /data\\040disk rw,relatime shared:1 - ext4 /dev/sdb rw\n')
        rows = storage.read_mounts(path)
        self.assertEqual(rows[0]['target'], '/data disk')
        self.assertEqual(rows[0]['device'], '8:2')
        path.write_text('invalid\n')
        with self.assertRaisesRegex(storage.LayoutError, 'Malformed'):
            storage.read_mounts(path)

    def test_atomic_unit_update_keeps_backup_and_identical_run_does_not_rewrite(self):
        unit = self.units / 'data2.mount'
        old = storage.MARKER + '[Unit]\nDescription=old\n'
        unit.write_text(old)
        new = self.plan_content()
        real_check = storage.checked_unit
        # Temp files belong to the invoking test user, not host root.
        def check(path):
            if path.exists() and path.is_file():
                return path.read_text()
            return real_check(path)
        with patch.object(storage, 'checked_unit', side_effect=check):
            backup = storage.write_unit(unit, new)
            self.assertEqual(Path(backup).read_text(), old)
            inode = unit.stat().st_ino
            self.assertIsNone(storage.write_unit(unit, new))
            self.assertEqual(unit.stat().st_ino, inode)
        self.assertEqual(unit.read_text(), new)
        self.assertEqual(stat.S_IMODE(unit.stat().st_mode), 0o644)

    def plan_content(self):
        return storage.unit_text(self.source, self.target, str(self.disk))

    def test_apply_only_starts_target_mount_and_preserves_existing_files(self):
        plan = self.plan()
        live = self.mounts + [self.mount(self.target, '8:2')]
        with patch.object(storage.os, 'geteuid', return_value=0), patch.object(storage, 'build_plan', return_value=plan), patch.object(storage, 'read_mounts', return_value=live), patch.object(storage.os.path, 'samefile', return_value=True), patch.object(storage, 'run_systemctl') as systemctl:
            result = storage.apply_plan(plan)
        self.assertEqual(result['status'], 'mounted')
        self.assertTrue(self.source.is_dir())
        self.assertTrue(self.target.is_dir())
        self.assertEqual([call.args for call in systemctl.call_args_list], [('daemon-reload',), ('start', 'data2.mount'), ('enable', 'data2.mount')])
        self.assertEqual(self.fstab.read_text(), '# existing unrelated entry\n')

    def test_reapply_matching_bind_does_not_rewrite_unit_or_touch_data(self):
        self.source.mkdir()
        self.target.mkdir()
        data = self.source / 'dataset'
        data.write_text('unchanged')
        data.chmod(0o640)
        unit = self.units / 'data2.mount'
        unit.write_text(self.plan_content())
        before = (unit.stat().st_ino, unit.read_bytes(), data.stat().st_mode, data.stat().st_uid)
        self.mounts.append(self.mount(self.target, '8:2'))
        with patch.object(storage.os.path, 'samefile', return_value=True), patch.object(storage, 'checked_unit', return_value=unit.read_text()):
            plan = self.plan()
            self.assertTrue(plan['alreadyBound'])
            self.assertFalse(plan['unitChanged'])
            with patch.object(storage.os, 'geteuid', return_value=0), patch.object(storage, 'build_plan', return_value=plan), patch.object(storage, 'read_mounts', return_value=self.mounts), patch.object(storage, 'run_systemctl') as systemctl:
                result = storage.apply_plan(plan)
        self.assertFalse(result['changed'])
        self.assertEqual([call.args for call in systemctl.call_args_list], [('start', 'data2.mount'), ('enable', 'data2.mount')])
        self.assertEqual((unit.stat().st_ino, unit.read_bytes(), data.stat().st_mode, data.stat().st_uid), before)
        self.assertEqual(data.read_text(), 'unchanged')

    def test_failed_start_does_not_enable_mount_or_delete_source_data(self):
        self.source.mkdir()
        data = self.source / 'keep'
        data.write_text('dataset')
        plan = self.plan()
        def fail_start(*args):
            if args[0] == 'start':
                raise storage.subprocess.CalledProcessError(1, ['systemctl', *args])
        with patch.object(storage.os, 'geteuid', return_value=0), patch.object(storage, 'build_plan', return_value=plan), patch.object(storage, 'run_systemctl', side_effect=fail_start) as systemctl, self.assertRaises(storage.subprocess.CalledProcessError):
            storage.apply_plan(plan)
        self.assertNotIn(('enable', 'data2.mount'), [call.args for call in systemctl.call_args_list])
        self.assertEqual(data.read_text(), 'dataset')

    def test_changed_source_mount_aborts_before_writes(self):
        plan = self.plan()
        fresh = {**plan, 'sourceDevice': '8:9'}
        with patch.object(storage.os, 'geteuid', return_value=0), patch.object(storage, 'build_plan', return_value=fresh), patch.object(storage, 'run_systemctl') as systemctl, self.assertRaisesRegex(storage.LayoutError, 'changed since inspection'):
            storage.apply_plan(plan)
        self.assertFalse(self.source.exists())
        self.assertFalse(self.target.exists())
        systemctl.assert_not_called()

    def test_unverified_mount_is_not_enabled(self):
        plan = self.plan()
        with patch.object(storage.os, 'geteuid', return_value=0), patch.object(storage, 'build_plan', return_value=plan), patch.object(storage, 'read_mounts', return_value=self.mounts), patch.object(storage, 'run_systemctl') as systemctl, self.assertRaisesRegex(storage.LayoutError, 'no root-disk fallback'):
            storage.apply_plan(plan)
        self.assertNotIn(('enable', 'data2.mount'), [call.args for call in systemctl.call_args_list])

    def test_apply_requires_root(self):
        with patch.object(storage.os, 'geteuid', return_value=1000), self.assertRaisesRegex(storage.LayoutError, 'requires root'):
            storage.apply_plan(self.plan())


if __name__ == '__main__':
    unittest.main()
