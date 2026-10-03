"""Regress directory-bind lifetime and the real new-install unit-copy path.

The socket tests use an open directory FD as the container's pinned directory
identity, and model systemd's documented explicit-stop removal policy. They do
not claim to run systemd or a privileged bind mount on the test host.
"""
import configparser
import importlib.util
import io
import os
from pathlib import Path
import shutil
import socket
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
UNIT = ROOT / 'deploy/gpuq-console-executor.service'
spec = importlib.util.spec_from_file_location('executor_runtime_installer', ROOT / 'deploy/init-vps.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def service_settings(path=UNIT):
    parsed = configparser.ConfigParser(interpolation=None, strict=True)
    parsed.read_string(path.read_text())
    return parsed['Service']


class RuntimeDirectoryLifetime(unittest.TestCase):
    def test_unit_preserves_directory_without_relaxing_access(self):
        service = service_settings()
        self.assertEqual(service['RuntimeDirectoryPreserve'], 'yes')
        self.assertEqual(service['RuntimeDirectory'], 'gpuq-console-executor')
        self.assertEqual(service['RuntimeDirectoryMode'], '0750')
        self.assertEqual(service['ReadWritePaths'], '/run/gpuq-console-executor')
        self.assertEqual(service['Group'], '1000')
        self.assertEqual(service['UMask'], '0007')
        self.assertEqual(service['ProtectSystem'], 'strict')
        self.assertEqual(service['NoNewPrivileges'], 'true')

    def directory_survives_explicit_stop_start(self, preserve):
        # Keep the Unix socket path below the macOS sockaddr_un length limit.
        with tempfile.TemporaryDirectory(prefix='gpuq-', dir='/tmp') as temp:
            runtime = Path(temp) / 'run'
            runtime.mkdir(mode=0o750)
            fd = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY)
            try:
                before = os.fstat(fd)
                with socket.socket(socket.AF_UNIX) as first:
                    first.bind(str(runtime / 'bridge.sock'))
                (runtime / 'bridge.sock').unlink()
                # RuntimeDirectoryPreserve=restart does not preserve a separate
                # stop followed by start, nor does the default/no policy.
                if preserve != 'yes':
                    runtime.rmdir()
                    runtime.mkdir(mode=0o750)
                with socket.socket(socket.AF_UNIX) as second:
                    second.bind(str(runtime / 'bridge.sock'))
                    second.listen(1)
                    now = runtime.stat()
                    same_inode = (before.st_dev, before.st_ino) == (now.st_dev, now.st_ino)
                    if same_inode:
                        self.assertTrue(stat.S_ISSOCK(os.stat('bridge.sock', dir_fd=fd).st_mode))
                        with socket.socket(socket.AF_UNIX) as client:
                            client.connect(str(runtime / 'bridge.sock'))
                            accepted, _ = second.accept()
                            accepted.close()
                    else:
                        # The old directory identity no longer sees the socket,
                        # even though the restarted bridge is healthy on host.
                        self.assertTrue((runtime / 'bridge.sock').exists())
                        with self.assertRaises(FileNotFoundError):
                            os.stat('bridge.sock', dir_fd=fd)
                    return same_inode
            finally:
                os.close(fd)

    def test_installed_policy_keeps_second_socket_visible_to_pinned_directory(self):
        self.assertTrue(self.directory_survives_explicit_stop_start(service_settings()['RuntimeDirectoryPreserve']))

    def test_old_default_and_restart_only_reproduce_stale_directory(self):
        for policy in (None, 'no', 'restart'):
            with self.subTest(policy=policy):
                self.assertFalse(self.directory_survives_explicit_stop_start(policy))


class InstallerUnitCopy(unittest.TestCase):
    def test_real_installer_copies_preserve_policy_without_starting_services(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve() / 'install'
            units = Path(temp).resolve() / 'units'
            (base / 'deploy').mkdir(parents=True)
            units.mkdir()
            (base / 'inventory.json').write_text('{"nodes":[]}')
            (base / 'data').mkdir()
            database = base / 'data/portal.sqlite'
            database.write_bytes(b'existing database fixture')
            database.chmod(0o640)
            before = (database.read_bytes(), database.stat().st_ino, stat.S_IMODE(database.stat().st_mode))
            shutil.copy2(UNIT, base / 'deploy' / UNIT.name)
            for folder, script in [('collector', 'collect-status.py'), ('executor', 'execution-worker.py')]:
                (base / folder).mkdir()
                (base / 'deploy' / script).write_text('# harmless installation fixture\n')
                # Dummy files avoid key generation; these are not credentials.
                (base / folder / 'id_ed25519').write_text('fixture-only')
            (base / 'deploy/backup.sh').write_text('# harmless backup fixture\n')

            def private_path(value):
                return {'/opt/gpuq-console': base, '/etc/systemd/system': units}.get(str(value), Path(value))

            with patch.object(installer, 'Path', side_effect=private_path), \
                    patch.object(installer, '__file__', str(base / 'deploy/init-vps.py')), \
                    patch.object(installer.os, 'getuid', return_value=0), \
                    patch.object(installer.os, 'chown') as chown, \
                    patch.object(installer.os, 'umask'), \
                    patch.object(installer.subprocess, 'run') as run, redirect_stdout(io.StringIO()):
                installer.main()

            installed = units / UNIT.name
            self.assertEqual(installed.read_bytes(), UNIT.read_bytes())
            self.assertEqual(service_settings(installed)['RuntimeDirectoryPreserve'], 'yes')
            run.assert_called_once_with(['systemctl', 'daemon-reload'], check=True)
            self.assertEqual((database.read_bytes(), database.stat().st_ino, stat.S_IMODE(database.stat().st_mode)), before)
            self.assertNotIn(database, [Path(call.args[0]) for call in chown.call_args_list])
            self.assertFalse((base / 'data/bootstrap.json').exists())
            self.assertEqual(stat.S_IMODE((base / 'executor/execution-worker.py').stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((base / 'executor/id_ed25519').stat().st_mode), 0o600)


if __name__ == '__main__':
    unittest.main()
