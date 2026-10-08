"""Fixed temporary volumes and actual cache metadata; no GPU, broker or nodes."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from storage_test_helpers import local_data_mounts

HERE = Path(__file__).resolve().parents[1]/'deploy'


def module(name):
    spec = importlib.util.spec_from_file_location('training_fixture_'+name.replace('-', '_'), HERE/(name+'.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


t, d, s, q = (module(name) for name in ('training-storage', 'dataset-cache', 'project-store', 'storage-quota'))
OWNER = 'demo-user-1'


class TrainingStorage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/private/tmp')
        self.base = Path(self.temp.name)
        self.addCleanup(self.cleanup)
        self.root = self.base/'workspace'
        self.root.mkdir()
        self.mount = self.base/'data'
        self.mount.mkdir()
        self.source = self.base/'source'
        self.source.mkdir()
        (self.source/'sample.bin').write_bytes(b'cache-sample')
        mounts = local_data_mounts(self.mount)
        mounts.start()
        self.addCleanup(mounts.stop)
        self.cache = d.DatasetCache(self.mount/'cache', sources={'approved': self.source},
                                    reserve_bytes=4096, budget_bytes=1024**3, mount_point=self.mount)
        self.actor = d.Principal(OWNER, False)
        self.version = self.cache.register_source(d.Principal('builtin-admin', True), 'data', 'approved', [OWNER])['version']
        self.node = SimpleNamespace(ROOT=self.root, HERE=HERE,
                                    CONFIG={'machine': 'gpu-1', 'workspaceReserveBytes': 8192},
                                    dataset_cache=lambda: (d, self.cache),
                                    dataset_training_sources=lambda: SimpleNamespace(status=self.status))
        self.guard = patch.object(s, 'check_platform_root', return_value={'guarded': True})
        self.guard.start()
        self.addCleanup(self.guard.stop)
        original = t.load
        loader = patch.object(t, 'load', side_effect=lambda executor, name: s if name == 'project-store' else original(executor, name))
        loader.start()
        self.addCleanup(loader.stop)
        self.space = SimpleNamespace(f_files=1000000, f_favail=900000, f_flag=0,
                                     f_bavail=2**30, f_frsize=4096, f_bsize=4096)
        filesystem = patch.object(t.os, 'fstatvfs', return_value=self.space)
        filesystem.start()
        self.addCleanup(filesystem.stop)

    def cleanup(self):
        for root, dirs, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root)/name
                if not path.is_symlink():
                    path.chmod(0o600)
        self.temp.cleanup()

    def status(self, args):
        record, identity = self.cache._record_snapshot(self.actor, args['dataset'], args['version'])
        state = self.cache.status(self.actor, args['dataset'], args['version'])
        manifest = record['manifest']
        with self.cache._locked():
            self.cache._check_snapshot(self.actor, args['dataset'], args['version'], identity)
        return {'protocol': 'dataset-training-source-v1', 'machine': 'gpu-1',
                'dataset': args['dataset'], 'version': args['version'], 'datasetReadMode': args['datasetReadMode'],
                'reference': {'dataset': args['dataset'], 'version': args['version']},
                'state': state['state'], 'canPrepare': True, 'warehouseReady': False, 'authority': None,
                'bytes': sum(item['size'] for item in manifest['files']), 'files': len(manifest['files']),
                'directories': len(manifest['directories']), 'manifestBytes': len(d._json_bytes(manifest)),
                'footprintBytes': self.cache._footprint(manifest), 'remainingBytes': state['remainingBytes']}

    def args(self, datasets=True):
        refs = [{'dataset': 'data', 'version': self.version}] if datasets else []
        states = [self.status({'dataset': ref['dataset'], 'version': ref['version'], 'datasetReadMode': 'cache'}) for ref in refs]
        return {'userId': OWNER, 'hostAdmin': False, 'datasets': refs, 'datasetReadMode': 'cache',
                'projectFootprint': None,
                'datasetFootprints': [{**ref, **{key: state[key] for key in ('bytes', 'files', 'directories', 'manifestBytes')}}
                                     for ref, state in zip(refs, states)]}

    def test_same_device_is_one_volume_with_max_reserve_and_live_snapshot(self):
        args = self.args()
        with patch.object(self.cache, '_reserved', return_value=500), patch.object(self.cache, '_upload_reserved', return_value=(500, 7)):
            value = t.plan(self.node, args)
        self.assertTrue(value['fits'])
        self.assertEqual(value['requestSHA256'], t.digest(args))
        self.assertEqual(len(value['volumes']), 1)
        volume = value['volumes'][0]
        self.assertEqual(volume['roles'], ['project', 'cache'])
        self.assertEqual(volume['reserveBytes'], 8192)
        self.assertEqual(volume['activeReservedBytes'], 500)
        self.assertEqual(volume['activeReservedInodes'], 7)
        self.assertEqual(volume['requiredBytes'], 65536+self.status({**args['datasets'][0], 'datasetReadMode': 'cache'})['footprintBytes'])
        self.assertEqual(volume['usableBytes'], self.space.f_bavail*self.space.f_frsize-8192-500)

    def test_existing_ready_is_already_in_statvfs_and_not_added_as_new_bytes(self):
        self.cache.prepare(self.actor, 'data', self.version)
        args = self.args()
        value = t.plan(self.node, args)
        self.assertEqual(value['volumes'][0]['requiredBytes'], 65536)
        self.assertEqual(value['cacheBudget']['requiredBytes'], 0)
        self.assertGreater(value['cacheBudget']['usedOrReservedBytes'], 0)
        self.assertTrue(value['fits'])

    def test_staging_is_charged_once_by_existing_physical_and_logical_reservations(self):
        self.cache.prepare_transfer(d.Principal(OWNER, True), 'data', self.version)
        args = self.args()
        value = t.plan(self.node, args)
        self.assertEqual(value['volumes'][0]['requiredBytes'], 65536)
        self.assertEqual(value['volumes'][0]['activeReservedBytes'], len(b'cache-sample'))
        self.assertEqual(value['volumes'][0]['activeReservedInodes'], 17)
        self.assertEqual(value['cacheBudget']['requiredBytes'], 0)
        self.assertEqual(value['cacheBudget']['usedOrReservedBytes'], self.status({**args['datasets'][0], 'datasetReadMode': 'cache'})['footprintBytes'])

    def test_cache_budget_pressure_or_physical_pressure_reports_not_fit_without_gc(self):
        args = self.args()
        self.cache.budget_bytes = 1
        before = sorted(str(path.relative_to(self.base)) for path in self.base.rglob('*'))
        value = t.plan(self.node, args)
        self.assertFalse(value['fits'])
        self.assertEqual(sorted(str(path.relative_to(self.base)) for path in self.base.rglob('*')), before)
        self.cache.budget_bytes = 1024**3
        self.space.f_bavail = 0
        self.assertFalse(t.plan(self.node, args)['fits'])
        self.assertTrue((self.source/'sample.bin').exists())

    def test_unknown_inodes_read_only_unpinned_root_and_mount_drift_reject(self):
        args = self.args()
        self.space.f_files = 0
        with self.assertRaisesRegex(ValueError, 'inode'): t.plan(self.node, args)
        self.space.f_files = 1000000
        self.space.f_flag = getattr(os, 'ST_RDONLY', 1)
        with self.assertRaisesRegex(ValueError, 'read-only'): t.plan(self.node, args)
        self.space.f_flag = 0
        with patch.object(s, 'check_platform_root', return_value=None), self.assertRaisesRegex(ValueError, 'guarded'):
            t.plan(self.node, args)
        self.cache.mount = (99, 'changed', 99)
        with self.assertRaisesRegex(ValueError, 'mount identity changed'): t.plan(self.node, args)

    def test_owner_admin_path_unsafe_number_and_changed_local_footprint_reject(self):
        for mutate in (lambda a: a.update(hostAdmin=True), lambda a: a.update(path='/'),
                       lambda a: a.update(userId='other-user'),
                       lambda a: a['datasetFootprints'][0].update(bytes=True),
                       lambda a: a['datasetFootprints'][0].update(bytes=2**53)):
            args = self.args()
            mutate(args)
            with self.assertRaises(ValueError): t.plan(self.node, args)
        args = self.args()
        args['datasetFootprints'][0]['bytes'] += 1
        with self.assertRaisesRegex(ValueError, 'footprint changed'): t.plan(self.node, args)

    def test_future_cross_copy_reserves_upload_peak_not_just_final_cache_bytes(self):
        args = self.args()
        args['datasets'][0]['dataset'] = 'future'
        args['datasetFootprints'][0]['dataset'] = 'future'
        value = t.plan(self.node, args)
        f = args['datasetFootprints'][0]
        peak = f['bytes']+f['manifestBytes']*4+(f['files']+f['directories'])*8192+65536
        self.assertEqual(value['cacheBudget']['requiredBytes'], peak)
        self.assertEqual(value['volumes'][0]['requiredBytes'], 65536+peak)

    def test_project_source_export_and_image_import_peak_are_conservative_and_bound(self):
        args = self.args(False)
        args.update(project='vision', release='a'*64,
                    projectFootprint={'sourceMachine': 'gpu-2', 'image': 'sha256:'+'b'*64,
                                      'architecture': 'amd64', 'codeBytes': 100, 'codeEntries': 2,
                                      'imageUnpackedBytes': 1000, 'imageEntries': 50})
        absent = s.ProjectError('not_found', 'absent')
        self.node.projects = lambda: SimpleNamespace(store=SimpleNamespace(release=lambda *unused: (_ for _ in ()).throw(absent)))
        value = t.plan(self.node, args)
        self.assertEqual(value['volumes'][0]['requiredBytes'], 100+8192+2*(1100+16*1024**2)+65536)
        self.assertEqual(value['volumes'][0]['requiredInodes'], 84)
        args['projectFootprint']['imageUnpackedBytes'] = None
        with self.assertRaisesRegex(ValueError, 'footprint'): t.plan(self.node, args)

    def test_unknown_image_inodes_reject_new_copy_but_not_existing_fixed_ready_release(self):
        args = self.args(False)
        args.update(project='vision', release='a'*64,
                    projectFootprint={'sourceMachine': 'gpu-2', 'image': 'sha256:'+'b'*64,
                                      'architecture': 'amd64', 'codeBytes': 100, 'codeEntries': 2,
                                      'imageUnpackedBytes': 1000, 'imageEntries': None})
        absent = s.ProjectError('not_found', 'absent')
        self.node.projects = lambda: SimpleNamespace(store=SimpleNamespace(release=lambda *unused: (_ for _ in ()).throw(absent)))
        with self.assertRaisesRegex(ValueError, 'inode footprint'):
            t.plan(self.node, args)
        # Missing additive sampling capability is not retroactively required
        # to run the same exact release/image already present on this node.
        ready = {'meta': {'environmentMode': 'oci', 'bytes': 100, 'entries': 2, 'oci': {}}}
        engine = SimpleNamespace(portable_image=lambda *unused: {'image': 'sha256:'+'b'*64, 'architecture': 'amd64'})
        self.node.projects = lambda: SimpleNamespace(store=SimpleNamespace(release=lambda *unused: ready, _oci=lambda owner: engine))
        value = t.plan(self.node, args)
        self.assertTrue(value['fits'])
        self.assertEqual(value['volumes'][0]['requiredInodes'], 16)

    def test_personal_quota_is_opaque_device_bound_and_unknown_broker_never_falls_back(self):
        args = self.args(False)
        volume_id = hashlib.sha256(str(self.root.stat().st_dev).encode()).hexdigest()
        quota = {'enabled': True, 'enforcement': 'kernel-project-quota', 'owner': OWNER,
                 'volumes': [{'volumeDeviceId': volume_id, 'remainingBytes': 0, 'remainingInodes': 1000}]}
        with patch.object(q, 'training_status', return_value=quota), patch.object(t, 'load', side_effect=lambda executor, name: s if name == 'project-store' else q):
            self.assertFalse(t.plan(self.node, args)['fits'])
            quota['volumes'][0]['volumeDeviceId'] = 'f'*64
            with self.assertRaisesRegex(ValueError, 'volume identity'): t.plan(self.node, args)
        with patch.object(q, 'training_status', side_effect=ValueError('old broker')), patch.object(q, 'status', side_effect=AssertionError('no legacy fallback')), patch.object(t, 'load', side_effect=lambda executor, name: s if name == 'project-store' else q):
            with self.assertRaisesRegex(ValueError, 'old broker'): t.plan(self.node, args)

    def test_warehouse_reads_do_not_need_or_allocate_cache_capacity(self):
        args = self.args()
        args['datasetReadMode'] = 'warehouse'
        self.node.CONFIG['storageArchive'] = {'authority': 'local-cold-authority'}
        source = self.status({**args['datasets'][0], 'datasetReadMode': 'warehouse'})
        source.update(state='READY', warehouseReady=True, authority='local-cold-authority')
        self.node.dataset_training_sources = lambda: SimpleNamespace(status=lambda fields: source)
        self.node.dataset_cache = lambda: (_ for _ in ()).throw(AssertionError('no cache capacity fallback'))
        value = t.plan(self.node, args)
        self.assertEqual(value['volumes'][0]['roles'], ['project'])
        self.assertEqual(value['cacheBudget']['requiredBytes'], 0)
        source['authority'] = 'another-authority'
        with self.assertRaisesRegex(ValueError, 'not READY'): t.plan(self.node, args)

    def test_ascii_digest_matches_node_semantic_canonicalization(self):
        args = {'userId': OWNER, 'hostAdmin': False, 'datasets': [], 'datasetReadMode': 'cache',
                'projectFootprint': None, 'datasetFootprints': []}
        self.assertEqual(t.digest(args), '2cc5836e21ccf86bc3860dc79b9c1bc2d44f80a32763cff5aaf21eae78ec3709')


if __name__ == '__main__':
    unittest.main()
