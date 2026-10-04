"""Exercise data-root preparation without real mounts, root, SSH, or services."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('prepare_data_root', Path(__file__).resolve().parents[1] / 'deploy/prepare-data-root.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareDataRoot(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'data2'
        self.root.mkdir()
        # BSD/macOS children inherit the parent's group rather than egid.
        # This synthetic data volume represents the current service group.
        os.chown(self.root, -1, os.getgid())
        self.cache = self.root / 'datasets'
        self.identity = {'user': 'dataset-service', 'uid': os.getuid(), 'group': 'dataset-group', 'gid': os.getgid()}
        self.mounts = [self.mount('/', '8:1', '1'), self.mount(self.root, '8:2', '2')]
        self.real_read_mounts = prepare.read_mounts
        self.patches = [patch.object(prepare, 'resolve_service', return_value=self.identity),
                        patch.object(prepare, 'read_mounts', side_effect=lambda: self.mounts),
                        patch.object(prepare, 'device_id', return_value='8:2'),
                        patch.object(prepare, 'check_parent')]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    @staticmethod
    def mount(target, device, mount_id, fstype='ext4', options=None):
        return {'id': mount_id, 'target': str(target), 'device': device, 'fstype': fstype,
                'options': options or ['rw'], 'superOptions': ['rw']}

    def plan(self):
        return prepare.build_plan('dataset-service', root=self.root)

    def test_preview_writes_nothing_and_reports_service_config(self):
        plan = self.plan()
        self.assertEqual(plan['action'], 'create')
        self.assertEqual(plan['cacheConfig'], {'root': str(self.cache), 'serviceUid': os.getuid(), 'serviceGid': os.getgid()})
        self.assertFalse(self.cache.exists())

    def test_cli_defaults_to_preview(self):
        with patch.object(prepare, 'build_plan', return_value={'action': 'create'}), patch.object(prepare, 'apply_plan') as apply, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(prepare.main(['--service-user', 'dataset-service']), 0)
        self.assertTrue(json.loads(out.getvalue())['dryRun'])
        apply.assert_not_called()

    def test_missing_exact_mount_is_rejected(self):
        self.mounts.pop()
        with self.assertRaisesRegex(prepare.PreparationError, 'exact active mount'):
            self.plan()
        self.assertFalse(self.cache.exists())

    def test_parent_mount_is_not_enough(self):
        self.mounts[-1]['target'] = str(self.root.parent)
        with self.assertRaisesRegex(prepare.PreparationError, 'exact active mount'):
            self.plan()

    def test_root_device_alias_pseudo_and_network_filesystems_are_rejected(self):
        for device, fstype in [('8:1', 'ext4'), ('8:2', 'tmpfs'), ('8:2', 'overlay'), ('8:2', 'nfs4')]:
            with self.subTest(device=device, fstype=fstype):
                self.mounts[-1].update(device=device, fstype=fstype)
                with self.assertRaisesRegex(prepare.PreparationError, 'local data filesystem'):
                    self.plan()

    def test_readonly_mount_and_superblock_are_rejected(self):
        for key in ('options', 'superOptions'):
            with self.subTest(key=key):
                self.mounts[-1][key] = ['ro']
                with self.assertRaisesRegex(prepare.PreparationError, 'read-only'):
                    self.plan()
                self.mounts[-1][key] = ['rw']

    def test_opened_device_must_match_mount_table(self):
        with patch.object(prepare, 'device_id', return_value='8:3'), self.assertRaisesRegex(prepare.PreparationError, 'no longer matches'):
            self.plan()

    def test_cache_submount_and_nested_submount_are_rejected(self):
        for path in [self.cache, self.cache / 'nested']:
            with self.subTest(path=path):
                self.mounts.append(self.mount(path, '8:3', '3'))
                with self.assertRaisesRegex(prepare.PreparationError, 'submount'):
                    self.plan()
                self.mounts.pop()

    def test_non_cache_submount_is_not_changed_or_rejected(self):
        self.mounts.append(self.mount(self.root / 'unrelated', '8:3', '3'))
        self.assertEqual(self.plan()['action'], 'create')

    def test_existing_matching_directory_and_data_are_preserved(self):
        self.cache.mkdir(mode=0o700)
        file = self.cache / 'existing-dataset'
        file.write_bytes(b'do not modify')
        file.chmod(0o440)
        snapshot = (file.read_bytes(), file.stat().st_mode, file.stat().st_uid, self.cache.stat().st_ino)
        plan = self.plan()
        with patch.object(prepare.os, 'geteuid', return_value=0), patch.object(prepare.os, 'fchown') as chown, patch.object(prepare.os, 'fchmod') as chmod:
            result = prepare.apply_plan(plan)
        self.assertFalse(result['changed'])
        chown.assert_not_called()
        chmod.assert_not_called()
        self.assertEqual((file.read_bytes(), file.stat().st_mode, file.stat().st_uid, self.cache.stat().st_ino), snapshot)

    def test_existing_wrong_mode_is_not_repaired(self):
        self.cache.mkdir(mode=0o755)
        self.cache.chmod(0o755)  # Explicit unsafe fixture even under umask 077.
        with patch.object(prepare.os, 'fchmod') as chmod, self.assertRaisesRegex(prepare.PreparationError, 'no automatic chown/chmod'):
            self.plan()
        chmod.assert_not_called()
        self.assertEqual(stat.S_IMODE(self.cache.stat().st_mode), 0o755)

    def test_existing_wrong_owner_or_group_is_not_repaired(self):
        self.cache.mkdir(mode=0o700)
        for field in ('uid', 'gid'):
            identity = {**self.identity, field: self.identity[field] + 1}
            with self.subTest(field=field), patch.object(prepare, 'resolve_service', return_value=identity), patch.object(prepare.os, 'fchown') as chown, self.assertRaisesRegex(prepare.PreparationError, 'differs'):
                self.plan()
            chown.assert_not_called()

    def test_symlink_cache_and_regular_file_are_rejected(self):
        self.cache.symlink_to(self.root)
        with self.assertRaisesRegex(prepare.PreparationError, 'not a real directory'):
            self.plan()
        self.cache.unlink()
        self.cache.write_text('keep')
        with self.assertRaisesRegex(prepare.PreparationError, 'not a real directory'):
            self.plan()
        self.assertEqual(self.cache.read_text(), 'keep')

    def test_root_and_ancestor_symlinks_are_not_followed(self):
        alias = self.root.parent / 'alias'
        alias.symlink_to(self.root)
        for path in (alias, alias / 'child'):
            with self.subTest(path=path), self.assertRaises(OSError):
                with prepare.directory(path):
                    pass

    def test_missing_root_does_not_get_created(self):
        self.root.rmdir()
        with self.assertRaises(FileNotFoundError):
            self.plan()
        self.assertFalse(self.root.exists())

    def test_new_directory_only_is_owned_and_permissioned(self):
        plan = self.plan()
        original = self.root.stat()
        with patch.object(prepare.os, 'geteuid', return_value=0), patch.object(prepare.os, 'fchown') as chown:
            result = prepare.apply_plan(plan)
        self.assertTrue(result['changed'])
        self.assertEqual(len(chown.call_args_list), 1)
        self.assertEqual(chown.call_args.args[1:], (self.identity['uid'], self.identity['gid']))
        self.assertEqual(stat.S_IMODE(self.cache.stat().st_mode), 0o700)
        self.assertEqual((self.root.stat().st_uid, self.root.stat().st_gid, self.root.stat().st_mode), (original.st_uid, original.st_gid, original.st_mode))
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_apply_requires_root(self):
        with patch.object(prepare.os, 'geteuid', return_value=1000), self.assertRaisesRegex(prepare.PreparationError, 'requires root'):
            prepare.apply_plan(self.plan())

    def test_mount_change_before_apply_writes_nothing(self):
        plan = self.plan()
        self.mounts[-1]['id'] = '99'
        with patch.object(prepare.os, 'geteuid', return_value=0), self.assertRaisesRegex(prepare.PreparationError, 'changed after preview'):
            prepare.apply_plan(plan)
        self.assertFalse(self.cache.exists())

    def test_service_identity_change_before_apply_writes_nothing(self):
        plan = self.plan()
        with patch.object(prepare.os, 'geteuid', return_value=0), patch.object(prepare, 'resolve_service', return_value={**self.identity, 'uid': 12345}), self.assertRaisesRegex(prepare.PreparationError, 'identity changed'):
            prepare.apply_plan(plan)
        self.assertFalse(self.cache.exists())

    def test_mount_removed_after_creation_does_not_claim_success_or_delete_data(self):
        plan = self.plan()
        real_mkdir = os.mkdir
        def remove_mount(name, mode=0o777, *, dir_fd=None):
            real_mkdir(name, mode, dir_fd=dir_fd)
            self.mounts.pop()
        with patch.object(prepare.os, 'geteuid', return_value=0), patch.object(prepare.os, 'mkdir', side_effect=remove_mount), patch.object(prepare.os, 'fchown'), self.assertRaisesRegex(prepare.PreparationError, 'exact active mount'):
            prepare.apply_plan(plan)
        self.assertTrue(self.cache.is_dir())

    def test_mountinfo_parse_and_bad_input(self):
        path = self.root / 'mountinfo'
        path.write_text('15 1 8:2 / /data\\040disk rw shared:3 - ext4 /dev/example rw\n')
        rows = self.real_read_mounts(path)
        self.assertEqual(rows[0]['target'], '/data disk')
        self.assertEqual(rows[0]['id'], '15')
        path.write_text('bad\n')
        with self.assertRaisesRegex(prepare.PreparationError, 'Malformed'):
            self.real_read_mounts(path)

    def test_trust_input_validation(self):
        self.assertEqual(prepare.validated_trust([1000, 1000]), [1000])
        for value in [0, -1, '1000', True, 2**32 - 1]:
            with self.subTest(value=value), self.assertRaises(prepare.PreparationError):
                prepare.validated_trust([value])


class ServiceAndParentChecks(unittest.TestCase):
    def test_service_resolution_primary_or_explicit_group(self):
        user = SimpleNamespace(pw_name='service', pw_uid=1234, pw_gid=5678)
        primary = SimpleNamespace(gr_name='service', gr_gid=5678)
        other = SimpleNamespace(gr_name='cache', gr_gid=9012)
        with patch.object(prepare.pwd, 'getpwnam', return_value=user), patch.object(prepare.grp, 'getgrgid', return_value=primary), patch.object(prepare.grp, 'getgrnam', return_value=other):
            self.assertEqual(prepare.resolve_service('service')['gid'], 5678)
            self.assertEqual(prepare.resolve_service('service', 'cache')['gid'], 9012)

    def test_missing_service_is_not_created(self):
        with patch.object(prepare.pwd, 'getpwnam', side_effect=KeyError()), self.assertRaisesRegex(prepare.PreparationError, 'no account will be created'):
            prepare.resolve_service('missing')

    def test_parent_uid_requires_explicit_trust_and_is_never_chowned(self):
        owner = SimpleNamespace(st_uid=1000, st_mode=stat.S_IFDIR | 0o755)
        with self.assertRaisesRegex(prepare.PreparationError, 'trusted owner'):
            prepare.check_parent(owner, [])
        prepare.check_parent(owner, [1000])
        with self.assertRaisesRegex(prepare.PreparationError, 'trusted owner'):
            prepare.check_parent(SimpleNamespace(st_uid=1000, st_mode=stat.S_IFDIR | 0o777), [1000])
        prepare.check_parent(SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755), [])


if __name__ == '__main__':
    unittest.main()
