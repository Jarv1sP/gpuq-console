#!/usr/bin/env python3
"""Durable preparation handoff and whole-download holds; no TTL release.

Authenticated executor code owns this interface, never raw client identities.
prepare/handoff serialize using an independent journal flock; the runner does
not have to reacquire the executor's submission job flock. The submission path
still owns its existing job flock. cancel_prepare MUST hold that job flock and
have trusted proof that the job was never dispatched. finalize_training MUST
hold the same job flock and have fresh trusted proof of either never-dispatched
or native terminal AND all execution units stopped. No client-provided flag is
proof. Unknown native/unit state must retain the hold. The scheduler termination
path releases its legacy receipt then finalizes the retained journal.
Lock order: job flock (training only), this journal flock, cache/version locks.
Downloads use their own namespace, never the peer transfer's lease identity.
"""
from contextlib import contextmanager
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
USER = re.compile(r'(builtin-admin|demo-user-[0-9]+)\Z')
STATES = {'ACQUIRING', 'HELD', 'HANDED_OFF', 'CANCELING', 'CANCELED', 'COMPLETING', 'COMPLETED',
          'RELEASING', 'RELEASED'}


class StorageLeases:
    def __init__(self, executor):
        self.n = executor
        self.d, _ = executor.dataset_cache()  # Current mount guard, not a cached path.
        self.root = executor.ROOT / 'storage-leases'
        for path in (self.root, self.root / 'training', self.root / 'downloads'):
            self.d._mkdir(path)
            info = path.stat()
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError('Unsafe storage lease state directory')

    def _identity(self, key, user):
        if not isinstance(key, str) or not UUID.fullmatch(key):
            raise ValueError('Invalid storage lease UUID')
        if not isinstance(user, str) or not USER.fullmatch(user):
            raise ValueError('Invalid storage lease owner')
        self.n.workspace(user)

    def _training(self, job):
        self._identity(job.get('id'), job.get('userId'))
        refs = self.n.dataset_refs(job)
        return {'id': job['id'], 'userId': job['userId'],
                'references': json.loads(json.dumps(refs))}

    def _download(self, args, extra=()):
        if not isinstance(args, dict) or set(args) - {'id', 'userId', 'reference', 'hostAdmin'} - set(extra):
            raise ValueError('Invalid download lease fields')
        self._identity(args.get('id'), args.get('userId'))
        if type(args.get('hostAdmin', False)) is not bool:
            raise ValueError('Invalid download administrator identity')
        ref = args.get('reference')
        if (not isinstance(ref, dict) or not {'dataset', 'version'} <= set(ref)
                or set(ref) - {'kind', 'dataset', 'version'} or ref.get('kind', 'datasets') != 'datasets'):
            raise ValueError('Download requires a fixed dataset reference')
        self.d._identifier(ref['dataset'])
        self.d._identifier(ref['version'], self.d.HASH_RE)
        return {'id': args['id'], 'userId': args['userId'],
                'reference': {'kind': 'datasets', 'dataset': ref['dataset'], 'version': ref['version']},
                'hostAdmin': args.get('hostAdmin', False)}

    @contextmanager
    def _lock(self, kind, key, *, create=True):
        parent = self.root / kind
        folder = parent / key
        # Serialize admission so retained permanent fences cannot grow unbounded.
        with self.d._directory(parent) as parent_fd:
            fd = self._open_lock(parent_fd, '.history.lock')
            try:
                self._safe_fd(fd)
                fcntl.flock(fd, fcntl.LOCK_EX)
                try:
                    present = os.stat(key, dir_fd=parent_fd, follow_symlinks=False)
                except FileNotFoundError:
                    present = None
                if present is not None and not stat.S_ISDIR(present.st_mode):
                    raise ValueError('Unsafe storage lease journal directory')
                if present is None and not create:
                    folder = None
                elif present is None and len(os.listdir(parent_fd)) >= 10001:
                    raise ValueError('Storage lease history is full; reconcile retained fences')
                if folder is not None:
                    self.d._mkdir(folder)
            finally:
                os.close(fd)
        if folder is None:
            yield None
            return
        with self.d._directory(folder) as directory:
            if stat.S_IMODE(os.fstat(directory).st_mode) != 0o700:
                raise ValueError('Unsafe storage lease journal directory')
            fd = self._open_lock(directory, '.lock')
            try:
                self._safe_fd(fd)
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield folder / 'record.json'
            finally:
                os.close(fd)

    @staticmethod
    def _open_lock(directory, name):
        # O_CREAT|O_NOFOLLOW can return ENOENT during concurrent first creation
        # on macOS. Split atomic exclusive creation from nofollow existing open;
        # no retry loop, and neither path follows a symlink or blocks on a FIFO.
        try:
            return os.open(name, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NONBLOCK,
                           0o600, dir_fd=directory)
        except FileExistsError:
            return os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)

    def _safe_fd(self, fd):
        info = self.d._regular(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Unsafe storage lease metadata')

    def _load(self, path, binding):
        with self.d._directory(path.parent) as directory:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                self._safe_fd(fd)
                if os.fstat(fd).st_size > 65536:
                    raise ValueError('Storage lease journal too large')
                record = json.loads(os.read(fd, 65537))
            finally:
                os.close(fd)
        if (not isinstance(record, dict) or record.get('schema') != 1
                or record.get('binding') != binding or record.get('state') not in STATES
                or not isinstance(record.get('leases'), list) or len(record['leases']) > 16):
            raise ValueError('Storage lease identity or journal changed')
        expected = len(binding['references']) if 'references' in binding else 1
        if (len(record['leases']) > expected or record['state'] in ('HELD', 'HANDED_OFF')
                and len(record['leases']) != expected):
            raise ValueError('Completed storage hold has incomplete lease metadata')
        return record

    def _save(self, path, record):
        # Per-UUID lock isolates _write_json's interrupted temporary cleanup.
        self.d._write_json(path, record)

    def _initial(self, path, binding):
        try:
            return self._load(path, binding)
        except FileNotFoundError:
            record = {'schema': 1, 'binding': binding, 'state': 'ACQUIRING',
                      'leases': [], 'createdAt': time.time()}
            self._save(path, record)  # Intent is durable BEFORE acquiring anything.
            return record

    def _require(self, cache, binding, ref, lease, job_id, *, ready=False):
        if (not isinstance(lease, dict) or set(lease) != {'leaseId', 'dataset', 'version', 'path', 'readOnly'}
                or lease.get('dataset') != ref['dataset']
                or lease.get('version') != ref['version'] or lease.get('readOnly') is not True):
            raise ValueError('Stored dataset lease identity changed')
        with cache._locked():
            paths = cache._paths(ref['dataset'], ref['version'])
            if lease['path'] != str(paths['ready'] / 'data'):
                raise ValueError('Stored dataset lease path changed')
            if ready:
                record = cache._record(self.d.Principal(binding['userId'], False), ref['dataset'], ref['version'])
                if not cache._ready(paths, record['manifest'], ref['version']):
                    raise ValueError('Prepared dataset is no longer READY')
            if not any(value['id'] == lease.get('leaseId') and value['owner'] == binding['userId']
                       and value['jobId'] == job_id for value in cache._leases(ref['dataset'], ref['version'])):
                raise ValueError('Persistent storage lease is missing; reconcile before continuing')

    def prepare(self, job):
        """Hold every selected READY version using final job ID and own flock."""
        binding = self._training(job)
        with self._lock('training', binding['id']) as path:
            record = self._initial(path, binding)
            if record['state'] not in ('ACQUIRING', 'HELD'):
                raise ValueError('Preparation was finalized; no same-ID reacquisition')
            module, cache = self.n.dataset_cache()
            actor = module.Principal(binding['userId'], False)
            for index, ref in enumerate(binding['references']):
                if index < len(record['leases']):
                    self._require(cache, binding, ref, record['leases'][index], binding['id'])
                lease = cache.acquire_lease(actor, ref['dataset'], ref['version'], binding['id'])
                if index < len(record['leases']):
                    if record['leases'][index] != lease:
                        raise ValueError('Prepared lease path or identity changed')
                else:
                    record['leases'].append(lease)
                    self._save(path, record)
            record['state'] = 'HELD'
            self._save(path, record)
            return {'jobId': binding['id'], 'state': 'HELD', 'leases': record['leases']}

    def handoff(self, job):
        """Own flock: persist scheduler receipt without dropping any lease."""
        binding = self._training(job)
        with self._lock('training', binding['id']) as path:
            record = self._load(path, binding)
            return self._handoff_locked(job, binding, path, record)

    def handoff_if_present(self, job):
        """None means exactly no journal, never an ACL/mount/lease read failure."""
        binding = self._training(job)
        with self._lock('training', binding['id'], create=False) as path:
            if path is None:
                return None
            with self.d._directory(path.parent) as directory:
                try:
                    os.stat(path.name, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    return None
            return self._handoff_locked(job, binding, path, self._load(path, binding))

    def _handoff_locked(self, job, binding, path, record):
        if record['state'] not in ('HELD', 'HANDED_OFF') or len(record['leases']) != len(binding['references']):
            raise ValueError('Preparation hold is not ready for handoff')
        _, cache = self.n.dataset_cache()
        for ref, lease in zip(binding['references'], record['leases']):
            self._require(cache, binding, ref, lease, binding['id'], ready=True)
        destination = self.n.ROOT / 'jobs' / (binding['id'] + '.datasets.json')
        self.d._mkdir(destination.parent)
        if destination.exists():
            if self.d._read_json(destination) != record['leases']:
                raise ValueError('Existing scheduler lease receipt differs')
        else:
            self.n.atomic_json(destination, record['leases'])
        record['state'] = 'HANDED_OFF'
        self._save(path, record)
        return record['leases']

    def _release_matching(self, binding, refs, job_id):
        module, cache = self.n.dataset_cache()
        for ref in refs:
            with cache._locked():
                matches = [lease for lease in cache._leases(ref['dataset'], ref['version'])
                           if lease['owner'] == binding['userId'] and lease['jobId'] == job_id]
            for lease in matches:
                cache.release_lease(module.Principal('builtin-admin', True),
                                    ref['dataset'], ref['version'], lease['id'])
            # Missing registration after a prior successful unlink is fine.
            with cache._locked():
                if any(lease['owner'] == binding['userId'] and lease['jobId'] == job_id
                       for lease in cache._leases(ref['dataset'], ref['version'])):
                    raise ValueError('Storage lease release is not confirmed')

    def cancel_prepare(self, job):
        """Job flock + trusted NEVER-DISPATCHED proof required, not a public flag."""
        binding = self._training(job)
        with self._lock('training', binding['id']) as path:
            record = self._initial(path, binding)
            receipt = self.n.ROOT / 'jobs' / (binding['id'] + '.datasets.json')
            if record['state'] == 'HANDED_OFF' or receipt.exists():
                raise ValueError('Scheduler owns this hold; reconcile job termination')
            if record['state'] not in ('ACQUIRING', 'HELD', 'CANCELING', 'CANCELED'):
                raise ValueError('Invalid preparation cancellation state')
            record['state'] = 'CANCELING'
            self._save(path, record)  # Permanent fence precedes every release.
            self._release_matching(binding, binding['references'], binding['id'])
            record['state'] = 'CANCELED'
            self._save(path, record)
            return {'jobId': binding['id'], 'state': 'CANCELED', 'released': True}

    def finalize_training(self, job):
        """Trusted stopped/never-dispatched proof + main job flock REQUIRED.

        Finalize only an existing preparation journal. This remains retryable
        after the legacy scheduler receipt has already been removed, or a
        partial cache release lost its reply. Never infer stop from that absence.
        """
        binding = self._training(job)
        with self._lock('training', binding['id'], create=False) as path:
            if path is None:
                return None
            try:
                record = self._load(path, binding)
            except FileNotFoundError:
                # _load reads only the journal; it does not query cache state.
                return None
            if record['state'] not in ('ACQUIRING', 'HELD', 'HANDED_OFF', 'CANCELING',
                                       'CANCELED', 'RELEASING', 'RELEASED'):
                raise ValueError('Invalid training finalization state')
            record['state'] = 'RELEASING'
            self._save(path, record)
            self._release_matching(binding, binding['references'], binding['id'])
            record['state'] = 'RELEASED'
            self._save(path, record)
            return {'jobId': binding['id'], 'state': 'RELEASED', 'released': True}

    def _snapshots(self):
        spec = importlib.util.spec_from_file_location('gpuq_storage_download_snapshots', self.n.HERE / 'snapshot-sync.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.SnapshotSync(self.n)

    def _export(self, binding, lease, operation, fields):
        ref = binding['reference']
        return self._snapshots().export(operation, {'userId': binding['userId'],
            'hostAdmin': binding['hostAdmin'], 'dataset': ref['dataset'], 'version': ref['version'], **fields},
            _download_lease=(binding['id'], lease['leaseId']))

    def download_open(self, args):
        binding = self._download(args)
        with self._lock('downloads', binding['id']) as path:
            record = self._initial(path, binding)
            if record['state'] not in ('ACQUIRING', 'HELD'):
                raise ValueError('Download was finalized; use a new UUID')
            module, cache = self.n.dataset_cache()
            ref = binding['reference']
            if record['leases']:
                self._require(cache, binding, ref, record['leases'][0], 'download:' + binding['id'])
            lease = cache.acquire_lease(module.Principal(binding['userId'], binding['hostAdmin']),
                                        ref['dataset'], ref['version'], 'download:' + binding['id'])
            if record['leases'] and record['leases'] != [lease]:
                raise ValueError('Download lease identity changed')
            record.update(state='HELD', leases=[lease])
            self._save(path, record)
            info = self._export(binding, lease, 'datasets.snapshot.info', {})
            if 'snapshot' in record and record['snapshot'] != info:
                raise ValueError('Fixed download snapshot changed')
            record['snapshot'] = info
            self._save(path, record)
            return {'id': binding['id'], 'state': 'OPEN'}

    def download_export(self, operation, args):
        if operation not in ('datasets.snapshot.info', 'datasets.snapshot.manifest', 'datasets.snapshot.get'):
            raise ValueError('Invalid download snapshot operation')
        fields = {'offset'} if operation.endswith('.manifest') else {'path', 'offset'} if operation.endswith('.get') else set()
        binding = self._download(args, fields)
        with self._lock('downloads', binding['id']) as path:
            record = self._load(path, binding)
            if record['state'] != 'HELD' or len(record['leases']) != 1:
                raise ValueError('Download is not held or was finalized')
            _, cache = self.n.dataset_cache()
            self._require(cache, binding, binding['reference'], record['leases'][0], 'download:' + binding['id'])
            return self._export(binding, record['leases'][0], operation, {key: args[key] for key in fields if key in args})

    def download_finish(self, args):
        binding = self._download(args, {'state'})
        terminal = args.get('state')
        if terminal not in ('CANCELED', 'COMPLETED'):
            raise ValueError('Explicit canceled or completed download required')
        with self._lock('downloads', binding['id']) as path:
            record = self._initial(path, binding)
            if record.get('finishState', terminal) != terminal:
                raise ValueError('Download terminal identity cannot change')
            if record['state'] not in ('ACQUIRING', 'HELD', 'CANCELING', 'CANCELED', 'COMPLETING', 'COMPLETED'):
                raise ValueError('Invalid download finalization state')
            record.update(state='CANCELING' if terminal == 'CANCELED' else 'COMPLETING', finishState=terminal)
            self._save(path, record)  # Same lock excludes every in-flight read.
            self._release_matching(binding, [binding['reference']], 'download:' + binding['id'])
            record['state'] = terminal
            self._save(path, record)
            return {'id': binding['id'], 'state': terminal, 'released': True}
