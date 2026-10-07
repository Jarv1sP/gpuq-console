#!/usr/bin/python3
"""Authenticated personal dataset uploads; no user-supplied host paths.

Large manifests are separately streamed and sealed in a bounded worker. The
immutable SQLite path index keeps chunk requests independent of manifest size.
Only cache.publish can make a version READY; upload receipts are not readiness.
"""
import base64
from contextlib import closing, contextmanager
from contextvars import ContextVar
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import time
import uuid

NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}\Z')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
TRANSIENT = {'SEALING': 'RECEIVING_MANIFEST', 'PUBLISHING': 'UPLOADING', 'DISCARDING': 'DISCARDING'}
DEFAULTS = {'maxUploadBytes': 1024**4, 'maxUserBytes': 2*1024**4,
            'maxUserUploads': 256, 'maxActiveUploads': 4, 'maxUserSessions': 1024,
            'maxUserEntries': 2000000}
RELAY_LIMIT_BYTES = 256*1024**2
MAX_ACTIVE_ARCHIVES = 4  # Independent admission, never an unbounded bypass.


DIRECT_FILE_CHUNK_BYTES = 16 * 1024 * 1024
_CACHE_PREPARATION = ContextVar('dataset_upload_cache_preparation', default=None)


class DatasetUploads:
    def __init__(self, executor):
        self.n = executor
        self.d, self.cache = executor.dataset_cache()
        configured = executor.CONFIG['datasets'].get('uploads', {})
        if (not isinstance(configured, dict) or set(configured)-set(DEFAULTS)
                or any(type(v) is not int or not (0 if k == 'maxUserBytes' else 1) <= v <= 2**63-1
                       for k, v in configured.items())):
            raise ValueError('Invalid personal dataset upload limits')
        self.limits = {**DEFAULTS, **configured}
        self.root = self.cache.root/'.uploads'
        self.d._mkdir(self.root)
        self.d._mkdir(self.root/'bindings')

    def cache_only(self):
        # Existing trusted node policy, never a public request option. Members
        # and administrators share the same dataset ingress boundary.
        return self.n.CONFIG.get('storageTier', {}).get('enabled') is True

    def require_public_ingress(self):
        if self.cache_only():
            raise PermissionError('Dataset originals must be uploaded to the HDD warehouse; this node only prepares training caches')

    def require_ingress(self, user, upload, session=None):
        if not self.cache_only():
            return
        scope = _CACHE_PREPARATION.get()
        if scope is None or scope[0] is not self or scope[1]['userId'] != user or scope[1]['id'] != upload:
            self.require_public_ingress()
        spec, validate = scope[1], scope[2]
        validate()
        if session is not None and (session['name'] != spec['name'] or any(
                session[k] != spec['source'][k] for k in ('manifestBytes', 'manifestSha256', 'totalBytes', 'entries'))
                or session.get('version', spec['reference']['version']) != spec['reference']['version']):
            raise ValueError('Training cache upload differs from its fixed warehouse version')

    @contextmanager
    def _peer_cache_preparation(self, spec):
        """Private worker scope; no JSON/HTTP field can construct this grant."""
        if not self.cache_only():
            yield
            return
        policy = self.n.CONFIG.get('storageArchive', {})
        jobs = self.n.transfers()
        def validate():
            ref, source = spec.get('reference'), spec.get('source')
            if (policy.get('enabled') is not True or spec.get('sourceMachine') != policy.get('machine')
                    or policy.get('machine') == self.n.CONFIG.get('machine') or 'archiveLane' in spec
                    or not isinstance(ref, dict) or set(ref) != {'kind', 'dataset', 'version'}
                    or ref.get('kind') != 'datasets' or not HASH.fullmatch(str(ref.get('version', '')))
                    or not isinstance(source, dict) or source.get('state') != 'READY'
                    or source.get('id') != spec.get('id') or not UUID.fullmatch(str(spec.get('id', '')))
                    or jobs.load(spec['id']) != spec or jobs.path(spec['id'], '.cancel').exists()
                    or spec['sourceMachine'] not in self.n.CONFIG.get('transferPeers', {})):
                raise PermissionError('Training cache requires its durable fixed-version HDD warehouse transfer')
            payload = {k: spec[k] for k in ('userId', 'sourceMachine', 'source', 'name', 'reference', 'timeoutSec')}
            if spec.get('digest') != hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest():
                raise ValueError('Training cache transfer identity changed')
        validate()
        token = _CACHE_PREPARATION.set((self, spec, validate))
        try:
            yield
        finally:
            _CACHE_PREPARATION.reset(token)

    def actor(self, user):
        self.n.workspace(user)
        return self.d.Principal(user, False)

    def folder(self, user, upload, *, create=False):
        self.actor(user)
        if not isinstance(upload, str) or not UUID.fullmatch(upload):
            raise ValueError('Invalid upload ID')
        parent = self.root/hashlib.sha256(user.encode()).hexdigest()
        target = parent/upload
        if create:
            self.d._mkdir(parent)
            if 'storageQuota' in self.n.CONFIG:
                self.n.storage_quota(user, parent)
            self.d._mkdir(target)
        elif 'storageQuota' in self.n.CONFIG and parent.exists():
            self.n.storage_quota(user, parent)
        return target

    def key(self, user, upload):
        return hashlib.sha256(json.dumps([user, upload], separators=(',', ':')).encode()).hexdigest()

    def reservation(self, user, upload):
        return self.cache.root/'.upload-reservations'/(self.key(user, upload)+'.json')

    def reservation_value(self, session, *, sealed=False, budget_sealed=None):
        budget_sealed = sealed if budget_sealed is None else budget_sealed
        footprint = session['totalBytes'] + 4096 * session['entries'] + 8192
        return {'bytes': session['reserveBytes']-(session['totalBytes'] if sealed else 0),
                'inodes': session['entries']+16,
                'budgetBytes': session['reserveBytes']-(footprint if budget_sealed else 0)}

    def ensure_reservation(self, session):
        """Caller holds the cache lock; repair interrupted admission safely."""
        if 'version' in session and self._exists(self.cache._paths(session['dataset'], session['version'])['.staging']):
            return
        path = self.reservation(session['userId'], session['uploadId'])
        try:
            value = self.d._read_json(path)
        except FileNotFoundError:
            self.cache._budget(session['reserveBytes'])
            self.cache._free(self.cache._reserved()+session['reserveBytes'], needed_inodes=session['entries']+16)
            self.d._write_json(path, self.reservation_value(session))
        else:
            full = self.reservation_value(session)
            variants = (full, self.reservation_value(session, sealed=True),
                        self.reservation_value(session, sealed=True, budget_sealed=False))
            legacy = tuple({k: v for k, v in item.items() if k != 'budgetBytes'} for item in variants)
            if value not in (*variants, *legacy):
                raise ValueError('Personal upload reservation changed')
            if value != full:
                # A killed conversion can leave its reduced physical record
                # without a stage. Re-admit the missing commitment before any
                # further manifest writes; never infer a refund from absence.
                self.cache._budget(session['reserveBytes']-value.get('budgetBytes', value['bytes']))
                self.cache._free(self.cache._reserved()+session['reserveBytes']-value['bytes'],
                                 needed_inodes=session['entries']+16)
                self.d._write_json(path, full)

    @contextmanager
    def guard(self, user, upload):
        # Authenticate the session before creating an attacker-chosen lock.
        self.load(user, upload)
        with self.cache._lock_file('.locks/upload-'+self.key(user, upload)+'.lock'):
            yield

    def load(self, user, upload):
        value = self.d._read_json(self.folder(user, upload)/'session.json')
        if (not isinstance(value, dict) or value.get('schema') != 1
                or value.get('userId') != user or value.get('uploadId') != upload
                or not isinstance(value.get('name'), str) or not NAME.fullmatch(value['name'])
                or value.get('state') not in {'RECEIVING_MANIFEST', 'SEALING', 'UPLOADING', 'PUBLISHING', 'READY', 'DISCARDING', 'DISCARDED', 'FAILED'}
                or any(type(value.get(k)) is not int or value[k] < 0 for k in ('manifestBytes', 'totalBytes', 'entries', 'reserveBytes'))
                or not 1 <= value['manifestBytes'] <= self.d.MAX_JSON_BYTES
                or value['entries'] > self.d.MAX_ENTRIES or value['totalBytes'] > 2**63-1
                or value['reserveBytes'] != value['totalBytes']+value['manifestBytes']*4+value['entries']*8192+65536
                or not isinstance(value.get('manifestSha256'), str) or not HASH.fullmatch(value['manifestSha256'])):
            raise ValueError('Corrupt personal upload identity')
        lane = value.get('archiveAdmission')
        if lane is not None:
            if (not isinstance(lane, dict) or set(lane) != {'schema', 'transferId', 'targetMachine', 'authority', 'sourceMachine', 'reference'}
                    or type(lane.get('schema')) is not int or lane['schema'] != 1 or lane['transferId'] != upload
                    or any(not isinstance(lane.get(k), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', lane[k])
                           for k in ('targetMachine', 'authority', 'sourceMachine'))
                    or lane['sourceMachine'] == lane['targetMachine']
                    or not isinstance(lane['reference'], dict) or set(lane['reference']) != {'kind', 'dataset', 'version'}
                    or lane['reference']['kind'] != 'datasets'
                    or not isinstance(lane['reference']['dataset'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', lane['reference']['dataset'])
                    or not isinstance(lane['reference']['version'], str) or not HASH.fullmatch(lane['reference']['version'])):
                raise ValueError('Corrupt managed archive upload binding')
        return value

    def save(self, session):
        session['updatedAt'] = time.time()
        self.d._write_json(self.folder(session['userId'], session['uploadId'])/'session.json', session)

    def active(self, user, upload):
        session = self.load(user, upload)
        unit = session.get('workerUnit', 'gpuq-upload-'+self.key(user, upload)[:32])
        if not re.fullmatch(r'gpuq-transfer-[a-f0-9-]{36}-[1-9][0-9]*\.service|gpuq-upload-[a-f0-9]{32}', unit):
            raise ValueError('Invalid upload worker unit')
        return subprocess.run(['/usr/bin/systemctl', '--user', 'is-active', '--quiet',
            unit], env=self.n.ENV,
            stdout=subprocess.DEVNULL, timeout=4).returncode == 0

    def _exists(self, path):
        try:
            with self.d._directory(path):
                pass
            return True
        except FileNotFoundError:
            return False

    def _unlink(self, path):
        with self.d._directory(path.parent) as fd:
            try:
                os.unlink(path.name, dir_fd=fd)
                os.fsync(fd)
            except FileNotFoundError:
                pass

    def _size(self, path, *, missing=0):
        try:
            with self.d._directory(path.parent) as parent:
                fd = os.open(path.name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
                try:
                    return self.d._regular(fd).st_size
                finally:
                    os.close(fd)
        except FileNotFoundError:
            return missing

    def _ready(self, session):
        if 'version' not in session:
            return False
        actor = self.actor(session['userId'])
        try:
            self.cache._dataset(actor, session['dataset'])
        except FileNotFoundError:
            return False
        if 'registrationIdentity' in session:
            try:
                self.cache._check_snapshot(actor, session['dataset'], session['version'], tuple(session['registrationIdentity']))
            except FileNotFoundError:
                return False
        paths = self.cache._paths(session['dataset'], session['version'])
        if not self._exists(paths['ready']):
            return False
        marker = self.d._read_json(paths['ready']/'READY.json')
        if marker != {'schema': self.d.SCHEMA, 'version': session['version']}:
            raise ValueError('Published dataset marker is invalid')
        for path in (paths['ready'], paths['ready']/'data'):
            with self.d._directory(path) as fd:
                if os.fstat(fd).st_mode & 0o222:
                    raise ValueError('Published dataset is not read-only')
        return True

    def retire_unregistered(self, session):
        """Reclaim only this session's metadata after confirmed admin removal.

        Caller holds the cache lock. A missing READY directory alone is eviction,
        not deletion: its registration continues to count toward personal quota.
        Any residual replica/lease, I/O error or authorization mismatch fails
        closed. This never removes cache registrations, replicas or leases.
        """
        if session['state'] != 'READY' or 'registrationIdentity' not in session:
            return session
        dataset, version = session['dataset'], session['version']
        expected = 'u-'+hashlib.sha256(session['userId'].encode()).hexdigest()[:16]+'-'+session['name']
        if dataset != expected:
            raise ValueError('Personal upload namespace changed')
        # Quarantined bytes still occupy disk and remain recoverable. A rename
        # out of the registry is never permission to refund their reservation.
        fence = self.cache._retirement_fence(dataset, version)
        if fence is not None and fence['state'] not in {'RESTORED','RELEASED','PURGED'}:
            return session
        if fence is not None and fence['state'] == 'PURGED':
            spec=importlib.util.spec_from_file_location('upload_retention_proof',Path(__file__).with_name('dataset-retirement.py'))
            retention=importlib.util.module_from_spec(spec);spec.loader.exec_module(retention)
            journal=retention.private_read(self.cache.root/'.trash'/('retire-'+fence['operationId'].replace('-',''))/'RETIREMENT.json')
            if (journal.get('state')!='PURGED' or journal.get('dataset')!=dataset or journal.get('version')!=version
                    or journal.get('snapshot',{}).get('registration')!=session['registrationIdentity']
                    or journal.get('operationId')!=fence['operationId']
                    or retention.sha(journal.get('snapshot'))!=fence['snapshotSha256']
                    or journal.get('snapshot',{}).get('rootIdentity')!=list(self.cache._root_identity)
                    or journal.get('actor')!=session['userId'] and journal.get('admin') is not True):
                raise ValueError('Purged upload generation is unconfirmed; reservation retained')
        try:
            self.cache._record_identity(dataset, version, _read_only=fence is not None and fence['state']=='PURGED')
            return session
        except FileNotFoundError:
            pass
        try:
            owners = self.cache._dataset(self.actor(session['userId']), dataset)['owners']
            if owners != [session['userId']]:
                raise PermissionError('Personal dataset ownership changed')
        except FileNotFoundError:
            pass
        paths = self.cache._paths(dataset, version)
        if (self._exists(paths['ready']) or self._exists(paths['.staging'])
                or self.cache._leases(dataset, version)):
            raise ValueError('Unregistered dataset still has replicas or leases; administrator inspection required')
        binding = self.binding(dataset, version)
        try:
            if self.d._read_json(binding) == {'userId': session['userId'], 'uploadId': session['uploadId']}:
                self._unlink(binding)
        except FileNotFoundError:
            pass
        self._unlink(self.reservation(session['userId'], session['uploadId']))
        for name in ('manifest.part', 'index.sqlite', 'index.pending', 'chunk.json'):
            self._unlink(self.folder(session['userId'], session['uploadId'])/name)
        session = dict(session, state='DISCARDED')
        session.pop('error', None)
        session.pop('resumeState', None)
        self.save(session)
        return session

    def effective(self, session):
        result = dict(session)
        if 'version' in session and session['state'] != 'DISCARDED':
            with self.cache._locked():
                session = self.retire_unregistered(session)
                if session['state'] == 'DISCARDED':
                    return session
                if self._ready(session):
                    self._unlink(self.reservation(session['userId'], session['uploadId']))
                    result['state'] = 'READY'
                    result.pop('error', None)
                    result.pop('resumeState', None)
                    # Recover a committed publish whose worker died before its
                    # receipt. Persist the confirmed state so future admission
                    # does not keep charging a dead PUBLISHING worker as active.
                    # A live worker owns the session writer lock and will write
                    # its own receipt; never race its atomic metadata writer.
                    if (session['state'] != 'READY' or 'error' in session or 'resumeState' in session) and not self.active(session['userId'], session['uploadId']):
                        self.save(result)
                    return result
        if session['state'] in TRANSIENT and not self.active(session['userId'], session['uploadId']):
            result.update(state='FAILED', resumeState=TRANSIENT[session['state']],
                error='Upload worker is not running; retry the pending action or discard this unfinished upload')
        elif session['state'] == 'READY':
            result.update(state='FAILED', resumeState='RECEIVING_MANIFEST',
                error='Published data is no longer present; reseal and upload the original files again')
        return result

    def result(self, session):
        result = {k: session[k] for k in ('uploadId', 'name', 'state', 'manifestBytes', 'totalBytes',
            'entries', 'dataset', 'version', 'error', 'resumeState', 'lastConfirmedRoute') if k in session}
        result.update(manifestOffset=self._size(self.folder(session['userId'], session['uploadId'])/'manifest.part'),
                      chunkBytes=self.d.CHUNK_BYTES)
        if session['state'] == 'READY':
            result['remainingBytes'] = 0
        elif 'version' in session and session['state'] != 'DISCARDED':
            try:
                stage = self.cache._paths(session['dataset'], session['version'])['.staging']
                result['remainingBytes'] = self.cache._transfer(stage)['remainingBytes']
            except FileNotFoundError:
                pass
        return result

    def _archive_binding(self, user, args, transfer):
        # This private keyword is not part of process()/HTTP. Re-read a durable
        # copy specification and its trusted target before granting its lane.
        if not isinstance(transfer, str) or not UUID.fullmatch(transfer) or args.get('key') != transfer:
            raise ValueError('Managed archive upload requires its exact transfer ID')
        jobs = self.n.transfers()
        spec = jobs.load(transfer)
        lane = jobs.archive_lane(spec.get('archiveLane'), spec.get('sourceMachine'))
        source, ref = spec.get('source'), spec.get('reference')
        if (not isinstance(source, dict) or set(source) != {'id', 'token', 'state', 'manifestBytes', 'manifestSha256', 'totalBytes', 'entries'}
                or source.get('state') != 'READY' or not isinstance(source.get('token'), str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{43}', source['token'])
                or not isinstance(ref, dict) or set(ref) != {'kind', 'dataset', 'version'} or ref.get('kind') != 'datasets'):
            raise ValueError('Invalid durable managed archive copy specification')
        self.d._identifier(ref['dataset']); self.d._identifier(ref['version'], self.d.HASH_RE)
        payload = {k: spec[k] for k in ('userId', 'sourceMachine', 'source', 'name', 'reference', 'timeoutSec', 'archiveLane')}
        expected_digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        if (spec.get('id') != transfer or spec.get('userId') != user or spec.get('digest') != expected_digest
                or spec.get('name') != args.get('name') or source.get('id') != transfer
                or any(source.get(k) != args.get(k) for k in ('manifestBytes', 'manifestSha256', 'totalBytes', 'entries'))):
            raise ValueError('Managed archive upload differs from its durable copy specification')
        return {'schema': 1, 'transferId': transfer, 'targetMachine': lane['targetMachine'],
                'authority': lane['authority'], 'sourceMachine': spec['sourceMachine'], 'reference': spec['reference']}

    def _admit(self, user, args, *, _archive_transfer=None):
        self.require_ingress(user, args.get('key'))
        name, upload = args.get('name'), args.get('key')
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError('Personal dataset name must be 1-40 ASCII letters, digits, underscores or hyphens')
        folder = self.folder(user, upload)
        for field, maximum in (('manifestBytes', self.d.MAX_JSON_BYTES),
                               ('totalBytes', self.limits['maxUploadBytes']), ('entries', self.d.MAX_ENTRIES)):
            value = args.get(field)
            if type(value) is not int or not 0 <= value <= maximum or (field == 'manifestBytes' and value == 0):
                raise ValueError('Invalid upload '+field+' or configured limit exceeded')
        digest = args.get('manifestSha256')
        if not isinstance(digest, str) or not HASH.fullmatch(digest):
            raise ValueError('Invalid manifest SHA256')
        specification = {k: args[k] for k in ('name', 'manifestBytes', 'manifestSha256', 'totalBytes', 'entries')}
        archive = self._archive_binding(user, args, _archive_transfer) if _archive_transfer is not None else None
        with self.cache._locked():
            try:
                prior = self.load(user, upload)
            except FileNotFoundError:
                prior = None
            if prior is not None:
                if prior.get('archiveAdmission') != archive:
                    raise ValueError('An existing upload cannot change its admission lane')
                if any(prior.get(k) != v for k, v in specification.items()):
                    raise ValueError('Upload key already exists with a different specification')
                prior = self.retire_unregistered(prior)
                if (prior['state'] in ('RECEIVING_MANIFEST', 'SEALING')
                        or prior['state'] == 'FAILED' and prior.get('resumeState') == 'RECEIVING_MANIFEST'):
                    self.ensure_reservation(prior)
                return prior
            parent = folder.parent
            sessions = []
            if self._exists(parent):
                with self.d._directory(parent) as fd:
                    names = os.listdir(fd)
                for item in names:
                    if not UUID.fullmatch(item):
                        raise ValueError('Corrupt personal upload directory')
                    try:
                        sessions.append(self.retire_unregistered(self.load(user, item)))
                    except FileNotFoundError:
                        # A killed first admission can leave an empty private
                        # session directory, before any reservation or payload.
                        with self.d._directory(parent/item) as fd:
                            debris = os.listdir(fd)
                        if any(not re.fullmatch(r'\.write-[a-f0-9]{32}', entry) for entry in debris):
                            raise ValueError('Incomplete upload admission needs inspection')
            # Cancellation releases payload quota, not an unlimited supply of
            # private lock files and recovery receipts. Bound lifetime sessions
            # too; intentional administrator archival can reset that history.
            if len(sessions) >= self.limits['maxUserSessions']:
                raise ValueError('Upload session history limit reached; administrator archival required')
            retained = [s for s in sessions if s['state'] != 'DISCARDED']
            if len(retained) >= self.limits['maxUserUploads']:
                raise ValueError('Personal dataset upload count limit reached')
            active = [s for s in retained if s['state'] != 'READY' and (s.get('archiveAdmission') is not None) == (archive is not None)]
            if len(active) >= (MAX_ACTIVE_ARCHIVES if archive is not None else self.limits['maxActiveUploads']):
                raise ValueError('Too many unfinished managed archive uploads' if archive is not None else 'Too many unfinished personal dataset uploads')
            # Account for raw/canonical manifests, the immutable path index and
            # future payload before any public or personal transfer can spend it.
            reserve = args['totalBytes']+args['manifestBytes']*4+args['entries']*8192+65536
            if reserve > 2**63-1:
                raise ValueError('Upload reservation exceeds supported size')
            # An administrator may choose a shared-volume policy instead of
            # per-member byte budgets. Physical free-space/inode reservation
            # below remains mandatory; zero never disables those protections.
            if self.limits['maxUserBytes'] and sum(s['reserveBytes'] for s in retained)+reserve > self.limits['maxUserBytes']:
                raise ValueError('Personal dataset storage quota reached (including metadata allowance)')
            if sum(s['entries'] for s in retained)+args['entries'] > self.limits['maxUserEntries']:
                raise ValueError('Personal dataset entry quota reached')
            self.cache._budget(reserve)
            self.cache._free(self.cache._reserved()+reserve, needed_inodes=args['entries']+16)
            self.folder(user, upload, create=True)
            session = dict(schema=1, userId=user, uploadId=upload, **specification,
                state='RECEIVING_MANIFEST', createdAt=time.time(), reserveBytes=reserve)
            if archive is not None:
                session['archiveAdmission'] = archive
            self.save(session)
            self.d._write_json(self.reservation(user, upload), self.reservation_value(session))
            return session

    def begin(self, user, args, *, _archive_transfer=None):
        self.require_ingress(user, args.get('key'))
        # effective() has its own short cache lock; do not nest it in admission.
        session = self.effective(self._admit(user, args, _archive_transfer=_archive_transfer))
        if session.get('directPaused') is True or args.get('allowRelay') is True and session.get('relayAllowed') is not True:
            with self.guard(user, session['uploadId']):
                session = self.load(user, session['uploadId'])
                session.pop('directPaused', None)
                if args.get('allowRelay') is True:
                    session['relayAllowed'] = True
                self.save(session)
        transport = self.direct_transport()
        return {**self.result(session), 'uploadTransport': {
            'protocol': 'dataset-upload-v1', 'directAvailable': transport['available'],
            'reason': transport['reason'], 'relayLimitBytes': RELAY_LIMIT_BYTES,
            'routeSelection': True,
            'relayAllowed': session.get('relayAllowed') is True}}

    def direct(self):
        spec = importlib.util.spec_from_file_location('gpuq_direct_upload', self.n.HERE/'direct-upload.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.DirectUploads(self.n, self)

    def direct_transport(self):
        # Old installations can safely keep using small uploads without the
        # optional daemon/module. Configuration alone never means reachable.
        config = self.n.CONFIG.get('directUpload')
        if config is None:
            return {'available': False, 'reason': 'not-configured'}
        if isinstance(config, dict) and config.get('enabled') is False:
            return {'available': False, 'reason': 'disabled'}
        try:
            return self.direct().availability()
        except Exception:
            # Optional direct ingress must fail closed without disabling the
            # explicitly permitted small-file legacy control/data path.
            return {'available': False, 'reason': 'invalid-config'}

    @contextmanager
    def direct_guard(self, user, upload):
        self.load(user, upload)
        with self.cache._lock_file('.locks/direct-upload-'+self.key(user, upload)+'.lock'):
            yield

    def revoke_direct(self, user, upload, *, paused=False):
        # Shared with the direct writer. Returning from cancellation guarantees
        # no already-authorized raw write remains in progress.
        try:
            with self.direct_guard(user, upload):
                self._unlink(self.folder(user, upload)/'direct-grant.json')
                if paused:
                    with self.guard(user, upload):
                        session = self.load(user, upload)
                        session['directPaused'] = True
                        self.save(session)
        except FileNotFoundError:
            pass

    def relay_allowed(self, user, upload):
        session = self.load(user, upload)
        if session['totalBytes'] > RELAY_LIMIT_BYTES and session.get('relayAllowed') is not True:
            raise ValueError('Large upload requires direct transport or explicit allowRelay; no VPS fallback was performed')

    def decoded(self, args):
        value, offset = args.get('data'), args.get('offset')
        if type(offset) is not int or offset < 0 or not isinstance(value, str) or len(value) > ((self.d.CHUNK_BYTES+2)//3)*4:
            raise ValueError('Invalid upload chunk encoding or offset')
        try:
            data = base64.b64decode(value, validate=True)
        except (ValueError, UnicodeError):
            raise ValueError('Invalid upload chunk encoding') from None
        if len(data) > self.d.CHUNK_BYTES:
            raise ValueError('Upload chunk too large')
        return offset, data

    def manifest(self, user, args):
        offset, data = self.decoded(args)
        return self.manifest_bytes(user, args, offset, data)

    def manifest_bytes(self, user, args, offset, data, *, transport='vps-relay'):
        upload = args['uploadId']
        self.require_ingress(user, upload)
        self.raw_chunk(offset, data)
        with self.guard(user, upload):
            session = self.effective(self.load(user, upload))
            self.require_ingress(user, upload, session)
            if session['state'] not in ('RECEIVING_MANIFEST', 'FAILED') or session.get('resumeState', 'RECEIVING_MANIFEST') != 'RECEIVING_MANIFEST':
                raise ValueError('Manifest is already sealed or being processed')
            if offset+len(data) > session['manifestBytes']:
                raise ValueError('Manifest chunk exceeds declared length')
            with self.cache._locked():
                self.ensure_reservation(session)
                self.cache._free(self.cache._reserved()+8192)
                with self.d._directory(self.folder(user, upload)) as parent:
                    fd = os.open('manifest.part', os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK, 0o600, dir_fd=parent)
                    try:
                        size = self.d._regular(fd).st_size
                        if offset+len(data) <= size and os.pread(fd, len(data), offset) == data:
                            pass
                        elif offset == size:
                            os.lseek(fd, offset, os.SEEK_SET)
                            view = memoryview(data)
                            while view:
                                written = os.write(fd, view)
                                if not written:
                                    raise OSError('Short manifest write')
                                view = view[written:]
                            os.fsync(fd)
                            os.fsync(parent)
                        else:
                            raise ValueError('Manifest retry differs or offset does not match; discard and restart if content changed')
                        size = self.d._regular(fd).st_size
                    finally:
                        os.close(fd)
            if session['state'] == 'FAILED':
                session.update(state='RECEIVING_MANIFEST')
                session.pop('error', None)
                session.pop('resumeState', None)
                self.save(session)
            self.confirm_route(session, transport)
            return {**self.result(session), 'offset': size, 'complete': size == session['manifestBytes']}

    def confirm_route(self, session, transport):
        # Only a trusted ingress selects this value, after accepted data I/O.
        # Persist once per route change, not on every chunk or status request.
        if transport not in ('campus-direct', 'tail-upload', 'lan-peer', 'vps-relay'):
            raise ValueError('Invalid trusted upload transport')
        if session.get('lastConfirmedRoute') != transport:
            session['lastConfirmedRoute'] = transport
            self.save(session)

    def _entry(self, session, path):
        self.d._relative(path)
        index = self.folder(session['userId'], session['uploadId'])/'index.sqlite'
        with self.d._directory(index.parent) as parent:
            fd = os.open(index.name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
            try:
                if list(self.d._stamp(self.d._regular(fd))) != session['indexIdentity']:
                    raise ValueError('Upload file index changed')
            finally:
                os.close(fd)
        with closing(sqlite3.connect(index.as_uri()+'?mode=ro&immutable=1', uri=True)) as db:
            row = db.execute('SELECT size,sha256 FROM files WHERE path=?', (path,)).fetchone()
        if row is None:
            raise ValueError('Upload path is not in the sealed manifest')
        return {'path': path, 'size': row[0], 'sha256': row[1]}

    def _check(self, session, *, transfer=True):
        actor = self.actor(session['userId'])
        dataset, version = session['dataset'], session['version']
        metadata = self.cache._dataset(actor, dataset)
        expected = 'u-'+hashlib.sha256(actor.user_id.encode()).hexdigest()[:16]+'-'+session['name']
        if dataset != expected or metadata['owners'] != [actor.user_id]:
            raise PermissionError('Upload is not an exclusively owned personal dataset')
        self.cache._check_snapshot(actor, dataset, version, tuple(session['registrationIdentity']))
        paths = self.cache._paths(dataset, version)
        if self._exists(paths['ready']):
            raise ValueError('Published version cannot be changed or discarded')
        if not transfer:
            return paths, None
        fence = self.cache._transfer(paths['.staging'])
        if fence['owner'] != actor.user_id or fence['token'] != session['transferToken']:
            raise PermissionError('Upload transfer identity changed')
        return paths, fence

    @contextmanager
    def version_guard(self, session):
        with self.cache._locked():
            self._check(session)
        with self.cache._lock_file('.locks/'+session['dataset']+'.'+session['version']+'.lock'):
            yield

    def recover_chunk(self, session, paths, fence):
        """Repair only this version's bounded last write, not its whole tree.

        A crash between data fsync and TRANSFER accounting otherwise leaks a
        reservation forever. This private intent is persisted before the write.
        """
        journal = self.folder(session['userId'], session['uploadId'])/'chunk.json'
        try:
            pending = self.d._read_json(journal)
        except FileNotFoundError:
            return fence
        if (not isinstance(pending, dict) or set(pending) != {'path', 'beforeOffset', 'beforeRemaining', 'length', 'token'}
                or pending['token'] != session['transferToken']
                or any(type(pending[k]) is not int or pending[k] < 0 for k in ('beforeOffset', 'beforeRemaining', 'length'))
                or pending['length'] > DIRECT_FILE_CHUNK_BYTES):
            raise ValueError('Invalid interrupted chunk journal')
        entry = self._entry(session, pending['path'])
        size = self._size(paths['.staging']/'data'/entry['path'])
        delta = size-pending['beforeOffset']
        if size > entry['size'] or not 0 <= delta <= pending['length'] or delta > pending['beforeRemaining']:
            raise ValueError('Interrupted chunk size cannot be reconciled')
        expected = pending['beforeRemaining']-delta
        if fence['remainingBytes'] == pending['beforeRemaining']:
            fence = dict(fence, remainingBytes=expected)
            self.d._write_json(paths['.staging']/'TRANSFER.json', fence)
        elif fence['remainingBytes'] != expected:
            raise ValueError('Interrupted chunk accounting changed')
        self._unlink(journal)
        return fence

    def chunk(self, user, args):
        offset, data = self.decoded(args)
        return self.chunk_bytes(user, args, offset, data)

    def raw_chunk(self, offset, data, *, limit=None):
        limit = self.d.CHUNK_BYTES if limit is None else limit
        if type(offset) is not int or not 0 <= offset <= 2**63-1 or not isinstance(data, bytes) or len(data) > limit:
            raise ValueError('Invalid raw upload chunk or offset')

    def chunk_bytes(self, user, args, offset, data, *, transport='vps-relay', direct_chunk_limit=None):
        upload = args['uploadId']
        self.require_ingress(user, upload)
        # Only the authenticated direct data plane can use large file blocks.
        # Keep the journal, data and accounting durability barriers unchanged.
        limit = self.d.CHUNK_BYTES
        if direct_chunk_limit is not None:
            if transport not in ('campus-direct', 'tail-upload') or type(direct_chunk_limit) is not int or direct_chunk_limit not in (self.d.CHUNK_BYTES, DIRECT_FILE_CHUNK_BYTES):
                raise ValueError('Invalid authenticated direct chunk limit')
            limit = direct_chunk_limit
        self.raw_chunk(offset, data, limit=limit)
        with self.guard(user, upload):
            session = self.effective(self.load(user, upload))
            self.require_ingress(user, upload, session)
            if session['state'] != 'UPLOADING' and not (session['state'] == 'FAILED' and session.get('resumeState') == 'UPLOADING'):
                raise ValueError('Upload is not accepting data; finish sealing or wait for publication')
            entry = self._entry(session, args.get('path'))
            with self.version_guard(session), self.cache._locked():
                paths, fence = self._check(session)
                fence = self.recover_chunk(session, paths, fence)
                self.cache._free(self.cache._reserved()+8192)
                journal = self.folder(user, upload)/'chunk.json'
                self.d._write_json(journal, {'path': entry['path'],
                    'beforeOffset': self._size(paths['.staging']/'data'/entry['path']),
                    'beforeRemaining': fence['remainingBytes'], 'length': len(data), 'token': session['transferToken']})
                result, written = self.cache._put_chunk_data(paths['.staging'], entry, offset, data, fence['remainingBytes'])
                if written:
                    fence['remainingBytes'] -= written
                    self.d._write_json(paths['.staging']/'TRANSFER.json', fence)
                self._unlink(journal)
            if session['state'] == 'FAILED':
                session.update(state='UPLOADING')
                session.pop('error', None)
                session.pop('resumeState', None)
                self.save(session)
            self.confirm_route(session, transport)
            return {**self.result(session), **result}

    def status(self, user, args):
        session = self.effective(self.load(user, args['uploadId']))
        result = self.result(session)
        if 'path' in args:
            if session['state'] not in ('UPLOADING', 'READY', 'FAILED') or 'indexIdentity' not in session:
                raise ValueError('Upload manifest has not been sealed')
            entry = self._entry(session, args['path'])
            with self.cache._locked():
                self.cache._dataset(self.actor(user), session['dataset'])
                paths = self.cache._paths(session['dataset'], session['version'])
                root = paths['ready'] if session['state'] == 'READY' else paths['.staging']
                actual = self._size(root/'data'/entry['path'], missing=None)
                offset = 0 if actual is None else actual
            if offset > entry['size']:
                raise ValueError('Uploaded file exceeds registered size')
            result['file'] = {**entry, 'offset': offset,
                'complete': actual is not None and offset == entry['size']}
        return result

    def start(self, user, args, action, *, inline_unit=None):
        if action != 'discard':
            self.require_ingress(user, args.get('uploadId'))
        # Internal transfer worker only, never accepted in public RPC fields.
        # Seal/publish in the SAME cgroup, so cancel cannot leave a publisher.
        if inline_unit is not None and not re.fullmatch(r'gpuq-transfer-[a-f0-9-]{36}-[1-9][0-9]*\.service', inline_unit):
            raise ValueError('Invalid inline worker unit')
        upload = args['uploadId']
        with self.guard(user, upload):
            session = self.effective(self.load(user, upload))
            if session['state'] == 'READY':
                if action == 'discard':
                    raise ValueError('Cannot discard a published dataset; no data was deleted')
                return self.result(session)
            if session['state'] == 'DISCARDED':
                if action != 'discard':
                    raise ValueError('This upload was discarded; use a new upload key')
                return self.result(session)
            target = {'seal': 'SEALING', 'commit': 'PUBLISHING', 'discard': 'DISCARDING'}[action]
            if session['state'] in TRANSIENT:
                if session['state'] == target:
                    return self.result(session)
                raise ValueError('Another upload operation is running')
            previous = session.get('resumeState', session['state']) if session['state'] == 'FAILED' else session['state']
            if action == 'seal' and previous != 'RECEIVING_MANIFEST':
                if session['state'] == 'UPLOADING':
                    return self.result(session)
                raise ValueError('Upload manifest is already sealed')
            if action == 'commit' and previous != 'UPLOADING':
                raise ValueError('Seal the manifest before publishing')
            if action == 'seal' and self._size(self.folder(user, upload)/'manifest.part') != session['manifestBytes']:
                raise ValueError('Manifest upload is incomplete')
            session.update(state=target, action=action)
            if inline_unit is None:
                session.pop('workerUnit', None)
            else:
                session['workerUnit'] = inline_unit
            session.pop('error', None)
            session.pop('resumeState', None)
            self.save(session)
            try:
                if inline_unit is None:
                    self.n.run(['/usr/bin/systemd-run', '--user', '--collect',
                    '--unit=gpuq-upload-'+self.key(user, upload)[:32], '--property=KillMode=control-group',
                    '--property=UMask=0077', '--property=CPUQuota=100%', '--property=MemoryMax=2G',
                    '--property=IOWeight=10', '--property=RuntimeMaxSec=86400', '--property=TimeoutStopSec=20',
                    '/usr/bin/python3', str(self.n.HERE/'node-executor.py'), '--dataset-upload-worker', user, upload, action], timeout=8)
            except Exception:
                session.update(state='FAILED', resumeState=previous, error='Unable to start upload worker')
                self.save(session)
                raise
            if inline_unit is None:
                return self.result(session)
        self.worker(user, upload, action)
        return self.status(user, {'uploadId': upload})

    def pause(self, user, args):
        # Stop without deleting partial payload. Do not hold the writer lock
        # while stopping the unit: its worker may itself own that lock.
        self.revoke_direct(user, args['uploadId'], paused=True)
        try:
            session = self.load(user, args['uploadId'])
        except FileNotFoundError:
            # begin alone cannot start an upload/verification worker. Portal
            # permanently fences subsequent transfer I/O after cancel intent.
            return {'uploadId': args['uploadId'], 'state': 'NOT_STARTED'}
        unit = session.get('workerUnit', 'gpuq-upload-'+self.key(user, args['uploadId'])[:32])
        if 'workerUnit' in session:
            raise ValueError('This upload is controlled by its transfer job')
        self.n.run(['/usr/bin/systemctl', '--user', 'stop', unit], timeout=10)
        return self.status(user, args)

    def binding(self, dataset, version):
        return self.root/'bindings'/(hashlib.sha256((dataset+'@'+version).encode()).hexdigest()+'.json')

    def seal(self, session):
        self.require_ingress(session['userId'], session['uploadId'], session)
        user, upload = session['userId'], session['uploadId']
        folder = self.folder(user, upload)
        with self.d._directory(folder) as parent:
            fd = os.open('manifest.part', os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
            try:
                digest, size = self.d._digest_fd(fd)
                if size != session['manifestBytes'] or digest != session['manifestSha256']:
                    raise ValueError('Manifest length or SHA256 does not match')
                os.lseek(fd, 0, os.SEEK_SET)
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    manifest = self.d._manifest(json.load(stream))
            finally:
                os.close(fd)
        if (len(manifest['files'])+len(manifest['directories']) != session['entries']
                or sum(f['size'] for f in manifest['files']) != session['totalBytes']):
            raise ValueError('Manifest totals differ from the admitted upload')
        dataset = 'u-'+hashlib.sha256(user.encode()).hexdigest()[:16]+'-'+session['name']
        version = self.d._version(manifest)
        actor = self.actor(user)
        index = folder/'index.sqlite'
        temporary = folder/'index.pending'
        self._unlink(temporary)
        fd = os.open(temporary, os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW, 0o600)
        os.close(fd)
        try:
            with closing(sqlite3.connect(temporary)) as db:
                db.execute('PRAGMA journal_mode=OFF')
                db.execute('PRAGMA synchronous=OFF')
                db.execute('CREATE TABLE files(path TEXT PRIMARY KEY,size INTEGER NOT NULL,sha256 TEXT NOT NULL) WITHOUT ROWID')
                db.executemany('INSERT INTO files VALUES(?,?,?)',
                    ((f['path'], f['size'], f['sha256']) for f in manifest['files']))
                db.commit()
            with self.d._directory(folder) as parent:
                fd = os.open(temporary.name, os.O_RDONLY|os.O_NOFOLLOW, dir_fd=parent)
                try:
                    self.d._regular(fd)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                os.replace(temporary.name, index.name, src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
            session.update(dataset=dataset, version=version)
            session['indexIdentity'] = list(self.d._stamp(index.stat(follow_symlinks=False)))
            # A kill after any cache mutation must still leave enough durable
            # identity for discard/retry to find precisely this upload's work.
            self.save(session)
            origin = 'replica' if session.get('workerUnit', '').startswith('gpuq-transfer-') else 'upload'
            internal=self.d.Principal(user,True)
            with self.cache._new_registration(internal,dataset,manifest,[user],None,origin=origin,receipt=upload,
                                              explicit=origin=='upload') as reopening,self.cache._locked():
                binding = self.binding(dataset, version)
                try:
                    existing = self.d._read_json(binding)
                except FileNotFoundError:
                    existing = None
                if existing is not None and existing != {'userId': user, 'uploadId': upload}:
                    if reopening:
                        scope=self.d._REGISTRATION_SCOPE.get()[1]
                        R=self.cache._retirement_module()
                        old=R.private_read(self.cache.root/'.trash'/('retire-'+scope['operationId'].replace('-',''))/'metadata/provenance.json')
                        if existing!={'userId':user,'uploadId':old.get('receipt')} or old.get('origin')!='upload' or old.get('owners')!=[user]:
                            raise ValueError('Explicit upload cannot replace an unconfirmed old upload binding')
                        existing=None
                if existing is not None and existing != {'userId': user, 'uploadId': upload}:
                    if not self._ready(session):
                        raise ValueError('This personal dataset version already has another unfinished upload')
                    session.update(state='READY', registrationIdentity=list(self.cache._record_identity(dataset, version)))
                    self._unlink(self.reservation(user, upload))
                    self.save(session)
                    return
                try:
                    record = self.cache._record(actor, dataset, version)
                    if record['sourceId'] is not None:
                        raise ValueError('Personal upload cannot replace an approved source registration')
                    if existing is None and not self._ready(session):
                        raise ValueError('An existing unowned transfer cannot be adopted by this upload')
                except FileNotFoundError:
                    pass
                try:
                    metadata = self.cache._dataset(actor, dataset)
                    if metadata['owners'] != [user]:
                        raise PermissionError('Personal dataset owner differs')
                except FileNotFoundError:
                    pass
                self.d._write_json(binding, {'userId': user, 'uploadId': upload})
                # All authorization, quota admission and reservation conversion
                # are service-owned. No public operation receives an admin actor.
                try:
                    self.cache._register(internal, dataset, manifest, [user], None,
                                         _origin=origin, _receipt=upload)
                    session['registrationIdentity'] = list(self.cache._record_identity(dataset, version))
                    self.save(session)
                    # Keep the whole logical commitment until the stage is
                    # durable. The physical record still reserves remaining
                    # writes exactly as before. A crash may overcount, never
                    # free the payload before its replacement stage exists.
                    self.d._write_json(self.reservation(user, upload),
                                       self.reservation_value(session, sealed=True, budget_sealed=False))
                    plan = self.cache._plan(actor, dataset, version,
                                            reservation_credit=self.cache._footprint(manifest))
                    self.d._write_json(self.reservation(user, upload), self.reservation_value(session, sealed=True))
                except BaseException:
                    self.d._write_json(self.reservation(user, upload), self.reservation_value(session))
                    raise
                if plan['state'] == 'READY':
                    session.update(state='READY')
                    self._unlink(self.reservation(user, upload))
                else:
                    session.update(state='UPLOADING', transferToken=plan['token'])
                self.save(session)
        finally:
            self._unlink(temporary)

    def discard(self, session):
        user, upload = session['userId'], session['uploadId']
        if 'version' in session:
            owned = False
            with self.cache._locked():
                binding = self.binding(session['dataset'], session['version'])
                try:
                    owned = self.d._read_json(binding) == {'userId': user, 'uploadId': upload}
                except FileNotFoundError:
                    pass
                if owned:
                    try:
                        record = self.cache._record(self.actor(user), session['dataset'], session['version'])
                    except FileNotFoundError:
                        owned = False
                    else:
                        if record['sourceId'] is not None:
                            raise ValueError('Personal upload source registration changed')
                        if 'registrationIdentity' not in session:
                            session['registrationIdentity'] = list(self.cache._record_identity(session['dataset'], session['version']))
                        paths, _ = self._check(session, transfer=False)
                        if self._exists(paths['.staging']) and 'transferToken' not in session:
                            fence = self.cache._transfer(paths['.staging'])
                            if fence['owner'] != user:
                                raise PermissionError('Upload transfer belongs to another user')
                            session['transferToken'] = fence['token']
                        self.save(session)
            def guard():
                paths, _ = self._check(session, transfer=False)
                if self._exists(paths['.staging']):
                    self._check(session)
            # The cache rechecks this guard inside every deletion transaction
            # checkpoint. An owner/source/registration/READY change fails closed.
            if owned:
                self.cache.unregister(self.d.Principal(user, True), session['dataset'], session['version'], _guard=guard)
            with self.cache._locked():
                binding = self.binding(session['dataset'], session['version'])
                try:
                    if self.d._read_json(binding) == {'userId': user, 'uploadId': upload}:
                        self._unlink(binding)
                except FileNotFoundError:
                    pass
        with self.cache._locked():
            self._unlink(self.reservation(user, upload))
        for name in ('manifest.part', 'index.sqlite', 'index.pending', 'chunk.json'):
            self._unlink(self.folder(user, upload)/name)
        session.update(state='DISCARDED')
        session.pop('error', None)
        session.pop('resumeState', None)
        self.save(session)

    def worker(self, user, upload, action):
        with self.d.wait_for_locks():
            return self._worker(user, upload, action)

    def _worker(self, user, upload, action):
        self.actor(user)
        if action not in ('seal', 'commit', 'discard'):
            raise ValueError('Invalid upload worker action')
        with self.guard(user, upload):
            session = self.load(user, upload)
            expected = {'seal': 'SEALING', 'commit': 'PUBLISHING', 'discard': 'DISCARDING'}[action]
            if session['state'] != expected or session.get('action') != action:
                raise ValueError('Upload worker request changed')
            try:
                if action != 'discard':
                    self.require_ingress(user, upload, session)
                if action == 'seal':
                    self.seal(session)
                elif action == 'commit':
                    actor = self.actor(user)
                    archive = None
                    # Peer copies use this same uploader but are not new user
                    # originals. Enrolling them again would recurse forever.
                    if (self.n.CONFIG.get('storageArchive', {}).get('enabled') is True
                            and not session.get('workerUnit', '').startswith('gpuq-transfer-')):
                        archive = self.n.storage_archive()
                        intent = archive.outbox_begin({'opId': upload, 'userId': user,
                            'reference': {'dataset': session['dataset'], 'version': session['version']}, 'origin': 'upload'})
                        session['archiveEventId'] = intent['id']
                        self.save(session)
                    with self.version_guard(session):
                        with self.cache._locked():
                            paths, fence = self._check(session)
                            self.recover_chunk(session, paths, fence)
                            record = self.cache._record(actor, session['dataset'], session['version'])
                            identity = self.cache._record_identity(session['dataset'], session['version'])
                        # Retain the same version lock and recheck exclusive
                        # personal ownership at every publish checkpoint, even
                        # if an administrator changes authorization mid-hash.
                        self.cache._publish_locked(actor, session['dataset'], session['version'],
                            session['transferToken'], (record, identity),
                            _guard=lambda: (self.require_ingress(user, upload, session), self._check(session)))
                    session.update(state='READY')
                    with self.cache._locked():
                        self._unlink(self.reservation(user, upload))
                    self.save(session)
                    if archive is not None:
                        archive.outbox_ready({'opId': session['archiveEventId'], 'userId': user})
                else:
                    self.discard(session)
            except Exception as error:
                with self.cache._locked():
                    committed = 'version' in session and self._ready(session)
                    if committed:
                        self._unlink(self.reservation(user, upload))
                if committed:
                    session.update(state='READY')
                    session.pop('error', None)
                    session.pop('resumeState', None)
                else:
                    message = (os.strerror(error.errno) if isinstance(error, OSError) and error.errno
                        else str(error) if isinstance(error, ValueError) else 'Upload operation failed; inspect node logs')
                    session.update(state='FAILED', resumeState=TRANSIENT[expected], error=message[:300])
                self.save(session)
                return 0 if committed else 1
            return 0

    def process(self, operation, args):
        fields = {'begin': {'name', 'key', 'manifestBytes', 'manifestSha256', 'totalBytes', 'entries', 'allowRelay'},
                  'manifest': {'uploadId', 'offset', 'data'}, 'seal': {'uploadId'},
                  'status': {'uploadId', 'path'}, 'chunk': {'uploadId', 'path', 'offset', 'data'},
                  'commit': {'uploadId'}, 'discard': {'uploadId'}, 'pause': {'uploadId'},
                  'routes': set(), 'direct-ticket': {'uploadId', 'routeId'}, 'direct-revoke': {'uploadId'}}
        action = operation.removeprefix('datasets.upload.')
        if (action not in fields or not isinstance(args, dict) or set(args)-fields[action]-{'userId', 'hostAdmin'}
                or ('hostAdmin' in args and args['hostAdmin'] is not False)):
            raise ValueError('Invalid personal upload fields')
        required = fields[action]-({'path'} if action == 'status' else {'allowRelay'} if action == 'begin' else {'routeId'} if action == 'direct-ticket' else set())
        if not required <= set(args) or 'userId' not in args:
            raise ValueError('Missing personal upload fields')
        user = args['userId']
        if action in ('begin', 'manifest', 'seal', 'chunk', 'commit', 'direct-ticket'):
            self.require_public_ingress()
        if action == 'routes':
            # Metadata only: no workspace, upload, ticket or lockfile creation.
            if not isinstance(user, str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]{1,18})', user):
                raise ValueError('Invalid personal upload identity')
            return self.direct_transport()
        self.actor(user)
        if 'allowRelay' in args and type(args['allowRelay']) is not bool:
            raise ValueError('allowRelay must be an explicit boolean')
        if action == 'direct-ticket':
            self.load(user, args['uploadId'])
            transport = self.direct_transport()
            if not transport['available']:
                return {'available': False, 'protocol': 'dataset-upload-v1',
                        'reason': transport['reason'], 'relayLimitBytes': RELAY_LIMIT_BYTES}
            return self.direct().issue(user, args['uploadId'], args.get('routeId', 'primary'))
        if action == 'direct-revoke':
            self.load(user, args['uploadId'])
            self.revoke_direct(user, args['uploadId'], paused=True)
            return {'uploadId': args['uploadId'], 'revoked': True}
        if action in ('manifest', 'chunk'):
            self.relay_allowed(user, args['uploadId'])
        if action == 'discard':
            self.revoke_direct(user, args['uploadId'], paused=True)
        if action in ('seal', 'commit', 'discard'):
            return self.start(user, args, action)
        return getattr(self, action)(user, args)
