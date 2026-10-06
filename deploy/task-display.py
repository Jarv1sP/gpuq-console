"""Presentation-only sync to native GPUQ; preserve the immutable job spec."""
import json
import hashlib
import os
import re
import stat
import unicodedata

CAPABILITY = 'console-task-display-v1'
NATIVE = 'job-display-v1'
EDIT_CAPABILITY = 'console-task-display-edit-v1'
CAS_NATIVE = 'job-display-cas-v1'


def revision(metadata):
    value={} if metadata=={} else normalize(metadata)
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf8')).hexdigest()


def edit(node,operation,args):
    setting=operation=='tasks.display.set'
    allowed={'userId','hostAdmin','nodeJobId','job'}|({'name','description','revision'} if setting else set())
    if (operation not in ('tasks.display.get','tasks.display.set') or not isinstance(args,dict)
            or set(args)-allowed or not {'userId','hostAdmin','nodeJobId'}<=set(args)
            or not isinstance(args['userId'],str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',args['userId'])
            or type(args['hostAdmin']) is not bool or not isinstance(args['nodeJobId'],str)
            or not re.fullmatch(r'J[a-f0-9]{12}',args['nodeJobId'])):
        raise ValueError('Invalid task display request')
    job=args.get('job')
    if job is not None:
        node.validate_job(job,readonly=True)
        if args['userId']!=job['userId'] and not args['hostAdmin']:
            raise ValueError('Task belongs to another account')
        path=node.ROOT/'jobs'/(job['id']+'.json')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid() or info.st_size>1000000:
                raise ValueError('Stored task identity is unavailable')
            with os.fdopen(fd,'r',encoding='utf8',closefd=False) as stream:stored=json.load(stream)
        finally:os.close(fd)
        if stored!=job:raise ValueError('Stored task identity changed')
    elif not args['hostAdmin']:
        raise ValueError('Unlinked native tasks require administrator access')
    native=node.gpu('show',args['nodeJobId']).get('job')
    if not isinstance(native,dict) or native.get('id')!=args['nodeJobId']:
        raise ValueError('Original native task is unconfirmed')
    if job is not None and (native.get('submit_key'),native.get('owner'),native.get('name'))!=(job['id'],node.gpuq_owner(job),'portal-'+job['id'][:8]):
        raise ValueError('Original native task binding changed')
    current=native.get('display_metadata')
    current_revision=revision(current)
    if current=={}:
        username=job['username'] if job else native.get('owner')
        metadata=normalize({'name':job['name'] if job else native.get('name'),'description':'',
                            'submitter':{'name':username,'username':username}})
    else:
        metadata=normalize(current)
        if job and metadata['submitter']['username']!=job['username']:
            raise ValueError('Display metadata belongs to another submitted task')
    capabilities=node.gpu('status').get('daemon',{}).get('capabilities')
    available=isinstance(capabilities,list) and CAS_NATIVE in capabilities
    if setting:
        if set(args)-{'job'}!={'userId','hostAdmin','nodeJobId','name','description','revision'}:
            raise ValueError('Task display edit requires name, description and revision')
        if not available:raise ValueError('Native task display CAS capability is unavailable')
        if not isinstance(args['revision'],str) or not re.fullmatch(r'[a-f0-9]{64}',args['revision']) or args['revision']!=current_revision:
            raise ValueError('Task display revision changed; read the original task again')
        metadata=normalize({**metadata,'name':args['name'],'description':args['description']})
        # Only mutable presentation is written. Binding and current display
        # comparison are rechecked in one native SQLite transaction.
        result=node.gpu('set-display',native['id'],'--expected-submit-key='+native['submit_key'],
            '--expected-owner='+native['owner'],'--expected-name='+native['name'],
            '--expected-display-revision='+current_revision,'--name='+metadata['name'],
            '--description='+metadata['description'],'--submitter-name='+metadata['submitter']['name'],
            '--username='+metadata['submitter']['username'])
        if (not isinstance(result,dict) or result.get('job_id')!=native['id']
                or result.get('display_metadata')!=metadata or result.get('revision')!=revision(metadata)):
            raise ValueError('Task display outcome unconfirmed; read the same original task, do not replay')
        current_revision=result['revision']
    return {'protocol':'task-display-edit-v1','nodeJobId':native['id'],'available':available,
            'name':metadata['name'],'description':metadata['description'],'revision':current_revision,
            'metadata':metadata,'binding':{'submitKey':native['submit_key'],'owner':native['owner'],'name':native['name']}}


def normalize(metadata):
    if not isinstance(metadata, dict) or set(metadata) != {'name','description','submitter'}:
        raise ValueError('Invalid job display metadata')
    actor=metadata['submitter']
    if not isinstance(actor,dict) or set(actor) != {'name','username'}:
        raise ValueError('Invalid job display submitter')
    fields=((metadata['name'],64,256,False),(metadata['description'],2000,6000,True),
            (actor['name'],32,128,False),(actor['username'],24,96,False))
    for value,chars,size,multiline in fields:
        if not isinstance(value,str) or len(value)>chars or len(value.encode('utf8'))>size:
            raise ValueError('Job display text is too large')
        if not multiline and not value.strip():raise ValueError('Job display text is empty')
        if any(unicodedata.category(c) in ('Cc','Cf','Cs','Zl','Zp') and not(multiline and c in '\n\t') for c in value):
            raise ValueError('Job display text contains controls')
    return metadata


def validate(job, metadata):
    normalize(metadata)
    if metadata['name'] != job['name'] or metadata['submitter']['username'] != job['username']:
        raise ValueError('Display metadata belongs to another submitted task')
    return metadata


def sync(node, job, metadata, native):
    if metadata is None:return {'state':'LEGACY'}
    validate(job,metadata)
    if native.get('display_metadata') == metadata:return {'state':'SYNCED'}
    existing=native.get('display_metadata')
    if existing:
        try:normalize(existing)
        except (ValueError,UnicodeError):pass
        else:
            if existing['submitter']['username']==job['username']:
                # A human used the native, identity-fenced set-display entry.
                # Reconciliation observes it, never rewrites it to rawname.
                return {'state':'PRESERVED','metadata':existing}
    # The native endpoint checks all three persistent identity fields atomically.
    # No guess by shortened portal name, GPU index or process username.
    result=node.gpu('set-display',native['id'],
        '--expected-submit-key='+job['id'],'--expected-owner='+node.gpuq_owner(job),
        '--expected-name=portal-'+job['id'][:8],
        '--name='+metadata['name'],'--description='+metadata['description'],
        '--submitter-name='+metadata['submitter']['name'],'--username='+metadata['submitter']['username'])
    if result.get('job_id')!=native['id'] or result.get('display_metadata')!=metadata:
        raise ValueError('Native display receipt does not match the selected task')
    return {'state':'SYNCED'}
