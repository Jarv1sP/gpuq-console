"""Legacy node upgrade compatibility, temporary files only; never touch a node."""
import contextlib
import hashlib
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

spec = importlib.util.spec_from_file_location('upgrade_datasets', Path(__file__).resolve().parents[1] / 'deploy/upgrade-datasets.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeDatasets(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.dest = self.base / 'node'
        self.dest.mkdir(mode=0o700)
        self.source = self.base / 'source'
        self.source.mkdir()
        self.conda = self.base / 'original-environment'
        (self.conda / 'bin').mkdir(parents=True)
        (self.conda / 'bin/python').write_text('original python')
        self.cache = self.base / 'datasets'
        self.cache.mkdir(mode=0o700)
        self.runner = self.dest / 'sandbox-runner.py'
        self.runner.write_text("args=['--ro-bind'," + repr(str(self.conda)) + ",'/opt/conda','--ro-bind'," + repr(str(self.conda)) + ',' + repr(str(self.conda)) + ']\n')
        self.executor = self.dest / 'node-executor.py'
        self.executor.write_text('# old executor\n')
        self.broker = self.dest / 'terminal-helper.py'
        self.broker.write_text('# old root broker\n')
        self.wrapper = self.base / 'root-shell'
        self.wrapper.write_text('#!/bin/sh\n')
        self.wrapper.chmod(0o755)
        self.config = {'root': '/data/existing-workspaces', 'gpu': '/opt/legacy/bin/gpu',
                       'database': '/data/scheduler/existing.db', 'slirp': '/opt/legacy/slirp4netns',
                       'futureSetting': {'keep': True}}
        self.path = self.dest / 'node-config.json'
        self.path.write_text(json.dumps(self.config))
        self.path.chmod(0o600)
        (self.source / 'dataset-cache.py').write_text('def _data2_mount(): return None\nclass DatasetCache:\n def __init__(self, root): pass\n')
        (self.source / 'sandbox-runner.py').write_text('# new runner needs cfg conda\n')
        (self.source / 'node-executor.py').write_text('# new executor\n')
        (self.source / 'dataset-upload.py').write_text('# member upload helper\n')
        (self.source / 'data-workspace.py').write_text('# personal data workspace helper\n')

    def inferred(self, config=None):
        return upgrade.upgraded_config(self.config if config is None else config, self.runner, self.cache)

    def run_main(self, apply=False):
        with patch.object(upgrade, 'DATASET_ROOT', self.cache), patch.object(upgrade, 'preserved_host_root', return_value=(True, 'legacy-verified-root-wrapper')), patch.object(upgrade.subprocess, 'run', return_value=SimpleNamespace(stdout='--ro-bind-fd')), contextlib.redirect_stdout(io.StringIO()) as out:
            upgrade.main(['--directory', str(self.dest), '--source', str(self.source), *(['--apply'] if apply else [])])
        return json.loads(out.getvalue())

    def test_infers_original_literal_environment_without_new_field(self):
        updated, origin = self.inferred()
        self.assertEqual(updated['conda'], str(self.conda))
        self.assertEqual(origin, 'legacy-sandbox-mount')
        self.assertNotIn('conda', self.config)
        for key, value in self.config.items():
            self.assertEqual(updated[key], value)

    def test_explicit_environment_wins_and_remains_unchanged(self):
        explicit = self.base / 'different-environment'
        (explicit / 'bin').mkdir(parents=True)
        (explicit / 'bin/python').touch()
        updated, origin = self.inferred({**self.config, 'conda': str(explicit)})
        self.assertEqual(updated['conda'], str(explicit))
        self.assertEqual(origin, 'existing-config')

    def test_broken_explicit_environment_never_falls_back_to_existing_old_one(self):
        with self.assertRaisesRegex(SystemExit, 'no fallback'):
            self.inferred({**self.config, 'conda': '/not/a/real/environment'})

    def test_unrecognized_or_ambiguous_legacy_never_guesses(self):
        self.runner.write_text('conda = discover_environment()\n')
        with self.assertRaisesRegex(SystemExit, 'identify one original'):
            self.inferred()
        self.runner.write_text("a=['--ro-bind','/one','/opt/conda'];b=['--ro-bind','/two','/opt/conda']\n")
        with self.assertRaisesRegex(SystemExit, 'identify one original'):
            self.inferred()

    def test_legacy_source_is_parsed_never_executed(self):
        sentinel = self.base / 'must-not-exist'
        with self.runner.open('a') as stream:
            stream.write('open(' + repr(str(sentinel)) + ',"w").write("executed")\n')
        self.inferred()
        self.assertFalse(sentinel.exists())

    def test_unsafe_conda_values_and_missing_python_rejected(self):
        for value in [None, [], 'relative', '/tmp/../env', '/', '/opt', '/home', '/usr', '/tmp/\nconda']:
            with self.subTest(value=value), self.assertRaises(SystemExit):
                self.inferred({**self.config, 'conda': value})
        (self.conda / 'bin/python').unlink()
        with self.assertRaisesRegex(SystemExit, 'unavailable'):
            self.inferred()

    def test_symlink_legacy_runner_rejected(self):
        self.runner.unlink()
        self.runner.symlink_to(self.executor)
        with self.assertRaisesRegex(SystemExit, 'trusted legacy'):
            self.inferred()

    def test_existing_dataset_sources_and_unknown_fields_preserved(self):
        datasets = {'root': str(self.cache), 'sources': {'approved': '/data/library/item'}, 'reserveBytes': 1024}
        updated, _ = self.inferred({**self.config, 'datasets': datasets})
        self.assertEqual(updated['datasets'], datasets)
        self.assertEqual(updated['futureSetting'], {'keep': True})

    def test_conflicting_dataset_configuration_never_rewritten(self):
        for datasets in [None, '/bad', {'root': '/other/cache'}]:
            with self.subTest(datasets=datasets), self.assertRaisesRegex(SystemExit, 'reviewed manually'):
                self.inferred({**self.config, 'datasets': datasets})

    def test_preview_legacy_writes_nothing(self):
        before = {path: (path.read_bytes(), path.stat().st_ino) for path in self.dest.iterdir()}
        result = self.run_main()
        self.assertTrue(result['dryRun'])
        self.assertEqual(result['condaSource'], 'legacy-sandbox-mount')
        self.assertTrue(result['terminalHelperUnchanged'])
        self.assertEqual(before, {path: (path.read_bytes(), path.stat().st_ino) for path in self.dest.iterdir()})

    def test_apply_preserves_paths_backups_and_broker_and_writes_config_first(self):
        original = self.path.read_bytes()
        broker_inode = self.broker.stat().st_ino
        copied = []
        actual_copy = upgrade.atomic_copy
        def inspect_copy(source, target):
            cfg = json.loads(self.path.read_text())
            self.assertEqual(cfg['conda'], str(self.conda))
            self.assertIs(cfg['hostRoot'], True)
            copied.append(target.name)
            actual_copy(source, target)
        with patch.object(upgrade, 'atomic_copy', side_effect=inspect_copy):
            result = self.run_main(apply=True)
        cfg = json.loads(self.path.read_text())
        for key, value in self.config.items():
            self.assertEqual(cfg[key], value)
        self.assertEqual(copied, ['dataset-cache.py', 'dataset-upload.py', 'data-workspace.py', 'sandbox-runner.py', 'node-executor.py'])
        self.assertEqual(self.broker.stat().st_ino, broker_inode)
        self.assertEqual((Path(result['backup']) / 'node-config.json').read_bytes(), original)
        self.assertFalse(result['restartRequired'])
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_missing_bwrap_feature_rejects_without_changing_configuration(self):
        before = self.path.read_bytes()
        with patch.object(upgrade, 'DATASET_ROOT', self.cache), patch.object(upgrade, 'preserved_host_root', return_value=(True, 'legacy')), patch.object(upgrade.subprocess, 'run', return_value=SimpleNamespace(stdout='')), self.assertRaisesRegex(SystemExit, 'ro-bind-fd'):
            upgrade.main(['--directory', str(self.dest), '--source', str(self.source), '--apply'])
        self.assertEqual(self.path.read_bytes(), before)

    def test_root_explicit_boolean_always_preserved_no_inference(self):
        for value in [True, False]:
            self.assertEqual(upgrade.preserved_host_root({'hostRoot': value}, self.dest), (value, 'existing-config'))
        with self.assertRaisesRegex(SystemExit, 'boolean'):
            upgrade.preserved_host_root({'hostRoot': 'true'}, self.dest)

    def test_unknown_legacy_root_behavior_never_enables(self):
        with self.assertRaisesRegex(SystemExit, 'unknown'):
            upgrade.preserved_host_root({}, self.dest)

    def legacy_hashes(self):
        return [patch.object(upgrade, 'LEGACY_EXECUTOR_SHA256', hashlib.sha256(self.executor.read_bytes()).hexdigest()),
                patch.object(upgrade, 'LEGACY_BROKER_SHA256', hashlib.sha256(self.broker.read_bytes()).hexdigest()),
                patch.object(upgrade, 'LEGACY_ROOT_SHELL', self.wrapper)]

    def test_recognized_legacy_requires_root_owned_executable_wrapper(self):
        patches = self.legacy_hashes()
        with patches[0], patches[1], patches[2]:
            actual_lstat = Path.lstat
            def root_stat(path, *args, **kwargs):
                if path == self.wrapper:
                    return SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_nlink=1, st_uid=0)
                return actual_lstat(path, *args, **kwargs)
            with patch.object(Path, 'lstat', root_stat):
                self.assertEqual(upgrade.preserved_host_root({}, self.dest), (True, 'legacy-verified-root-wrapper'))

    def test_unsafe_wrapper_does_not_restore_root_permission(self):
        patches = self.legacy_hashes()
        with patches[0], patches[1], patches[2]:
            for uid, mode, links in [(os.getuid(), 0o755, 1), (0, 0o777, 1), (0, 0o755, 2)]:
                actual_lstat = Path.lstat
                def wrong_stat(path, *args, **kwargs):
                    if path == self.wrapper:
                        return SimpleNamespace(st_mode=stat.S_IFREG | mode, st_nlink=links, st_uid=uid)
                    return actual_lstat(path, *args, **kwargs)
                with self.subTest(uid=uid, mode=mode), patch.object(Path, 'lstat', wrong_stat), self.assertRaisesRegex(SystemExit, 'Unsafe legacy'):
                    upgrade.preserved_host_root({}, self.dest)

    def test_modified_broker_no_longer_counts_as_known_legacy_authorization(self):
        patches = self.legacy_hashes()
        with patches[0], patches[1], patches[2]:
            self.broker.write_text('# modified authorization\n')
            with self.assertRaisesRegex(SystemExit, 'unknown'):
                upgrade.preserved_host_root({}, self.dest)


if __name__ == '__main__':
    unittest.main()
