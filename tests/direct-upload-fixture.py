#!/usr/bin/env python3
"""Private temporary loopback fixture for the real Node/Python upload protocol.

Standard input represents the already authenticated portal control bridge.
Only listener binding is substituted: no real LAN config, services, or GPUs.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cache_module = load('integration_cache', 'dataset-cache.py')
upload_module = load('integration_upload', 'dataset-upload.py')
direct_module = load('integration_direct', 'direct-upload.py')
temporary = tempfile.TemporaryDirectory(prefix='gpuq-upload-integration-')
root = Path(temporary.name).resolve()
cert, key = root/'certificate.pem', root/'key.pem'
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key),
                '-out', str(cert), '-days', '1', '-subj', '/CN=localhost'], check=True,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
key.chmod(0o600)
pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()


def workspace(user):
    if not isinstance(user, str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)', user):
        raise ValueError('Invalid test identity')
    path = root/'workspaces'/user
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


cache = cache_module.DatasetCache(root/'cache', reserve_bytes=0)
node = SimpleNamespace(CONFIG={'machine': 'gpu-4', 'datasets': {}, 'directUpload': {'enabled': True}},
                       HERE=DEPLOY, ENV={}, dataset_cache=lambda: (cache_module, cache),
                       workspace=workspace, run=lambda *_a, **_kw: None,
                       platform_root_check=lambda: None,
                       dataset_mount_check=lambda _config: None)
uploads = upload_module.DatasetUploads(node)
uploads.active = lambda *_args: True
# Keep real issuance/probe/authorization/storage. The fixture alone substitutes
# a random loopback bind because production configuration forbids loopback.
config = {'enabled': True, 'bind': '127.0.0.1', 'port': 0, 'endpoint': '',
          'certificate': str(cert), 'privateKey': str(key), 'machine': 'gpu-4',
          'certificateSha256': pin, 'revision': 'c'*64}
direct_module.DirectUploads.configuration = lambda _self: dict(config)
direct = direct_module.DirectUploads(node, uploads)
uploads.direct = lambda: direct
server = direct_module.create_server(node, uploads)
config.update(port=server.server_address[1], endpoint=f'https://127.0.0.1:{server.server_address[1]}')
fault = {'dropNextChunkReceipt': False}
original_send = server.RequestHandlerClass.send_json


def send_json(handler, code, value):
    if code == 200 and '/chunk?' in handler.path and fault['dropNextChunkReceipt']:
        fault['dropNextChunkReceipt'] = False
        handler.close_connection = True
        handler.connection.shutdown(socket.SHUT_RDWR)
        return
    original_send(handler, code, value)


server.RequestHandlerClass.send_json = send_json
serving = threading.Thread(target=server.serve_forever, daemon=True)
serving.start()
print(json.dumps({'ready': True, 'endpoint': config['endpoint'], 'certificateSha256': pin}), flush=True)
try:
    for line in sys.stdin:
        request = json.loads(line)
        if request.get('action') == 'shutdown':
            break
        try:
            action = request['action']
            if action == 'fault':
                fault['dropNextChunkReceipt'] = True
                result = {'armed': True}
            elif action == 'root-unavailable':
                # Model the production guard failure, not a listener restart.
                # Existing capabilities must not bypass per-request admission.
                def unavailable():
                    raise ValueError('Platform root unavailable')
                node.platform_root_check = unavailable
                result = {'blocked': True}
            else:
                args = {**request.get('args', {}), 'userId': 'demo-user-1', 'hostAdmin': False}
                args.pop('machine', None)
                result = uploads.process('datasets.upload.'+action, args)
                if action in ('seal', 'commit', 'discard'):
                    uploads.worker('demo-user-1', args['uploadId'], action)
                    result = uploads.process('datasets.upload.status', {'userId': 'demo-user-1', 'hostAdmin': False, 'uploadId': args['uploadId']})
            print(json.dumps({'id': request['id'], 'ok': True, 'result': result}), flush=True)
        except Exception as error:
            print(json.dumps({'id': request['id'], 'ok': False, 'error': str(error)}), flush=True)
finally:
    server.shutdown()
    server.server_close()
    serving.join(3)
    # Published fixtures intentionally become read-only. Only this process's
    # private test root is made writable for deterministic cleanup.
    for folder, _directories, files in os.walk(root, followlinks=False):
        os.chmod(folder, 0o700)
        for name in files:
            path = Path(folder)/name
            if not path.is_symlink():
                os.chmod(path, 0o600)
    temporary.cleanup()
