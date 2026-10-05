"""Direct data-plane tests use only temporary files and a loopback TLS fixture."""
import hashlib
import concurrent.futures
from contextlib import contextmanager
import http.client
import importlib.util
import json
import io
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
        self.node.platform_root_check = lambda: None
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

    def test_platform_mount_loss_rejects_before_upload_read_or_write(self):
        with patch.object(self.node, 'platform_root_check', side_effect=ValueError('platform unavailable')), \
                patch.object(self.direct, 'claims') as claims:
            with self.assertRaisesRegex(ValueError, 'platform unavailable'):
                self.direct.process('unused', 'unused', 'chunk', {}, b'no write')
            claims.assert_not_called()

    def raw(self, grant, upload, action, **args):
        data = args.pop('data', b'')
        return self.direct.process(grant['ticket'], upload, action, args, data)

    def fixture_grant_claims(self, grant, upload, claims):
        # Model a ticket actually issued by an older listener, not a forged
        # client upgrade. Only this private fixture writes the matching record.
        token = DIRECT.encoded(claims)+'.'+grant['ticket'].split('.')[1]
        fixtures.D._write_json(self.u.folder(self.user, upload)/'direct-grant.json',
                              {'claims': claims, 'sha256': hashlib.sha256(token.encode()).hexdigest()})
        return {**grant, 'ticket': token, 'expiresAt': claims['expiresAt']}

    def test_file_capability_is_bound_and_legacy_tickets_keep_one_mib(self):
        content = b'x'*(fixtures.D.CHUNK_BYTES+1)
        result, _, _ = self.seal(files={'x': content})
        upload = result['uploadId']; grant = self.ticket(upload)
        claims = self.direct.claims(grant['ticket'])
        self.assertEqual(grant['chunkBytes'], fixtures.D.CHUNK_BYTES)
        self.assertEqual(grant['maxChunkBytes'], DIRECT.MAX_FILE_CHUNK_BYTES)
        self.assertEqual(claims['maxChunkBytes'], grant['maxChunkBytes'])
        self.assertEqual(fixtures.D._read_json(self.u.folder(self.user, upload)/'direct-grant.json')['claims'], claims)
        legacy_claims = {key: value for key, value in claims.items() if key != 'maxChunkBytes'}
        legacy = self.fixture_grant_claims(grant, upload, legacy_claims)
        with self.assertRaises(ValueError):
            self.raw(legacy, upload, 'chunk', path='x', offset=0, data=content)
        # Editing a legacy opaque ticket cannot silently acquire the new cap.
        forged = {**legacy, 'ticket': DIRECT.encoded({**legacy_claims, 'maxChunkBytes': DIRECT.MAX_FILE_CHUNK_BYTES})+'.'+legacy['ticket'].split('.')[1]}
        with self.assertRaises(DIRECT.GrantError):
            self.raw(forged, upload, 'chunk', path='x', offset=0, data=content)
        self.assertEqual(self.raw(legacy, upload, 'chunk', path='x', offset=0,
                                  data=content[:fixtures.D.CHUNK_BYTES])['offset'], fixtures.D.CHUNK_BYTES)
        for cap in (None, True, str(DIRECT.MAX_FILE_CHUNK_BYTES), 0, DIRECT.MAX_FILE_CHUNK_BYTES+1):
            invalid = self.fixture_grant_claims(grant, upload, {**claims, 'maxChunkBytes': cap})
            with self.subTest(cap=cap), self.assertRaises(DIRECT.GrantError):
                self.raw(invalid, upload, 'status')
        self.assertEqual(self.call('status', uploadId=upload, path='x')['file']['offset'], fixtures.D.CHUNK_BYTES)

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
            self.raw(grant, upload, 'chunk', path='train.txt', offset=0, data=b'x'*(DIRECT.MAX_FILE_CHUNK_BYTES+1))
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

    def test_browser_origins_are_optional_exact_https_and_revision_bound(self):
        cert, key, _ = self.tls_fixture()
        direct = DIRECT.DirectUploads(self.node, self.u)
        config = {'enabled': True, 'bind': '192.168.77.104', 'port': 18444,
                  'endpoint': 'https://upload.example.test:18444', 'certificate': str(cert), 'privateKey': str(key)}
        self.node.CONFIG['directUpload'] = config
        old = direct.configuration()
        self.assertNotIn('allowedOrigins', old)
        self.node.CONFIG['directUpload'] = {**config, 'allowedOrigins': ['https://portal.example.test:443/']}
        browser = direct.configuration()
        self.assertEqual(browser['allowedOrigins'], ['https://portal.example.test'])
        self.assertNotEqual(browser['revision'], old['revision'])
        for value in ('*', ['*'], ['null'], ['http://portal.example.test'], ['https://*.example.test'],
                      ['https://portal.example.test/path'], ['https://user:pass@portal.example.test'],
                      ['https://portal.example.test?secret=x'], ['https://portal.example.test\r\nX: y'],
                      ['https://portal.example.test']*2,
                      ['https://portal.example.test', 'https://portal.example.test:443/'],
                      [f'https://portal{i}.example.test' for i in range(9)]):
            self.node.CONFIG['directUpload'] = {**config, 'allowedOrigins': value}
            with self.subTest(value=value), self.assertRaises(ValueError):
                direct.configuration()

    def test_browser_preflight_raw_upload_and_errors_preserve_ticket_fencing(self):
        cert, key, pin = self.tls_fixture()
        listener = socket.socket(); listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]; listener.close()
        origin = 'https://portal.example.test'
        self.config.update(bind='127.0.0.1', port=port, endpoint=f'https://localhost:{port}',
                           certificate=str(cert), privateKey=str(key), certificateSha256=pin,
                           allowedOrigins=[origin])
        with patch.object(DIRECT.DirectUploads, 'configuration', return_value=self.config):
            server = DIRECT.create_server(self.node, self.u)
            accepted_options = []
            accept = server.get_request
            def observed_accept():
                connection, address = accept()
                accepted_options.append(bool(connection.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY)))
                return connection, address
            server.get_request = observed_accept
            serving = threading.Thread(target=server.serve_forever, daemon=True); serving.start()
            try:
                initial, _, manifest, _ = self.admit(); upload = initial['uploadId']; grant = self.ticket(upload)
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.check_hostname = False; context.verify_mode = ssl.CERT_NONE
                client = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=3)
                path = f'/v1/uploads/{upload}/manifest?offset=0'
                preflight = {'Origin': origin, 'Access-Control-Request-Method': 'POST',
                             'Access-Control-Request-Headers': 'Authorization, Content-Type',
                             'Access-Control-Request-Private-Network': 'true'}
                before = self.u.load(self.user, upload)
                client.request('OPTIONS', path, headers=preflight)
                reply = client.getresponse(); self.assertEqual(reply.status, 204)
                self.assertEqual(reply.read(), b'')
                self.assertEqual(accepted_options, [True])
                self.assertEqual(reply.getheader('Access-Control-Allow-Origin'), origin)
                self.assertEqual(reply.getheader('Access-Control-Allow-Private-Network'), 'true')
                self.assertEqual(reply.getheader('Access-Control-Allow-Methods'), 'POST')
                self.assertIsNone(reply.getheader('Access-Control-Allow-Credentials'))
                self.assertEqual(self.u.load(self.user, upload), before)
                for change, route in (({'Origin': 'https://evil.example.test'}, path),
                                      ({'Origin': 'null'}, path),
                                      ({'Access-Control-Request-Method': 'DELETE'}, path),
                                      ({'Access-Control-Request-Headers': 'cookie'}, path),
                                      ({'Access-Control-Request-Headers': 'authorization,authorization'}, path),
                                      ({'Access-Control-Request-Private-Network': 'false'}, path),
                                      ({}, '/v1/uploads/'+upload+'/exec')):
                    client.request('OPTIONS', route, headers={**preflight, **change})
                    reply = client.getresponse(); self.assertIn(reply.status, (403, 409)); reply.read()
                    if 'Origin' in change:
                        self.assertIsNone(reply.getheader('Access-Control-Allow-Origin'))
                    self.assertIsNone(reply.getheader('Access-Control-Allow-Private-Network'))
                headers = {'Origin': origin, 'Authorization': 'Bearer '+grant['ticket'],
                           'Content-Type': 'application/octet-stream'}
                with patch.object(self.u, 'manifest_bytes', side_effect=AssertionError('Bad Origin must not write')):
                    client.request('POST', path, manifest, {**headers, 'Origin': 'https://evil.example.test'})
                    reply = client.getresponse(); self.assertEqual(reply.status, 403)
                    self.assertIsNone(reply.getheader('Access-Control-Allow-Origin')); reply.read()
                client.request('POST', path, manifest, headers)
                reply = client.getresponse(); self.assertEqual(reply.status, 200)
                self.assertEqual(reply.getheader('Access-Control-Allow-Origin'), origin)
                self.assertEqual(json.loads(reply.read())['result']['offset'], len(manifest))
                client.request('GET', f'/v1/uploads/{upload}/status', headers={'Origin': origin, 'Authorization': headers['Authorization']})
                reply = client.getresponse(); self.assertEqual(reply.status, 200)
                self.assertEqual(json.loads(reply.read())['result']['manifestOffset'], len(manifest))
                self.call('direct-revoke', uploadId=upload)
                client.request('GET', f'/v1/uploads/{upload}/status', headers={'Origin': origin, 'Authorization': headers['Authorization']})
                reply = client.getresponse(); self.assertEqual(reply.status, 403)
                self.assertEqual(reply.getheader('Access-Control-Allow-Origin'), origin)
                self.assertNotIn(grant['ticket'], reply.read().decode())
                client.close()
            finally:
                server.shutdown(); server.server_close(); serving.join(3)

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

    def test_real_https_sixteen_mib_ack_preserves_reservation_and_full_sha_ready(self):
        cert, key, pin = self.tls_fixture()
        self.config.update(bind='127.0.0.1', port=0, certificate=str(cert), privateKey=str(key), certificateSha256=pin)
        content = b'q'*DIRECT.MAX_FILE_CHUNK_BYTES+b'tail'
        result, _, manifest, _ = self.admit(files={'large.bin': content})
        upload = result['uploadId']
        with patch.object(DIRECT.DirectUploads, 'configuration', side_effect=lambda: dict(self.config)):
            server = DIRECT.create_server(self.node, self.u)
            port = server.server_address[1]
            self.config.update(port=port, endpoint=f'https://localhost:{port}')
            serving = threading.Thread(target=server.serve_forever, daemon=True); serving.start()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False; context.verify_mode = ssl.CERT_NONE
            client = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=5)
            try:
                client.connect()
                self.assertEqual(hashlib.sha256(client.sock.getpeercert(binary_form=True)).hexdigest(), pin)
                grant = self.ticket(upload)
                headers = {'Authorization': 'Bearer '+grant['ticket'], 'Content-Type': 'application/octet-stream'}
                def send(action, query, payload=None):
                    client.request('GET' if action == 'status' else 'POST',
                                   f'/v1/uploads/{upload}/{action}?{query}', payload, headers)
                    reply = client.getresponse(); self.assertEqual(reply.status, 200)
                    return json.loads(reply.read())['result']
                self.assertEqual(send('manifest', 'offset=0', manifest)['offset'], len(manifest))
                self.call('seal', uploadId=upload)
                self.assertEqual(self.u.worker(self.user, upload, 'seal'), 0)
                session = self.u.load(self.user, upload)
                stage = self.cache._paths(session['dataset'], session['version'])['.staging']
                first = send('chunk', 'path=large.bin&offset=0', content[:DIRECT.MAX_FILE_CHUNK_BYTES])
                self.assertEqual(first['offset'], DIRECT.MAX_FILE_CHUNK_BYTES)
                self.assertFalse(first['complete'])
                self.assertEqual(self.cache._transfer(stage)['remainingBytes'], 4)
                self.assertFalse((self.u.folder(self.user, upload)/'chunk.json').exists())
                # Durable ACK can be checked by a fresh HTTPS status request;
                # an identical offset retry consumes no second reservation.
                self.assertEqual(send('status', 'path=large.bin')['file']['offset'], DIRECT.MAX_FILE_CHUNK_BYTES)
                send('chunk', 'path=large.bin&offset=0', content[:DIRECT.MAX_FILE_CHUNK_BYTES])
                self.assertEqual(self.cache._transfer(stage)['remainingBytes'], 4)
                self.assertTrue(send('chunk', f'path=large.bin&offset={DIRECT.MAX_FILE_CHUNK_BYTES}', content[-4:])['complete'])
                self.assertEqual(self.cache._transfer(stage)['remainingBytes'], 0)
                self.call('commit', uploadId=upload)
                self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
                self.assertEqual(self.call('status', uploadId=upload)['state'], 'READY')
                ready = self.cache._paths(session['dataset'], session['version'])['ready']/'data'/'large.bin'
                self.assertEqual(hashlib.sha256(ready.read_bytes()).hexdigest(), hashlib.sha256(content).hexdigest())
                self.assertEqual(ready.stat().st_mode & 0o777, 0o444)
                self.assertEqual(self.cache._reserved(), 0)
            finally:
                client.close(); server.shutdown(); server.server_close(); serving.join(3)

    def test_real_https_rejects_expired_forged_and_oversized_caps_before_body(self):
        cert, key, pin = self.tls_fixture()
        self.config.update(bind='127.0.0.1', port=0, certificate=str(cert), privateKey=str(key), certificateSha256=pin)
        result, _, _, _ = self.admit(files={'x': b'x'})
        upload = result['uploadId']
        with patch.object(DIRECT.DirectUploads, 'configuration', side_effect=lambda: dict(self.config)):
            server = DIRECT.create_server(self.node, self.u)
            port = server.server_address[1]; self.config.update(port=port, endpoint=f'https://localhost:{port}')
            serving = threading.Thread(target=server.serve_forever, daemon=True); serving.start()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False; context.verify_mode = ssl.CERT_NONE
            try:
                for case in ('over-hard-limit', 'manifest-large', 'legacy-large', 'expired', 'forged-cap', 'invalid-cap', 'revoked'):
                    grant = self.ticket(upload); claims = self.direct.claims(grant['ticket'])
                    size = DIRECT.MAX_FILE_CHUNK_BYTES; action = 'chunk'; expected = 409
                    if case == 'over-hard-limit': size += 1
                    elif case == 'manifest-large': action = 'manifest'; size = fixtures.D.CHUNK_BYTES+1
                    elif case == 'legacy-large':
                        grant = self.fixture_grant_claims(grant, upload, {k: v for k, v in claims.items() if k != 'maxChunkBytes'})
                        size = fixtures.D.CHUNK_BYTES+1
                    elif case == 'expired':
                        grant = self.fixture_grant_claims(grant, upload, {**claims, 'expiresAt': int(time.time())-1}); expected = 401
                    elif case == 'forged-cap':
                        grant = {**grant, 'ticket': DIRECT.encoded({**claims, 'maxChunkBytes': fixtures.D.CHUNK_BYTES})+'.'+grant['ticket'].split('.')[1]}; expected = 403
                    elif case == 'invalid-cap':
                        grant = self.fixture_grant_claims(grant, upload, {**claims, 'maxChunkBytes': True}); expected = 403
                    else:
                        self.call('direct-revoke', uploadId=upload); expected = 403
                    client = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=2)
                    try:
                        query = 'offset=0'+('&path=x' if action == 'chunk' else '')
                        client.putrequest('POST', f'/v1/uploads/{upload}/{action}?{query}')
                        client.putheader('Authorization', 'Bearer '+grant['ticket'])
                        client.putheader('Content-Type', 'application/octet-stream')
                        client.putheader('Content-Length', str(size)); client.endheaders()
                        # Send no body at all: a timely response proves auth and
                        # action/capacity rejection precede the blocking read.
                        reply = client.getresponse()
                        with self.subTest(case=case): self.assertEqual(reply.status, expected)
                        body = reply.read().decode(); self.assertNotIn(grant['ticket'], body)
                        self.assertEqual(self.u.load(self.user, upload)['state'], 'RECEIVING_MANIFEST')
                        self.assertEqual(self.call('status', uploadId=upload)['manifestOffset'], 0)
                    finally:
                        client.close()
            finally:
                server.shutdown(); server.server_close(); serving.join(3)

    @contextmanager
    def admission_listener(self):
        cert, key, pin = self.tls_fixture()
        self.config.update(bind='127.0.0.1', port=0, certificate=str(cert),
                           privateKey=str(key), certificateSha256=pin)
        with patch.object(DIRECT.DirectUploads, 'configuration', side_effect=lambda: dict(self.config)):
            server = DIRECT.create_server(self.node, self.u)
            self.config.update(port=server.server_address[1], endpoint=f'https://localhost:{server.server_address[1]}')
            serving = threading.Thread(target=server.serve_forever, daemon=True); serving.start()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False; context.verify_mode = ssl.CERT_NONE
            try:
                yield server, context
            finally:
                server.shutdown(); server.server_close(); serving.join(3)

    def test_real_https_rejects_header_bytes_fields_and_expect_before_body(self):
        with self.admission_listener() as (server, context):
            for headers, expected in (({'X-Large': 'x'*DIRECT.MAX_HEADER_BYTES}, 431),
                                      ({'X-'+str(i): 'v' for i in range(65)}, 431),
                                      ({'Expect': '100-continue', 'Content-Length': '100'}, 417)):
                client = http.client.HTTPSConnection('127.0.0.1', server.server_address[1], context=context, timeout=3)
                try:
                    client.putrequest('GET', '/capabilities')
                    for name, value in headers.items(): client.putheader(name, value)
                    client.endheaders()
                    response = client.getresponse()
                    self.assertEqual(response.status, expected); response.read()
                finally:
                    client.close()

    def test_real_tls_slow_handshakes_release_capacity_without_http_workers(self):
        with patch.object(DIRECT, 'HANDSHAKE_TIMEOUT', 0.15), self.admission_listener() as (server, context):
            slow = [socket.create_connection(server.server_address, timeout=2) for _ in range(8)]
            try:
                for connection in slow:
                    connection.settimeout(2)
                    try: self.assertEqual(connection.recv(1), b'')
                    except ConnectionResetError: pass
                client = http.client.HTTPSConnection('127.0.0.1', server.server_address[1], context=context, timeout=2)
                try:
                    client.request('GET', '/capabilities')
                    response = client.getresponse(); self.assertEqual(response.status, 200); response.read()
                finally:
                    client.close()
            finally:
                for connection in slow: connection.close()

    def test_real_https_partial_headers_expire_before_request_deadline(self):
        with patch.object(DIRECT, 'HEADER_TIMEOUT', 0.15), self.admission_listener() as (server, context):
            connection = context.wrap_socket(socket.create_connection(server.server_address, timeout=2), server_hostname='localhost')
            try:
                connection.sendall(b'GET /capabilities HTTP/1.1\r\nX-Slow: ')
                connection.settimeout(2)
                self.assertEqual(connection.recv(1), b'')
            finally:
                connection.close()

    def test_real_https_stale_anonymous_connections_do_not_exclude_new_member(self):
        with patch.object(DIRECT, 'STALE_ANONYMOUS_SECONDS', 0.05), self.admission_listener() as (server, context):
            initial, _, _, _ = self.admit(); upload = initial['uploadId']; grant = self.ticket(upload)
            slow = []
            try:
                for _ in range(8):
                    connection = context.wrap_socket(socket.create_connection(server.server_address, timeout=3), server_hostname='localhost')
                    connection.sendall(b'GET /capabilities HTTP/1.1\r\nX-Slow: ')
                    slow.append(connection)
                time.sleep(0.08)
                client = http.client.HTTPSConnection('127.0.0.1', server.server_address[1], context=context, timeout=3)
                try:
                    client.request('GET', f'/v1/uploads/{upload}/status', headers={'Authorization': 'Bearer '+grant['ticket']})
                    reply = client.getresponse(); self.assertEqual(reply.status, 200)
                    self.assertEqual(json.loads(reply.read())['result']['manifestOffset'], 0)
                finally:
                    client.close()
            finally:
                for connection in slow: connection.close()

    def test_same_nat_eight_authenticated_sixteen_mib_chunks_remain_parallel(self):
        content = b'p'*DIRECT.MAX_FILE_CHUNK_BYTES
        prepared = []
        for number in range(1, 9):
            user = 'demo-user-'+str(number)
            response, _, _ = self.seal(files={'large.bin': content}, user=user)
            prepared.append((user, response['uploadId']))
        with self.admission_listener() as (server, context):
            clients, inputs = [], []
            for user, upload in prepared:
                grant = self.ticket(upload, user=user)
                client = http.client.HTTPSConnection('127.0.0.1', server.server_address[1], context=context, timeout=12)
                client.connect(); clients.append(client)
                inputs.append((client, user, upload, grant))
            barrier = threading.Barrier(8, timeout=10)
            original = self.u.chunk_bytes
            def concurrently_authenticated(*args, **kwargs):
                barrier.wait()
                return original(*args, **kwargs)
            def upload_one(item):
                client, user, upload, grant = item
                client.request('POST', f'/v1/uploads/{upload}/chunk?path=large.bin&offset=0', content,
                               {'Authorization': 'Bearer '+grant['ticket'], 'Content-Type': 'application/octet-stream'})
                reply = client.getresponse()
                self.assertEqual(reply.status, 200)
                self.assertEqual(json.loads(reply.read())['result']['offset'], len(content))
                return user, upload
            try:
                with patch.object(self.u, 'chunk_bytes', side_effect=concurrently_authenticated), \
                        concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                    completed = list(pool.map(upload_one, inputs))
                self.assertEqual(len(completed), 8)
                # The same persistent connections can continue authenticated
                # requests; neither NAT fairness nor anonymous budgets rate-
                # limit the data plane. Existing full-commit test checks SHA.
                for client, user, upload, grant in inputs:
                    client.request('GET', f'/v1/uploads/{upload}/status?path=large.bin',
                                   headers={'Authorization': 'Bearer '+grant['ticket']})
                    reply = client.getresponse(); self.assertEqual(reply.status, 200)
                    self.assertEqual(json.loads(reply.read())['result']['file']['offset'], len(content))
            finally:
                for client in clients: client.close()


class AdmissionUnitTests(unittest.TestCase):
    def test_header_budget_is_aggregate_and_does_not_consume_body(self):
        body = b'body-not-headers'
        stream = io.BytesIO(b'X: a\r\nY: b\r\n\r\n'+body)
        reader = DIRECT.HeaderBudget(stream)
        self.assertEqual(http.client.parse_headers(reader)['X'], 'a')
        self.assertEqual(stream.read(), body)
        stream = io.BytesIO(b''.join(b'X: '+b'x'*1020+b'\r\n' for _ in range(40)))
        with self.assertRaises(http.client.LineTooLong):
            http.client.parse_headers(DIRECT.HeaderBudget(stream))

    def test_eight_same_nat_clients_are_not_subject_to_per_ip_data_cap(self):
        gate = DIRECT.ConnectionAdmission()
        clients = [object() for _ in range(8)]
        for client in clients:
            self.assertTrue(gate.acquire(client, '192.0.2.1'))
            self.assertTrue(gate.phase(client, True))
        with patch.object(DIRECT.time, 'monotonic', return_value=time.monotonic()+60):
            self.assertFalse(gate.acquire(object(), '192.0.2.2'))
        self.assertEqual(len(gate.active), 8)

    def test_stale_anonymous_replacement_fences_auth_and_waits_for_release(self):
        gate = DIRECT.ConnectionAdmission()
        class SlowSocket:
            def shutdown(inner, how):
                self.assertFalse(gate.phase(inner, True), 'retirement must win the auth race')
                self.assertEqual(len(gate.active), 8, 'no ninth worker during retirement')
                gate.release(inner)
        clients = [SlowSocket() for _ in range(8)]
        for client in clients: self.assertTrue(gate.acquire(client, '192.0.2.1'))
        self.assertFalse(gate.acquire(object(), '192.0.2.2'), 'fresh NAT handshakes are not evicted')
        for row in gate.active.values(): row['waiting'] -= 3
        first_waiting = gate.active[clients[1]]['waiting']
        self.assertTrue(gate.phase(clients[1], False))
        self.assertEqual(gate.active[clients[1]]['waiting'], first_waiting,
                         'repeated anonymous probes must not reset eviction age')
        self.assertTrue(gate.phase(clients[0], True))
        newcomer = object()
        self.assertTrue(gate.acquire(newcomer, '192.0.2.2'))
        self.assertIn(clients[0], gate.active, 'authenticated body must survive saturation')
        self.assertIn(newcomer, gate.active)
        self.assertEqual(len(gate.active), 8)

    def test_handshake_and_probe_budgets_are_separate_bounded_and_refill(self):
        gate = DIRECT.ConnectionAdmission()
        with patch.object(DIRECT.time, 'monotonic', return_value=100):
            for _ in range(64):
                client = object(); self.assertTrue(gate.acquire(client, '192.0.2.1')); gate.release(client)
            self.assertFalse(gate.acquire(object(), '192.0.2.1'))
            for _ in range(128): self.assertTrue(gate.anonymous_request('192.0.2.1'))
            self.assertFalse(gate.anonymous_request('192.0.2.1'))
            # Unique chunk URLs can force a browser preflight on every 1 MiB
            # block. This separate budget must not cap a shared gigabit NAT.
            for _ in range(2048): self.assertTrue(gate.anonymous_request('192.0.2.1', 'preflight'))
            self.assertFalse(gate.anonymous_request('192.0.2.1', 'preflight'))
            other = object(); self.assertTrue(gate.acquire(other, '192.0.2.2')); gate.release(other)
        with patch.object(DIRECT.time, 'monotonic', return_value=101):
            client = object(); self.assertTrue(gate.acquire(client, '192.0.2.1')); gate.release(client)
            self.assertTrue(gate.anonymous_request('192.0.2.1'))
        for index in range(1100):
            with patch.object(DIRECT.time, 'monotonic', return_value=200+index):
                self.assertTrue(gate.anonymous_request(str(index)))
        self.assertEqual(len(gate.peers), 1024)


if __name__ == '__main__':
    unittest.main()
