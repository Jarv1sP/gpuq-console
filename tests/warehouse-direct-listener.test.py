"""Fixed HDD listener readiness; synthetic dual roots and loopback TLS only."""
import ast
import contextlib
import hashlib
import http.client
import json
from pathlib import Path
import socket
import ssl
import subprocess
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import importlib.util

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('warehouse_listener_fixtures', HERE/'storage-warehouse.test.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
DIRECT = fixtures.module('warehouse_listener_direct', 'direct-upload.py')


class WarehouseListenerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.WarehouseTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.w, self.node = self.fixture.w, self.fixture.node
        self.mounts, self.hdd_available = [], True
        def check(config):
            self.mounts.append(config['root'])
            # SSD readiness must not authorize or block this HDD ingress.
            if config['root'] != str(self.w.cold.root):
                raise ValueError('listener checked the training SSD')
            if not self.hdd_available:
                raise ValueError('warehouse mount unavailable')
        self.node.dataset_mount_check = self.w.view.dataset_mount_check = check
        self.node.platform_root_check = self.w.view.platform_root_check = lambda: None
        self.node.HERE = self.w.view.HERE = self.fixture.root
        self.uploads = fixtures.U.DatasetUploads(self.w.view)
        self.cert, self.key = self.fixture.root/'cert.pem', self.fixture.root/'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(self.key), '-out', str(self.cert), '-days', '1',
                        '-subj', '/CN=localhost'], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.key.chmod(0o600)
        self.origin = 'https://portal.example.test'
        config = dict(enabled=True, bind='192.168.77.104', port=18444,
                      endpoint='https://upload.example.test:18444',
                      certificate=str(self.cert), privateKey=str(self.key),
                      allowedOrigins=[self.origin])
        self.node.CONFIG['directUpload'] = self.w.view.CONFIG['directUpload'] = config
        (self.fixture.root/'node-config.json').write_text(json.dumps(self.node.CONFIG))

    @contextlib.contextmanager
    def listener(self):
        direct = DIRECT.DirectUploads(self.w.view, self.uploads)
        # Validate the real original startup configuration before changing only
        # its bind/port for an isolated loopback fixture (no real LAN listener).
        config = direct.configuration()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        config = {**config, 'bind': '127.0.0.1', 'port': port}
        with patch.object(DIRECT.DirectUploads, 'configuration', return_value=config):
            server = DIRECT.create_server(self.w.view, self.uploads)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.check_hostname = False; context.verify_mode = ssl.CERT_NONE
                with contextlib.closing(http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=3)) as client:
                    client.connect()
                    self.assertEqual(hashlib.sha256(client.sock.getpeercert(binary_form=True)).hexdigest(), config['certificateSha256'])
                    yield client, config
            finally:
                server.shutdown(); server.server_close(); thread.join(3)
                self.assertFalse(thread.is_alive())

    def request(self, client, method, path, **headers):
        client.request(method, path, headers=headers)
        reply = client.getresponse()
        return reply.status, dict(reply.getheaders()), reply.read()

    def test_actual_daemon_branch_passes_factory_view_not_outer_ssd(self):
        tree = ast.parse((fixtures.DEPLOY/'node-executor.py').read_text())
        branches = [value for value in ast.walk(tree) if isinstance(value, ast.If)
                    and any(isinstance(v, ast.Constant) and v.value == '--direct-upload-daemon'
                            for v in ast.walk(value.test))]
        self.assertEqual(len(branches), 1)
        calls = []
        fake_module = SimpleNamespace(serve=lambda node, uploads: calls.append((node, uploads)))
        fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
        def exit_(code): raise SystemExit(code)
        namespace = dict(HERE=fixtures.DEPLOY, __name__='fixture_outer',
                         importlib=SimpleNamespace(util=SimpleNamespace(spec_from_file_location=lambda *args: fake_spec,
                                                                        module_from_spec=lambda spec: fake_module)),
                         sys=SimpleNamespace(modules={'fixture_outer': self.node}, exit=exit_),
                         dataset_ingress_view=lambda: self.w.view, dataset_uploads=lambda: self.uploads)
        with self.assertRaises(SystemExit) as result:
            exec(compile(ast.Module(body=branches[0].body, type_ignores=[]), 'actual-daemon-branch', 'exec'), namespace)
        self.assertEqual(result.exception.code, 0)
        self.assertEqual(calls, [(self.w.view, self.uploads)])
        self.assertIs(calls[0][1].n, calls[0][0])
        self.assertEqual(calls[0][0].CONFIG['datasets']['root'], str(self.w.cold.root))
        self.assertNotEqual(calls[0][0].CONFIG['datasets']['root'], str(self.fixture.hot.root))

    def test_tls_capabilities_and_preflight_recheck_hdd_mount_loss(self):
        before = sorted(str(p.relative_to(self.fixture.root)) for p in self.fixture.root.rglob('*'))
        with self.listener() as (client, config):
            status, headers, body = self.request(client, 'GET', '/capabilities', Origin=self.origin)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), dict(protocol=DIRECT.PROTOCOL, listenerReady=True,
                                                  revision=config['revision'], machine='test-node'))
            self.assertEqual(headers['Access-Control-Allow-Origin'], self.origin)
            options = {'Origin': self.origin, 'Access-Control-Request-Method': 'GET'}
            self.assertEqual(self.request(client, 'OPTIONS', '/capabilities', **options)[0], 204)
            self.hdd_available = False
            self.assertEqual(self.request(client, 'GET', '/capabilities', Origin=self.origin)[0], 409)
            self.assertEqual(self.request(client, 'OPTIONS', '/capabilities', **options)[0], 409)
            self.assertTrue(self.mounts)
            self.assertEqual(set(self.mounts), {str(self.w.cold.root)})
        self.assertEqual(sorted(str(p.relative_to(self.fixture.root)) for p in self.fixture.root.rglob('*')), before)
        self.assertFalse((self.fixture.hot.root/'.uploads').exists())

    def test_wrong_origin_and_missing_ticket_create_no_hdd_or_ssd_upload(self):
        before = sorted(str(p.relative_to(self.fixture.root)) for p in self.fixture.root.rglob('*'))
        with self.listener() as (client, _):
            status, headers, _ = self.request(client, 'OPTIONS', '/capabilities',
                                             Origin='https://other.example.test',
                                             **{'Access-Control-Request-Method': 'GET'})
            self.assertEqual(status, 403); self.assertNotIn('Access-Control-Allow-Origin', headers)
            path = '/v1/uploads/12345678-1234-4234-8234-123456789012/status'
            self.assertEqual(self.request(client, 'GET', path, Origin=self.origin)[0], 403)
        self.assertEqual(sorted(str(p.relative_to(self.fixture.root)) for p in self.fixture.root.rglob('*')), before)
        self.assertFalse((self.fixture.hot.root/'.uploads').exists())

    def test_valid_short_ticket_writes_manifest_only_to_hdd_and_mount_loss_fences_bytes(self):
        manifest = json.dumps({'schema': 1, 'directories': [], 'files': [dict(
            path='train.txt', size=5, sha256=hashlib.sha256(b'train').hexdigest())]}, separators=(',', ':')).encode()
        args = dict(userId=fixtures.OWNER.user_id, hostAdmin=False, name='training-set', key=str(uuid.uuid4()),
                    manifestBytes=len(manifest), manifestSha256=hashlib.sha256(manifest).hexdigest(),
                    totalBytes=5, entries=1)
        direct = DIRECT.DirectUploads(self.w.view, self.uploads)
        with self.listener() as (client, _), patch.object(self.uploads, 'direct', return_value=direct), \
                patch.object(direct, 'probe'):
            result = self.uploads.process('datasets.upload.begin', args)
            upload = result['uploadId']; grant = direct.issue(fixtures.OWNER.user_id, upload)
            self.assertLessEqual(grant['expiresAt']-__import__('time').time(), 300)
            headers = {'Origin': self.origin, 'Authorization': 'Bearer '+grant['ticket'],
                       'Content-Type': 'application/octet-stream'}
            path = f'/v1/uploads/{upload}/manifest?offset=0'
            client.request('POST', path, manifest[:20], headers)
            reply = client.getresponse(); self.assertEqual(reply.status, 200)
            self.assertEqual(json.loads(reply.read())['result']['offset'], 20)
            folder = self.uploads.folder(fixtures.OWNER.user_id, upload)
            self.assertTrue(folder.is_relative_to(self.w.cold.root))
            part = folder/'manifest.part'; self.assertEqual(part.read_bytes(), manifest[:20])
            self.hdd_available = False
            client.request('POST', f'/v1/uploads/{upload}/manifest?offset=20', manifest[20:], headers)
            reply = client.getresponse(); self.assertEqual(reply.status, 409); reply.read()
            self.assertEqual(part.read_bytes(), manifest[:20])
        self.assertFalse((self.fixture.hot.root/'.uploads').exists())

    def test_view_rejects_original_warehouse_config_drift_without_ssd_fallback(self):
        config = json.loads((self.fixture.root/'node-config.json').read_text())
        config['storageWarehouse'] = {**config['storageWarehouse'], 'root': '/changed'}
        (self.fixture.root/'node-config.json').write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, 'Warehouse storage configuration changed'):
            DIRECT.DirectUploads(self.w.view, self.uploads).configuration()
        self.assertEqual(self.uploads.cache.root, self.w.cold.root)
        self.assertFalse((self.fixture.hot.root/'.uploads').exists())


if __name__ == '__main__':
    unittest.main()
