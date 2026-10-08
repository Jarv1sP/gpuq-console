"""Read-only capacity role projection: no GPU, remote bridge or node writes."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('capacity_node_fixture', Path(__file__).with_name('node-datasets.test.py'))
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)


class StorageCapacityOverview(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.NodeDatasets('test_all_legacy_dataset_owners_keep_existing_cohort_behavior')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.node = self.fixture.node
        self.cache = self.fixture.cache
        self.admin = self.fixture.admin

    def test_filesystem_snapshot_is_constant_time_and_has_opaque_device_identity(self):
        with patch.object(self.cache, '_record', side_effect=AssertionError('manifest scan forbidden')):
            value = self.cache.capacity(self.admin)
        self.assertRegex(value['volumeDeviceId'], r'^[a-f0-9]{64}$')
        self.assertRegex(value['checkedAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertIs(type(value['readOnly']), bool)
        self.assertLessEqual(value['usedBytes'] + value['availableBytes'], value['filesystemBytes'])
        self.assertEqual(value['scope'], 'filesystem')
        self.assertEqual(value['usableBytes'], max(0, value['availableBytes'] - value['reserveBytes']))
        self.assertNotIn('root', value)
        # Same-device bind/directory aliases share the same opaque identity.
        sibling = self.fixture.base / 'sibling-cache'
        alias = self.fixture.module.DatasetCache(sibling, reserve_bytes=0)
        self.assertEqual(alias.capacity(self.admin)['volumeDeviceId'], value['volumeDeviceId'])

    def test_existing_capacity_adds_separate_explicit_warehouse_volume_and_cache_budget(self):
        self.node.CONFIG['storageTier'] = {'enabled': True, 'budgetBytes': 400, 'highWater': 0.9, 'lowWater': 0.8}
        self.node.CONFIG['storageWarehouse'] = {'enabled': True}
        cold = SimpleNamespace(capacity=lambda actor: {'filesystemBytes': 2000, 'usedBytes': 500, 'availableBytes': 1500})
        with patch.object(self.node, 'storage_warehouse', return_value=SimpleNamespace(cold=cold)):
            value = self.node._dataset_op('datasets.capacity', {'userId': 'builtin-admin', 'hostAdmin': True})
        overview = value['storageOverview']
        self.assertEqual(overview['protocol'], 'dataset-storage-node-v1')
        self.assertEqual(overview['cache']['budgetBytes'], 400)
        self.assertEqual(overview['cache']['volume']['filesystemBytes'], value['filesystemBytes'])
        self.assertEqual(overview['warehouse']['volume']['filesystemBytes'], 2000)
        self.assertEqual(overview['warehouse']['state'], 'READY')
        self.assertNotIn('storageOverview', overview['cache']['volume'])

    def test_unconfigured_warehouse_is_not_inferred_from_cache_or_archive_config(self):
        self.node.CONFIG['storageArchive'] = {'machine': 'same-node'}
        with patch.object(self.node, 'storage_warehouse', side_effect=AssertionError('warehouse constructor must not run')):
            value = self.node._dataset_op('datasets.capacity', {'userId': 'builtin-admin', 'hostAdmin': True})
        self.assertIsNone(value['storageOverview']['warehouse'])

    def local_authority(self):
        self.node.CONFIG.update(machine='single-root-node',storageAuthority={'enabled':True},
            storageArchive={'enabled':True,'machine':'single-root-node','authority':'local-original'},
            storageTier={'enabled':False})

    def test_single_root_authority_reuses_one_guarded_snapshot_without_constructing_journals(self):
        self.local_authority()
        with patch.object(self.node, 'storage_authority', side_effect=AssertionError('authority journal write forbidden')), \
                patch.object(self.node, 'storage_warehouse', side_effect=AssertionError('dual-root constructor forbidden')):
            value=self.node._dataset_op('datasets.capacity',{'userId':'builtin-admin','hostAdmin':True})
        overview=value['storageOverview']
        self.assertEqual(overview['warehouse']['state'],'READY')
        self.assertEqual(overview['warehouse']['volume'],overview['cache']['volume'])
        self.assertIsNot(overview['warehouse']['volume'],overview['cache']['volume'])
        self.assertEqual(overview['warehouse']['volume']['volumeDeviceId'],value['volumeDeviceId'])
        self.assertIsNone(overview['cache']['budgetBytes'])
        self.assertNotIn('storageOverview',overview['warehouse']['volume'])

    def test_disabled_authority_does_not_infer_warehouse_from_valid_local_archive(self):
        self.local_authority()
        self.node.CONFIG['storageAuthority']={'enabled':False}
        value=self.node._dataset_op('datasets.capacity',{'userId':'builtin-admin','hostAdmin':True})
        self.assertIsNone(value['storageOverview']['warehouse'])

    def test_disabled_tier_keeps_its_configuration_without_exposing_a_cache_budget(self):
        self.local_authority()
        self.node.CONFIG['storageTier']={'enabled':False,'budgetBytes':400,'highWater':0.9,'lowWater':0.8}
        value=self.node._dataset_op('datasets.capacity',{'userId':'builtin-admin','hostAdmin':True})
        self.assertEqual(value['storageOverview']['warehouse']['state'],'READY')
        self.assertIsNone(value['storageOverview']['cache']['budgetBytes'])

    def test_inconsistent_single_root_authority_is_unavailable_not_a_guessed_warehouse(self):
        for field,value in [('storageArchive',{'enabled':True,'machine':'other-node','authority':'local-original'}),
                            ('storageArchive',{'enabled':False}),
                            ('storageArchive',{'enabled':True,'machine':'single-root-node','authority':'/private/secret'}),
                            ('storageTier',{'enabled':True,'budgetBytes':400}),
                            ('storageAuthority',{'enabled':True,'extra':True})]:
            with self.subTest(field=field,value=value):
                self.local_authority();self.node.CONFIG[field]=value
                result=self.node._dataset_op('datasets.capacity',{'userId':'builtin-admin','hostAdmin':True})
                self.assertEqual(result['storageOverview']['warehouse'],{'state':'UNAVAILABLE','volume':None})
                self.assertGreater(result['storageOverview']['cache']['volume']['filesystemBytes'],0)
                self.assertNotIn('/private/secret',str(result))

    def test_single_root_authority_unmounted_volume_does_not_fall_back_to_system_disk(self):
        self.local_authority()
        with patch.object(self.node,'dataset_mount_check',side_effect=ValueError('unmounted original')):
            with self.assertRaisesRegex(ValueError,'unmounted original'):
                self.node._dataset_op('datasets.capacity',{'userId':'builtin-admin','hostAdmin':True})

    def test_unavailable_warehouse_never_falls_back_to_cache_or_leaks_path(self):
        self.node.CONFIG['storageWarehouse'] = {'enabled': True}
        with patch.object(self.node, 'storage_warehouse', side_effect=ValueError('secret /dev/sda mount unavailable')):
            value = self.node._dataset_op('datasets.capacity', {'userId': 'builtin-admin', 'hostAdmin': True})
        self.assertEqual(value['storageOverview']['warehouse'], {'state': 'UNAVAILABLE', 'volume': None})
        self.assertGreater(value['storageOverview']['cache']['volume']['filesystemBytes'], 0)
        self.assertNotIn('secret', str(value))

    def test_capacity_still_refuses_unmounted_cache_and_unsafe_arguments(self):
        with patch.object(self.node, 'dataset_mount_check', side_effect=ValueError('no root disk fallback')):
            with self.assertRaisesRegex(ValueError, 'no root disk fallback'):
                self.node._dataset_op('datasets.capacity', {'userId': 'builtin-admin', 'hostAdmin': True})
        with self.assertRaisesRegex(ValueError, 'operation fields'):
            self.node._dataset_op('datasets.capacity', {'userId': 'builtin-admin', 'hostAdmin': True, 'path': '/'})


if __name__ == '__main__':
    unittest.main()
