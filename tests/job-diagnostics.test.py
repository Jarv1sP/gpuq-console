"""Diagnostic boundaries/lifecycle without systemd, SSH, GPU or real user logs."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'
loader = importlib.util.spec_from_file_location('diagnostic_test', DEPLOY / 'job-diagnostics.py')
D = importlib.util.module_from_spec(loader); loader.loader.exec_module(D)
JID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
CAPTURE = 'b' * 32
UNIT = 'gpuq-test.service'


class Diagnostics(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve(); self.root.chmod(0o700)
        self.spec = {'id': JID, 'userId': 'demo-user-1', 'username': 'alice', 'cards': 1, 'argv': ['python', 'private-secret'], 'name': 'fixture', 'minVramGiB': 0}
        self.group = self.root / 'cgroup'; self.group.mkdir(mode=0o700)
        for name, content in {'memory.current': '20', 'memory.peak': '70', 'memory.events': 'low 0\noom 1\noom_kill 1\n', 'pids.current': '4', 'pids.peak': '9', 'pids.events': 'max 2\n', 'cpu.stat': 'usage_usec 100\n', 'cgroup.events': 'populated 1\n'}.items(): (self.group / name).write_text(content)
        self.group_patch = patch.object(D, '_group_path', return_value=self.group); self.group_patch.start()
        self.shown = {'Id': UNIT, 'InvocationID': CAPTURE, 'ControlGroup': '/some/' + UNIT, 'ActiveState': 'active', 'SubState': 'running', 'Result': 'success', 'ExecMainCode': '0', 'ExecMainStatus': '0'}
        self.show_patch = patch.object(D, '_show', return_value=self.shown); self.show_patch.start()
        self.run_patch = patch.object(D.subprocess, 'run', return_value=SimpleNamespace(returncode=0)); self.run = self.run_patch.start()

    def tearDown(self):
        self.run_patch.stop(); self.show_patch.stop(); self.group_patch.stop(); self.tmp.cleanup()

    def test_allocation_history_whitelists_real_lease_times_without_attempt_inference(self):
        row = {'id': 4, 'job_id': 'J-one', 'attempt_id': 'A-one', 'gpu_uuid': 'GPU-one',
               'gpu_index': 3, 'acquired_at': 123.25, 'released_at': 156.75,
               'release_reason': 'attempt finalized: EXITED_SUCCESS', 'source': 'observed',
               'lease_token': 'DO_NOT_EXPOSE', 'argv': ['private-secret']}
        scheduler = {'job': {'id': 'J-one', 'state': 'SUCCEEDED'}, 'allocation_history': [row],
                     'allocation_history_available': True, 'allocation_history_truncated': True,
                     'allocation_history_next_before_id': 4}
        package = D.bundle(self.root, self.spec, scheduler)
        self.assertTrue(package['historyAvailable']); self.assertTrue(package['historyTruncated'])
        self.assertEqual(package['historyNextBeforeId'], 4)
        self.assertEqual(package['allocationHistory'][0]['acquired_at'], 123.25)
        self.assertEqual(package['allocationHistory'][0]['released_at'], 156.75)
        self.assertNotIn('DO_NOT_EXPOSE', json.dumps(package)); self.assertNotIn('private-secret', json.dumps(package))
        legacy = D.bundle(self.root, self.spec, {'job': {'state': 'SUCCEEDED'},
                          'attempts': [{'started_at': 123, 'finished_at': 156}]})
        self.assertFalse(legacy['historyAvailable']); self.assertEqual(legacy['allocationHistory'], [])
        row.update(source='migrated_active', released_at=None, release_reason=None)
        self.assertIsNone(D.bundle(self.root, self.spec, scheduler)['allocationHistory'][0]['released_at'])
        for changes in ({'job_id': 'another-owner-job'}, {'acquired_at': None}, {'released_at': float('nan')},
                        {'gpu_index': True}, {'source': 'inferred'}):
            bad = {**scheduler, 'allocation_history': [{**row, **changes}]}
            self.assertFalse(D.bundle(self.root, self.spec, bad)['historyAvailable'])
            self.assertEqual(D.bundle(self.root, self.spec, bad)['allocationHistory'], [])

    def start(self):
        result = D.start_capture(self.root, self.spec, UNIT, '/some/' + UNIT, {}, ['2'], ['GPU-abc'])
        self.folder = self.root / 'diagnostics' / JID / CAPTURE
        return result

    def logs(self):
        self.start()
        path = self.folder / 'runtime/ray/session_2026-09-30/logs'; path.mkdir(parents=True)
        return path

    def bundle(self, state='RUNNING'):
        return D.bundle(self.root, self.spec, {'job': {'state': state}, 'attempts': [{'id': 'a1', 'gpu_indices': [2], 'gpu_uuids': ['GPU-abc'], 'started_at': 1, 'finished_at': 2, 'exit_code': 137, 'failure_reason': 'OOM', 'log_path': '/private/other.log', 'unit_token': 'secret'}]})

    def test_start_identity_private_runtime_and_bounded_detached_observer(self):
        out = self.start(); self.assertTrue(out['available']); self.assertEqual(out['captureId'], CAPTURE)
        self.assertEqual(Path(out['runtimePath']).stat().st_mode & 0o777, 0o700)
        text = (self.folder / 'identity.json').read_text() + (self.folder / 'report.json').read_text()
        self.assertNotIn('private-secret', text); self.assertNotIn('argv', json.loads((self.folder / 'identity.json').read_text()))
        cmd = self.run.call_args.args[0]
        for limit in ('--property=CPUQuota=10%', '--property=MemoryMax=128M', '--property=TasksMax=16', '--property=RuntimeMaxSec=2592000'): self.assertIn(limit, cmd)
        self.assertEqual(cmd[-3:], ['--observe', JID, CAPTURE]); self.assertEqual(self.run.call_args.kwargs['timeout'], 5)

    def test_start_fails_closed_if_unit_invocation_or_group_does_not_match(self):
        for fields in ({'Id': 'gpuq-other.service'}, {'InvocationID': ''}, {'ControlGroup': '/other'}):
            with self.subTest(fields=fields), patch.object(D, '_show', return_value={**self.shown, **fields}):
                with self.assertRaises(ValueError): self.start()
        self.run.assert_not_called()

    def test_launch_failure_retains_runtime_but_does_not_claim_capture(self):
        self.run.side_effect = OSError('unavailable')
        out = self.start(); self.assertFalse(out['available'])
        self.assertEqual(self.bundle()['state'], 'UNAVAILABLE')

    def test_logs_whitelist_no_session_latest_symlink_hardlink_fifo_or_outside(self):
        path = self.logs(); (path / 'worker-ok.err').write_text('Traceback (most recent call last):\nlocal failure')
        secret = self.root / 'secret'; secret.write_text('TOP_SECRET')
        (path / 'worker-symlink.err').symlink_to(secret); os.link(secret, path / 'worker-hardlink.err')
        os.mkfifo(path / 'worker-fifo.err'); (path / 'passwords.txt').write_text('TOP_SECRET')
        (path.parent.parent / 'session_latest').symlink_to(path.parent)
        other = path.parent.parent / 'session_outside'; other.symlink_to(self.root)
        logs, rejected = D.collect_logs(self.folder / 'runtime')
        self.assertEqual(len(logs), 1); self.assertIn('local failure', logs[0]['text']); self.assertGreaterEqual(rejected, 4)
        self.assertNotIn('TOP_SECRET', json.dumps(logs))

    def test_private_claim_and_parent_symlinks_fail_closed(self):
        self.start()
        for spec in ({**self.spec, 'userId': 'demo-user-2'}, {**self.spec, 'argv': ['other']}):
            with self.assertRaisesRegex(ValueError, 'identity mismatch'): D.bundle(self.root, spec, {})
        original = self.folder / 'report.json'; original.unlink(); original.symlink_to(self.root / 'secret')
        with self.assertRaises(OSError): self.bundle()

    def test_managed_runtime_override_never_scans_external_tmp(self):
        self.start(); secret = self.root / 'unrelated-tmp'; secret.mkdir(); (secret / 'worker.err').write_text('OUTSIDE')
        report = self.bundle()['captures'][0]
        self.assertFalse(report['scope']['externalTmpCaptured']); self.assertIn('overrides', report['scope']['note']); self.assertEqual(report['logs'], [])

    def test_common_credentials_and_terminal_controls_are_redacted(self):
        # Assemble the deliberately non-key fixture without committing a PEM
        # header that the public-tree secret guard correctly rejects.
        fake_pem = '-----BEGIN ' + 'PRIVATE KEY-----\nPRIVATE\n-----END PRIVATE KEY-----'
        text = D.redact('token=abc password="two words secret" Bearer ABC.DEF https://name:pwd@host/?api_key=key\n' + fake_pem + '\n\x1b[31mhello\x00')
        for secret in ('abc', 'two words secret', 'ABC.DEF', 'name:pwd', 'api_key=key', '\nPRIVATE\n', '\x1b', '\x00'): self.assertNotIn(secret, text)
        self.assertIn('hello', text)

    def test_file_count_byte_tail_and_unicode_package_limits(self):
        path = self.logs()
        for i in range(40): (path / ('worker-%02d.err' % i)).write_text('中' * 40000)
        logs, _ = D.collect_logs(self.folder / 'runtime')
        self.assertLessEqual(len(logs), D.MAX_LOGS); self.assertLessEqual(sum(len(item['text'].encode()) for item in logs), D.LOG_BUDGET)
        self.assertTrue(all(item['truncated'] for item in logs)); self.assertTrue(all(len(item['text'].encode()) <= D.FILE_LIMIT for item in logs))
        report = D._read(self.folder / 'report.json'); D._logs(report, self.folder); D._write(self.folder / 'report.json', report)
        bundle = self.bundle(); self.assertLessEqual(len(json.dumps(bundle).encode()), D.BUNDLE_LIMIT); self.assertTrue(bundle['truncated'])

    def test_escape_heavy_logs_still_fit_persistent_report_not_just_api(self):
        path = self.logs()
        for i in range(40): (path / ('worker-%02d.err' % i)).write_text('\\\n\t"' * 30000)
        report = D._read(self.folder / 'report.json'); D._logs(report, self.folder); D._write(self.folder / 'report.json', report)
        self.assertLessEqual((self.folder / 'report.json').stat().st_size, D.BUNDLE_LIMIT)
        self.assertLessEqual(len(json.dumps(self.bundle()).encode()), D.BUNDLE_LIMIT)

    def test_finished_receipt_captures_final_resources_without_false_scheduler_failure(self):
        path = self.logs(); (path / 'worker-1.err').write_text('RayActorError: example')
        D.finish_capture(self.root, self.spec, CAPTURE, 0)
        D.observe(self.root, self.spec, CAPTURE, {}, sleep=lambda _: self.fail('finished observer should not wait'))
        out = self.bundle(); capture = out['captures'][0]
        self.assertEqual(out['schedulerState'], 'RUNNING'); self.assertTrue(out['workerErrorEvidence']); self.assertEqual(out['state'], 'COMPLETE')
        self.assertEqual(capture['runnerExit']['exitCode'], 0); self.assertEqual(capture['resources']['peaks']['memory.peak'], 70)
        self.assertNotIn('unitExit', capture)
        self.assertEqual(capture['resources']['counters']['memory.events']['oom_kill'], 1); self.assertEqual(capture['resources']['counters']['pids.events']['max'], 2)
        self.assertEqual(out['attempts'][0]['gpu_uuids'], ['GPU-abc']); self.assertNotIn('log_path', out['attempts'][0]); self.assertNotIn('unit_token', out['attempts'][0])

    def test_older_runner_receipt_does_not_decrease_newer_event_counts(self):
        self.start(); D.finish_capture(self.root, self.spec, CAPTURE, 137)
        (self.group / 'memory.events').write_text('oom 2\noom_kill 2\n')
        D.observe(self.root, self.spec, CAPTURE, {})
        self.assertEqual(self.bundle()['captures'][0]['resources']['counters']['memory.events']['oom_kill'], 2)

    def test_periodic_sampling_spawns_no_process_and_missing_final_receipt_is_partial(self):
        self.start(); self.run.reset_mock()
        calls = []
        def tick(seconds):
            calls.append(seconds); (self.group / 'cgroup.events').write_text('populated 0\n')
        D.observe(self.root, self.spec, CAPTURE, {}, sleep=tick)
        self.assertEqual(calls, [2]); self.run.assert_not_called(); self.assertEqual(self.bundle()['state'], 'PARTIAL')

    def test_only_same_invocation_confirmed_terminal_unit_has_unit_exit(self):
        self.start(); (self.group / 'cgroup.events').write_text('populated 0\n')
        with patch.object(D, '_show', return_value={**self.shown, 'ActiveState': 'failed', 'MainPID': '0', 'Result': 'oom-kill', 'ExecMainStatus': '9'}): D.observe(self.root, self.spec, CAPTURE, {})
        self.assertEqual(self.bundle()['captures'][0]['unitExit']['Result'], 'oom-kill')
        report = D._read(self.folder / 'report.json'); report.pop('unitExit'); D._write(self.folder / 'report.json', report)
        with patch.object(D, '_show', return_value={**self.shown, 'InvocationID': 'c' * 32, 'ActiveState': 'failed', 'MainPID': '0'}): D.observe(self.root, self.spec, CAPTURE, {})
        self.assertNotIn('unitExit', self.bundle()['captures'][0])

    def test_replaced_cgroup_never_reads_new_job_and_stale_heartbeat_is_partial(self):
        self.start(); identity = D._read(self.folder / 'identity.json'); identity['cgroupInode'] += 1; D._write(self.folder / 'identity.json', identity)
        with self.assertRaisesRegex(ValueError, 'replaced'): D.finish_capture(self.root, self.spec, CAPTURE, 0)
        D.observe(self.root, self.spec, CAPTURE, {})
        self.assertEqual(self.bundle()['state'], 'PARTIAL')
        report = D._read(self.folder / 'report.json'); report.update(state='CAPTURING', updatedAt=time.time() - 31); D._write(self.folder / 'report.json', report)
        self.assertIn('stale', self.bundle()['captures'][0]['error'])

    def test_slots_are_bounded_and_full_slots_report_unavailable(self):
        self.start(); slots = [D._observer_slot(self.root / 'diagnostics') for _ in range(D.MAX_OBSERVERS)]
        try:
            self.assertNotIn(None, slots); self.assertIsNone(D._observer_slot(self.root / 'diagnostics'))
            D.observe(self.root, self.spec, CAPTURE, {})
            self.assertEqual(self.bundle()['state'], 'UNAVAILABLE')
        finally:
            for fd in slots: os.close(fd)

    def test_retention_never_removes_running_or_unknown_cgroup(self):
        self.start(); D.finish_capture(self.root, self.spec, CAPTURE, 0); D.observe(self.root, self.spec, CAPTURE, {})
        later = time.time() + 31 * 86400
        D.prune(self.root, later); self.assertTrue(self.folder.exists())
        (self.group / 'cgroup.events').unlink(); D.prune(self.root, later); self.assertTrue(self.folder.exists())
        (self.group / 'cgroup.events').write_text('populated 0\n')
        if shutil.rmtree.avoids_symlink_attacks:
            D.prune(self.root, later); self.assertFalse(self.folder.exists())

    def test_no_capture_is_explicit_unavailable_not_empty_success(self):
        out = self.bundle('CANCELED'); self.assertEqual(out['state'], 'UNAVAILABLE'); self.assertEqual(out['schedulerState'], 'CANCELED')

    def test_main_log_summary_exposes_bounded_redacted_worker_and_resource_evidence(self):
        path = self.logs(); (path / 'worker-test.err').write_text('RuntimeError: CUDA out of memory token=TOP_SECRET\n' + 'x' * 100)
        D.finish_capture(self.root, self.spec, CAPTURE, 137); D.observe(self.root, self.spec, CAPTURE, {})
        package = self.bundle(); before = json.dumps(package)
        text = D.summary(package)
        self.assertIn('CUDA out of memory', text); self.assertIn('OOM kill=1', text); self.assertIn('PID 拒绝=2', text)
        self.assertIn('调度状态：RUNNING', text); self.assertIn('gpuctl diagnostics ' + JID, text); self.assertNotIn('TOP_SECRET', text)
        self.assertLess(len(text), 2000); self.assertEqual(json.dumps(package), before)

    def test_orphan_is_persistently_finalized_and_only_ended_raw_runtime_is_removed(self):
        path = self.logs(); (path / 'worker-test.err').write_text('RayActorError: retained after observer crash')
        spill = self.folder / 'runtime/ray/spill'; spill.mkdir(); (spill / 'object.bin').write_bytes(b'raw object')
        report = D._read(self.folder / 'report.json'); report.update(state='CAPTURING', updatedAt=time.time() - 80 * 86400); D._write(self.folder / 'report.json', report)
        (self.group / 'cgroup.events').write_text('populated 0\n')
        D.prune(self.root)
        saved = D._read(self.folder / 'report.json')
        self.assertEqual(saved['state'], 'PARTIAL'); self.assertIn('finalizedAt', saved)
        self.assertEqual(saved['rawRuntimeCleanup'], 'removed-after-confirmed-stop'); self.assertFalse((self.folder / 'runtime').exists())
        self.assertIn('retained after observer crash', saved['logs'][0]['text']); self.assertTrue(self.bundle()['workerErrorEvidence'])

    def test_complete_success_cleans_raw_runtime_without_reclassifying_normal_shutdown(self):
        path = self.logs(); (path / 'worker-test.err').write_text('RpcError: End of file during normal shutdown')
        report = D._read(self.folder / 'report.json')
        finalized = time.time() - 60
        report.update(state='COMPLETE', finalizedAt=finalized, runnerExit={'exitCode': 0})
        report.pop('rawRuntimeCleanup', None); D._write(self.folder / 'report.json', report)
        (self.group / 'cgroup.events').write_text('populated 0\n')
        D.prune(self.root)
        saved = D._read(self.folder / 'report.json')
        self.assertEqual(saved['state'], 'COMPLETE'); self.assertEqual(saved['finalizedAt'], finalized)
        self.assertEqual(saved['runnerExit']['exitCode'], 0)
        self.assertEqual(saved['rawRuntimeCleanup'], 'removed-after-confirmed-stop')
        self.assertFalse((self.folder / 'runtime').exists()); self.assertTrue(self.folder.exists())
        self.assertIn('normal shutdown', saved['logs'][0]['text'])
        package = self.bundle('SUCCEEDED'); text = D.summary(package)
        self.assertEqual(package['state'], 'COMPLETE'); self.assertEqual(package['schedulerState'], 'SUCCEEDED')
        self.assertIn('也可能来自正常退出日志', text); self.assertIn('调度状态：SUCCEEDED', text)

    def test_orphan_active_unknown_and_live_observer_are_never_retired(self):
        self.logs(); D.prune(self.root)
        self.assertTrue((self.folder / 'runtime').exists()); self.assertEqual(D._read(self.folder / 'report.json')['state'], 'STARTING')
        (self.group / 'cgroup.events').unlink(); D.prune(self.root); D.prune(self.root)
        self.assertTrue((self.folder / 'runtime').exists())
        (self.group / 'cgroup.events').write_text('populated 0\n')
        fd = os.open(self.folder / 'observer.lock', os.O_RDWR | os.O_CREAT, 0o600); D.fcntl.flock(fd, D.fcntl.LOCK_EX)
        try:
            D.prune(self.root); D.prune(self.root); self.assertTrue((self.folder / 'runtime').exists())
        finally: os.close(fd)

    def test_gone_cgroup_cleanup_does_not_follow_nested_runtime_symlinks(self):
        self.start(); outside = self.root / 'outside'; outside.mkdir(); (outside / 'important').write_text('keep')
        (self.folder / 'runtime/escape').symlink_to(outside, target_is_directory=True)
        shutil.rmtree(self.group); D.prune(self.root)
        self.assertEqual((outside / 'important').read_text(), 'keep'); self.assertFalse((self.folder / 'runtime').exists())

    def test_cursor_visits_later_jobs_and_all_captures_instead_of_first_prefix_forever(self):
        self.start(); template = self.folder
        for number in range(4):
            job = '%08x-aaaa-aaaa-aaaa-aaaaaaaaaaaa' % number
            folder = self.root / 'diagnostics' / job; folder.mkdir(mode=0o700)
            claim = {**D._identity(self.spec), 'jobId': job}; D._write(folder / 'claim.json', claim)
            for attempt in range(3):
                capture = '%032x' % attempt; dest = folder / capture; shutil.copytree(template, dest)
                identity = D._read(dest / 'identity.json'); identity.update(jobId=job, captureId=capture); D._write(dest / 'identity.json', identity)
                report = D._read(dest / 'report.json'); report.update(jobId=job, captureId=capture); D._write(dest / 'report.json', report)
        (self.group / 'cgroup.events').write_text('populated 0\n')
        for _ in range(20): D.prune(self.root, max_jobs=2, max_captures=1)
        for path in (self.root / 'diagnostics').glob('*/*/report.json'):
            self.assertIn(D._read(path)['state'], D.FINAL); self.assertFalse((path.parent / 'runtime').exists())

    def test_cleanup_error_retains_report_and_retry_finishes_raw_removal(self):
        self.logs(); (self.group / 'cgroup.events').write_text('populated 0\n')
        original = D.shutil.rmtree
        def blocked(path, *args, **kwargs):
            if Path(path).name == 'runtime': raise PermissionError('retry')
            return original(path, *args, **kwargs)
        with patch.object(D.shutil, 'rmtree', side_effect=blocked) as remove:
            remove.avoids_symlink_attacks = True; D.prune(self.root)
        self.assertEqual(D._read(self.folder / 'report.json')['rawRuntimeCleanup'], 'pending'); self.assertTrue((self.folder / 'runtime').exists())
        D.prune(self.root); D.prune(self.root)
        self.assertFalse((self.folder / 'runtime').exists()); self.assertEqual(D._read(self.folder / 'report.json')['rawRuntimeCleanup'], 'removed-after-confirmed-stop')


class NodeDiagnostics(unittest.TestCase):
    def test_read_only_operation_never_submits_and_checks_immutable_spec(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(); root = base / 'state'; root.mkdir(mode=0o700)
            for name in ('node-executor.py', 'scheduling-policy.py', 'job-diagnostics.py'): shutil.copy2(DEPLOY / name, base / name)
            database = base / 'gpuq.db'
            with sqlite3.connect(database) as db: db.execute('CREATE TABLE jobs (id TEXT, submit_key TEXT)')
            (base / 'node-config.json').write_text(json.dumps({'root': str(root), 'database': str(database), 'gpu': '/no/gpu'}))
            loader = importlib.util.spec_from_file_location('node_diag_fixture', base / 'node-executor.py'); node = importlib.util.module_from_spec(loader); loader.loader.exec_module(node)
            job = {'id': JID, 'userId': 'demo-user-1', 'username': 'alice', 'cards': 1, 'argv': ['python'], 'name': 'fixture', 'minVramGiB': 0}
            with patch.object(node, 'gpu') as gpu:
                out = node.process('diagnostics', {'job': job}); self.assertEqual(out['schedulerState'], 'NOT_SUBMITTED'); gpu.assert_not_called()
                self.assertEqual(list(root.iterdir()), [])
                with self.assertRaises(ValueError): node.process('diagnostics', {'job': job, 'path': '/tmp'})
                (root / 'jobs').mkdir(); (root / 'jobs' / (JID + '.json')).write_text(json.dumps(job))
                with self.assertRaisesRegex(ValueError, 'identity mismatch'): node.process('diagnostics', {'job': {**job, 'userId': 'demo-user-2'}})
            with sqlite3.connect(database) as db: db.execute('INSERT INTO jobs VALUES (?,?)', ('J123', JID))
            with patch.object(node, 'gpu', return_value={'job': {'state': 'FAILED'}, 'attempts': []}) as gpu:
                out = node.process('diagnostics', {'job': job}); self.assertEqual(out['schedulerState'], 'FAILED'); gpu.assert_called_once_with('show', 'J123')
            with patch.object(node, 'gpu', return_value={'job': {'state': 'RUNNING'}, 'attempts': [{'id': 'a1'}]}) as gpu, patch.object(node, 'run', return_value='Ray started\n') as run:
                out = node.process('logs', {'job': job})
                self.assertTrue(out['text'].startswith('Ray started\n')); self.assertIn('gpuctl diagnostics ' + JID, out['text'])
                gpu.assert_called_once_with('show', 'J123'); run.assert_called_once()
            with patch.object(node, 'job_diagnostics', side_effect=OSError('private path must not leak')):
                out = node.job_log_result(job, {}, 'main log stays')
                self.assertTrue(out['text'].startswith('main log stays')); self.assertIn('诊断暂不可用', out['text']); self.assertNotIn('private path', out['text'])


if __name__ == '__main__': unittest.main()
