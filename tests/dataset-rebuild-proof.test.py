"""Consume real external replacement proofs; no forged positive guards."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('replacement_proof_fixture',Path(__file__).with_name('storage-retirement.test.py'))
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
spec=importlib.util.spec_from_file_location('replacement_rebuild_fixture',Path(__file__).resolve().parents[1]/'deploy/dataset-rebuild-proof.py')
REBUILD=importlib.util.module_from_spec(spec);spec.loader.exec_module(REBUILD)


class ReplacementProofTests(F.AuthorityRetirementTests):
    # Select only new tests; the unchanged external suite is run separately.
    def prepared_revoke(self):
        f=self.prepared();proof=f['target'].retire(f['args']);args=self.source_args(f,proof)
        from types import SimpleNamespace
        calls=[]
        def dispatch(operation,request,**fixed):
            calls.append((operation,request,fixed))
            return dict(operationId='a'*64,state='UNREGISTERING')
        with patch.object(self.node,'_dataset_op',side_effect=dispatch):
            self.source.retire(args)
        self.cold.rebuild_guard=REBUILD.RetiredReplacement(self.store).guard
        return f,args,calls

    def test_real_sealed_union_guards_full_old_manifest_without_rewriting_external_records(self):
        f,_,_=self.prepared_revoke()
        fence=self.store.reference_fence('original',self.version)
        journal=self.store.root/f['grant']['id']/'retirement.json'
        before=(fence.read_bytes(),journal.read_bytes())
        with self.cold.rebuild_guard(F.ADMIN,'original',self.version):
            self.assertEqual((fence.read_bytes(),journal.read_bytes()),before)
        self.assertEqual((fence.read_bytes(),journal.read_bytes()),before)
        result=self.cold.unregister(F.ADMIN,'original',self.version)
        self.assertTrue(result['unregistered']);self.assertEqual(self.cold.status(F.ADMIN,'replacement',f['new'])['state'],'READY')

    def test_same_owner_and_version_names_are_not_substitute_for_committed_proof(self):
        f=self.prepared()
        self.cold.rebuild_guard=REBUILD.RetiredReplacement(self.store).guard
        with self.assertRaises(FileNotFoundError):
            with self.cold.rebuild_guard(F.ADMIN,'original',self.version):pass
        self.assertEqual(self.cold.status(F.ADMIN,'original',self.version)['state'],'READY')

    def test_incomplete_retirement_or_changed_seal_never_allows_last_copy_removal(self):
        f,_,_=self.prepared_revoke();journal=self.store.root/f['grant']['id']/'retirement.json'
        saved=F.A._load(journal);self.source._save(journal,{**saved,'state':'REVOKING'})
        with self.assertRaisesRegex(ValueError,'incomplete'):
            self.cold.evict(F.ADMIN,'original',self.version)
        self.source._save(journal,saved)
        seal=self.store.root/f['replacement']['id']/'sealed.json'
        proof=F.A._load(seal);self.source._save(seal,{**proof,'owners':['someone-else']})
        with self.assertRaisesRegex(ValueError,'seals'):
            self.cold.evict(F.ADMIN,'original',self.version)
        self.assertTrue(self.cold._paths('original',self.version)['ready'].exists())

    def test_replacement_pins_owners_fences_and_registry_are_rechecked_at_consumption(self):
        f,_,_=self.prepared_revoke()
        tier=self.cold._tier('replacement',f['new'])
        saved=dict(tier);tier={**tier,'pins':{}};self.cold._write_tier('replacement',f['new'],tier)
        with self.assertRaises(ValueError):self.cold.evict(F.ADMIN,'original',self.version)
        self.cold._write_tier('replacement',f['new'],saved)
        self.source._save(self.store.reference_fence('replacement',f['new']),{'unknown':True})
        with self.assertRaisesRegex(ValueError,'retired'):
            self.cold.evict(F.ADMIN,'original',self.version)
        self.assertTrue(self.cold._paths('original',self.version)['ready'].exists())

    def test_external_retirement_stays_permanent_and_is_not_a_data_isolation_receipt(self):
        f,_,_=self.prepared_revoke()
        with self.assertRaisesRegex(ValueError,'retired'):
            self.store.deletion_dependencies(F.ADMIN,'original',self.version)
        self.assertEqual(self.cold.status(F.ADMIN,'original',self.version)['state'],'READY')
        with self.assertRaisesRegex(ValueError,'retired'):
            self.store.seal(F.ADMIN,'original',self.version,f['grant']['id'],'hot-node')


# Avoid inheriting/relabeling the unchanged external test cases in our count.
for name in dir(F.AuthorityRetirementTests):
    if name.startswith('test_') and name not in ReplacementProofTests.__dict__:
        setattr(ReplacementProofTests,name,None)

if __name__=='__main__':unittest.main()
