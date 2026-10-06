"""Keep ownership metadata until a purged peer namespace is released."""
import importlib.util
from pathlib import Path
import unittest
import uuid
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('followup_nodes',ROOT/'tests/dataset-delete-node.test.py')
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)


class Followup(unittest.TestCase):
    setUp=F.RetirementNodeTests.setUp
    tearDown=F.RetirementNodeTests.tearDown

    def purged_peer(self,other_version,purge=True):
        cache=self.empty.cache;cache.sources['approved']=self.cache.sources['approved']
        with cache._locked():
            cache._register(F.D.Principal('owner',True),'sample',F.D._scan(cache.sources['approved']),['owner'],'approved',
                            _origin='upload',_receipt=str(uuid.uuid4()))
        cache.materialize(F.OWNER,'sample',self.version)
        if other_version:
            source=self.base/'other';source.mkdir();(source/'other.txt').write_bytes(b'other')
            cache.sources['other']=source
            with cache._locked():
                self.other=cache._register(F.D.Principal('owner',True),'sample',F.D._scan(source),['owner'],'other',
                                          _origin='upload',_receipt=str(uuid.uuid4()))['version']
        self.empty.plan(F.OWNER,'sample',self.version,self.empty_key)
        peer=self.empty.isolate(F.OWNER,self.empty_key,[])
        source=self.node.isolate(F.OWNER,self.key,[peer])
        committed=self.empty.commit(F.ADMIN,self.empty_key,source)
        F.D._write_json(self.empty._phase_path(self.empty_key,'commit','result'),dict(ok=True,result=committed))
        self.empty.retirement.clock=lambda:peer['retainUntil']+1
        self.empty.retirement.clock_synchronized=lambda:True
        if purge:self.assertEqual(self.empty.retirement.purge(F.ADMIN,self.empty_key)['state'],'PURGED')
        return cache

    def preserve_then_release(self,other_version):
        cache=self.purged_peer(other_version)
        metadata=cache._paths('sample')['.registry']/'dataset.json';before=metadata.read_bytes()
        records={path.name:path.read_bytes() for path in metadata.parent.glob('*.json')}
        removals=set((cache.root/'.trash').glob('unregister-*'))
        with self.assertRaisesRegex(F.D.CacheError,'已清除副本.*围栏'):
            cache.unregister(F.ADMIN,'sample')
        self.assertEqual(metadata.read_bytes(),before,'owners stay available to fixed source restoration')
        self.assertEqual({path.name:path.read_bytes() for path in metadata.parent.glob('*.json')},records)
        self.assertEqual(set((cache.root/'.trash').glob('unregister-*')),removals,'reject before any ordinary-removal transaction')
        if other_version:
            self.assertTrue(cache.unregister(F.ADMIN,'sample',self.other)['unregistered'],'single-version removal remains available')
            self.assertEqual(metadata.read_bytes(),before)
        restored=self.node.restore(F.ADMIN,self.key)
        self.assertEqual(self.empty.release_absence(F.ADMIN,self.empty_key,restored)['state'],'RELEASED')
        self.assertEqual(cache._retirement_fence('sample',self.version)['state'],'RELEASED')
        self.assertTrue(cache.unregister(F.ADMIN,'sample')['unregistered'],'whole removal works after proved namespace release')
        cache.register_source(F.ADMIN,'sample','approved',['owner']);cache.materialize(F.OWNER,'sample',self.version)
        self.assertEqual((cache._paths('sample',self.version)['ready']/'data/fixed.txt').read_bytes(),b'fixed full data')

    def test_N2a_whole_unregister_preserves_owners_for_purged_peer_then_source_release_and_reregistration(self):
        self.preserve_then_release(True)

    def test_N2a_whole_unregister_preserves_owners_when_only_purged_version_remains(self):
        self.preserve_then_release(False)

    def test_N2a_whole_unregister_rechecks_newly_purged_fence_before_the_metadata_move(self):
        cache=self.purged_peer(True,purge=False)
        metadata=cache._paths('sample')['.registry']/'dataset.json';before=metadata.read_bytes()
        cleanup=cache._unregister_cleanup;called=False
        def purge_during_cleanup(transaction):
            nonlocal called
            cleanup(transaction)
            if not called:
                called=True
                self.assertEqual(self.empty.retirement.purge(F.ADMIN,self.empty_key)['state'],'PURGED')
        with patch.object(cache,'_unregister_cleanup',side_effect=purge_during_cleanup),\
                self.assertRaisesRegex(F.D.CacheError,'已清除副本.*围栏'):
            cache.unregister(F.ADMIN,'sample')
        self.assertTrue(called)
        self.assertEqual(metadata.read_bytes(),before)
        self.assertTrue((metadata.parent/(self.other+'.json')).is_file())


if __name__=='__main__':unittest.main()
