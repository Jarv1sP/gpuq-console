"""Detached administrator unregister integration; no real systemd, SSH or GPUs."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
import uuid
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('node_unregister_fixture', Path(__file__).with_name('node-datasets.test.py'))
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class NodeDatasetUnregister(unittest.TestCase):
    setUp = fixture.NodeDatasets.setUp
    tearDown = fixture.NodeDatasets.tearDown
    ready = fixture.NodeDatasets.ready

    def call(self, operation='unregister', **args):
        return self.node.dataset_op('datasets.' + operation, {'userId': 'builtin-admin', 'hostAdmin': True, **args})

    def submit(self, **args):
        with patch.object(self.node, 'dataset_background_active', return_value=False), \
                patch.object(self.node, 'run', return_value='') as run:
            result = self.call(dataset='example', **args)
        return result, run.call_args

    def test_submission_is_detached_and_does_not_run_cleanup_in_request(self):
        self.ready()
        with patch.object(self.module.DatasetCache, 'unregister', side_effect=AssertionError('must only run in worker')):
            result, invoked = self.submit()
        self.assertEqual(result['state'], 'UNREGISTERING')
        self.assertNotIn('unregistered', result)
        self.assertIsNone(result['version'])
        self.assertRegex(result['operationId'], '^[a-f0-9]{64}$')
        argv = invoked.args[0]
        self.assertIn('systemd-run', argv[0])
        self.assertIn('--property=KillMode=control-group', argv)
        self.assertIn('--property=MemoryMax=2G', argv)
        self.assertIn('--property=CPUQuota=100%', argv)
        self.assertEqual(argv[-2:], ['--dataset-worker', result['operationId']])
        self.assertEqual(invoked.kwargs['timeout'], 8)
        self.assertEqual(self.cache.status(self.user, 'example', self.version)['state'], 'READY')

    def test_worker_receipt_confirms_unregistration_and_is_queryable_after_registry_gone(self):
        self.ready()
        source_before = (self.source / 'train.txt').read_bytes()
        result, _ = self.submit(version=self.version)
        key = result['operationId']
        self.assertEqual(self.node.dataset_worker(key), 0)
        status = self.call('status', operationId=key)
        self.assertEqual(status['state'], 'UNREGISTERED')
        self.assertIs(status['unregistered'], True)
        self.assertIs(status['registrationRetained'], False)
        self.assertEqual(status['versions'], [self.version])
        self.assertRegex(status['recoveryId'], '^unregister-[a-f0-9]{32}$')
        self.assertNotIn(str(self.source), json.dumps(status))
        self.assertNotIn('userId', status)
        self.assertEqual((self.source / 'train.txt').read_bytes(), source_before)

    def test_whole_dataset_and_null_version_are_supported(self):
        for args in ({}, {'version': None}):
            self.cache.register_source(self.admin, 'example', 'approved', ['demo-user-1'])
            result, _ = self.submit(**args)
            self.assertEqual(self.node.dataset_worker(result['operationId']), 0)
            self.assertIs(self.call('status', operationId=result['operationId'])['unregistered'], True)

    def test_missing_target_receipt_is_explicit_idempotent_not_false_new_removal(self):
        first, _ = self.submit()
        self.node.dataset_worker(first['operationId'])
        second, _ = self.submit()
        self.assertNotEqual(first['operationId'], second['operationId'])
        self.node.dataset_worker(second['operationId'])
        status = self.call('status', operationId=second['operationId'])
        self.assertEqual(status['state'], 'UNREGISTERED')
        self.assertIs(status['unregistered'], False)
        self.assertIsNone(status['recoveryId'])

    def test_members_and_raw_identity_or_source_fields_cannot_submit(self):
        for args in ({'userId': 'demo-user-1', 'hostAdmin': False}, {'hostAdmin': 1},
                     {'sourcePath': str(self.source)}, {'sourceId': 'approved'},
                     {'actor': {'is_admin': True}}, {'role': 'admin'}, {'force': True},
                     {'version': '../bad'}, {'version': ''}, {'version': 2}):
            with self.subTest(args=args), patch.object(self.node, 'run') as run:
                with self.assertRaises(ValueError):
                    self.call(dataset='example', **args)
                run.assert_not_called()
        for dataset in ('../example', '/data2', '', None, ['example']):
            with self.subTest(dataset=dataset), self.assertRaises(ValueError):
                self.call(dataset=dataset)

    def test_current_admin_role_required_even_for_own_removal_receipt(self):
        result, _ = self.submit()
        for user in ('builtin-admin', 'demo-user-1'):
            with self.subTest(user=user), self.assertRaisesRegex(ValueError, 'Administrator'):
                self.call('status', operationId=result['operationId'], userId=user, hostAdmin=False)

    def test_active_worker_is_not_reported_as_completed_and_missing_receipt_is_unknown(self):
        result, _ = self.submit()
        with patch.object(self.node, 'dataset_background_active', return_value=True):
            self.assertEqual(self.call('status', operationId=result['operationId'])['state'], 'UNREGISTERING')
        with patch.object(self.node, 'dataset_background_active', return_value=False):
            status = self.call('status', operationId=result['operationId'])
        self.assertEqual(status['state'], 'UNKNOWN')
        self.assertNotIn('unregistered', status)

    def test_lease_failure_is_a_failed_receipt_and_never_stops_training(self):
        self.ready()
        lease = self.cache.acquire_lease(self.user, 'example', self.version, 'running-job')
        result, _ = self.submit()
        with patch.object(self.node, 'gpu', side_effect=AssertionError('must not touch scheduler')):
            self.assertEqual(self.node.dataset_worker(result['operationId']), 1)
        status = self.call('status', operationId=result['operationId'])
        self.assertEqual(status['state'], 'FAILED')
        self.assertIn('lease', status['error'])
        self.assertNotIn('unregistered', status)
        self.assertEqual(self.cache.acquire_lease(self.user, 'example', self.version, 'running-job'), lease)

    def test_launch_timeout_keeps_operation_record_and_never_claims_canceled(self):
        with patch.object(self.node, 'dataset_background_active', return_value=False), \
                patch.object(self.node, 'run', side_effect=subprocess.TimeoutExpired('systemd-run', 8)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.call(dataset='example')
        records = list((self.node.ROOT / 'dataset-ops').glob('*.json'))
        self.assertEqual(len(records), 1)
        key = records[0].stem
        with patch.object(self.node, 'dataset_background_active', return_value=False):
            self.assertEqual(self.call('status', operationId=key)['state'], 'UNKNOWN')
        self.assertEqual(self.node.dataset_worker(key), 0)
        self.assertEqual(self.call('status', operationId=key)['state'], 'UNREGISTERED')

    def test_status_rejects_mixed_fields_or_modified_worker_identity(self):
        result, _ = self.submit()
        with self.assertRaises(ValueError):
            self.call('status', operationId=result['operationId'], dataset='example')
        record = self.node.ROOT / 'dataset-ops' / (result['operationId'] + '.json')
        task = json.loads(record.read_text());task['dataset'] = 'different'
        record.write_text(json.dumps(task))
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.call('status', operationId=result['operationId'])
        with self.assertRaisesRegex(ValueError, 'modified'):
            self.node.dataset_worker(result['operationId'])

    def test_private_retirement_fixed_identity_and_registration_aba(self):
        self.ready();stamp=list(self.cache._record_identity('example',self.version));ident=str(uuid.uuid4())
        args={'userId':'demo-user-1','hostAdmin':True,'dataset':'example','version':self.version}
        def submit():
            return self.node._dataset_op('datasets.unregister',args,_request_id=ident,
                _expected_registration=stamp,_expected_owners=['demo-user-1'])
        with patch.object(self.node,'dataset_background_active',return_value=False), patch.object(self.node,'run') as run:
            first=submit();second=submit()
            self.assertEqual(first['operationId'],second['operationId']);self.assertEqual(run.call_count,1)
        manifest=self.cache._record(self.admin,'example',self.version)['manifest']
        self.cache.unregister(self.admin,'example',self.version)
        self.cache.register_manifest(self.admin,'example',manifest,['demo-user-1'])
        self.assertEqual(self.node.dataset_worker(first['operationId']),1)
        self.assertIn('retirement identity',self.call('status',operationId=first['operationId'])['error'])
        self.assertEqual(self.cache._record(self.admin,'example',self.version)['manifest'],manifest)
        with patch.object(self.node,'run') as run:
            self.assertEqual(submit()['state'],'FAILED');run.assert_not_called()

    def test_private_retirement_binding_cannot_be_supplied_publicly_or_change(self):
        self.ready();stamp=list(self.cache._record_identity('example',self.version));ident=str(uuid.uuid4())
        args={'userId':'demo-user-1','hostAdmin':True,'dataset':'example','version':self.version}
        for field,value in [('requestId',ident),('expectedRegistration',stamp),('expectedOwners',['demo-user-1'])]:
            with self.assertRaises(ValueError):self.node.dataset_op('datasets.unregister',{**args,field:value})
        with patch.object(self.node,'dataset_background_active',return_value=False),patch.object(self.node,'run'):
            self.node._dataset_op('datasets.unregister',args,_request_id=ident,_expected_registration=stamp,_expected_owners=['demo-user-1'])
            with self.assertRaisesRegex(ValueError,'ownership identity'):
                self.node._dataset_op('datasets.unregister',args,_request_id=ident,_expected_registration=stamp,_expected_owners=['demo-user-2'])


if __name__ == '__main__':
    unittest.main()
