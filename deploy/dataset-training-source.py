"""Trusted, fixed local training sources; no request path or cache fallback.

Legacy jobs keep their exact cache binding. Explicit warehouse jobs bind the
configured local protected authority, not a remote grant or a media/name guess.
All consumers share the same durable source identity and ordinary version lease.
"""
from contextlib import closing, contextmanager
import json
import os
import sqlite3
import time


PROTOCOL = 'dataset-training-source-v1'


def read_mode(job):
    mode = job.get('datasetReadMode', 'cache')
    if not isinstance(mode, str) or mode not in ('cache', 'warehouse'):
        raise ValueError('Invalid immutable dataset read mode')
    return mode


def _json(value):
    return json.loads(json.dumps(value))


class TrainingSources:
    def __init__(self, executor):
        self.n = executor

    def _warehouse(self):
        config = self.n.CONFIG
        archive = config.get('storageArchive', {})
        if (config.get('storageAuthority') != {'enabled': True}
                or not isinstance(archive, dict) or archive.get('enabled') is not True
                or archive.get('machine') != config.get('machine')):
            raise ValueError('Local protected warehouse training is unavailable')
        module, cache = self.n.dataset_source_cache()
        module._identifier(config.get('machine'))
        module._identifier(archive.get('authority'))
        store = self.n.storage_authority()
        selected = config.get('storageWarehouse')
        selected = selected if selected is not None else config.get('datasets')
        if not isinstance(selected, dict):
            raise ValueError('Fixed local warehouse configuration is unavailable')
        self.n.dataset_mount_check(selected)
        if (store is None or store.machine != config['machine']
                or store.cache.root != cache.root or store.cache._root_identity != cache._root_identity
                or str(cache.root) != selected.get('root') or cache.mount is None):
            raise ValueError('Fixed protected warehouse authority differs')
        with cache._locked(), module._directory(cache.root) as fd:
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) != cache._root_identity:
                raise ValueError('Fixed warehouse root changed')
        source = {'kind': 'warehouse', 'machine': config['machine'], 'authority': archive['authority'],
                  'rootIdentity': list(cache._root_identity),
                  'deviceIdentity': [cache.mount[1], cache.mount[2]]}
        return module, cache, store, source

    def binding(self, job, base):
        if read_mode(job) == 'cache':
            return base
        if not base['references']:
            raise ValueError('Warehouse training requires fixed dataset versions')
        _, _, _, source = self._warehouse()
        return {**base, 'datasetReadMode': 'warehouse', 'source': source}

    def cache(self, binding):
        if binding.get('datasetReadMode', 'cache') == 'cache':
            return self.n.dataset_cache()
        if binding.get('datasetReadMode') != 'warehouse':
            raise ValueError('Invalid durable training source mode')
        module, cache, _, source = self._warehouse()
        if binding.get('source') != source:
            raise ValueError('Durable warehouse source root or authority changed')
        return module, cache

    def cancel_unseen(self, job):
        """Job flock + validated private cancel only, BEFORE first spec write.

        A missing journal for an existing identity remains unknown. Only a
        wholly unseen node identity can establish a new, empty permanent fence;
        no receipt absence or caller-provided never-dispatched flag proves it.
        The ordinary cancel path subsequently persists its spec and finalizes
        this journal. A crash before that still prevents same-ID preparation.
        """
        if read_mode(job) != 'warehouse':
            raise ValueError('Unseen cancellation requires warehouse mode')
        key = job['id']
        paths = [self.n.ROOT / 'jobs' / (key + suffix) for suffix in
                 ('.json', '.dataset-dispatch-attempted', '.datasets.json',
                  '.dataset-not-submitted.json', '.canceled')]
        paths.append(self.n.ROOT / 'storage-leases' / 'training' / key)
        if any(os.path.lexists(path) for path in paths):
            return False
        with closing(sqlite3.connect(f'file:{self.n.CONFIG["database"]}?mode=ro', uri=True)) as db:
            if db.execute('SELECT id FROM jobs WHERE submit_key=?', (key,)).fetchone():
                return False
        leases = self.n.storage_leases()
        binding = leases._training(job)
        with leases._lock('training', key) as path:
            if os.path.lexists(path):
                raise ValueError('Unseen warehouse cancellation journal changed')
            leases._save(path, {'schema': 1, 'binding': binding, 'state': 'CANCELED',
                                'leases': [], 'sourceSnapshots': [], 'createdAt': time.time()})
        return True

    @contextmanager
    def guard(self, binding, ref, expected=None, *, require_ready=True):
        """Authority reference -> version -> short metadata locks, never a scan.

        The persistent lease then protects the source after these locks leave.
        A READY tree was fully hashed before publication; this checks its current
        immutable manifest, owner, root, generation and READY identities again.
        """
        module, cache = self.cache(binding)
        _, _, store, _ = self._warehouse()
        actor = module.Principal(binding['userId'], False)
        dataset, version = ref['dataset'], ref['version']
        # Authenticate before creating an authority-reference lock for guessed IDs.
        cache._record_snapshot(actor, dataset, version)
        with store.reference_lock(dataset, version), cache._version_locked(actor, dataset, version, snapshot=True) as value:
            record, registration = value
            paths = cache._paths(dataset, version)
            ready, ready_identity = cache._ready_snapshot(paths, record['manifest'], version)
            snapshot = {'dataset': dataset, 'version': version,
                        'registration': list(registration), 'ready': _json(ready_identity)}
            with cache._locked():
                store.assert_live(dataset, version)
                cache._check_snapshot(actor, dataset, version, registration)
                cache._check_ready_snapshot(paths, ready_identity)
                if cache._tier(dataset, version)['role'] != 'protected':
                    raise ValueError('Warehouse training requires a protected original')
                if require_ready and not ready:
                    raise ValueError('Fixed warehouse original is not READY')
                if expected is not None and expected != snapshot:
                    raise ValueError('Durable warehouse registration or READY identity changed')
            yield module, cache, record, snapshot, ready
            with cache._locked():
                store.assert_live(dataset, version)
                cache._check_snapshot(actor, dataset, version, registration)
                cache._check_ready_snapshot(paths, ready_identity)
                if cache._tier(dataset, version)['role'] != 'protected':
                    raise ValueError('Warehouse original protection changed')

    def status(self, args):
        fields = {'userId', 'hostAdmin', 'dataset', 'version', 'datasetReadMode'}
        if (not isinstance(args, dict) or set(args) != fields or args.get('hostAdmin') is not False):
            raise ValueError('Invalid private training source fields')
        mode = read_mode(args)
        module, hot = self.n.dataset_cache()
        actor = module.Principal(args['userId'], False)
        self.n.workspace(args['userId'])
        module._identifier(args['dataset']); module._identifier(args['version'], module.HASH_RE)
        ref = {'dataset': args['dataset'], 'version': args['version']}
        result = {'protocol': PROTOCOL, 'machine': self.n.CONFIG.get('machine'), **ref,
                  'datasetReadMode': mode, 'datasetWarehouseRead': 0, 'authority': None,
                  'warehouseReady': False}
        if mode == 'warehouse':
            binding = self.binding({'datasetReadMode': mode}, {'userId': args['userId'], 'references': [ref]})
            with self.guard(binding, ref, require_ready=False) as (_, cache, record, _, ready):
                result.update(datasetWarehouseRead=1, authority=binding['source']['authority'],
                              warehouseReady=ready, state='READY' if ready else 'NOT_READY', remainingBytes=0 if ready else None)
                if ready: result['reference'] = ref
                manifest = record['manifest']
                result.update(bytes=sum(item['size'] for item in manifest['files']),
                              files=len(manifest['files']), directories=len(manifest['directories']),
                              footprintBytes=cache._footprint(manifest), manifestBytes=len(module._json_bytes(manifest)))
            return result
        warehouse = self.n.storage_warehouse()
        cache = hot
        if warehouse is not None and warehouse.contains(actor, ref['dataset'], ref['version']):
            cache = warehouse.cold
            current = warehouse.status(actor, **ref)
            result['reference'] = {'dataset': warehouse.cache_name(ref['dataset']), 'version': ref['version']}
        else:
            current = hot.status(actor, **ref)
        record, identity = cache._record_snapshot(actor, **ref)
        with cache._locked(): cache._check_snapshot(actor, ref['dataset'], ref['version'], identity)
        result.update(state=current['state'], canPrepare=(current.get('canPrepare') is True
                      or current['state'] == 'READY' or record['sourceId'] in cache.sources),
                      warehouseReady=current.get('warehouseReady') is True,
                      remainingBytes=current.get('remainingBytes', 0 if current['state'] == 'READY' else None))
        if current['state'] == 'READY': result['reference'] = current.get('storageReference', ref)
        manifest = record['manifest']
        result.update(bytes=sum(item['size'] for item in manifest['files']), files=len(manifest['files']),
                      directories=len(manifest['directories']), footprintBytes=cache._footprint(manifest),
                      manifestBytes=len(module._json_bytes(manifest)))
        if current['state'] == 'REGISTERED':
            result['remainingBytes'] = result['bytes']
        return result
