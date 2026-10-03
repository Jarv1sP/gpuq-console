"""Direct data-plane tests use only temporary files and a loopback TLS fixture."""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import threading
import time
import unittest
import uuid
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('upload_fixtures', HERE/'dataset-upload.test.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
DIRECT = fixtures.module('direct_upload_tests', 'direct-upload.py')


class DirectTests(unittest.TestCase):
    call = fixtures.PersonalUploads.call
    admit = fixtures.PersonalUploads.admit
    seal = fixtures.PersonalUploads.seal
    fill = fixtures.PersonalUploads.fill

    def setUp(self):
        fixtures.PersonalUploads.setUp(self)
        self.node.CONFIG['machine'] = 'gpu-4'
        self.mounts = []
        self.node.dataset_mount_check = lambda config: self.mounts.append(True)
        self.direct = DIRECT.DirectUploads(self.node, self.u)
        self.config = {'enabled': True, 'bind': '192.168.77.104', 'port': 18444,
                       'endpoint': 'https://upload.example.test:18444', 'certificate': '/fixture/cert',
                       'privateKey': '/fixture/key', 'machine': 'gpu-4',
                       'certificateSha256': 'a'*64, 'revision': 'b'*64}
        self.config_patch = patch.object(self.direct, 'configuration', side_effect=lambda: dict(self.config))
        self.config_patch.start()
        self.probe_patch = patch.object(self.direct, 'probe')
        self.probe_patch.start()

    def tearDown(self):
        self.config_patch.stop()
        self.probe_patch.stop()
        fixtures.PersonalUploads.tearDown(self)

    def ticket(self, upload, user=None):
        return self.direct.issue(user or self.user, upload)

    def raw(self, grant, upload, action, **args):
        data = args.pop('data', b'')
        return self.direct.process(grant['ticket'], upload, action, args, data)

    def test_raw_lifecycle_uses_same_upload_and_publishes_verified_readonly(self):
        initial, args, manifest, files = self.admit()
        upload = initial['uploadId']
        grant = self.ticket(upload)
        self.assertTrue(grant['available'])
        self.assertEqual(grant['protocol'], DIRECT.PROTOCOL)
        self.assertLessEqual(grant['expiresAt']-time.time(), 300)
        self.assertNotIn(grant['ticket'], (self.u.folder(self.user, upload)/'direct-grant.json').read_text())
        with patch.object(self.u, 'decoded', side_effect=AssertionError('No base64 data path')):
            first = self.raw(grant, upload, 'manifest', offset=0, data=manifest[:25])
            self.assertEqual(first['offset'], 25)
            self.assertEqual(first['lastConfirmedRoute'], 'campus-direct')
            self.assertEqual(self.raw(grant, upload, 'manifest', offset=0, data=manifest[:25])['offset'], 25)
            self.raw(grant, upload, 'manifest', offset=25, data=manifest[25:])
            self.call('seal', uploadId=upload)
            self.assertEqual(self.u.worker(self.user, upload, 'seal'), 0)
            for path, data in files.items():
                self.raw(grant, upload, 'chunk', offset=0, path=path, data=data)
                self.assertTrue(self.raw(grant, upload, 'status', path=path)['file']['complete'])
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        result = self.call('status', uploadId=upload)
        self.assertEqual(result['state'], 'READY')
        ready = self.cache._paths(result['dataset'], result['version'])['ready']/'data'/'train.txt'
        self.assertEqual(ready.read_bytes(), files['train.txt'])
        self.assertEqual(ready.stat().st_mode & 0o777, 0o444)
        self.assertGreater(len(self.mounts), 0)

    def test_grant_is_exact_owner_upload_machine_config_and_operations(self):
        first, _, _, _ = self.admit()
        second, _, _, _ = self.admit(name='second')
        upload = first['uploadId']
        grant = self.ticket(upload)
        with self.assertRaises(FileNotFoundError):
            self.ticket(upload, 'demo-user-2')
        with self.assertRaises(DIRECT.GrantError):
            self.raw(grant, second['uploadId'], 'status')
        for action in ('commit', 'seal', 'discard', 'begin', 'exec'):
            with self.subTest(action=action), self.assertRaises(DIRECT.GrantError):
                self.raw(grant, upload, action)
        for key in ('machine', 'revision'):
            previous = self.config[key]
            self.config[key] = 'wrong'
            with self.subTest(key=key), self.assertRaises(DIRECT.GrantError):
                self.raw(grant, upload, 'status')
            self.config[key] = previous

    def test_token_tampering_expiry_and_refresh(self):
        result, _, _, _ = self.admit()
        upload = result['uploadId']
        grant = self.ticket(upload)
        claims = self.direct.claims(grant['ticket'])
        claims['userId'] = 'demo-user-2'
        forged = {**grant, 'ticket': DIRECT.encoded(claims)+'.'+grant['ticket'].split('.')[1]}
        with self.assertRaises((DIRECT.GrantError, FileNotFoundError)):
            self.raw(forged, upload, 'status')
        for ticket in ('', 'bad', 'x'*4097, grant['ticket'][:-1]+'!'):
            with self.subTest(ticket=ticket[:8]), self.assertRaises(DIRECT.GrantError):
                self.direct.claims(ticket)
        with patch.object(DIRECT.time, 'time', return_value=grant['expiresAt']):
            with self.assertRaisesRegex(DIRECT.GrantError, 'grant-expired'):
                self.raw(grant, upload, 'status')
        refreshed = self.ticket(upload)
        with self.assertRaises(DIRECT.GrantError):
            self.raw(grant, upload, 'status')
        self.assertEqual(self.raw(refreshed, upload, 'status')['uploadId'], upload)

    def test_forged_identity_and_upload_cannot_create_workspaces_or_locks(self):
        result, _, _, _ = self.admit()
        grant = self.ticket(result['uploadId'])
        claims = self.direct.claims(grant['ticket'])
        before = sorted(str(path.relative_to(self.base)) for path in self.base.rglob('*'))
        for update in ({'userId': 'demo-user-9999'}, {'uploadId': str(uuid.uuid4())}, {'userId': '../outside'}):
            value = {**claims, **update}
            token = DIRECT.encoded(value)+'.'+grant['ticket'].split('.')[1]
            with patch.object(self.u, 'actor', side_effect=AssertionError('Unauthenticated actor called')):
                with self.assertRaises(DIRECT.GrantError):
                    self.direct.process(token, value['uploadId'], 'status', {})
            self.assertEqual(sorted(str(path.relative_to(self.base)) for path in self.base.rglob('*')), before)

    def test_revoke_pause_and_discard_fence_existing_token(self):
        for action in ('direct-revoke', 'pause', 'discard'):
            with self.subTest(action=action):
                result, args, _, _ = self.admit(name='test-'+action)
                upload = result['uploadId']
                grant = self.ticket(upload)
                self.call(action, uploadId=upload)
                with self.assertRaises(DIRECT.GrantError):
                    self.raw(grant, upload, 'manifest', offset=0, data=b'x')
                with self.assertRaises(ValueError):
                    self.ticket(upload)
                if action != 'discard':
                    self.call('begin', **args)
                    self.assertTrue(self.ticket(upload)['available'])

    def test_cancel_waits_for_inflight_direct_write(self):
        result, _, manifest, _ = self.admit()
        upload = result['uploadId']
        grant = self.ticket(upload)
        entered, release, canceled = threading.Event(), threading.Event(), threading.Event()
        original = self.u.manifest_bytes
        def blocked(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(3))
            return original(*args, **kwargs)
        with patch.object(self.u, 'manifest_bytes', side_effect=blocked):
            writing = threading.Thread(target=lambda: self.raw(grant, upload, 'manifest', offset=0, data=manifest))
            writing.start()
            self.assertTrue(entered.wait(3))
            canceling = threading.Thread(target=lambda: (self.call('direct-revoke', uploadId=upload), canceled.set()))
            canceling.start()
            self.assertFalse(canceled.wait(.1))
            release.set()
            writing.join(3)
            canceling.join(3)
        self.assertTrue(canceled.is_set())
        with self.assertRaises(DIRECT.GrantError):
            self.raw(grant, upload, 'status')

    def test_large_relay_requires_explicit_begin_opt_in(self):
        result, args, manifest, _ = self.admit(declared_total=DIRECT.RELAY_LIMIT_BYTES+1)
        upload = result['uploadId']
        self.assertFalse(result['uploadTransport']['relayAllowed'])
        with self.assertRaisesRegex(ValueError, 'no VPS fallback'):
            self.call('manifest', uploadId=upload, offset=0, data='eA==')
        # Raw direct bytes are admitted under the existing reservation instead.
        self.raw(self.ticket(upload), upload, 'manifest', offset=0, data=manifest[:1])
        resumed = self.call('begin', **args, allowRelay=True)
        self.assertTrue(resumed['uploadTransport']['relayAllowed'])
        receipt = self.call('manifest', uploadId=upload, offset=0, data=__import__('base64').b64encode(manifest[:1]).decode())
        self.assertEqual(receipt['lastConfirmedRoute'], 'vps-relay')
        with self.assertRaises(ValueError):
            self.call('begin', **args, allowRelay='true')

    def test_relay_threshold_is_strictly_greater_than_256mib(self):
        result, _, _, _ = self.admit(declared_total=DIRECT.RELAY_LIMIT_BYTES)
        self.call('manifest', uploadId=result['uploadId'], offset=0, data='ew==')

    def test_raw_paths_offsets_ceiling_mount_and_manifest_identity(self):
        result, _, _ = self.seal()
        upload = result['uploadId']
        grant = self.ticket(upload)
        for args in ({'path': '../secret', 'offset': 0}, {'path': '/etc/passwd', 'offset': 0},
                     {'path': 'unknown', 'offset': 0}, {'path': 'train.txt', 'offset': -1},
                     {'path': 'train.txt', 'offset': True}, {'path': 'train.txt', 'offset': 2**63}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.raw(grant, upload, 'chunk', data=b'x', **args)
        with self.assertRaises(ValueError):
            self.raw(grant, upload, 'chunk', path='train.txt', offset=0, data=b'x'*(fixtures.D.CHUNK_BYTES+1))
        with patch.object(self.node, 'dataset_mount_check', side_effect=ValueError('wrong mount')):
            with self.assertRaises(ValueError):
                self.raw(grant, upload, 'status')
        session = self.u.load(self.user, upload)
        session['totalBytes'] += 1
        session['reserveBytes'] += 1
        self.u.save(session)
        with self.assertRaises(DIRECT.GrantError):
            self.raw(grant, upload, 'status')

    def test_disabled_and_unconfigured_are_explicit_not_ready(self):
        result, _, _, _ = self.admit()
        self.assertEqual(result['uploadTransport']['reason'], 'not-configured')
        self.assertFalse(result['uploadTransport']['directAvailable'])
        response = self.call('direct-ticket', uploadId=result['uploadId'])
        self.assertFalse(response['available'])
        self.assertNotIn('endpoint', response)
        self.node.CONFIG['directUpload'] = {'enabled': False}
        self.assertEqual(self.call('direct-ticket', uploadId=result['uploadId'])['reason'], 'disabled')
        with patch.object(self.direct, 'probe', side_effect=OSError('unreachable')):
            self.assertEqual(self.direct.availability(), {'available': False, 'reason': 'listener-unavailable'})
        self.node.CONFIG['directUpload'] = {'enabled': True, 'endpoint': []}
        with patch.object(self.u, 'direct', side_effect=ValueError('invalid optional module/config')):
            self.assertEqual(self.u.direct_transport(), {'available': False, 'reason': 'invalid-config'})
            value, _args, _raw, _files = self.admit(name='still-small')
            self.assertEqual(value['uploadTransport']['reason'], 'invalid-config')
        with patch.object(self.direct, 'configuration', side_effect=AttributeError('bad optional field')):
            self.assertEqual(self.direct.availability(), {'available': False, 'reason': 'invalid-config'})

    def tls_fixture(self):
        certificate, key = self.base/'certificate.pem', self.base/'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key),
                        '-out', str(certificate), '-days', '1', '-subj', '/CN=localhost'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        key.chmod(0o600)
        pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate.read_text())).hexdigest()
        return certificate, key, pin

    def test_config_validation_rejects_wildcard_public_binding_bad_tls_and_http(self):
        cert, key, pin = self.tls_fixture()
        direct = DIRECT.DirectUploads(self.node, self.u)
        config = {'enabled': True, 'bind': '192.168.77.104', 'port': 18444,
                  'endpoint': 'https://upload.example.test:18444', 'certificate': str(cert), 'privateKey': str(key)}
        self.node.CONFIG['directUpload'] = config
        self.assertEqual(direct.configuration()['certificateSha256'], pin)
        for update in ({'bind': '0.0.0.0'}, {'bind': '127.0.0.1'}, {'bind': '8.8.8.8'},
                       {'endpoint': 'http://example.test'}, {'endpoint': 'https://a:b@example.test'},
                       {'endpoint': 'https://example.test/path'}, {'port': True}, {'enabled': False}):
            self.node.CONFIG['directUpload'] = {**config, **update}
            with self.subTest(update=update), self.assertRaises(ValueError):
                direct.configuration()
        self.node.CONFIG['directUpload'] = config
        key.chmod(0o644)
        with self.assertRaises(ValueError):
            direct.configuration()

    def test_changed_dataset_config_fails_closed_until_restart(self):
        self.node.HERE = self.base
        # Local temporary synthetic config only; no real node config is read.
        (self.base/'node-config.json').write_text(json.dumps({**self.node.CONFIG, 'datasets': {'root': '/other'}}))
        with self.assertRaisesRegex(ValueError, 'storage configuration changed'):
            DIRECT.DirectUploads(self.node, self.u).configuration()

    def test_local_https_raw_protocol_and_rejection_have_no_secret_logs(self):
        cert, key, pin = self.tls_fixture()
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        listener.close()
        self.config.update(bind='127.0.0.1', port=port, endpoint=f'https://localhost:{port}',
                           certificate=str(cert), privateKey=str(key), certificateSha256=pin)
        # Only the test bypasses production's RFC1918 bind check, so no real LAN
        # listener or network configuration is required by regression tests.
        with patch.object(DIRECT.DirectUploads, 'configuration', return_value=self.config):
            server = DIRECT.create_server(self.node, self.u)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            try:
                result, _, manifest, _ = self.admit()
                upload = result['uploadId']
                grant = self.ticket(upload)
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                client = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=3)
                client.connect()
                self.assertEqual(hashlib.sha256(client.sock.getpeercert(binary_form=True)).hexdigest(), pin)
                headers = {'Authorization': 'Bearer '+grant['ticket'], 'Content-Type': 'application/octet-stream'}
                client.request('POST', f'/v1/uploads/{upload}/manifest?offset=0', manifest, headers)
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['result']['offset'], len(manifest))
                client.request('GET', f'/v1/uploads/{upload}/status', headers={'Authorization': headers['Authorization']})
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['result']['manifestOffset'], len(manifest))
                client.request('POST', f'/v1/uploads/{upload}/manifest?offset=0&offset=1', manifest, headers)
                response = client.getresponse()
                self.assertEqual(response.status, 409)
                error = response.read().decode()
                self.assertNotIn(grant['ticket'], error)
                self.assertNotIn(str(self.base), error)
                client.close()
                # Exercise actual local capability probe, not the fixture stub.
                DIRECT.DirectUploads.probe(self.direct, self.config)
                with self.assertRaises(ValueError):
                    DIRECT.DirectUploads.probe(self.direct, {**self.config, 'certificateSha256': '0'*64})
            finally:
                server.shutdown()
                server.server_close()
                serving.join(3)

    def test_empty_http_status_query_is_portable_to_python310(self):
        original = DIRECT.parse_qs
        def strict_older_python(query, **kwargs):
            if not query:
                raise ValueError('bad query field: empty')
            return original(query, **kwargs)
        # Keep the real TLS/framing/auth/raw upload flow and duplicate-query
        # rejection; simulate only Python 3.10's empty strict-query behavior.
        with patch.object(DIRECT, 'parse_qs', side_effect=strict_older_python):
            self.test_local_https_raw_protocol_and_rejection_have_no_secret_logs()


if __name__ == '__main__':
    unittest.main()
