"""No-GPU durable transfer worker and scoped immutable-snapshot capabilities.

LAN peers expose READ ONLY snapshots over certificate-pinned TLS. The regular
Portal SSH executor alone may create/cancel jobs or mint source tickets. No
host path, shell command, identity or peer address comes from a peer request.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import subprocess
import time

VERSION = 1
PROTOCOL = 'lan-transfer-v1'
CHUNK = 1024**2
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
USER = re.compile(r'(builtin-admin|demo-user-[0-9]+)\Z')
MACHINE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')
TERMINAL = {'SUCCEEDED', 'FAILED', 'PAUSED', 'CANCELED'}
RELEASABLE = {'SUCCEEDED', 'FAILED', 'CANCELED'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError('A full transfer UUID is required')
    return value


def reference(value):
    if (not isinstance(value, dict) or set(value) != {'kind', 'dataset', 'version'}
            or value['kind'] != 'datasets' or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', value.get('dataset', ''))
            or not HASH.fullmatch(value.get('version', ''))):
        raise ValueError('Select one immutable dataset and full version')
    return dict(value)


class PeerClient:
    """Persistent LAN TLS connection: authenticate pin BEFORE sending ticket."""
    def __init__(self, config, ticket):
        if (not isinstance(config, dict) or set(config) != {'address', 'port', 'certificateSha256'}
                or type(config['port']) is not int or not 1 <= config['port'] <= 65535
                or not HASH.fullmatch(config['certificateSha256'])):
            raise ValueError('LAN peer is not explicitly configured')
        ip = ipaddress.ip_address(config['address'])
        if ip.version != 4 or not (ip.is_private or ip.is_loopback) or ip.is_unspecified or ip.is_multicast:
            raise ValueError('Use an explicit LAN IPv4 peer')
        self.config, self.ticket, self.connection = config, ticket, None
        self.campus_only = False  # Set only by a verified private training worker.
        self.campus_binding = None

    def campus_route(self):
        """Fixed peer metadata only. No discovery, tunnel or relay fallback."""
        address=ipaddress.ip_address(self.config['address'])
        if address.version!=4 or not address.is_private or address.is_loopback:
            raise ValueError('Training data requires a campus physical IPv4 peer')
        tool=next((name for name in ('/usr/sbin/ip','/usr/bin/ip','/sbin/ip','/bin/ip') if Path(name).is_file()),None)
        if tool is None:raise ValueError('Campus data route cannot be verified')
        result=subprocess.run([tool,'-j','route','get',str(address)],capture_output=True,text=True,timeout=2)
        if result.returncode or len(result.stdout)>16384:raise ValueError('Campus data route cannot be verified')
        rows=json.loads(result.stdout)
        if not isinstance(rows,list) or len(rows)!=1 or not isinstance(rows[0],dict):raise ValueError('Campus data route cannot be verified')
        route=rows[0];device=route.get('dev');source=route.get('prefsrc') or route.get('src')
        if (not isinstance(device,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,32}',device)
                or device.lower().startswith(('tailscale','tun','tap','wg','lo'))
                or not (Path('/sys/class/net')/device/'device').exists()):
            raise ValueError('Training data route is not a campus physical interface')
        ip=ipaddress.ip_address(source)
        if ip.version!=4 or not ip.is_private or ip.is_loopback:raise ValueError('Campus data source cannot be verified')
        return {'device':device,'source':str(ip),'gateway':route.get('gateway')}

    def close(self):
        if self.connection:
            self.connection.close()
        self.connection = None
        self.campus_binding = None

    def verify_campus(self,*,response=False):
        if self.campus_only and (self.campus_binding is None or self.campus_route()!=self.campus_binding
                or self.connection is None or not response and (self.connection.sock is None
                    or self.connection.sock.getsockname()[0]!=self.campus_binding['source'])):
            self.close()
            raise ValueError('Campus data route changed before file transfer')

    def connect(self, timeout=25):
        if not self.connection or self.connection.sock is None:
            self.close()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE  # Explicit DER pin is the trust anchor.
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            route=self.campus_route() if self.campus_only else None
            options={'source_address':(route['source'],0)} if route is not None else {}
            connection = http.client.HTTPSConnection(self.config['address'], self.config['port'], timeout=timeout, context=context,**options)
            try:
                connection.connect()
                if not hmac.compare_digest(hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest(), self.config['certificateSha256']):
                    raise ValueError('LAN peer certificate differs from configured pin')
                if route is not None and (self.campus_route()!=route or connection.sock.getsockname()[0]!=route['source']):
                    raise ValueError('Campus data route changed before file transfer')
            except Exception:
                connection.close()
                raise
            self.connection = connection
            self.campus_binding = route
        else:
            # A persistent TCP connection can be rerouted too. Check every
            # bounded read, not merely a handshake/reconnect, before any token
            # or payload request and again before accepting its response.
            self.verify_campus()

    def ready(self):
        """Bounded, ticket-free probe, only to an explicitly pinned LAN peer."""
        try:
            self.connect(timeout=2)
            self.connection.request('GET', '/capabilities')
            response = self.connection.getresponse()
            raw = response.read(257)
            return response.status == 200 and len(raw) <= 256 and json.loads(raw) == {'protocol': PROTOCOL, 'sourceReady': True}
        except (OSError, ValueError, http.client.HTTPException):
            return False
        finally:
            self.close()

    def call(self, action, **fields):
        try:
            self.connect()
            payload = json.dumps({'id': self.ticket['id'], 'action': action, **fields}).encode()
            self.connection.request('POST', '/snapshot', body=payload,
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer '+self.ticket['token']})
            response = self.connection.getresponse()
            raw = response.read(1500001)
            # A valid HTTP Connection:close response has already detached its
            # socket. The send-side source was checked before the request; the
            # completed response still must have the identical campus route.
            self.verify_campus(response=True)
            if len(raw) > 1500000:
                raise ValueError('Peer response is too large')
            value = json.loads(raw)
            if response.status == 503 and value.get('ok') is False and value.get('code') == 'SOURCE_CACHE_BUSY':
                # Only this typed metadata-lock response joins the existing
                # bounded read retry budget. Other 503s and every 403 remain
                # terminal; acknowledged target writes are never replayed.
                raise ConnectionError('Source dataset metadata is temporarily busy')
            if response.status != 200 or value.get('ok') is not True:
                raise ValueError('Source snapshot unavailable: '+str(value.get('error', response.status))[:200])
            return value['result']
        except Exception:
            self.close()
            raise


class TransferJobs:
    def __init__(self, executor):
        self.n = executor
        self.root = executor.ROOT/'transfer-jobs'
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink() or self.root.stat().st_uid != os.getuid() or self.root.stat().st_mode & 0o077:
            raise ValueError('Unsafe transfer state directory')

    def path(self, key, suffix='.json'):
        return self.root/(identifier(key)+suffix)

    @contextmanager
    def lock(self, key, suffix='.lock'):
        fd = os.open(self.path(key, suffix), os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def load(self, key, suffix='.json'):
        path = self.path(key, suffix)
        fd = os.open(path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 65536:
                raise ValueError('Invalid transfer receipt')
            return json.loads(os.read(fd, 65537))
        finally:
            os.close(fd)

    def actor(self, args):
        if not USER.fullmatch(args.get('userId', '')) or type(args.get('hostAdmin', False)) is not bool:
            raise ValueError('Invalid transfer identity')
        self.n.workspace(args['userId'])

    def capabilities(self, args):
        if set(args) != {'userId'}:
            raise ValueError('Capability query accepts only authenticated identity')
        self.actor(args)
        result = {'protocol': PROTOCOL, 'enabled': False, 'sourceReady': False, 'sources': []}
        try:
            self.n.dataset_uploads()  # Configured quotas and live local mount.
            manager = subprocess.run(['/usr/bin/systemctl', '--user', 'show', '--property=Version'],
                env=self.n.ENV, text=True, capture_output=True, timeout=3)
            result['enabled'] = manager.returncode == 0 and manager.stdout.startswith('Version=')
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        peer = self.n.CONFIG.get('transferPeer')
        if isinstance(peer, dict):
            try:
                certificate = Path(peer['certificate']).read_text()
                pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate)).hexdigest()
                result['sourceReady'] = PeerClient({'address': peer['bind'], 'port': peer['port'], 'certificateSha256': pin}, {}).ready()
            except (KeyError, OSError, ValueError, TypeError):
                pass
        peers = self.n.CONFIG.get('transferPeers', {})
        if not result['enabled'] or not isinstance(peers, dict) or len(peers) > 16:
            return result
        def probe(item):
            machine, config = item
            try:
                if isinstance(machine, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', machine) and PeerClient(config, {}).ready():
                    return machine
            except (ValueError, TypeError, KeyError):
                pass
        with ThreadPoolExecutor(max_workers=4) as pool:
            result['sources'] = sorted(filter(None, pool.map(probe, peers.items())))
        return result

    def snapshots(self):
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('gpuq_transfer_snapshots', self.n.HERE/'snapshot-sync.py')
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.SnapshotSync(self.n)

    def machine(self):
        value = self.n.CONFIG.get('machine')
        if not isinstance(value, str) or not MACHINE.fullmatch(value):
            raise ValueError('Configure the exact local machine identity before source transfers')
        return value

    @staticmethod
    def lease_args(journal):
        return {**journal['actor'], 'dataset': journal['reference']['dataset'],
                'version': journal['reference']['version']}

    def source(self, ref, actor, action, *, _transfer_lease=None, _snapshots=None, **fields):
        snapshots = self.snapshots() if _snapshots is None else _snapshots
        return snapshots.export('datasets.snapshot.'+action,
            {'dataset': ref['dataset'], 'version': ref['version'], 'userId': actor['userId'],
             'hostAdmin': actor.get('hostAdmin', False), **fields}, _transfer_lease=_transfer_lease)

    def prepare(self, args):
        if set(args)-{'id', 'reference', 'userId', 'hostAdmin', 'timeoutSec', 'renew', 'targetMachine'} or type(args.get('renew',False)) is not bool:
            raise ValueError('Invalid source ticket fields')
        self.actor(args)
        key, ref = identifier(args.get('id')), reference(args.get('reference'))
        timeout = args.get('timeoutSec', 86400)
        if type(timeout) is not int or not 1 <= timeout <= 604800:
            raise ValueError('Transfer timeout must be 1..604800 seconds')
        actor = {'userId': args['userId'], 'hostAdmin': args.get('hostAdmin', False)}
        target = args.get('targetMachine')
        if not isinstance(target, str) or not MACHINE.fullmatch(target) or target == self.machine():
            raise ValueError('Bind the source ticket to a different exact target machine')
        payload = {'reference': ref, 'actor': actor, 'timeoutSec': timeout,
                   'sourceMachine': self.machine(), 'targetMachine': target}
        with self.lock(key, '.ticket.lock'):
            try:
                ticket = self.load(key, '.ticket.json')
                if ticket['digest'] != digest(payload):
                    raise ValueError('Source ticket ID belongs to different content')
            except FileNotFoundError:
                if len(list(self.root.glob('*.ticket.json'))) >= 10000:
                    raise ValueError('Source ticket history is full')
                ticket = None
            try:
                journal = self.load(key, '.source-lease.json')
                if journal['digest'] != digest(payload):
                    raise ValueError('Source lease ID belongs to different content')
                if journal['state'] in ('RELEASING', 'RELEASED'):
                    raise ValueError('Source transfer was finalized; use a new transfer ID')
            except FileNotFoundError:
                # Durable intent makes a crash between cache acquisition and
                # saving leaseId recoverable by the same owner/jobId. Never TTL.
                journal = {**payload, 'id': key, 'digest': digest(payload),
                           'state': 'PREPARING', 'createdAt': time.time()}
                with self.lock('00000000-0000-0000-0000-000000000000', '.source-history.lock'):
                    if len(list(self.root.glob('*.source-lease.json'))) >= 10000:
                        raise ValueError('Source lease history is full; reconcile before creating more transfers')
                    self.n.atomic_json(self.path(key, '.source-lease.json'), journal)
            snapshot = self.snapshots()
            lease = snapshot.acquire_transfer_lease(self.lease_args(journal), key)
            if journal.get('leaseId') not in (None, lease['leaseId']):
                raise ValueError('Source lease identity changed; reconcile retained leases')
            journal.update(leaseId=lease['leaseId'], state='HELD')
            self.n.atomic_json(self.path(key, '.source-lease.json'), journal)
            # Any failure after acquisition leaves the durable intent/lease
            # protected and retryable; no guessed target state can release it.
            info = self.source(ref, actor, 'info', _transfer_lease=(key, journal['leaseId']))
            if ticket is None:
                ticket = {**payload, 'id': key, 'digest': digest(payload), 'info': info,
                    'expiresAt': time.time()+timeout+3600, 'token': secrets.token_urlsafe(32)}
                self.n.atomic_json(self.path(key, '.ticket.json'), ticket)
            elif args.get('renew'):
                if ticket['info'] != info or ticket.get('revoked'):
                    raise ValueError('Fixed source snapshot changed or grant revoked')
                ticket.update(token=secrets.token_urlsafe(32), expiresAt=time.time()+timeout+3600)
                self.n.atomic_json(self.path(key, '.ticket.json'), ticket)
            if ticket['info'] != info or ticket['expiresAt'] < time.time() or ticket.get('revoked'):
                raise ValueError('Source ticket expired, revoked or snapshot changed; inspect original transfer')
            return {'id': key, 'token': ticket['token'], **info}

    def read(self, request, token):
        if not isinstance(request, dict) or set(request)-{'id', 'action', 'path', 'offset'}:
            raise ValueError('Peer may only read a granted immutable snapshot')
        key = identifier(request.get('id'))
        # Readers and revocation share a lock; no in-flight peer read outlives
        # confirmed revocation and lease release.
        with self.lock(key, '.ticket.lock'):
            return self.read_locked(request, token)

    def read_locked(self, request, token):
        key = identifier(request.get('id'))
        ticket = self.load(key, '.ticket.json')
        if (not isinstance(token, str) or not hmac.compare_digest(token, ticket['token'])
                or ticket.get('revoked') or ticket['expiresAt'] < time.time()):
            raise ValueError('Source ticket is invalid or expired')
        action = request.get('action')
        fields = {k: v for k, v in request.items() if k in ('path', 'offset')}
        if action not in ('info', 'manifest', 'get') or action == 'info' and fields or action == 'manifest' and 'path' in fields:
            raise ValueError('Invalid snapshot read operation')
        journal = self.load(key, '.source-lease.json')
        if journal['state'] != 'HELD' or journal['digest'] != ticket['digest']:
            raise ValueError('Source transfer is not protected by a persistent lease')
        # Reuse only this request's adapter, not any authorization, lease,
        # registry or file result. Both export calls still recheck live state.
        snapshots = self.snapshots()
        snapshots.require_transfer_lease(self.lease_args(journal), key, journal['leaseId'])
        lease = (key, journal['leaseId'])
        info = self.source(ticket['reference'], ticket['actor'], 'info', _transfer_lease=lease, _snapshots=snapshots)
        if info != ticket['info']:
            raise ValueError('Fixed source snapshot changed')
        return info if action == 'info' else self.source(ticket['reference'], ticket['actor'], action,
            _transfer_lease=lease, _snapshots=snapshots, **fields)

    def confirm_source_release(self, args):
        """Trusted target control: permanently fence restart BEFORE releasing."""
        binding = {'sourceMachine', 'reference', 'manifestSha256'}
        if set(args) not in ({'id', 'userId'}, {'id', 'userId'}|binding):
            raise ValueError('Invalid target release confirmation fields')
        self.actor(args)
        with self.lock(args['id']):
            try:
                proof = self.load(args['id'], '.source-release.json')
                if proof['userId'] != args['userId'] or any(proof[k] != args[k] for k in binding if k in args):
                    raise ValueError('Target release confirmation identity cannot change')
                return proof
            except FileNotFoundError:
                pass
            try:
                spec = self.owned(args)
            except FileNotFoundError:
                # Cancel-before-dispatch: cancel marker and this permanent
                # fence serialize with start, so a delayed control cannot launch.
                marker = self.load(args['id'], '.cancel')
                if (marker.get('userId') != args['userId'] or not binding <= set(args)
                        or not isinstance(args['sourceMachine'], str) or not MACHINE.fullmatch(args['sourceMachine'])
                        or not isinstance(args['manifestSha256'], str) or not HASH.fullmatch(args['manifestSha256'])
                        or self.activity(self.unit(args['id'], 1)) is not False):
                    raise ValueError('Pre-dispatch cancellation requires owned binding and confirmed stopped target')
                proof = {'schema': 1, 'id': args['id'], 'userId': args['userId'],
                    'sourceMachine': args['sourceMachine'], 'targetMachine': self.machine(),
                    'reference': reference(args['reference']), 'manifestSha256': args['manifestSha256'],
                    'attempt': 0, 'state': 'CANCELED', 'confirmedStopped': True}
                self.n.atomic_json(self.path(args['id'], '.source-release.json'), proof)
                return proof
            if any(args[k] != (spec['source']['manifestSha256'] if k == 'manifestSha256' else spec[k])
                   for k in binding if k in args):
                raise ValueError('Target release confirmation identity cannot change')
            current = self.status(args)
            if current['state'] not in RELEASABLE or self.activity(self.unit(spec['id'], spec['attempt'])) is not False:
                raise ValueError('Source release requires a confirmed stopped terminal target; PAUSED/UNKNOWN retain leases')
            confirmation = {'schema': 1, 'id': spec['id'], 'userId': spec['userId'],
                'sourceMachine': spec['sourceMachine'], 'targetMachine': self.machine(),
                'reference': spec['reference'], 'manifestSha256': spec['source']['manifestSha256'],
                'attempt': spec['attempt'], 'state': current['state'], 'confirmedStopped': True}
            self.n.atomic_json(self.path(spec['id'], '.source-release.json'), confirmation)
            return confirmation

    def release_source(self, args):
        """SSH control ONLY; a peer bearer ticket is never release authority.

        The trusted bridge must obtain confirmation from the bound target's
        confirm-source-release action, never accept it from a public API body.
        """
        if set(args) != {'id', 'userId', 'confirmation'}:
            raise ValueError('Invalid source release fields')
        self.actor(args)
        key = identifier(args['id'])
        with self.lock(key, '.ticket.lock'):
            journal = self.load(key, '.source-lease.json')
            if journal['actor']['userId'] != args['userId']:
                raise ValueError('Source lease belongs to another user')
            if journal['sourceMachine'] != self.machine():
                raise ValueError('Source machine identity changed; reconcile before releasing')
            proof = args['confirmation']
            ticket = self.load(key, '.ticket.json')
            expected = {'schema': 1, 'id': key, 'userId': args['userId'],
                'sourceMachine': journal['sourceMachine'], 'targetMachine': journal['targetMachine'],
                'reference': journal['reference'], 'manifestSha256': ticket['info']['manifestSha256'],
                'confirmedStopped': True}
            if (not isinstance(proof, dict) or set(proof) != set(expected)|{'attempt', 'state'}
                    or any(proof.get(k) != v for k, v in expected.items())
                    or proof.get('confirmedStopped') is not True or type(proof.get('schema')) is not int
                    or type(proof.get('attempt')) is not int or proof['attempt'] < 0 or proof['state'] not in RELEASABLE
                    or proof['attempt'] == 0 and proof['state'] != 'CANCELED'):
                raise ValueError('Source release requires the bound target stopped-terminal confirmation')
            if journal.get('confirmation') not in (None, proof):
                raise ValueError('Source release confirmation cannot change')
            if journal['state'] == 'RELEASED':
                return {'id': key, 'released': True}
            # Fence future prepare/read first. A crash keeps the lease or can
            # idempotently finish release; it can never mint another ticket.
            journal.update(state='RELEASING', confirmation=proof)
            self.n.atomic_json(self.path(key, '.source-lease.json'), journal)
            ticket['revoked'] = True
            self.n.atomic_json(self.path(key, '.ticket.json'), ticket)
            self.snapshots().release_transfer_lease(self.lease_args(journal), journal['leaseId'])
            journal.update(state='RELEASED', releasedAt=time.time())
            self.n.atomic_json(self.path(key, '.source-lease.json'), journal)
            return {'id': key, 'released': True}

    def confirm_unprepared_cancel(self, args):
        """Internal target control: certify an explicitly canceled, unstarted ID."""
        if set(args) != {'id', 'userId', 'sourceMachine', 'reference'}:
            raise ValueError('Invalid unprepared cancellation fields')
        self.actor(args)
        key, ref = identifier(args['id']), reference(args['reference'])
        source = args['sourceMachine']
        if not isinstance(source, str) or not MACHINE.fullmatch(source) or source == self.machine():
            raise ValueError('Invalid source machine identity')
        proof = {'schema': 1, 'mode': 'unprepared-cancel-v1', 'id': key, 'userId': args['userId'],
                 'sourceMachine': source, 'targetMachine': self.machine(), 'reference': ref,
                 'attempt': 0, 'state': 'CANCELED', 'confirmedStopped': True}
        with self.lock(key):
            # Serialize with start/resume, and fail closed on any surviving spec.
            try:
                self.load(key)
            except FileNotFoundError:
                pass
            else:
                raise ValueError('Unprepared cancellation requires no target specification')
            marker = self.load(key, '.cancel')
            if marker.get('userId') != args['userId'] or self.activity(self.unit(key, 1)) is not False:
                raise ValueError('Unprepared cancellation requires owned cancel and confirmed stopped target')
            try:
                prior = self.load(key, '.source-release.json')
                if prior != proof:
                    raise ValueError('Target release confirmation identity cannot change')
            except FileNotFoundError:
                self.n.atomic_json(self.path(key, '.source-release.json'), proof)
            return proof

    def release_unprepared_source(self, args):
        """Internal source control; no ticket may ever have been issued for ID."""
        if set(args) != {'id', 'userId', 'confirmation'}:
            raise ValueError('Invalid unprepared source release fields')
        self.actor(args)
        key = identifier(args['id'])
        with self.lock(key, '.ticket.lock'):
            # A lost prepare reply is NOT an unprepared transfer. Never fabricate
            # a manifest/ticket or weaken the existing issued-ticket protocol.
            try:
                self.load(key, '.ticket.json')
            except FileNotFoundError:
                pass
            else:
                raise ValueError('Issued source ticket requires the regular release protocol')
            journal = self.load(key, '.source-lease.json')
            payload = {k: journal[k] for k in ('reference', 'actor', 'timeoutSec', 'sourceMachine', 'targetMachine')}
            if (journal['id'] != key or journal['digest'] != digest(payload)
                    or journal['actor']['userId'] != args['userId'] or journal['sourceMachine'] != self.machine()):
                raise ValueError('Unprepared source journal identity mismatch')
            expected = {'schema': 1, 'mode': 'unprepared-cancel-v1', 'id': key, 'userId': args['userId'],
                        'sourceMachine': journal['sourceMachine'], 'targetMachine': journal['targetMachine'],
                        'reference': reference(journal['reference']), 'attempt': 0,
                        'state': 'CANCELED', 'confirmedStopped': True}
            proof = args['confirmation']
            if (not isinstance(proof, dict) or proof != expected or type(proof.get('schema')) is not int
                    or type(proof.get('attempt')) is not int or proof.get('confirmedStopped') is not True):
                raise ValueError('Unprepared source release requires exact stopped-target confirmation')
            retry = journal['state'] in ('RELEASING', 'RELEASED') and journal.get('confirmation') == expected
            if (not retry and journal['state'] != 'PREPARING') or journal.get('leaseId') is not None:
                raise ValueError('Only an original PREPARING source journal may use unprepared cancellation')
            if journal.get('confirmation') not in (None, expected):
                raise ValueError('Source release confirmation cannot change')
            if journal['state'] == 'RELEASED':
                return {'id': key, 'released': True}
            # Existing prepare rejects both states. Persist this fence BEFORE
            # looking up/removing a lease whose ID may not have been journaled.
            journal.update(state='RELEASING', confirmation=expected)
            self.n.atomic_json(self.path(key, '.source-lease.json'), journal)
            self.snapshots().release_unprepared_transfer_lease(self.lease_args(journal), key)
            journal.update(state='RELEASED', releasedAt=time.time())
            self.n.atomic_json(self.path(key, '.source-lease.json'), journal)
            return {'id': key, 'released': True}

    @staticmethod
    def unit(key, attempt):
        return 'gpuq-transfer-'+identifier(key)+'-'+str(attempt)+'.service'

    def activity(self, unit):
        """True active, False confirmed quiescent, None unknown. Never PID-only."""
        try:
            result = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit,
                '--property=LoadState,ActiveState,MainPID,ControlGroup'], env=self.n.ENV, text=True, capture_output=True, timeout=5)
            props = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
            if set(props) != {'LoadState', 'ActiveState', 'MainPID', 'ControlGroup'}:
                return None
            if result.returncode not in (0, 1) or result.returncode == 1 and props['LoadState'] != 'not-found':
                return None
            if props['MainPID'] != '0' or props['ActiveState'] not in ('inactive', 'failed'):
                return True
            group = props['ControlGroup']
            if group:
                if not group.startswith('/') or '..' in Path(group).parts or Path(group).name != unit:
                    return None
                folder = Path('/sys/fs/cgroup')/group.lstrip('/')
                try:
                    events = dict(line.split() for line in (folder/'cgroup.events').read_text().splitlines())
                except FileNotFoundError:
                    return False if not folder.exists() else None
                return events.get('populated') != '0'
            return False if props['LoadState'] in ('loaded', 'not-found') else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return None

    def owned(self, args):
        self.actor(args)
        spec = self.load(args['id'])
        if spec['userId'] != args['userId']:
            raise ValueError('Transfer belongs to a different account')
        return spec

    def status(self, args):
        spec = self.owned(args)
        active = self.activity(self.unit(spec['id'], spec['attempt']))
        try:
            result = self.load(spec['id'], '.result.json')
            if result.get('attempt') != spec['attempt']:
                result = {}
        except FileNotFoundError:
            result = {}
        try:
            progress = self.load(spec['id'], '.progress.json')
            if progress.get('attempt') != spec['attempt']:
                progress = {}
        except FileNotFoundError:
            progress = {}
        canceled = self.path(spec['id'], '.cancel').exists()
        stopped = 'PAUSED' if self.path(spec['id'], '.started-'+str(spec['attempt'])).exists() else 'UNKNOWN'
        # A durable owner cancellation fences a stopped failed/paused attempt;
        # its older result must not keep cancellation pending forever. Preserve
        # completed success, and never infer a stop from the marker alone.
        finished = 'CANCELED' if canceled and result.get('state') != 'SUCCEEDED' else result.get('state', stopped)
        state = ('CANCELING' if canceled else progress.get('state', 'RUNNING')) if active is True else (
            finished if active is False else 'UNKNOWN')
        if active is True and state in TERMINAL:
            state = 'VERIFYING'
        return {'id': spec['id'], 'state': state, 'attempt': spec['attempt'], 'route': 'lan',
            'bytes': progress.get('bytes', 0), 'totalBytes': spec['source']['totalBytes'],
            'path': progress.get('path'), 'createdAt': spec['createdAt'], 'checkedAt': time.time(),
            'error': result.get('error'), 'retries': result.get('retries',0),
            **{k: v for k, v in result.items() if k in ('dataset', 'version', 'uploadId')}}

    def launch(self, spec, *, training=False):
        self.n.atomic_json(self.path(spec['id']), spec)  # Attempt marker precedes launch.
        try:
            self.n.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit='+self.unit(spec['id'], spec['attempt']),
                '--property=Type=exec', '--property=KillMode=control-group', '--property=UMask=0077',
                '--property=CPUQuota=200%', '--property=MemoryMax=2G', '--property=TasksMax=128',
                '--property=RuntimeMaxSec='+str(spec['timeoutSec']+10), '--property=TimeoutStopSec=5',
                '/usr/bin/python3', str(self.n.HERE/'node-executor.py'), '--training-transfer-worker' if training else '--transfer-worker', spec['id'], str(spec['attempt'])], timeout=8)
        except (OSError, ValueError, subprocess.SubprocessError):
            pass  # Ambiguous launch is inspected, never automatically launched twice.

    def admit(self, spec):
        # Four durable slots, not a systemctl scan of the entire job history.
        # Reserve BEFORE launch. A missing/unknown receipt retains its slot.
        global_id='00000000-0000-0000-0000-000000000000'
        try:
            slots=self.load(global_id,'.slots.json')['slots']
        except FileNotFoundError:
            if any(UUID.fullmatch(p.name[:-5]) for p in self.root.glob('*.json')):
                raise ValueError('Admission receipts missing; inspect existing transfers before dispatch')
            slots=[]
        if not isinstance(slots,list) or len(slots)>4:
            raise ValueError('Invalid transfer admission receipt')
        retained=[]
        for slot in slots:
            try:
                state=self.status({'id':slot['id'],'userId':slot['userId']})['state']
            except FileNotFoundError:
                state='UNKNOWN'
                try:
                    marker=self.load(slot['id'],'.cancel')
                    if marker.get('userId')==slot['userId']:state='CANCELED'
                except FileNotFoundError:
                    pass
            if state not in TERMINAL:retained.append(slot)
        existing=next((s for s in retained if s['id']==spec['id']),None)
        if existing and (existing['userId']!=spec['userId'] or existing['digest']!=spec['digest']):
            raise ValueError('Reserved transfer identity cannot change')
        if not existing and len(retained)>=4:
            raise ValueError('Four active or unconfirmed transfer jobs already exist')
        if not existing:retained.append({k:spec[k] for k in ('id','userId','digest')})
        self.n.atomic_json(self.path(global_id,'.slots.json'),{'slots':retained})

    def start(self, args, *, training=False):
        if set(args)-{'id', 'userId', 'username', 'sourceMachine', 'source', 'reference', 'name', 'timeoutSec', 'archiveLane'}:
            raise ValueError('Invalid LAN transfer fields')
        self.actor(args)
        key = identifier(args.get('id'))
        source = args.get('source')
        if (not isinstance(source, dict) or set(source) != {'id', 'token', 'state', 'manifestBytes', 'manifestSha256', 'totalBytes', 'entries'}
                or source['id'] != key or source['state'] != 'READY' or not HASH.fullmatch(source['manifestSha256'])
                or not isinstance(source['token'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', source['token'])
                or type(source['manifestBytes']) is not int or not 1 <= source['manifestBytes'] <= 64*CHUNK
                or type(source['totalBytes']) is not int or not 0 <= source['totalBytes'] <= 2**53-1
                or type(source['entries']) is not int or not 0 <= source['entries'] <= 500000):
            raise ValueError('Invalid fixed source ticket')
        ref = reference(args.get('reference'))
        timeout = args.get('timeoutSec', 86400)
        if type(timeout) is not int or not 1 <= timeout <= 604800 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}', args.get('name', '')):
            raise ValueError('Invalid target name or timeout')
        peer = self.n.CONFIG.get('transferPeers', {}).get(args.get('sourceMachine'))
        PeerClient(peer, source).close()  # Validate trusted config; no connection yet.
        payload = {k: args[k] for k in ('userId', 'sourceMachine', 'source', 'name')}
        payload.update(reference=ref, timeoutSec=timeout)
        if 'archiveLane' in args:
            payload['archiveLane'] = self.archive_lane(args['archiveLane'], args['sourceMachine'])
        with self.lock(key):
            if self.path(key, '.source-release.json').exists():
                raise ValueError('Source transfer was finalized; use a new transfer ID')
            if self.path(key, '.cancel').exists():
                raise ValueError('Transfer ID was canceled before dispatch; it cannot start')
            try:
                spec = self.load(key)
            except FileNotFoundError:
                spec = None
            if spec is not None:
                if 'targetStorage' in spec:
                    payload['targetStorage']=spec['targetStorage']
                    self.target_uploads(spec)
                if spec['digest'] != digest(payload):
                    raise ValueError('Transfer ID cannot change source or target')
            else:
                if len(list(self.root.glob('*.json'))) >= 40000:
                    raise ValueError('Transfer history is full')
                # One service-user admission guard; no unbounded background fanout.
                with self.lock('00000000-0000-0000-0000-000000000000', '.admission.lock'):
                    target_storage=self.new_target_storage(payload)
                    if target_storage is not None:payload['targetStorage']=target_storage
                    spec = {**payload, 'id': key, 'digest': digest(payload), 'attempt': 1, 'createdAt': time.time()}
                    self.admit(spec)
                    self.launch(spec, training=True) if training else self.launch(spec)
            return self.status({'id': key, 'userId': args['userId']})

    def cancel(self, args):
        with self.lock(args['id']):
            self.actor(args)
            try:
                spec = self.owned(args)
            except FileNotFoundError:
                try:
                    marker = self.load(args['id'], '.cancel')
                    if marker['userId'] != args['userId']:
                        raise ValueError('Transfer belongs to another account')
                except FileNotFoundError:
                    self.n.atomic_json(self.path(args['id'], '.cancel'), {'at': time.time(), 'userId': args['userId']})
                return {'id': args['id'], 'state': 'CANCELED', 'bytes': 0, 'totalBytes': 0, 'route': 'lan'}
            if self.status(args)['state'] == 'SUCCEEDED':
                return self.status(args)
            self.n.atomic_json(self.path(spec['id'], '.cancel'), {'at': time.time(), 'userId': args['userId']})
            try:
                self.n.run(['/usr/bin/systemctl', '--user', 'stop', self.unit(spec['id'], spec['attempt'])], timeout=10)
            except (OSError, ValueError, subprocess.SubprocessError):
                # The executor wraps nonzero systemctl exits as ValueError,
                # including an already-collected unit. Fresh activity below,
                # not the stop command's exit status, confirms termination.
                pass
            return self.status(args)

    def resume(self, args, *, training=False):
        with self.lock(args['id']):
            spec = self.owned(args)
            if 'targetStorage' in spec:self.target_uploads(spec)
            if 'archiveLane' in spec:
                self.archive_lane(spec['archiveLane'], spec['sourceMachine'])
            if self.path(spec['id'], '.source-release.json').exists():
                raise ValueError('Source transfer was finalized; use a new transfer ID')
            if self.path(spec['id'], '.cancel').exists():
                raise ValueError('Canceled jobs never resume automatically or reuse their canceled ID')
            state = self.status(args)['state']
            if state not in ('FAILED', 'PAUSED'):
                raise ValueError('Only a confirmed stopped resumable transfer may start a new attempt')
            if 'source' in args:
                source=args['source']
                if (not isinstance(source,dict) or set(source)!=set(spec['source'])
                        or any(source[k]!=spec['source'][k] for k in source if k!='token')
                        or not isinstance(source.get('token'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',source['token'])):
                    raise ValueError('Resume may renew only the SAME immutable source ticket')
                spec['source']=source
                spec['digest']=digest({k:spec[k] for k in ('userId','sourceMachine','source','name','reference','timeoutSec','archiveLane','targetStorage') if k in spec})
            with self.lock('00000000-0000-0000-0000-000000000000', '.admission.lock'):
                self.admit(spec)
                spec['attempt'] += 1
                self.launch(spec, training=True) if training else self.launch(spec)
            return self.status(args)

    def new_target_storage(self, spec):
        """Only new authenticated fixed-version copies gain a hot-root bind."""
        if 'archiveLane' in spec or self.n.CONFIG.get('storageWarehouse',{}).get('enabled') is not True:
            return None
        ref=spec.get('reference',{});source=spec.get('sourceMachine')
        authorities=self.n.CONFIG.get('storageAuthorities',{})
        configured=isinstance(authorities,dict) and any(
            isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',name)
            and value=={'machine':source} for name,value in authorities.items())
        if (source==self.n.CONFIG.get('machine') or ref.get('kind')!='datasets'
                or not HASH.fullmatch(str(ref.get('version',''))) or not configured):
            raise PermissionError('New warehouse/cache transfers require a configured authoritative warehouse source')
        PeerClient(self.n.CONFIG.get('transferPeers',{}).get(source),{}).close()
        warehouse=self.n.storage_warehouse()
        if warehouse is None:
            raise ValueError('Configured warehouse/cache storage is unavailable')
        self.n.dataset_mount_check(self.n.CONFIG['datasets'])
        module,cache=self.n.dataset_cache()
        if (cache.root!=warehouse.hot.root
                or cache._root_identity!=warehouse.hot._root_identity or cache.mount!=warehouse.hot.mount
                or cache.root==warehouse.cold.root):
            raise ValueError('Training target must be the configured separate cache')
        if cache.mount is not None and cache._current_mount()!=cache.mount:
            raise ValueError('Training target mount changed')
        with module._directory(cache.root) as fd:
            stat=os.fstat(fd)
            if (stat.st_dev,stat.st_ino)!=cache._root_identity:
                raise ValueError('Training target root changed')
        return dict(protocol='dataset-training-cache-v1',machine=self.n.CONFIG['machine'],
                    root=str(cache.root),rootIdentity=list(cache._root_identity),
                    mount=list(cache.mount) if cache.mount is not None else None)

    def target_uploads(self, spec):
        if 'targetStorage' not in spec:
            return self.n.dataset_uploads()  # Never upgrade or rebind old journals.
        if (self.load(spec['id'])!=spec or spec.get('digest')!=digest({k:spec[k] for k in
                ('userId','sourceMachine','source','name','reference','timeoutSec','archiveLane','targetStorage') if k in spec})):
            raise ValueError('Fixed training transfer target changed; no root fallback')
        bound=spec['targetStorage'];config=self.n.CONFIG['datasets']
        if (not isinstance(bound,dict) or set(bound)!={'protocol','machine','root','rootIdentity','mount'}
                or bound['protocol']!='dataset-training-cache-v1' or bound['machine']!=self.n.CONFIG.get('machine')
                or bound['root']!=config.get('root','/data2/datasets')):
            raise ValueError('Fixed training transfer target changed; no root fallback')
        # Check the original directory BEFORE factories that initialize cache
        # metadata. A missing/remounted root must never be recreated/rebound.
        module=getattr(self,'_root_guard_module',None)
        if module is None:
            definition=importlib.util.spec_from_file_location('gpuq_transfer_root_guard',self.n.HERE/'dataset-cache.py')
            module=importlib.util.module_from_spec(definition);definition.loader.exec_module(module)
            self._root_guard_module=module  # Cache code, never filesystem state.
        with module._directory(bound['root']) as fd:
            info=os.fstat(fd)
            if bound['rootIdentity']!=[info.st_dev,info.st_ino]:
                raise ValueError('Training target root changed')
        self.n.dataset_mount_check(config)
        if (bound['mount'] is not None and list(module._storage_mount(config.get('mountPoint','/data2'),bound['root']))!=bound['mount']):
            raise ValueError('Training target mount changed')
        if bound!=self.new_target_storage(spec):
            raise ValueError('Fixed training transfer target changed; no root fallback')
        uploads=self.n.dataset_training_uploads()
        if (str(uploads.cache.root)!=spec['targetStorage']['root']
                or list(uploads.cache._root_identity)!=spec['targetStorage']['rootIdentity']):
            raise ValueError('Training upload adapter root differs from its durable binding')
        return uploads

    def archive_lane(self, value, source_machine):
        # Only the authenticated internal bridge supplies this binding. Check
        # it again against the live fixed authority, not a caller boolean.
        policy = self.n.CONFIG.get('storageArchive')
        if (not isinstance(value, dict) or set(value) != {'schema', 'targetMachine', 'authority'}
                or value.get('schema') != 1 or type(value['schema']) is not int
                or not isinstance(policy, dict) or type(policy.get('enabled')) is not bool
                or policy != {'enabled': True, 'machine': value.get('targetMachine'), 'authority': value.get('authority')}
                or self.n.CONFIG.get('machine') != value['targetMachine']
                or source_machine == value['targetMachine']
                or self.n.CONFIG.get('storageAuthority') != {'enabled': True}):
            raise ValueError('Managed archive requires the fixed protected storage authority')
        archive = self.n.storage_archive()
        archive._require(source=True)
        if (archive.policy != policy or archive.machine != value['targetMachine']
                or archive.store is None or archive.store.machine != archive.machine
                or archive.store.cache.root != getattr(self.n,'dataset_source_cache',self.n.dataset_cache)()[1].root):
            raise ValueError('Managed archive authority binding changed')
        return dict(value)

    def upload(self, spec, action, **fields):
        if action not in ('begin', 'manifest', 'chunk', 'seal', 'commit'):
            # Query and cleanup remain usable after owner cancellation. They
            # never need permission to admit warehouse bytes into a cache.
            return self._upload_bound(spec, action, **fields)
        with self.target_uploads(spec)._peer_cache_preparation(spec):
            return self._upload_bound(spec, action, **fields)

    def _upload_bound(self, spec, action, **fields):
        if action == 'begin' and 'archiveLane' in spec:
            self.archive_lane(spec['archiveLane'], spec['sourceMachine'])
            return self.target_uploads(spec).begin(spec['userId'], fields, _archive_transfer=spec['id'])
        if action in ('manifest', 'chunk'):
            # These bytes were read by this node from a certificate-pinned LAN
            # peer, not relayed through the Portal. The public upload RPC keeps
            # its large-relay opt-in; no request field can select this ingress.
            # Revalidate the durable copy/session binding before every write,
            # including old ordinary-admission transfers resumed in place.
            current = self.load(spec['id'])
            if current != spec or fields.get('uploadId') != spec['id']:
                raise ValueError('LAN upload differs from its durable transfer')
            if self.path(spec['id'], '.cancel').exists():
                raise InterruptedError('Canceled by owner')
            if 'archiveLane' in spec:
                self.archive_lane(spec['archiveLane'], spec['sourceMachine'])
            uploads = self.target_uploads(spec)
            session = uploads.load(spec['userId'], fields['uploadId'])
            if (session.get('name') != spec['name'] or any(
                    session.get(k) != spec['source'][k]
                    for k in ('manifestBytes', 'manifestSha256', 'totalBytes', 'entries'))):
                raise ValueError('LAN upload differs from its admitted immutable source')
            offset, data = uploads.decoded(fields)
            return getattr(uploads, action+'_bytes')(
                spec['userId'], fields, offset, data, transport='lan-peer')
        if action in ('seal', 'commit'):
            return self.target_uploads(spec).start(spec['userId'], fields, action,
                inline_unit=self.unit(spec['id'], spec['attempt']))
        if action == 'begin':
            return self.target_uploads(spec).begin(spec['userId'], fields)
        return self.target_uploads(spec).process('datasets.upload.'+action, {'userId': spec['userId'], **fields})

    def worker(self, key, attempt, *, require_training=False):
        with self.lock(key, '.worker.lock'):
            spec = self.load(key)
            if (spec['attempt'] != attempt or self.path(key, '.started-'+str(attempt)).exists()
                    or self.path(key, '.source-release.json').exists()):
                return 1
            self.n.atomic_json(self.path(key, '.started-'+str(attempt)), {'attempt': attempt})
            client = PeerClient(self.n.CONFIG['transferPeers'][spec['sourceMachine']], spec['source'])
            client.campus_only = require_training
            started, retries, transferred, last_progress = time.monotonic(), 0, 0, 0
            result = {'state': 'FAILED', 'attempt': attempt}
            def check():
                if self.path(key, '.cancel').exists():
                    raise InterruptedError('Canceled by owner')
                if time.monotonic()-started >= spec['timeoutSec']:
                    raise TimeoutError('Transfer deadline reached')
            def report(state='RUNNING', path=None, force=False):
                nonlocal last_progress
                if force or time.monotonic()-last_progress >= 1:
                    self.n.atomic_json(self.path(key, '.progress.json'), {'attempt': attempt, 'state': state, 'bytes': transferred, 'path': path, 'at': time.time()})
                    last_progress = time.monotonic()
            def read(action, **fields):
                nonlocal retries
                for retry in range(6):
                    check()
                    try:
                        return client.call(action, **fields)
                    except (OSError, http.client.HTTPException):
                        retries += 1
                        if retry == 5:
                            raise ConnectionError('LAN network retry budget exhausted; original transfer can be resumed') from None
                        report('RETRYING', force=True)
                        for _ in range(min(30, 2**retry)*4):
                            check();time.sleep(.25)
            try:
                if 'archiveLane' in spec:
                    self.archive_lane(spec['archiveLane'], spec['sourceMachine'])
                check()
                training = None
                if not require_training and os.path.lexists(self.path(key,'.training.json')):
                    raise ValueError('Training transfer cannot use a legacy worker')
                if require_training or os.path.lexists(self.path(key, '.training.json')):
                    utility = __import__('importlib.util', fromlist=['util'])
                    definition = utility.spec_from_file_location('gpuq_training_preparation', self.n.HERE/'training-preparation.py')
                    helper = utility.module_from_spec(definition);definition.loader.exec_module(helper)
                    training = helper.transfer_binding(self.n, key)
                    if training is None:raise ValueError('Missing training receipt; no legacy worker fallback')
                info = read('info')
                if any(info[k] != spec['source'][k] for k in ('manifestBytes', 'manifestSha256', 'totalBytes', 'entries')):
                    raise ValueError('Source snapshot identity changed')
                raw = bytearray()
                while len(raw) < info['manifestBytes']:
                    response = read('manifest', offset=len(raw))
                    data = base64.b64decode(response['data'], validate=True)
                    if not data or len(data) > CHUNK or len(raw)+len(data) > info['manifestBytes']:
                        raise ValueError('Invalid source manifest chunk')
                    raw.extend(data)
                if hashlib.sha256(raw).hexdigest() != info['manifestSha256']:
                    raise ValueError('Source manifest SHA256 differs')
                manifest = self.n.dataset_cache()[0]._manifest(json.loads(raw))
                if (sum(f['size'] for f in manifest['files']) != info['totalBytes']
                        or len(manifest['files'])+len(manifest['directories']) != info['entries']):
                    raise ValueError('Source manifest totals differ')
                # Admission never reclaims caches. Existing sessions retain
                # their whole durable reservation; do
                # not count the same admitted transfer twice on resume.
                uploads=self.target_uploads(spec)
                try:prior=uploads.load(spec['userId'],key)
                except FileNotFoundError:
                    needed=info['totalBytes']+info['manifestBytes']*4+info['entries']*8192+65536
                    prior=None
                else:needed=0
                target='u-'+hashlib.sha256(spec['userId'].encode()).hexdigest()[:16]+'-'+spec['name']
                version=self.n.dataset_cache()[0]._version(manifest)
                if training is not None:
                    matches = [item for item in training['planRequest']['datasetFootprints']
                               if item['version']==spec['reference']['version'] and item['dataset'] in
                               (training['preparation']['logicalReference']['dataset'], spec['reference']['dataset'])]
                    if len(matches)!=1:raise ValueError('Ambiguous training source footprint')
                    footprint=matches[0]
                    if (footprint['bytes']!=info['totalBytes'] or footprint['manifestBytes']!=info['manifestBytes']
                            or footprint['files']!=len(manifest['files']) or footprint['directories']!=len(manifest['directories'])):
                        raise ValueError('Training fixed source footprint changed')
                    helper.admission(self.n, training, {'dataset':target,'version':version})
                if prior is None or prior['state']!='READY':
                    self.n.dataset_cache_admission(needed,_exclude=((target,version),))
                state = self.upload(spec, 'begin', name=spec['name'], key=key, **{k: info[k] for k in ('manifestBytes', 'manifestSha256', 'totalBytes', 'entries')})
                upload_id = state['uploadId'];result['uploadId'] = upload_id
                if state['state'] == 'FAILED' and state.get('resumeState') in ('RECEIVING_MANIFEST', 'UPLOADING'):
                    state = {**state, 'state': state['resumeState']}
                if state['state'] == 'FAILED' and state.get('resumeState') in ('SEALING', 'PUBLISHING'):
                    state = self.upload(spec, 'seal' if state['resumeState']=='SEALING' else 'commit', uploadId=upload_id)
                if state['state'] == 'RECEIVING_MANIFEST':
                    offset = state['manifestOffset']
                    while offset < len(raw):
                        check();part = raw[offset:offset+CHUNK]
                        reply = self.upload(spec, 'manifest', uploadId=upload_id, offset=offset, data=base64.b64encode(part).decode())
                        if reply['offset'] != offset+len(part):raise ValueError('Target manifest offset mismatch')
                        offset = reply['offset']
                    state = self.upload(spec, 'seal', uploadId=upload_id)
                while state['state'] == 'SEALING':
                    check();time.sleep(.5);state = self.upload(spec, 'status', uploadId=upload_id)
                if state['state'] not in ('UPLOADING', 'READY', 'PUBLISHING'):
                    raise ValueError('Target upload requires inspection: '+state['state'])
                if state['state'] == 'UPLOADING':
                    for entry in manifest['files']:
                        check();remote = self.upload(spec, 'status', uploadId=upload_id, path=entry['path'])['file']
                        offset = remote['offset'];transferred += offset
                        if remote['size'] != entry['size'] or remote['sha256'] != entry['sha256'] or not 0 <= offset <= entry['size']:
                            raise ValueError('Target partial file is not the same source version')
                        if entry['size'] == 0 and not remote['complete']:
                            self.upload(spec, 'chunk', uploadId=upload_id, path=entry['path'], offset=0, data='')
                        while offset < entry['size']:
                            check();reply = read('get', path=entry['path'], offset=offset);part = base64.b64decode(reply['data'], validate=True)
                            if (not part or len(part)>CHUNK or offset+len(part)>entry['size']
                                    or reply.get('size') != entry['size'] or reply.get('offset') != offset+len(part)):
                                raise ValueError('Invalid source file chunk')
                            target = self.upload(spec, 'chunk', uploadId=upload_id, path=entry['path'], offset=offset, data=reply['data'])
                            if target['offset'] != offset+len(part):raise ValueError('Target did not confirm received bytes')
                            offset = target['offset'];transferred += len(part);report(path=entry['path'])
                    check();report('VERIFYING', force=True);state = self.upload(spec, 'commit', uploadId=upload_id)
                while state['state'] in ('SEALING', 'PUBLISHING'):
                    check();report('VERIFYING');time.sleep(.5);state = self.upload(spec, 'status', uploadId=upload_id)
                if state['state'] != 'READY' or state.get('version') != spec['reference']['version']:
                    raise ValueError('Target is not READY with the pinned source content version')
                transferred = info['totalBytes'];report('VERIFYING', force=True)
                result.update(state='SUCCEEDED', dataset=state['dataset'], version=state['version'])
            except InterruptedError:
                result.update(state='CANCELED', error='Canceled; partial payload retained, never auto-restarted')
            except (OSError, http.client.HTTPException):
                result.update(state='PAUSED', error='Network or I/O interrupted; resume the same stopped transfer after inspection')
            except Exception as error:
                result.update(state='FAILED', error=str(error)[:300])
            finally:
                client.close()
                result.update(finishedAt=time.time(), retries=retries)
                self.n.atomic_json(self.path(key, '.result.json'), result)
            return 0 if result['state']=='SUCCEEDED' else 1

    def process(self, operation, args, *, training=False):
        action = operation.removeprefix('transfers.')
        if not isinstance(args, dict):raise ValueError('Invalid transfer fields')
        if action == 'capabilities':return self.capabilities(args)
        if action == 'source.prepare':return self.prepare(args)
        if action == 'confirm-source-release':return self.confirm_source_release(args)
        if action == 'release-source':return self.release_source(args)
        if action == 'confirm-unprepared-cancel':return self.confirm_unprepared_cancel(args)
        if action == 'release-unprepared-source':return self.release_unprepared_source(args)
        if action == 'source.read':
            if set(args)-{'userId','id','action','path','offset','token'}:raise ValueError('Invalid snapshot read fields')
            self.actor(args);ticket=self.load(args['id'],'.ticket.json')
            if ticket['actor']['userId'] != args['userId']:raise ValueError('Source ticket belongs to another user')
            return self.read({k:v for k,v in args.items() if k not in ('userId','token')},args.get('token'))
        if action == 'start':return self.start(args, training=True) if training else self.start(args)
        if action in ('status','cancel','resume'):
            allowed={'id','userId'}|({'source'} if action=='resume' else set())
            if set(args)-allowed or not {'id','userId'}<=set(args):raise ValueError('Invalid transfer control fields')
            if action=='resume' and training:return self.resume(args, training=True)
            return getattr(self, action)(args)
        raise ValueError('Unknown transfer operation')
