"""Private, job-bound adapters over the original dataset/transfer journals.

There is no scheduler here. The authenticated Portal persists this envelope
before calling us; neither public dataset fields nor a peer may mint it.
"""
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import stat

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
TRANSFER = {'transfers.start', 'transfers.status', 'transfers.cancel', 'transfers.resume',
            'transfers.confirm-source-release', 'transfers.confirm-unprepared-cancel'}


def unit(key):
    # TransferJobs.activity compares the cgroup basename to the exact unit.
    # systemctl accepts an omitted suffix, cgroup identity does not.
    return 'gpuq-data-'+key[:32]+'.service'


def load(node, name):
    spec = importlib.util.spec_from_file_location('gpuq_training_'+name.replace('-', '_'), node.HERE/(name+'.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def reference(value):
    if (not isinstance(value, dict) or set(value) != {'dataset', 'version'}
            or not isinstance(value['dataset'], str) or not ID.fullmatch(value['dataset'])
            or not isinstance(value['version'], str) or not HASH.fullmatch(value['version'])):
        raise ValueError('Invalid fixed training preparation reference')
    return value


def validate(node, args):
    if not isinstance(args, dict) or set(args) != {'job', 'planRequest', 'preparation', 'operation', 'args'}:
        raise ValueError('Invalid private training preparation envelope')
    job, request, prep = args['job'], args['planRequest'], args['preparation']
    load(node, 'training-storage').validate(request)
    node.validate_job(job, readonly=True)
    if node.dataset_read_mode(job) != 'cache':
        raise ValueError('Warehouse reads never prepare a cache')
    if (not isinstance(prep, dict) or set(prep) != {'protocol', 'id', 'kind', 'sourceMachine', 'targetMachine', 'logicalReference', 'reference'}
            or type(prep['protocol']) is not int or prep['protocol'] != 1
            or not isinstance(prep['id'], str) or not UUID.fullmatch(prep['id'])
            or prep['kind'] not in ('dataset', 'transfer')
            or not isinstance(prep['sourceMachine'], str) or not ID.fullmatch(prep['sourceMachine'])
            or prep['targetMachine'] != node.CONFIG.get('machine')
            or reference(prep['logicalReference']) not in [{'dataset': r['dataset'], 'version': r['version']} for r in node.dataset_refs(job)]
            or reference(prep['reference'])['version'] != prep['logicalReference']['version']):
        raise ValueError('Training preparation job/source/target mismatch')
    # Node plan validates the full private footprint schema. These extra checks
    # prevent the caller from measuring another account/mode/version/project.
    if (not isinstance(request, dict) or request.get('userId') != job['userId'] or request.get('hostAdmin') is not False
            or request.get('datasetReadMode') != 'cache'
            or any(request.get(k) != job.get(k) for k in ('project', 'release'))
            or not isinstance(request.get('datasets'), list)
            or not any(reference(r)['version'] == prep['reference']['version'] for r in request['datasets'])):
        raise ValueError('Training preparation storage request mismatch')
    call = args['args']
    if not isinstance(call, dict) or call.get('userId') != job['userId']:
        raise ValueError('Training preparation owner mismatch')
    if prep['kind'] == 'dataset':
        if (prep['sourceMachine'] != prep['targetMachine'] or args['operation'] not in ('datasets.prepare', 'datasets.status', 'datasets.cancel')
                or set(call) != {'userId', 'hostAdmin', 'dataset', 'version'} or call['hostAdmin'] is not False
                or {k: call[k] for k in ('dataset', 'version')} != prep['reference']):
            raise ValueError('Invalid bound local preparation')
    else:
        if args['operation'] not in TRANSFER or call.get('id') != prep['id'] or prep['sourceMachine'] == prep['targetMachine']:
            raise ValueError('Invalid bound target transfer operation')
        if args['operation'] == 'transfers.start':
            if (call.get('sourceMachine') != prep['sourceMachine'] or call.get('reference') != {'kind': 'datasets', **prep['reference']}
                    or 'archiveLane' in call):
                raise ValueError('Training transfer source binding changed')
        if args['operation'].startswith('transfers.confirm-') and (call.get('sourceMachine') != prep['sourceMachine']
                or call.get('reference') != {'kind': 'datasets', **prep['reference']}):
            raise ValueError('Training transfer cleanup binding changed')
    return {'protocol': 1, 'job': copy.deepcopy(job), 'preparation': copy.deepcopy(prep), 'planRequest': copy.deepcopy(request),
            'runtime': str(node.HERE.resolve())}


def admission(node, binding, physical=None):
    request = copy.deepcopy(binding['planRequest'])
    existing_upload=None
    if physical is not None:
        # Only the verified worker derives the upload's physical ID. Count an
        # existing atomic upload/staging reservation once, not another copy.
        version = binding['preparation']['reference']['version']
        matches = [i for i, ref in enumerate(request['datasets']) if ref['version'] == version
                   and ref['dataset'] in (binding['preparation']['logicalReference']['dataset'], binding['preparation']['reference']['dataset'])]
        if len(matches) != 1:
            raise ValueError('Ambiguous training transfer capacity binding')
        i = matches[0]
        request['datasets'][i] = dict(physical)
        request['datasetFootprints'][i].update(physical)
        def existing_upload(ref, expected):
            if ref!=physical:return False
            prep=binding['preparation'];transfers=node.transfers();spec=transfers.load(prep['id'])
            uploads=transfers.target_uploads(spec)
            try:session=uploads.load(binding['job']['userId'],prep['id'])
            except FileNotFoundError:return False
            if (session['name']!=spec['name'] or session.get('archiveAdmission') is not None
                    or session.get('serverAdmission') is not None
                    or any(session[key]!=spec['source'][key] for key in ('manifestBytes','manifestSha256','totalBytes','entries'))
                    or spec['reference']!={'kind':'datasets',**prep['reference']}
                    or expected['bytes']!=session['totalBytes'] or expected['manifestBytes']!=session['manifestBytes']
                    or expected['files']+expected['directories']!=session['entries']):
                raise ValueError('Existing training upload identity changed')
            try:value=read(uploads.reservation(session['userId'],session['uploadId']))
            except FileNotFoundError:return False
            # The plan handles a verified staging tree itself. Without it, a
            # reduced conversion receipt is NOT a full future-payload promise;
            # do not repair it or silently credit bytes after a conversion crash.
            if value!=uploads.reservation_value(session):raise ValueError('Existing training upload reservation changed')
            return True
    helper=load(node,'training-storage')
    result=helper.plan(node,request,_existing_upload=existing_upload) if existing_upload is not None else helper.plan(node,request)
    if result.get('fits') is not True or result.get('noReclaim') is not True:
        raise ValueError('Training preparation capacity changed; no payload or cache was deleted')
    return result


def read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink!=1 or info.st_mode & 0o077 or info.st_size > 256*1024:
            raise ValueError('Unsafe training preparation receipt')
        with os.fdopen(fd, 'r', closefd=False) as stream:
            return json.load(stream)
    finally:
        os.close(fd)


@contextmanager
def lock(path, *, nonblocking=False):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or info.st_mode&0o077:
            raise ValueError('Unsafe training preparation lock')
        fcntl.flock(fd,fcntl.LOCK_EX|(fcntl.LOCK_NB if nonblocking else 0))
        yield
    finally:os.close(fd)


def transfer_binding(node, key):
    path = node.transfers().path(key, '.training.json')
    try:
        value = read(path)
    except FileNotFoundError:
        return None
    # Reuse validation, including the exact job and immutable owner/ref tuple.
    prep = value.get('preparation', {})
    checked = validate(node, {'job': value.get('job'), 'planRequest': value.get('planRequest'), 'preparation': prep,
                             'operation': 'transfers.status', 'args': {'id': key, 'userId': value.get('job', {}).get('userId')}})
    if value != checked:
        raise ValueError('Training transfer receipt/runtime changed')
    spec = node.transfers().load(key)
    if (spec['userId'] != checked['job']['userId'] or spec['sourceMachine'] != prep['sourceMachine']
            or spec['reference'] != {'kind': 'datasets', **prep['reference']}):
        raise ValueError('Training transfer journal changed')
    return value


def local_task(node, binding, *, warehouse_source=None):
    prep, job = binding['preparation'], binding['job']
    task = {'op': 'prepare', **prep['reference'], 'userId': job['userId'], 'hostAdmin': False, 'trainingPreparation': binding}
    if warehouse_source is None:
        module, cache = node.dataset_cache()
        actor = node.dataset_actor(module, task)
        warehouse = node.storage_warehouse()
        warehouse_source=warehouse is not None and warehouse.contains(actor,task['dataset'],task['version'])
    if warehouse_source:
        task['warehouse'] = True
    key = hashlib.sha256(json.dumps(task, sort_keys=True).encode()).hexdigest()
    return key, task


def local_receipt(node,binding,operation):
    """Cleanup uses the original source snapshot, never today's contains()."""
    folder=node.ROOT/'dataset-ops';path=folder/(binding['preparation']['id']+'.training.json')
    try:value=read(path)
    except FileNotFoundError:
        candidates=[local_task(node,binding,warehouse_source=source) for source in (False,True)]
        pending=node.dataset_current_prepare(folder,**binding['preparation']['reference'])
        if pending and pending in candidates:
            key,task=pending  # Complete original immutable task is proof, not a source guess.
        else:
            if any(os.path.lexists(folder/(key+suffix)) for key,task in candidates
                   for suffix in ('.json','.result.json','.started','.cancel','.worker.lock')):
                raise ValueError('Original training dataset receipt unavailable; no cleanup guess')
            if operation=='datasets.status':return None
            if operation=='datasets.cancel':
                # No persisted operation identity, and both possible fixed units
                # are proven stopped. Persist an empty intent before fencing it.
                if any(node.transfers().activity(unit(key)) is not False for key,task in candidates):
                    raise ValueError('Unseen training preparation stop is unconfirmed')
                key,task=candidates[0]
            else:key,task=local_task(node,binding)
        value={'protocol':1,'key':key,'task':task}
        node.atomic_json(path,value)
    if (not isinstance(value,dict) or set(value)!={'protocol','key','task'} or type(value['protocol']) is not int or value['protocol']!=1
            or not isinstance(value['task'],dict) or value['task'].get('trainingPreparation')!=binding
            or value['task'].get('warehouse',False) not in (False,True)
            or ('warehouse' in value['task'] and value['task']['warehouse'] is not True)
            or local_task(node,binding,warehouse_source=value['task'].get('warehouse',False))!=(value['key'],value['task'])):
        raise ValueError('Original training dataset source snapshot changed')
    return value['key'],value['task']


def local_status(node, key, task):
    folder = node.ROOT/'dataset-ops'
    module, cache = node.dataset_cache()
    actor = node.dataset_actor(module, task)
    canceled = (folder/(key+'.cancel')).exists()
    activity = node.transfers().activity(unit(key))
    if canceled:
        # systemd/cgroup proof AND absence of the real worker lock are required.
        stopped = activity is False
        try:
            with lock(folder/(key+'.worker.lock'),nonblocking=True):pass
        except BlockingIOError:stopped=False
        return {'operationId': key, **task_ref(task), 'state': 'CANCELED' if stopped else 'UNKNOWN', 'confirmedStopped': stopped}
    if not (folder/(key+'.json')).exists():
        return {'operationId': key, **task_ref(task), 'state': 'UNKNOWN'}
    if read(folder/(key+'.json')) != task:
        raise ValueError('Training dataset journal changed')
    if activity is None:
        return {'operationId': key, **task_ref(task), 'state': 'UNKNOWN'}
    result=node.dataset_background_status(folder, key, task, cache, actor)
    if result.get('state')!='READY' and not (folder/(key+'.started')).exists() and not (folder/(key+'.result.json')).exists():
        return {'operationId':key,**task_ref(task),'state':'UNKNOWN'}
    return result


def task_ref(task):
    return {k: task[k] for k in ('dataset', 'version')}


def dispatch(node, args):
    binding = validate(node, args)
    prep, op, call = binding['preparation'], args['operation'], args['args']
    # The original job lock also serializes late start against cancellation.
    folder = node.ROOT/'jobs'
    folder.mkdir(mode=0o700, exist_ok=True)
    with lock(folder/(binding['job']['id']+'.lock')):
        if op in ('datasets.prepare', 'transfers.start', 'transfers.resume'):
            if (folder/(binding['job']['id']+'.canceled')).exists():
                raise ValueError('Training job is canceled')
            physical=None
            if prep['kind']=='transfer':
                try:spec=node.transfers().load(prep['id'])
                except FileNotFoundError:pass
                else:
                    if spec['userId']!=binding['job']['userId'] or spec['reference']!={'kind':'datasets',**prep['reference']}:
                        raise ValueError('Existing training transfer identity changed')
                    physical={'dataset':'u-'+hashlib.sha256(spec['userId'].encode()).hexdigest()[:16]+'-'+spec['name'],
                              'version':prep['reference']['version']}
            admission(node,binding,physical)
        if prep['kind'] == 'transfer':
            transfers = node.transfers()
            sidecar = transfers.path(prep['id'], '.training.json')
            # A separate binding lock avoids nesting TransferJobs' original
            # .lock and leaves its attempt/cancel/source-release fences intact.
            with transfers.lock(prep['id'], '.training.lock'):
                try:
                    prior = read(sidecar)
                except FileNotFoundError:
                    if transfers.path(prep['id']).exists():
                        raise ValueError('Legacy transfer cannot acquire training admission')
                    if op not in ('transfers.start', 'transfers.cancel', 'transfers.confirm-unprepared-cancel'):
                        raise ValueError('Missing training transfer receipt; no legacy fallback')
                    node.atomic_json(sidecar, binding)
                else:
                    if prior != binding:
                        raise ValueError('Training transfer immutable binding changed')
                return transfers.process(op, call, training=True)
        folder = node.ROOT/'dataset-ops'
        folder.mkdir(mode=0o700, exist_ok=True)
        pointer = node.dataset_prepare_pointer(folder,**prep['reference'])
        with lock(str(pointer)+'.lock'):
            original=local_receipt(node,binding,op)
            if original is None:return {**prep['reference'],'state':'UNKNOWN'}
            key,task=original
            if op == 'datasets.cancel':
                node.atomic_json(folder/(key+'.cancel'), {'userId': binding['job']['userId'], 'preparationId': prep['id']})
                try:
                    node.run(['/usr/bin/systemctl', '--user', 'stop', unit(key)], timeout=25)
                except Exception:
                    pass
                return local_status(node, key, task)
            if (folder/(key+'.cancel')).exists():
                return local_status(node, key, task)
            if (folder/(key+'.json')).exists():
                # Lost launch replies, failures and finished receipts NEVER
                # automatically relaunch. Explicit new user jobs get new IDs.
                return local_status(node, key, task)
            if op == 'datasets.status':
                return local_status(node, key, task)
            pending = node.dataset_current_prepare(folder, task['dataset'], task['version'])
            if pending and pending[0] != key:
                # A completed earlier prepare may have left a pointer. Never
                # take over an active/unknown legacy worker or its receipt.
                result = folder/(pending[0]+'.result.json')
                if (not result.exists() or read(result).get('state') not in ('READY', 'FAILED')
                        or node.transfers().activity(unit(pending[0])) is not False):
                    raise ValueError('Existing preparation requires its original cohort; not upgraded')
            node.atomic_json(folder/(key+'.json'), task)
            node.atomic_json(pointer, {'operationId': key})
            try:
                node.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit=gpuq-data-'+key[:32],
                          '--property=KillMode=control-group', '--property=UMask=0077', '--property=CPUQuota=100%',
                          '--property=MemoryMax=2G', '--property=IOWeight=10', '--property=RuntimeMaxSec=86400',
                          '--property=TimeoutStopSec=20', '/usr/bin/python3', str(node.HERE/'node-executor.py'),
                          '--training-dataset-worker', key], timeout=8)
            except Exception:
                # Durable intent is enough to prevent replay; not enough to
                # claim an inactive unit finished or never started.
                return {'operationId': key, **task_ref(task), 'state': 'UNKNOWN'}
            return {'operationId': key, **task_ref(task), 'state': 'PREPARING'}


def dataset_worker(node, key):
    if not isinstance(key, str) or not HASH.fullmatch(key):
        raise ValueError('Invalid training dataset operation ID')
    folder = node.ROOT/'dataset-ops'
    task = read(folder/(key+'.json'))
    binding = task.get('trainingPreparation')
    if not isinstance(binding, dict):raise ValueError('Missing training dataset binding')
    checked=validate(node, {'job':binding.get('job'),'planRequest':binding.get('planRequest'),'preparation':binding.get('preparation'),
                          'operation':'datasets.prepare','args':{'userId':binding.get('job',{}).get('userId'),'hostAdmin':False,**task_ref(task)}})
    if binding!=checked or local_receipt(node,binding,'datasets.status') != (key,task):
        raise ValueError('Training dataset worker binding changed')
    with lock(folder/(key+'.worker.lock')):
        if (folder/(key+'.started')).exists() or (folder/(key+'.cancel')).exists():
            return 1
        node.atomic_json(folder/(key+'.started'), {'preparationId': binding['preparation']['id']})
        try:
            admission(node, binding)
        except Exception:
            node.atomic_json(folder/(key+'.result.json'), {**task_ref(task), 'operationId': key, 'state': 'FAILED',
                                                        'error': 'Training capacity or source changed; nothing reclaimed'})
            return 1
        if (folder/(key+'.cancel')).exists():return 1
        return node.dataset_worker(key)
