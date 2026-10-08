"""Private preparation binding, durable launch and stop fences; no node/service IO."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


F = load(Path(__file__).with_name('node-datasets.test.py'), 'training_preparation_dataset_fixture')
storage = load(DEPLOY / 'training-storage.py', 'training_preparation_storage_schema')


class TrainingPreparationNode(unittest.TestCase):
    def setUp(self):
        F.NodeDatasets.setUp(self)
        for name in ('training-preparation.py', 'training-storage.py', 'transfer-jobs.py'):
            shutil.copy2(DEPLOY / name, self.base / name)
        self.node.CONFIG['machine'] = 'gpu-fixture'
        self.helper = load(self.base / 'training-preparation.py', 'training_preparation_isolated')
        self.transfers = self.node.transfers()
        self.transfers_patch = patch.object(self.node, 'transfers', return_value=self.transfers)
        self.transfers_patch.start()
        self.addCleanup(self.transfers_patch.stop)
        self.activity = False
        self.activity_patch = patch.object(self.transfers, 'activity', side_effect=lambda _unit: self.activity)
        self.activity_patch.start()
        self.addCleanup(self.activity_patch.stop)
        self.active_patch = patch.object(self.node, 'dataset_background_active', side_effect=lambda _key: self.activity is True)
        self.active_patch.start()
        self.addCleanup(self.active_patch.stop)
        self.warehouse_patch = patch.object(self.node, 'storage_warehouse', return_value=None)
        self.warehouse_patch.start()
        self.addCleanup(self.warehouse_patch.stop)
        self.run = Mock(return_value='')
        self.run_patch = patch.object(self.node, 'run', self.run)
        self.run_patch.start()
        self.addCleanup(self.run_patch.stop)
        self.plan_result = {'fits': True, 'noReclaim': True}
        self.plan_calls = []

        def plan(node, request):
            self.assertIs(node, self.node)
            self.plan_calls.append(copy.deepcopy(request))
            return copy.deepcopy(self.plan_result)

        self.storage = SimpleNamespace(validate=storage.validate, plan=plan)
        self.load_patch = patch.object(self.helper, 'load', side_effect=lambda _node, name: self.storage if name == 'training-storage' else self.fail(name))
        self.load_patch.start()
        self.addCleanup(self.load_patch.stop)
        record, _identity = self.cache._record_snapshot(self.user, 'example', self.version)
        manifest = record['manifest']
        ref = {'dataset': 'example', 'version': self.version}
        self.envelope = {
            'job': copy.deepcopy(self.job),
            'planRequest': {'userId': self.job['userId'], 'hostAdmin': False, 'datasetReadMode': 'cache',
                            'projectFootprint': None, 'datasets': [ref],
                            'datasetFootprints': [{**ref, 'bytes': sum(f['size'] for f in manifest['files']),
                                                   'files': len(manifest['files']), 'directories': len(manifest['directories']),
                                                   'manifestBytes': len(self.module._json_bytes(manifest))}]},
            'preparation': {'protocol': 1, 'id': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'kind': 'dataset',
                            'sourceMachine': 'gpu-fixture', 'targetMachine': 'gpu-fixture',
                            'logicalReference': ref, 'reference': ref},
            'operation': 'datasets.prepare',
            'args': {'userId': self.job['userId'], 'hostAdmin': False, **ref},
        }

    tearDown = F.NodeDatasets.tearDown

    def call(self, operation='datasets.prepare', envelope=None):
        value = copy.deepcopy(self.envelope if envelope is None else envelope)
        value['operation'] = operation
        return self.helper.dispatch(self.node, value)

    def identity(self):
        binding = self.helper.validate(self.node, self.envelope)
        return self.helper.local_task(self.node, binding)

    def launches(self):
        return [c for c in self.run.call_args_list if c.args[0][0] == '/usr/bin/systemd-run']

    def legacy_pointer(self, folder):
        task = {'op': 'prepare', 'dataset': 'example', 'version': self.version,
                'userId': self.job['userId'], 'hostAdmin': False}
        key = __import__('hashlib').sha256(json.dumps(task, sort_keys=True).encode()).hexdigest()
        self.node.atomic_json(folder / (key + '.json'), task)
        pointer = self.node.dataset_prepare_pointer(folder, 'example', self.version)
        self.node.atomic_json(pointer, {'operationId': key})
        return key, pointer

    def test_intent_precedes_exact_same_runtime_worker_launch(self):
        result = self.call()
        key, task = self.identity()
        self.assertEqual(result, {'operationId': key, 'dataset': 'example', 'version': self.version, 'state': 'PREPARING'})
        self.assertEqual(self.helper.read(self.node.ROOT / 'dataset-ops' / (key + '.json')), task)
        pointer = self.node.dataset_prepare_pointer(self.node.ROOT / 'dataset-ops', 'example', self.version)
        self.assertEqual(self.helper.read(pointer), {'operationId': key})
        self.assertEqual(self.launches()[0].args[0][-3:], [str(self.base / 'node-executor.py'), '--training-dataset-worker', key])
        self.assertEqual(task['trainingPreparation']['runtime'], str(self.base.resolve()))
        self.assertEqual(len(self.launches()), 1)

    def test_lost_launch_ack_keeps_original_intent_and_never_relaunches(self):
        self.run.side_effect = subprocess.TimeoutExpired('systemd-run', 8)
        first = self.call()
        path = self.node.ROOT / 'dataset-ops' / (first['operationId'] + '.json')
        before = path.read_bytes()
        self.run.side_effect = None
        second = self.call()
        self.assertEqual(first['state'], 'UNKNOWN')
        self.assertEqual(second['state'], 'UNKNOWN')
        self.assertEqual(second['operationId'], first['operationId'])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(len(self.launches()), 1)

    def test_lost_launch_with_confirmed_active_unit_observes_original_not_replay(self):
        self.run.side_effect = subprocess.TimeoutExpired('systemd-run', 8)
        first = self.call()
        self.run.side_effect = None
        self.activity = True
        second = self.call()
        self.assertEqual(second['operationId'], first['operationId'])
        self.assertEqual(second['state'], 'UNKNOWN')  # No worker started/result receipt yet.
        self.assertEqual(len(self.launches()), 1)

    def test_real_local_payload_worker_is_one_shot_and_ready(self):
        first = self.call()
        with patch.object(self.cache, 'evict', side_effect=AssertionError('no reclaim')):
            self.assertEqual(self.helper.dataset_worker(self.node, first['operationId']), 0)
            self.assertEqual(self.helper.dataset_worker(self.node, first['operationId']), 1)
        self.assertEqual(self.cache.status(self.user, 'example', self.version)['state'], 'READY')
        self.assertEqual(self.call()['state'], 'READY')
        self.assertEqual(len(self.launches()), 1)

    def test_capacity_change_before_dispatch_cannot_save_or_launch(self):
        for result in ({'fits': False, 'noReclaim': True}, {'fits': True, 'noReclaim': False}):
            with self.subTest(result=result):
                self.plan_result = result
                with self.assertRaisesRegex(ValueError, 'capacity changed'):
                    self.call()
        self.assertEqual(self.launches(), [])
        self.assertFalse((self.node.ROOT / 'dataset-ops').exists())

    def test_worker_rechecks_capacity_and_never_calls_payload_on_failure(self):
        first = self.call()
        self.plan_result['fits'] = False
        with patch.object(self.node, 'dataset_worker') as payload:
            self.assertEqual(self.helper.dataset_worker(self.node, first['operationId']), 1)
            payload.assert_not_called()
        receipt = self.helper.read(self.node.ROOT / 'dataset-ops' / (first['operationId'] + '.result.json'))
        self.assertEqual(receipt['state'], 'FAILED')
        self.assertNotEqual(self.cache.status(self.user, 'example', self.version)['state'], 'READY')

    def test_job_cancellation_fences_late_dispatch_before_admission(self):
        (self.node.ROOT / 'jobs' / (self.job['id'] + '.canceled')).touch(mode=0o600)
        with self.assertRaisesRegex(ValueError, 'job is canceled'):
            self.call()
        self.assertEqual(self.plan_calls, [])
        self.assertEqual(self.launches(), [])

    def test_cancel_before_worker_start_prevents_all_payload(self):
        first = self.call()
        result = self.call('datasets.cancel')
        self.assertEqual(result['state'], 'CANCELED')
        self.assertTrue(result['confirmedStopped'])
        with patch.object(self.node, 'dataset_worker') as payload:
            self.assertEqual(self.helper.dataset_worker(self.node, first['operationId']), 1)
            payload.assert_not_called()
        self.assertEqual(len(self.launches()), 1)

    def test_stop_exit_is_not_stop_proof_and_unknown_activity_is_not_canceled(self):
        first = self.call()
        for activity in (True, None):
            self.activity = activity
            result = self.call('datasets.cancel')
            self.assertEqual(result['state'], 'UNKNOWN')
            self.assertFalse(result['confirmedStopped'])
        self.activity = False
        self.run.side_effect = ValueError('already collected')
        result = self.call('datasets.cancel')
        self.assertEqual(result['state'], 'CANCELED')
        self.assertTrue(result['confirmedStopped'])
        self.assertEqual(result['operationId'], first['operationId'])

    def test_real_worker_lock_prevents_false_stop_confirmation(self):
        first = self.call()
        worker_lock = self.node.ROOT / 'dataset-ops' / (first['operationId'] + '.worker.lock')
        with self.helper.lock(worker_lock):
            result = self.call('datasets.cancel')
            self.assertEqual(result['state'], 'UNKNOWN')
            self.assertFalse(result['confirmedStopped'])
        self.assertTrue(self.call('datasets.cancel')['confirmedStopped'])

    def test_source_disappearance_cannot_cancel_another_idle_operation(self):
        warehouse = SimpleNamespace(contains=Mock(return_value=True))
        with patch.object(self.node, 'storage_warehouse', return_value=warehouse):
            first = self.call()
            folder = self.node.ROOT / 'dataset-ops'
            original = folder / (first['operationId'] + '.json')
            before = original.read_bytes()
            warehouse.contains.return_value = False  # Original READY/registration disappeared.
            original_unit = 'gpuq-data-' + first['operationId'][:32] + '.service'
            with patch.object(self.transfers, 'activity', side_effect=lambda unit: unit == original_unit):
                result = self.call('datasets.cancel')
            self.assertEqual(result['operationId'], first['operationId'])
            self.assertEqual(result['state'], 'UNKNOWN')
            self.assertFalse(result['confirmedStopped'])
            self.assertEqual(original.read_bytes(), before)
            stops = [c for c in self.run.call_args_list if c.args[0][:4] == ['/usr/bin/systemctl', '--user', 'stop', original_unit]]
            self.assertEqual(len(stops), 1)

    def test_real_activity_requires_exact_service_and_empty_cgroup(self):
        key, _task = self.identity()
        unit = 'gpuq-data-' + key[:32] + '.service'
        self.assertEqual(self.helper.unit(key), unit)
        method = type(self.transfers).activity
        process = method.__globals__['subprocess']
        props = 'LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlGroup=/fixture/' + unit + '\n'
        done = subprocess.CompletedProcess(['fixed-systemctl'], 0, stdout=props, stderr='')
        with patch.object(process, 'run', return_value=done) as inspect_unit:
            with patch.object(Path, 'read_text', return_value='populated 0\n') as events:
                self.assertIs(method(self.transfers, unit), False)
                self.assertEqual(events.call_args.args, ())
            with patch.object(Path, 'read_text', return_value='populated 1\n'):
                self.assertIs(method(self.transfers, unit), True)
            wrong = subprocess.CompletedProcess(['fixed-systemctl'], 0, stdout=props.replace(unit, unit[:-8]), stderr='')
            inspect_unit.return_value = wrong
            with patch.object(Path, 'read_text', side_effect=AssertionError('mismatched cgroup must not be opened')):
                self.assertIsNone(method(self.transfers, unit))
        self.assertEqual(inspect_unit.call_args.args[0][:4], ['/usr/bin/systemctl', '--user', 'show', unit])

    def test_pre_dispatch_cancel_is_durable_and_not_later_launched(self):
        first = self.call('datasets.cancel')
        self.assertEqual(first['state'], 'CANCELED')
        self.assertEqual(self.call()['state'], 'CANCELED')
        self.assertEqual(self.launches(), [])

    def test_foreign_or_unknown_legacy_pointer_is_not_taken_over(self):
        folder = self.node.ROOT / 'dataset-ops'
        folder.mkdir(mode=0o700)
        old, pointer = self.legacy_pointer(folder)
        body = pointer.read_bytes()
        for activity in (True, None, False):
            self.activity = activity
            with self.assertRaisesRegex(ValueError, 'original cohort'):
                self.call()
            self.assertEqual(pointer.read_bytes(), body)
        self.assertEqual(self.launches(), [])

    def test_confirmed_stopped_completed_pointer_keeps_legacy_history(self):
        folder = self.node.ROOT / 'dataset-ops'
        folder.mkdir(mode=0o700)
        old, pointer = self.legacy_pointer(folder)
        path = folder / (old + '.result.json')
        self.node.atomic_json(path, {'state': 'FAILED', 'legacy': True})
        before = path.read_bytes()
        result = self.call()
        self.assertNotEqual(result['operationId'], old)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(len(self.launches()), 1)

    def test_owner_mode_machine_source_and_full_manifest_schema_are_closed(self):
        mutations = [
            lambda v: v['args'].__setitem__('userId', 'demo-user-2'),
            lambda v: v['planRequest'].__setitem__('userId', 'demo-user-2'),
            lambda v: v['job'].__setitem__('userId', 'demo-user-2'),
            lambda v: v['args'].__setitem__('hostAdmin', True),
            lambda v: v['job'].__setitem__('datasetReadMode', 'warehouse'),
            lambda v: v['preparation'].__setitem__('targetMachine', 'other-machine'),
            lambda v: v['preparation'].__setitem__('sourceMachine', 'other-machine'),
            lambda v: v['preparation']['logicalReference'].__setitem__('dataset', 'foreign'),
            lambda v: v['planRequest']['datasetFootprints'][0].pop('manifestBytes'),
            lambda v: v['job'].__setitem__('callerFlag', True),
        ]
        for mutate in mutations:
            value = copy.deepcopy(self.envelope)
            mutate(value)
            with self.subTest(value=value), self.assertRaises((ValueError, KeyError)):
                self.call(envelope=value)
        self.assertEqual(self.plan_calls, [])
        self.assertEqual(self.launches(), [])

    def test_worker_requires_full_original_binding_and_exact_runtime(self):
        first = self.call()
        folder = self.node.ROOT / 'dataset-ops'
        task = self.helper.read(folder / (first['operationId'] + '.json'))
        task['trainingPreparation']['runtime'] = str(self.base / 'other-runtime')
        key = __import__('hashlib').sha256(json.dumps(task, sort_keys=True).encode()).hexdigest()
        self.node.atomic_json(folder / (key + '.json'), task)
        with patch.object(self.node, 'dataset_worker') as payload:
            with self.assertRaisesRegex(ValueError, 'binding changed'):
                self.helper.dataset_worker(self.node, key)
            payload.assert_not_called()

    def test_private_receipt_no_follow_modes_and_hardlinks_are_rejected(self):
        folder = self.node.ROOT / 'receipt-test'
        folder.mkdir(mode=0o700)
        source = folder / 'receipt'
        self.node.atomic_json(source, {'value': 1})
        self.assertEqual(self.helper.read(source), {'value': 1})
        source.chmod(0o640)
        with self.assertRaises(ValueError):
            self.helper.read(source)
        source.chmod(0o600)
        alias = folder / 'hardlink'
        os.link(source, alias)
        with self.assertRaises(ValueError):
            self.helper.read(source)
        alias.unlink()
        alias.symlink_to(source)
        with self.assertRaises(OSError):
            self.helper.read(alias)

    def test_fifo_receipt_and_lock_reject_before_any_blocking_open(self):
        # Assert the production flag before exercising a real FIFO so an old
        # blocking regression fails quickly instead of hanging the test runner.
        for method in (self.helper.read, self.helper.lock.__wrapped__):
            source = __import__('inspect').getsource(method)
            self.assertIn('os.O_NONBLOCK', source)
        fifo = self.node.ROOT / 'receipt-fifo'
        os.mkfifo(fifo, 0o600)
        started = time.monotonic()
        with self.assertRaises((OSError, ValueError)):
            self.helper.read(fifo)
        with self.assertRaises((OSError, ValueError)):
            with self.helper.lock(fifo):
                self.fail('FIFO lock accepted')
        self.assertLess(time.monotonic() - started, 1)

    def test_detached_candidate_entry_cannot_add_unmanifested_bytecode(self):
        environment={key:value for key,value in os.environ.items() if key!='PYTHONDONTWRITEBYTECODE'}
        subprocess.run([sys.executable,str(self.base/'node-executor.py'),'--training-dataset-worker','a'*64],
                       env=environment,capture_output=True,timeout=5)
        self.assertFalse((self.base/'__pycache__').exists())


if __name__ == '__main__':
    unittest.main()
