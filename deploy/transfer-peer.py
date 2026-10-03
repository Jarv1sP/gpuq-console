"""Opt-in, LAN-bound read-only snapshot endpoint; no management SSH keys."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import ssl
import threading


def create_server(node, jobs, *, authority=None):
    config = node.CONFIG.get('transferPeer')
    if not isinstance(config, dict) or set(config) != {'bind', 'port', 'certificate', 'privateKey'}:
        raise ValueError('Configure transferPeer explicitly before enabling this service')
    address = ipaddress.IPv4Address(config['bind'])
    if not address.is_private or address.is_unspecified or address.is_multicast:
        raise ValueError('Bind only an explicit LAN IPv4 address, never 0.0.0.0')
    if type(config['port']) is not int or not 1024 <= config['port'] <= 65535:
        raise ValueError('Invalid LAN listener port')
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(config['certificate'], config['privateKey'])
    slots = threading.BoundedSemaphore(8)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass  # Never log snapshot tickets or dataset paths.

        def do_GET(self):
            # No identity, inventory, paths, certificates or tickets here.
            # The target authenticates this response with its configured pin.
            self.close_connection = True
            try:
                if self.path != '/capabilities' or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Length', '0') != '0':
                    raise ValueError('Invalid capability probe')
                node.dataset_mount_check(node.CONFIG['datasets'])
                payload, code = {'protocol': 'lan-transfer-v1', 'sourceReady': True}, 200
            except Exception:
                payload, code = {'protocol': 'lan-transfer-v1', 'sourceReady': False}, 503
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            self.close_connection = True
            try:
                if self.path not in ('/snapshot','/authority') or self.headers.get('Transfer-Encoding'):
                    raise ValueError('Read-only snapshot endpoint')
                length = int(self.headers.get('Content-Length', '-1'))
                if not 1 <= length <= 8192 or not self.headers.get('Content-Type', '').startswith('application/json'):
                    raise ValueError('Invalid snapshot request')
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete request')
                auth = self.headers.get('Authorization', '')
                if not auth.startswith('Bearer '):
                    raise ValueError('Snapshot ticket required')
                if self.path == '/authority':
                    if authority is None:raise ValueError('Protected authority is not enabled')
                    result=authority.read(json.loads(raw),auth[7:])
                else:result = jobs.read(json.loads(raw), auth[7:])
                payload, code = {'ok': True, 'result': result}, 200
            except Exception:
                payload, code = {'ok': False, 'error': 'Snapshot grant or immutable source is unavailable'}, 403
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(30)
            # Handshake in the bounded worker, not the listener thread.
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


def serve(node, jobs, *, authority=None):
    with create_server(node, jobs, authority=authority) as server:
        server.serve_forever()
