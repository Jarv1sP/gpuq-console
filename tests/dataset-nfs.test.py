"""NFS planning/apply tests with temporary files and mocked system commands only."""
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


spec = importlib.util.spec_from_file_location('dataset_nfs', Path(__file__).resolve().parents[1] / 'deploy/dataset-nfs.py')
nfs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nfs)


class DatasetNfs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'data2'
        self.root.mkdir()
        self.cache = self.root / 'datasets'
        self.cache.mkdir(mode=0o700)
        (self.cache / 'ready').mkdir(mode=0o700)
        self.etc = self.base / 'etc'
        self.etc.mkdir()
        self.exports_dir = self.etc / 'exports.d'
        self.exports_dir.mkdir()
        self.unit_dir = self.etc / 'systemd'
        self.unit_dir.mkdir()
        self.exports = self.etc / 'exports'
        self.exports.write_text('# unrelated comments only\n')
        self.fstab = self.etc / 'fstab'
        self.fstab.write_text('')
        self.rows = [self.row('/', '8:1', '1'), self.row(self.root, '8:2', '2')]
        self.live = ''
        self.commands = []
        self.systemd_override = ''
        # macOS temporary directories may inherit the parent's group rather
        # than the process's primary group. Model the fixture's actual service
        # ownership; production still requires an exact UID/GID/mode match.
        self.user = SimpleNamespace(pw_name='cache-service', pw_uid=self.cache.stat().st_uid,
                                    pw_gid=self.cache.stat().st_gid)
        self.real_safe_text = nfs.safe_text
        self.real_trusted_info = nfs.trusted_info
        self.patches = [patch.object(nfs, 'read_mounts', side_effect=lambda: self.rows),
                        patch.object(nfs, 'device_id', return_value='8:2'),
                        patch.object(nfs, 'trusted_info'), patch.object(nfs, 'trusted_config_dir'),
                        patch.object(nfs, 'safe_text', side_effect=self.safe_text),
                        patch.object(nfs.pwd, 'getpwnam', return_value=self.user),
                        patch.object(nfs, 'run', side_effect=self.command)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    @staticmethod
    def row(target, device, mount_id, fstype='ext4', source='/dev/data', options=None, super_options=None):
        return {'target': str(target), 'device': device, 'id': mount_id, 'fstype': fstype,
                'source': source, 'options': options or ['rw'], 'superOptions': super_options or ['rw']}

    def safe_text(self, path, **kwargs):
        path = Path(path)
        if path.is_symlink():
            raise OSError('Symlink configuration refused')
        if not path.exists():
            return None
        if path.stat().st_nlink != 1:
            raise nfs.SetupError('Unsafe configuration file')
        return path.read_text()

    def command(self, args):
        self.commands.append(args)
        if args == ['exportfs', '-s']:
            return self.live
        if args[:2] == ['exportfs', '-i']:
            peer, path = args[-1].split(':', 1)
            line = path + ' ' + peer + '(' + args[3] + ')\n'
            if line not in self.live:
                self.live += line
            return ''
        if args[:3] == ['systemctl', 'show', 'nfs-server.service']:
            return 'loaded\n'
        if args[:3] == ['systemctl', 'show', nfs.UNIT_NAME]:
            return self.systemd_override
        if args == ['systemctl', 'start', nfs.UNIT_NAME] and not any(r['target'] == str(self.root / 'library') for r in self.rows):
            self.rows.append(self.row(self.root / 'library', '0:55', '55', fstype='nfs4',
                                      source='10.20.30.40:/', options=['ro', 'nosuid', 'nodev', 'noexec'],
                                      super_options=['ro', 'vers=4.2', 'proto=tcp', 'sec=sys', 'hard']))
        return ''

    def plan(self, mode='server', **kwargs):
        common = {'root': self.root, 'exports': self.exports, 'exports_dir': self.exports_dir,
                  'unit_dir': self.unit_dir, 'fstab': self.fstab}
        specific = {'peers': ['10.20.30.50'], 'service_user': 'cache-service'} if mode == 'server' else {'server': '10.20.30.40'}
        return nfs.build_plan(mode, **(common | specific | kwargs))

    def apply(self, plan):
        with patch.object(nfs.os, 'geteuid', return_value=0):
            return nfs.apply_plan(plan)

    def test_server_preview_is_read_only_and_narrow(self):
        plan = self.plan(peers=['10.20.30.50', '192.168.50.7', '10.20.30.50'])
        self.assertFalse(plan['installed'])
        self.assertEqual(plan['peers'], ['10.20.30.50', '192.168.50.7'])
        self.assertEqual(list(self.exports_dir.iterdir()), [])
        self.assertIn('ro,root_squash,sync,no_subtree_check,secure,sec=sys,fsid=0', plan['content'])
        self.assertIn('mp=' + str(self.root), plan['content'])
        self.assertNotIn('no_root_squash', plan['content'])
        self.assertNotIn('*', plan['content'])
        self.assertFalse(any('start' in c or 'enable' in c for c in self.commands))

    def test_client_preview_is_readonly_with_fixed_source_and_safe_unit(self):
        plan = self.plan('client')
        self.assertEqual(plan['target'], str(self.root / 'library'))
        self.assertEqual(plan['sourcePattern'], str(self.root / 'library/<dataset>/<sha256>/data'))
        self.assertIn('What=10.20.30.40:/', plan['content'])
        self.assertIn('vers=4.2,proto=tcp,sec=sys,ro,nosuid,nodev,noexec,hard', plan['content'])
        self.assertIn('AssertPathIsMountPoint=' + str(self.root), plan['content'])
        self.assertFalse((self.root / 'library').exists())

    def test_cli_preview_default_never_calls_apply(self):
        with patch.object(nfs, 'build_plan', return_value={'mode': 'client'}), patch.object(nfs, 'apply_plan') as apply, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(nfs.main(['client', '--server', '10.20.30.40']), 0)
        self.assertTrue(json.loads(out.getvalue())['dryRun'])
        apply.assert_not_called()

    def test_only_explicit_rfc1918_hosts_are_accepted(self):
        for value in ['10.0.0.2', '172.16.0.1', '172.31.255.2', '192.168.5.2']:
            self.assertEqual(nfs.private_ipv4(value), value)
        for value in ['0.0.0.0', '127.0.0.1', '169.254.1.1', '100.64.0.1', '192.0.2.4', '8.8.8.8', '172.32.0.1', '::1', '10.2.0.0/16', '*', 'example.test', '10.0.0.1\n(rw)']:
            with self.subTest(value=value), self.assertRaises(nfs.SetupError):
                nfs.private_ipv4(value)

    def test_server_requires_explicit_peer_and_nonroot_cache_account(self):
        with self.assertRaisesRegex(nfs.SetupError, 'explicit --peer'):
            self.plan(peers=[])
        with patch.object(nfs.pwd, 'getpwnam', side_effect=KeyError), self.assertRaisesRegex(nfs.SetupError, 'service-user'):
            self.plan()
        with patch.object(nfs.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=0)), self.assertRaisesRegex(nfs.SetupError, 'must not be root'):
            self.plan()

    def test_exact_mounted_local_nonroot_writable_data_disk_required(self):
        cases = [([], 'exact active mount'), ([self.row(self.root, '8:1', '2')], 'root device'),
                 ([self.row(self.root, '8:2', '2', fstype='nfs4')], 'local data'),
                 ([self.row(self.root, '8:2', '2', options=['ro'])], 'writable'),
                 ([self.row(self.root, '8:2', '2', super_options=['ro'])], 'writable')]
        for rows, message in cases:
            with self.subTest(message=message):
                self.rows = [self.row('/', '8:1', '1')] + rows
                with self.assertRaisesRegex(nfs.SetupError, message):
                    self.plan()

    def test_device_fd_must_match_mount_table(self):
        with patch.object(nfs, 'device_id', return_value='8:99'), self.assertRaisesRegex(nfs.SetupError, 'does not match'):
            self.plan()

    def test_symlink_data_root_and_dataset_ancestors_rejected(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.root)
        with self.assertRaises(OSError):
            self.plan(root=alias)
        (self.cache / 'ready').rmdir()
        (self.cache / 'ready').symlink_to(self.root)
        with self.assertRaises(OSError):
            self.plan()

    def test_publish_tree_not_created_or_permission_repaired(self):
        (self.cache / 'ready').rmdir()
        with self.assertRaises(FileNotFoundError):
            self.plan()
        (self.cache / 'ready').mkdir(mode=0o755)
        (self.cache / 'ready').chmod(0o755)
        with patch.object(nfs.os, 'chmod') as chmod, patch.object(nfs.os, 'chown') as chown, self.assertRaisesRegex(nfs.SetupError, '0700'):
            self.plan()
        chmod.assert_not_called()
        chown.assert_not_called()

    def test_publish_submount_rejected(self):
        self.rows.append(self.row(self.cache / 'ready/other', '8:3', '3'))
        with self.assertRaisesRegex(nfs.SetupError, 'another mount'):
            self.plan()

    def test_export_config_conflicts_and_broad_existing_exports_rejected(self):
        for target in [self.exports, self.exports_dir / 'someone.exports']:
            target.write_text('/home *(rw)\n')
            with self.subTest(path=target), self.assertRaisesRegex(nfs.SetupError, 'Unrelated'):
                self.plan()
            target.write_text('')
        (self.exports_dir / nfs.EXPORT_NAME).write_text(nfs.MARKER + '/other 10.1.1.1(ro)\n')
        with self.assertRaisesRegex(nfs.SetupError, 'differs'):
            self.plan()

    def test_live_export_without_owned_config_rejected(self):
        self.live = str(self.cache / 'ready') + ' 10.20.30.50(ro)\n'
        with self.assertRaisesRegex(nfs.SetupError, 'not owned'):
            self.plan()

    def test_live_export_foreign_peer_path_or_options_rejected(self):
        plan = self.plan()
        Path(plan['config']).write_text(plan['content'])
        for text in ['/other 10.20.30.50(ro)\n', str(self.cache / 'ready') + ' *(ro)\n', str(self.cache / 'ready') + ' 10.20.30.50(rw,no_root_squash)\n']:
            self.live = text
            with self.subTest(text=text), self.assertRaises(nfs.SetupError):
                self.plan()

    def test_server_applies_only_scoped_export_and_is_idempotent(self):
        (self.cache / 'ready/keep').write_bytes(b'untouched')
        before = {p: (p.stat().st_mode, p.stat().st_uid, p.stat().st_ino) for p in [self.root, self.cache, self.cache / 'ready']}
        result = self.apply(self.plan())
        self.assertEqual(result['status'], 'configured')
        self.assertFalse(result['dataPermissionsChanged'])
        self.assertTrue(Path(result['config']).exists())
        self.assertEqual(Path(result['config']).stat().st_nlink, 1)
        self.assertTrue(any(c[:2] == ['exportfs', '-i'] for c in self.commands))
        self.assertFalse(any(any(v in c for v in ['-ra', '-a', '-f', 'restart']) for c in self.commands))
        inode = Path(result['config']).stat().st_ino
        self.apply(self.plan())
        self.assertEqual(Path(result['config']).stat().st_ino, inode)
        self.assertEqual((self.cache / 'ready/keep').read_bytes(), b'untouched')
        self.assertEqual(before, {p: (p.stat().st_mode, p.stat().st_uid, p.stat().st_ino) for p in before})

    def test_changed_peer_set_requires_manual_review_without_changes(self):
        self.apply(self.plan())
        existing = (self.exports_dir / nfs.EXPORT_NAME).read_bytes()
        with self.assertRaisesRegex(nfs.SetupError, 'differs'):
            self.plan(peers=['10.20.30.51'])
        self.assertEqual((self.exports_dir / nfs.EXPORT_NAME).read_bytes(), existing)

    def test_client_does_not_cover_nonempty_path_file_or_symlink(self):
        target = self.root / 'library'
        target.mkdir()
        (target / 'keep').write_text('keep')
        with self.assertRaisesRegex(nfs.SetupError, 'not empty'):
            self.plan('client')
        (target / 'keep').unlink()
        target.rmdir()
        target.symlink_to(self.cache)
        with self.assertRaisesRegex(nfs.SetupError, 'symlink'):
            self.plan('client')
        target.unlink()
        target.write_text('keep')
        with self.assertRaisesRegex(nfs.SetupError, 'symlink or file'):
            self.plan('client')

    def test_client_fstab_dropin_and_shadow_unit_rejected(self):
        self.fstab.write_text('10.1.1.1:/ ' + str(self.root / 'library') + ' nfs ro 0 0\n')
        with self.assertRaisesRegex(nfs.SetupError, 'fstab'):
            self.plan('client')
        self.fstab.write_text('')
        for value in ['DropInPaths=/etc/systemd/system/data2-library.mount.d/unsafe.conf', 'FragmentPath=/run/systemd/system/data2-library.mount']:
            self.systemd_override = value
            with self.subTest(value=value), self.assertRaisesRegex(nfs.SetupError, 'override/drop-in'):
                self.plan('client')

    def test_client_mount_verified_before_enable(self):
        result = self.apply(self.plan('client'))
        self.assertEqual(result['status'], 'configured')
        self.assertIn(['systemctl', 'start', nfs.UNIT_NAME], self.commands)
        self.assertIn(['systemctl', 'enable', nfs.UNIT_NAME], self.commands)
        self.assertTrue((self.root / 'library').is_dir())
        inode = Path(result['config']).stat().st_ino
        self.apply(self.plan('client'))
        self.assertEqual(Path(result['config']).stat().st_ino, inode)

    def test_client_mount_failure_is_not_success_and_does_not_enable(self):
        plan = self.plan('client')
        with patch.object(nfs, 'check_library_mount', return_value=False), self.assertRaisesRegex(nfs.SetupError, 'not active'):
            self.apply(plan)
        self.assertNotIn(['systemctl', 'enable', nfs.UNIT_NAME], self.commands)
        self.assertTrue(Path(plan['config']).exists())  # explicit partial state, never destructive rollback

    def test_unsafe_existing_mount_or_nested_mount_rejected(self):
        target = self.root / 'library'
        self.rows.append(self.row(target, '0:55', '55', fstype='nfs4', source='10.20.30.40:/'))
        with self.assertRaisesRegex(nfs.SetupError, 'unsafe options'):
            self.plan('client')
        self.rows.pop()
        self.rows.append(self.row(target / 'nested', '8:3', '3'))
        with self.assertRaisesRegex(nfs.SetupError, 'Nested mount'):
            self.plan('client')

    def test_changed_mount_between_plan_and_apply_prevents_writes(self):
        plan = self.plan()
        self.rows[-1]['id'] = '999'
        with self.assertRaisesRegex(nfs.SetupError, 'changed after preview'):
            self.apply(plan)
        self.assertFalse(Path(plan['config']).exists())

    def test_apply_requires_root(self):
        with patch.object(nfs.os, 'geteuid', return_value=123), self.assertRaisesRegex(nfs.SetupError, 'requires root'):
            nfs.apply_plan(self.plan())

    def test_no_permission_repair_and_trusted_parent_owner_rules(self):
        self.real_trusted_info(SimpleNamespace(st_uid=1000, st_mode=stat.S_IFDIR | 0o755), [1000])
        for uid, mode in [(1000, 0o755), (0, 0o775), (0, 0o777)]:
            with self.subTest(uid=uid, mode=mode), self.assertRaises(nfs.SetupError):
                self.real_trusted_info(SimpleNamespace(st_uid=uid, st_mode=stat.S_IFDIR | mode))

    def test_config_symlink_or_hardlink_rejected(self):
        path = self.exports_dir / nfs.EXPORT_NAME
        path.symlink_to(self.exports)
        with self.assertRaises(OSError):
            self.plan()
        path.unlink()
        os.link(self.exports, path)
        with self.assertRaisesRegex(nfs.SetupError, 'Unsafe'):
            self.plan()

    def test_uninstalled_server_package_is_explicit_error(self):
        def run(args):
            return 'not-found\n' if 'nfs-server.service' in args else ''
        with patch.object(nfs, 'run', side_effect=run), self.assertRaisesRegex(nfs.SetupError, 'Install the NFS server'):
            self.plan()

    def test_live_conflicting_unsafe_option_never_accepted(self):
        plan = self.plan()
        Path(plan['config']).write_text(plan['content'])
        for option in ['rw', 'no_root_squash', 'async', 'insecure', 'crossmnt', 'nohide']:
            self.live = str(self.cache / 'ready') + ' 10.20.30.50(' + plan['options'] + ',' + option + ')\n'
            with self.subTest(option=option), self.assertRaisesRegex(nfs.SetupError, 'options differ'):
                self.plan()

    def test_export_failure_never_reports_success_or_enables_service(self):
        plan = self.plan()
        def fail_export(args):
            if args[:2] == ['exportfs', '-i']:
                raise nfs.SetupError('export failed')
            return self.command(args)
        with patch.object(nfs, 'run', side_effect=fail_export), self.assertRaisesRegex(nfs.SetupError, 'export failed'):
            self.apply(plan)
        self.assertNotIn(['systemctl', 'enable', 'nfs-server.service'], self.commands)
        self.assertTrue(Path(plan['config']).exists())

    def test_empty_post_apply_exports_never_enables_service(self):
        plan = self.plan()
        def drop_export(args):
            if args[:2] == ['exportfs', '-i']:
                return ''
            return self.command(args)
        with patch.object(nfs, 'run', side_effect=drop_export), self.assertRaisesRegex(nfs.SetupError, 'Not all requested peers'):
            self.apply(plan)
        self.assertNotIn(['systemctl', 'enable', 'nfs-server.service'], self.commands)

    def test_atomic_config_creation_never_overwrites_different_file(self):
        path = self.exports_dir / nfs.EXPORT_NAME
        path.write_text('existing\n')
        with self.assertRaisesRegex(nfs.SetupError, 'differs'):
            nfs.create_config(path, 'new\n')
        self.assertEqual(path.read_text(), 'existing\n')
        self.assertEqual(sorted(p.name for p in self.exports_dir.iterdir()), [nfs.EXPORT_NAME])

    def test_readonly_fstab_exception_accepts_root_group_only_without_chmod(self):
        self.fstab.write_text('# keep existing fstab\n')
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o664, st_nlink=1, st_uid=0, st_gid=0, st_size=22)
        with patch.object(nfs.os, 'fstat', return_value=info), patch.object(nfs, 'root_group_is_administrative', return_value=True), patch.object(nfs.os, 'chmod') as chmod:
            self.assertEqual(self.real_safe_text(self.fstab, allow_root_group_write=True), '# keep existing fstab\n')
            with self.assertRaisesRegex(nfs.SetupError, 'Unsafe'):
                self.real_safe_text(self.fstab)  # writable managed configs remain strict
        chmod.assert_not_called()

    def test_readonly_fstab_exception_rejects_nonroot_group_or_members(self):
        for gid, trusted, mode in [(1000, True, 0o664), (0, False, 0o664), (0, True, 0o666), (0, True, 0o2664)]:
            info = SimpleNamespace(st_mode=stat.S_IFREG | mode, st_nlink=1, st_uid=0, st_gid=gid, st_size=0)
            with self.subTest(gid=gid, mode=mode, trusted=trusted), patch.object(nfs.os, 'fstat', return_value=info), patch.object(nfs, 'root_group_is_administrative', return_value=trusted), self.assertRaisesRegex(nfs.SetupError, 'Unsafe'):
                self.real_safe_text(self.fstab, allow_root_group_write=True)

    def test_gid_zero_membership_check_covers_primary_and_supplementary_users(self):
        root = SimpleNamespace(pw_uid=0, pw_gid=0)
        ordinary = SimpleNamespace(pw_uid=1000, pw_gid=1000)
        with patch.object(nfs.grp, 'getgrgid', return_value=SimpleNamespace(gr_gid=0, gr_mem=[])), patch.object(nfs.pwd, 'getpwall', return_value=[root, ordinary]):
            self.assertTrue(nfs.root_group_is_administrative())
        with patch.object(nfs.grp, 'getgrgid', return_value=SimpleNamespace(gr_gid=0, gr_mem=['member'])), patch.object(nfs.pwd, 'getpwall', return_value=[root, ordinary]), patch.object(nfs.pwd, 'getpwnam', return_value=ordinary):
            self.assertFalse(nfs.root_group_is_administrative())
        with patch.object(nfs.grp, 'getgrgid', return_value=SimpleNamespace(gr_gid=0, gr_mem=[])), patch.object(nfs.pwd, 'getpwall', return_value=[root, SimpleNamespace(pw_uid=1000, pw_gid=0)]):
            self.assertFalse(nfs.root_group_is_administrative())
        with patch.object(nfs.grp, 'getgrgid', side_effect=KeyError):
            self.assertFalse(nfs.root_group_is_administrative())


if __name__ == '__main__':
    unittest.main()
