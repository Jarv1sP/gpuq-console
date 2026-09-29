"""Extract only the manual probe's observer; never import Ray or run the probe."""
import ast
import json
from pathlib import Path
import subprocess
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

SOURCE = Path(__file__).with_name('ray-eight-gpu-probe.py')
tree = ast.parse(SOURCE.read_text())
observer_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'StartupProcessObserver')
namespace = {'json': json, 'subprocess': subprocess, 'threading': threading, 'time': time}
exec(compile(ast.Module(body=[observer_class], type_ignores=[]), str(SOURCE), 'exec'), namespace)
Observer = namespace['StartupProcessObserver']


class StartupObserverTests(unittest.TestCase):
    def test_raylet_early_stderr_preserves_process_info_and_does_not_log_arguments(self):
        process = SimpleNamespace(pid=42, poll=Mock(return_value=None))
        info = SimpleNamespace(process=process)
        original = Mock(return_value=info); services = SimpleNamespace(start_ray_process=original)
        emit = Mock(); observer = Observer(services, emit=emit, background=False)
        arguments = ['raylet', '--some-sensitive-argument=secret']
        self.assertIs(services.start_ray_process(arguments, 'raylet', True,
            env_updates={'PRIVATE_TOKEN': 'secret'}, stdout_file=subprocess.DEVNULL,
            stderr_file=subprocess.DEVNULL), info)
        self.assertEqual(original.call_args.args, (arguments, 'raylet', True))
        self.assertEqual(original.call_args.kwargs['env_updates'], {'PRIVATE_TOKEN': 'secret'})
        self.assertEqual(original.call_args.kwargs['stdout_file'], subprocess.DEVNULL)
        self.assertIsNone(original.call_args.kwargs['stderr_file'])
        process.poll.return_value = -6; observer.sample()
        records = observer.close()
        self.assertIs(services.start_ray_process, original)
        self.assertTrue(any(row['phase'] == 'exit' and row['poll'] == -6 for row in records))
        self.assertNotIn('secret', json.dumps(records))
        self.assertNotIn('PRIVATE_TOKEN', str(emit.call_args_list))

    def test_other_components_and_explicit_stderr_are_untouched(self):
        original = Mock(return_value=SimpleNamespace(process=SimpleNamespace(pid=4, poll=lambda: 0)))
        services = SimpleNamespace(start_ray_process=original)
        observer = Observer(services, emit=Mock(), background=False)
        services.start_ray_process(['gcs'], process_type='gcs_server', stderr_file=subprocess.DEVNULL)
        self.assertEqual(original.call_args.kwargs['stderr_file'], subprocess.DEVNULL)
        stream = object()
        services.start_ray_process(['raylet'], process_type='raylet', stderr_file=stream)
        self.assertIs(original.call_args.kwargs['stderr_file'], stream)
        observer.close()

    def test_spawn_failure_preserves_exception_and_records_only_its_type(self):
        failure = OSError('sensitive argv detail')
        original = Mock(side_effect=failure); services = SimpleNamespace(start_ray_process=original)
        observer = Observer(services, emit=Mock(), background=False)
        with self.assertRaises(OSError) as caught: services.start_ray_process(['secret'], 'raylet', True)
        self.assertIs(caught.exception, failure)
        records = observer.close()
        self.assertEqual(records[-1]['errorType'], 'OSError')
        self.assertNotIn('sensitive', json.dumps(records)); self.assertNotIn('secret', json.dumps(records))

    def test_snapshots_are_bounded_and_do_not_kill_or_wait_on_ray_children(self):
        process = Mock(pid=1); process.poll.return_value = None
        original = Mock(return_value=SimpleNamespace(process=process)); services = SimpleNamespace(start_ray_process=original)
        observer = Observer(services, emit=Mock(), background=False)
        for _ in range(100): services.start_ray_process(['worker'], 'worker', True)
        records = observer.close()
        self.assertEqual(len(observer.children), 32); self.assertLessEqual(len(records), 128)
        self.assertLessEqual(observer.emit.call_count, 128)
        process.kill.assert_not_called(); process.terminate.assert_not_called(); process.wait.assert_not_called()


if __name__ == '__main__': unittest.main()
