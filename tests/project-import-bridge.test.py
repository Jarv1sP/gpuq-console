"""Load the actual fixed bridge and dispatch owner-bound project draft RPCs.

Inventory and the final SSH transport are synthetic; no socket, host path,
credential, production node or GPU job is accessed by this test.
"""
import io
import json
from pathlib import Path
import runpy
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1] / 'deploy/execution-worker.py'
KEY = '12345678-1234-4234-8234-123456789012'
PROJECT_DRAFT = ('files.upload.list', 'files.upload.cancel',
                 'projects.local-import.begin', 'projects.local-import.status',
                 'projects.local-import.cancel')


class ProjectDraftBridge(unittest.TestCase):
    def setUp(self):
        inventory = json.dumps({'nodes': [
            {'id': 'fixture-node', 'user': 'fixture', 'address': '127.0.0.1'}]})
        original = Path.read_text

        def read(path, *args, **kwargs):
            if str(path) == '/opt/gpuq-console/inventory.json':
                return inventory
            return original(path, *args, **kwargs)

        with patch.object(Path, 'read_text', read):
            self.worker = runpy.run_path(str(WORKER), run_name='project_draft_bridge_test')

    @staticmethod
    def args(operation):
        args = {'userId': 'fixture-owner', 'project': 'my-project'}
        if operation.startswith('files.upload.'):
            args['area'] = 'code'
            if operation in ('files.upload.cancel', 'files.upload.status'):
                args['uploadId'] = KEY
            if operation == 'files.upload.status':
                args.update(path='train.py', totalSize=7, sha256='a' * 64)
        else:
            if operation.startswith('projects.local-import.') or operation == 'projects.publish':
                args['key'] = KEY
            if operation == 'projects.local-import.begin':
                args.update(sourcePath='source/code', destinationPath='imported')
        return args

    def request(self, operation, machine='fixture-node', response=None, failure=None):
        handler = self.worker['Handler'].__new__(self.worker['Handler'])
        handler.request = SimpleNamespace(settimeout=lambda _value: None)
        args = self.args(operation)
        handler.rfile = io.BytesIO((json.dumps(
            {'machine': machine, 'operation': operation, 'args': args}) + '\n').encode())
        handler.wfile = io.BytesIO()
        if response is None:
            response = {'ok': True, 'result': {'key': KEY, 'state': 'UNKNOWN'}}
        with (
            patch.object(self.worker['SSH_CONNECTIONS'], 'control_path',
                         return_value=Path('/fixture-private/control')) as control,
            patch.object(self.worker['SSH_CONNECTIONS'], 'ensure_master') as master,
            patch.object(self.worker['subprocess'], 'run', side_effect=failure,
                         return_value=SimpleNamespace(returncode=0,
                                                      stdout=json.dumps(response))) as run,
        ):
            handler.handle()
        return json.loads(handler.wfile.getvalue()), run, args, control, master

    def test_all_five_exact_operations_cross_actual_bridge_with_unchanged_identity(self):
        for operation in PROJECT_DRAFT:
            with self.subTest(operation=operation):
                result, run, args, _control, _master = self.request(operation)
                self.assertTrue(result['ok'], result)
                run.assert_called_once()
                self.assertEqual(json.loads(run.call_args.kwargs['input']),
                                 {'operation': operation, 'args': args})
                self.assertEqual(result['result'], {'key': KEY, 'state': 'UNKNOWN'})
                self.assertFalse(args.get('hostAdmin', False))

    def test_existing_project_upload_and_publication_operations_remain_reachable(self):
        for operation in ('files.upload.status', 'projects.status', 'projects.publish'):
            with self.subTest(operation=operation):
                result, run, args, _control, _master = self.request(operation)
                self.assertTrue(result['ok'], result)
                run.assert_called_once()
                self.assertEqual(json.loads(run.call_args.kwargs['input']),
                                 {'operation': operation, 'args': args})

    def test_nearby_unlisted_operations_and_unknown_machine_never_reach_ssh(self):
        cases = [(operation, 'fixture-node') for operation in
                 ('files.upload.force-cancel', 'files.upload.delete',
                  'projects.local-import.force', 'projects.local-import.shell',
                  'projects.local-import.begin.extra', 'projects.local-import.*')]
        cases += [(operation, 'unknown-node') for operation in PROJECT_DRAFT]
        for operation, machine in cases:
            with self.subTest(operation=operation, machine=machine):
                result, run, _args, control, master = self.request(operation, machine)
                self.assertFalse(result['ok'])
                self.assertEqual(result['error'], 'Invalid operation')
                run.assert_not_called(); control.assert_not_called(); master.assert_not_called()

    def test_node_ownership_rejection_is_preserved_not_reinterpreted_as_success(self):
        rejection = {'ok': False, 'error': 'Different project owner'}
        for operation in PROJECT_DRAFT:
            with self.subTest(operation=operation):
                result, run, _args, _control, _master = self.request(operation, response=rejection)
                self.assertEqual(result, rejection)
                run.assert_called_once()

    def test_ambiguous_mutation_transport_failure_is_not_retried(self):
        for operation in ('projects.local-import.begin', 'projects.local-import.cancel',
                          'files.upload.cancel'):
            with self.subTest(operation=operation):
                result, run, _args, _control, _master = self.request(
                    operation, failure=subprocess.TimeoutExpired('fixture-rpc', 1))
                self.assertFalse(result['ok'])
                self.assertEqual(result['error'], 'Node connection failed')
                run.assert_called_once()

    def test_fixed_key_host_checks_and_no_shell_are_unchanged(self):
        for operation in PROJECT_DRAFT:
            with self.subTest(operation=operation):
                result, run, _args, _control, _master = self.request(operation)
                self.assertTrue(result['ok'], result)
                command = run.call_args.args[0]
                self.assertEqual(command[:4], ['/usr/bin/ssh', '-F', '/dev/null', '-T'])
                self.assertEqual(command[-1], 'fixture@127.0.0.1')
                for option in ('StrictHostKeyChecking=yes', 'IdentitiesOnly=yes',
                               'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes',
                               'ProxyCommand=/usr/bin/false'):
                    self.assertIn(option, command)
                self.assertNotIn('shell', run.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
