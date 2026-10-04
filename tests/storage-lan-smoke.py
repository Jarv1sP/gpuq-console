#!/usr/bin/env python3
"""Explicit 3090 HDD -> 5090 NVMe authority acceptance; NEVER run by discovery.

Run only after the peer and exact machine/authority configs are approved/live.
Two trusted administrator phases, joined by a privately transported grant file:
  source-seal --runtime DIR --run-id UUID --grant-file PRIVATE_FILE
  target-check --runtime DIR --run-id UUID --grant-file PRIVATE_FILE --authority hdd

Only the deterministic, UUID-named 2 MiB builtin-admin fixture is created/read/
evicted. The HDD original and permanent authority pin are intentionally retained.
Target READY data is evicted finally; its registration/recovery receipt/grant
remain as a repeatable recovery baseline. No GC enable, SSH, unit changes, old
dataset scan, source unpin, configuration writes, or secret-bearing stdout.
"""
import argparse
import hashlib
import importlib.util
import ipaddress
import json
from pathlib import Path
import ssl
import subprocess
import sys
import uuid

SOURCE = 'amax-3090'
TARGET = 'amax-5090'
OWNER = 'builtin-admin'
SIZE = 2 * 1024**2


def sample(run_id):
    key = str(uuid.UUID(run_id))
    if key != run_id:
        raise ValueError('Use a canonical lowercase acceptance UUID')
    block = ('GPUQ storage authority acceptance ' + key + '\n').encode()
    payload = (block * (SIZE // len(block) + 1))[:SIZE]
    name = 'gpuq-storage-accept-' + uuid.UUID(key).hex
    manifest = dict(schema=1, directories=['empty', '验证'], files=[
        dict(path='empty.bin', size=0, sha256=hashlib.sha256(b'').hexdigest()),
        dict(path='验证/data.bin', size=SIZE, sha256=hashlib.sha256(payload).hexdigest())])
    return name, manifest, {'empty.bin': b'', '验证/data.bin': payload}


def load_node(runtime):
    runtime = Path(runtime).resolve(strict=True)
    spec = importlib.util.spec_from_file_location('gpuq_storage_acceptance_node', runtime / 'node-executor.py')
    node = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = node
    spec.loader.exec_module(node)
    return node


def identity(node, expected):
    if node.CONFIG.get('machine') != expected:
        raise ValueError('Wrong exact machine identity for this acceptance phase')
    if node.CONFIG.get('storageTier', {}).get('enabled', False) is not False:
        raise ValueError('Acceptance requires global storage GC to remain disabled')
    module, cache = node.dataset_cache()  # Real required-mount/root guards.
    return module, cache, module.Principal(OWNER, True)


def receipt(node, run_id, name, manifest, version):
    return dict(schema=1, runId=run_id, machine=node.CONFIG['machine'], dataset=name,
                version=version, sourceMachine=SOURCE, targetMachine=TARGET, sourceBytes=SIZE,
                owners=[OWNER], files=[dict(path=f['path'], bytes=f['size'], sha256=f['sha256'])
                                     for f in manifest['files']], gcEnabled=False,
                runnerSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                runtimeSha256={name: hashlib.sha256((node.HERE / name).read_bytes()).hexdigest()
                               for name in ('platform-root-guard.py','node-executor.py', 'transfer-peer.py', 'storage-authority.py',
                                            'dataset-tier.py', 'dataset-cache.py')})


def ensure_private_grant(authority, path, grant):
    path = Path(path)
    authority._private_root(path.parent)
    try:
        current = authority._load(path)
    except FileNotFoundError:
        current = None
    if current is not None and current != grant:
        raise ValueError('Refusing to replace a different private acceptance grant')
    if current is None:
        authority.D._write_json(path, grant)


def source_seal(node, run_id, grant_file):
    module, cache, admin = identity(node, SOURCE)
    store = node.storage_authority()
    if store is None:
        raise ValueError('Protected HDD authority must be explicitly enabled first')
    authority = node.storage_authority_module()
    peer = node.CONFIG['transferPeer']
    pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(Path(peer['certificate']).read_text())).hexdigest()
    connection = authority.J.PeerClient(dict(address=peer['bind'], port=peer['port'], certificateSha256=pin), {})
    if not connection.ready():
        raise ValueError('Source TLS peer must be live before creating the acceptance fixture')
    name, manifest, content = sample(run_id)
    version = cache.register_manifest(admin, name, manifest, [OWNER])['version']
    plan = cache.prepare_transfer(admin, name, version)
    if plan['state'] != 'READY':
        for file in plan['files']:
            data = content[file['path']]
            offset = file['offset']
            if not data:
                cache.put_chunk(admin, name, version, file['path'], 0, b'', plan['token'])
            while offset < len(data):
                chunk = data[offset:offset + module.CHUNK_BYTES]
                cache.put_chunk(admin, name, version, file['path'], offset, chunk, plan['token'])
                offset += len(chunk)
        cache.publish(admin, name, version, plan['token'])
    if not cache.verify(admin, name, version)['verified']:
        raise ValueError('Acceptance source failed full verification')
    grant = store.seal(admin, name, version, run_id, TARGET)
    ensure_private_grant(authority, grant_file, grant)
    client = authority.AuthorityClient(dict(address=peer['bind'], port=peer['port'], certificateSha256=pin), grant)
    try:
        if client.call('guard') != grant['receipt']:
            raise ValueError('Running source daemon does not confirm this fixed source')
    finally:
        client.close()
    result = receipt(node, run_id, name, manifest, version)
    result.update(phase='source-seal', state='SEALED', sourceRetained=True,
                  permanentPin=grant['receipt']['pinId'], grantReceiptSha256=authority._sha(grant['receipt']))
    return result


def check_physical_lan(address):
    ip = ipaddress.ip_address(address)
    if ip not in ipaddress.ip_network('192.168.77.0/24'):
        raise ValueError('Acceptance requires the configured physical 15-122 LAN peer, never Tail/VPS')
    route = json.loads(subprocess.run(['ip', '-j', 'route', 'get', address], check=True,
                                     capture_output=True, text=True, timeout=5).stdout)
    if (len(route) != 1 or route[0].get('gateway') or route[0].get('dev', '').startswith(('lo', 'tailscale', 'tun', 'wg'))
            or not route[0].get('dev') or not route[0].get('prefsrc')):
        raise ValueError('Peer route is not a direct physical LAN path')
    device = route[0]['dev']
    if not (Path('/sys/class/net') / device / 'device').exists():
        raise ValueError('Peer route is not backed by a physical interface')
    return dict(address=address, interface=device, sourceAddress=route[0]['prefsrc'], direct=True)


def target_check(node, run_id, grant_file, authority_id, *, _route=check_physical_lan):
    module, cache, admin = identity(node, TARGET)
    configured = node.CONFIG.get('storageAuthorities', {}).get(authority_id)
    if configured != {'machine': SOURCE}:
        raise ValueError('Select the configured fixed 3090 protected authority')
    storage = node.storage_node()
    remote = storage.tier.authorities[authority_id]
    route = _route(remote.peer['address'])
    authority = node.storage_authority_module()
    grant = authority._load(Path(grant_file))
    name, manifest, _ = sample(run_id)
    version = hashlib.sha256(module._json_bytes(module._manifest(manifest))).hexdigest()
    if (grant.get('id') != run_id or grant.get('dataset') != name or grant.get('version') != version
            or grant.get('sourceMachine') != SOURCE or grant.get('targetMachine') != TARGET
            or grant.get('receipt', {}).get('owners') != [OWNER] or grant['receipt'].get('totalBytes') != SIZE):
        raise ValueError('Grant is not the exact approved 2 MiB administrator fixture')
    remote.install_grant(grant)
    cache.register_manifest(admin, name, manifest, [OWNER])
    proof = remote.seal(admin, name, version, 'authority-acceptance')
    remote.recover(admin, proof, cache, name, validate_target=lambda: None)
    if not cache.verify(admin, name, version)['verified']:
        raise ValueError('First target copy failed full hash verification')
    storage.tier.verify_authority(admin, name, version, authority_id)
    denials = []
    for kind, bad_peer, bad_grant in (
        ('certificate', {**remote.peer, 'certificateSha256': '0' * 64}, grant),
        ('token', remote.peer, {**grant, 'token': 'x' * 43}),
        ('reference', remote.peer, {**grant, 'version': '0' * 64})):
        client = authority.AuthorityClient(bad_peer, bad_grant)
        try:
            try:
                client.call('guard')
            except (ValueError, OSError):
                denials.append(kind)
            else:
                raise AssertionError('Invalid authority unexpectedly accepted')
        finally:
            client.close()
    lease = cache.acquire_lease(admin, name, version, 'acceptance:' + run_id)
    try:
        try:
            cache.evict(admin, name, version)
        except module.CacheError:
            pass
        else:
            raise AssertionError('Active fixture lease did not prevent eviction')
    finally:
        cache.release_lease(admin, name, version, lease['leaseId'])
    cache.evict(admin, name, version)
    if cache.status(admin, name, version)['state'] == 'READY':
        raise ValueError('Named fixture was not evicted')
    storage.tier.recover(admin, name, version)
    if not cache.verify(admin, name, version)['verified']:
        raise ValueError('Rehydrated target failed full hash verification')
    for file in manifest['files']:
        path = cache._paths(name, version)['ready'] / 'data' / file['path']
        if path.stat().st_mode & 0o222:
            raise ValueError('Rehydrated target is not read-only')
    cache.evict(admin, name, version)  # Only this exact UUID fixture payload.
    paths = cache._paths(name, version)
    cleaned = not paths['ready'].exists() and not paths['.staging'].exists()
    if not cleaned:
        raise ValueError('Fixture target payload cleanup is incomplete')
    result = receipt(node, run_id, name, manifest, version)
    result.update(phase='target-check', state='PASS', route=route, denied=denials,
                  leasePreventedEviction=True, recoveredAndVerified=True, targetPayloadRemoved=cleaned,
                  targetRecoveryMetadataRetained=True, sourceRetained=True,
                  grantReceiptSha256=authority._sha(grant['receipt']))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['source-seal', 'target-check'])
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--grant-file', required=True)
    parser.add_argument('--authority', default='hdd')
    args = parser.parse_args()
    try:
        node = load_node(args.runtime)
        if args.phase == 'source-seal':
            result = source_seal(node, args.run_id, args.grant_file)
        else:
            result = target_check(node, args.run_id, args.grant_file, args.authority)
    except Exception as error:
        # A failed operation may have retained its fixture/partial safely.
        # Never report successful cleanup or echo a secret-bearing exception.
        print(json.dumps(dict(schema=1, phase=args.phase, state='FAILED',
                              errorType=type(error).__name__, cleanupConfirmed=False,
                              retainedStateRequiresInspection=True,
                              runnerSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
