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

    def close(self):
        if self.connection:
            self.connection.close()
        self.connection = None

    def connect(self, timeout=25):
        if not self.connection or self.connection.sock is None:
            self.close()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE  # Explicit DER pin is the trust anchor.
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            connection = http.client.HTTPSConnection(self.config['address'], self.config['port'], timeout=timeout, context=context)
            try:
                connection.connect()
                if not hmac.compare_digest(hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest(), self.config['certificateSha256']):
                    raise ValueError('LAN peer certificate differs from configured pin')
            except Exception:
                connection.close()
                raise
            self.connection = connection

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
            if len(raw) > 1500000:
                raise ValueError('Peer response is too large')
            value = json.loads(raw)
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

    def source(self, ref, actor, action, *, _transfer_lease=None, **fields):
        return self.snapshots().export('datasets.snapshot.'+action,
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
        self.snapshots().require_transfer_lease(self.lease_args(journal), key, journal['leaseId'])
        lease = (key, journal['leaseId'])
        info = self.source(ticket['reference'], ticket['actor'], 'info', _transfer_lease=lease)
        if info != ticket['info']:
            raise ValueError('Fixed source snapshot changed')
        return info if action == 'info' else self.source(ticket['reference'], ticket['actor'], action, _transfer_lease=lease, **fields)

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
        state = ('CANCELING' if canceled else progress.get('state', 'RUNNING')) if active is True else (
            result.get('state', 'CANCELED' if canceled else stopped) if active is False else 'UNKNOWN')
        if active is True and state in TERMINAL:
            state = 'VERIFYING'
        return {'id': spec['id'], 'state': state, 'attempt': spec['attempt'], 'route': 'lan',
            'bytes': progress.get('bytes', 0), 'totalBytes': spec['source']['totalBytes'],
            'path': progress.get('path'), 'createdAt': spec['createdAt'], 'checkedAt': time.time(),
            'error': result.get('error'), 'retries': result.get('retries',0),
            **{k: v for k, v in result.items() if k in ('dataset', 'version', 'uploadId')}}

    def launch(self, spec):
        self.n.atomic_json(self.path(spec['id']), spec)  # Attempt marker precedes launch.
        try:
            self.n.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit='+self.unit(spec['id'], spec['attempt']),
                '--property=Type=exec', '--property=KillMode=control-group', '--property=UMask=0077',
                '--property=CPUQuota=200%', '--property=MemoryMax=2G', '--property=TasksMax=128',
                '--property=RuntimeMaxSec='+str(spec['timeoutSec']+10), '--property=TimeoutStopSec=5',
                '/usr/bin/python3', str(self.n.HERE/'node-executor.py'), '--transfer-worker', spec['id'], str(spec['attempt'])], timeout=8)
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

    def start(self, args):
        if set(args)-{'id', 'userId', 'username', 'sourceMachine', 'source', 'reference', 'name', 'timeoutSec'}:
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
        with self.lock(key):
            if self.path(key, '.source-release.json').exists():
                raise ValueError('Source transfer was finalized; use a new transfer ID')
            if self.path(key, '.cancel').exists():
                raise ValueError('Transfer ID was canceled before dispatch; it cannot start')
            try:
                spec = self.load(key)
                if spec['digest'] != digest(payload):
                    raise ValueError('Transfer ID cannot change source or target')
            except FileNotFoundError:
                if len(list(self.root.glob('*.json'))) >= 40000:
                    raise ValueError('Transfer history is full')
                # One service-user admission guard; no unbounded background fanout.
                with self.lock('00000000-0000-0000-0000-000000000000', '.admission.lock'):
                    spec = {**payload, 'id': key, 'digest': digest(payload), 'attempt': 1, 'createdAt': time.time()}
                    self.admit(spec)
                    self.launch(spec)
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
            except (OSError, subprocess.SubprocessError):
                pass
            return self.status(args)

    def resume(self, args):
        with self.lock(args['id']):
            spec = self.owned(args)
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
                spec['digest']=digest({k:spec[k] for k in ('userId','sourceMachine','source','name','reference','timeoutSec')})
            with self.lock('00000000-0000-0000-0000-000000000000', '.admission.lock'):
                self.admit(spec)
                spec['attempt'] += 1
                self.launch(spec)
            return self.status(args)

    def upload(self, spec, action, **fields):
        if action in ('seal', 'commit'):
            return self.n.dataset_uploads().start(spec['userId'], fields, action,
                inline_unit=self.unit(spec['id'], spec['attempt']))
        return self.n.dataset_uploads().process('datasets.upload.'+action, {'userId': spec['userId'], **fields})

    def worker(self, key, attempt):
        with self.lock(key, '.worker.lock'):
            spec = self.load(key)
            if (spec['attempt'] != attempt or self.path(key, '.started-'+str(attempt)).exists()
                    or self.path(key, '.source-release.json').exists()):
                return 1
            self.n.atomic_json(self.path(key, '.started-'+str(attempt)), {'attempt': attempt})
            client = PeerClient(self.n.CONFIG['transferPeers'][spec['sourceMachine']], spec['source'])
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
                check()
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

    def process(self, operation, args):
        action = operation.removeprefix('transfers.')
        if not isinstance(args, dict):raise ValueError('Invalid transfer fields')
        if action == 'capabilities':return self.capabilities(args)
        if action == 'source.prepare':return self.prepare(args)
        if action == 'confirm-source-release':return self.confirm_source_release(args)
        if action == 'release-source':return self.release_source(args)
        if action == 'source.read':
            if set(args)-{'userId','id','action','path','offset','token'}:raise ValueError('Invalid snapshot read fields')
            self.actor(args);ticket=self.load(args['id'],'.ticket.json')
            if ticket['actor']['userId'] != args['userId']:raise ValueError('Source ticket belongs to another user')
            return self.read({k:v for k,v in args.items() if k not in ('userId','token')},args.get('token'))
        if action == 'start':return self.start(args)
        if action in ('status','cancel','resume'):
            allowed={'id','userId'}|({'source'} if action=='resume' else set())
            if set(args)-allowed or not {'id','userId'}<=set(args):raise ValueError('Invalid transfer control fields')
            return getattr(self, action)(args)
        raise ValueError('Unknown transfer operation')
