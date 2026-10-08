"""Synthetic files and a fake OCI engine; never run containers or GPU jobs."""
import base64
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parents[1]/'deploy'
spec = importlib.util.spec_from_file_location('portable_test', HERE/'portable-project.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
s = p.load_store()
USER, PROJECT, IMAGE = 'demo-user-23', 'portable-fixture', 'sha256:'+'a'*64


class PortableProjectTests(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory(); self.path = Path(self.temp.name).resolve()
        self.addCleanup(self.cleanup)
        self.base = self.path/'base'; self.base.mkdir()
        self.source, self.target = self.store('source'), self.store('target')
        self.a, self.b = p.PortableProjects(self.source), p.PortableProjects(self.target)
        self.source.create(USER, PROJECT, environment_mode='oci')
        dev = self.source.dev_paths(USER, PROJECT)
        (dev['code']/'train.py').write_text('print("fixture")\n')
        (dev['code']/'bin').mkdir()
        (dev['code']/'bin/run').write_text('#!/bin/sh\ntrue\n'); (dev['code']/'bin/run').chmod(0o700)
        (dev['home']/'private-key').write_text('must not transfer')
        self.release = self.source.publish(USER, PROJECT)['release']

    def cleanup(self):
        for current, dirs, files in os.walk(self.path):
            Path(current).chmod(0o700)
            for name in files:
                if not (Path(current)/name).is_symlink(): (Path(current)/name).chmod(0o600)
        self.temp.cleanup()

    def store(self, name):
        root = self.path/name; root.mkdir(mode=0o700)
        store = s.ProjectStore(root, self.base, reserve_bytes=0)
        receipt = {'schema':1,'owner':hashlib.sha256(USER.encode()).hexdigest(),'project':PROJECT,'image':IMAGE}
        def export(slug, value, path):
            self.assertEqual(value,receipt); path.write_bytes(b'fake immutable OCI image')
            return {'schema':1,'image':IMAGE,'os':'linux','architecture':'amd64','diffIds':['sha256:'+'b'*64],
                    'unpackedBytes':24,'archiveBytes':path.stat().st_size,'archiveSha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        def verify(slug,value):
            self.assertEqual(value,receipt); return IMAGE
        store._oci = lambda user: SimpleNamespace(verify_host=lambda:None,publish=lambda slug:dict(receipt),
            verify_image=verify,export_image=export,import_image=lambda *args:None,
            portable_image=lambda slug,value:{'schema':1,'image':verify(slug,value),'os':'linux',
                'architecture':'amd64','diffIds':['sha256:'+'b'*64],'unpackedBytes':24})
        return store

    def stage(self):
        self.a.export(USER,PROJECT,self.release)
        source, manifest = self.a.manifest(USER,PROJECT,self.release)
        folder = self.b.folder(USER,'imports')/str(uuid.uuid4()); folder.mkdir(mode=0o700)
        for directory in sorted(manifest['directories'],key=lambda path:len(Path(path).parts)):
            (folder/directory).mkdir(mode=0o700)
        for entry in manifest['files']:
            (folder/entry['path']).write_bytes((source/entry['path']).read_bytes())
        return folder,manifest

    def test_pinned_release_moves_with_image_and_executable_not_home(self):
        folder,manifest = self.stage()
        result = self.b.import_bundle(USER,PROJECT,self.release,folder,manifest)
        self.assertEqual(result['state'],'READY'); self.assertFalse(result['developmentChanged'])
        imported = self.target.release(USER,PROJECT,self.release)
        self.assertEqual((imported['code']/'train.py').read_text(),'print("fixture")\n')
        self.assertTrue((imported['code']/'bin/run').stat().st_mode & 0o111)
        self.assertFalse(any('private-key' in entry['path'] for entry in manifest['files']))
        self.assertIsNone(self.target.status(USER,PROJECT)['latestReadyRelease'])
        self.assertEqual(os.listdir(self.target.dev_paths(USER,PROJECT)['code']),[])

    def test_import_does_not_change_existing_dev_home_latest_or_container(self):
        self.target.create(USER,PROJECT,environment_mode='oci')
        dev = self.target.dev_paths(USER,PROJECT)
        (dev['code']/'local.py').write_text('unsaved destination work')
        (dev['home']/'secret').write_text('destination secret')
        previous = self.target.publish(USER,PROJECT)['release']
        before = self.target.status(USER,PROJECT)
        folder,manifest = self.stage(); self.b.import_bundle(USER,PROJECT,self.release,folder,manifest)
        self.assertEqual((dev['code']/'local.py').read_text(),'unsaved destination work')
        self.assertEqual((dev['home']/'secret').read_text(),'destination secret')
        self.assertEqual(self.target.status(USER,PROJECT)['latestReadyRelease'],previous)
        self.assertEqual(len(self.target.status(USER,PROJECT)['releases']),len(before['releases'])+1)

    def test_foreign_owner_wrong_release_or_missing_file_rejected(self):
        folder,manifest = self.stage()
        for field,value in [('owner','f'*64),('release','e'*64),('project','other')]:
            bad = copy.deepcopy(manifest); bad[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.b.import_bundle(USER,PROJECT,self.release,folder,bad)
        (folder/'release/code/train.py').unlink()
        with self.assertRaisesRegex(ValueError,'missing'): self.b.import_bundle(USER,PROJECT,self.release,folder,manifest)

    def test_extra_paths_links_and_corruption_rejected(self):
        for kind in ('extra','link','hardlink','corrupt'):
            folder,manifest = self.stage(); file=folder/'release/code/train.py'
            if kind=='extra': (folder/'secret').write_text('x')
            elif kind=='link': file.unlink(); file.symlink_to('/etc/passwd')
            elif kind=='hardlink':
                file.unlink(); outside=self.path/(str(uuid.uuid4())+'.txt'); outside.write_text('x'); os.link(outside,file)
            else: file.write_bytes(b'x'*file.stat().st_size)
            with self.subTest(kind=kind), self.assertRaises((ValueError,OSError)): self.b.import_bundle(USER,PROJECT,self.release,folder,manifest)

    def test_manifest_paths_and_exact_numeric_bounds_stay_strict_without_size_quota(self):
        folder,manifest = self.stage()
        cases=[]
        for path in ('../outside','/etc/passwd','release/env/evil','release/code/../evil','release/code/missing/file'):
            bad=copy.deepcopy(manifest); bad['files'][0]['path']=path; cases.append(bad)
        bad=copy.deepcopy(manifest); bad['files'].append(bad['files'][0]); cases.append(bad)
        large=copy.deepcopy(manifest); large['files'][0]['size']=200*1024**3
        self.assertEqual(self.b.validate_manifest(large,USER,PROJECT,self.release),sum(f['size'] for f in large['files']))
        self.assertFalse(self.target.size_warnings(sum(f['size'] for f in large['files']))[0]['blocking'])
        for size in (True,-1,2**53,1.5):
            bad=copy.deepcopy(manifest); bad['files'][0]['size']=size; cases.append(bad)
        total_overflow=copy.deepcopy(manifest)
        total_overflow['files'][0]['size']=2**53-1
        cases.append(total_overflow)
        for bad in cases:
            with self.assertRaises(ValueError): self.b.validate_manifest(bad,USER,PROJECT,self.release)

    def test_source_cache_idempotence_and_manifest_index_reuse(self):
        first=self.a.export(USER,PROJECT,self.release)
        self.assertEqual(self.a.export(USER,PROJECT,self.release),first)
        with patch.object(self.a.s,'read_json',side_effect=AssertionError('must reuse fixed manifest index')):
            one=self.a.read(USER,PROJECT,self.release,'get',path='release/code/train.py')
            two=self.a.read(USER,PROJECT,self.release,'manifest')
        self.assertIn(b'fixture',base64.b64decode(one['data']))
        self.assertEqual(two['size'],first['manifestBytes'])

    def test_target_environment_mode_conflict_leaves_work_untouched(self):
        self.target.create(USER,PROJECT,environment_mode='isolated')
        before=self.target.status(USER,PROJECT)
        folder,manifest=self.stage()
        with self.assertRaisesRegex(ValueError,'mode cannot be changed'):
            self.b.import_bundle(USER,PROJECT,self.release,folder,manifest)
        self.assertEqual(self.target.status(USER,PROJECT),before)


if __name__=='__main__': unittest.main()
