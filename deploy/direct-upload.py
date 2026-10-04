"""Opt-in pinned-TLS data plane for an already admitted personal upload.

The portal issues/revokes a five-minute capability through its authenticated
node bridge. This listener accepts only bounded raw manifest/file chunks and
status; it cannot create uploads, select owners, publish, or run commands.
"""
import base64
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import stat
import threading
import time
from urllib.parse import parse_qs, urlsplit

PROTOCOL = 'dataset-upload-v1'
TTL_SECONDS = 300
OPERATIONS = ['manifest', 'chunk', 'status']
MAX_TICKET_BYTES = 4096
RELAY_LIMIT_BYTES = 256*1024**2
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')


class GrantError(PermissionError):
    def __init__(self, code='grant-invalid'):
        self.code = code
        super().__init__(code)


def encoded(value):
    return base64.urlsafe_b64encode(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).decode().rstrip('=')


class DirectUploads:
    def __init__(self, node, uploads):
        self.n, self.u = node, uploads

    def configuration(self):
        # Re-read only this local administrator-owned configuration, so a
        # disabled listener cannot keep honoring old tickets until restart.
        source = self.n.HERE/'node-config.json'
        if hasattr(self.n, '__file__') or source.exists():
            with self.u.d._directory(source.parent) as parent:
                fd = os.open(source.name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
                try:
                    if self.u.d._regular(fd).st_size > 1024*1024:
                        raise ValueError('Invalid node configuration')
                    with os.fdopen(os.dup(fd), 'rb') as stream:
                        whole = json.load(stream)
                finally:
                    os.close(fd)
        else:
            whole = self.n.CONFIG
        if not isinstance(whole, dict):
            raise ValueError('Invalid node configuration')
        if whole.get('datasets') != self.n.CONFIG.get('datasets'):
            raise ValueError('Dataset storage configuration changed; restart listener after validation')
        config = whole.get('directUpload')
        if (not isinstance(config, dict) or config.get('enabled') is not True
                or set(config) != {'enabled', 'bind', 'port', 'endpoint', 'certificate', 'privateKey'}):
            raise ValueError('Direct upload is not explicitly enabled')
        address = ipaddress.IPv4Address(config['bind'])
        networks = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
        if not any(address in ipaddress.IPv4Network(net) for net in networks):
            raise ValueError('Direct upload requires an explicit RFC1918 LAN address')
        if type(config['port']) is not int or not 1024 <= config['port'] <= 65535:
            raise ValueError('Invalid direct upload port')
        endpoint = urlsplit(config['endpoint'])
        if (endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password
                or endpoint.query or endpoint.fragment or endpoint.path not in ('', '/')
                or re.search(r'[\s\\\x00-\x1f]', config['endpoint'])
                or endpoint.port is not None and not 1 <= endpoint.port <= 65535):
            raise ValueError('Direct upload endpoint must be an exact HTTPS origin')
        machine = whole.get('machine')
        if not isinstance(machine, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', machine):
            raise ValueError('Node machine identity is required')
        for field in ('certificate', 'privateKey'):
            path = Path(config[field])
            if not path.is_absolute() or not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError('TLS files must be absolute regular files')
            if field == 'privateKey' and (path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077):
                raise ValueError('TLS key must be private to the service user')
        cert = Path(config['certificate']).read_text()
        leaf = re.search(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', cert, re.S)
        if not leaf:
            raise ValueError('TLS certificate is missing')
        pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(leaf.group())).hexdigest()
        hostname = endpoint.hostname.encode('idna').decode('ascii').lower()
        host = '['+hostname+']' if ':' in hostname else hostname
        origin = 'https://'+host+((':'+str(endpoint.port)) if endpoint.port not in (None, 443) else '')
        public = dict(config, endpoint=origin, machine=machine, certificateSha256=pin)
        public['revision'] = hashlib.sha256(encoded(public).encode()).hexdigest()
        return public

    def probe(self, config):
        # Connect locally to the explicit listener, not the public/campus
        # endpoint. This proves listener readiness only, not client reachability.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE  # Replaced by exact DER pin below.
        connection = http.client.HTTPSConnection(config['bind'], config['port'], context=context, timeout=2)
        try:
            connection.connect()
            actual = hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest()
            if not hmac.compare_digest(actual, config['certificateSha256']):
                raise ValueError('Direct listener certificate changed')
            connection.request('GET', '/capabilities')
            response = connection.getresponse()
            body = response.read(4097)
            if (response.status != 200 or len(body) > 4096
                    or json.loads(body) != {'protocol': PROTOCOL, 'listenerReady': True, 'revision': config['revision']}):
                raise ValueError('Direct listener is unavailable')
        finally:
            connection.close()

    def availability(self):
        try:
            config = self.configuration()
        except Exception:
            return {'available': False, 'reason': 'invalid-config'}
        try:
            self.probe(config)
        except Exception:
            return {'available': False, 'reason': 'listener-unavailable'}
        return {'available': True, 'reason': 'ready'}

    def issue(self, user, upload):
        config = self.configuration()
        self.probe(config)
        with self.u.direct_guard(user, upload):
            session = self.u.load(user, upload)
            if session['state'] in ('DISCARDED', 'DISCARDING', 'READY') or session.get('directPaused') is True:
                raise ValueError('Upload does not accept a direct grant')
            claims = {'schema': 1, 'machine': config['machine'], 'userId': user,
                      'uploadId': upload, 'expiresAt': int(time.time())+TTL_SECONDS,
                      'operations': OPERATIONS, 'revision': config['revision'],
                      **{k: session[k] for k in ('manifestSha256', 'manifestBytes', 'totalBytes', 'entries')}}
            token = encoded(claims)+'.'+secrets.token_urlsafe(32)
            self.u.d._write_json(self.u.folder(user, upload)/'direct-grant.json', {
                'claims': claims, 'sha256': hashlib.sha256(token.encode()).hexdigest()})
            return {'available': True, 'protocol': PROTOCOL, 'endpoint': config['endpoint'],
                    'certificateSha256': config['certificateSha256'], 'ticket': token,
                    'expiresAt': claims['expiresAt'], 'chunkBytes': self.u.d.CHUNK_BYTES}

    def claims(self, token):
        try:
            if not isinstance(token, str) or not 1 <= len(token) <= MAX_TICKET_BYTES:
                raise ValueError()
            body, secret = token.split('.')
            if not re.fullmatch(r'[A-Za-z0-9_-]{43}', secret) or not re.fullmatch(r'[A-Za-z0-9_-]+', body):
                raise ValueError()
            value = json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
            if (not isinstance(value, dict) or encoded(value) != body
                    or not isinstance(value.get('uploadId'), str) or not UUID.fullmatch(value['uploadId'])
                    or not isinstance(value.get('userId'), str)
                    or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]{1,18})', value['userId'])):
                raise ValueError()
            return value
        except Exception:
            raise GrantError() from None

    def authorize(self, token, claims, upload, action):
        config = self.configuration()
        if claims.get('uploadId') != upload or claims.get('machine') != config['machine'] or claims.get('revision') != config['revision']:
            raise GrantError()
        if type(claims.get('expiresAt')) is not int or claims['expiresAt'] <= int(time.time()):
            raise GrantError('grant-expired')
        if claims['expiresAt'] > int(time.time())+TTL_SECONDS+1 or claims.get('operations') != OPERATIONS or action not in OPERATIONS:
            raise GrantError()
        try:
            # Do not call actor()/folder()/guard() on untrusted claims: those
            # helpers may create workspaces or lockfiles. First authenticate the
            # opaque capability using a strictly derived read-only location.
            folder = self.u.root/hashlib.sha256(claims['userId'].encode()).hexdigest()/upload
            record = self.u.d._read_json(folder/'direct-grant.json')
            if (record.get('claims') != claims or not isinstance(record.get('sha256'), str)
                    or not hmac.compare_digest(record['sha256'], hashlib.sha256(token.encode()).hexdigest())):
                raise GrantError()
            session = self.u.load(claims['userId'], upload)
            if (session['state'] in ('DISCARDED', 'DISCARDING') or session.get('directPaused') is True
                    or any(session[k] != claims.get(k) for k in ('manifestSha256', 'manifestBytes', 'totalBytes', 'entries'))):
                raise GrantError()
        except (FileNotFoundError, KeyError, TypeError):
            raise GrantError() from None
        return claims['userId']

    def process(self, token, upload, action, args, data=b''):
        self.n.platform_root_check()
        claims = self.claims(token)
        if claims['uploadId'] != upload:
            raise GrantError()
        self.authorize(token, claims, upload, action)
        with self.u.direct_guard(claims['userId'], upload):
            user = self.authorize(token, claims, upload, action)
            # This checks mount identity on every request even in a long-lived
            # listener. A missing /data2 mount must never fall back to root disk.
            self.n.dataset_mount_check(self.n.CONFIG['datasets'])
            if action == 'status':
                if set(args)-{'path'} or data:
                    raise ValueError('Invalid status fields')
                return self.u.status(user, {'uploadId': upload, **args})
            if action not in ('manifest', 'chunk') or set(args) != ({'offset'} if action == 'manifest' else {'offset', 'path'}):
                raise ValueError('Invalid direct upload fields')
            return getattr(self.u, action+'_bytes')(user, {'uploadId': upload, **args}, args['offset'], data, transport='campus-direct')


def create_server(node, uploads):
    direct = DirectUploads(node, uploads)
    config = direct.configuration()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(config['certificate'], config['privateKey'])
    slots = threading.BoundedSemaphore(8)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def handle_one_request(self):
            # Socket inactivity timeouts alone do not bound a trickling sender.
            # Cap headers plus one bounded chunk, including unauthenticated I/O.
            def expire():
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            deadline = threading.Timer(20, expire)
            deadline.daemon = True
            deadline.start()
            try:
                super().handle_one_request()
            finally:
                deadline.cancel()

        def log_message(self, *args):
            pass  # No bearer tickets, user paths, or request headers in logs.

        def send_json(self, code, value):
            body = json.dumps(value, separators=(',', ':')).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            if self.close_connection:
                self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.handle_upload()

        def do_POST(self):
            self.handle_upload()

        def handle_upload(self):
            try:
                node.platform_root_check()
                lengths = self.headers.get_all('Content-Length', [])
                if (self.headers.get('Transfer-Encoding') or len(lengths) > 1
                        or lengths and not re.fullmatch(r'0|[1-9][0-9]{0,7}', lengths[0])):
                    raise ValueError('Invalid framing')
                length = int(lengths[0]) if lengths else 0
                if self.command == 'GET' and length or length > uploads.d.CHUNK_BYTES:
                    raise ValueError('Invalid request length')
                if self.path == '/capabilities' and self.command == 'GET':
                    current = direct.configuration()
                    node.dataset_mount_check(node.CONFIG['datasets'])
                    if current['revision'] != config['revision']:
                        raise ValueError('Restart listener after configuration change')
                    self.send_json(200, {'protocol': PROTOCOL, 'listenerReady': True, 'revision': config['revision']})
                    return
                parsed = urlsplit(self.path)
                route = re.fullmatch(r'/v1/uploads/([a-f0-9-]{36})/(manifest|chunk|status)', parsed.path)
                if (not route or not UUID.fullmatch(route[1]) or parsed.fragment or parsed.scheme or parsed.netloc
                        or self.command != ('GET' if route[2] == 'status' else 'POST')):
                    raise ValueError('Invalid upload operation')
                # Python 3.10 treats an empty strict query as a malformed field.
                # Status has no required query; nonempty input remains strict.
                query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True, max_num_fields=2) if parsed.query else {}
                if any(len(value) != 1 for value in query.values()):
                    raise ValueError('Duplicate upload arguments')
                args = {key: value[0] for key, value in query.items()}
                if 'offset' in args:
                    if not re.fullmatch(r'0|[1-9][0-9]{0,18}', args['offset']):
                        raise ValueError('Invalid offset')
                    args['offset'] = int(args['offset'])
                if len(self.headers.get_all('Authorization', [])) != 1:
                    raise GrantError()
                authorization = self.headers['Authorization']
                if not authorization.startswith('Bearer '):
                    raise GrantError()
                token = authorization[7:]
                # Reject unauthenticated requests before receiving file bytes.
                claims = direct.claims(token)
                direct.authorize(token, claims, route[1], route[2])
                if self.command == 'POST' and (not lengths or self.headers.get('Content-Type') != 'application/octet-stream'):
                    raise ValueError('Raw upload requires an explicit bounded octet-stream body')
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError('Incomplete upload body')
                result = direct.process(token, route[1], route[2], args, data)
                self.send_json(200, {'ok': True, 'result': result})
            except GrantError as error:
                self.close_connection = True
                self.send_json(401 if error.code == 'grant-expired' else 403, {'ok': False, 'code': error.code, 'error': 'Direct upload authorization expired or was revoked; renew through the portal'})
            except Exception:
                self.close_connection = True
                self.send_json(409, {'ok': False, 'code': 'upload-rejected', 'error': 'Upload state, path, offset, storage or listener configuration changed; check portal status and resume'})

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

        def handle_error(self, request, address):
            # Disconnected clients and deliberately rejected TLS pins are
            # expected. Do not print request context or a private-path traceback.
            pass

        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(15)
            return connection, address

        def process_request(self, request, address):
            if not slots.acquire(blocking=False):
                self.shutdown_request(request)
                return
            super().process_request(request, address)

        def process_request_thread(self, request, address):
            wrapped = request
            try:
                wrapped = context.wrap_socket(request, server_side=True)
                super().process_request_thread(wrapped, address)
            except (OSError, ssl.SSLError):
                self.shutdown_request(wrapped)
            finally:
                slots.release()

    return Server((config['bind'], config['port']), Handler)


def serve(node, uploads):
    with create_server(node, uploads) as server:
        server.serve_forever()
