"""Real private layer trees, fake immutable Podman reads; no containers."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]/'deploy'
spec = importlib.util.spec_from_file_location('inode_oci', HERE/'personal-oci.py')
o = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o)
USER, PROJECT, IMAGE = 'demo-user-3', 'vision', 'sha256:'+'a'*64


class ImageInodes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/private/tmp')
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.manager = o.PersonalOCI.__new__(o.PersonalOCI)
        self.manager.root = self.root
        self.manager.owner = hashlib.sha256(USER.encode()).hexdigest()
        self.manager.folder = self.root/'oci'/self.manager.owner
        self.manager.s = o.module('project-store')
        self.graph = self.manager.folder/'graph'
        self.graph.mkdir(mode=0o700, parents=True)
        self.a, self.b = (self.graph/'overlay'/key/'diff' for key in ('b'*64, 'c'*64))
        for layer in (self.a, self.b):
            layer.mkdir(parents=True)
        (self.a/'empty').write_bytes(b'')
        (self.a/'dir').mkdir()
        (self.a/'dir'/'file').write_bytes(b'not read')
        (self.a/'external-link').symlink_to('/unreadable/host/tree')
        (self.b/'empty').write_bytes(b'')
        (self.b/'hard-alias').hardlink_to(self.b/'empty')
        self.link = self.graph/'overlay/l'/'SHORTALIAS'
        self.link.parent.mkdir()
        self.link.symlink_to('../'+'c'*64+'/diff')
        self.body = {'Id': IMAGE, 'RootFS': {'Layers': ['sha256:'+'b'*64, 'sha256:'+'c'*64]},
                     'GraphDriver': {'Name': 'overlay', 'Data': {'UpperDir': str(self.a), 'LowerDir': str(self.link)}}}
        self.receipt = {'schema': 1, 'owner': self.manager.owner, 'project': PROJECT, 'image': IMAGE}
        self.calls = []
        self.manager.verify_host = lambda: None  # only pinned host dependency discovery is simulated
        self.manager.run = self.podman_read

    def podman_read(self, *args, **options):
        self.calls.append((args, options))
        if args == ('image', 'inspect', '--format={{.Id}}', IMAGE):
            return IMAGE
        if args == ('image', 'inspect', IMAGE):
            return json.dumps([self.body])
        raise AssertionError('No image mount, export, delete, pull or other write command is allowed')

    def count(self, **options):
        return self.manager.portable_image_entries(PROJECT, self.receipt, **options)

    def test_real_layers_count_symlinks_and_hardlinks_but_never_read_or_follow_content(self):
        before = (self.a/'dir'/'file').read_bytes()
        original = o.os.open
        def opened(path, flags, *args, **kwargs):
            self.assertTrue(flags & os.O_DIRECTORY, 'only no-follow directories may be opened')
            self.assertTrue(flags & os.O_NOFOLLOW)
            return original(path, flags, *args, **kwargs)
        with patch.object(o.os, 'open', side_effect=opened), patch.object(o.os, 'read', side_effect=AssertionError('no payload reads')):
            # Two root directories, four upper and two lower entries.
            self.assertEqual(self.count(), 8+2*16+1024)
        self.assertEqual((self.a/'dir'/'file').read_bytes(), before)
        self.assertTrue(all(call[0][0:2] == ('image', 'inspect') for call in self.calls))

    def test_layer_overlap_is_not_optimistically_deduplicated(self):
        self.body['GraphDriver']['Data']['LowerDir'] = str(self.a)
        self.assertEqual(self.count(), 10+2*16+1024)

    def test_foreign_graph_alias_escape_symlink_directory_and_unrecognized_driver_reject(self):
        for mutate in ('foreign','alias','symlink','driver','missing-layer'):
            body = copy.deepcopy(self.body)
            if mutate == 'foreign': self.body['GraphDriver']['Data']['UpperDir'] = str(self.root/'another-owner')
            if mutate == 'alias':
                self.link.unlink();self.link.symlink_to('../../../../outside')
            if mutate == 'symlink':
                self.body['GraphDriver']['Data']['UpperDir'] = str(self.a/'external-link')
            if mutate == 'driver': self.body['GraphDriver']['Name'] = 'unrecognized'
            if mutate == 'missing-layer': self.body['GraphDriver']['Data']['LowerDir'] = ''
            with self.subTest(mutate=mutate), self.assertRaises((ValueError,OSError)):
                self.count()
            self.body = body
            if mutate == 'alias':
                self.link.unlink();self.link.symlink_to('../'+'c'*64+'/diff')

    def test_file_count_deadline_and_deep_layers_are_unknown_not_partial_success(self):
        with self.assertRaisesRegex(ValueError,'bound'): self.count(max_entries=1)
        with patch.object(o.time,'monotonic',side_effect=range(100000)),self.assertRaisesRegex(ValueError,'bound'):
            self.count(timeout=0.1)
        for options in ({'max_entries':0},{'max_entries':True},{'timeout':False},{'timeout':3}):
            with self.subTest(options=options),self.assertRaises(ValueError):self.count(**options)
        deep = self.a
        for unused in range(130):
            deep = deep/'d';deep.mkdir()
        with self.assertRaisesRegex(ValueError,'depth bound'): self.count()

    def test_sampling_bound_stops_during_iteration_without_consuming_rest_of_tree(self):
        original = o.os.scandir
        yielded = []
        class Scan:
            def __init__(self, fd): self.scan = original(fd)
            def __enter__(self): return self
            def __exit__(self, *unused): self.scan.close()
            def __iter__(self):
                for child in self.scan:
                    yielded.append(child.name)
                    if len(yielded) > 3: raise AssertionError('sampler continued after its entry bound')
                    yield child
        with patch.object(o.os,'scandir',side_effect=Scan), self.assertRaisesRegex(ValueError,'bound'):
            self.count(max_entries=2)
        self.assertLessEqual(len(yielded),2)

    def test_layer_tree_change_early_in_walk_is_detected_after_all_layers(self):
        original=o.os.scandir
        mutated=False
        def scan(fd):
            nonlocal mutated
            # Mutate the already visited upper layer when lower walk begins.
            if os.fstat(fd).st_ino == self.b.stat().st_ino and not mutated:
                mutated=True;(self.a/'new-entry').write_bytes(b'')
            return original(fd)
        with patch.object(o.os,'scandir',side_effect=scan),self.assertRaisesRegex(ValueError,'changed'):
            self.count()

    def test_fixed_image_or_layer_graph_changes_are_not_accepted(self):
        original=self.podman_read
        inspections=0
        def run(*args,**kwargs):
            nonlocal inspections
            if args == ('image','inspect',IMAGE):
                inspections += 1
                if inspections == 2:
                    changed=copy.deepcopy(self.body);changed['RootFS']['Layers'][0]='sha256:'+'f'*64
                    return json.dumps([changed])
            return original(*args,**kwargs)
        self.manager.run=run
        with self.assertRaisesRegex(ValueError,'changed'):self.count()
        self.receipt['owner']='f'*64
        with self.assertRaisesRegex(ValueError,'ownership'):self.count()


if __name__ == '__main__':
    unittest.main()
