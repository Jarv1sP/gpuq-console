"""Read-only consumption of external replacement-retirement evidence.

Does not retire an authority, revoke a grant, remove pins or change a fence.
Only a committed external REVOKED journal plus a live permanently sealed source
containing every old path can authorize ordinary removal of the old bytes.
"""
import contextlib
import importlib.util
from pathlib import Path

spec=importlib.util.spec_from_file_location('replacement_authority_helpers',Path(__file__).with_name('storage-authority.py'))
A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)


class RetiredReplacement:
    def __init__(self,store):
        self.store=store

    def _evidence(self,dataset,version):
        store=self.store
        fence=A._load(store.reference_fence(dataset,version))
        fields={'binding','opId','grantId','replacementGrantId','targetProofSha256'}
        if not isinstance(fence,dict) or set(fence)!=fields:
            raise ValueError('Exact external replacement retirement is unconfirmed')
        for name in ('opId','grantId','replacementGrantId'):A.J.identifier(fence[name])
        for name in ('binding','targetProofSha256'):A.D._identifier(fence[name],A.D.HASH_RE)
        original=A._load(store.root/fence['grantId']/'grant.json')
        original=A._validate_grant(original,store.machine,original.get('targetMachine'))
        if original['dataset']!=dataset or original['version']!=version:
            raise ValueError('External replacement belongs to another old version')
        journal=A._load(store.root/fence['grantId']/'retirement.json')
        if (not isinstance(journal,dict) or set(journal)-{'binding','state','fence','unregisterRequestId','unregisterAttempts'}
                or journal.get('binding')!=fence['binding'] or journal.get('fence')!=fence or journal.get('state')!='REVOKED'):
            raise ValueError('External replacement retirement is incomplete')
        replacement=A._load(store.root/fence['replacementGrantId']/'grant.json')
        replacement=A._validate_grant(replacement,store.machine,replacement.get('targetMachine'))
        if replacement['version']==version or replacement['receipt']['owners']!=original['receipt']['owners']:
            raise ValueError('External replacement version or owners differ')
        old_seal=A._load(store.root/fence['grantId']/'sealed.json')
        new_seal=A._load(store.root/fence['replacementGrantId']/'sealed.json')
        if (A._sha(old_seal)!=original['receipt']['sealedSha256']
                or A._sha(new_seal)!=replacement['receipt']['sealedSha256']):
            raise ValueError('External replacement seals cannot be confirmed')
        return fence,original,replacement,old_seal,new_seal

    @contextlib.contextmanager
    def guard(self,actor,dataset,version):
        store,cache=self.store,self.store.cache
        cache._actor(actor)
        evidence=self._evidence(dataset,version)
        fence,original,replacement,old_seal,new_seal=evidence
        old_ref=(dataset,version);new_ref=(replacement['dataset'],replacement['version'])
        with contextlib.ExitStack() as scopes:
            # Same external lock/order as authority-source-v1; no TTL or
            # assumption that a returned network guard will remain valid.
            for ref in sorted([old_ref,new_ref]):
                scopes.enter_context(store.reference_lock(*ref))
            if self._evidence(dataset,version)!=evidence:
                raise ValueError('External replacement identity changed')
            store.assert_live(*new_ref)
            store._assert_live(replacement)
            scopes.enter_context(store.local.guard(store.principal,new_seal,_hold_global=False))
            old_record,old_identity=cache._record_snapshot(actor,dataset,version)
            new_record,new_identity=cache._record_snapshot(store.principal,*new_ref)
            with cache._locked():
                cache._check_snapshot(actor,dataset,version,old_identity)
                cache._check_snapshot(store.principal,*new_ref,new_identity)
                owners=cache._dataset(actor,dataset)['owners']
                if (list(old_identity)!=old_seal.get('registration') or list(cache._root_identity)!=old_seal.get('rootIdentity')
                        or owners!=original['receipt']['owners'] or owners!=old_seal.get('owners')
                        or new_seal.get('owners')!=owners or cache._tier(dataset,version)['role']!='protected'
                        or cache._tier(dataset,version)['pins']):
                    raise ValueError('Removed original registration or protection changed')
            index={entry['path']:entry for entry in new_record['manifest']['files']}
            if (any(index.get(entry['path'])!=entry for entry in old_record['manifest']['files'])
                    or not set(old_record['manifest']['directories']).issubset(new_record['manifest']['directories'])):
                raise ValueError('Replacement does not contain every old path, size and checksum')
            if self._evidence(dataset,version)!=evidence:
                raise ValueError('External replacement retirement changed')
            yield


@contextlib.contextmanager
def configured_guard(executor,actor,dataset,version):
    """Executor-owned choice; request JSON cannot choose a replacement source."""
    store=executor.storage_authority()
    if store is not None:
        try:
            A._load(store.reference_fence(dataset,version))
        except FileNotFoundError:
            pass
        else:
            with RetiredReplacement(store).guard(actor,dataset,version):
                yield
            return
    with executor.storage_node().tier.rebuild_guard(actor,dataset,version):
        yield
