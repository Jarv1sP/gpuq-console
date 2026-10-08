"""Opt-in pinned-TLS data plane for an already admitted personal upload.

The portal issues/revokes a five-minute capability through its authenticated
node bridge. This listener accepts only bounded raw manifest/file chunks and
status; it cannot create uploads, select owners, publish, or run commands.
"""
import base64
from collections import Counter, OrderedDict
from contextlib import nullcontext
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
MAX_FILE_CHUNK_BYTES = 16*1024*1024
RELAY_LIMIT_BYTES = 256*1024**2
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
MAX_HEADER_BYTES = 32*1024
MAX_HEADER_FIELDS = 64
HEADER_TIMEOUT = 5
HANDSHAKE_TIMEOUT = 5
STALE_ANONYMOUS_SECONDS = 2
ROUTE_ID = re.compile(r'[a-z][a-z0-9-]{0,31}\Z')


class HeaderBudget:
    """Limit only HTTP headers, never the already bounded raw upload body."""
    def __init__(self, stream):
        self.stream, self.remaining, self.fields = stream, MAX_HEADER_BYTES, 0

    def readline(self, size=-1):
        limit = self.remaining+1
        line = self.stream.readline(min(size, limit) if size >= 0 else limit)
        self.remaining -= len(line)
        self.fields += line not in (b'\r\n', b'\n', b'')
        if self.remaining < 0 or self.fields > MAX_HEADER_FIELDS:
            raise http.client.LineTooLong('request headers')
        return line


class ConnectionAdmission:
    """Eight data connections, without a per-IP cap on authenticated NAT users.

    At saturation a newcomer can replace a stale *unauthenticated* connection
    from its own source, or a source with more occupied slots. Closing occurs
    outside the lock; the old worker must release its slot before replacement.
    New handshakes and anonymous probes have generous bounded token buckets;
    authenticated chunks/status never consume an anonymous request budget.
    """
    def __init__(self):
        self.condition = threading.Condition()
        self.active = {}
        self.peers = OrderedDict()
        self.global_tokens = {}

    @staticmethod
    def _spend(buckets, name, now, rate, burst):
        tokens, previous = buckets.get(name, (burst, now))
        tokens = min(burst, tokens+max(0, now-previous)*rate)
        allowed = tokens >= 1
        buckets[name] = (tokens-1 if allowed else tokens, now)
        return allowed

    def _budget(self, peer, name, now):
        if peer not in self.peers:
            if len(self.peers) >= 1024:
                self.peers.popitem(last=False)
            self.peers[peer] = {}
        self.peers.move_to_end(peer)
        # Browser preflight caches may be keyed by the full URL (each chunk's
        # offset changes it). Do not apply the small probe budget to OPTIONS:
        # a gigabit upload with 1 MiB blocks needs over 100 preflights/second.
        rate, burst = {'connect': (32, 64), 'probe': (64, 128),
                       'preflight': (1024, 2048)}[name]
        return (self._spend(self.peers[peer], name, now, rate, burst)
                and self._spend(self.global_tokens, name, now, rate*2, burst*2))

    def anonymous_request(self, peer, kind='probe'):
        with self.condition:
            return self._budget(peer, kind, time.monotonic())

    def acquire(self, request, peer):
        victim = None
        with self.condition:
            now = time.monotonic()
            if not self._budget(peer, 'connect', now):
                return False
            if len(self.active) >= 8:
                counts = Counter(row['peer'] for row in self.active.values())
                eligible = [row for row in self.active.values()
                            if not row['authenticated'] and now-row['waiting'] >= STALE_ANONYMOUS_SECONDS
                            and (row['peer'] == peer or counts[row['peer']] > counts[peer])]
                if eligible:
                    retiring = min(eligible, key=lambda row: (-counts[row['peer']], row['waiting']))
                    # Fence authentication before dropping the lock: a worker
                    # racing this choice must not begin receiving a file body.
                    retiring['retiring'] = True
                    victim = retiring['socket']
                else:
                    return False
        if victim is not None:
            try:
                victim.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        with self.condition:
            # Never start a ninth TLS/HTTP worker while a retired one exits.
            if not self.condition.wait_for(lambda: len(self.active) < 8, timeout=0.25):
                return False
            self.active[request] = {'socket': request, 'peer': peer,
                                    'authenticated': False, 'retiring': False,
                                    'waiting': time.monotonic()}
            return True

    def replace_socket(self, request, wrapped):
        with self.condition:
            if self.active[request]['retiring']:
                wrapped.close()
                raise OSError('Anonymous connection retired')
            self.active[request]['socket'] = wrapped

    def phase(self, connection, authenticated):
        with self.condition:
            for row in self.active.values():
                if row['socket'] is connection:
                    if row['retiring']:
                        return False
                    # Anonymous keep-alive probes must not refresh their age
                    # forever and monopolize all eight slots without a ticket.
                    if authenticated or row['authenticated']:
                        row['waiting'] = time.monotonic()
                    row['authenticated'] = authenticated
                    return True
            return False

    def release(self, request):
        with self.condition:
            self.active.pop(request, None)
            self.condition.notify_all()


class GrantError(PermissionError):
    def __init__(self, code='grant-invalid'):
        self.code = code
        super().__init__(code)


def encoded(value):
    return base64.urlsafe_b64encode(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).decode().rstrip('=')


def browser_origin(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 512
            or re.search(r'[\s\\\x00-\x1f*]', value)):
        raise ValueError('Browser upload origins must be exact HTTPS origins')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ('', '/')
            or parsed.port is not None and not 1 <= parsed.port <= 65535):
        raise ValueError('Browser upload origins must be exact HTTPS origins')
    hostname = parsed.hostname.encode('idna').decode('ascii').lower()
    host = '['+hostname+']' if ':' in hostname else hostname
    return 'https://'+host+((':'+str(parsed.port)) if parsed.port not in (None, 443) else '')


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
        expected=getattr(self.n,'direct_startup_config',lambda:self.n.CONFIG)()
        if whole.get('datasets') != expected.get('datasets'):
            raise ValueError('Dataset storage configuration changed; restart listener after validation')
        if whole.get('storageWarehouse') != expected.get('storageWarehouse'):
            raise ValueError('Warehouse storage configuration changed; restart listener after validation')
        config = whole.get('directUpload')
        required = {'enabled', 'bind', 'port', 'endpoint', 'certificate', 'privateKey'}
        if (not isinstance(config, dict) or config.get('enabled') is not True
                or not required <= set(config) or set(config)-required-{'allowedOrigins', 'alternates'}):
            raise ValueError('Direct upload is not explicitly enabled')
        origins = config.get('allowedOrigins', [])
        if not isinstance(origins, list) or len(origins) > 8:
            raise ValueError('Invalid browser upload origin allowlist')
        allowed = [browser_origin(value) for value in origins]
        if len(set(allowed)) != len(allowed):
            raise ValueError('Duplicate browser upload origin')
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
        alternates = config.get('alternates', [])
        if not isinstance(alternates, list) or len(alternates) > 3:
            raise ValueError('At most three fixed alternate upload routes are allowed')
        ids, endpoints, normalized = {'primary'}, {origin}, []
        for route in alternates:
            if (not isinstance(route, dict) or set(route) != {'id', 'endpoint', 'kind'}
                    or not isinstance(route['id'], str) or not ROUTE_ID.fullmatch(route['id'])
                    or route['id'] in ids or route['kind'] not in ('campus-direct', 'tail-upload')):
                raise ValueError('Invalid fixed upload route')
            endpoint_origin = browser_origin(route['endpoint'])
            if endpoint_origin in endpoints:
                raise ValueError('Duplicate fixed upload endpoint')
            ids.add(route['id']); endpoints.add(endpoint_origin)
            normalized.append(dict(route, endpoint=endpoint_origin))
        # Do not change the revision of existing single-endpoint configs.
        if 'alternates' in config:
            public['alternates'] = normalized
        if 'allowedOrigins' in config:
            public['allowedOrigins'] = allowed
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
                    or json.loads(body) != {'protocol': PROTOCOL, 'listenerReady': True,
                                           'revision': config['revision'], 'machine': config['machine']}):
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
        return {'available': True, 'reason': 'ready', 'protocol': PROTOCOL,
                'machine': config['machine'], 'revision': config['revision'],
                'certificateSha256': config['certificateSha256'], 'routes': self.routes(config)}

    @staticmethod
    def routes(config):
        return [{'id': 'primary', 'kind': 'campus-direct', 'endpoint': config['endpoint']},
                *config.get('alternates', [])]

    def issue(self, user, upload, route_id='primary'):
        self.u.require_public_ingress()
        config = self.configuration()
        route = next((row for row in self.routes(config) if row['id'] == route_id), None)
        if route is None:
            raise ValueError('Upload route is not approved by this node')
        self.probe(config)
        with self.u.direct_guard(user, upload):
            session = self.u.load(user, upload)
            if session.get('archive') and route['kind'] != 'campus-direct':
                raise ValueError('Archive upload requires the campus offset transport')
            if session['state'] in ('DISCARDED', 'DISCARDING', 'READY') or session.get('directPaused') is True:
                raise ValueError('Upload does not accept a direct grant')
            claims = {'schema': 1, 'machine': config['machine'], 'userId': user,
                      'uploadId': upload, 'expiresAt': int(time.time())+TTL_SECONDS,
                      'operations': OPERATIONS, 'revision': config['revision'],
                      'routeId': route['id'],
                      'maxChunkBytes': MAX_FILE_CHUNK_BYTES,
                      **{k: session[k] for k in ('manifestSha256', 'manifestBytes', 'totalBytes', 'entries')}}
            token = encoded(claims)+'.'+secrets.token_urlsafe(32)
            self.u.d._write_json(self.u.folder(user, upload)/'direct-grant.json', {
                'claims': claims, 'sha256': hashlib.sha256(token.encode()).hexdigest()})
            return {'available': True, 'protocol': PROTOCOL, 'endpoint': route['endpoint'],
                    'routeId': route['id'], 'kind': route['kind'], 'machine': config['machine'],
                    'revision': config['revision'],
                    'certificateSha256': config['certificateSha256'], 'ticket': token,
                    'expiresAt': claims['expiresAt'], 'chunkBytes': self.u.d.CHUNK_BYTES,
                    'maxChunkBytes': claims['maxChunkBytes']}

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
        if not any(row['id'] == claims.get('routeId', 'primary') for row in self.routes(config)):
            raise GrantError()
        if type(claims.get('expiresAt')) is not int or claims['expiresAt'] <= int(time.time()):
            raise GrantError('grant-expired')
        if claims['expiresAt'] > int(time.time())+TTL_SECONDS+1 or claims.get('operations') != OPERATIONS or action not in OPERATIONS:
            raise GrantError()
        limit = claims.get('maxChunkBytes', self.u.d.CHUNK_BYTES)
        if type(limit) is not int or limit not in (self.u.d.CHUNK_BYTES, MAX_FILE_CHUNK_BYTES):
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
        # Eight authenticated 16 MiB writers can briefly serialize at the
        # durable cache/accounting fence. The ordinary two-second control-plane
        # lock budget must not reject a healthy writer merely because fsync is
        # busy. Wait only for acquisition, never replay a chunk, and stay below
        # the HTTP request deadline. Status and unauthenticated callers retain
        # the short default; nested locks share this finite per-thread budget.
        waiting = (self.u.d.wait_for_locks(timeout=8.0, total=8.0)
                   if action in ('manifest', 'chunk') else nullcontext())
        with waiting, self.u.direct_guard(claims['userId'], upload):
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
            extra = {'direct_chunk_limit': claims.get('maxChunkBytes', self.u.d.CHUNK_BYTES),
                     'direct_authorize': lambda: self.authorize(token, claims, upload, action)} if action == 'chunk' else {}
            route = next(row for row in self.routes(self.configuration()) if row['id'] == claims.get('routeId', 'primary'))
            return getattr(self.u, action+'_bytes')(user, {'uploadId': upload, **args}, args['offset'], data, transport=route['kind'], **extra)


def create_server(node, uploads):
    direct = DirectUploads(node, uploads)
    config = direct.configuration()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(config['certificate'], config['privateKey'])
    admission = ConnectionAdmission()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def handle_one_request(self):
            # Socket inactivity timeouts alone do not bound a trickling sender.
            # Cap headers plus one bounded chunk, including unauthenticated I/O.
            if not admission.phase(self.connection, False):
                self.close_connection = True
                return
            started = time.monotonic()
            finished = threading.Event()
            self.header_complete = False
            def expire():
                if finished.wait(HEADER_TIMEOUT):
                    return
                if self.header_complete and finished.wait(max(0, 20-(time.monotonic()-started))):
                    return
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            # One watcher per worker, not two concurrent timers: the deployed
            # service's TasksMax=24 still accommodates eight data connections.
            deadline = threading.Thread(target=expire, daemon=True)
            deadline.start()
            try:
                super().handle_one_request()
            finally:
                finished.set()
                deadline.join(0.1)

        def parse_request(self):
            original = self.rfile
            self.rfile = HeaderBudget(original)
            try:
                return super().parse_request()
            finally:
                self.rfile = original
                self.header_complete = True

        def handle_expect_100(self):
            # Do not invite a body before capability authentication. Existing
            # browser/CLI clients do not use Expect: 100-continue.
            self.send_error(417, 'Expect is not supported')
            return False

        def admit_anonymous(self, kind='probe'):
            if admission.anonymous_request(self.client_address[0], kind):
                return True
            self.close_connection = True
            self.send_json(429, {'ok': False, 'code': 'listener-busy', 'error': 'Upload listener is busy; retry later'})
            return False

        def log_message(self, *args):
            pass  # No bearer tickets, user paths, or request headers in logs.

        def send_json(self, code, value):
            body = json.dumps(value, separators=(',', ':')).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.cors_headers()
            if self.close_connection:
                self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.handle_upload()

        def do_POST(self):
            self.handle_upload()

        def cors_headers(self):
            self.send_header('Vary', 'Origin')
            if getattr(self, 'cors_origin', None):
                self.send_header('Access-Control-Allow-Origin', self.cors_origin)

        def check_origin(self):
            self.cors_origin = None
            origins = self.headers.get_all('Origin', [])
            if len(origins) > 1:
                raise GrantError('origin-rejected')
            if not origins:
                return  # Existing pinned CLI clients do not send Origin.
            current = direct.configuration()
            if current['revision'] != config['revision']:
                raise ValueError('Restart listener after configuration change')
            if origins[0] not in current.get('allowedOrigins', []):
                raise GrantError('origin-rejected')
            self.cors_origin = origins[0]

        def do_OPTIONS(self):
            try:
                if not self.admit_anonymous('preflight'):
                    return
                node.platform_root_check()
                self.check_origin()
                if not self.cors_origin:
                    raise GrantError('origin-rejected')
                methods = self.headers.get_all('Access-Control-Request-Method', [])
                headers = self.headers.get_all('Access-Control-Request-Headers', [])
                networks = self.headers.get_all('Access-Control-Request-Private-Network', [])
                lengths = self.headers.get_all('Content-Length', [])
                if (len(methods) != 1 or len(headers) > 1 or len(networks) > 1
                        or networks and networks != ['true']
                        or self.headers.get('Transfer-Encoding')
                        or len(lengths) > 1 or lengths and lengths != ['0']):
                    raise ValueError('Invalid browser preflight')
                parsed = urlsplit(self.path)
                route = re.fullmatch(r'/v1/uploads/([a-f0-9-]{36})/(manifest|chunk|status)', parsed.path)
                method = 'GET' if self.path == '/capabilities' or route and route[2] == 'status' else 'POST'
                if (parsed.fragment or parsed.scheme or parsed.netloc
                        or self.path != '/capabilities' and (not route or not UUID.fullmatch(route[1]))
                        or methods[0] != method):
                    raise ValueError('Invalid browser preflight route')
                names = [value.strip().lower() for value in headers[0].split(',')] if headers else []
                if (headers and len(headers[0]) > 1024
                        or len(set(names)) != len(names)
                        or set(names)-{'authorization', 'content-type'}):
                    raise ValueError('Invalid browser preflight headers')
                node.dataset_mount_check(node.CONFIG['datasets'])
                self.send_response(204)
                self.cors_headers()
                self.send_header('Access-Control-Allow-Methods', method)
                if names:
                    self.send_header('Access-Control-Allow-Headers', ', '.join(sorted(names)))
                if networks:
                    self.send_header('Access-Control-Allow-Private-Network', 'true')
                self.send_header('Access-Control-Max-Age', '300')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', '0')
                self.end_headers()
            except GrantError:
                self.close_connection = True
                self.send_json(403, {'ok': False, 'code': 'origin-rejected', 'error': 'Browser origin is not allowed'})
            except Exception:
                self.close_connection = True
                self.send_json(409, {'ok': False, 'code': 'preflight-rejected', 'error': 'Browser preflight rejected'})

        def handle_upload(self):
            try:
                node.platform_root_check()
                self.check_origin()
                lengths = self.headers.get_all('Content-Length', [])
                if (self.headers.get('Transfer-Encoding') or len(lengths) > 1
                        or lengths and not re.fullmatch(r'0|[1-9][0-9]{0,7}', lengths[0])):
                    raise ValueError('Invalid framing')
                length = int(lengths[0]) if lengths else 0
                if self.command == 'GET' and length or length > MAX_FILE_CHUNK_BYTES:
                    raise ValueError('Invalid request length')
                if self.path == '/capabilities' and self.command == 'GET':
                    if not self.admit_anonymous():
                        return
                    current = direct.configuration()
                    node.dataset_mount_check(node.CONFIG['datasets'])
                    if current['revision'] != config['revision']:
                        raise ValueError('Restart listener after configuration change')
                    self.send_json(200, {'protocol': PROTOCOL, 'listenerReady': True,
                                         'revision': config['revision'], 'machine': config['machine']})
                    return
                parsed = urlsplit(self.path)
                route = re.fullmatch(r'/v1/uploads/([a-f0-9-]{36})/(manifest|chunk|status)', parsed.path)
                if (not route or not UUID.fullmatch(route[1]) or parsed.fragment or parsed.scheme or parsed.netloc
                        or self.command != ('GET' if route[2] == 'status' else 'POST')):
                    raise ValueError('Invalid upload operation')
                if length > (MAX_FILE_CHUNK_BYTES if route[2] == 'chunk' else uploads.d.CHUNK_BYTES):
                    raise ValueError('Invalid request length')
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
                if not admission.phase(self.connection, True):
                    raise ValueError('Anonymous connection retired before authentication')
                if length > (claims.get('maxChunkBytes', uploads.d.CHUNK_BYTES) if route[2] == 'chunk' else uploads.d.CHUNK_BYTES):
                    raise ValueError('Request exceeds authenticated chunk limit')
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
            # Chunk acknowledgements are small TLS records. Do not delay them
            # behind Nagle while the sequential sender waits for the offset.
            connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            connection.settimeout(15)
            return connection, address

        def process_request(self, request, address):
            if not admission.acquire(request, address[0]):
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, address)
            except Exception:
                admission.release(request)
                raise

        def process_request_thread(self, request, address):
            wrapped = request
            try:
                wrapped = context.wrap_socket(request, server_side=True, do_handshake_on_connect=False)
                admission.replace_socket(request, wrapped)
                wrapped.settimeout(HANDSHAKE_TIMEOUT)
                wrapped.do_handshake()
                wrapped.settimeout(15)
                super().process_request_thread(wrapped, address)
            except (OSError, ssl.SSLError):
                self.shutdown_request(wrapped)
            finally:
                admission.release(request)

    return Server((config['bind'], config['port']), Handler)


def serve(node, uploads):
    with create_server(node, uploads) as server:
        server.serve_forever()
