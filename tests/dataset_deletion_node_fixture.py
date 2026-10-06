"""One isolated real node adapter call; only detached systemd transport changes.

All provenance, metadata, hashes, persistent locks/fences, isolation and restore
are the product modules. No production path, network or system service is used.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import uuid

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,DEPLOY/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
N=load('native_delete_fixture','dataset-retirement-node.py')
T=load('native_delete_tier','dataset-tier.py')
D=T.D
root=Path(sys.argv[1]);request=json.load(sys.stdin)
machine,op,args=request['host'],request['op'],request['args']
D._identifier(machine);D._mkdir(root/machine)
cache=D.DatasetCache(root/machine/'cache',reserve_bytes=0)
tier=T.DatasetTier(cache)
actor=D.Principal(args['userId'],args['hostAdmin'])
retirement=N.R.DatasetRetirement(cache,machine,recovery_references=tier.retirement_references)
node=N.RetirementNode(retirement,root/machine/'operations',tier=tier,principal=D.Principal('builtin-admin',True))
if op=='fixture.publish':
    approved=root/'fixture-input';approved.mkdir(exist_ok=True);(approved/'train.txt').write_bytes(b'actual complete recoverable bytes')
    with cache._locked():
        registered=cache._register(D.Principal(actor.user_id,True),'personal',D._scan(approved),[actor.user_id],None,
            _origin='upload',_receipt=str(uuid.uuid4()))
    cache.materialize(D.Principal(actor.user_id,True),'personal',registered['version'],_source=approved)
    result=registered
elif op=='datasets.list':result=cache.list_datasets(actor)
else:
    phase=op.removeprefix('storage.dataset-delete.')
    if phase=='capabilities':result=dict(protocol=N.PROTOCOL,machine=machine,datasetDelete=1)
    elif phase=='locations':result=dict(protocol=N.PROTOCOL,machine=machine,locations=node.grant_locations(args['version'],args['references']))
    elif phase=='plan':result=node.plan(actor,args['dataset'],args['version'],args['operationId'],authorization=args.get('authorization'),references=args.get('references'))
    elif phase=='status':result={**node.worker_status(actor,args['operationId']),'pendingPhases':[],'unconfirmedPhases':[]}
    elif phase in ('fence','isolate','restore','release-absence'):
        key=args['operationId']
        if phase=='fence':value=node.fence(actor,key)
        elif phase=='isolate':value=node.isolate(actor,key,args['targets'])
        elif phase=='restore':value=node.restore(actor,key)
        else:value=node.release_absence(actor,key,args['sourceResult'])
        D._write_json(node._phase_path(key,phase,'result'),dict(ok=True,result=value))
        result=dict(protocol=N.PROTOCOL,operationId=key,machine=machine,state='DISPATCHED',action=phase)
    else:raise ValueError('Unknown local fixture transport action')
print(json.dumps(result))
