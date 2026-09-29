"""Installer preflight tests: no real systemd, root operation, network or GPU."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cpu_delegation_test', ROOT / 'deploy/cpu-delegation.py')
D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)


class DelegationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.base.chmod(0o700)
        self.directory = self.base / 'user@1000.service.d'

    def write(self, text):
        return D.write_dropin(self.directory, text, owner=os.getuid())

    def test_minimal_addition_preserves_existing_controllers(self):
        self.assertEqual(D.delegation_content('memory pids\n'), '[Service]\nDelegate=cpu memory pids\n')
        self.assertEqual(D.delegation_content('cpuset io memory pids'), '[Service]\nDelegate=cpu cpuset io memory pids\n')
        with self.assertRaises(ValueError): D.delegation_content('memory\n[Service]')

    def test_private_backup_atomic_update_and_idempotency(self):
        first = self.write('old\n'); target = Path(first['path'])
        self.assertTrue(first['changed']); self.assertIsNone(first['backup'])
        second = self.write('new\n'); backup = Path(second['backup'])
        self.assertEqual(backup.read_text(), 'old\n'); self.assertEqual(target.read_text(), 'new\n')
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
        self.assertFalse(self.write('new\n')['changed'])

    def test_does_not_change_other_dropins(self):
        self.directory.mkdir(); unrelated = self.directory / 'custom.conf'; unrelated.write_text('keep me')
        self.write(D.delegation_content('memory pids'))
        self.assertEqual(unrelated.read_text(), 'keep me')

    def test_rejects_directory_and_file_links_and_writable_paths(self):
        outside = self.base / 'outside'; outside.mkdir()
        self.directory.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.write('x')
        self.directory.unlink(); self.directory.mkdir()
        target = self.directory / '90-gpuq-console-cpu.conf'
        external = outside / 'file'; external.write_text('preserve')
        target.symlink_to(external)
        with self.assertRaises(OSError): self.write('x')
        target.unlink(); os.link(external, target)
        with self.assertRaises(ValueError): self.write('x')
        target.unlink(); self.directory.chmod(0o777)
        with self.assertRaises(ValueError): self.write('x')
        self.assertEqual(external.read_text(), 'preserve')

    def test_configure_only_reloads_system_manager_without_runtime_mutations(self):
        with patch.object(D.os, 'geteuid', return_value=0), patch.object(D.pwd, 'getpwuid'), \
             patch.object(D.Path, 'read_text', return_value='cpu cpuset io memory pids'), \
             patch.object(D, 'write_dropin', return_value={'changed': True, 'backup': None}) as write, \
             patch.object(D, 'run', side_effect=['memory pids\n', '']) as run:
            result = D.configure(1000)
        self.assertEqual(write.call_args.args, (Path('/etc/systemd/system/user@1000.service.d'), '[Service]\nDelegate=cpu memory pids\n'))
        self.assertEqual(run.call_args_list[1].args, ('/usr/bin/systemctl', 'daemon-reload'))
        self.assertEqual(len(run.call_args_list), 2)
        self.assertFalse(result['appliedToActiveManager'])
        for call in run.call_args_list:
            self.assertNotIn('daemon-reexec', call.args); self.assertNotIn('restart', call.args)

    def test_configure_requires_explicit_root_nonroot_target(self):
        with patch.object(D.os, 'geteuid', return_value=1000), self.assertRaises(ValueError): D.configure(1000)
        with patch.object(D.os, 'geteuid', return_value=0), self.assertRaises(ValueError): D.configure(0)

    def test_probe_has_small_runtime_and_resource_caps(self):
        observed = {'cpuMax': '100000 100000', 'memoryMax': 134217728, 'pidsMax': 32}
        with patch.object(D.os, 'geteuid', return_value=1000), patch.object(D, 'run', return_value=json.dumps(observed)) as run:
            self.assertEqual(D.probe(), observed)
        argv = run.call_args.args
        for option in ('--wait', '--collect', '--property=CPUQuota=100%', '--property=MemoryMax=128M', '--property=TasksMax=32', '--property=RuntimeMaxSec=10'):
            self.assertIn(option, argv)
        self.assertEqual(argv[-1], D.PROBE)
        self.assertNotIn('nvidia', ' '.join(argv))

    def test_kernel_probe_rejects_missing_unlimited_or_excessive_cpu(self):
        group = self.base / 'probe'; group.mkdir()
        (group / 'memory.max').write_text('134217728'); (group / 'pids.max').write_text('32')
        real_path = Path
        def lookup(value):
            if value == '/proc/self/cgroup':
                return type('SelfCgroup', (), {'read_text': lambda self: '0::/probe\n'})()
            return self.base if value == '/sys/fs/cgroup' else real_path(value)
        for text in (None, 'max 100000', '200000 100000'):
            if text is not None: (group / 'cpu.max').write_text(text)
            with self.subTest(cpu=text), patch('pathlib.Path', side_effect=lookup), self.assertRaises((FileNotFoundError, AssertionError)):
                exec(D.PROBE, {})
        (group / 'cpu.max').write_text('100000 100000')
        with patch('pathlib.Path', side_effect=lookup), patch('builtins.print') as emit:
            exec(D.PROBE, {})
        self.assertEqual(json.loads(emit.call_args.args[0])['pidsMax'], 32)

    def test_installer_preflight_precedes_existing_state_changes(self):
        source = (ROOT / 'deploy/install-node.py').read_text()
        ast.parse(source)
        self.assertLess(source.index("str(delegation),'--check'"), source.index('os.umask'))
        self.assertIn("if a.configure_cpu_delegation:", source)
        self.assertNotIn("'daemon-reexec'", source)


if __name__ == '__main__': unittest.main()
