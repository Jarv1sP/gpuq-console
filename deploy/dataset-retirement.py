#!/usr/bin/env python3
"""Explicit version-data isolation, distinct from archive-intent retirement.

Only the authenticated executor constructs this adapter. No request path,
retention policy, authority adapter, role or dependency checker is trusted.
All complete data remains on its verified filesystem for at least seven days.
There is no listener, automatic retry, enabled timer, or archive lane here.
"""
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import time
import uuid

_spec = importlib.util.spec_from_file_location('retirement_cache_helpers', Path(__file__).with_name('dataset-cache.py'))
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)
PROTOCOL = 'dataset-version-retirement-v1'
GRANT_UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')


def operation(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', value):
        raise D.CacheError('a fixed UUID retirement operation is required')
    return value


def sha(value):
    return hashlib.sha256(D._json_bytes(value)).hexdigest()


def private_directory(path):
    D._mkdir(path)
    with D._directory(path) as fd:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise D.CacheError('retirement journal must remain private and service-owned')


def private_read(path):
    with D._directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
        try:
            info = D._regular(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > D.MAX_JSON_BYTES:
                raise D.CacheError('unsafe retirement journal')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                try:
                    return json.loads(stream.read(D.MAX_JSON_BYTES + 1))
                except (ValueError, UnicodeDecodeError) as error:
                    raise D.CacheError('corrupt retirement journal') from error
        finally:
            os.close(fd)


def exists(path):
    # A broken link still exists and must never be interpreted as absence.
    return os.path.lexists(path)


def identity(path, directory=False):
    if directory:
        with D._directory(path) as fd:
            return list(D._stamp(os.fstat(fd)))
    with D._directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
        try:
            return list(D._stamp(D._regular(fd)))
        finally:
            os.close(fd)


class DatasetRetirement:
    def __init__(self, cache, machine, *, retention_days=7, clock=time.time,
                 assert_quiescent=None, authority=None, recovery_references=None):
        if not isinstance(machine, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', machine):
            raise D.CacheError('a configured machine identity is required')
        if type(retention_days) is not int or not 7 <= retention_days <= 365:
            raise D.CacheError('retirement retention must be 7–365 days')
        self.cache, self.machine, self.clock = cache, machine, clock
        self.retention_seconds = retention_days * 86400
        self.assert_quiescent, self.authority = assert_quiescent, authority
        self.recovery_references=recovery_references
        self.root = cache.root / '.retirements'
        private_directory(self.root)

    def _folder(self, key):
        return self.cache.root / '.trash' / ('retire-' + uuid.UUID(operation(key)).hex)

    def _lock(self, key):
        return self.cache._lock_file('.locks/retire-' + uuid.UUID(operation(key)).hex + '.lock')

    def _now(self, row=None):
        now = self.clock()
        if type(now) not in (int, float) or not math.isfinite(now) or now < 0:
            raise D.CacheError('untrusted retirement clock')
        if row is not None and now < row['lastObservedAt']:
            raise D.CacheError('clock moved backwards; retirement collection forbidden')
        return now

    def _journal(self, key):
        row = private_read(self._folder(key) / 'RETIREMENT.json')
        fields = {'schema', 'protocol', 'operationId', 'machine', 'actor', 'admin', 'dataset', 'version',
                  'snapshot', 'binding', 'rootIdentity', 'mountIdentity', 'retentionSeconds', 'retainUntil',
                  'createdAt', 'lastObservedAt', 'state', 'moves', 'dataIdentity', 'revocations', 'restoreRecordIdentity'}
        if (not isinstance(row, dict) or set(row) != fields or type(row['schema']) is not int or row['schema'] != 1
                or row['protocol'] != PROTOCOL or row['operationId'] != operation(key) or row['machine'] != self.machine
                or type(row['admin']) is not bool or row['state'] not in {'ISOLATING', 'ISOLATED', 'RESTORING', 'RESTORED', 'PURGING', 'PURGED'}
                or row['rootIdentity'] != list(self.cache._root_identity)
                or row['mountIdentity'] != (list(self.cache.mount) if self.cache.mount is not None else None)
                or type(row['retentionSeconds']) is not int or row['retentionSeconds'] < 7*86400
                or not isinstance(row['moves'], dict) or set(row['moves']) - {'ready', 'registration', 'tier', 'provenance', 'restore-ready', 'restore-registration'}
                or not isinstance(row['revocations'], list)):
            raise D.CacheError('corrupt retirement journal; no cleanup or recovery permitted')
        for field in ('createdAt', 'lastObservedAt'):
            if type(row[field]) not in (int, float) or not math.isfinite(row[field]) or row[field] < 0:
                raise D.CacheError('corrupt retirement clock')
        if row['retainUntil'] is not None and (type(row['retainUntil']) not in (int, float)
                or not math.isfinite(row['retainUntil']) or row['retainUntil'] < row['createdAt'] + row['retentionSeconds']):
            raise D.CacheError('corrupt retention deadline')
        D._identifier(row['actor'], D.USER_RE)
        self.cache._paths(row['dataset'], row['version'])
        snap = row['snapshot']
        fields = {'protocol', 'machine', 'dataset', 'version', 'owners', 'registration', 'rootIdentity',
                  'manifestSha256', 'complete', 'readyIdentity', 'tierSha256', 'provenanceSha256',
                  'tierIdentity', 'provenanceIdentity', 'memberAllowed', 'authority', 'authorityReferences'}
        if (not isinstance(snap, dict) or set(snap) != fields or snap['protocol'] != PROTOCOL
                or any(snap[name] != row[name] for name in ('machine', 'dataset', 'version', 'rootIdentity'))
                or type(snap['complete']) is not bool or type(snap['memberAllowed']) is not bool
                or self.cache._owners(snap['owners']) != snap['owners']
                or snap['manifestSha256'] != row['version']):
            raise D.CacheError('corrupt retirement version snapshot')
        def stamp(value):
            return isinstance(value, list) and len(value) == 5 and all(type(item) is int and item >= 0 for item in value)
        for name in ('registration', 'readyIdentity', 'tierIdentity', 'provenanceIdentity'):
            value = snap[name]
            if (name == 'registration' or value is not None) and not stamp(value):
                raise D.CacheError('corrupt fixed retirement inode')
        if snap['complete'] != (snap['readyIdentity'] is not None):
            raise D.CacheError('corrupt retirement completeness')
        if row['restoreRecordIdentity'] is not None and not stamp(row['restoreRecordIdentity']):
            raise D.CacheError('corrupt restored registration identity')
        for name in ('manifestSha256', 'tierSha256', 'provenanceSha256'):
            D._identifier(snap[name], D.HASH_RE)
        if not isinstance(snap['authorityReferences'],list) or len(snap['authorityReferences'])>16:
            raise D.CacheError('corrupt fixed authority references')
        for ref in snap['authorityReferences']:
            if (not isinstance(ref,dict) or set(ref)!={'sourceMachine','targetMachine','sourceDataset','version','grantId','receiptSha256'}
                    or ref['targetMachine']!=row['machine'] or ref['version']!=row['version']):
                raise D.CacheError('corrupt fixed authority reference')
            D._identifier(ref['sourceMachine']);D._identifier(ref['sourceDataset'])
            D._identifier(ref['grantId'],GRANT_UUID);D._identifier(ref['receiptSha256'],D.HASH_RE)
        authority=snap['authority']
        if authority is not None:
            if (not isinstance(authority,dict) or set(authority)!={'protocol','sourceMachine','dataset','version','registration','pins','grants'}
                    or authority['protocol']!='dataset-authority-dependencies-v1' or authority['sourceMachine']!=row['machine']
                    or authority['dataset']!=row['dataset'] or authority['version']!=row['version']
                    or authority['registration']!=snap['registration'] or not isinstance(authority['pins'],list)
                    or not isinstance(authority['grants'],list) or len(authority['grants'])>10000):
                raise D.CacheError('corrupt authority dependency plan')
            for grant in authority['grants']:
                if (not isinstance(grant,dict) or set(grant)!={'id','targetMachine','receiptSha256','registration','pinId'}
                        or grant['registration']!=snap['registration'] or grant['pinId']!='authority-'+grant['id']):
                    raise D.CacheError('corrupt fixed authority grant')
                D._identifier(grant['id'],GRANT_UUID);D._identifier(grant['targetMachine']);D._identifier(grant['receiptSha256'],D.HASH_RE)
            if authority['pins']!=sorted(grant['pinId'] for grant in authority['grants']):
                raise D.CacheError('incomplete authority dependency pins')
        for name, value in row['moves'].items():
            origin = (row['restoreRecordIdentity'] if name == 'restore-registration' else snap['registration']
                      if name == 'registration' else snap['readyIdentity'] if name in {'ready', 'restore-ready'} else snap[name+'Identity'])
            if not stamp(value) or origin is None or value[:4] != origin[:4]:
                raise D.CacheError('corrupt confirmed retirement move')
        if row['dataIdentity'] is not None and (not stamp(row['dataIdentity'])
                or row['dataIdentity'][:4] != (snap['readyIdentity'] or [])[:4]):
            raise D.CacheError('corrupt isolated payload identity')
        if row['state'] != 'ISOLATING':
            required = {'registration'} | ({'ready'} if snap['complete'] else set())
            required |= {name for name in ('tier', 'provenance') if snap[name+'Identity'] is not None}
            if (not required <= set(row['moves']) or row['retainUntil'] is None
                    or snap['complete'] != (row['dataIdentity'] is not None)):
                raise D.CacheError('isolation has no complete confirmed transaction')
        if row['lastObservedAt'] < row['createdAt']:
            raise D.CacheError('corrupt retirement clock sequence')
        if row['binding'] != sha([row['actor'], row['admin'], row['dataset'], row['version'], row['snapshot']]):
            raise D.CacheError('retirement request binding changed')
        return row

    def _save(self, row):
        row['lastObservedAt'] = self._now(row)
        D._write_json(self._folder(row['operationId']) / 'RETIREMENT.json', row)

    def _permissions_locked(self, actor, dataset, version):
        owners = self.cache._dataset(actor, dataset)['owners']
        proof = self.cache._provenance(dataset, version)
        personal = (owners == [actor.user_id] and proof is not None and proof['owners'] == owners
                    and proof['origin'] in {'upload', 'workspace', 'replica'})
        if not actor.is_admin and not personal:
            raise PermissionError('这份数据只能由管理员删除')
        return owners, proof

    def fence(self, actor, dataset, version, key, snapshot):
        """Persist before draining workers; never clear an ambiguous fence."""
        self.cache._actor(actor)
        operation(key)
        with self._lock(key):
            with self.cache._locked():
                previous = self.cache._retirement_fence(dataset, version)
            if previous is not None and previous['state'] not in {'RESTORED','RELEASED'}:
                if (previous['operationId'] != key or previous['actor'] != actor.user_id
                        or previous['admin'] != actor.is_admin or previous['snapshotSha256'] != sha(snapshot)):
                    raise PermissionError('version is fenced by another immutable deletion request')
            else:
                if previous is not None and previous['operationId'] == key:
                    raise D.CacheError('restored generation cannot replay its old deletion')
                if self.inspect(actor, dataset, version) != snapshot:
                    raise D.CacheError('version deletion preflight is stale')
                with self.cache._locked():
                    if self.cache._retirement_fence(dataset, version) != previous:
                        raise D.CacheError('another deletion fenced the version during preflight')
                    self.cache._check_snapshot(actor, dataset, version, tuple(snapshot['registration']))
                    owners, _ = self._permissions_locked(actor, dataset, version)
                    if (owners != snapshot['owners'] or sha(self.cache._tier(dataset, version)) != snapshot['tierSha256']
                            or self.cache._leases(dataset, version)
                            or exists(self.cache._paths(dataset, version)['.staging'])):
                        raise D.CacheError('version use changed before the persistent deletion fence')
                    folder = self.root/dataset
                    private_directory(folder)
                    previous = dict(schema=1, protocol='dataset-version-fence-v1', rootIdentity=list(self.cache._root_identity),
                        dataset=dataset, version=version, operationId=key, actor=actor.user_id, admin=actor.is_admin,
                        snapshotSha256=sha(snapshot), generation=sha([list(self.cache._root_identity), dataset, version, snapshot['registration']]),
                        state='FENCED', createdAt=self._now(), restoredRegistration=None)
                    D._write_json(folder/(version+'.json'), previous)
            with self.cache._retirement_scope(actor, key, dataset, version, sha(snapshot)):
                # Global metadata lock is released before waiting for a copier,
                # recovery stream, source guard, publish or another GC worker.
                with self.cache._lock_file('.locks/'+dataset+'.'+version+'.lock'):
                    if self.assert_quiescent is not None:
                        self.assert_quiescent(dataset, version)
                    return dict(protocol='dataset-version-fence-v1', operationId=key, machine=self.machine,
                        dataset=dataset, version=version, snapshotSha256=sha(snapshot), generation=previous['generation'],
                        state=previous['state'], drained=True)

    def _set_fence(self, row, state, restored=None):
        """Caller owns operation/version/global locks and the private scope."""
        previous = self.cache._retirement_fence(row['dataset'], row['version'])
        if (previous is None or previous['operationId'] != row['operationId']
                or previous['actor'] != row['actor'] or previous['admin'] != row['admin']
                or previous['snapshotSha256'] != sha(row['snapshot'])):
            raise D.CacheError('persistent deletion generation changed; no mutation permitted')
        allowed = {'FENCED':{'ISOLATED'}, 'ISOLATED':{'RESTORING','PURGED'},
                   'RESTORING':{'RESTORED'}, 'RESTORED':set(), 'PURGED':set()}
        if state != previous['state'] and state not in allowed[previous['state']]:
            raise D.CacheError('invalid persistent deletion fence transition')
        current = dict(previous, state=state, restoredRegistration=restored)
        D._write_json(self.root/row['dataset']/(row['version']+'.json'), current)

    def inspect(self, actor, dataset, version):
        self.cache._actor(actor)
        paths = self.cache._paths(dataset, version)
        with self.cache._version_locked(actor, dataset, version, snapshot=True) as value:
            record, registered = value
            with self.cache._locked():
                owners, provenance = self._permissions_locked(actor, dataset, version)
                tier = self.cache._tier(dataset, version)
                if self.cache._leases(dataset, version):
                    raise D.CacheError('active leases prevent version deletion')
                if any(not pin.startswith('authority-') for pin in tier['pins']):
                    raise D.CacheError('persistent use pins prevent version deletion')
                if exists(paths['.staging']):
                    raise D.CacheError('unfinished or unconfirmed staging must be reconciled before deletion')
                ready = self.cache._ready(paths, record['manifest'], version)
                snapshot = dict(protocol=PROTOCOL, machine=self.machine, dataset=dataset, version=version,
                    owners=owners, registration=list(registered), rootIdentity=list(self.cache._root_identity),
                    manifestSha256=sha(record['manifest']), complete=ready,
                    readyIdentity=identity(paths['ready'], True) if ready else None,
                    tierSha256=sha(tier), provenanceSha256=sha(private_read(self.cache.root/'.provenance'/dataset/(version+'.json'))
                        if exists(self.cache.root/'.provenance'/dataset/(version+'.json')) else None),
                    tierIdentity=identity(self.cache.root/'.tiers'/dataset/(version+'.json')) if exists(self.cache.root/'.tiers'/dataset/(version+'.json')) else None,
                    provenanceIdentity=identity(self.cache.root/'.provenance'/dataset/(version+'.json')) if exists(self.cache.root/'.provenance'/dataset/(version+'.json')) else None,
                    memberAllowed=bool(provenance and provenance['owners'] == owners and len(owners) == 1
                        and provenance['origin'] in {'upload', 'workspace', 'replica'}))
            if self.assert_quiescent is not None:
                self.assert_quiescent(dataset, version)
            snapshot['authority']=(self.authority.deletion_dependencies(actor,dataset,version)
                                   if self.authority is not None and tier['role']=='protected' and ready else None)
            if tier['role']=='cache' and self.recovery_references is None:
                raise D.CacheError('cache deletion requires fixed configured authority references')
            snapshot['authorityReferences']=(self.recovery_references(actor,dataset,version)
                                             if self.recovery_references is not None else [])
            return snapshot

    def _receipt(self, row):
        fence = self.cache._retirement_fence(row['dataset'], row['version'])
        if fence is None or fence['operationId'] != row['operationId'] or fence['snapshotSha256'] != sha(row['snapshot']):
            raise D.CacheError('retirement receipt has no matching persistent generation')
        return dict(protocol=PROTOCOL, operationId=row['operationId'], machine=row['machine'],
                    dataset=row['dataset'], version=row['version'], state=row['state'],
                    isolated=row['state'] == 'ISOLATED' and fence['state'] == 'ISOLATED', complete=row['snapshot']['complete'],
                    snapshotSha256=sha(row['snapshot']), generation=fence['generation'], fenceState=fence['state'],
                    authorityReferences=row['snapshot']['authorityReferences'],
                    retainUntil=row['retainUntil'], proofSha256=sha([row['binding'], row['moves'], row['dataIdentity'], row['revocations'], fence]))

    def status(self, actor, key):
        self.cache._actor(actor)
        with self._lock(key):
            row = self._journal(key)
            if not actor.is_admin and (row['actor'] != actor.user_id or row['admin'] != actor.is_admin):
                raise PermissionError('retirement operation belongs to another account')
            return self._receipt(row)  # Pure query: no clock write or replay.

    def _move(self, row, name, source, destination, expected, directory=False):
        if exists(source) and exists(destination):
            raise D.CacheError('ambiguous retirement paths; nothing will be overwritten')
        if exists(source):
            if identity(source, directory) != expected:
                raise D.CacheError('retirement source identity changed')
            if directory:
                D._rename_new(source, destination)
            else:
                self.cache._unregister_move_record(source, destination)
        if not exists(destination) or identity(destination, directory)[:4] != expected[:4]:
            raise D.CacheError('retirement move is not confirmed by the fixed inode')
        row['moves'][name] = identity(destination, directory)
        self._save(row)

    def isolate(self, actor, dataset, version, key, snapshot, *, _revoke=None):
        """Private, fixed-request worker; retry only this exact durable transaction."""
        self.cache._actor(actor)
        self.cache._paths(dataset, version)
        operation(key)
        self.fence(actor, dataset, version, key, snapshot)
        folder = self._folder(key)
        with self._lock(key), self.cache._retirement_scope(actor, key, dataset, version, sha(snapshot)):
            try:
                row = self._journal(key)
            except FileNotFoundError:
                if self.inspect(actor, dataset, version) != snapshot:
                    raise D.CacheError('version deletion preflight is stale')
                now = self._now()
                private_directory(folder)
                row = dict(schema=1, protocol=PROTOCOL, operationId=key, machine=self.machine,
                    actor=actor.user_id, admin=actor.is_admin, dataset=dataset, version=version,
                    snapshot=snapshot, binding=sha([actor.user_id, actor.is_admin, dataset, version, snapshot]),
                    rootIdentity=list(self.cache._root_identity), mountIdentity=list(self.cache.mount) if self.cache.mount is not None else None,
                    retentionSeconds=self.retention_seconds, retainUntil=None, createdAt=now, lastObservedAt=now,
                    state='ISOLATING', moves={}, dataIdentity=None, revocations=[], restoreRecordIdentity=None)
                D._write_json(folder/'RETIREMENT.json', row)
            if row['binding'] != sha([actor.user_id, actor.is_admin, dataset, version, snapshot]):
                raise PermissionError('retirement UUID belongs to another immutable request')
            if row['state'] == 'ISOLATED':
                self._verify_payload(row)
                with self.cache._locked():
                    self._set_fence(row, 'ISOLATED')
                return self._receipt(row)
            if row['state'] != 'ISOLATING':
                raise D.CacheError('retirement transaction cannot be replayed in this state')
            self._now(row)
            with self.cache._lock_file('.locks/' + dataset + '.' + version + '.lock'):
                with self.cache._locked():
                    authority_pins=self.cache._authority_pins(dataset,version)
                if authority_pins:
                    if _revoke is None:
                        raise D.CacheError('authority isolation requires confirmed dependent removal and grant revocation')
                    # Source version lock + persistent fence stay held, but
                    # metadata/global lock never spans enumeration, hashing,
                    # peer I/O, or an authenticated confirmation checker.
                    row['revocations']=_revoke(row)
                    if self.authority is None:
                        raise D.CacheError('confirmed authority revocation adapter is unavailable')
                    self.authority.verify_retirement_revocations(row)
                    self._save(row)
                if self.assert_quiescent is not None:
                    self.assert_quiescent(dataset,version)
                with self.cache._locked():
                    paths = self.cache._paths(dataset, version)
                    registry = self.cache._paths(dataset)['.registry']
                    if 'registration' not in row['moves'] and exists(registry/(version+'.json')):
                        owners, _ = self._permissions_locked(actor, dataset, version)
                        if owners != snapshot['owners'] or list(self.cache._record_identity(dataset, version)) != snapshot['registration']:
                            raise D.CacheError('registration or ownership changed during deletion')
                    if self.cache._leases(dataset, version) or exists(paths['.staging']):
                        raise D.CacheError('new lease or unfinished writer blocks version isolation')
                    tier = self.cache._tier(dataset, version)
                    if any(not pin.startswith('authority-') for pin in tier['pins']):
                        raise D.CacheError('new use pin blocks version isolation')
                    if any(pin.startswith('authority-') for pin in tier['pins']):
                        if not row['revocations']:
                            raise D.CacheError('authority revocation is not durably confirmed')
                    for name in ('payload', 'registration', 'metadata'):
                        private_directory(folder/name)
                    metadata = folder/'registration'/'dataset.json'
                    if not exists(metadata):
                        D._write_json(metadata, self.cache._dataset(actor, dataset))
                    moves = [('ready', paths['ready'], folder/'payload'/'ready', snapshot['readyIdentity'], True),
                             ('registration', registry/(version+'.json'), folder/'registration'/(version+'.json'), snapshot['registration'], False)]
                    for name, source, destination, expected, directory in moves:
                        if expected is not None:
                            self._move(row, name, source, destination, expected, directory)
                    for name, bucket in (('tier', '.tiers'), ('provenance', '.provenance')):
                        source = self.cache.root/bucket/dataset/(version+'.json')
                        destination = folder/'metadata'/(name+'.json')
                        expected = snapshot[name+'Identity']
                        if expected is not None:
                            self._move(row, name, source, destination, expected)
                        elif exists(source) or exists(destination):
                            raise D.CacheError('unexpected retirement metadata needs administrator inspection')
                # Full payload verification is outside the global metadata lock.
                record = private_read(folder/'registration'/(version+'.json'))
                if sha(record['manifest']) != snapshot['manifestSha256']:
                    raise D.CacheError('isolated immutable manifest changed')
                if snapshot['complete']:
                    ready = folder/'payload'/'ready'
                    if D._read_json(ready/'READY.json') != {'schema':1, 'version':version} or D._scan(ready/'data') != record['manifest']:
                        raise D.CacheError('isolated full data is not confirmed')
                    row['dataIdentity'] = identity(ready, True)
                self._verify_payload(row)
                row['retainUntil'] = self._now(row) + row['retentionSeconds']
                row['state'] = 'ISOLATED'
                self._save(row)
                with self.cache._locked():
                    self._set_fence(row, 'ISOLATED')
            return self._receipt(row)

    def _verify_payload(self, row, *, partial=False):
        authority=row['snapshot']['authority']
        if authority is not None and authority['grants']:
            if self.authority is None:
                raise D.CacheError('retained authority revocation adapter is unavailable')
            self.authority.verify_retirement_revocations(row)
        folder = self._folder(row['operationId'])
        record = private_read(folder/'registration'/(row['version']+'.json'))
        manifest = D._manifest(record['manifest'])
        if sha(manifest) != row['snapshot']['manifestSha256']:
            raise D.CacheError('isolated manifest identity changed')
        for name in ('tier','provenance'):
            path = folder/'metadata'/(name+'.json')
            value = private_read(path) if exists(path) else self.cache._default_tier() if name == 'tier' else None
            if sha(value) != row['snapshot'][name+'Sha256']:
                raise D.CacheError('retained permission or recovery metadata changed')
        ready = folder/'payload'/'ready'
        if not row['snapshot']['complete']:
            if exists(ready):
                raise D.CacheError('unexpected complete data in metadata-only retirement')
            return record
        if not exists(ready):
            if partial:
                return record
            raise D.CacheError('retained complete data is missing')
        if identity(ready, True)[:2] != row['dataIdentity'][:2]:
            raise D.CacheError('retained data directory identity changed')
        with D._directory(ready) as fd:
            names = set(os.listdir(fd))
        allowed = {'data', 'READY.json', 'manifest.json'}
        if names - allowed or not partial and names != allowed:
            raise D.CacheError('unexpected retained data files')
        if exists(ready/'READY.json') and D._read_json(ready/'READY.json') != {'schema':1, 'version':row['version']}:
            raise D.CacheError('retained READY receipt changed')
        if exists(ready/'manifest.json') and D._read_json(ready/'manifest.json') != manifest:
            raise D.CacheError('retained full manifest changed')
        if exists(ready/'data'):
            actual = D._scan(ready/'data')
            if partial:
                files = {entry['path']:entry for entry in manifest['files']}
                if any(files.get(entry['path']) != entry for entry in actual['files']) or not set(actual['directories']) <= set(manifest['directories']):
                    raise D.CacheError('unconfirmed files in interrupted purge')
            elif actual != manifest:
                raise D.CacheError('retained full payload verification failed')
        elif not partial:
            raise D.CacheError('retained full payload is missing')
        return record

    def restore(self, actor, key):
        """Administrator-only local restore; old grants are never reinstated."""
        self.cache._actor(actor, admin=True)
        row = self._journal(key)
        original_actor = type(actor)(row['actor'], row['admin'])
        with self.cache._retirement_scope(original_actor, key, row['dataset'], row['version'], sha(row['snapshot'])):
            return self._restore(actor, key)

    def _restore(self, actor, key):
        with self._lock(key):
            row = self._journal(key)
            now = self._now(row)
            if row['state'] == 'RESTORED':
                with self.cache._locked():
                    if list(self.cache._record_identity(row['dataset'], row['version'])) != row['moves'].get('restore-registration'):
                        raise D.CacheError('restored registration changed; no replay permitted')
                    self._set_fence(row, 'RESTORED', row['moves']['restore-registration'])
                return self._receipt(row)
            if row['state'] not in {'ISOLATED', 'RESTORING'} or row['retainUntil'] is None or now >= row['retainUntil']:
                raise D.CacheError('restore is only available during the retention period')
            dataset, version = row['dataset'], row['version']
            folder = self._folder(key)
            with self.cache._lock_file('.locks/' + dataset + '.' + version + '.lock'):
                paths = self.cache._paths(dataset, version)
                registry = self.cache._paths(dataset)['.registry']
                record = private_read(folder/'registration'/(version+'.json'))
                metadata = private_read(folder/'registration'/'dataset.json')
                ready = folder/'payload'/'ready'
                if 'restore-ready' not in row['moves'] and exists(ready):
                    self._verify_payload(row)
                with self.cache._locked():
                    if self._now(row) >= row['retainUntil']:
                        raise D.CacheError('restore retention period expired during verification')
                    if self.cache._leases(dataset, version) or exists(paths['.staging']):
                        raise D.CacheError('restore refuses active users or unfinished writers')
                    if self.cache._tier(dataset, version)['pins']:
                        raise D.CacheError('restore refuses new persistent use pins')
                    if row['state'] == 'ISOLATED' and (exists(paths['ready']) or exists(registry/(version+'.json'))):
                        raise D.CacheError('restore never overwrites a new registration or payload')
                    if exists(registry/'dataset.json') and D._read_json(registry/'dataset.json') != metadata:
                        raise D.CacheError('restore owner binding conflicts with the current dataset')
                    if row['state'] == 'ISOLATED':
                        row['state'] = 'RESTORING'
                        self._save(row)
                    self._set_fence(row, 'RESTORING')
                    restored_record = folder/'metadata'/'restore-registration.json'
                    if row['restoreRecordIdentity'] is None:
                        if exists(registry/(version+'.json')):
                            raise D.CacheError('restore never overwrites an unconfirmed registration')
                        if not exists(restored_record):
                            D._write_json(restored_record, record)
                        if private_read(restored_record) != record:
                            raise D.CacheError('pending restored registration changed')
                        row['restoreRecordIdentity'] = identity(restored_record)
                        self._save(row)
                    D._mkdir(registry)
                    D._mkdir(paths['ready'].parent)
                    if row['snapshot']['complete']:
                        self._move(row, 'restore-ready', ready, paths['ready'], row['dataIdentity'], True)
                    # New immutable registration identity is a new generation.
                    # The old proof, grants and previous archive event stay dead.
                    D._write_json(registry/'dataset.json', metadata)
                    self._move(row, 'restore-registration', restored_record, registry/(version+'.json'), row['restoreRecordIdentity'])
                    tier = private_read(folder/'metadata'/'tier.json') if exists(folder/'metadata'/'tier.json') else self.cache._default_tier()
                    tier['pins'] = {pin:value for pin,value in tier['pins'].items() if not pin.startswith('authority-')}
                    tier['role'], tier['recovery'] = 'protected', None
                    self.cache._write_tier(dataset, version, tier)
                    proof = private_read(folder/'metadata'/'provenance.json') if exists(folder/'metadata'/'provenance.json') else None
                    if (row['snapshot']['memberAllowed'] and proof is not None
                            and proof['origin'] in {'upload','workspace','replica'}
                            and proof['registrationIdentity'] == row['snapshot']['registration']
                            and proof['owners'] == metadata['owners'] and len(metadata['owners']) == 1):
                        internal = type(actor)(metadata['owners'][0], True)
                        self.cache._write_provenance(internal, dataset, version, metadata['owners'], proof['origin'], key)
                    else:
                        self.cache._write_provenance(actor, dataset, version, metadata['owners'], 'admin', None)
                    row['state'] = 'RESTORED'
                    self._save(row)
                    self._set_fence(row, 'RESTORED', row['moves']['restore-registration'])
            return self._receipt(row)

    @staticmethod
    def _writable_tree(path):
        def visit(fd):
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise D.CacheError('unsafe retained cleanup directory')
            for name in os.listdir(fd):
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        visit(child)
                    finally:
                        os.close(child)
                elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
                    raise D.CacheError('retained cleanup rejects links and special files')
            os.fchmod(fd, stat.S_IMODE(os.fstat(fd).st_mode) | stat.S_IWUSR)
        with D._directory(path) as fd:
            visit(fd)

    def purge(self, actor, key):
        """Local collection hook only. No RPC/peer route or timer is installed."""
        self.cache._actor(actor, admin=True)
        row = self._journal(key)
        original_actor = type(actor)(row['actor'], row['admin'])
        with self.cache._retirement_scope(original_actor, key, row['dataset'], row['version'], sha(row['snapshot'])):
            return self._purge(actor, key)

    def _purge(self, actor, key):
        if not shutil.rmtree.avoids_symlink_attacks:
            raise D.CacheError('descriptor-safe cleanup is unavailable')
        with self._lock(key):
            row = self._journal(key)
            now = self._now(row)
            if row['state'] == 'PURGED':
                with self.cache._locked():
                    self._set_fence(row,'PURGED')
                return self._receipt(row)
            if row['state'] not in {'ISOLATED', 'PURGING'} or row['retainUntil'] is None or now < row['retainUntil']:
                raise D.CacheError('confirmed complete isolation and expired retention are required')
            folder = self._folder(key)
            with self.cache._lock_file('.locks/' + row['dataset'] + '.' + row['version'] + '.lock'):
                payload = folder/'payload'
                with D._directory(payload) as fd:
                    if set(os.listdir(fd)) - {'ready'}:
                        raise D.CacheError('unknown retirement payload; cleanup forbidden')
                self._verify_payload(row, partial=row['state'] == 'PURGING')
                row['state'] = 'PURGING'
                self._save(row)
                if exists(payload/'ready'):
                    self._writable_tree(payload/'ready')
                    shutil.rmtree(payload/'ready')
                    with D._directory(payload) as fd:
                        os.fsync(fd)
                row['state'] = 'PURGED'
                self._save(row)
                with self.cache._locked():
                    self._set_fence(row, 'PURGED')
            return self._receipt(row)

    def collect_expired(self, actor, *, enabled=False, max_versions=16):
        self.cache._actor(actor, admin=True)
        if type(enabled) is not bool or type(max_versions) is not int or not 1 <= max_versions <= 1000:
            raise D.CacheError('invalid trusted collection policy')
        if not enabled:
            return dict(enabled=False, purged=[], skipped=[])
        with D._directory(self.cache.root/'.trash') as fd:
            names = sorted(os.listdir(fd))
        purged, skipped = [], []
        for name in names:
            if not re.fullmatch(r'retire-[a-f0-9]{32}', name):
                continue
            key = str(uuid.UUID(name[7:]))
            if len(purged) >= max_versions:
                break
            try:
                result = self.purge(actor, key)
                if result['state'] == 'PURGED':
                    purged.append(key)
            except (ValueError, OSError, TypeError, KeyError):
                skipped.append(key)  # Never turn an unknown journal into success.
        return dict(enabled=True, purged=purged, skipped=skipped)
