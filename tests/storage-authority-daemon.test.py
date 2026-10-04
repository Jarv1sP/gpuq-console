"""Real executor --transfer-peer-daemon integration on disposable loopback TLS.

Only /proc/self/mountinfo is synthetic: startup, config, HTTP routing, TLS,
authority guards, grants and filesystem operations are production code. No
systemd units, GPUs, private inventory, production config or remote hosts used.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from storage_test_helpers import isolated_platform_pin, local_data_mounts


DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'


def load_node(root):
    name = 'authority_daemon_fixture_' + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, root / 'node-executor.py')
    node = importlib.util.module_from_spec(spec)
    sys.modules[name] = node
    spec.loader.exec_module(node)
    return node


def fixture_daemon(root):
    # This branch exists only in the test file, never in the shipped runtime.
    if not (root / '.authority-daemon-fixture').is_file():
        raise ValueError('Refusing a non-fixture runtime')
    config = json.loads((root / 'node-config.json').read_text())
    sys.argv = [str(root / 'node-executor.py'), '--transfer-peer-daemon']
    # A service mount namespace uses different IDs from the sealing process.
    # The physical device and inode identities deliberately remain identical.
    # The disposable child process must not consult the host's production pin.
    fixture = unittest.TestCase()
    isolated_platform_pin(fixture)
    try:
        with local_data_mounts(config['datasets']['mountPoint'], mount_id_offset=1000):
            runpy.run_path(sys.argv[0], run_name='__main__')
    finally:
        fixture.doCleanups()


class AuthorityDaemon(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory(prefix='gpuq-authority-daemon-')
        self.root = Path(self.temp.name).resolve()
        self.mounts = local_data_mounts(self.root)
        self.mounts.start()
        self.addCleanup(self.mounts.stop)
        self.processes = []
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir(mode=0o700)
        for source in DEPLOY.glob('*.py'):
            shutil.copy2(source, self.runtime / source.name)
        (self.runtime / '.authority-daemon-fixture').touch()
        self.source = self.root / 'approved'
        self.source.mkdir()
        self.content = b'fixed authority daemon payload\x00' * 60000
        (self.source / 'data.bin').write_bytes(self.content)
        self.cert, self.key = self.root / 'cert.pem', self.root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(self.key), '-out', str(self.cert), '-subj',
                        '/CN=loopback-authority-daemon', '-days', '1'],
                       check=True, capture_output=True)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.port = listener.getsockname()[1]
        self.pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(self.cert.read_text())).hexdigest()
        self.peer = dict(address='127.0.0.1', port=self.port, certificateSha256=self.pin)
        self.config = dict(root=str(self.root / 'state'), machine='source-node',
                           datasets=dict(root=str(self.root / 'cold'), mountPoint=str(self.root),
                                         sources={'approved': str(self.source)}, reserveBytes=0),
                           transferPeer=dict(bind='127.0.0.1', port=self.port,
                                             certificate=str(self.cert), privateKey=str(self.key)))
        self.write_config()
        self.node = load_node(self.runtime)
        self.module, self.cache = self.node.dataset_cache()
        self.admin = self.module.Principal('builtin-admin', True)
        self.owner = self.module.Principal('demo-user-1')
        self.version = self.cache.register_source(self.admin, 'shared', 'approved', [self.owner.user_id])['version']
        self.cache.materialize(self.owner, 'shared', self.version)
        self.authority = self.node.storage_authority_module()

    def tearDown(self):
        for process in self.processes:
            self.stop(process)
        for directory, _, files in os.walk(self.root):
            os.chmod(directory, 0o700)
            for name in files:
                path = Path(directory) / name
                if not path.is_symlink():
                    os.chmod(path, 0o600)
        self.temp.cleanup()

    def write_config(self):
        (self.runtime / 'node-config.json').write_text(json.dumps(self.config))

    def seal(self):
        self.config['storageAuthority'] = {'enabled': True}
        self.node.CONFIG = self.config
        self.write_config()
        self.grant = self.node.storage_authority().seal(
            self.admin, 'shared', self.version, str(uuid.uuid4()), 'target-node')
        return self.grant

    def start(self, *, ready=True):
        process = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()),
                                    '--fixture-daemon', str(self.runtime)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
        self.processes.append(process)
        if not ready:
            return process
        until = time.monotonic() + 8
        while time.monotonic() < until:
            if process.poll() is not None:
                _, errors = process.communicate()
                self.fail('Fixture daemon failed startup: ' + errors.decode()[-2000:])
            try:
                with socket.create_connection(('127.0.0.1', self.port), timeout=.1):
                    return process
            except OSError:
                time.sleep(.02)
        self.fail('Fixture daemon did not bind loopback')

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.terminate()
        process.communicate(timeout=5)

    def request(self, route, value=None, *, token='x' * 43, method='POST'):
        # Reuse the real pinned client connection, including pin-before-bearer.
        connection = self.authority.J.PeerClient(self.peer, token)
        connection.connect()
        try:
            body = None if method == 'GET' else json.dumps(value).encode()
            headers = {'Content-Type': 'application/json'}
            if token is not None:
                headers['Authorization'] = 'Bearer ' + token
            connection.connection.request(method, route, body, headers)
            response = connection.connection.getresponse()
            return response.status, json.loads(response.read(2 * 1024**2))
        finally:
            connection.close()

    def guard(self, **changes):
        return dict(id=self.grant['id'], action='guard', dataset='shared',
                    version=self.version, targetMachine='target-node', **changes)

    def test_default_off_starts_snapshot_peer_but_never_constructs_authority(self):
        self.assertIsNone(self.node.storage_authority())
        self.start()
        self.assertEqual(self.request('/capabilities', method='GET'),
                         (200, {'protocol': 'lan-transfer-v1', 'sourceReady': True}))
        code, result = self.request('/authority', {'action': 'guard'})
        self.assertEqual(code, 403)
        self.assertFalse(result['ok'])
        self.assertFalse((self.root / 'state' / 'storage-authority').exists())
        self.assertFalse(self.node.storage_node().tier.enabled)

    def test_invalid_authority_config_or_missing_peer_fails_startup_without_listener(self):
        variants = [dict(storageAuthority={'enabled': 'true'}),
                    dict(storageAuthority={'enabled': True, 'root': '/untrusted'}),
                    dict(storageAuthority={'enabled': True}, machine=None),
                    dict(transferPeer=None)]
        original = self.config
        for changes in variants:
            with self.subTest(changes=changes):
                self.config = {**original, **changes}
                self.write_config()
                process = self.start(ready=False)
                _, errors = process.communicate(timeout=8)
                self.assertNotEqual(process.returncode, 0, errors)
                with self.assertRaises(OSError):
                    socket.create_connection(('127.0.0.1', self.port), timeout=.1)

    def test_enabled_daemon_reads_fixed_guard_manifest_and_bytes_after_restart(self):
        self.seal()
        process = self.start()
        client = self.authority.AuthorityClient(self.peer, self.grant)
        self.assertEqual(client.call('guard'), self.grant['receipt'])
        manifest = client.call('manifest', offset=0)
        self.assertEqual(hashlib.sha256(base64.b64decode(manifest['data'])).hexdigest(),
                         self.grant['receipt']['manifestSha256'])
        first = client.call('get', path='data.bin', offset=0)
        self.assertEqual(base64.b64decode(first['data']), self.content[:self.authority.CHUNK])
        self.stop(process)
        self.start()
        self.assertEqual(client.call('guard'), self.grant['receipt'])
        second = client.call('get', path='data.bin', offset=first['offset'])
        self.assertEqual(base64.b64decode(second['data']), self.content[first['offset']:])

    def test_unknown_routes_mutations_and_unauthenticated_reads_are_generic_denials(self):
        self.seal()
        self.start()
        for route in ('/seal', '/unpin', '/authority/guard', '/authority?token=wrong', '/unknown'):
            with self.subTest(route=route):
                code, response = self.request(route, self.guard(), token=self.grant['token'])
                self.assertEqual(code, 403)
                self.assertEqual(response, {'ok': False, 'error': 'Snapshot grant or immutable source is unavailable'})
        for value, token in ((self.guard(), None), (self.guard(), 'wrong'),
                             ({**self.guard(), 'action': 'seal'}, self.grant['token']),
                             ({**self.guard(), 'version': '0' * 64}, self.grant['token']),
                             ({**self.guard(), 'targetMachine': 'another'}, self.grant['token'])):
            with self.subTest(value=value['action'], token=token is None):
                code, response = self.request('/authority', value, token=token)
                self.assertEqual(code, 403)
                text = json.dumps(response)
                self.assertNotIn(self.grant['token'], text)
                self.assertNotIn(str(self.root), text)
                self.assertNotIn(self.version, text)
        self.assertEqual(self.request('/unknown', method='GET')[0], 503)

    def test_source_guard_rechecks_pin_and_registration_in_running_daemon(self):
        self.seal()
        self.start()
        self.assertEqual(self.request('/authority', self.guard(), token=self.grant['token'])[0], 200)
        with self.cache._locked():
            metadata = self.cache._tier('shared', self.version)
            metadata['pins'] = {}
            self.cache._write_tier('shared', self.version, metadata)
        self.assertEqual(self.request('/authority', self.guard(), token=self.grant['token'])[0], 403)
        self.assertEqual(self.cache.status(self.owner, 'shared', self.version)['state'], 'READY')

    def test_actual_target_node_configuration_recovers_over_real_daemon(self):
        self.seal()
        self.start()
        target = self.root / 'target-runtime'
        shutil.copytree(self.runtime, target)
        target_config = dict(root=str(self.root / 'target-state'), machine='target-node',
                             datasets=dict(root=str(self.root / 'hot'), mountPoint=str(self.root),
                                           sources={}, reserveBytes=0),
                             transferPeers={'source-node': self.peer},
                             storageAuthorities={'hdd': {'machine': 'source-node'}})
        Path(target_config['root']).mkdir(mode=0o700)
        (target / 'node-config.json').write_text(json.dumps(target_config))
        node = load_node(target)
        module, cache = node.dataset_cache()
        admin = module.Principal('builtin-admin', True)
        owner = module.Principal('demo-user-1')
        cache.register_manifest(admin, 'replica', self.cache.export_manifest(self.admin, 'shared', self.version)['manifest'],
                                [owner.user_id])
        storage = node.storage_node()
        remote = storage.tier.authorities['hdd']
        remote.install_grant(self.grant)
        proof = remote.seal(admin, 'shared', self.version, 'authority-fixture')
        remote.recover(admin, proof, cache, 'replica', validate_target=lambda: None)
        storage.tier.verify_authority(admin, 'replica', self.version, 'hdd', 'shared')
        self.assertFalse(storage.tier.enabled)  # No production GC policy inferred.
        cache.evict(admin, 'replica', self.version)
        self.assertNotEqual(cache.status(owner, 'replica', self.version)['state'], 'READY')
        self.assertEqual(storage.tier.recover(admin, 'replica', self.version)['state'], 'READY')
        actual = cache._paths('replica', self.version)['ready'] / 'data' / 'data.bin'
        self.assertEqual(hashlib.sha256(actual.read_bytes()).digest(), hashlib.sha256(self.content).digest())
        self.assertFalse(actual.stat().st_mode & 0o222)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture-daemon':
        fixture_daemon(Path(sys.argv[2]).resolve())
    else:
        unittest.main()
