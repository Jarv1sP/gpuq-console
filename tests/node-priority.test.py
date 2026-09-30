"""Node priority bridge contract: temporary files, no GPU, daemon, SSH or systemd."""
from contextlib import closing
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid


DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'
CAPABILITIES = ['priority-policy-v1', 'preempt-idle-only-v1']
POLICIES = {'idle': (0, 'now'), 'normal': (2, 'never'), 'high': (4, 'never')}


class NodePriority(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        shutil.copy2(DEPLOY / 'node-executor.py', self.base / 'node-executor.py')
        shutil.copy2(DEPLOY / 'scheduling-policy.py', self.base / 'scheduling-policy.py')
        self.config = {'root': str(self.base / 'state'), 'cards': 4,
                       'gpu': '/not/a/gpu', 'database': str(self.base / 'gpuq.db')}
        (self.base / 'node-config.json').write_text(json.dumps(self.config))
        module = importlib.util.spec_from_file_location('node_priority_test', self.base / 'node-executor.py')
        self.node = importlib.util.module_from_spec(module)
        module.loader.exec_module(self.node)
        with closing(sqlite3.connect(self.config['database'])) as db:
            db.execute('CREATE TABLE jobs(id TEXT, submit_key TEXT)')
            db.commit()
        self.job = {'id': str(uuid.uuid4()), 'userId': 'demo-user-1', 'username': 'alice',
                    'cards': 1, 'argv': ['python', 'train.py'], 'name': 'priority-test',
                    'minVramGiB': 0, 'priority': 'normal', 'preemptIdleOnly': True}
        self.node_id = 'Jtestpriority'
        self.status = {'daemon': {'capabilities': list(CAPABILITIES)}}
        self.data = {'job': {'id': self.node_id, 'state': 'PENDING',
                             'state_reason': 'waiting for confirmed idle capacity',
                             'priority': 2, 'yield_policy': 'never', 'restart_policy': 'never',
                             'dispatch_mode': 'queue', 'preempt_idle_only': True}, 'attempts': []}
        self.commands = []
        self.runner = patch.object(self.node, 'run', side_effect=self.fake_run)
        self.runner.start()
        self.addCleanup(self.runner.stop)

    def policy(self):
        return {key: self.data['job'][key] for key in ('priority', 'yield_policy', 'restart_policy', 'dispatch_mode')}

    def register(self, job=None):
        job = job or self.job
        with closing(sqlite3.connect(self.config['database'])) as db:
            db.execute('INSERT INTO jobs(id, submit_key) VALUES(?,?)', (self.node_id, job['id']))
            db.commit()

    def fake_run(self, argv, **_kwargs):
        self.commands.append(list(argv))
        self.assertEqual(argv[:2], [self.config['gpu'], '--json'])
        args = argv[2:]
        if args[0] == 'status':
            return json.dumps(self.status)
        if args[0] == 'submit':
            self.data['job'].update(priority=int(args[args.index('-p') + 1][1:]),
                                    yield_policy=args[args.index('--yield') + 1],
                                    restart_policy=args[args.index('--restart-policy') + 1],
                                    dispatch_mode=args[args.index('-m') + 1],
                                    preempt_idle_only='--preempt-idle-only' in args)
            self.register()
            return json.dumps({'job_id': self.node_id})
        if args[0] == 'show':
            self.assertEqual(args[1:], [self.node_id])
            return json.dumps(self.data)
        if args[0] == 'set-priority':
            self.assertEqual(args[1], self.node_id)
            level, yielding = POLICIES[args[2]]
            self.data['job'].update(priority=level, yield_policy=yielding,
                                    restart_policy='never', dispatch_mode='queue')
            return json.dumps({'job_id': self.node_id, 'state': 'PENDING'})
        raise AssertionError('Unexpected GPUQ action: ' + repr(args))

    def call(self, operation='sync', job=None, **options):
        return self.node.process(operation, {'job': job or self.job, **options})

    def operations(self):
        return [command[2] for command in self.commands]

    def test_each_new_class_has_exact_scope_and_safe_scheduler_flags(self):
        for priority_class, (level, yielding) in POLICIES.items():
            with self.subTest(priority_class=priority_class):
                self.job = {**self.job, 'id': str(uuid.uuid4()), 'priority': priority_class}
                before = len(self.commands)
                result = self.call()
                commands = self.commands[before:]
                self.assertEqual([command[2] for command in commands], ['status', 'submit', 'show'])
                command = commands[1]
                self.assertEqual(command[:14], [self.config['gpu'], '--json', 'submit', '-g', '1',
                                               '-p', 'P' + str(level), '-m', 'queue', '--yield', yielding,
                                               '--restart-policy', 'never', '--preempt-idle-only'])
                self.assertEqual(command[command.index('--submit-key') + 1], self.job['id'])
                self.assertEqual(command[command.index('--') + 1:], ['/usr/bin/python3', str(self.base / 'sandbox-runner.py'), self.job['id']])
                self.assertEqual(result['priority'], priority_class)
                self.assertTrue(result['priorityMutable'])

    def test_legacy_spec_preserves_p0_never_and_does_not_require_capability(self):
        self.job = {key: value for key, value in self.job.items() if key not in {'priority', 'preemptIdleOnly'}}
        self.status = {}
        result = self.call()
        self.assertEqual(self.operations(), ['submit', 'show'])
        command = self.commands[0]
        self.assertEqual(command[5:13], ['-p', 'P0', '-m', 'queue', '--yield', 'never', '--restart-policy', 'never'])
        self.assertNotIn('--preempt-idle-only', command)
        self.assertFalse(result['priorityMutable'])

    def test_unknown_or_partial_capability_refuses_new_submission(self):
        for status in [{}, {'daemon': {}}, {'daemon': {'capabilities': []}},
                       {'daemon': {'capabilities': None}},
                       {'daemon': {'capabilities': 'priority-policy-v1 preempt-idle-only-v1'}},
                       {'daemon': {'capabilities': {key: True for key in CAPABILITIES}}},
                       {'daemon': {'capabilities': [CAPABILITIES[0]]}},
                       {'daemon': {'capabilities': [CAPABILITIES[1]]}}]:
            with self.subTest(status=status):
                self.commands.clear()
                self.status = status
                with self.assertRaisesRegex(ValueError, 'capability'):
                    self.call()
                self.assertEqual(self.operations(), ['status'])

    def test_new_spec_requires_both_valid_class_and_literal_true_scope(self):
        old = {key: value for key, value in self.job.items() if key not in {'priority', 'preemptIdleOnly'}}
        invalid = [{'priority': 'normal'}, {'preemptIdleOnly': True},
                   {'priority': 'normal', 'preemptIdleOnly': False},
                   {'priority': 'normal', 'preemptIdleOnly': 1},
                   {'priority': 'normal', 'preemptIdleOnly': 'true'},
                   {'priority': 'urgent', 'preemptIdleOnly': True},
                   {'priority': None, 'preemptIdleOnly': True}]
        for extra in invalid:
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'safe scheduling'):
                self.call(job={**old, **extra})
        self.assertEqual(self.commands, [])

    def test_capability_failure_does_not_acquire_dataset_or_mark_possible_dispatch(self):
        self.status = {}
        self.job = {**self.job, 'datasets': [{'dataset': 'example', 'version': 'a' * 64}]}
        with patch.object(self.node, 'acquire_datasets') as acquire:
            with self.assertRaisesRegex(ValueError, 'capability'):
                self.call()
        acquire.assert_not_called()
        marker = self.node.ROOT / 'jobs' / (self.job['id'] + '.dataset-dispatch-attempted')
        self.assertFalse(marker.exists())
        self.assertNotIn('submit', self.operations())

    def test_priority_operation_never_submits_unknown_job(self):
        with self.assertRaisesRegex(ValueError, 'not yet registered'):
            self.call('priority', priority='high', expected=self.policy())
        self.assertEqual(self.commands, [])
        with closing(sqlite3.connect(self.config['database'])) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0], 0)

    def test_pending_change_preserves_immutable_original_spec_and_exact_expected_flags(self):
        self.register()
        before = deepcopy(self.job)
        expected = self.policy()
        result = self.call('priority', priority='high', expected=expected)
        self.assertEqual(self.operations(), ['show', 'status', 'set-priority', 'show'])
        self.assertEqual(self.commands[2], [self.config['gpu'], '--json', 'set-priority', self.node_id, 'high',
                                          '--expected-priority', 'P2', '--expected-yield', 'never',
                                          '--expected-restart-policy', 'never', '--expected-mode', 'queue'])
        self.assertEqual(self.job, before)
        saved = json.loads((self.node.ROOT / 'jobs' / (self.job['id'] + '.json')).read_text())
        self.assertEqual(saved, before)
        self.assertEqual(saved['priority'], 'normal')
        self.assertEqual(result, {
            'nodeJobId': self.node_id, 'state': 'PENDING', 'assignedIndices': [],
            'schedulerState': 'PENDING', 'schedulerPriority': 4, 'priority': 'high',
            'schedulerPolicy': {'priority': 4, 'yield_policy': 'never', 'restart_policy': 'never', 'dispatch_mode': 'queue'},
            'priorityMutable': True, 'queueReason': 'waiting for confirmed idle capacity', 'preempted': False,
        })
        self.commands.clear()
        self.assertEqual(self.call()['priority'], 'high')
        self.assertEqual(self.operations(), ['show'])

    def test_resubmitted_mutated_spec_is_rejected_before_gpuq(self):
        self.register()
        self.call()
        self.commands.clear()
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.call(job={**self.job, 'priority': 'high'})
        self.assertEqual(self.commands, [])

    def test_stale_expected_policy_is_rejected_without_mutation(self):
        self.register()
        expected = {**self.policy(), 'priority': 0, 'yield_policy': 'now'}
        with self.assertRaisesRegex(ValueError, 'refresh'):
            self.call('priority', priority='high', expected=expected)
        self.assertEqual(self.operations(), ['show'])
        self.assertEqual(self.data['job']['priority'], 2)

    def test_running_and_terminal_jobs_cannot_change_priority(self):
        self.register()
        for state in ['STARTING', 'RUNNING', 'PREEMPTING', 'CANCELED', 'FAILED', 'SUCCEEDED', 'LOST']:
            with self.subTest(state=state):
                self.commands.clear()
                self.data['job']['state'] = state
                with self.assertRaisesRegex(ValueError, 'Only pending'):
                    self.call('priority', priority='idle', expected=self.policy())
                self.assertEqual(self.operations(), ['show'])

    def test_both_immutable_and_scheduler_scope_must_be_explicit_true(self):
        self.register()
        for scope in [None, False, 1, 'true']:
            with self.subTest(scope=scope):
                self.commands.clear()
                self.data['job']['preempt_idle_only'] = scope
                with self.assertRaisesRegex(ValueError, 'safe-policy'):
                    self.call('priority', priority='idle', expected=self.policy())
                self.assertEqual(self.operations(), ['show'])
        self.data['job']['preempt_idle_only'] = True
        old = {key: value for key, value in self.job.items() if key not in {'priority', 'preemptIdleOnly'}}
        # Keep the submitted immutable spec old for this independent identity.
        old['id'] = str(uuid.uuid4())
        self.register(old)
        self.commands.clear()
        with self.assertRaisesRegex(ValueError, 'safe-policy'):
            self.call('priority', job=old, priority='idle', expected=self.policy())
        self.assertEqual(self.operations(), ['show'])

    def test_priority_requires_current_capability_before_mutation(self):
        self.register()
        self.status = {'daemon': {'capabilities': ['priority-policy-v1']}}
        with self.assertRaisesRegex(ValueError, 'capability'):
            self.call('priority', priority='idle', expected=self.policy())
        self.assertEqual(self.operations(), ['show', 'status'])

    def test_scheduler_side_conflict_is_not_retried_or_resubmitted(self):
        self.register()
        original = self.fake_run
        def racing_run(argv, **kwargs):
            if argv[2] == 'set-priority':
                self.commands.append(argv)
                raise ValueError('only a PENDING job can change priority')
            return original(argv, **kwargs)
        with patch.object(self.node, 'run', side_effect=racing_run):
            with self.assertRaisesRegex(ValueError, 'PENDING'):
                self.call('priority', priority='idle', expected=self.policy())
        self.assertEqual(self.operations(), ['show', 'status', 'set-priority'])

    def test_invalid_or_partial_policy_requests_do_not_call_mutating_command(self):
        self.register()
        for options in [{'priority': 'urgent', 'expected': self.policy()},
                        {'priority': 'idle', 'expected': {}},
                        {'priority': 'idle', 'expected': None},
                        {'priority': 'idle', 'expected': {**self.policy(), 'extra': 1}}]:
            with self.subTest(options=options):
                self.commands.clear()
                with self.assertRaisesRegex(ValueError, 'Invalid expected'):
                    self.call('priority', **options)
                self.assertEqual(self.operations(), ['show'])

    def test_preempted_requires_canceled_and_latest_attempt_preempted(self):
        self.data['job']['state'] = 'CANCELED'
        self.data['attempts'] = [{'ordinal': 2, 'state': 'PREEMPTED'}, {'ordinal': 1, 'state': 'EXITED_FAILURE'}]
        self.assertTrue(self.node.scheduling_status(self.job, self.data)['preempted'])
        self.data['attempts'] = [{'ordinal': 2, 'state': 'CANCELED'}, {'ordinal': 1, 'state': 'PREEMPTED'}]
        self.assertFalse(self.node.scheduling_status(self.job, self.data)['preempted'])
        self.data['job']['state'] = 'RUNNING'
        self.data['attempts'] = [{'ordinal': 2, 'state': 'PREEMPTED'}]
        self.assertFalse(self.node.scheduling_status(self.job, self.data)['preempted'])
        self.data['job']['state'] = 'CANCELED'
        self.data['attempts'] = []
        self.assertFalse(self.node.scheduling_status(self.job, self.data)['preempted'])

    def test_preempted_label_requires_strict_new_console_scope(self):
        self.data['job']['state'] = 'CANCELED'
        self.data['attempts'] = [{'ordinal': 1, 'state': 'PREEMPTED'}]
        for scope in [False, None, 1, 'true']:
            with self.subTest(scope=scope):
                self.data['job']['preempt_idle_only'] = scope
                self.assertFalse(self.node.scheduling_status(self.job, self.data)['preempted'])
        self.data['job']['preempt_idle_only'] = True
        for scope in [False, None, 1, 'true']:
            with self.subTest(console_scope=scope):
                self.assertFalse(self.node.scheduling_status({**self.job, 'preemptIdleOnly': scope}, self.data)['preempted'])

    def test_running_assigned_gpu_indices_come_from_latest_attempt(self):
        self.register()
        self.data['job']['state'] = 'RUNNING'
        self.data['attempts'] = [{'ordinal': 2, 'state': 'RUNNING', 'gpu_indices': [3]},
                                 {'ordinal': 1, 'state': 'PREEMPTED', 'gpu_indices': [0]}]
        self.assertEqual(self.call()['assignedIndices'], [3])


if __name__ == '__main__':
    unittest.main()
