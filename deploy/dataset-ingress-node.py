"""Private control-plane lookup; never create a user workspace or upload."""
import hashlib
import re


def locate(executor, args):
    if (not isinstance(args, dict) or set(args) != {'userId', 'uploadId'}
            or not isinstance(args['userId'], str)
            or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]{1,18})', args['userId'])
            or not isinstance(args['uploadId'], str)
            or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', args['uploadId'])):
        raise ValueError('Invalid private upload location fields')
    module, cache = executor.dataset_cache()  # Existing mount/root guard.
    machine = executor.CONFIG['machine']
    archive = executor.CONFIG.get('storageArchive', {})
    authority = executor.CONFIG.get('storageAuthority', {})
    is_hdd = (authority.get('enabled') is True and archive.get('enabled') is True
              and archive.get('machine') == machine
              and executor.CONFIG.get('storageTier', {}).get('enabled') is not True)
    result = {'protocol': 'dataset-upload-location-v1', 'machine': machine,
              'userId': args['userId'], 'uploadId': args['uploadId'], 'present': False,
              'authority': {'enabled': is_hdd, 'machine': machine, 'authority': archive.get('authority')}}
    path = cache.root/'.uploads'/hashlib.sha256(args['userId'].encode()).hexdigest()/args['uploadId']/'session.json'
    try:
        session = module._read_json(path)
    except FileNotFoundError:
        return result
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
    result.update(present=True, specification={key: session[key] for key in
        ('name', 'manifestBytes', 'manifestSha256', 'totalBytes', 'entries')})
    return result
