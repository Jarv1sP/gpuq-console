"""Actual node route plus bridge/runtime boundaries; no SSH or device writes."""
import ast
import hashlib
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socketserver
import stat
import re
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('storage_node_route_fixture', Path(__file__).with_name('node-datasets.test.py'))
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)


class StorageManagementRoute(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        F.NodeDatasets.setUp(self)
        for name in ('dataset-tier.py', 'storage-node.py', 'storage-authority.py', 'transfer-jobs.py'):
            shutil.copy2(ROOT / 'deploy' / name, self.base / name)
        self.ready()

    tearDown = F.NodeDatasets.tearDown
    ready = F.NodeDatasets.ready

    def call(self, action='status', **fields):
        return self.node.process('datasets.storage.' + action,
                                 dict(userId='builtin-admin', hostAdmin=True, **fields))

    def ref(self, **fields):
        return dict(dataset='example', version=self.version, **fields)

    def test_real_route_defaults_disabled_and_status_plan_never_delete_or_schedule(self):
        before = (self.cache.root / 'ready' / 'example' / self.version / 'data' / 'train.txt').read_bytes()
        with patch.object(self.module.DatasetCache, 'evict', side_effect=AssertionError('no eviction')), \
                patch.object(self.module.DatasetCache, 'unregister', side_effect=AssertionError('no unregister')), \
                patch.object(self.module.DatasetCache, '_quarantine_locked', side_effect=AssertionError('no GC')), \
                patch.object(self.node, 'gpu', side_effect=AssertionError('no scheduler')), \
                patch.object(self.node, 'run', side_effect=AssertionError('no remote process')):
            status = self.call()
            self.assertIs(status['enabled'], False)
            self.assertFalse(status['automaticCollectionExposed'])
            self.assertEqual(self.call(**self.ref())['version']['role'], 'protected')
            plan = self.call('plan', neededBytes=123)
            self.assertTrue(plan['dryRun'])
            self.assertEqual(plan['reservedBytes'], 123)
        self.assertEqual(before, (self.cache.root / 'ready' / 'example' / self.version / 'data' / 'train.txt').read_bytes())
        self.assertNotIn(str(self.base), json.dumps(status))

    def test_enrollment_metadata_probe_is_only_an_internal_archive_route(self):
        args = dict(userId='demo-user-1', dataset='example', version=self.version)
        archive = SimpleNamespace(enrollment_check=Mock(return_value={'state':'READY'}))
        with patch.object(self.node, 'storage_archive', return_value=archive), \
                patch.object(self.node, 'gpu', side_effect=AssertionError('no scheduler')):
            self.assertEqual(self.node.process('storage.archive.enrollment-check', args), {'state':'READY'})
            archive.enrollment_check.assert_called_once_with(args)
            with self.assertRaises(ValueError): self.node.process('datasets.archive.enrollment-check', args)

    def test_retirement_is_only_an_internal_archive_route(self):
        args = dict(userId='demo-user-1', dataset='example', version=self.version)
        archive = SimpleNamespace(retire=Mock(return_value={'state':'RETIRED'}))
        with patch.object(self.node, 'storage_archive', return_value=archive):
            self.assertEqual(self.node.process('storage.archive.retire', args), {'state':'RETIRED'})
            archive.retire.assert_called_once_with(args)
            with self.assertRaises(ValueError): self.node.process('datasets.archive.retire', args)

    def test_authenticated_control_flag_is_exact_boolean_and_identity_is_validated(self):
        for admin in (False, None, 0, 1, 'true'):
            with self.subTest(admin=admin), self.assertRaises(ValueError):
                self.node.process('datasets.storage.status', dict(userId='demo-user-1', hostAdmin=admin))
        for identity in ('../admin', '', '/root', 'admin', None, {}, True):
            with self.subTest(identity=identity), self.assertRaises((ValueError, KeyError)):
                self.node.process('datasets.storage.status', dict(userId=identity, hostAdmin=True))

    def test_strict_route_refuses_role_actor_paths_proof_and_operation_override(self):
        for key, value in dict(role='admin', actor={'is_admin': True}, path='/data1', root='/data1',
                               proof={'verified': True}, authorityId='hdd', sourceId='source',
                               op='collect', force=True, enabled=True, dryRun=False).items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.call(**{key: value})
        for action in ('collect', 'recover', 'enable', 'verify', 'constructor', '__proto__'):
            with self.subTest(action=action), self.assertRaises(ValueError):
                self.call(action)

    def test_manual_pin_and_unpin_preserve_existing_training_lease(self):
        lease = self.cache.acquire_lease(self.user, 'example', self.version, 'running-job')
        self.assertTrue(self.call('pin', **self.ref(pinId='manual-job'))['pinned'])
        state = self.call(**self.ref())['version']
        self.assertEqual((state['pinCount'], state['leaseCount']), (1, 1))
        self.assertTrue(self.call('unpin', **self.ref(pinId='manual-job'))['unpinned'])
        self.assertEqual(self.cache.acquire_lease(self.user, 'example', self.version, 'running-job')['leaseId'], lease['leaseId'])
        self.assertFalse(self.call('unpin', **self.ref(pinId='manual-job'))['unpinned'])

    def test_authority_pins_paths_and_unknown_refs_cannot_use_manual_route(self):
        for action in ('pin', 'unpin'):
            for label in ('authority-retained', '../bad', '/data1', 'a:b', 'x' * 65):
                with self.subTest(action=action, label=label), self.assertRaises(ValueError):
                    self.call(action, **self.ref(pinId=label))
        for fields in ({'dataset': 'example'}, {'version': self.version},
                       {'dataset': '../example', 'version': self.version},
                       {'dataset': 'example', 'version': 'latest'}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.call(**fields)

    def test_cached_route_still_checks_current_mount_and_never_enables_gc_from_request(self):
        self.call()
        with patch.object(self.node, 'dataset_mount_check', side_effect=ValueError('mount identity changed')):
            with self.assertRaisesRegex(ValueError, 'mount identity'):
                self.call()
        with self.assertRaises(ValueError):
            self.call('plan', enabled=True)
        self.assertFalse(self.call()['enabled'])

    def test_local_collector_requires_explicit_policy_and_has_no_public_route(self):
        storage = self.node.storage_node()
        with patch.object(storage.tier, 'collect', side_effect=AssertionError('disabled policy must not collect')):
            self.assertEqual(self.node.storage_collect(), {'enabled':False,'state':'DISABLED','evicted':[]})
        storage.tier.enabled = True
        with patch.object(storage.tier, 'collect', return_value={'evicted':[]}) as collect:
            self.assertEqual(self.node.storage_collect(), {'evicted':[]})
            actor = collect.call_args.args[0]
            self.assertTrue(actor.is_admin)
            self.assertEqual(collect.call_args.kwargs, {'dry_run':False,'max_versions':16})
        with self.assertRaises(ValueError):
            self.call('collect')

    def test_gc_timer_is_opt_in_pressure_check_not_age_deletion(self):
        unit = (ROOT / 'deploy/gpuq-storage-gc.service').read_text()
        timer = (ROOT / 'deploy/gpuq-storage-gc.timer').read_text()
        self.assertIn('--storage-collect', unit)
        self.assertIn('MemoryMax=2G', unit)
        self.assertIn('OnUnitInactiveSec=1h', timer)
        self.assertNotIn('Persistent=true', timer)

    def test_local_gc_defers_lock_contention_once_without_claiming_no_evictions(self):
        storage = self.node.storage_node()
        storage.tier.enabled = True
        with patch.object(storage.tier, 'collect', side_effect=self.module.CacheBusy('busy')) as collect:
            result = self.node.storage_collect()
        self.assertEqual(result, {'enabled':True,'state':'DEFERRED','reason':'CACHE_BUSY',
                                  'recheck':'NEXT_SCHEDULED_RUN','evictionOutcome':'CHECK_STATUS'})
        self.assertEqual(collect.call_count, 1)
        self.assertNotIn('evicted', result)

    def test_local_gc_does_not_hide_storage_or_authority_errors(self):
        storage = self.node.storage_node()
        storage.tier.enabled = True
        for error in (self.module.CacheError('mount changed'), OSError('disk failure'), ValueError('bad policy')):
            with self.subTest(error=type(error).__name__), \
                    patch.object(storage.tier, 'collect', side_effect=error), \
                    self.assertRaises(type(error)):
                self.node.storage_collect()

    def configure_local_recovery(self):
        spec = importlib.util.spec_from_file_location('storage_recovery_fixture_tier', self.base / 'dataset-tier.py')
        tier_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tier_module)
        cold = self.module.DatasetCache(self.base / 'authority', sources={'approved': self.source},
                                       mount_point=self.base, reserve_bytes=0)
        cold.register_source(self.admin, 'example', 'approved', ['demo-user-1'])
        cold.materialize(self.user, 'example', self.version)
        adapter = tier_module.LocalAuthority(cold)
        tier = tier_module.DatasetTier(self.cache, authorities={'fixed-hdd': adapter})
        tier.verify_authority(self.admin, 'example', self.version, 'fixed-hdd')
        self.node.STORAGE_NODE = SimpleNamespace(tier=tier)
        self.cache.evict(self.admin, 'example', self.version)
        return cold, adapter, tier

    def queue_recovery(self):
        with patch.object(self.node, 'dataset_background_active', return_value=False), \
                patch.object(self.node, 'run', return_value=''):
            return self.node.dataset_op('datasets.prepare', dict(userId='demo-user-1', hostAdmin=False, **self.ref()))

    def test_recovery_metadata_hint_does_not_probe_remote_and_survives_historical_worker(self):
        cold, adapter, tier = self.configure_local_recovery()
        with patch.object(adapter, 'guard', side_effect=AssertionError('hint must be metadata-only')):
            result = self.node.dataset_op('datasets.status', dict(userId='demo-user-1', **self.ref()))
            self.assertTrue(result['recoveryConfigured'])
        operation = self.queue_recovery()['operationId']
        self.assertEqual(self.node.dataset_worker(operation), 0)
        self.cache.evict(self.admin, 'example', self.version)
        with patch.object(self.node, 'dataset_background_active', return_value=False):
            result = self.node.dataset_op('datasets.status', dict(userId='demo-user-1', **self.ref()))
            self.assertNotEqual(result['state'], 'READY')
            self.assertTrue(result.get('recoveryConfigured'), result)
            by_operation = self.node.dataset_op('datasets.status', dict(userId='demo-user-1', operationId=operation))
            self.assertTrue(by_operation.get('recoveryConfigured'), by_operation)

    def test_member_prepare_restores_only_receipt_even_when_old_source_changes(self):
        self.configure_local_recovery()
        operation = self.queue_recovery()['operationId']
        (self.source / 'train.txt').write_text('old mutable source must not be read')
        self.assertEqual(self.node.dataset_worker(operation), 0)
        self.assertTrue(self.cache.verify(self.user, 'example', self.version)['verified'])

    def test_original_owner_permission_is_rechecked_before_admin_recover(self):
        cold, adapter, tier = self.configure_local_recovery()
        operation = self.queue_recovery()['operationId']
        self.cache.set_owners(self.admin, 'example', ['demo-user-2'])
        with patch.object(tier, 'recover') as recover:
            self.assertEqual(self.node.dataset_worker(operation), 1)
            recover.assert_not_called()
        result = json.loads((self.node.ROOT / 'dataset-ops' / (operation + '.result.json')).read_text())
        self.assertEqual(result['state'], 'FAILED')

    def test_unknown_receipt_cannot_use_arbitrary_endpoint_or_old_approved_source(self):
        cold, adapter, tier = self.configure_local_recovery()
        with self.cache._locked():
            value = self.cache._tier('example', self.version)
            value['recovery'] = {'endpoint': 'https://untrusted.invalid/data', 'sourceId': 'approved'}
            self.cache._write_tier('example', self.version, value)
        self.assertFalse(self.node.dataset_recovery_configured(self.cache, self.user, 'example', self.version))
        operation = self.queue_recovery()['operationId']
        with patch.object(self.module.DatasetCache, 'materialize', side_effect=AssertionError('no sourceId fallback')) as materialize:
            self.assertEqual(self.node.dataset_worker(operation), 1)
            materialize.assert_not_called()

    def test_source_identity_or_source_acl_corruption_cannot_publish_recovery(self):
        cold, adapter, tier = self.configure_local_recovery()
        operation = self.queue_recovery()['operationId']
        marker = cold.root / 'ready' / 'example' / self.version / 'READY.json'
        os.utime(marker, ns=(marker.stat().st_atime_ns, marker.stat().st_mtime_ns + 1000000))
        with patch.object(self.module.DatasetCache, 'materialize', side_effect=AssertionError('no sourceId fallback')) as materialize:
            self.assertEqual(self.node.dataset_worker(operation), 1)
            materialize.assert_not_called()
        self.assertNotEqual(self.cache.status(self.user, 'example', self.version)['state'], 'READY')

    def test_fresh_remote_authority_config_only_uses_fixed_pinned_peer(self):
        self.node.CONFIG.update(machine='target-machine', storageAuthorities={'hdd': {'machine': 'source-machine'}},
                                transferPeers={'source-machine': {'address': '127.0.0.1', 'port': 9443,
                                                                  'certificateSha256': 'a' * 64}})
        node = self.node.storage_node()
        self.assertFalse(node.tier.enabled)
        self.assertEqual(node.tier.authorities['hdd'].machine, 'source-machine')
        root = self.node.ROOT / 'storage-grants'
        self.assertTrue(root.is_dir())
        self.assertEqual(root.stat().st_mode & 0o777, 0o700)

    def test_storage_authority_configuration_rejects_request_style_paths_endpoints_and_self(self):
        self.node.CONFIG.update(machine='target-machine', transferPeers={})
        for value in ({'hdd': {'machine': 'missing'}}, {'hdd': {'machine': 'target-machine'}},
                      {'hdd': {'machine': 'source', 'endpoint': 'https://untrusted.invalid'}},
                      {'../bad': {'machine': 'source'}}, {'hdd': {'root': '/data1'}}):
            self.node.STORAGE_NODE = None
            self.node.CONFIG['storageAuthorities'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.node.storage_node()


class StorageBridgeAndRuntime(unittest.TestCase):
    def handler(self, operation, machine='gpu-1'):
        # Compile only literal operation constants and Handler: never load private /opt inventory or
        # start a Unix service. All SSH process creation is a strict mock.
        tree = ast.parse((ROOT / 'deploy' / 'execution-worker.py').read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Handler')
        connections = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'SSHConnections')
        constants = [n for n in tree.body if isinstance(n, ast.Assign)
                     and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
                     and n.targets[0].id == 'INTERNAL_STORAGE']
        self.assertEqual(len(constants), 1)
        internal = ast.literal_eval(constants[0].value)
        self.assertEqual(set(internal), {
            'storage.archive.events', 'storage.archive.ack', 'storage.archive.original',
            'storage.archive.enrollment-check', 'storage.archive.retire',
            'storage.archive.provision', 'storage.archive.certify', 'storage.lease.prepare',
            'storage.lease.cancel', 'storage.download.open', 'storage.download.info',
            'storage.download.manifest', 'storage.download.get', 'storage.download.finish'})
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout='{"ok":true,"result":{"enabled":false}}'))
        namespace = dict(socketserver=socketserver, json=json, subprocess=SimpleNamespace(run=run),
                         hashlib=hashlib, ipaddress=ipaddress, os=os, re=re, stat=stat, threading=threading, time=time,
                         RUNTIME=Path('/fixture-only'),
                         BASE=Path('/fixture-only'), HOSTS={'gpu-1': {'user': 'fixture', 'address': '127.0.0.1'}})
        exec(compile(ast.Module(body=constants + [connections, cls], type_ignores=[]), '<worker boundary>', 'exec'), namespace)
        namespace['SSH_CONNECTIONS'] = namespace['SSHConnections']()
        handler = object.__new__(namespace['Handler'])
        handler.request = Mock()
        handler.rfile = io.BytesIO((json.dumps(dict(machine=machine, operation=operation,
                                                    args=dict(userId='builtin-admin', hostAdmin=True))) + '\n').encode())
        handler.wfile = io.BytesIO()
        with patch.object(namespace['SSH_CONNECTIONS'], 'control_path', return_value=Path('/fixture-private/control')), \
                patch.object(namespace['SSH_CONNECTIONS'], 'ensure_master'):
            handler.handle()
        return json.loads(handler.wfile.getvalue()), run

    def test_execution_worker_allows_only_four_storage_management_operations(self):
        for action in ('status', 'plan', 'pin', 'unpin'):
            with self.subTest(action=action):
                result, run = self.handler('datasets.storage.' + action)
                self.assertTrue(result['ok'])
                run.assert_called_once()
                forwarded = json.loads(run.call_args.kwargs['input'])
                self.assertEqual(forwarded['operation'], 'datasets.storage.' + action)
        for action in ('collect', 'recover', 'enable', 'constructor', '__proto__'):
            with self.subTest(action=action):
                result, run = self.handler('datasets.storage.' + action)
                self.assertFalse(result['ok'])
                run.assert_not_called()
        result, run = self.handler('datasets.storage.status', machine='unknown')
        self.assertFalse(result['ok'])
        run.assert_not_called()

    def test_execution_worker_allows_exact_internal_lifecycle_operations(self):
        for operation in ('storage.archive.events', 'storage.archive.ack', 'storage.archive.original',
                          'storage.archive.enrollment-check',
                          'storage.archive.provision', 'storage.archive.certify', 'storage.lease.prepare',
                          'storage.lease.cancel', 'storage.download.open', 'storage.download.info',
                          'storage.download.manifest', 'storage.download.get', 'storage.download.finish'):
            with self.subTest(operation=operation):
                result, run = self.handler(operation)
                self.assertTrue(result['ok'])
                run.assert_called_once()
        for operation in ('storage.archive.enable', 'storage.download.delete', 'storage.lease.release'):
            with self.subTest(operation=operation):
                result, run = self.handler(operation)
                self.assertFalse(result['ok'])
                run.assert_not_called()

    def test_runtime_ships_tier_dependencies_and_gc_unit_is_not_enabled_by_install(self):
        spec = importlib.util.spec_from_file_location('storage_runtime_test', ROOT / 'deploy' / 'node_runtime.py')
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        for profile in ('common-p0', 'ray-p0'):
            plan, payloads = runtime.preflight(ROOT / 'deploy', profile)
            names = [name for name, original in plan]
            for dependency in ('dataset-cache.py', 'dataset-tier.py', 'storage-node.py', 'storage-retirement.py'):
                self.assertIn(dependency, payloads)
                self.assertLess(names.index(dependency), names.index('node-executor.py'))
        units = runtime.manifest()['units']
        self.assertIn('gpuq-storage-gc.timer', units)
        for name in ('install-node.py', 'install-runtime-p0.py', 'upgrade-datasets.py', 'upgrade-projects.py'):
            source = ROOT / 'deploy' / name
            if source.exists():
                self.assertNotIn("'enable','--now','gpuq-storage-gc.timer'", source.read_text())


if __name__ == '__main__':
    unittest.main()
