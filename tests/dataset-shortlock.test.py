"""Catalog validation is outside global locks; final metadata/ACL checks fail closed."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from dataset_retention_helpers import protected_original

SPEC = importlib.util.spec_from_file_location('dataset_shortlock', Path(__file__).resolve().parents[1]/'deploy'/'dataset-cache.py')
D = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(D)
ADMIN, OWNER, OTHER = D.Principal('admin', True), D.Principal('owner'), D.Principal('other')


class DatasetShortLockTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name).resolve()
        self.cache=D.DatasetCache(self.base/'cache',reserve_bytes=1024,lock_timeout=0.05)
        empty=hashlib.sha256(b'').hexdigest()
        manifest={'schema':1,'directories':[],'files':[{'path':f'large-{n:05d}.bin','size':0,'sha256':empty} for n in range(2000)]}
        self.version=self.cache.register_manifest(ADMIN,'large',manifest,[OWNER.user_id])['version']
        self.paths=self.cache._paths('large',self.version)
        self.small=self.cache.register_manifest(ADMIN,'small',{'schema':1,'directories':[],'files':[]},[OWNER.user_id])['version']
        self.other=D.DatasetCache(self.cache.root,reserve_bytes=1024,lock_timeout=0.05)

    def tearDown(self):
        for root,_dirs,files in os.walk(self.base,followlinks=False):
            os.chmod(root,0o700)
            for name in files:
                path=Path(root)/name
                if not path.is_symlink():os.chmod(path,0o600)
        self.temp.cleanup()

    def ready_metadata(self):
        """Isolated metadata fixture, not a production publication bypass."""
        p=self.paths['ready'];p.mkdir();(p/'data').mkdir()
        manifest=D._read_json(self.paths['.registry'].parent/(self.version+'.json'))['manifest']
        D._write_json(p/'manifest.json',manifest);D._write_json(p/'READY.json',{'schema':1,'version':self.version})
        (p/'data').chmod(0o555);p.chmod(0o555)

    def while_blocked(self, operation, target):
        entered,resume=threading.Event(),threading.Event();errors=[]
        original=D._manifest_bytes if target=='registry' else D._canonical_json_matches
        def slow(value,*args,**kwargs):
            selected=(isinstance(value,dict) and len(value.get('files',[]))==2000) if target=='registry' else Path(value)==self.paths['ready']/'manifest.json'
            if selected:
                entered.set()
                if not resume.wait(5):raise AssertionError('reader not resumed')
            return original(value,*args,**kwargs)
        def run():
            try:operation()
            except BaseException as e:errors.append(e)
        with patch.object(D,'_manifest_bytes' if target=='registry' else '_canonical_json_matches',side_effect=slow):
            worker=threading.Thread(target=run);worker.start()
            try:
                self.assertTrue(entered.wait(3))
                plan=self.other.plan(OWNER,'small',self.small)
                self.assertEqual(self.other.publish(OWNER,'small',self.small,plan['token'])['state'],'READY')
            finally:
                resume.set();worker.join(5)
        self.assertFalse(worker.is_alive());self.assertEqual(errors,[])

    def test_large_catalog_registry_validation_allows_unrelated_publication(self):
        self.while_blocked(lambda:self.cache.list_datasets(OWNER),'registry')

    def test_large_status_registry_validation_allows_unrelated_publication(self):
        self.while_blocked(lambda:self.cache.status(OWNER,'large',self.version),'registry')

    def test_ready_manifest_comparison_allows_unrelated_publication(self):
        self.ready_metadata()
        self.while_blocked(lambda:self.cache.status(OWNER,'large',self.version),'ready')

    def test_ready_catalog_comparison_allows_unrelated_publication(self):
        self.ready_metadata()
        self.while_blocked(lambda:self.cache.list_datasets(OWNER),'ready')

    def test_ready_materialize_initial_record_validation_allows_unrelated_publication(self):
        self.ready_metadata()
        self.while_blocked(lambda:self.cache.materialize(OWNER,'large',self.version),'registry')

    def test_ready_materialize_comparison_allows_unrelated_publication(self):
        self.ready_metadata()
        self.while_blocked(lambda:self.cache.materialize(OWNER,'large',self.version),'ready')

    def test_lease_admission_validation_allows_unrelated_publication(self):
        self.ready_metadata()
        self.while_blocked(lambda:self.cache.acquire_lease(OWNER,'large',self.version,'job'),'registry')

    def test_lease_release_validation_allows_unrelated_publication(self):
        self.ready_metadata();lease=self.cache.acquire_lease(OWNER,'large',self.version,'job')
        self.while_blocked(lambda:self.cache.release_lease(ADMIN,'large',self.version,lease['leaseId']),'registry')

    def test_eviction_after_ready_validation_prevents_new_lease(self):
        self.ready_metadata();snapshot=self.cache._ready_snapshot
        source=self.base/'protected-large';source.mkdir()
        for n in range(2000):(source/f'large-{n:05d}.bin').write_bytes(b'')
        retention=protected_original(self.cache,D,self.base/'retention-original',source_trees={('large',self.version):source})
        retention.bind_cache(self.other)
        def evict(*args):
            value=snapshot(*args);self.other.evict(ADMIN,'large',self.version);return value
        with patch.object(self.cache,'_ready_snapshot',side_effect=evict),self.assertRaisesRegex(D.CacheError,'metadata changed'):
            self.cache.acquire_lease(OWNER,'large',self.version,'job')
        self.assertEqual(self.cache._leases('large',self.version),[])

    def test_all_heavy_catalog_validation_runs_outside_global_lock(self):
        self.ready_metadata();depth=0;lock=self.cache._locked;read=D._read_json;validate=D._manifest_bytes;canonical=D._canonical_json_matches
        @contextlib.contextmanager
        def tracked():
            nonlocal depth
            with lock():
                depth+=1
                try:yield
                finally:depth-=1
        def checked_read(p):
            if p.name in (self.version+'.json','manifest.json'):self.assertEqual(depth,0)
            return read(p)
        def checked_validate(v):
            self.assertEqual(depth,0);return validate(v)
        def checked_canonical(path,digest):
            self.assertEqual(depth,0);return canonical(path,digest)
        with patch.object(self.cache,'_locked',side_effect=tracked),patch.object(D,'_read_json',side_effect=checked_read),patch.object(D,'_manifest_bytes',side_effect=checked_validate),patch.object(D,'_canonical_json_matches',side_effect=checked_canonical):
            self.assertEqual(self.cache.list_datasets(OWNER)['datasets'][0]['versions'][0]['state'],'READY')
            self.assertEqual(self.cache.status(OWNER,'large',self.version)['state'],'READY')
            self.assertEqual(self.cache.export_manifest(OWNER,'large',self.version)['version'],self.version)

    def test_registration_replacement_after_parse_is_rejected_even_if_byte_identical(self):
        record=self.cache._record
        def replace(*args,**kwargs):
            result=record(*args,**kwargs);D._write_json(self.paths['.registry'].parent/(self.version+'.json'),result);return result
        with patch.object(self.cache,'_record',side_effect=replace),self.assertRaisesRegex(D.CacheError,'registration changed'):
            self.cache.status(OWNER,'large',self.version)

    def test_revocation_after_parse_never_returns_manifest_or_catalog(self):
        for action in ('status','export_manifest','list_datasets'):
            with self.subTest(action=action):
                self.cache.set_owners(ADMIN,'large',[OWNER.user_id]);record=self.cache._record
                def revoke(*args,**kwargs):
                    value=record(*args,**kwargs);self.other.set_owners(ADMIN,'large',[OTHER.user_id]);return value
                with patch.object(self.cache,'_record',side_effect=revoke),self.assertRaises(PermissionError):
                    getattr(self.cache,action)(OWNER,*(() if action=='list_datasets' else ('large',self.version)))

    def test_revocation_at_catalog_finalization_is_rejected(self):
        snapshot=self.cache._ready_snapshot
        def revoke(*args):
            value=snapshot(*args);self.other.set_owners(ADMIN,'large',[OTHER.user_id]);return value
        with patch.object(self.cache,'_ready_snapshot',side_effect=revoke),self.assertRaises(PermissionError):
            self.cache.list_datasets(OWNER)

    def test_ready_metadata_replacement_after_validation_is_rejected(self):
        self.ready_metadata();snapshot=self.cache._ready_snapshot
        def replace(*args):
            value=snapshot(*args);p=self.paths['ready'];p.chmod(0o700)
            D._write_json(p/'READY.json',{'schema':1,'version':self.version});p.chmod(0o555);return value
        with patch.object(self.cache,'_ready_snapshot',side_effect=replace),self.assertRaisesRegex(D.CacheError,'metadata changed'):
            self.cache.status(OWNER,'large',self.version)

    def test_ready_appearing_after_absent_snapshot_is_rejected(self):
        snapshot=self.cache._ready_snapshot
        def appear(*args):
            value=snapshot(*args);self.ready_metadata();return value
        with patch.object(self.cache,'_ready_snapshot',side_effect=appear),self.assertRaisesRegex(D.CacheError,'metadata changed'):
            self.cache.status(OWNER,'large',self.version)

    def test_missing_ready_marker_does_not_look_registered(self):
        self.ready_metadata();p=self.paths['ready'];p.chmod(0o700);(p/'READY.json').unlink();p.chmod(0o555)
        with self.assertRaisesRegex(D.CacheError,'READY metadata'):
            self.cache.status(OWNER,'large',self.version)

    def test_corrupt_registry_and_ready_are_not_cached_as_valid(self):
        self.ready_metadata();manifest=self.paths['ready']/'manifest.json';manifest.chmod(0o600);manifest.write_text('{}');manifest.chmod(0o444)
        with self.assertRaisesRegex(D.CacheError,'corrupt'):
            self.cache.status(OWNER,'large',self.version)
        registry=self.paths['.registry'].parent/(self.version+'.json');registry.write_text('{}')
        with self.assertRaisesRegex(D.CacheError,'registration'):
            self.cache.list_datasets(OWNER)

    def test_symlink_and_hardlink_metadata_are_rejected(self):
        registry=self.paths['.registry'].parent/(self.version+'.json');safe=registry.read_bytes();outside=self.base/'outside.json';outside.write_bytes(safe)
        registry.unlink();registry.symlink_to(outside)
        with self.assertRaises(OSError):self.cache.status(OWNER,'large',self.version)
        registry.unlink();os.link(outside,registry)
        with self.assertRaisesRegex(D.CacheError,'single link'):self.cache.status(OWNER,'large',self.version)

    def test_only_catalog_uses_private_disposable_summaries_not_status(self):
        before=sorted(str(p.relative_to(self.cache.root)) for p in self.cache.root.rglob('*') if p.name!='.lock')
        self.cache.status(OWNER,'large',self.version)
        self.assertEqual(before,sorted(str(p.relative_to(self.cache.root)) for p in self.cache.root.rglob('*') if p.name!='.lock'))
        self.cache.list_datasets(OWNER)
        after=sorted(str(p.relative_to(self.cache.root)) for p in self.cache.root.rglob('*') if p.name!='.lock')
        self.assertEqual(before,[name for name in after if name!='.catalog' and not name.startswith('.catalog/')])
        with patch.object(self.cache,'_catalog_summary',side_effect=AssertionError('status must not trust catalog')):
            self.cache.status(OWNER,'large',self.version)


if __name__=='__main__':unittest.main()
