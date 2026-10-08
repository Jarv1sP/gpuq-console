"""Private control-plane lookup; never create a user workspace or upload."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re


def _reader(executor, module, cache):
    spec = importlib.util.spec_from_file_location('gpuq_ingress_upload_receipt', Path(__file__).with_name('dataset-upload.py'))
    uploads = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(uploads)
    reader = uploads.DatasetUploads.__new__(uploads.DatasetUploads)
    reader.n, reader.d, reader.cache = executor, module, cache
    return uploads, reader


def locate(executor, args):
    if (not isinstance(args, dict) or set(args) not in (
            {'userId', 'uploadId'}, {'userId', 'uploadId', 'specification', 'authority'})
            or not isinstance(args['userId'], str)
            or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]{1,18})', args['userId'])
            or not isinstance(args['uploadId'], str)
            or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', args['uploadId'])):
        raise ValueError('Invalid private upload location fields')
    factory=getattr(executor,'dataset_source_cache',executor.dataset_cache)
    module, cache = factory()  # Existing fixed warehouse mount/root guard.
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
    path = cache.root/'.uploads'/hashlib.sha256(args['userId'].encode()).hexdigest()/args['uploadId']/'session.json'
    try:
        session = module._read_json(path)
    except FileNotFoundError:
        marker = cache.root/'.upload-admissions'/(hashlib.sha256(json.dumps(
            [args['userId'], args['uploadId']], separators=(',', ':')).encode()).hexdigest()+'.json')
        try:
            module._read_json(marker)
        except FileNotFoundError:
            if 'specification' in args:
                # On split HDD/cache nodes the trusted ingress view carries the
                # HDD policy. Never infer write permission from a public field.
                view = getattr(executor, 'dataset_ingress_view', lambda: executor)()
                uploads, reader = _reader(view, module, cache)
                reader.limits = uploads.upload_limits(view.CONFIG)
                result['capacity'] = reader.capacity(args['authority'], args['specification'])
            return result
        raise ValueError('Private upload admission is incomplete; absence is unconfirmed')
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
    return result


def admit(executor, args):
    """Private server-minted admission; no public/peer operation alias."""
    return executor.dataset_uploads().admit(args)
