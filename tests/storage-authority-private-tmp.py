#!/usr/bin/env python3
"""OPT-IN Linux/systemd regression. Review before --execute; never discovered.

Example (amax, on an approved node, with reviewed source staged separately):
  python3 -B storage-authority-private-tmp.py --execute --deploy /path/to/deploy \
    --fixture-root /data/gpuq-authority-private-tmp-<32 lowercase hex>

Creates ONLY that fresh fixture, a 2 MiB source, a local TLS certificate and two
UUID-named transient services. No installed runtime/config, production cache,
GPUQ unit, host mount, network/ACL, GPU or global GC changes. The source is sealed
in the caller's real namespace. The actual node-executor peer runs as amax with
PrivateTmp=yes and reads the unchanged proof/grant over pinned loopback TLS.
A separate short root transient process constructs a cache as amax, then calls
unshare(CLONE_NEWNS) in that same process: the stale instance must reject its new
mount ID; a newly constructed instance can read the original sealed proof.
No synthetic mountinfo, mount command, setns/nsenter, or production proof used.

Success stops the fixture peer and removes the exact marked fixture tree.
Failure stops the fixture peer but RETAINS the fixture for explicit inspection.
Only sanitized checks/hashes are printed; grants/cert private keys never are.
"""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import runpy
import shutil
import socket
import ssl
import subprocess
import sys
import time
import uuid

PREFIX = 'gpuq-authority-private-tmp-'
MARKER = '.authority-private-tmp-fixture.json'
SIZE = 2 * 1024**2


def need(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def fixture_path(value, *, existing=False):
    path = Path(value)
    need(path.parent == Path('/data') and re.fullmatch(PREFIX + '[a-f0-9]{32}', path.name),
         'Fixture must be a fresh UUID-named immediate child of /data')
    need(not path.is_symlink() and path.parent.resolve(strict=True) == path.parent,
         'Fixture ancestors must be real directories')
    if existing:
        marker = json.loads((path / MARKER).read_bytes())
        need(marker == {'schema': 1, 'root': str(path), 'uid': 1000}, 'Exact fixture marker required')
        need(path.stat().st_uid == 1000 and path.stat().st_mode & 0o077 == 0,
             'Fixture must remain private and owned by amax')
    else:
        need(not path.exists(), 'Never reuse an existing fixture tree')
    return path


def load(path):
    name = 'authority_namespace_fixture_' + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def namespace():
    return os.readlink('/proc/self/ns/mnt')


def systemd_command(root, action):
    need(action in ('peer', 'live-guard'), 'Unknown fixture worker')
    key = root.name.removeprefix(PREFIX)
    unit = 'gpuq-authority-fixture-' + key + '-' + action
    command = ['sudo', '-n', '/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + unit,
               '--property=PrivateTmp=yes', '--property=PrivateDevices=yes',
               '--property=DevicePolicy=closed', '--property=NoNewPrivileges=yes',
               '--property=ProtectHome=yes', '--property=UMask=0077',
               '--property=MemoryMax=512M', '--property=CPUQuota=50%',
               '--property=RuntimeMaxSec=120', '--property=Environment=PYTHONDONTWRITEBYTECODE=1',
               '--property=User=' + ('amax' if action == 'peer' else 'root')]
    if action == 'live-guard':
        command += ['--wait', '--pipe']
    command += ['/usr/bin/python3', '-B', str(root / 'fixture.py'), '--worker', action,
                '--fixture-root', str(root)]
    return unit + '.service', command


def peer_worker(root):
    need(os.getuid() == 1000, 'Peer fixture must run as amax')
    node = load(root / 'source-runtime/node-executor.py')
    _, cache = node.dataset_cache()
    save(root / 'peer-namespace.json', {'namespace': namespace(), 'mount': list(cache.mount)})
    sys.argv = [str(root / 'source-runtime/node-executor.py'), '--transfer-peer-daemon']
    runpy.run_path(sys.argv[0], run_name='__main__')


def live_guard_worker(root):
    need(os.getuid() == 0, 'Only the isolated live-guard fixture needs root to unshare')
    # Retain saved UID 0 solely for unshare; all cache operations use service UID.
    os.setgroups([])
    os.setresgid(1000, 1000, 0)
    os.setresuid(1000, 1000, 0)
    node = load(root / 'source-runtime/node-executor.py')
    module, cache = node.dataset_cache()
    old_namespace, old_mount = namespace(), cache.mount
    with cache._locked():
        pass
    os.seteuid(0)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(0x00020000) != 0:  # CLONE_NEWNS; no mount/unmount operation.
        raise OSError(ctypes.get_errno(), 'Fixture unshare failed')
    os.seteuid(1000)
    new_mount = cache._current_mount()
    need(namespace() != old_namespace and new_mount[0] != old_mount[0]
         and new_mount[1:] == old_mount[1:], 'Real namespace clone must change only mount ID')
    try:
        with cache._locked():
            pass
    except module.CacheError as error:
        need(str(error).startswith('data mount identity changed'), 'Unexpected guard failure')
    else:
        raise AssertionError('A stale cache instance accepted its changed live mount ID')
    authority = node.storage_authority_module()
    grant = authority._load(root / 'grant.json')
    store = node.storage_authority()  # Fresh instance in the new namespace.
    result = store.read(dict(id=grant['id'], action='guard', dataset=grant['dataset'],
                             version=grant['version'], targetMachine=grant['targetMachine']), grant['token'])
    need(result == grant['receipt'], 'A reopened instance failed the unchanged persistent proof')
    print(json.dumps({'sameInstanceMountChangeDenied': True, 'freshInstanceGuardPassed': True,
                      'oldNamespace': old_namespace, 'newNamespace': namespace(),
                      'oldMount': list(old_mount), 'newMount': list(new_mount)}))


def remove_exact_fixture(root):
    fixture_path(str(root), existing=True)
    # This explicit disposable-test cleanup is NOT a production unpin operation.
    for parent, dirs, files in os.walk(root, topdown=True, followlinks=False):
        need(not Path(parent).is_symlink(), 'Unsafe fixture cleanup tree')
        os.chmod(parent, 0o700)
        for name in dirs + files:
            path = Path(parent) / name
            need(not path.is_symlink(), 'Unsafe fixture cleanup entry')
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
    shutil.rmtree(root)


def stop_fixture_units(units):
    unconfirmed = []
    for unit in reversed(units):
        need(re.fullmatch('gpuq-authority-fixture-[a-f0-9]{32}-(peer|live-guard)\\.service', unit),
             'Refusing to stop anything except an exact fixture unit')
        try:
            subprocess.run(['sudo', '-n', '/usr/bin/systemctl', 'stop', unit],
                           capture_output=True, timeout=20)
            status = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--property=ActiveState', '--value'],
                                    capture_output=True, text=True, timeout=5)
            # A --collect service may already be unloaded; show still reports
            # inactive. Never infer stopped from a timed-out --wait invocation.
            if status.returncode != 0 or status.stdout.strip() not in ('inactive', 'failed'):
                unconfirmed.append(unit)
        except (OSError, subprocess.SubprocessError):
            unconfirmed.append(unit)
    need(not unconfirmed, 'Fixture unit stop unconfirmed; retain fixture for inspection')


def execute(deploy, root):
    need(sys.platform == 'linux' and os.getuid() == 1000 and pwd.getpwuid(1000).pw_name == 'amax',
         'Opt-in fixture requires Linux service identity amax/1000')
    fixture_path(str(root))
    deploy = Path(deploy).resolve(strict=True)
    need(deploy != Path('/home/amax/.local/libexec/amax-console'),
         'Use a separately staged reviewed source tree, not installed production runtime')
    runtime_shas = {p.name: digest(p) for p in deploy.glob('*.py')}
    need(all(name in runtime_shas for name in ('platform-root-guard.py','node-executor.py', 'dataset-cache.py',
         'dataset-tier.py', 'storage-authority.py', 'transfer-peer.py', 'scheduling-policy.py')),
         'Reviewed deploy source is incomplete')
    # Read real mountinfo before creating even the disposable tree.
    cache_module = load(deploy / 'dataset-cache.py')
    cache_module._storage_mount('/data', str(root / 'cold'))
    root.mkdir(mode=0o700)
    save(root / MARKER, {'schema': 1, 'root': str(root), 'uid': 1000})
    shutil.copy2(Path(__file__), root / 'fixture.py')
    units = []
    success = False
    try:
        for name in ('source-runtime', 'target-runtime', 'state', 'target-state', 'approved'):
            (root / name).mkdir(mode=0o700)
        for source in deploy.glob('*.py'):
            for runtime in ('source-runtime', 'target-runtime'):
                shutil.copy2(source, root / runtime / source.name)
        for runtime in ('source-runtime', 'target-runtime'):
            need({p.name: digest(p) for p in (root / runtime).glob('*.py')} == runtime_shas,
                 'Copied fixture runtime differs from its pre-read SHA map')
        block = b'GPUQ PrivateTmp fixed immutable data\n'
        content = (block * (SIZE // len(block) + 1))[:SIZE]
        need(len(content) == SIZE, 'Fixture size mismatch')
        (root / 'approved/data.bin').write_bytes(content)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout',
                        str(root / 'key.pem'), '-out', str(root / 'cert.pem'), '-subj',
                        '/CN=private-tmp-authority-fixture', '-days', '1'],
                       check=True, capture_output=True, timeout=15)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
        need(port != 18443, 'Never use the production peer port')
        pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert((root / 'cert.pem').read_text())).hexdigest()
        peer = dict(address='127.0.0.1', port=port, certificateSha256=pin)
        config = dict(root=str(root / 'state'), machine='fixture-source', storageTier={'enabled': False},
                      storageAuthority={'enabled': True},
                      datasets=dict(root=str(root / 'cold'), mountPoint='/data', reserveBytes=0,
                                    sources={'fixture': str(root / 'approved')}),
                      transferPeer=dict(bind='127.0.0.1', port=port, certificate=str(root / 'cert.pem'),
                                        privateKey=str(root / 'key.pem')))
        save(root / 'source-runtime/node-config.json', config)
        node = load(root / 'source-runtime/node-executor.py')
        module, cache = node.dataset_cache()
        admin = module.Principal('builtin-admin', True)
        version = cache.register_source(admin, 'shared', 'fixture', ['builtin-admin'])['version']
        cache.materialize(admin, 'shared', version)
        authority = node.storage_authority_module()
        grant = node.storage_authority().seal(admin, 'shared', version, str(uuid.uuid4()), 'fixture-target')
        save(root / 'grant.json', grant)
        sealed = root / 'state/storage-authority' / grant['id'] / 'sealed.json'
        issued = sealed.with_name('grant.json')
        fixed = {'sealed': digest(sealed), 'grant': digest(issued)}
        issuer = {'namespace': namespace(), 'mount': list(cache.mount)}
        unit, command = systemd_command(root, 'peer')
        units.append(unit)  # Include even an unknown/timeout start outcome.
        subprocess.run(command, check=True, capture_output=True, timeout=15)
        client = authority.AuthorityClient(peer, grant)
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    if client.ready(): break
                except OSError:
                    pass
                need(time.monotonic() < deadline, 'PrivateTmp fixture daemon startup failed')
                time.sleep(.1)
            live = json.loads((root / 'peer-namespace.json').read_bytes())
            need(live['namespace'] != issuer['namespace'] and live['mount'][0] != issuer['mount'][0]
                 and live['mount'][1:] == issuer['mount'][1:], 'Test requires real distinct namespace mount IDs')
            need(client.call('guard') == grant['receipt'], 'Cross-namespace TLS guard failed')
        finally:
            client.close()
        target_config = dict(root=str(root / 'target-state'), machine='fixture-target',
                             storageTier={'enabled': False}, storageAuthorities={'hdd': {'machine': 'fixture-source'}},
                             transferPeers={'fixture-source': peer},
                             datasets=dict(root=str(root / 'hot'), mountPoint='/data', sources={}, reserveBytes=0))
        save(root / 'target-runtime/node-config.json', target_config)
        target = load(root / 'target-runtime/node-executor.py')
        target_module, hot = target.dataset_cache()
        target_admin = target_module.Principal('builtin-admin', True)
        hot.register_manifest(target_admin, 'replica', cache.export_manifest(admin, 'shared', version)['manifest'], ['builtin-admin'])
        storage = target.storage_node()
        remote = storage.tier.authorities['hdd']
        remote.install_grant(grant)
        proof = remote.seal(target_admin, 'shared', version, 'authority-fixture')
        remote.recover(target_admin, proof, hot, 'replica', validate_target=lambda: None)
        storage.tier.verify_authority(target_admin, 'replica', version, 'hdd', 'shared')
        hot.evict(target_admin, 'replica', version)
        need(storage.tier.recover(target_admin, 'replica', version)['state'] == 'READY', 'Recovery failed')
        ready = hot._paths('replica', version)['ready'] / 'data/data.bin'
        need(digest(ready) == hashlib.sha256(content).hexdigest() and not ready.stat().st_mode & 0o222,
             'Recovered payload is not exact and read-only')
        negative_unit, negative = systemd_command(root, 'live-guard')
        units.append(negative_unit)
        result = subprocess.run(negative, check=True, capture_output=True, text=True, timeout=25)
        negative_receipt = json.loads(result.stdout)
        need(negative_receipt.get('sameInstanceMountChangeDenied') is True, 'Live guard negative test not confirmed')
        need(fixed == {'sealed': digest(sealed), 'grant': digest(issued)}, 'Issued proof/grant changed')
        receipt = dict(state='PASS', fixtureRoot=str(root), bytes=SIZE, version=version,
                       issuer=issuer, peer=live, proofAndGrantBytesUnchanged=True,
                       sourceGuardOverActualDaemon=True, pinnedTlsEvictRecoverPassed=True,
                       negative=negative_receipt, runtimeSha256=runtime_shas,
                       scriptSha256=digest(Path(__file__)), gcEnabled=False)
        success = True
    finally:
        stop_fixture_units(units)
    if success:
        remove_exact_fixture(root)
        receipt.update(fixturePeerStopped=True, fixtureRemoved=not root.exists())
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--deploy')
    parser.add_argument('--fixture-root', required=True)
    parser.add_argument('--worker', choices=('peer', 'live-guard'))
    args = parser.parse_args()
    os.umask(0o077)
    if args.worker:
        root = fixture_path(args.fixture_root, existing=True)
        (peer_worker if args.worker == 'peer' else live_guard_worker)(root)
    else:
        need(args.execute and args.deploy, 'Explicit --execute and reviewed --deploy required')
        print(json.dumps(execute(args.deploy, fixture_path(args.fixture_root)), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'state': 'FAILED', 'errorType': type(error).__name__,
                          'fixtureRetainedForInspection': True}), file=sys.stderr)
        sys.exit(1)
