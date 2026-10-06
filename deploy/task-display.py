"""Presentation-only sync to native GPUQ; preserve the immutable job spec."""
import json
import unicodedata

CAPABILITY = 'console-task-display-v1'
NATIVE = 'job-display-v1'


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
