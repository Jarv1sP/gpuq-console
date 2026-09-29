"""Host command safety and subprocess lifecycle, entirely local without sudo."""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

SPEC = importlib.util.spec_from_file_location('admin_command_test', Path(__file__).resolve().parents[1] / 'deploy/admin-command.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class HostCommands(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.commands = module.Commands(self.root)
        self.key = str(uuid.uuid4())
        self.identity = {'userId': 'builtin-admin', 'username': 'admin'}
        self.args = {**self.identity, 'key': self.key, 'argv': [sys.executable, '-c', 'print("hello")'], 'cwd': str(self.root), 'timeoutSec': 5}
        self.active = patch.object(self.commands, 'activity', return_value=False).start()
        self.launch = patch.object(self.commands, 'run_system', return_value=SimpleNamespace(returncode=0, stdout='')).start()
        self.addCleanup(patch.stopall)

    def submit(self, **extra):
        return self.commands.call('host.exec', {**self.args, **extra})

    def status(self):
        return self.commands.status(self.key, self.identity['userId'])

    def test_validation_rejects_extra_fields_and_invalid_argv_time_identity(self):
        for changes in ({'argv': 'sh -c echo'}, {'argv': []}, {'argv': ['']}, {'argv': ['a\0b']},
                        {'argv': ['a' * 12001]}, {'timeoutSec': True}, {'timeoutSec': 0},
                        {'timeoutSec': 86401}, {'cwd': 'relative'}, {'key': '../bad'},
                        {'userId': 'root'}, {'project': 'private'}, {'username': ''}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.submit(**changes)
        self.launch.assert_not_called()

    def test_node_gate_requires_exact_enabled_boolean_and_admin(self):
        for config, args in [({'hostRoot': False}, {**self.args, 'hostAdmin': True}),
                             ({'hostRoot': 1}, {**self.args, 'hostAdmin': True}),
                             ({'hostRoot': True}, self.args),
                             ({'hostRoot': True}, {**self.args, 'hostAdmin': 1})]:
            with self.subTest(config=config), patch.object(module.subprocess, 'run') as run, self.assertRaises(ValueError):
                module.process(config, 'host.exec', args)
            run.assert_not_called()

    def test_node_rejects_untrusted_helper_and_forwards_only_json_argv(self):
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0o100775, st_uid=0)), self.assertRaisesRegex(ValueError, 'Unsafe'):
            module.process({'hostRoot': True}, 'host.exec', {**self.args, 'hostAdmin': True})
        reply = SimpleNamespace(returncode=0, stdout=json.dumps({'ok': True, 'result': {'id': self.key}}))
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0o100755, st_uid=0)), patch.object(module.subprocess, 'run', return_value=reply) as run:
            self.assertEqual(module.process({'hostRoot': True}, 'host.exec', {**self.args, 'hostAdmin': True}), {'id': self.key})
            self.assertEqual(run.call_args.args[0], ['/usr/bin/sudo', '-n', module.ROOT_HELPER])
            self.assertNotIn('shell', run.call_args.kwargs)
            self.assertNotIn('hostAdmin', json.loads(run.call_args.kwargs['input'])['args'])

    def test_valid_multibyte_argv_fits_the_helper_utf8_request_limit(self):
        argv = ['printf', '中' * 3500]
        args = {**self.args, 'argv': argv, 'hostAdmin': True}
        self.assertLess(len(json.dumps(argv, ensure_ascii=False).encode('utf-8')), 12000)

        def helper(_command, **kwargs):
            forwarded = kwargs['input']
            if isinstance(forwarded, str):
                forwarded = forwarded.encode('utf-8')
            self.assertLessEqual(len(forwarded), module.REQUEST_LIMIT)
            self.assertIn('中'.encode('utf-8'), forwarded)
            if isinstance(kwargs['input'], str):
                self.assertEqual(kwargs.get('encoding'), 'utf-8')
            self.assertEqual(json.loads(forwarded)['args']['argv'], argv)
            output = io.StringIO()
            # Exercise the actual bounded helper reader without root, sudo,
            # systemd, or a real command dispatch.
            with patch.object(module, 'prepare_root'), patch.object(module.os, 'umask'), \
                    patch.object(module, 'Commands') as commands, \
                    patch.object(module.sys, 'argv', [module.ROOT_HELPER]), \
                    patch.object(module.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(forwarded))), \
                    patch.object(module.sys, 'stdout', output):
                commands.return_value.call.return_value = {'id': self.key}
                code = module.main()
                commands.return_value.call.assert_called_once_with(
                    'host.exec', {k: v for k, v in args.items() if k != 'hostAdmin'})
            return SimpleNamespace(returncode=code, stdout=output.getvalue())

        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0o100755, st_uid=0)), \
                patch.object(module.subprocess, 'run', side_effect=helper):
            self.assertEqual(module.process({'hostRoot': True}, 'host.exec', args), {'id': self.key})

    def test_node_and_helper_share_the_same_request_byte_limit_boundary(self):
        args = {**self.args, 'argv': ['printf', '中']}
        request = json.dumps({'operation': 'host.exec', 'args': args}, ensure_ascii=False).encode('utf-8')
        reply = SimpleNamespace(returncode=0, stdout=json.dumps({'ok': True, 'result': {'id': self.key}}))
        for limit in (len(request), len(request) - 1):
            with self.subTest(limit=limit), patch.object(module, 'REQUEST_LIMIT', limit):
                with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0o100755, st_uid=0)), \
                        patch.object(module.subprocess, 'run', return_value=reply) as run:
                    if limit == len(request):
                        self.assertEqual(module.process({'hostRoot': True}, 'host.exec', {**args, 'hostAdmin': True}), {'id': self.key})
                        run.assert_called_once()
                    else:
                        with self.assertRaisesRegex(ValueError, 'too large'):
                            module.process({'hostRoot': True}, 'host.exec', {**args, 'hostAdmin': True})
                        run.assert_not_called()
                with patch.object(module, 'prepare_root'), patch.object(module.os, 'umask'), \
                        patch.object(module, 'Commands') as commands, \
                        patch.object(module.sys, 'argv', [module.ROOT_HELPER]), \
                        patch.object(module.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(request))), \
                        patch.object(module.sys, 'stdout', io.StringIO()):
                    commands.return_value.call.return_value = {'id': self.key}
                    if limit == len(request):
                        self.assertEqual(module.main(), 0)
                        commands.return_value.call.assert_called_once_with('host.exec', args)
                    else:
                        with self.assertRaisesRegex(ValueError, 'too large'):
                            module.main()
                        commands.return_value.call.assert_not_called()

    def test_same_key_launches_once_even_after_dispatch_timeout_and_restart(self):
        self.launch.side_effect = subprocess.TimeoutExpired('systemd-run', 8)
        self.assertEqual(self.submit()['state'], 'UNKNOWN')
        self.submit(); self.assertEqual(self.launch.call_count, 1)
        reopened = module.Commands(self.root)
        with patch.object(reopened, 'activity', return_value=False), patch.object(reopened, 'run_system') as again:
            self.assertEqual(reopened.call('host.exec', self.args)['state'], 'UNKNOWN')
            again.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'same command key'):
            self.submit(argv=['true'])
        events = [json.loads(line)['event'] for line in (self.root / 'audit.jsonl').read_text().splitlines()]
        self.assertEqual(events, ['submit'])

    def test_fail_closed_if_audit_cannot_persist(self):
        with patch.object(self.commands, 'audit', side_effect=OSError('disk full')), self.assertRaises(OSError):
            self.submit()
        self.launch.assert_not_called()
        self.assertFalse(self.commands.path(self.key, '.json').exists())

    def test_concurrent_retries_share_a_single_dispatch(self):
        with ThreadPoolExecutor(max_workers=4) as threads:
            results = list(threads.map(lambda _: self.submit(), range(8)))
        self.assertEqual(len({result['id'] for result in results}), 1)
        self.assertEqual(self.launch.call_count, 1)

    def test_nodewide_limit_is_atomic_and_same_key_retry_consumes_no_new_slot(self):
        keys = [str(uuid.uuid4()) for _ in range(module.MAX_CONCURRENT)]
        for key in keys:
            self.submit(key=key)
        with self.assertRaisesRegex(ValueError, 'concurrency limit'):
            self.submit()
        self.assertFalse(self.commands.path(self.key, '.json').exists())
        self.submit(key=keys[0])
        self.assertEqual(self.launch.call_count, module.MAX_CONCURRENT)

    def test_unknown_dispatch_without_worker_fence_keeps_its_slot(self):
        self.launch.side_effect = subprocess.TimeoutExpired('systemd-run', 8)
        for _ in range(module.MAX_CONCURRENT):
            self.assertEqual(self.submit(key=str(uuid.uuid4()))['state'], 'UNKNOWN')
        self.active.return_value = False
        with self.assertRaisesRegex(ValueError, 'concurrency limit'):
            self.submit()
        self.assertEqual(self.launch.call_count, module.MAX_CONCURRENT)

    def test_reclaim_requires_both_worker_fence_and_confirmed_empty_unit(self):
        keys = [str(uuid.uuid4()) for _ in range(module.MAX_CONCURRENT)]
        for key in keys:
            self.submit(key=key)
        module.atomic_json(self.commands.path(keys[0], '.result.json'), {'state': 'SUCCEEDED', 'exitCode': 0})
        for active in (True, None):
            self.active.return_value = active
            with self.assertRaisesRegex(ValueError, 'concurrency limit'):
                self.submit()
        self.active.return_value = False
        self.submit()
        self.assertEqual(self.launch.call_count, module.MAX_CONCURRENT + 1)

    def test_parallel_new_keys_never_exceed_nodewide_limit(self):
        def submit(_index):
            try:
                return self.submit(key=str(uuid.uuid4()))
            except ValueError as error:
                self.assertRegex(str(error), 'admission is busy|concurrency limit')
        with ThreadPoolExecutor(max_workers=12) as threads:
            list(threads.map(submit, range(24)))
        self.assertLessEqual(self.launch.call_count, module.MAX_CONCURRENT)
        self.assertGreater(self.launch.call_count, 0)
        for call in self.launch.call_args_list:
            self.assertFalse(any(any(limit in arg for limit in ('CPUQuota', 'MemoryMax', 'TasksMax'))
                                 for arg in call.args[0]))

    def test_ownership_and_explicit_unit_scope(self):
        self.submit()
        for operation in ('host.status', 'host.cancel'):
            with self.assertRaisesRegex(ValueError, 'not owned'):
                self.commands.call(operation, {'userId': 'demo-user-1', 'username': 'other-admin', 'id': self.key})
        argv = self.launch.call_args.args[0]
        self.assertIn('--unit=gpuq-host-' + self.key + '.service', argv)
        self.assertIn('--property=KillMode=control-group', argv)
        self.assertIn('--property=RuntimeMaxSec=15', argv)
        self.assertNotIn('--user', argv)
        self.assertEqual(argv[-3:], [module.ROOT_HELPER, '--worker', self.key])

    def test_worker_captures_two_streams_exit_status_literal_argv_and_audit(self):
        text = 'literal;$(touch forbidden) * "quotes"'
        argv = [sys.executable, '-c', 'import sys;print(sys.argv[1]);print("problem",file=sys.stderr);sys.exit(7)', text]
        self.submit(argv=argv)
        self.assertEqual(self.commands.worker(self.key), 0)
        result = self.status()
        self.assertEqual(result['state'], 'FAILED'); self.assertEqual(result['exitCode'], 7)
        self.assertEqual(result['stdout'], text + '\n'); self.assertEqual(result['stderr'], 'problem\n')
        self.assertFalse((self.root / 'forbidden').exists())
        audits = [json.loads(line) for line in (self.root / 'audit.jsonl').read_text().splitlines()]
        self.assertEqual([a['event'] for a in audits], ['submit', 'start', 'finish'])
        self.assertNotIn(text, (self.root / 'audit.jsonl').read_text())
        for record in audits:
            self.assertEqual(record['userId'], 'builtin-admin'); self.assertEqual(len(record['digest']), 64)

    def test_output_is_bounded_while_both_pipes_are_drained(self):
        self.submit(argv=[sys.executable, '-c', 'import os;os.write(1,b"o"*250000);os.write(2,b"e"*250000)'])
        self.commands.worker(self.key)
        result = self.status()
        self.assertEqual(result['state'], 'SUCCEEDED')
        self.assertEqual(len(result['stdout']), module.LIMIT); self.assertEqual(len(result['stderr']), module.LIMIT)
        self.assertEqual(result['truncated'], {'stdout': True, 'stderr': True})
        self.assertEqual(self.commands.path(self.key, '.stdout').stat().st_size, module.LIMIT)

    def test_timeout_is_explicit_and_group_is_killed(self):
        self.submit(argv=[sys.executable, '-c', 'import time;print("started",flush=True);time.sleep(60)'], timeoutSec=1)
        began = time.monotonic(); self.commands.worker(self.key)
        result = self.status()
        self.assertLess(time.monotonic() - began, 5)
        self.assertEqual(result['state'], 'TIMED_OUT'); self.assertTrue(result['timedOut'])
        self.assertEqual(result['signal'], signal.SIGTERM)
        self.assertIn('started', result['stdout'])

    def test_cancel_before_worker_prevents_execution_and_double_worker_never_repeats(self):
        self.submit(argv=[sys.executable, '-c', 'from pathlib import Path;Path("ran").write_text("once")'])
        self.commands.call('host.cancel', {**self.identity, 'id': self.key})
        self.commands.worker(self.key)
        self.assertEqual(self.status()['state'], 'CANCELED'); self.assertFalse((self.root / 'ran').exists())
        self.assertEqual(self.commands.worker(self.key), 1)

    def test_descendant_retaining_pipes_is_cleaned_after_parent_exit(self):
        self.submit(argv=[sys.executable, '-c', 'import subprocess;subprocess.Popen(["sleep","60"]);print("parent done")'])
        began = time.monotonic(); self.commands.worker(self.key)
        self.assertLess(time.monotonic() - began, 5)
        self.assertEqual(self.status()['state'], 'SUCCEEDED')

    def test_active_worker_cancel_captures_final_output_and_reaps_child(self):
        self.submit(argv=[sys.executable, '-c', 'import os,time;print(os.getpid(),flush=True);time.sleep(60)'])
        code = ('import importlib.util,sys;from pathlib import Path;'
                's=importlib.util.spec_from_file_location("worker_test",sys.argv[1]);'
                'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
                'sys.exit(m.Commands(Path(sys.argv[2])).worker(sys.argv[3]))')
        worker = subprocess.Popen([sys.executable, '-c', code, SPEC.origin, str(self.root), self.key])
        self.addCleanup(lambda: worker.kill() if worker.poll() is None else None)
        output = self.commands.path(self.key, '.stdout')
        deadline = time.monotonic() + 5
        while (not output.exists() or not output.read_text().strip()) and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(output.exists()); pid = int(output.read_text().strip())
        module.atomic_json(self.commands.path(self.key, '.cancel'), {'at': module.now()})
        worker.terminate(); worker.wait(timeout=5)
        result = self.status()
        self.assertEqual(result['state'], 'CANCELED'); self.assertEqual(result['signal'], signal.SIGTERM)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_terminal_receipt_requires_confirmed_empty_cgroup(self):
        self.submit(); self.commands.worker(self.key)
        self.active.return_value = True
        self.assertEqual(self.status()['state'], 'RUNNING'); self.assertIsNone(self.status()['exitCode'])
        self.active.return_value = None
        self.assertEqual(self.status()['state'], 'UNKNOWN')
        self.active.return_value = False
        self.assertEqual(self.status()['state'], 'SUCCEEDED')

    def test_completion_receipt_written_during_activity_probe_is_visible_immediately(self):
        self.submit()
        receipt = self.commands.path(self.key, '.result.json')
        self.assertFalse(receipt.exists())
        finished = {'state': 'SUCCEEDED', 'exitCode': 0, 'signal': None,
                    'finishedAt': '2026-09-30T00:00:00Z', 'timedOut': False,
                    'truncated': {'stdout': False, 'stderr': False}}

        def finish_during_probe(identifier):
            self.assertEqual(identifier, self.key)
            module.atomic_json(receipt, finished)
            return False

        self.active.side_effect = finish_during_probe
        result = self.status()
        self.assertEqual(result['state'], 'SUCCEEDED')
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(result['finishedAt'], finished['finishedAt'])
        self.assertNotIn('error', result)

    def test_systemctl_failures_are_unknown_not_confirmed_stopped(self):
        commands = module.Commands(self.root)
        for code, text in [(1, ''), (0, 'MainPID=0\nActiveState=inactive\n'),
                           (1, 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n')]:
            with patch.object(commands, 'run_system', return_value=SimpleNamespace(returncode=code, stdout=text)):
                self.assertIsNone(commands.activity(self.key))
        text = 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n'
        with patch.object(commands, 'run_system', return_value=SimpleNamespace(returncode=1, stdout=text)):
            self.assertIs(commands.activity(self.key), False)


if __name__ == '__main__':
    unittest.main()
