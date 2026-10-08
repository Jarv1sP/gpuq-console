"""Authorized, version-locked bounded directory metadata, never host paths."""
import base64
import hashlib
import json
import os
import re
import stat

PROTOCOL = 'dataset-files-list-v1'
PAGE_SIZE = 200
PAGE_BYTES = 64 * 1024
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
USER = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}\Z')


def cursor_for(binding, after):
    return base64.urlsafe_b64encode(json.dumps(dict(binding=binding, after=after),
        ensure_ascii=False, separators=(',', ':')).encode()).decode().rstrip('=')


def owner_identity(module, paths):
    with module._directory(paths['.registry'].parent) as fd:
        child = os.open('dataset.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            return module._stamp(module._regular(child))
        finally:
            os.close(child)


def listing(node, args):
    allowed = {'userId', 'hostAdmin', 'dataset', 'version', 'path', 'cursor'}
    if not isinstance(args, dict) or set(args)-allowed or not {'userId', 'dataset', 'version'} <= set(args) or args.get('hostAdmin', False) is not False:
        raise ValueError('Invalid dataset file listing fields')
    for field, pattern in (('userId', USER), ('dataset', ID), ('version', HASH)):
        if not isinstance(args[field], str) or not pattern.fullmatch(args[field]):
            raise ValueError('Invalid fixed dataset identity')
    factory = getattr(node, 'dataset_source_cache', None)
    module, cache = factory(args['dataset'], args['version']) if factory else node.dataset_cache()
    dataset = module._identifier(args['dataset'])
    version = module._identifier(args['version'], module.HASH_RE)
    path = args.get('path', '')
    if not isinstance(path, str) or len(path.encode()) > 4096:
        raise ValueError('Invalid fixed dataset directory')
    if path:
        module._relative(path)
    actor = module.Principal(args['userId'], False)
    # Authenticating the registry precedes version-lock creation. The same
    # exclusive lock used by GC and lease admission spans the complete page;
    # no persistent download lease, snapshot index or user workspace is made.
    with cache._catalog_version_locked(actor, dataset, version) as snapshot:
        record, registration = snapshot
        manifest = record['manifest']
        paths = cache._paths(dataset, version)
        with cache._catalog_read(actor, dataset):
            cache._check_snapshot(actor, dataset, version, registration)
            owners = owner_identity(module, paths)
        # Canonical manifest verification may read the bounded large manifest;
        # hold the version lock, not the unrelated global cache metadata lock.
        ready, identity = cache._ready_snapshot(paths, manifest, version)
        if not ready:
            raise ValueError('Fixed dataset version is not READY')
        if path and path not in manifest['directories']:
            raise ValueError('Directory is not part of the fixed version')
        binding = hashlib.sha256(json.dumps([actor.user_id, node.CONFIG['machine'],
            dataset, version, path, owners, registration, identity], separators=(',', ':')).encode()).hexdigest()
        after = ''
        if args.get('cursor') is not None:
            token = args['cursor']
            if not isinstance(token, str) or not 1 <= len(token) <= 8192:
                raise ValueError('Invalid directory cursor')
            try:
                value = json.loads(base64.b64decode(token+'='*((-len(token)) % 4), altchars=b'-_', validate=True))
            except (ValueError, UnicodeError):
                raise ValueError('Invalid directory cursor') from None
            if (not isinstance(value, dict) or set(value) != {'binding', 'after'}
                    or value['binding'] != binding or not isinstance(value['after'], str)
                    or not value['after'] or '/' in value['after'] or len(value['after'].encode()) > 4096
                    or cursor_for(binding, value['after']) != token):
                raise ValueError('Directory cursor source changed')
            after = value['after']
        prefix = path+'/' if path else ''
        children = {}
        for directory in manifest['directories']:
            if directory.startswith(prefix):
                tail = directory[len(prefix):]
                if tail and '/' not in tail:
                    children[tail] = dict(name=tail, path=directory, type='directory', bytes=None)
        for entry in manifest['files']:
            if entry['path'].startswith(prefix):
                tail = entry['path'][len(prefix):]
                if tail and '/' not in tail:
                    if tail in children:
                        raise ValueError('Conflicting fixed directory entries')
                    children[tail] = dict(name=tail, path=entry['path'], type='file', bytes=entry['size'])
        if after and after not in children:
            raise ValueError('Directory cursor entry changed')
        names = sorted(name for name in children if name > after)
        entries, identities, used = [], {}, 0
        directory = paths['ready']/'data'/path
        with module._directory(directory) as fd:
            directory_identity = module._stamp(os.fstat(fd))
            for name in names:
                value = children[name]
                size = len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())+1
                if len(entries) == PAGE_SIZE or used+size > PAGE_BYTES-8192:
                    break
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if value['type'] == 'directory':
                    if not stat.S_ISDIR(info.st_mode):
                        raise ValueError('Published directory identity changed')
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        if module._stamp(os.fstat(child)) != module._stamp(info):
                            raise ValueError('Published directory changed')
                    finally:
                        os.close(child)
                else:
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        actual = module._regular(child)
                        if actual.st_size != value['bytes'] or module._stamp(actual) != module._stamp(info):
                            raise ValueError('Published file identity changed')
                    finally:
                        os.close(child)
                identities[name] = module._stamp(info)
                entries.append(value);used += size
            for name, expected in identities.items():
                if module._stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)) != expected:
                    raise ValueError('Published directory entry changed')
            if module._stamp(os.fstat(fd)) != directory_identity:
                raise ValueError('Published directory membership changed')
        if names and not entries:
            raise ValueError('Directory entry exceeds page bound')
        with cache._catalog_read(actor, dataset):
            cache._check_snapshot(actor, dataset, version, registration)
            if owner_identity(module, paths) != owners:
                raise ValueError('Dataset ownership metadata changed')
            cache._check_ready_snapshot(paths, identity)
        result = dict(protocol=PROTOCOL, available=True, machine=node.CONFIG['machine'],
            dataset=dataset, version=version, path=path, entries=entries,
            nextCursor=cursor_for(binding, entries[-1]['name']) if len(entries) < len(names) else None)
        if len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) > PAGE_BYTES:
            raise ValueError('Directory response exceeded page bound')
        return result
