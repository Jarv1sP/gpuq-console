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
A=load('native_delete_authority','storage-authority.py')
D,T=A.D,A.T
root=Path(sys.argv[1]);request=json.load(sys.stdin)
machine,op,args=request['host'],request['op'],request['args']
D._identifier(machine);D._mkdir(root/machine)
cache=D.DatasetCache(root/machine/'cache',reserve_bytes=0)
actor=D.Principal(args['userId'],args['hostAdmin'])
config=root/'authority-config.json'
authority,remote=None,None
if config.exists():
    source=D._read_json(config)['machine'];D._identifier(source)
    source_cache=cache if machine==source else D.DatasetCache(root/source/'cache',reserve_bytes=0)
    store=A.AuthorityStore(source_cache,source,root/source/'authority',principal=D.Principal('builtin-admin',True))
    if machine==source:authority=store
    else:
        class InProcessTransport:
            def __init__(self,peer,grant):self.grant=grant
            def call(self,action,**fields):
                grant=self.grant
                return store.read(dict(id=grant['id'],action=action,dataset=grant['dataset'],version=grant['version'],
                    targetMachine=grant['targetMachine'],**fields),grant['token'])
            def close(self):pass
        # Only the transport changes. Actual persistent grants/seals, remote
        # scopes, pin/fence guards and every content hash remain real.
        A.AuthorityClient=InProcessTransport
        remote=A.RemoteAuthority(source,dict(address='127.0.0.1',port=1,certificateSha256='a'*64),
            root/machine/'grants',target_machine=machine)
tier=T.DatasetTier(cache,authorities={'configured-original':remote} if remote else {})
retirement=N.R.DatasetRetirement(cache,machine,authority=authority,recovery_references=tier.retirement_references)
node=N.RetirementNode(retirement,root/machine/'operations',tier=tier,principal=D.Principal('builtin-admin',True))
if op=='fixture.enable-authority':
    D._write_json(config,dict(machine=machine));result=dict(enabled=True)
elif op=='fixture.seal':
    result=authority.seal(actor,'personal',args['version'],str(uuid.uuid4()),args['targetMachine'])
elif op=='fixture.replicate':
    grant=args['grant'];name=args['dataset']
    approved=root/'fixture-input'
    with cache._locked():
        registered=cache._register(D.Principal(args['owner'],True),name,D._scan(approved),[args['owner']],None,
            _origin='replica',_receipt=grant['id'])
    cache.materialize(actor,name,registered['version'],_source=approved)
    remote.install_grant(grant)
    result=tier.verify_authority(actor,name,registered['version'],'configured-original','personal')
elif op=='fixture.independent':
    approved=root/'fixture-input';name=args['dataset']
    with cache._locked():
        registered=cache._register(D.Principal(args['owner'],True),name,D._scan(approved),[args['owner']],None,
            _origin='replica',_receipt=str(uuid.uuid4()))
    cache.materialize(actor,name,registered['version'],_source=approved)
    result=registered
elif op=='fixture.old-grant-denied':
    grant=args['grant']
    try:
        authority.read(dict(id=grant['id'],action='guard',dataset=grant['dataset'],version=grant['version'],
            targetMachine=grant['targetMachine']),grant['token'])
    except PermissionError:result=dict(denied=True)
    else:raise AssertionError('Old grant became usable after isolation or restore')
elif op=='fixture.local-restore':result=retirement.restore(actor,args['operationId'])
elif op=='fixture.publish':
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
    elif phase=='plan':
        effective=node.resume_actor(actor,args['operationId']) if args.get('adminContinue') and node._path(args['operationId']).exists() else actor
        result=node.plan(effective,args['dataset'],args['version'],args['operationId'],authorization=args.get('authorization'),references=args.get('references'))
    elif phase=='status':result={**node.worker_status(actor,args['operationId']),'pendingPhases':[],'unconfirmedPhases':[]}
    elif phase in ('fence','isolate','restore','release-absence','cancel','commit'):
        key=args['operationId']
        effective=node.resume_actor(actor,key) if args.get('adminContinue') else actor
        if phase=='fence':value=node.fence(effective,key)
        elif phase=='isolate':value=node.isolate(effective,key,args['targets'])
        elif phase=='restore':value=node.restore(actor,key)
        elif phase=='cancel':value=node.cancel(actor,key)
        elif phase=='commit':value=node.commit(actor,key,args['sourceResult'])
        else:value=node.release_absence(actor,key,args['sourceResult'])
        D._write_json(node._phase_path(key,phase,'result'),dict(ok=True,result=value))
        result=dict(protocol=N.PROTOCOL,operationId=key,machine=machine,state='DISPATCHED',action=phase)
    else:raise ValueError('Unknown local fixture transport action')
print(json.dumps(result))
