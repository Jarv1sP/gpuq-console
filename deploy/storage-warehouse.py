"""One private fixed HDD original root beside this machine's SSD cache.

No request chooses a disk, path, role or endpoint. Cache aliases are internal
physical identities, preserving the existing full-deletion dependency graph.
"""
import hashlib
import importlib.util
import uuid
from pathlib import Path
from types import SimpleNamespace


def policy(executor):
    value=executor.CONFIG.get('storageWarehouse')
    if value is None:return None
    required={'enabled','root','mountPoint','reserveBytes'}
    if (not isinstance(value,dict) or set(value)!=required or value.get('enabled') is not True
            or type(value['reserveBytes']) is not int or not 0<=value['reserveBytes']<=2**63-1
            or executor.CONFIG.get('storageAuthority')!={'enabled':True}
            or executor.CONFIG.get('storageTier',{}).get('enabled') is not True
            or executor.CONFIG.get('storageArchive',{}).get('enabled') is not True
            or executor.CONFIG['storageArchive'].get('machine')!=executor.CONFIG.get('machine')):
        raise ValueError('Fixed warehouse requires this configured protected HDD authority')
    return dict(root=value['root'],mountPoint=value['mountPoint'],reserveBytes=value['reserveBytes'],
                sources={},uploads=executor.CONFIG.get('datasets',{}).get('uploads',{}),
                retireRetentionDays=executor.CONFIG.get('datasets',{}).get('retireRetentionDays',7))


class Warehouse:
    def __init__(self, executor):
        self.n=executor;self.config=policy(executor)
        if self.config is None:raise ValueError('Local warehouse is not enabled')
        executor.dataset_mount_check(self.config)
        self.d,self.hot=executor.dataset_cache()
        self.cold=self.d.DatasetCache(self.config['root'],sources={},reserve_bytes=self.config['reserveBytes'],
                                     mount_point=self.config['mountPoint'])
        if (self.cold.root==self.hot.root or self.cold.root in self.hot.root.parents or self.hot.root in self.cold.root.parents
                or self.cold._root_identity==self.hot._root_identity
                or self.cold.mount is not None and self.hot.mount is not None and self.cold.mount[2]==self.hot.mount[2]):
            raise ValueError('Warehouse and training cache must be distinct fixed roots and media')
        self.control=executor.ROOT/'warehouse-control';self.d._mkdir(self.control)
        self.bindings=self.control/'cache-bindings';self.d._mkdir(self.bindings)
        # The view is exclusively an executor factory product. Preserve user
        # workspace/project/command closures; only dataset originals use HDD.
        self.view=SimpleNamespace(**vars(executor))
        self.view.CONFIG={**executor.CONFIG,'datasets':self.config,'storageTier':{'enabled':False}}
        self.view.ROOT=self.control
        self.view.dataset_cache=lambda:(self.d,self.cold)
        self.view.dataset_source_cache=self.view.dataset_cache
        self.view.storage_authority=executor.storage_authority
        self.view.storage_archive=executor.storage_archive
        self.view.storage_node=self._cold_storage
        self.view.direct_startup_config=lambda:executor.CONFIG
        self.cache_view=SimpleNamespace(**vars(executor))
        # The SSD target is not the original authority. Feeding its physical
        # cache name into the HDD AuthorityStore would conflate the two roots.
        self.cache_view.storage_authority=lambda:None
        self.cold.rebuild_guard=lambda actor,dataset,version:executor.dataset_rebuild_guard_for(self.view,actor,dataset,version)

    def _cold_storage(self):
        spec=importlib.util.spec_from_file_location('gpuq_warehouse_storage_node',self.n.HERE/'storage-node.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.StorageNode(self.cold,policy={'enabled':False},authorities={})

    @staticmethod
    def cache_name(dataset):
        return 'wc-'+hashlib.sha256(dataset.encode()).hexdigest()[:60]

    def binding(self, physical, version):
        self.d._identifier(physical);self.d._identifier(version,self.d.HASH_RE)
        value=self.d._read_json(self.bindings/(physical+'-'+version+'.json'))
        if (not isinstance(value,dict) or set(value)!={'source','target','version','sourceRoot','targetRoot'}
                or value['target']!=physical or value['version']!=version
                or self.cache_name(value['source'])!=physical
                or value['sourceRoot']!=list(self.cold._root_identity)
                or value['targetRoot']!=list(self.hot._root_identity)):
            raise ValueError('Fixed local cache binding changed')
        return value

    def contains(self, actor, dataset, version):
        try:self.cold._record_snapshot(actor,dataset,version)
        except FileNotFoundError:return False
        return True

    def status(self, actor, dataset, version):
        source=self.cold.status(actor,dataset,version)
        physical=self.cache_name(dataset)
        try:
            binding=self.binding(physical,version)
            if binding['source']!=dataset:raise ValueError('Local cache source differs')
            current=self.hot.status(actor,physical,version)
            with self.hot._locked():
                if current['state']=='READY' and self.hot._tier(physical,version)['role']!='cache':
                    current={**current,'state':'REGISTERED'}
        except FileNotFoundError:
            current={'state':'REGISTERED'}
        # An original READY is source evidence, never SSD training readiness.
        result={**source,**current,'dataset':dataset,'version':version,
                'warehouseReady':source['state']=='READY','canPrepare':source['state']=='READY',
                'warehouseCanPrepare':source['state']=='READY'}
        if source['state']!='READY':result['state']=source['state']
        if source['state']=='READY' and current.get('state')=='READY':
            result['storageReference']={'dataset':physical,'version':version}
        return result

    def list(self, actor):
        listing=self.cold.list_datasets(actor)
        for item in listing['datasets']:
            for value in item['versions']:
                # Display UNKNOWN has no status/admission snapshot. Repeating
                # strict status would fail the whole catalog for this one row.
                if value.get('errorCode')!='CACHE_METADATA_INCOMPLETE':
                    try:value.update(self.status(actor,item['dataset'],value['version']))
                    except self.d.CacheMetadataIncomplete:
                        value.update(self.d.DatasetCache._catalog_incomplete(value))
                if value.get('errorCode')=='CACHE_METADATA_INCOMPLETE':
                    value.update(warehouseReady=False,warehouseCanPrepare=False,
                        deletionPermissions={'allowed':False,'memberAllowed':False,'reason':'CACHE_METADATA_INCOMPLETE'})
                    value.pop('storageReference',None)
                    value.pop('recoveryConfigured',None)
                    continue
                value.pop('dataset',None)
                value['deletionPermissions']=self.cold.deletion_permissions(actor,item['dataset'],value['version'])
        return listing

    def prepare(self, actor, dataset, version):
        record,source_identity=self.cold._record_snapshot(actor,dataset,version)
        if self.cold.status(actor,dataset,version)['state']!='READY':raise ValueError('Warehouse original is not READY')
        with self.cold._locked():owners=list(self.cold._dataset(actor,dataset)['owners'])
        physical=self.cache_name(dataset)
        admin=self.d.Principal(actor.user_id,True)
        self.n.dataset_cache_admission(self.hot._footprint(record['manifest']),_exclude=((physical,version),))
        authority=self.n.storage_node().tier.authorities[self.n.CONFIG['storageArchive']['authority']]
        proof=authority.seal(admin,dataset,version,'authority-local-prepare')
        with authority.guard(admin,proof):
            # The authority guard already holds the original's global and
            # version locks. Re-entering the file lock on another descriptor
            # would block our own process.
            self.cold._check_snapshot(actor,dataset,version,source_identity)
            if self.cold._dataset(actor,dataset)['owners']!=owners:raise PermissionError('Warehouse authorization changed')
            registered=self.hot._register(admin,physical,record['manifest'],owners,None,
                _origin='replica' if owners==[actor.user_id] else 'admin',
                _receipt='warehouse-'+hashlib.sha256((dataset+version).encode()).hexdigest()[:48] if owners==[actor.user_id] else None)
            if registered['version']!=version:raise ValueError('Local cache version differs from warehouse')
            self.d._write_json(self.bindings/(physical+'-'+version+'.json'),dict(source=dataset,target=physical,version=version,
                sourceRoot=list(self.cold._root_identity),targetRoot=list(self.hot._root_identity)))
        def validate():
            with self.cold._locked():
                self.cold._check_snapshot(actor,dataset,version,source_identity)
                if self.cold._dataset(actor,dataset)['owners']!=owners:raise PermissionError('Warehouse authorization changed')
            if self.hot._dataset(actor,physical)['owners']!=owners:raise PermissionError('Training cache authorization changed')
        authority.recover(admin,proof,self.hot,physical,validate_target=validate)
        self.n.storage_node().tier.verify_authority(admin,physical,version,self.n.CONFIG['storageArchive']['authority'],authority_dataset=dataset)
        return self.status(actor,dataset,version)

    def retirement(self, *, dataset=None, version=None, operation_id=None, originals=False):
        # Dispatch by exact durable registration/operation identity, not a name
        # prefix, user role flag, request path or disk selector.
        use_cold=None
        if operation_id is not None:
            if not isinstance(operation_id,str) or str(uuid.UUID(operation_id))!=operation_id:
                raise ValueError('Invalid fixed retirement operation identity')
            normal=self.n.ROOT/'dataset-retirements'/(operation_id+'.json')
            cold=self.control/'dataset-retirements'/(operation_id+'.json')
            if normal.exists() and cold.exists():raise ValueError('Ambiguous dual-root retirement identity')
            if normal.exists() or cold.exists():use_cold=cold.exists()
        if use_cold is None and dataset is not None:
            with self.cold._locked():
                paths=self.cold._paths(dataset,version)
                use_cold=(self.cold._paths(dataset)['.registry']/'dataset.json').exists()
                if version is not None:
                    use_cold=use_cold or any(path.exists() for path in (
                        paths['ready'],paths['.staging'],self.cold.root/'.tiers'/dataset/(version+'.json'),
                        self.cold.root/'.retirements'/dataset/(version+'.json')))
            if use_cold and (self.hot._paths(dataset)['.registry']/'dataset.json').exists():
                raise ValueError('Ambiguous dual-root dataset registration')
        if use_cold is None:use_cold=originals
        spec=importlib.util.spec_from_file_location('gpuq_warehouse_retirement',self.n.HERE/'dataset-retirement-node.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.RetirementNode.from_executor(self.view if use_cold else self.cache_view)
