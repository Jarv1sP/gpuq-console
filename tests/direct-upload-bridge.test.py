"""Exercise the actual fixed SSH bridge handler with synthetic input only."""
import io
import json
from pathlib import Path
import runpy
import unittest
from types import SimpleNamespace
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1]/'deploy/execution-worker.py'


class BridgeDirectOperations(unittest.TestCase):
    def setUp(self):
        # Load source without reading real inventory or opening any listener.
        inventory = json.dumps({'nodes': [{'id': 'gpu-4', 'user': 'fixture', 'address': '127.0.0.1'}]})
        with patch.object(Path, 'read_text', return_value=inventory):
            self.worker = runpy.run_path(str(WORKER), run_name='bridge_test')

    def request(self, operation, machine='gpu-4'):
        handler = self.worker['Handler'].__new__(self.worker['Handler'])
        handler.request = SimpleNamespace(settimeout=lambda _value: None)
        args = {'userId': 'demo-user-1', 'hostAdmin': False, 'uploadId': '12345678-1234-4234-8234-123456789012'}
        handler.rfile = io.BytesIO(json.dumps({'machine': machine, 'operation': operation, 'args': args}).encode()+b'\n')
        handler.wfile = io.BytesIO()
        with patch.object(self.worker['subprocess'], 'run', return_value=SimpleNamespace(returncode=0, stdout='{"ok":true,"result":{"available":false}}')) as run:
            handler.handle()
        return json.loads(handler.wfile.getvalue()), run, args

    def test_exact_direct_control_operations_cross_real_bridge_without_shell_or_identity_changes(self):
        for operation in ('datasets.upload.direct-ticket', 'datasets.upload.direct-revoke'):
            result, run, args = self.request(operation)
            self.assertTrue(result['ok'])
            command = run.call_args.args[0]
            self.assertEqual(command[0], '/usr/bin/ssh')
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertEqual(command[-1], 'fixture@127.0.0.1')
            self.assertEqual(json.loads(run.call_args.kwargs['input']), {'operation': operation, 'args': args})
            self.assertNotIn('shell', run.call_args.kwargs)

    def test_nearby_unknown_operations_and_unknown_machines_are_rejected_before_ssh(self):
        for operation in ('datasets.upload.direct-shell', 'datasets.upload.raw', 'datasets.upload.direct-ticket.extra'):
            result, run, _args = self.request(operation)
            self.assertFalse(result['ok'])
            run.assert_not_called()
        result, run, _args = self.request('datasets.upload.direct-ticket', machine='other')
        self.assertFalse(result['ok'])
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
