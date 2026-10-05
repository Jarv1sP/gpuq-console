"""Exact, private single-grant retirement; never a generic unpin API.

The authenticated control plane supplies identities, not user evidence. The
target proves its normal removal and permanently fences its installed grant.
The HDD verifies a sealed replacement and complete manifest containment before
revoking issuance/reads, releasing one exact authority pin, and scheduling the
ordinary unregister worker. Unknown consumers retain protection.
"""
import contextlib
import hashlib
import os
import re
import time


class AuthorityRetirement:
    def __init__(self, archive, authority):
        self.s = archive
        self.n, self.cache = archive.n, archive.cache
        # Reuse the caller's already-loaded module instances and trusted config.
        self.A = authority
        self.D, self.J = self.A.D, self.A.J

    def exact(self, args, fields):
        if not isinstance(args, dict) or set(args) != set(fields):
            raise ValueError('Exact private authority retirement identities are required')

    def ref(self, value):
        self.exact(value, ('dataset','version'))
        self.D._identifier(value['dataset']); self.D._identifier(value['version'],self.D.HASH_RE)
        return dict(value)

    def existing(self, path):
        try:
            with self.D._directory(path.parent) as parent:
                os.stat(path.name,dir_fd=parent,follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    def files(self, folder):
        try:
            with self.D._directory(folder) as fd:
                names = sorted(os.listdir(fd))
        except FileNotFoundError:
            return []
        if len(names)>50000:
            raise ValueError('Retirement metadata history requires offline reconciliation')
        return names

    def quiescent(self, ref, *, skip_unregister=None):
        """Only exact matching metadata; no processes are stopped or polled away."""
        jobs = self.J.TransferJobs(self.n)
        for name in self.files(jobs.root):
            if name.endswith('.source-lease.json'):
                ident = name[:-len('.source-lease.json')]
                journal = jobs.load(ident,'.source-lease.json')
                if journal.get('reference') == dict(kind='datasets',**ref) and journal.get('state') != 'RELEASED':
                    raise ValueError('Active or unknown source transfer prevents authority retirement')
            elif name.endswith('.json') and self.J.UUID.fullmatch(name[:-5]):
                spec = jobs.load(name[:-5])
                if spec.get('reference') != dict(kind='datasets',**ref):
                    continue
                if (jobs.activity(jobs.unit(spec['id'],spec['attempt'])) is not False
                        or jobs.load(spec['id'],'.result.json').get('state') not in ('SUCCEEDED','FAILED','CANCELED')):
                    raise ValueError('Active or unknown transfer worker prevents authority retirement')
        folder = self.n.ROOT/'dataset-ops'
        for name in self.files(folder):
            if not re.fullmatch(r'[a-f0-9]{64}\.json',name):
                continue
            ident = name[:-5]; spec = self.A._load(folder/name)
            if spec.get('dataset') != ref['dataset'] or spec.get('version') not in (None,ref['version']):
                continue
            if ident == skip_unregister:
                continue
            if (jobs.activity('gpuq-data-'+ident[:32]+'.service') is not False
                    or self.A._load(folder/(ident+'.result.json')).get('state') not in ('READY','REGISTERED','UNREGISTERED','FAILED')):
                raise ValueError('Active or unknown dataset worker prevents authority retirement')

    def removal(self, user, ref, identity, recovery_id):
        if not isinstance(recovery_id,str) or not re.fullmatch(r'unregister-[a-f0-9]{32}',recovery_id):
            raise ValueError('An exact normal unregister receipt is required')
        folder = self.cache.root/'.trash'/recovery_id
        removal = self.D._read_json(folder/'REMOVAL.json')
        if (removal.get('schema') != self.D.SCHEMA or removal.get('unregistered') is not True
                or removal.get('dataset') != ref['dataset'] or removal.get('version') not in (None,ref['version'])
                or ref['version'] not in removal.get('versions',[]) or removal.get('owners') != [user]):
            raise ValueError('Normal removal does not match the retired owner/reference')
        record_path = folder/'registration'/(ref['version']+'.json')
        with self.D._directory(record_path.parent) as fd:
            child = os.open(record_path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            try:
                if list(self.D._stamp(self.D._regular(child)))[:4] != identity[:4]:
                    raise ValueError('Normal removal is not the certified registration')
            finally:
                os.close(child)
        record = self.D._read_json(record_path)
        if (self.D._read_json(folder/'registration'/'dataset.json').get('owners') != [user]
                or hashlib.sha256(self.D._manifest_bytes(record['manifest'])[1]).hexdigest() != ref['version']):
            raise ValueError('Removed immutable manifest or owner differs')
        return self.A._sha(dict(removal=removal,registration=identity,record=record))

    def target(self, args):
        self.s._require(source=False)
        self.exact(args, ('mode','opId','userId','target','grantId','certifyId','recoveryId','receiptSha256'))
        op = self.J.identifier(args['opId']); user = self.D._identifier(args['userId'],self.D.USER_RE)
        ref = self.ref(args['target']); grant_id = self.J.identifier(args['grantId']); certify = self.J.identifier(args['certifyId'])
        self.D._identifier(args['receiptSha256'],self.D.HASH_RE)
        # Admission prevents a new certify journal from escaping the scan. A
        # previously admitted certify is serialized by the same operation lock.
        with self.s._lock('admission'), self.s._lock('op-'+certify):
            row = self.s._load(self.s._op_path(certify))
            if (not row or row.get('kind') != 'certify' or row.get('state') != 'READY'
                    or row.get('binding') != self.s.binding or row.get('receiptSha256') != args['receiptSha256']
                    or row.get('digest') != self.s._digest('certify',row.get('request',{}))
                    or row.get('request',{}).get('userId') != user or row['request'].get('target') != ref):
                raise ValueError('Retirement requires the exact completed certification')
            grant = self.A._validate_grant(row['request']['grant'],self.s.policy['machine'],self.s.machine)
            if grant['id'] != grant_id or grant['receipt']['owners'] != [user]:
                raise ValueError('Certification grant identity differs')
            for name in self.files(self.s.root/'operations'):
                other = self.s._load(self.s._op_path(self.J.identifier(name)))
                if other and other.get('request',{}).get('grant',{}).get('id') == grant_id:
                    if name != certify or self.s.worker_state(name) != 'STOPPED':
                        raise ValueError('Another or unknown certification depends on this authority')
            binding = self.A._sha(args); remote = self.s.remote
            with remote.scope(grant['dataset'],grant['version']):
                path = remote.fence_path(grant['dataset'],grant['version'])
                prior = self.s._load(path)
                if prior is not None:
                    if prior.get('binding') != binding:
                        raise ValueError('Authority retirement identity cannot change')
                    return prior['proof']
                if remote._grant(grant['dataset'],grant['version']) != grant:
                    raise ValueError('Installed authority grant changed')
                # This probes the running peer, not the version of files on
                # disk. An old persistent listener cannot acknowledge fences.
                client = self.A.AuthorityClient(remote.peer,grant)
                try:
                    if client.call('retirement-guard') != dict(protocol='authority-retirement-v1',receipt=grant['receipt']):
                        raise ValueError('Running authority peer does not support retirement fences')
                finally:
                    client.close()
                with self.cache._lock_file('.locks/'+ref['dataset']+'.'+ref['version']+'.lock'):
                    self.quiescent(ref)
                    with self.cache._locked():
                        paths = self.cache._paths(**ref)
                        if (self.existing(self.cache._paths(ref['dataset'])['.registry']/(ref['version']+'.json'))
                                or any(self.existing(paths[k]) for k in ('ready','.staging'))
                                or self.cache._leases(**ref) or self.cache._tier(**ref)['pins']):
                            raise ValueError('Live or unknown target data prevents retirement')
                        recovery = self.cache._tier(**ref)['recovery']
                        if (self.A._sha(recovery) != args['receiptSha256']
                                or recovery.get('registration') != row['registration']
                                or recovery.get('proof') != remote._proof(grant)):
                            raise ValueError('Removed target recovery proof differs')
                        # One grant can have aliases on the same node. Fail
                        # closed rather than silently retire their recovery.
                        for dataset in self.files(self.cache.root/'.tiers'):
                            self.D._identifier(dataset)
                            for version_file in self.files(self.cache.root/'.tiers'/dataset):
                                if not version_file.endswith('.json'):
                                    raise ValueError('Unknown tier metadata')
                                version = self.D._identifier(version_file[:-5],self.D.HASH_RE)
                                tier = self.cache._tier(dataset,version)
                                if ((dataset,version)!=(ref['dataset'],ref['version'])
                                        and (tier.get('recovery') or {}).get('proof',{}).get('grantId') == grant_id):
                                    raise ValueError('Another cache reference depends on this authority')
                        removed = self.removal(user,ref,row['registration'],args['recoveryId'])
                        proof = dict(protocol=1,state='REVOKED',opId=op,userId=user,grantId=grant_id,
                            sourceMachine=grant['sourceMachine'],targetMachine=grant['targetMachine'],
                            source=dict(dataset=grant['dataset'],version=grant['version']),target=ref,
                            grantReceiptSha256=self.A._sha(grant['receipt']),removalSha256=removed)
                        proof['proofSha256'] = self.A._sha(proof)
                        self.s._save(path,dict(binding=binding,proof=proof,at=time.time()))
                        return proof

    def source(self, args):
        self.s._require(source=True)
        self.exact(args, ('mode','opId','userId','grantId','replacementGrantId','targetProof') + (('retryKey',) if 'retryKey' in args else ()))
        op = self.J.identifier(args['opId']); user = self.D._identifier(args['userId'],self.D.USER_RE)
        retry = self.J.identifier(args['retryKey']) if 'retryKey' in args else None
        grant_id = self.J.identifier(args['grantId']); replacement_id = self.J.identifier(args['replacementGrantId'])
        store = self.s.store; folder = store.root/grant_id
        grant = self.A._load(folder/'grant.json'); replacement = self.A._load(store.root/replacement_id/'grant.json')
        if grant.get('id') != grant_id or replacement.get('id') != replacement_id:
            raise ValueError('Authority journal identity differs')
        for item in (grant,replacement):
            self.A._validate_grant(item,self.s.machine,item.get('targetMachine'))
            if item['receipt']['owners'] != [user]:
                raise ValueError('Authority retirement cannot change ownership')
        old = dict(dataset=grant['dataset'],version=grant['version'])
        new = dict(dataset=replacement['dataset'],version=replacement['version'])
        if old == new or old['version'] == new['version']:
            raise ValueError('Retirement needs a distinct, sealed replacement version')
        proof = args['targetProof']
        self.exact(proof, ('protocol','state','opId','userId','grantId','sourceMachine','targetMachine',
                          'source','target','grantReceiptSha256','removalSha256','proofSha256'))
        if (proof['protocol'] != 1 or proof['state'] != 'REVOKED' or proof['opId'] != op or proof['userId'] != user
                or proof['grantId'] != grant_id or proof['sourceMachine'] != self.s.machine
                or proof['targetMachine'] != grant['targetMachine'] or proof['source'] != old
                or proof['grantReceiptSha256'] != self.A._sha(grant['receipt'])
                or proof['proofSha256'] != self.A._sha({k:v for k,v in proof.items() if k!='proofSha256'})):
            raise ValueError('Trusted target revocation proof does not match this authority')
        self.ref(proof['target']);self.D._identifier(proof['removalSha256'],self.D.HASH_RE)
        binding = self.A._sha({key:value for key,value in args.items() if key!='retryKey'}); journal_path = folder/'retirement.json'
        # Both source identities are locked in stable order. A simultaneous
        # retirement cannot use an already-retired replacement as its proof.
        with contextlib.ExitStack() as locks:
            for ref in sorted([old,new],key=lambda ref:(ref['dataset'],ref['version'])):
                locks.enter_context(store.reference_lock(**ref))
            store.assert_live(**new)
            replacement_proof = self.A._load(store.root/replacement_id/'sealed.json')
            if self.A._sha(replacement_proof) != replacement['receipt']['sealedSha256']:
                raise ValueError('Replacement seal differs')
            prior = self.s._load(journal_path)
            if prior is not None and prior.get('binding') != binding:
                raise ValueError('Authority retirement request cannot change')
            # A trusted, fully sealed replacement must remain protected on
            # every retry, including after the old registration was removed.
            with store.local.guard(self.s.admin,replacement_proof,_hold_global=False):
                if prior is None or prior.get('state') != 'REVOKED':
                    self._revoke_source(args,grant,replacement,old,new,binding,journal_path)
            # Ordinary unregister is detached, bounded and has its own normal
            # REMOVAL receipt. Fixed request identity prevents lost-ACK replay.
            prior = self.s._load(journal_path)
            source_proof = self.A._load(folder/'sealed.json')
            if self.A._sha(source_proof) != grant['receipt']['sealedSha256']:
                raise ValueError('Old source seal differs')
            request_id = prior.get('unregisterRequestId',op)
            def submit(ident):
                return self.n._dataset_op('datasets.unregister',dict(userId=user,hostAdmin=True,**old),
                    _request_id=ident,_expected_registration=source_proof['registration'],_expected_owners=source_proof['owners'])
            result = submit(request_id)
            if retry is not None and retry != request_id:
                if retry in prior.get('unregisterAttempts',[]) or retry == op:
                    raise ValueError('Retirement retry key already belongs to an earlier attempt')
                if (result.get('state') != 'FAILED' or not isinstance(result.get('operationId'),str)
                        or not self.D.HASH_RE.fullmatch(result['operationId'])
                        or self.J.TransferJobs(self.n).activity('gpuq-data-'+result['operationId'][:32]+'.service') is not False):
                    raise ValueError('Explicit retry requires a confirmed failed and stopped unregister worker')
                attempts = prior.get('unregisterAttempts',[op])
                if len(attempts) >= 32:
                    raise ValueError('Retirement retry history requires administrator reconciliation')
                prior.update(unregisterRequestId=retry,unregisterAttempts=[*attempts,retry])
                self.s._save(journal_path,prior)  # Bind before dispatch; a lost ACK never creates another attempt.
                result = submit(retry)
            return dict(protocol=1,opId=op,userId=user,grantId=grant_id,source=old,
                state='RETIRED' if result.get('state') == 'UNREGISTERED' and result.get('unregistered') is True else 'UNREGISTERING',
                unregister=result)

    def _revoke_source(self,args,grant,replacement,old,new,binding,journal_path):
        store = self.s.store
        source_proof = self.A._load(store.root/grant['id']/'sealed.json')
        if self.A._sha(source_proof) != grant['receipt']['sealedSha256']:
            raise ValueError('Old source seal differs')
        # Global source-ticket history admission makes PREPARING without a
        # lease visible and prevents an unseen late ticket being admitted.
        jobs = self.J.TransferJobs(self.n)
        with jobs.lock('00000000-0000-0000-0000-000000000000','.source-history.lock'):
            with self.cache._lock_file('.locks/'+old['dataset']+'.'+old['version']+'.lock'):
                self.quiescent(old)
                for name in self.files(self.s.root/'operations'):
                    operation = self.s._load(self.s._op_path(self.J.identifier(name)))
                    if operation and operation.get('request',{}).get('source') == old:
                        if (name != grant['id'] or operation.get('kind') != 'provision'
                                or operation.get('state') != 'READY' or self.s.worker_state(name) != 'STOPPED'):
                            raise ValueError('Another or unknown authority worker retains the original')
                for name in self.files(store.root):
                    if not self.J.UUID.fullmatch(name):
                        continue
                    other = self.A._load(store.root/name/'grant.json')
                    if (other.get('dataset'),other.get('version')) == (old['dataset'],old['version']) and name != grant['id']:
                        raise ValueError('Another authority grant depends on the old original')
                old_record = self.cache._record(self.s.admin,**old)
                new_record = self.cache._record(self.s.admin,**new)
                index = {entry['path']:entry for entry in new_record['manifest']['files']}
                if (any(index.get(entry['path']) != entry for entry in old_record['manifest']['files'])
                        or not set(old_record['manifest']['directories']).issubset(new_record['manifest']['directories'])):
                    raise ValueError('Sealed replacement does not contain every old path, size and checksum')
                with self.cache._locked():
                    tier = self.cache._tier(**old)
                    fence = dict(binding=binding,opId=args['opId'],grantId=grant['id'],
                        replacementGrantId=replacement['id'],targetProofSha256=args['targetProof']['proofSha256'])
                    previous = self.s._load(store.reference_fence(**old))
                    if previous is not None and previous != fence:
                        raise ValueError('Another retirement already fenced this original')
                    if previous is None or grant['receipt']['pinId'] in tier['pins']:
                        store.local._validate_locked(self.s.admin,source_proof)
                    else:
                        # Recover only the precise crash window after this
                        # durable retirement removed its pin, before REVOKED
                        # was saved. Every other sealed identity stays exact.
                        journal = self.s._load(journal_path)
                        ready = self.cache._paths(**old)['ready']
                        if (journal != dict(binding=binding,state='REVOKING',fence=fence)
                                or tier['role'] != 'protected' or tier['pins']
                                or self.cache._dataset(self.s.admin,old['dataset'])['owners'] != source_proof['owners']
                                or list(self.cache._record_identity(**old)) != source_proof['registration']
                                or list(self.cache._root_identity) != source_proof['rootIdentity']
                                or self.A.T._persistent_mount_identity(self.cache.mount) != self.A.T._persistent_mount_identity(source_proof['mountIdentity'])
                                or store.local._identities(ready) != source_proof['identities']
                                or self.D._read_json(ready/'READY.json') != dict(schema=self.D.SCHEMA,version=old['version'])):
                            raise ValueError('Interrupted retirement source identity changed')
                    if (self.cache._leases(**old) or self.existing(self.cache._paths(**old)['.staging'])
                            or set(tier['pins']) not in ({grant['receipt']['pinId']},set())
                            or previous is None and not tier['pins']):
                        raise ValueError('Leases, writers or other retention pins prevent source retirement')
                    # Persist fences BEFORE changing protection. Ordinary APIs
                    # can never remove these tombstones or reissue the grant.
                    self.s._save(journal_path,dict(binding=binding,state='REVOKING',fence=fence))
                    self.s._save(store.reference_fence(**old),fence)
                    tier['pins'].pop(grant['receipt']['pinId'],None)
                    self.cache._write_tier(**old,value=tier)
                    self.s._save(journal_path,dict(binding=binding,state='REVOKED',fence=fence))
