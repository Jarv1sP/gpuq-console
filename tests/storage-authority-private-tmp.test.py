"""Offline safety/CLI tests; never create services, fixtures or namespaces."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name('storage-authority-private-tmp.py')
spec = importlib.util.spec_from_file_location('private_tmp_fixture_tests', SCRIPT)
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)


class PrivateTmpPlan(unittest.TestCase):
    def setUp(self):
        self.root = Path('/data') / (F.PREFIX + 'a' * 32)

    def test_no_implicit_execute(self):
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--fixture-root', str(self.root)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"state": "FAILED"', result.stderr)

    def test_invalid_fixture_paths_rejected_before_filesystem(self):
        for path in ('/data', '/data2/datasets', '/data/gpuq-authority-private-tmp-old',
                     '/tmp/' + self.root.name, str(self.root / 'nested')):
            with self.subTest(path=path), mock.patch.object(Path, 'resolve') as resolve:
                with self.assertRaises(ValueError):
                    F.fixture_path(path)
                resolve.assert_not_called()

    def test_fresh_path_only_and_no_reuse(self):
        with mock.patch.object(Path, 'resolve', return_value=Path('/data')), \
             mock.patch.object(Path, 'is_symlink', return_value=False), \
             mock.patch.object(Path, 'exists', return_value=True):
            with self.assertRaisesRegex(ValueError, 'Never reuse'):
                F.fixture_path(str(self.root))

    def test_peer_is_explicit_amax_private_tmp_non_gpu_transient_unit(self):
        unit, command = F.systemd_command(self.root, 'peer')
        self.assertEqual(unit, 'gpuq-authority-fixture-' + 'a' * 32 + '-peer.service')
        for expected in ('--property=PrivateTmp=yes', '--property=User=amax',
                         '--property=PrivateDevices=yes', '--property=DevicePolicy=closed',
                         '--property=RuntimeMaxSec=120', '--collect'):
            self.assertIn(expected, command)
        self.assertNotIn('gpuq-transfer-peer-lan.service', command)
        self.assertNotIn('--wait', command)
        self.assertEqual(command[-5:], [str(self.root / 'fixture.py'), '--worker', 'peer',
                                       '--fixture-root', str(self.root)])

    def test_live_guard_is_short_waited_separate_root_unit(self):
        unit, command = F.systemd_command(self.root, 'live-guard')
        self.assertTrue(unit.endswith('-live-guard.service'))
        for expected in ('--wait', '--pipe', '--property=User=root', '--property=PrivateTmp=yes'):
            self.assertIn(expected, command)
        with self.assertRaises(ValueError):
            F.systemd_command(self.root, 'restart')

    def test_linux_identity_gate_precedes_any_copy_or_service(self):
        with mock.patch.object(F.sys, 'platform', 'darwin'), \
             mock.patch.object(F.subprocess, 'run') as run, \
             mock.patch.object(F.shutil, 'copy2') as copy:
            with self.assertRaisesRegex(ValueError, 'Linux service identity'):
                F.execute('/never-read', self.root)
            run.assert_not_called()
            copy.assert_not_called()

    def test_cleanup_stops_both_units_even_when_live_guard_stop_times_out(self):
        peer = F.systemd_command(self.root, 'peer')[0]
        negative = F.systemd_command(self.root, 'live-guard')[0]
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            if command[-1] == negative and 'stop' in command:
                raise subprocess.TimeoutExpired(command, 20)
            return subprocess.CompletedProcess(command, 0, stdout='inactive\n')
        with mock.patch.object(F.subprocess, 'run', side_effect=run):
            with self.assertRaisesRegex(ValueError, 'stop unconfirmed'):
                F.stop_fixture_units([peer, negative])
        self.assertEqual([command[-1] for command in calls if 'stop' in command], [negative, peer])
        with mock.patch.object(F.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'exact fixture'):
                F.stop_fixture_units(['gpuq-transfer-peer-lan.service'])
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
