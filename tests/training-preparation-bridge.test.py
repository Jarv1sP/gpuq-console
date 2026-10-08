"""Actual private bridge dispatch, synthetic inventory and SSH transport only."""
import io
import json
from pathlib import Path
import runpy
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1] / 'deploy/execution-worker.py'
PREPARATIONS = ('storage.training.prepare', 'storage.training.project.prepare')


class TrainingPreparationBridge(unittest.TestCase):
    def setUp(self):
        original = Path.read_text

        def read(path, *args, **kwargs):
            if str(path) == '/opt/gpuq-console/inventory.json':
                return json.dumps({'nodes': [{'id': 'fixture-node', 'user': 'fixture',
                                              'address': '127.0.0.1'}]})
            return original(path, *args, **kwargs)

        with patch.object(Path, 'read_text', read):
            self.worker = runpy.run_path(str(WORKER), run_name='training_bridge_test')
        self.envelope = {
            'job': {'id': '11111111-1111-4111-8111-111111111111', 'userId': 'fixture-owner'},
            'planRequest': {'userId': 'fixture-owner', 'hostAdmin': False},
            'preparation': {'protocol': 1, 'id': '22222222-2222-4222-8222-222222222222'},
            'operation': 'fixture-inner-operation', 'args': {'userId': 'fixture-owner'},
        }

    def request(self, operation, *, machine='fixture-node', response=None, failure=None):
        handler = self.worker['Handler'].__new__(self.worker['Handler'])
        handler.request = SimpleNamespace(settimeout=lambda _value: None)
        handler.rfile = io.BytesIO(json.dumps({'machine': machine, 'operation': operation,
                                              'args': self.envelope}).encode() + b'\n')
        handler.wfile = io.BytesIO()
        response = {'ok': True, 'result': {'state': 'UNKNOWN'}} if response is None else response
        with (
            patch.object(self.worker['SSH_CONNECTIONS'], 'control_path',
                         return_value=Path('/fixture-private/control')),
            patch.object(self.worker['SSH_CONNECTIONS'], 'ensure_master'),
            patch.object(self.worker['subprocess'], 'run', side_effect=failure,
                         return_value=SimpleNamespace(returncode=0, stdout=json.dumps(response))) as run,
        ):
            handler.handle()
        return json.loads(handler.wfile.getvalue()), run

    def test_exact_private_preparations_forward_immutable_envelope_once(self):
        for operation in PREPARATIONS:
            with self.subTest(operation=operation):
                self.assertIn(operation, self.worker['INTERNAL_STORAGE'])
                result, run = self.request(operation)
                self.assertEqual(result, {'ok': True, 'result': {'state': 'UNKNOWN'}})
                run.assert_called_once()
                self.assertEqual(json.loads(run.call_args.kwargs['input']),
                                 {'operation': operation, 'args': self.envelope})
                command = run.call_args.args[0]
                self.assertEqual(command[:4], ['/usr/bin/ssh', '-F', '/dev/null', '-T'])
                self.assertEqual(command[-1], 'fixture@127.0.0.1')
                for option in ('StrictHostKeyChecking=yes', 'IdentitiesOnly=yes',
                               'ForwardAgent=no', 'ClearAllForwardings=yes',
                               'ProxyCommand=/usr/bin/false'):
                    self.assertIn(option, command)
                self.assertNotIn('shell', run.call_args.kwargs)

    def test_existing_read_and_manual_copy_rpcs_stay_reachable(self):
        for operation in ('datasets.training.status', 'storage.training.plan',
                          'projects.copy.prepare', 'projects.copy.start', 'projects.copy.cancel'):
            with self.subTest(operation=operation):
                result, run = self.request(operation)
                self.assertTrue(result['ok']); run.assert_called_once()

    def test_unknown_operation_or_machine_does_not_dispatch(self):
        cases = [(value, 'fixture-node') for value in
                 ('storage.training.*', 'storage.training.project.*', 'storage.training.project.shell',
                  'storage.training.project.prepare.extra', 'storage.training.force')]
        cases += [(value, 'unknown-node') for value in PREPARATIONS]
        for operation, machine in cases:
            with self.subTest(operation=operation, machine=machine):
                result, run = self.request(operation, machine=machine)
                self.assertEqual(result, {'ok': False, 'error': 'Invalid operation'})
                run.assert_not_called()

    def test_node_rejection_and_ambiguous_transport_failure_are_not_replayed(self):
        for operation in PREPARATIONS:
            with self.subTest(operation=operation):
                rejection = {'ok': False, 'error': 'Original preparation changed'}
                result, run = self.request(operation, response=rejection)
                self.assertEqual(result, rejection); run.assert_called_once()
                result, run = self.request(operation,
                                          failure=subprocess.TimeoutExpired('fixture-rpc', 1))
                self.assertFalse(result['ok']); self.assertTrue(result['outcomeUnconfirmed'])
                run.assert_called_once()


if __name__ == '__main__':
    unittest.main()
