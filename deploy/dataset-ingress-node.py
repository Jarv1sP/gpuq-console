"""Private control-plane lookup; never create a user workspace or upload."""
import hashlib
from contextlib import contextmanager
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace


def _capacity_cache(executor):
    """Inspect an initialized, fixed HDD root without any creating factory."""
    definition=importlib.util.spec_from_file_location('gpuq_ingress_capacity_cache',Path(__file__).with_name('dataset-cache.py'))
    module=importlib.util.module_from_spec(definition);definition.loader.exec_module(module)
    config=executor.CONFIG.get('datasets')
    if not isinstance(config,dict) or set(config)-{'root','mountPoint','sources','reserveBytes','uploads','retireRetentionDays'}:
        raise ValueError('Dataset storage is not configured')
    tier=executor.CONFIG.get('storageTier',{'enabled':False})
    if (not isinstance(tier,dict) or set(tier)-{'enabled','budgetBytes','highWater','lowWater'}
            or type(tier.get('enabled',False)) is not bool
            or tier.get('enabled',False) and (type(tier.get('budgetBytes')) is not int or not 0<tier['budgetBytes']<=2**63-1)):
        raise ValueError('Invalid trusted dataset cache policy')
    workspace_reserve=executor.CONFIG.get('workspaceReserveBytes')
    if ('workspaceReserveBytes' in executor.CONFIG and
            (type(workspace_reserve) is not int or not 0<=workspace_reserve<=2**63-1)):
        raise ValueError('Invalid workspace free-space reserve')

    def existing(value):
        executor.dataset_mount_check(value)
        cache=module.DatasetCache.__new__(module.DatasetCache)
        cache.root=module._absolute(value.get('root','/data2/datasets'))
        cache.reserve_bytes=value.get('reserveBytes',10*1024**3)
        if (str(cache.root) in module.BROAD or str(cache.root)!=value.get('root','/data2/datasets')
                or type(cache.reserve_bytes) is not int or cache.reserve_bytes<0):
            raise ValueError('Unsafe capacity root or reserve')
        for key,source in dict(value.get('sources') or {}).items():
            module._identifier(key)
            path=module._absolute(source)
            if (str(path) in module.BROAD or path.parent in (Path('/home'),Path('/Users'))
                    or any(part in module.FORBIDDEN for part in path.parts)
                    or any(path==Path(parent) or Path(parent) in path.parents for parent in module.SYSTEM)
                    or path==cache.root or path in cache.root.parents or cache.root in path.parents):
                raise ValueError('Unsafe approved source directory')
        cache.mount_point=module._absolute(value.get('mountPoint','/data2'))
        cache.mount=cache._current_mount()
        # These are the existing constructor's metadata directories. Missing
        # or unsafe initialization is unknown capacity, not permission to mkdir.
        for name in ('','.registry','.staging','ready','.leases','.trash','.locks',
                     '.upload-reservations','.tiers','.provenance','.retirements','.reopens'):
            with module._directory(cache.root/name) as fd:
                info=os.fstat(fd)
                if (info.st_uid!=os.geteuid() or info.st_mode&0o022 or info.st_dev!=cache.mount[2]):
                    raise ValueError('Capacity metadata is unsafe or on another volume')
                if not name:cache._root_identity=(info.st_dev,info.st_ino)
        return cache

    view=executor
    if executor.CONFIG.get('storageWarehouse') is not None:
        definition=importlib.util.spec_from_file_location('gpuq_ingress_warehouse_policy',Path(__file__).with_name('storage-warehouse.py'))
        warehouse=importlib.util.module_from_spec(definition);definition.loader.exec_module(warehouse)
        cold_config=warehouse.policy(executor)
        hot,cold=existing(config),existing(cold_config)
        if (cold.root==hot.root or cold.root in hot.root.parents or hot.root in cold.root.parents
                or cold._root_identity==hot._root_identity or cold.mount[2]==hot.mount[2]):
            raise ValueError('Warehouse and training cache must be distinct fixed roots and media')
        cache=cold
        view=SimpleNamespace(CONFIG={**executor.CONFIG,'datasets':cold_config,'storageTier':{'enabled':False}})
    else:
        cache=existing(config)
        if 'workspaceReserveBytes' in executor.CONFIG:
            with module._directory(executor.ROOT) as fd:
                if os.fstat(fd).st_dev==cache._root_identity[0]:cache.reserve_bytes=max(cache.reserve_bytes,workspace_reserve)
    return module,cache,view


def _reader(executor, module, cache):
    spec = importlib.util.spec_from_file_location('gpuq_ingress_upload_receipt', Path(__file__).with_name('dataset-upload.py'))
    uploads = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(uploads)
    reader = uploads.DatasetUploads.__new__(uploads.DatasetUploads)
    reader.n, reader.d, reader.cache = executor, module, cache
    return uploads, reader


def _child(parent, name, *, directory=False):
    """Only absence of a leaf in an already verified parent means absent."""
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags | (os.O_DIRECTORY if directory else 0), dir_fd=parent)
    if directory:
        info = os.fstat(fd)
        if (info.st_uid != os.geteuid() or info.st_mode & 0o022
                or info.st_dev != os.fstat(parent).st_dev):
            os.close(fd)
            raise ValueError('Private upload location directory identity is unsafe')
    return fd


@contextmanager
def _read_guard(module, cache):
    # Admission uses this same cache lock. Never create it for a read or infer
    # absence from missing required storage metadata/mounts.
    if cache.mount is not None and cache._current_mount() != cache.mount:
        raise ValueError('Private upload location mount identity changed')
    with module._directory(cache.root) as root:
        info = os.fstat(root)
        if (info.st_uid != os.geteuid() or info.st_mode & 0o022
                or (info.st_dev, info.st_ino) != cache._root_identity
                or cache.mount is not None and info.st_dev != cache.mount[2]):
            raise ValueError('Private upload location root identity changed')
        lock = os.open('.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        try:
            lock_info = module._regular(lock)
            if lock_info.st_uid != os.geteuid() or lock_info.st_mode & 0o022:
                raise ValueError('Private upload location lock owner changed')
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            def check():
                current = os.stat('.lock', dir_fd=root, follow_symlinks=False)
                if (current.st_dev, current.st_ino) != (lock_info.st_dev, lock_info.st_ino):
                    raise ValueError('Private upload location lock identity changed')
                with module._directory(cache.root) as after:
                    identity = os.fstat(after)
                    if (identity.st_dev, identity.st_ino) != cache._root_identity:
                        raise ValueError('Private upload location root identity changed')
                if cache.mount is not None and cache._current_mount() != cache.mount:
                    raise ValueError('Private upload location mount identity changed')
            check()
            yield root
            check()
        finally:
            os.close(lock)


def _session_exists(root, user, upload):
    descriptors = []
    parent = root
    try:
        for name in ('.uploads', hashlib.sha256(user.encode()).hexdigest(), upload):
            child = _child(parent, name, directory=True)
            if child is None:
                return False
            descriptors.append(child)
            parent = child
        session = _child(parent, 'session.json')
        if session is None:
            # Even an empty/lock-only folder is an interrupted admission, not
            # a server proof that this UUID has never initialized.
            raise ValueError('Private upload admission is incomplete; absence is unconfirmed')
        os.close(session)
        return True
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def _confirm_no_commitments(root, key):
    for name in ('.upload-admissions', '.upload-reservations'):
        # Reservations are a required cache parent. Admissions are optional
        # until the first private admit; inspect that optional leaf directly.
        parent = (_child(root, name, directory=True) if name == '.upload-admissions'
                  else os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root))
        if parent is None:
            continue
        try:
            info = os.fstat(parent)
            if (info.st_uid != os.geteuid() or info.st_mode & 0o022
                    or info.st_dev != os.fstat(root).st_dev):
                raise ValueError('Private upload commitment directory identity is unsafe')
            marker = _child(parent, key+'.json')
            if marker is not None:
                os.close(marker)
                raise ValueError('Private upload admission is incomplete; absence is unconfirmed')
        finally:
            os.close(parent)


def locate(executor, args):
    if (not isinstance(args, dict) or set(args) not in (
            {'userId', 'uploadId'}, {'userId', 'uploadId', 'specification', 'authority'})
            or not isinstance(args['userId'], str)
            or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]{1,18})', args['userId'])
            or not isinstance(args['uploadId'], str)
            or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', args['uploadId'])):
        raise ValueError('Invalid private upload location fields')
    if 'specification' in args:
        module,cache,view=_capacity_cache(executor)
    else:
        module, cache = executor.dataset_upload_location_cache()
    machine = executor.CONFIG['machine']
    archive = executor.CONFIG.get('storageArchive', {})
    authority = executor.CONFIG.get('storageAuthority', {})
    is_hdd = (authority.get('enabled') is True and archive.get('enabled') is True
              and archive.get('machine') == machine
              and (executor.CONFIG.get('storageTier', {}).get('enabled') is not True
                   or executor.CONFIG.get('storageWarehouse', {}).get('enabled') is True))
    result = {'protocol': 'dataset-upload-location-v1', 'machine': machine,
              'uploadAdmissionProtocol': 1,
              'userId': args['userId'], 'uploadId': args['uploadId'], 'present': False,
              'authority': {'enabled': is_hdd, 'machine': machine, 'authority': archive.get('authority')}}
    if 'specification' in args:
        # Preserve the capacity-only selection contract. It does not issue an
        # initialization proof or authorize a repeated begin.
        path = cache.root/'.uploads'/hashlib.sha256(args['userId'].encode()).hexdigest()/args['uploadId']/'session.json'
        try:
            module._read_json(path)
        except FileNotFoundError:
            marker = cache.root/'.upload-admissions'/(hashlib.sha256(json.dumps(
                [args['userId'], args['uploadId']], separators=(',', ':')).encode()).hexdigest()+'.json')
            try:
                module._read_json(marker)
            except FileNotFoundError:
                uploads, reader = _reader(view, module, cache)
                reader.limits = uploads.upload_limits(view.CONFIG)
                result['capacity'] = reader.capacity(args['authority'], args['specification'])
                return result
            raise ValueError('Private upload admission is incomplete; absence is unconfirmed')
        return _located_session(executor, args, module, cache, result, proof=False)
    with _read_guard(module, cache) as root:
        if not _session_exists(root, args['userId'], args['uploadId']):
            key = hashlib.sha256(json.dumps([args['userId'], args['uploadId']], separators=(',', ':')).encode()).hexdigest()
            _confirm_no_commitments(root, key)
            if is_hdd:
                result.update(state='NOT_INITIALIZED', initializationProtocol=1, nodePresent=False)
            return result
        return _located_session(executor, args, module, cache, result)


def _located_session(executor, args, module, cache, result, *, proof=True):
    path = cache.root/'.uploads'/hashlib.sha256(args['userId'].encode()).hexdigest()/args['uploadId']/'session.json'
    session = module._read_json(path)
    if (not isinstance(session, dict) or session.get('schema') != 1
            or session.get('userId') != args['userId'] or session.get('uploadId') != args['uploadId']
            or not isinstance(session.get('name'), str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}', session['name'])
            or not isinstance(session.get('manifestSha256'), str)
            or not re.fullmatch(r'[a-f0-9]{64}', session['manifestSha256'])
            or any(type(session.get(key)) is not int or session[key] < 0 for key in ('manifestBytes', 'totalBytes', 'entries'))
            or not 1 <= session['manifestBytes'] <= module.MAX_JSON_BYTES
            or session['entries'] > module.MAX_ENTRIES
            or session.get('archiveAdmission') is not None):
        raise ValueError('Existing private upload identity is invalid or belongs to a transfer')
    # Reuse the pure receipt check, not the upload constructor: location must
    # never create a workspace, upload control directory or reservation.
    _, reader = _reader(executor, module, cache)
    reader._check_admission(session)
    result.update(present=True, specification={key: session[key] for key in
        ('name', 'manifestBytes', 'manifestSha256', 'totalBytes', 'entries')})
    if proof and session.get('serverAdmission') is not None:
        bound = session['serverAdmission']
        result.update(initializationProtocol=1, nodePresent=True, admissionProtocol=1,
                      admissionKey=bound['intentKey'], requestedMachine=bound['requestedMachine'],
                      storageMachine=bound['storageMachine'], admissionAuthority=bound['authority'])
    return result


def admit(executor, args):
    """Private server-minted admission; no public/peer operation alias."""
    return executor.dataset_uploads().admit(args)
