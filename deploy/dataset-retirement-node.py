#!/usr/bin/env python3
"""Private control-plane adapter for fixed, durable version retirement steps.

Snapshots stay on the node. Public callers cannot supply owners, inode proofs,
retention, dependency receipts, roots or an override. The executor authenticates
Principal; the portal supplies the authenticated source authorization only on
this private bridge route. A negative inventory is fenced before it is used.
"""
import importlib.util
import os
from pathlib import Path
import re

_spec = importlib.util.spec_from_file_location('node_retirement_helpers', Path(__file__).with_name('dataset-retirement.py'))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)
D = R.D
PROTOCOL = 'dataset-delete-node-v1'


class RetirementNode:
    def __init__(self, retirement, state_root, *, tier, principal, quiescent=None):
        if tier.cache is not retirement.cache:
            raise ValueError('Retirement and storage tier must use the same configured cache')
        retirement.cache._actor(principal,admin=True)
        self.retirement, self.cache, self.tier, self.principal = retirement, retirement.cache, tier, principal
        self.root = D._absolute(state_root)
        R.private_directory(self.root)
        self.quiescent = quiescent

    @classmethod
    def from_executor(cls, executor):
        module,_=executor.dataset_cache()
        storage=executor.storage_node()
        policy=executor.CONFIG.get('datasets',{})
        retention=policy.get('retireRetentionDays',7)

        def quiescent(dataset,version):
            operations=executor.ROOT/'storage-archive'/'operations'
            if not R.exists(operations):return
            archive=executor.storage_archive()
            with D._directory(operations) as fd:
                keys=sorted(os.listdir(fd))
            if len(keys)>10000:raise ValueError('Archive worker inventory needs reconciliation')
            for key in keys:
                journal=archive._load(archive._op_path(key))
                if not isinstance(journal,dict) or not isinstance(journal.get('request'),dict):
                    raise ValueError('Unconfirmed archive operation blocks deletion')
                request=journal['request']
                refs=[request.get('source'),request.get('target')]
                if not any(isinstance(ref,dict) and ref.get('dataset')==dataset and ref.get('version')==version for ref in refs):
                    continue
                if journal.get('state')!='READY' or archive.worker_state(key)!='STOPPED':
                    raise ValueError('Archive worker termination is unconfirmed; version remains protected')

        retirement=R.DatasetRetirement(storage.cache,executor.CONFIG['machine'],retention_days=retention,
            assert_quiescent=quiescent,authority=executor.storage_authority(),recovery_references=storage.tier.retirement_references)
        return cls(retirement,executor.ROOT/'dataset-retirements',tier=storage.tier,
                   principal=module.Principal('builtin-admin',True),quiescent=quiescent)

    def _path(self, key):
        return self.root/(R.operation(key)+'.json')

    def _phase_path(self,key,action,kind):
        R.operation(key)
        if action not in {'fence','isolate','restore','release-absence'} or kind not in {'launch','result'}:
            raise ValueError('Invalid fixed retirement worker phase')
        return self.root/(key+'.'+action+'.'+kind+'.json')

    def _phase_read(self,key,action,kind):
        return R.private_read(self._phase_path(key,action,kind))

    def worker_status(self,actor,key):
        result=self.status(actor,key)
        phases={}
        for action in ('fence','isolate','restore','release-absence'):
            try:
                phase=self._phase_read(key,action,'result')
            except FileNotFoundError:
                continue
            if (not isinstance(phase,dict) or type(phase.get('ok')) is not bool
                    or set(phase)!=({'ok','result'} if phase['ok'] else {'ok','error'})):
                raise ValueError('Corrupt retirement worker receipt')
            if phase['ok']:
                value=phase['result']
                if (not isinstance(value,dict) or value.get('operationId')!=key
                        or value.get('machine')!=self.retirement.machine
                        or value.get('dataset')!=result['dataset'] or value.get('version')!=result['version']
                        or value.get('snapshotSha256')!=result['snapshotSha256']):
                    raise ValueError('Retirement worker reply differs from its fixed plan')
                if action=='fence':
                    fence=self.cache._retirement_fence(result['dataset'],result['version'])
                    if fence is None or fence['operationId']!=key or fence['generation']!=value.get('generation'):
                        raise ValueError('Persistent worker fence cannot be confirmed')
            elif not isinstance(phase['error'],str):
                raise ValueError('Invalid retirement worker error')
            phases[action]=phase
        return {**result,'phases':phases}

    def _lock(self, key):
        return self.cache._lock_file('.locks/delete-node-'+R.operation(key)+'.lock')

    def _write(self, row):
        D._write_json(self._path(row['operationId']), row)

    def _load(self, key):
        row = R.private_read(self._path(key))
        fields = {'schema','protocol','operationId','machine','actor','admin','dataset','version',
                  'snapshot','snapshotSha256','binding','state','targetsSha256','targets','result','restoreSourceSha256'}
        if (not isinstance(row,dict) or set(row)!=fields or type(row['schema']) is not int or row['schema']!=1
                or row['protocol']!=PROTOCOL or row['operationId']!=R.operation(key)
                or row['machine']!=self.retirement.machine or type(row['admin']) is not bool
                or row['state'] not in {'PLANNED','FENCED','ISOLATING','ISOLATED','RESTORING','RESTORED'}
                or not isinstance(row['snapshot'],dict)
                or row['snapshot'].get('protocol') not in {R.PROTOCOL,'dataset-version-absence-v1'}
                or row['snapshotSha256']!=R.sha(row['snapshot'])
                or row['binding']!=R.sha([row['actor'],row['admin'],row['dataset'],row['version'],row['snapshot']])):
            raise ValueError('Corrupt node retirement step; no dispatch or cleanup permitted')
        self.cache._paths(row['dataset'],row['version'])
        D._identifier(row['actor'],D.USER_RE)
        if row['snapshot'].get('machine')!=row['machine'] or row['snapshot'].get('dataset')!=row['dataset'] or row['snapshot'].get('version')!=row['version']:
            raise ValueError('Corrupt fixed node retirement reference')
        if row['targetsSha256'] is not None and row['targetsSha256']!=R.sha(row['targets']):
            raise ValueError('Confirmed dependent receipts changed')
        return row

    def _owned(self, actor, row, *, restoring=False):
        self.cache._actor(actor, admin=restoring)
        if not restoring and (row['actor']!=actor.user_id or row['admin']!=actor.is_admin):
            raise PermissionError('Node retirement belongs to another immutable account and role')

    def _authorization(self, actor, value, version):
        """Authenticated source preflight, never a public request field."""
        fields={'operationId','machine','dataset','version','owners','memberAllowed','complete','snapshotSha256'}
        if (not isinstance(value,dict) or set(value)!=fields or value['version']!=version
                or type(value['memberAllowed']) is not bool or value['complete'] is not True):
            raise ValueError('Absence needs the fixed complete source authorization')
        R.operation(value['operationId'])
        D._identifier(value['machine']);D._identifier(value['dataset']);D._identifier(value['snapshotSha256'],D.HASH_RE)
        owners=self.cache._owners(value['owners'])
        if owners!=value['owners']:
            raise ValueError('Invalid fixed source owners')
        if not actor.is_admin and (owners!=[actor.user_id] or not value['memberAllowed']):
            raise PermissionError('这份数据只能由管理员删除')
        return owners

    def _assert_empty(self, actor, dataset, version, authorization):
        """Exact negative observation; unknown residual data never means gone."""
        owners=self._authorization(actor,authorization,version)
        paths=self.cache._paths(dataset,version)
        with self.cache._locked():
            registry=self.cache._paths(dataset)['.registry']
            if R.exists(registry/'dataset.json'):
                current=self.cache._dataset(actor,dataset)['owners']
                if current!=owners:
                    raise PermissionError('Absent version namespace belongs to different owners')
            checks=[registry/(version+'.json'),paths['ready'],paths['.staging'],
                    self.cache.root/'.tiers'/dataset/(version+'.json'),
                    self.cache.root/'.provenance'/dataset/(version+'.json')]
            if any(R.exists(path) for path in checks) or self.cache._leases(dataset,version):
                raise ValueError('Missing registration has unconfirmed data or active dependencies')
        # Interrupted ordinary removal can still hold the last complete bytes.
        # A negative READY lookup alone cannot certify its deletion.
        with D._directory(self.cache.root/'.trash') as fd:
            names=sorted(os.listdir(fd))
        if len(names)>10000:
            raise ValueError('Trash inventory requires administrator reconciliation')
        for name in names:
            folder=self.cache.root/'.trash'/name
            if re.fullmatch(r'unregister-[a-f0-9]{32}',name):
                removal=R.private_read(folder/'REMOVAL.json')
                if removal.get('dataset')==dataset and version in removal.get('versions',[]):
                    for bucket in ('ready','.staging'):
                        if R.exists(folder/'replicas'/bucket/version):
                            raise ValueError('Interrupted ordinary deletion still holds unconfirmed data')
            elif re.fullmatch(r'retire-[a-f0-9]{32}',name):
                prior=R.private_read(folder/'RETIREMENT.json')
                if prior.get('dataset')==dataset and prior.get('version')==version and prior.get('state') not in {'RESTORED','PURGED'}:
                    raise ValueError('Another version retirement already retains this generation')
        if self.quiescent is not None:
            self.quiescent(dataset,version)
        return owners

    def _absence(self, actor, dataset, version, authorization, references):
        owners=self._assert_empty(actor,dataset,version,authorization)
        return dict(protocol='dataset-version-absence-v1',machine=self.retirement.machine,dataset=dataset,version=version,
                    owners=owners,rootIdentity=list(self.cache._root_identity),complete=False,memberAllowed=authorization['memberAllowed'],
                    authorization=authorization,authorityReferences=references)

    def _view(self, row):
        snapshot=row['snapshot']
        return dict(protocol=PROTOCOL,operationId=row['operationId'],machine=row['machine'],dataset=row['dataset'],version=row['version'],
                    state=row['state'],snapshotSha256=row['snapshotSha256'],owners=snapshot['owners'],memberAllowed=snapshot['memberAllowed'],
                    complete=snapshot['complete'],absent=snapshot['protocol']=='dataset-version-absence-v1',
                    authority=snapshot.get('authority'),authorityReferences=snapshot['authorityReferences'])

    def plan(self, actor, dataset, version, key, *, authorization=None, references=None):
        self.cache._actor(actor)
        self.cache._paths(dataset,version);R.operation(key)
        references=[] if references is None else references
        if not isinstance(references,list) or len(references)>16:
            raise ValueError('Invalid fixed source dependency references')
        for ref in references:
            if (not isinstance(ref,dict) or set(ref)!={'sourceMachine','targetMachine','sourceDataset','version','grantId','receiptSha256'}
                    or ref['targetMachine']!=self.retirement.machine or ref['version']!=version):
                raise ValueError('Invalid fixed source dependency reference')
            D._identifier(ref['sourceMachine']);D._identifier(ref['sourceDataset']);D._identifier(ref['grantId'],R.GRANT_UUID)
            D._identifier(ref['receiptSha256'],D.HASH_RE)
        with self._lock(key):
            try:
                row=self._load(key)
            except FileNotFoundError:
                row=None
            if row is not None:
                self._owned(actor,row)
                snapshot=row['snapshot']
                if (row['dataset']!=dataset or row['version']!=version
                        or snapshot.get('authorization')!=authorization
                        or snapshot['protocol']=='dataset-version-absence-v1' and snapshot['authorityReferences']!=references):
                    raise ValueError('Node plan UUID cannot change its target or authorization')
                return self._view(row)
            registry=self.cache._paths(dataset)['.registry']/(version+'.json')
            if R.exists(registry):
                snapshot=self.retirement.inspect(actor,dataset,version)
                if authorization is not None or references:
                    raise ValueError('Existing data uses its actual local source proof, never supplied owners')
            else:
                snapshot=self._absence(actor,dataset,version,authorization,references)
            row=dict(schema=1,protocol=PROTOCOL,operationId=key,machine=self.retirement.machine,actor=actor.user_id,admin=actor.is_admin,
                     dataset=dataset,version=version,snapshot=snapshot,snapshotSha256=R.sha(snapshot),
                     binding=R.sha([actor.user_id,actor.is_admin,dataset,version,snapshot]),state='PLANNED',targetsSha256=None,
                     targets=None,result=None,restoreSourceSha256=None)
            self._write(row)
            return self._view(row)

    def fence(self, actor, key):
        with self._lock(key):
            row=self._load(key);self._owned(actor,row)
            snapshot=row['snapshot']
            if snapshot['protocol']==R.PROTOCOL:
                result=self.retirement.fence(actor,row['dataset'],row['version'],key,snapshot)
            else:
                dataset,version=row['dataset'],row['version']
                with self.cache._locked():
                    previous=self.cache._retirement_fence(dataset,version)
                if previous is None or previous['state'] in {'RESTORED','RELEASED'}:
                    if previous is not None and previous['operationId']==key:
                        raise ValueError('Released absence cannot replay its old deletion')
                    if self._absence(actor,dataset,version,snapshot['authorization'],snapshot['authorityReferences'])!=snapshot:
                        raise ValueError('Negative dataset inventory changed')
                    with self.cache._lock_file('.locks/'+dataset+'.'+version+'.lock'),self.cache._locked():
                        if self.cache._retirement_fence(dataset,version)!=previous:
                            raise ValueError('Another deletion claimed the namespace')
                        # Check again under the same lock order used by writers.
                        if any(R.exists(p) for p in (self.cache._paths(dataset)['.registry']/(version+'.json'),
                                self.cache._paths(dataset,version)['ready'],self.cache._paths(dataset,version)['.staging'])):
                            raise ValueError('Data appeared before the negative inventory fence')
                        folder=self.cache.root/'.retirements'/dataset;R.private_directory(folder)
                        previous=dict(schema=1,protocol='dataset-version-fence-v1',rootIdentity=list(self.cache._root_identity),
                            dataset=dataset,version=version,operationId=key,actor=actor.user_id,admin=actor.is_admin,
                            snapshotSha256=row['snapshotSha256'],generation=R.sha([snapshot,key]),state='FENCED',
                            createdAt=self.retirement._now(),restoredRegistration=None)
                        D._write_json(folder/(version+'.json'),previous)
                if (previous['operationId']!=key or previous['actor']!=actor.user_id or previous['admin']!=actor.is_admin
                        or previous['snapshotSha256']!=row['snapshotSha256']):
                    raise ValueError('Negative inventory belongs to another persistent fence')
                with self.cache._retirement_scope(actor,key,dataset,version,row['snapshotSha256']),self.cache._lock_file('.locks/'+dataset+'.'+version+'.lock'):
                    self._assert_empty(actor,dataset,version,snapshot['authorization'])
                result=dict(protocol='dataset-version-fence-v1',operationId=key,machine=row['machine'],dataset=dataset,version=version,
                            snapshotSha256=row['snapshotSha256'],generation=previous['generation'],state=previous['state'],drained=True)
            if row['state']=='PLANNED':
                row['state']='FENCED';self._write(row)
            return result

    def isolate(self, actor, key, targets):
        self.fence(actor,key)
        with self._lock(key):
            row=self._load(key);self._owned(actor,row)
            if row['state'] not in {'FENCED','ISOLATING','ISOLATED'}:
                raise ValueError('Node retirement cannot be dispatched in this state')
            if not isinstance(targets,list) or len(targets)>10000:
                raise ValueError('Invalid confirmed dependent inventory')
            if row['targetsSha256'] is not None and row['targetsSha256']!=R.sha(targets):
                raise ValueError('Confirmed dependent receipts cannot change during a retry')
            row['targets'],row['targetsSha256']=targets,R.sha(targets)
            row['state']='ISOLATING';self._write(row)
            snapshot=row['snapshot']
            if snapshot['protocol']==R.PROTOCOL:
                authority=self.retirement.authority
                revoke=(lambda journal:authority.revoke_for_retirement(actor,journal,targets)) if authority is not None else None
                result=self.retirement.isolate(actor,row['dataset'],row['version'],key,snapshot,_revoke=revoke)
            else:
                with self.cache._retirement_scope(actor,key,row['dataset'],row['version'],row['snapshotSha256']),self.cache._lock_file('.locks/'+row['dataset']+'.'+row['version']+'.lock'):
                    self._assert_empty(actor,row['dataset'],row['version'],snapshot['authorization'])
                    with self.cache._locked():
                        fence=self.cache._check_retirement(row['dataset'],row['version'])
                        if fence['state'] not in {'FENCED','ISOLATED'}:
                            raise ValueError('Negative inventory has changed its generation')
                        if fence['state']=='FENCED':
                            fence={**fence,'state':'ISOLATED'}
                            D._write_json(self.cache.root/'.retirements'/row['dataset']/(row['version']+'.json'),fence)
                    result=dict(protocol=R.PROTOCOL,operationId=key,machine=row['machine'],dataset=row['dataset'],version=row['version'],
                        state='ISOLATED',isolated=True,complete=False,snapshotSha256=row['snapshotSha256'],generation=fence['generation'],
                        fenceState='ISOLATED',retainUntil=fence['createdAt']+self.retirement.retention_seconds,
                        authorityReferences=snapshot['authorityReferences'],proofSha256=R.sha([row['binding'],fence]))
            row['state'],row['result']='ISOLATED',result;self._write(row)
            return result

    def status(self, actor, key):
        with self._lock(key):
            row=self._load(key)
            self.cache._actor(actor)
            if not actor.is_admin and (row['actor']!=actor.user_id or row['admin']!=actor.is_admin):
                raise PermissionError('Node retirement belongs to another account')
            # A query never invokes isolate, replays a request, writes a clock,
            # or promotes a saved launch intent into a confirmed outcome.
            if row['snapshot']['protocol']==R.PROTOCOL and row['state'] in {'ISOLATING','ISOLATED','RESTORING','RESTORED'}:
                try:
                    result=self.retirement.status(actor,key)
                except FileNotFoundError:
                    return {**self._view(row),'state':'UNKNOWN','result':None,
                            'error':'Node dispatch intent has no confirmed retirement outcome; no automatic retry'}
                return {**self._view(row),'result':result}
            if row['result'] is not None:
                fence=self.cache._retirement_fence(row['dataset'],row['version'])
                restored=row['state']=='RESTORED'
                proof=[row['binding'],fence,row['restoreSourceSha256']] if restored else [row['binding'],fence]
                if (fence is None or fence['operationId']!=key or fence['snapshotSha256']!=row['snapshotSha256']
                        or fence['state']!=('RELEASED' if restored else 'ISOLATED') or row['result']['proofSha256']!=R.sha(proof)):
                    raise ValueError('Negative inventory receipt lost its persistent proof')
            return {**self._view(row),'result':row['result']}

    def restore(self, actor, key):
        self.cache._actor(actor,admin=True)
        with self._lock(key):
            row=self._load(key);self._owned(actor,row,restoring=True)
            if row['state'] not in {'ISOLATED','RESTORING','RESTORED'}:
                raise ValueError('Only confirmed isolated data may be restored')
            if row['snapshot']['protocol']!=R.PROTOCOL:
                raise ValueError('Empty namespace release requires the separately confirmed restored source')
            row['state']='RESTORING';self._write(row)
            result=self.retirement.restore(actor,key)
            row['state'],row['result']='RESTORED',result;self._write(row)
            return result

    def release_absence(self, actor, key, source_result):
        """Private admin step, after an authenticated original restore receipt."""
        self.cache._actor(actor,admin=True)
        with self._lock(key):
            row=self._load(key);self._owned(actor,row,restoring=True)
            snapshot=row['snapshot']
            if snapshot['protocol']!='dataset-version-absence-v1' or row['state'] not in {'ISOLATED','RESTORED'}:
                raise ValueError('Only this isolated absence namespace can be released')
            authorization=snapshot['authorization']
            fields={'protocol','operationId','machine','dataset','version','state','isolated','complete',
                    'snapshotSha256','generation','fenceState','retainUntil','proofSha256','authorityReferences'}
            if (not isinstance(source_result,dict) or set(source_result)!=fields or source_result['protocol']!=R.PROTOCOL
                    or source_result['state']!='RESTORED' or source_result['fenceState']!='RESTORED'
                    or source_result['isolated'] is not False or source_result['complete'] is not True
                    or any(source_result[k]!=authorization[k] for k in ('operationId','machine','dataset','version','snapshotSha256'))):
                raise ValueError('The fixed complete source restore is unconfirmed')
            D._identifier(source_result['proofSha256'],D.HASH_RE)
            D._identifier(source_result['generation'],D.HASH_RE)
            digest=R.sha(source_result)
            if row['restoreSourceSha256'] is not None and row['restoreSourceSha256']!=digest:
                raise ValueError('Restored source receipt cannot change')
            original_actor=type(actor)(row['actor'],row['admin'])
            with self.cache._retirement_scope(original_actor,key,row['dataset'],row['version'],row['snapshotSha256']),\
                    self.cache._lock_file('.locks/'+row['dataset']+'.'+row['version']+'.lock'):
                self._assert_empty(original_actor,row['dataset'],row['version'],authorization)
                with self.cache._locked():
                    fence=self.cache._check_retirement(row['dataset'],row['version'])
                    if fence is None or fence['operationId']!=key or fence['state'] not in {'ISOLATED','RELEASED'}:
                        raise ValueError('Empty namespace belongs to another deletion generation')
                    if fence['state']=='ISOLATED':
                        # Persist the complete-source proof before releasing.
                        row['restoreSourceSha256']=digest;self._write(row)
                        fence={**fence,'state':'RELEASED'}
                        D._write_json(self.cache.root/'.retirements'/row['dataset']/(row['version']+'.json'),fence)
                    row['result']={**row['result'],'state':'RESTORED','isolated':False,'fenceState':'RELEASED',
                                   'proofSha256':R.sha([row['binding'],fence,digest])}
                    row['state']='RESTORED';self._write(row)
            return row['result']

    def grant_locations(self, version, references):
        """Exhaustive local fixed-receipt projection, without owner filtering."""
        D._identifier(version,D.HASH_RE)
        if not isinstance(references,list) or len(references)>10000:
            raise ValueError('Invalid fixed dependent inventory')
        fields={'sourceMachine','targetMachine','sourceDataset','version','grantId','receiptSha256'}
        for ref in references:
            if (not isinstance(ref,dict) or set(ref)!=fields or ref['version']!=version or ref['targetMachine']!=self.retirement.machine):
                raise ValueError('Invalid configured dependent target')
            D._identifier(ref['sourceMachine']);D._identifier(ref['sourceDataset']);D._identifier(ref['grantId'],R.GRANT_UUID)
            D._identifier(ref['receiptSha256'],D.HASH_RE)
        expected={ref['grantId']:ref for ref in references}
        if len(expected)!=len(references):raise ValueError('Ambiguous dependent grants')
        locations=[]
        with D._directory(self.cache.root/'.registry') as fd:
            names=sorted(os.listdir(fd))
        if len(names)>10000:
            raise ValueError('Dataset dependency inventory requires reconciliation')
        internal=self.principal
        for dataset in names:
            D._identifier(dataset)
            path=self.cache._paths(dataset)['.registry']/(version+'.json')
            if not R.exists(path):continue
            with self.cache._locked():
                tier=self.cache._tier(dataset,version)
            if tier['role']!='cache':continue
            bindings=self.tier.retirement_references(internal,dataset,version)
            for binding in bindings:
                planned=expected.get(binding['grantId'])
                if planned is not None:
                    if binding!=planned:
                        raise ValueError('Fixed authority dependent identity differs')
                    locations.append(dict(dataset=dataset,version=version,authorityReference=binding))
        return locations
