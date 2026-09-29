"""Project upgrade preflight/ordering tests: synthetic files, no node services."""
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


spec = importlib.util.spec_from_file_location('upgrade_projects', Path(__file__).resolve().parents[1] / 'deploy/upgrade-projects.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeProjects(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.dest, self.source = self.base / 'node', self.base / 'source'
        self.root, self.conda = self.base / 'workspaces', self.base / 'conda'
        for directory in (self.dest, self.source, self.root, self.conda):
            directory.mkdir(mode=0o700)
        self.config = self.dest / 'node-config.json'
        self.config.write_text(json.dumps({'root': str(self.root), 'conda': str(self.conda),
                                         'gpu': '/operator/approved/bin/gpu', 'database': str(self.base / 'gpuq.db'),
                                         'hostRoot': True, 'futureSetting': {'keep': 'unchanged'}}, indent=3) + '\n\n')
        self.config.chmod(0o600)
        self.old, self.new = {}, {}
        for name in upgrade.FILES:
            self.new[name] = ('# new ' + name + '\nVALUE = 2\n').encode()
            (self.source / name).write_bytes(self.new[name])
            if name in ('sandbox-runner.py', 'node-executor.py'):
                self.old[name] = ('# old ' + name + '\nVALUE = 1\n').encode()
                (self.dest / name).write_bytes(self.old[name])
                (self.dest / name).chmod(0o700)
        self.sentinel_paths = [self.base / 'gpuq.db', self.dest / 'terminal-helper.py',
                               self.root / 'users/existing/data', self.root / 'jobs/existing.json']
        for path in self.sentinel_paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'Existing opaque state: must not change\n')

    def run_main(self, apply=False, directory=None, source=None):
        arguments = ['--directory', str(directory or self.dest), '--source', str(source or self.source)]
        if apply:
            arguments.append('--apply')
        with contextlib.redirect_stdout(io.StringIO()) as output:
            upgrade.main(arguments)
        return json.loads(output.getvalue())

    def snapshot(self, directory=None):
        directory = directory or self.dest
        return {str(path.relative_to(directory)): (path.read_bytes(), path.stat().st_ino, stat.S_IMODE(path.stat().st_mode))
                for path in directory.rglob('*') if path.is_file() and not path.is_symlink()}

    def test_preview_is_default_and_writes_nothing(self):
        before = self.snapshot()
        result = self.run_main()
        self.assertTrue(result['dryRun'])
        self.assertTrue(result['configurationUnchanged'])
        self.assertTrue(result['schedulerUnchanged'])
        self.assertFalse(result['restartRequired'])
        self.assertEqual(before, self.snapshot())
        self.assertEqual(len(list(self.dest.glob('before-projects-*'))), 0)

    def test_config_bytes_inode_mode_and_all_existing_state_unchanged(self):
        before = (self.config.read_bytes(), self.config.stat().st_ino, self.config.stat().st_mode)
        sentinels = {path: (path.read_bytes(), path.stat().st_ino) for path in self.sentinel_paths}
        result = self.run_main(apply=True)
        self.assertEqual(before, (self.config.read_bytes(), self.config.stat().st_ino, self.config.stat().st_mode))
        self.assertEqual(sentinels, {path: (path.read_bytes(), path.stat().st_ino) for path in self.sentinel_paths})
        self.assertTrue(result['upgraded'])
        for name in upgrade.FILES:
            self.assertEqual((self.dest / name).read_bytes(), self.new[name])
            self.assertEqual(stat.S_IMODE((self.dest / name).stat().st_mode), 0o700)

    def test_backup_is_complete_private_and_contains_original_config_bytes(self):
        original = self.config.read_bytes()
        result = self.run_main(apply=True)
        backup = Path(result['backup'])
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o700)
        self.assertEqual(set(path.name for path in backup.iterdir()), {*self.old, 'node-config.json'})
        self.assertEqual((backup / 'node-config.json').read_bytes(), original)
        self.assertEqual(stat.S_IMODE((backup / 'node-config.json').stat().st_mode), 0o600)
        for name, value in self.old.items():
            self.assertEqual((backup / name).read_bytes(), value)
            self.assertEqual(stat.S_IMODE((backup / name).stat().st_mode), 0o700)
        self.assertEqual(list(self.dest.rglob('.project-upgrade-*')), [])

    def test_dependencies_are_durable_before_dispatcher_install(self):
        installed = []
        actual = upgrade.atomic_copy
        def inspect(source, destination, **kwargs):
            if destination.parent == self.dest:
                if destination.name == 'node-executor.py':
                    self.assertEqual(installed, ['project-store.py', 'project-ops.py', 'sandbox-runner.py'])
                    for name in installed:
                        self.assertEqual((self.dest / name).read_bytes(), self.new[name])
                installed.append(destination.name)
            return actual(source, destination, **kwargs)
        with patch.object(upgrade, 'atomic_copy', side_effect=inspect):
            self.run_main(apply=True)
        self.assertEqual(installed, list(upgrade.FILES))

    def test_compile_failure_in_last_file_prevents_every_change_and_backup(self):
        (self.source / 'node-executor.py').write_text('def syntax error!\n')
        before = self.snapshot()
        with self.assertRaises(SyntaxError):
            self.run_main(apply=True)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(list(self.dest.glob('before-projects-*')), [])

    def test_preflight_never_executes_source_or_restarts_services(self):
        sentinel = self.base / 'must-not-exist'
        (self.source / 'project-store.py').write_text('open(' + repr(str(sentinel)) + ',"w").write("bad")\nraise RuntimeError("must not import")\n')
        with patch.object(os, 'system', side_effect=AssertionError('must not launch commands')), patch('subprocess.run', side_effect=AssertionError('must not restart services')), patch('subprocess.Popen', side_effect=AssertionError('must not restart services')):
            result = self.run_main(apply=True)
        self.assertFalse(sentinel.exists())
        self.assertTrue(result['schedulerUnchanged'])

    def test_installed_bytes_are_same_pinned_bytes_that_were_compiled(self):
        actual = upgrade.atomic_copy
        changed = False
        def mutate_after_compile(source, destination, **kwargs):
            nonlocal changed
            if not changed:
                changed = True
                for name in upgrade.FILES:
                    (self.source / name).write_text('uncompiled invalid syntax !!!')
            return actual(source, destination, **kwargs)
        with patch.object(upgrade, 'atomic_copy', side_effect=mutate_after_compile):
            self.run_main(apply=True)
        for name in upgrade.FILES:
            self.assertEqual((self.dest / name).read_bytes(), self.new[name])

    def test_source_symlink_and_source_parent_symlink_rejected(self):
        source = self.source / 'project-store.py'
        source.unlink()
        source.symlink_to(self.source / 'project-ops.py')
        with self.assertRaises(OSError):
            self.run_main(apply=True)
        source.unlink()
        source.write_bytes(self.new['project-store.py'])
        alias = self.base / 'source-alias'
        alias.symlink_to(self.source)
        with self.assertRaises(OSError):
            self.run_main(apply=True, source=alias)

    def test_destination_symlink_and_ancestor_symlink_rejected(self):
        alias = self.base / 'node-alias'
        alias.symlink_to(self.dest)
        with self.assertRaises(OSError):
            self.run_main(apply=True, directory=alias)
        parent_alias = self.base / 'parent-alias'
        parent_alias.symlink_to(self.base)
        with self.assertRaises(OSError):
            self.run_main(apply=True, directory=parent_alias / 'node')

    def test_config_and_existing_dangling_symlinks_are_never_overwritten(self):
        config_data = self.config.read_bytes()
        target = self.base / 'real-config'
        target.write_bytes(config_data)
        target.chmod(0o600)
        self.config.unlink()
        self.config.symlink_to(target)
        with self.assertRaises(OSError):
            self.run_main(apply=True)
        self.config.unlink()
        self.config.write_bytes(config_data)
        self.config.chmod(0o600)
        (self.dest / 'project-store.py').symlink_to(self.base / 'missing')
        with self.assertRaises(OSError):
            self.run_main(apply=True)
        self.assertTrue((self.dest / 'project-store.py').is_symlink())

    def test_hardlinked_source_config_or_existing_program_rejected(self):
        for path in (self.source / 'project-store.py', self.config, self.dest / 'node-executor.py'):
            link = self.base / 'hardlink'
            with self.subTest(path=path.name):
                os.link(path, link)
                with self.assertRaisesRegex(SystemExit, 'Unsafe'):
                    self.run_main(apply=True)
                link.unlink()

    def test_writable_source_existing_program_and_nonprivate_config_rejected(self):
        cases = [(self.source / 'project-store.py', 0o664), (self.dest / 'node-executor.py', 0o775), (self.config, 0o644)]
        for path, mode in cases:
            before = stat.S_IMODE(path.stat().st_mode)
            path.chmod(mode)
            with self.subTest(path=path.name), self.assertRaisesRegex(SystemExit, 'Unsafe'):
                self.run_main(apply=True)
            path.chmod(before)

    def test_source_or_node_directory_group_write_rejected(self):
        for path, mode in ((self.source, 0o775), (self.dest, 0o750)):
            path.chmod(mode)
            with self.subTest(path=path.name), self.assertRaisesRegex(SystemExit, 'Unsafe directory'):
                self.run_main(apply=True)
            path.chmod(0o700)

    def test_foreign_file_owner_rejected(self):
        real = os.fstat
        def wrong_owner(fd):
            info = real(fd)
            if stat.S_ISREG(info.st_mode):
                fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
                values = {name: getattr(info, name) for name in fields}
                values['st_uid'] = os.getuid() + 1
                return SimpleNamespace(**values)
            return info
        with patch.object(upgrade.os, 'fstat', side_effect=wrong_owner), self.assertRaisesRegex(SystemExit, 'Unsafe'):
            self.run_main(apply=True)

    def test_root_invocation_rejected_before_writes(self):
        before = self.snapshot()
        with patch.object(upgrade.os, 'getuid', return_value=0), self.assertRaisesRegex(SystemExit, 'not root'):
            self.run_main(apply=True)
        self.assertEqual(before, self.snapshot())

    def test_relative_traversal_root_and_missing_conda_rejected(self):
        for value in ('relative', '/', str(self.base / '..' / 'unwanted'), str(self.base / 'missing')):
            config = json.loads(self.config.read_bytes())
            config['conda'] = value
            self.config.write_text(json.dumps(config))
            with self.subTest(value=value), self.assertRaises((SystemExit, OSError)):
                self.run_main(apply=True)

    def test_missing_required_config_field_and_invalid_config_type_rejected(self):
        for config in ({'root': str(self.root)}, [], None):
            self.config.write_text(json.dumps(config))
            with self.subTest(config=config), self.assertRaisesRegex(SystemExit, 'Upgrade the execution'):
                self.run_main(apply=True)

    def test_config_concurrent_change_is_preserved_and_stops_before_install(self):
        actual = upgrade.atomic_copy
        external_bytes = self.config.read_bytes() + b'\n'
        def mutate(source, destination, **kwargs):
            result = actual(source, destination, **kwargs)
            if destination.parent != self.dest and destination.name == 'node-config.json':
                self.config.write_bytes(external_bytes)
            return result
        with patch.object(upgrade, 'atomic_copy', side_effect=mutate), self.assertRaisesRegex(SystemExit, 'changed while backing up'):
            self.run_main(apply=True)
        self.assertEqual(self.config.read_bytes(), external_bytes)
        for name, content in self.old.items():
            self.assertEqual((self.dest / name).read_bytes(), content)
        self.assertFalse((self.dest / 'project-store.py').exists())

    def test_install_failure_retains_backup_and_never_claims_success(self):
        actual = upgrade.atomic_copy
        def fail_install(source, destination, **kwargs):
            if destination.parent == self.dest and destination.name == 'sandbox-runner.py':
                raise OSError('synthetic disk failure')
            return actual(source, destination, **kwargs)
        with patch.object(upgrade, 'atomic_copy', side_effect=fail_install), self.assertRaisesRegex(SystemExit, 'did not finish.*no service was restarted'):
            self.run_main(apply=True)
        self.assertEqual(len(list(self.dest.glob('before-projects-*'))), 1)
        self.assertEqual((self.dest / 'node-executor.py').read_bytes(), self.old['node-executor.py'])
        self.assertEqual((self.dest / 'sandbox-runner.py').read_bytes(), self.old['sandbox-runner.py'])

    def test_oversized_source_rejected_before_any_backup(self):
        with patch.object(upgrade, 'MAX_FILE_BYTES', 32), self.assertRaisesRegex(SystemExit, 'oversized'):
            self.run_main(apply=True)
        self.assertEqual(list(self.dest.glob('before-projects-*')), [])


if __name__ == '__main__':
    unittest.main()
