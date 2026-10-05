"""Private publish outbox and fixed-HDD archive control-plane adapter.

The executor MUST expose these methods only on its authenticated INTERNAL bridge.
User identity is supplied by that bridge, never a public role/hostAdmin flag.
No payload copier, listener, GC switch, dataset scan, or authority decommission
is implemented here. Existing transfers copy bytes; AuthorityStore seals in a
bounded worker; RemoteAuthority and DatasetTier authenticate/certify recovery.
Grants are private node journal data and private RPC results, not browser data.
"""
import importlib.util
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import time

_spec = importlib.util.spec_from_file_location('gpuq_archive_authority', Path(__file__).with_name('storage-authority.py'))
A = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(A)
D, J = A.D, A.J
MAX_HISTORY = 10000


def _object(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError('Unrecognized private archive request fields')
    return value


def _user(value):
    if not isinstance(value, str) or not J.USER.fullmatch(value):
        raise ValueError('An immutable portal user ID is required')
    return value


def _ref(value):
    _object(value, ('dataset', 'version'))
    D._identifier(value['dataset']); D._identifier(value['version'], D.HASH_RE)
    return dict(value)


def policy(value):
    if value is None:
        return {'enabled': False}
    if (not isinstance(value, dict) or set(value)-{'enabled', 'machine', 'authority'}
            or type(value.get('enabled')) is not bool):
        raise ValueError('Invalid trusted archive configuration')
    if not value['enabled']:
        return {'enabled': False}
    _object(value, ('enabled', 'machine', 'authority'))
    A._machine(value['machine']); D._identifier(value['authority'])
    return dict(value)


class StorageArchive:
    @classmethod
    def from_executor(cls, executor):
        return cls(executor)

    def __init__(self, executor):
        self.n = executor
        self.policy = policy(executor.CONFIG.get('storageArchive'))
        self.enabled = self.policy['enabled']
        # Default-off construction must not initialize a cache or private tree.
        if not self.enabled:
            return
        self.machine = A._machine(executor.CONFIG.get('machine'))
        self.d, self.cache = executor.dataset_cache()
        self.admin = self.d.Principal('builtin-admin', True)
        self.root = A._private_root(executor.ROOT/'storage-archive')
        for name in ('operations', 'events', 'references', 'control'):
            A._private_root(self.root/name)
        for name in ('lane', 'outbox'):
            A._private_root(self.root/'control'/name)
        self.binding = dict(policy=self.policy, machine=self.machine,
                            rootIdentity=list(self.cache._root_identity))
        self.source = self.machine == self.policy['machine']
        self.store = None; self.tier = None; self.remote = None
        if self.source:
            if executor.CONFIG.get('storageAuthority') != {'enabled': True}:
                raise ValueError('Archive source requires the configured protected authority')
            self.store = executor.storage_authority()
            if self.store is None or self.store.machine != self.machine or self.store.cache.root != self.cache.root:
                raise ValueError('Archive source authority does not match the configured cache')
        else:
            mapping = executor.CONFIG.get('storageAuthorities', {}).get(self.policy['authority'])
            peer = executor.CONFIG.get('transferPeers', {}).get(self.policy['machine'])
            if mapping != {'machine': self.policy['machine']} or not isinstance(peer, dict):
                raise ValueError('Archive target requires a fixed configured authority peer')
            J.PeerClient(peer, {}).close()  # Validate the administrator's address/pin.
            self.tier = executor.storage_node().tier
            self.remote = self.tier.authorities.get(self.policy['authority'])
            if (self.remote is None or self.remote.machine != self.policy['machine']
                    or self.remote.target_machine != self.machine or self.remote.peer != peer
                    or self.tier.cache.root != self.cache.root):
                raise ValueError('Archive recovery adapter does not match trusted configuration')

    def _require(self, source=None):
        if not self.enabled:
            raise ValueError('Automatic archive is disabled')
        if source is not None and self.source is not source:
            raise ValueError('Archive operation is not available on this configured machine')

    def _lock(self, name):
        # Avoid the macOS first-open O_CREAT|O_NOFOLLOW race while retaining
        # DatasetCache's full live-mount/root guard and bounded flock timeout.
        if self.cache.mount is not None and self.cache._current_mount() != self.cache.mount:
            raise ValueError('Archive cache mount changed')
        with self.d._directory(self.cache.root) as root, self.d._directory(self.cache.root/'.locks') as parent:
            info = os.fstat(root)
            if ((info.st_dev, info.st_ino) != self.cache._root_identity
                    or os.fstat(parent).st_dev != info.st_dev
                    or self.cache.mount is not None and info.st_dev != self.cache.mount[2]):
                raise ValueError('Archive cache lock root changed')
            try:
                fd = os.open('archive-'+name+'.lock', os.O_CREAT|os.O_EXCL|os.O_RDWR, 0o600, dir_fd=parent)
            except FileExistsError:
                pass
            else:
                os.close(fd)
        return self.cache._lock_file('.locks/archive-'+name+'.lock')

    def _load(self, path):
        try:
            return A._load(path)
        except FileNotFoundError:
            return None

    def _save(self, path, value):
        if len(D._json_bytes(value)) > 65536:
            raise ValueError('Archive journal exceeds private metadata bound')
        self.d._write_json(path, value)

    def _ids(self, folder):
        # Enumerate only our bounded intent journal, never datasets or payloads.
        result = []
        with self.d._directory(folder) as fd:
            for name in os.listdir(fd):
                if name.startswith('.write-'):
                    continue
                if not name.endswith('.json'):
                    raise ValueError('Unknown archive journal entry')
                result.append(J.identifier(name[:-5]))
                if len(result) > MAX_HISTORY:
                    raise ValueError('Archive history requires operator reconciliation')
        return sorted(result)

    def _single_locked(self, user, ref, *, ready=False, protected=False, missing=False):
        try:
            owners = self.cache._dataset(self.admin, ref['dataset'])['owners']
        except FileNotFoundError:
            if missing:
                return None
            raise
        if owners != [user]:
            raise PermissionError('Automatic archive requires exactly the fixed single owner')
        try:
            identity = list(self.cache._record_identity(ref['dataset'], ref['version']))
        except FileNotFoundError:
            if missing:
                return None
            raise
        if ready:
            record = self.cache._record(self.admin, ref['dataset'], ref['version'])
            if not self.cache._ready(self.cache._paths(**ref), record['manifest'], ref['version']):
                raise ValueError('Archive reference is not READY')
        if protected and self.cache._tier(**ref)['role'] != 'protected':
            raise ValueError('Archive source must be a protected original, never a cache')
        return identity

    def _single(self, user, ref, **options):
        with self.cache._locked():
            return self._single_locked(user, ref, **options)

    def _registration_binding(self, user, ref, identity):
        return A._sha(dict(binding=self.binding, userId=user, reference=ref, registration=identity))

    def _expected_registration(self, args, user, ref, identity):
        if 'expectedRegistration' not in args:
            return None
        expected = D._identifier(args['expectedRegistration'], D.HASH_RE)
        with self.cache._locked():
            if (self._single_locked(user, ref) != identity
                    or expected != self._registration_binding(user, ref, identity)):
                raise ValueError('Explicit archive enrollment registration changed')
            if self.cache._version_entry_exists(self.cache._paths(**ref)['.staging']):
                raise ValueError('Archive enrollment refuses an active or unknown staging writer')
        return expected

    def enrollment_check(self, args):
        """Exact metadata-only probe; never enumerate data or create an outbox event.

        Full payload hashing remains in the bounded authority seal worker. A
        READY tree is immutable; an overlapping staging writer is not adopted.
        """
        self._require()
        _object(args, ('userId', 'dataset', 'version'))
        user = _user(args['userId']); ref = _ref({k: args[k] for k in ('dataset', 'version')})
        with self.cache._locked():
            identity = self._single_locked(user, ref, ready=True, protected=True)
            paths = self.cache._paths(**ref)
            if self.cache._version_entry_exists(paths['.staging']):
                raise ValueError('Archive enrollment refuses an active or unknown staging writer')
            if not self.source and self.cache._tier(**ref)['pins']:
                raise ValueError('Pinned originals cannot be enrolled as disposable caches')
            record = self.cache._record(self.admin, **ref)
            raw = D._json_bytes(record['manifest'])
            if len(raw) > A.MAX_MANIFEST or hashlib.sha256(raw).hexdigest() != ref['version']:
                raise ValueError('Archive enrollment manifest is not the complete fixed version')
            return dict(protocol=1, machine=self.machine, userId=user, **ref,
                        state='READY', role='protected', manifestSha256=ref['version'],
                        manifestBytes=len(raw), registration=self._registration_binding(user, ref, identity))

    def _op_path(self, op):
        return self.root/'operations'/J.identifier(op)/'journal.json'

    def _digest(self, kind, request):
        peer_machine = request.get('targetMachine', self.policy['machine'])
        return A._sha({'kind': kind, 'request': request, 'binding': self.binding,
                      'peer': self.n.CONFIG.get('transferPeers', {}).get(peer_machine)})

    def _operation(self, kind, request, identity):
        op = request['opId']; path = self._op_path(op)
        # Caller holds admission lock, then this operation's short journal lock.
        existing = self._load(path)
        digest = self._digest(kind, request)
        if existing is not None:
            if existing.get('schema') != 1 or existing.get('digest') != digest or existing.get('kind') != kind:
                raise ValueError('Archive operation ID cannot be reused for another request')
            if existing['registration'] != identity:
                raise ValueError('Archive registration changed since the operation began')
            return existing
        with self.d._directory(self.root/'operations') as fd:
            if len(os.listdir(fd)) >= MAX_HISTORY:
                raise ValueError('Archive operation history is full')
        A._private_root(path.parent)
        row = dict(schema=1, kind=kind, digest=digest, binding=self.binding, request=request, registration=identity,
                   state='PENDING', attempts=0, createdAt=time.time())
        self._save(path, row)
        return row

    @staticmethod
    def unit(op):
        return 'gpuq-storage-archive-'+J.identifier(op)+'.service'

    def worker_state(self, op):
        """UNKNOWN is not stopped and cannot free the single seal lane."""
        try:
            result = subprocess.run(['/usr/bin/systemctl', '--user', 'show', self.unit(op),
                '--property=LoadState,ActiveState,SubState,MainPID,ControlPID'], env=self.n.ENV,
                text=True, capture_output=True, timeout=4)
            values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
            stopped = values.get('MainPID') == '0' and values.get('ControlPID') == '0'
            if values.get('LoadState') == 'not-found' and values.get('ActiveState') == 'inactive' and stopped:
                return 'STOPPED'
            if result.returncode != 0:
                return 'UNKNOWN'
            if values.get('ActiveState') in ('inactive', 'failed') and stopped:
                return 'STOPPED'
            if values.get('ActiveState') in ('active', 'activating', 'deactivating', 'reloading'):
                return 'RUNNING'
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        return 'UNKNOWN'

    def spawn(self, op):
        self.n.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit='+self.unit(op),
            '--property=KillMode=control-group', '--property=UMask=0077',
            '--property=CPUQuota=100%', '--property=MemoryMax=2G', '--property=IOWeight=10',
            '--property=RuntimeMaxSec=86400', '--property=TimeoutStopSec=20',
            '/usr/bin/python3', str(self.n.HERE/'node-executor.py'), '--storage-archive-worker', op], timeout=8)

    def _grant(self, row):
        request = row['request']; ref = request['source']; grant = row['grant']
        if row['digest'] != self._digest('provision', request):
            raise ValueError('Prepared authority policy or peer configuration changed')
        A._validate_grant(grant, self.machine, request['targetMachine'])
        if (grant['id'] != request['opId'] or grant['dataset'] != ref['dataset']
                or grant['version'] != ref['version'] or grant['receipt']['owners'] != [request['userId']]
                or self._single(request['userId'], ref, ready=True, protected=True) != row['registration']):
            raise ValueError('Prepared authority no longer matches the fixed operation')
        receipt = self.store.read(dict(id=grant['id'], action='guard', **ref,
                                      targetMachine=grant['targetMachine']), grant['token'])
        if receipt != grant['receipt']:
            raise ValueError('Prepared authority receipt changed')
        return grant

    def provision(self, args):
        self._require(source=True)
        if not isinstance(args, dict) or set(args)-{'opId', 'userId', 'source', 'targetMachine', 'retry', 'expectedRegistration'}:
            raise ValueError('Unrecognized private archive provision fields')
        _object({k: v for k, v in args.items() if k not in ('retry', 'expectedRegistration')}, ('opId', 'userId', 'source', 'targetMachine'))
        retry = args.get('retry', False)
        if type(retry) is not bool:
            raise ValueError('Archive retry must be boolean')
        op = J.identifier(args['opId']); user = _user(args['userId']); ref = _ref(args['source'])
        target = A._machine(args['targetMachine'])
        peer = self.n.CONFIG.get('transferPeers', {}).get(target)
        if target == self.machine or not isinstance(peer, dict):
            raise ValueError('Archive target is not a fixed configured peer')
        J.PeerClient(peer, {}).close()
        request = dict(opId=op, userId=user, source=ref, targetMachine=target)
        identity = self._single(user, ref, ready=True, protected=True)
        # A precondition, not a new grant identity: a previously sealed grant
        # for this same registration must remain reusable by explicit adoption.
        # _operation durably binds the checked identity before worker dispatch.
        self._expected_registration(args, user, ref, identity)
        with self._lock('admission'):
            with self._lock('op-'+op):
                row = self._operation('provision', request, identity)
                if row['state'] == 'READY':
                    return dict(opId=op, state='READY', grant=self._grant(row))
                if row['state'] == 'FAILED' and not retry:
                    return dict(opId=op, state='FAILED' if self.worker_state(op) == 'STOPPED' else 'UNKNOWN')
                # Ambiguous launch/crash is deliberately not automatically
                # retried, even if a later process probe happens to be stopped.
                if row['state'] == 'UNKNOWN':
                    return dict(opId=op, state='UNKNOWN')
                lane_path = self.root/'control'/'lane'/'state.json'; lane = self._load(lane_path)
                if lane is not None:
                    previous = J.identifier(lane['opId'])
                    old = row if previous == op else self._load(self._op_path(previous))
                    # A not-found unit after an ambiguous dispatch is not a
                    # proof that the pending systemd call can never start it.
                    # Retain the lane until the same worker writes a definite
                    # terminal journal, or private operator reconciliation.
                    if old is None or old.get('state') == 'UNKNOWN':
                        return dict(opId=op, state='UNKNOWN')
                    status = self.worker_state(previous)
                    if status != 'STOPPED':
                        return dict(opId=op, state='PROVISIONING' if previous == op and status == 'RUNNING' else 'UNKNOWN')
                    if previous != op and old.get('state') not in ('READY', 'FAILED'):
                        return dict(opId=op, state='UNKNOWN')
                if row['state'] == 'PROVISIONING':
                    row['state'] = 'UNKNOWN'; self._save(self._op_path(op), row)
                    return dict(opId=op, state='UNKNOWN')
                if row['state'] == 'FAILED' and self.worker_state(op) != 'STOPPED':
                    return dict(opId=op, state='UNKNOWN')
                # Both intent and lane are durable before a possibly ambiguous
                # systemd dispatch. A retry never changes the grant or unit ID.
                self._save(lane_path, {'opId': op})
                row.update(state='PROVISIONING', attempts=row['attempts']+1)
                self._save(self._op_path(op), row)
                try:
                    self.spawn(op)
                except Exception:
                    row['state'] = 'UNKNOWN'
                    self._save(self._op_path(op), row)
                return dict(opId=op, state=row['state'])

    def worker(self, op):
        self._require(source=True); J.identifier(op)
        with self._lock('admission'):
            lane = self._load(self.root/'control'/'lane'/'state.json')
            if lane != {'opId': op}:
                raise ValueError('Archive worker does not own the fixed seal lane')
        # Distinct long worker lock: status polling never waits for full hashing.
        with self._lock('run-'+op):
            with self._lock('op-'+op):
                row = self._load(self._op_path(op))
                if row is None or row['kind'] != 'provision':
                    raise ValueError('No durable archive provision intent')
                if row.get('binding') != self.binding:
                    raise ValueError('Trusted archive policy changed; reconciliation required')
                if row['digest'] != self._digest('provision', row['request']):
                    raise ValueError('Trusted archive peer changed; reconciliation required')
                if row['state'] == 'READY':
                    self._grant(row); return 0
                request = row['request']; ref = request['source']
            try:
                if self._single(request['userId'], ref, ready=True, protected=True) != row['registration']:
                    raise ValueError('Archive original changed before sealing')
                grant = self.store.seal(self.admin, ref['dataset'], ref['version'], op, request['targetMachine'])
                row['grant'] = grant
                self._grant(row)
                row['state'] = 'READY'
            except Exception:
                # This might follow a durable seal/pin. Preserve all private
                # state; no expiry, new op ID, unpin, or guessed cleanup.
                row['state'] = 'FAILED'
            with self._lock('op-'+op):
                self._save(self._op_path(op), row)
            return 0 if row['state'] == 'READY' else 1

    def certify(self, args):
        self._require(source=False)
        if not isinstance(args, dict) or type(args.get('retry', False)) is not bool:
            raise ValueError('Invalid private archive certify request')
        _object({k: v for k, v in args.items() if k not in ('retry', 'expectedRegistration')}, ('opId', 'userId', 'target', 'grant'))
        op = J.identifier(args['opId']); user = _user(args['userId']); ref = _ref(args['target'])
        grant = A._validate_grant(args['grant'], self.policy['machine'], self.machine)
        if grant['version'] != ref['version'] or grant['receipt']['owners'] != [user]:
            raise ValueError('Grant does not certify this fixed version and single owner')
        request = dict(opId=op, userId=user, target=ref, grant=grant)
        identity = self._single(user, ref)
        self._expected_registration(args, user, ref, identity)
        with self._lock('admission'):
            with self._lock('op-'+op):
                row = self._operation('certify', request, identity)
        with self._lock('op-'+op):
            row = self._load(self._op_path(op))
            with self.cache._locked():
                self._single_locked(user, ref, ready=row['state'] != 'READY')
            if row['state'] != 'READY':
                self.remote.install_grant(grant)
                self.tier.verify_authority(self.admin, ref['dataset'], ref['version'],
                                           self.policy['authority'], grant['dataset'])
            with self.cache._locked():
                if self._single_locked(user, ref) != row['registration']:
                    raise ValueError('Target registration changed during certification')
                receipt = self.tier._receipt(self.admin, self.cache._tier(**ref), **ref)
                if (receipt['authorityId'] != self.policy['authority']
                        or receipt['proof'] != self.remote._proof(grant)):
                    raise ValueError('Target recovery receipt differs from this fixed grant')
                receipt_sha = A._sha(receipt)
            row.update(state='READY', receiptSha256=receipt_sha)
            self._save(self._op_path(op), row)
            return dict(opId=op, state='READY', **ref, role='cache', receiptSha256=receipt_sha)

    def original(self, args):
        self._require(source=True)
        _object(args, ('userId', 'dataset', 'version')); user = _user(args['userId'])
        ref = _ref({key: args[key] for key in ('dataset', 'version')})
        self._single(user, ref, ready=True, protected=True)
        return dict(protected=True, **ref)

    def retire(self, args):
        """Retire only a never-dispatched, same-HDD publish after normal removal.

        No discovery, data deletion, unpin, authority release or lane mutation.
        A committed removal preserves the actual old registration inode. Missing
        live files alone are never proof; existing operation journals fail closed.
        """
        self._require(source=True)
        _object(args, ('id', 'userId', 'dataset', 'version', 'recoveryId', 'grantId', 'certifyId'))
        op = J.identifier(args['id']); user = _user(args['userId'])
        ref = _ref({k: args[k] for k in ('dataset', 'version')})
        recovery = args['recoveryId']
        if not isinstance(recovery, str) or not re.fullmatch(r'unregister-[a-f0-9]{32}', recovery):
            raise ValueError('An exact normal unregister recovery receipt is required')
        grant, certify = J.identifier(args['grantId']), J.identifier(args['certifyId'])
        digest = A._sha([user, self.machine, ref['dataset'], ref['version'], self.machine])
        expected = digest[:8]+'-'+digest[8:12]+'-5'+digest[13:16]+'-a'+digest[17:20]+'-'+digest[20:32]
        if grant != expected or len({op, grant, certify}) != 3:
            raise ValueError('Retirement is not the fixed same-HDD ingest identity')
        request = A._sha(args)
        with self._lock('outbox'), self._lock('admission'), contextlib.ExitStack() as locks:
            for job in sorted((grant, certify)):
                locks.enter_context(self._lock('run-'+job))
                locks.enter_context(self._lock('op-'+job))
            row = self._load(self._event_path(op))
            if row is None or row.get('id') != op or row.get('userId') != user or row.get('reference') != ref:
                raise ValueError('Retirement does not match the exact publish event')
            self._event_binding(row)
            if row.get('state') == 'RETIRED':
                if row.get('retirement', {}).get('request') != request:
                    raise ValueError('Retirement receipt cannot be changed')
                return dict(protocol=1, id=op, userId=user, **ref, recoveryId=recovery,
                            state='RETIRED', neverDispatched=True, proofSha256=row['retirement']['proofSha256'])
            identity = row.get('registration')
            if (row.get('state') != 'READY' or not isinstance(identity, list) or len(identity) != 5
                    or any(type(n) is not int or n < 0 for n in identity)):
                raise ValueError('Retirement requires a fixed READY registration')
            for job in (grant, certify):
                if os.path.lexists(self._op_path(job).parent) or self.worker_state(job) != 'STOPPED':
                    raise ValueError('Existing or unconfirmed archive operation cannot be retired')
            lane = self._load(self.root/'control'/'lane'/'state.json')
            if lane is not None and lane.get('opId') in (grant, certify):
                raise ValueError('Retirement refuses a native archive lane')
            locks.enter_context(self.cache._lock_file('.locks/'+ref['dataset']+'.'+ref['version']+'.lock'))
            with self.cache._locked():
                paths = self.cache._paths(**ref)
                try:
                    self.cache._record_identity(**ref)
                except FileNotFoundError:
                    pass
                else:
                    raise ValueError('Reference is still registered or has been recreated')
                if (any(self.cache._version_entry_exists(paths[k]) for k in ('ready', '.staging'))
                        or self.cache._leases(**ref) or self.cache._tier(**ref)['pins']
                        or self.cache._tier(**ref).get('recovery') is not None):
                    raise ValueError('Live data, leases, pins or recovery prevent retirement')
                folder = self.cache.root/'.trash'/recovery
                removal = D._read_json(folder/'REMOVAL.json')
                if (removal.get('schema') != D.SCHEMA or removal.get('unregistered') is not True
                        or removal.get('dataset') != ref['dataset'] or removal.get('version') not in (None, ref['version'])
                        or ref['version'] not in removal.get('versions', []) or removal.get('owners') != [user]):
                    raise ValueError('Normal unregister receipt does not prove this owner/version was removed')
                record_path = folder/'registration'/(ref['version']+'.json')
                with D._directory(record_path.parent) as parent:
                    fd = os.open(record_path.name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
                    try:
                        stamp = list(D._stamp(D._regular(fd)))
                        # rename changes ctime; inode, length and mtime survive.
                        if stamp[:4] != identity[:4]:
                            raise ValueError('Removed registration is not the original publish identity')
                    finally:
                        os.close(fd)
                record = D._read_json(record_path)
                owners = D._read_json(folder/'registration'/'dataset.json')
                if (owners.get('owners') != [user] or not isinstance(record, dict)
                        or set(record) != {'schema','manifest','sourceId'} or record.get('schema') != D.SCHEMA
                        or hashlib.sha256(D._manifest_bytes(record['manifest'])[1]).hexdigest() != ref['version']):
                    raise ValueError('Removed registration owner or complete manifest differs')
                proof = A._sha(dict(request=args, registration=identity, removal=removal, record=record))
                row.update(state='RETIRED', retirement=dict(request=request, proofSha256=proof, at=time.time()))
                self._save(self._event_path(op), row)
            return dict(protocol=1, id=op, userId=user, **ref, recoveryId=recovery,
                        state='RETIRED', neverDispatched=True, proofSha256=proof)

    def _event_path(self, op):
        return self.root/'events'/(J.identifier(op)+'.json')

    def outbox_begin(self, args):
        self._require()
        _object(args, ('opId', 'userId', 'reference', 'origin'))
        op = J.identifier(args['opId']); user = _user(args['userId']); ref = _ref(args['reference'])
        if args['origin'] not in ('upload', 'workspace'):
            raise ValueError('Only new upload/workspace publications create archive intents')
        with self._lock('outbox'):
            identity = self._single(user, ref, missing=True)
            prior = self._load(self._event_path(op))
            if prior is not None:
                self._event_binding(prior)
                if prior.get('state') == 'RETIRED':
                    raise ValueError('Retired publish intent cannot be restarted')
                if (prior['userId'], prior['reference'], prior['origin']) != (user, ref, args['origin']):
                    raise ValueError('Publish intent ID cannot change its owner/reference/origin')
                if prior['registration'] is not None and prior['registration'] != identity:
                    raise ValueError('Publish intent registration changed')
                return {'id': op}
            index = self.root/'references'/(A._sha([user, ref])+'.json')
            link = self._load(index)
            if link is not None:
                old = self._load(self._event_path(link['id']))
                if old is None:
                    raise ValueError('Publish intent deduplication record is missing')
                self._event_binding(old)
                if old.get('state') != 'RETIRED' and (old['registration'] == identity or old['registration'] is None):
                    return {'id': old['id']}
            if len(self._ids(self.root/'events')) >= MAX_HISTORY:
                raise ValueError('Archive publish history is full')
            row = dict(schema=1, id=op, binding=self.binding, userId=user, reference=ref, origin=args['origin'],
                       registration=identity, state='PUBLISHING', createdAt=time.time())
            self._save(self._event_path(op), row)
            self._save(index, {'id': op})
            return {'id': op}

    def _event_binding(self, row):
        if row.get('schema') != 1 or row.get('binding') != self.binding:
            raise ValueError('Publish intent archive policy changed')

    def _ready_event(self, row):
        self._event_binding(row)
        if row.get('state') not in ('PUBLISHING', 'READY'):
            raise ValueError('Publish event is not eligible for READY')
        # READY is a durable publish event, not a new full manifest poll. After
        # certification the payload may already be evicted before ack arrives.
        identity = self._single(row['userId'], row['reference'], ready=row['state'] == 'PUBLISHING')
        if row['registration'] is not None and row['registration'] != identity:
            raise ValueError('Publish intent registration changed before READY')
        if row['state'] == 'PUBLISHING':
            row.update(registration=identity, state='READY')
            self._save(self._event_path(row['id']), row)
        return row

    def outbox_ready(self, args):
        self._require(); _object(args, ('opId', 'userId'))
        op = J.identifier(args['opId']); user = _user(args['userId'])
        with self._lock('outbox'):
            row = self._load(self._event_path(op))
            if row is None or row['userId'] != user:
                raise PermissionError('No matching private publish intent')
            self._event_binding(row)
            if row['state'] not in ('ACKNOWLEDGED', 'RETIRED'):
                self._ready_event(row)
            return dict(id=op, state=row['state'])

    def outbox_list(self, args):
        if not isinstance(args, dict) or set(args)-{'limit', 'cursor'}:
            raise ValueError('Invalid archive event query')
        limit = args.get('limit', 8)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('Archive event limit must be between 1 and 100')
        cursor = args.get('cursor')
        if cursor is not None:
            J.identifier(cursor)
        if not self.enabled:
            return {'events': []}
        with self._lock('outbox'):
            cursor_path = self.root/'control'/'outbox'/'cursor.json'
            saved = self._load(cursor_path)
            cursor = cursor or (saved['id'] if saved else '')
            ids = self._ids(self.root/'events')
            ids = [op for op in ids if op > cursor]+[op for op in ids if op <= cursor]
            events = []; last = None
            # Fair rotation bounds work even for broken/unready old intents.
            for op in ids[:max(32, limit*4)]:
                last = op; row = self._load(self._event_path(op))
                if row['state'] in ('ACKNOWLEDGED', 'RETIRED'):
                    continue
                try:
                    row = self._ready_event(row)
                except (OSError, ValueError, PermissionError):
                    continue
                events.append(dict(id=op, userId=row['userId'], **row['reference'], state='READY'))
                if len(events) == limit:
                    break
            if last is not None:
                self._save(cursor_path, {'id': last})
            return {'events': events}

    def outbox_ack(self, args):
        self._require(); _object(args, ('id', 'userId', 'dataset', 'version'))
        op = J.identifier(args['id']); user = _user(args['userId'])
        ref = _ref({key: args[key] for key in ('dataset', 'version')})
        with self._lock('outbox'):
            row = self._load(self._event_path(op))
            if (row is None or row['userId'] != user or row['reference'] != ref
                    or row['state'] not in ('READY', 'ACKNOWLEDGED')):
                raise ValueError('Archive acknowledgement does not match a READY intent')
            self._event_binding(row)
            # Payload may already have been evicted AFTER certification. Keep
            # registration/ACL fencing, but never require READY to acknowledge.
            if self._single(user, ref) != row['registration']:
                raise ValueError('Archive acknowledgement registration changed')
            if row['state'] != 'ACKNOWLEDGED':
                row['state'] = 'ACKNOWLEDGED'; self._save(self._event_path(op), row)
            return {'id': op, 'acknowledged': True}
