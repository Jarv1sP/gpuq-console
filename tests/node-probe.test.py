"""Read-only GPU telemetry tests with mocked fixed subprocesses, never real GPUs."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


class Probe(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        shutil.copy2(Path(__file__).resolve().parents[1] / 'deploy/node-probe.py', base / 'probe.py')
        self.gpu = base / 'gpu'
        self.gpu.touch()
        (base / 'node-config.json').write_text(json.dumps({'gpu': str(self.gpu)}))
        spec = importlib.util.spec_from_file_location('test_probe', base / 'probe.py')
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)
        self.outputs = {
            'base': '0, GPU-one, RTX Test, 24576, 2048, 75\n1, GPU-two, RTX Other, 32768, 8, 0\n',
            'sensors': 'GPU-one, 62, 217.5, 350\nGPU-two, N/A, [Not Supported], 450\n',
            'processes': 'GPU-one, 321, /secret/project/bin/python, 2000\nGPU-two, 321, /secret/project/bin/python, 4\n',
            'ps': '321 alice python\n',
            'gpuq': json.dumps({'daemon': {'health': 'ok'}, 'jobs': [{'id': 'J1', 'owner': 'old-user', 'name': 'old-task', 'argv': ['private-command']}]})
        }
        self.calls = []

    def command(self, argv, timeout=10):
        self.calls.append((argv, timeout))
        if argv[0] == str(self.gpu):
            key = 'gpuq'
        elif argv[0] == '/usr/bin/ps':
            key = 'ps'
        elif argv[1].startswith('--query-compute-apps='):
            key = 'processes'
        elif argv[1].startswith('--query-gpu=index,'):
            key = 'base'
        else:
            key = 'sensors'
        result = self.outputs[key]
        if isinstance(result, Exception):
            raise result
        return result

    def run_probe(self):
        with patch.object(self.probe, 'command', side_effect=self.command):
            return self.probe.probe()

    def test_dataset_delete_requires_actual_protocol_full_safe_helpers_and_retention(self):
        self.probe.CONFIG.update(machine='node-a',datasets={})
        self.assertEqual(self.probe.probe_dataset_delete(),0)
        root=self.probe.HERE
        (root/'node-executor.py').write_text("DATASET_DELETE_CAPABILITY='dataset-delete-v1'\n")
        helpers=('dataset-retirement.py','dataset-retirement-node.py','dataset-rebuild-proof.py','dataset-cache.py','dataset-tier.py','storage-authority.py')
        for name in helpers:(root/name).write_text('value=1\n')
        with patch.object(self.probe,'command',side_effect=AssertionError('No subprocess or deletion')):
            self.assertEqual(self.probe.probe_dataset_delete(),1)
            (root/helpers[0]).chmod(0o666)
            self.assertEqual(self.probe.probe_dataset_delete(),0)
            (root/helpers[0]).chmod(0o600)
            (root/helpers[1]).unlink();(root/helpers[1]).symlink_to(root/helpers[0])
            self.assertEqual(self.probe.probe_dataset_delete(),0)
            (root/helpers[1]).unlink();(root/helpers[1]).write_text('value=1\n')
            for value in (False,6,366,'7'):
                self.probe.CONFIG['datasets']['retireRetentionDays']=value
                self.assertEqual(self.probe.probe_dataset_delete(),0)

    def test_metrics_and_processes_are_matched_by_uuid(self):
        out = self.run_probe()
        self.assertEqual(len(out['gpus']), 2)
        first, second = out['gpus']
        self.assertEqual(first['temperatureC'], 62)
        self.assertEqual(first['powerDrawW'], 217.5)
        self.assertEqual(first['utilization'], 75)
        self.assertEqual(first['processes'], [{'pid': 321, 'name': 'python', 'owner': 'alice', 'memoryUsedMiB': 2000, 'type': 'compute'}])
        self.assertEqual(second['processes'][0]['memoryUsedMiB'], 4)
        self.assertIsNone(second['temperatureC'])
        self.assertIsNone(second['powerDrawW'])
        self.assertNotIn('/secret/project', json.dumps(out))
        self.assertNotIn('private-command', json.dumps(out))
        ps = next(argv for argv, _ in self.calls if argv[0] == '/usr/bin/ps')
        self.assertEqual(ps, ['/usr/bin/ps', '-p', '321', '-o', 'pid=,user=,comm='])
        self.assertTrue(all(timeout <= 12 for _, timeout in self.calls))

    def test_process_priority_requires_exact_attempt_cgroup_and_gpu_assignment(self):
        attempt = 'A' + 'a' * 32
        job = dict(id='J1', active_attempt_id=attempt, state='RUNNING', assigned_gpu_indices=[0], priority=2, yield_policy='never')
        self.outputs['gpuq'] = json.dumps({'daemon': {'health': 'ok'}, 'jobs': [job]})
        for unit in ('gpuq-' + attempt.lower() + '.service', 'gpuq-' + attempt + '.service'):
            with patch.object(self.probe, 'process_cgroups', return_value={unit}) as membership:
                out = self.run_probe()
            self.assertEqual(out['gpus'][0]['processes'][0]['scheduling'], {'jobId': 'J1', 'priority': 2, 'yieldPolicy': 'never'})
            self.assertNotIn('scheduling', out['gpus'][1]['processes'][0])
            membership.assert_called_once_with(321)
        for unknown in (None, set(), {'gpuq-' + attempt.lower() + '.service-evil'}, {'unrelated.service'},
                        {'gpuq-A' + 'b' * 32 + '.service'}, {'GPUQ-' + attempt + '.service'},
                        {'gpuq-' + attempt.upper() + '.service'}):
            with self.subTest(unknown=unknown), patch.object(self.probe, 'process_cgroups', return_value=unknown):
                self.assertNotIn('scheduling', self.run_probe()['gpus'][0]['processes'][0])

    def test_old_nodes_default_host_commands_false_without_running_sudo(self):
        with patch.object(self.probe, 'command') as command:
            self.assertEqual(self.probe.probe_host_command(), {'version': 1, 'available': False})
            command.assert_not_called()
        self.probe.CONFIG['hostRoot'] = True
        with patch.object(self.probe, 'helper_source', return_value=b'OLD_DISPATCHER = True'), patch.object(self.probe, 'command') as command:
            self.assertFalse(self.probe.probe_host_command()['available']); command.assert_not_called()

    def test_task_display_capability_requires_native_and_complete_node_helper(self):
        self.outputs['gpuq']=json.dumps({'daemon':{'health':'ok','capabilities':['job-display-v1']},'jobs':[]})
        def source(path,owner,**kwargs):
            if path.name=='node-executor.py':return b"TASK_DISPLAY_CAPABILITY='console-task-display-v1'"
            return b"CAPABILITY='console-task-display-v1'\ndef validate(job,metadata):pass\ndef sync(node,job,metadata,native):pass"
        with patch.object(self.probe,'helper_source',side_effect=source):self.assertIn('console-task-display-v1',self.run_probe()['gpuq']['capabilities'])
        for bad in (b'OLD=True',b"CAPABILITY='console-task-display-v1'"):
            with patch.object(self.probe,'helper_source',return_value=bad):self.assertNotIn('console-task-display-v1',self.run_probe()['gpuq']['capabilities'])
        self.outputs['gpuq']=json.dumps({'daemon':{'capabilities':None},'jobs':[]})
        self.assertTrue(self.run_probe()['gpuq']['connected']);self.assertNotIn('console-task-display-v1',self.run_probe()['gpuq']['capabilities'])
    def test_task_display_is_a_bounded_plain_text_allowlist(self):
        metadata={'name':'DUM-E｜插接训练','description':'第一行\n第二行',
                  'submitter':{'name':'张三','username':'alice'}}
        job={'id':'J1','name':'portal-raw','owner':'internal-owner','display_metadata':metadata,'argv':['PRIVATE']}
        self.outputs['gpuq']=json.dumps({'daemon':{'health':'ok'},'jobs':[job]})
        out=self.run_probe()['gpuq']['jobs'][0]
        self.assertEqual(out['display_metadata'],metadata);self.assertEqual(out['name'],'portal-raw');self.assertNotIn('argv',out)
        for broken in ({**metadata,'argv':['PRIVATE']},{**metadata,'name':'\u202eunsafe'},
                       {**metadata,'description':None},{**metadata,'name':'😀'*65},
                       {**metadata,'submitter':{**metadata['submitter'],'role':'admin'}}):
            self.outputs['gpuq']=json.dumps({'daemon':{'health':'ok'},'jobs':[{**job,'display_metadata':broken}]})
            self.assertNotIn('display_metadata',self.run_probe()['gpuq']['jobs'][0])

    def test_display_edit_requires_actual_atomic_cas_and_both_safe_helper_contracts(self):
        entry=b"TASK_DISPLAY_CAPABILITY='console-task-display-v1'\nTASK_DISPLAY_EDIT_CAPABILITY='console-task-display-edit-v1'"
        helper=b"CAPABILITY='console-task-display-v1'\nEDIT_CAPABILITY='console-task-display-edit-v1'\ndef validate(job,metadata):pass\ndef sync(node,job,metadata,native):pass\ndef edit(node,operation,args):pass"
        def source(path,owner,**kwargs):return entry if path.name=='node-executor.py' else helper
        for native in (['job-display-v1'],['job-display-v1','job-display-cas-v1']):
            self.outputs['gpuq']=json.dumps({'daemon':{'capabilities':native},'jobs':[]})
            with patch.object(self.probe,'helper_source',side_effect=source):
                capabilities=self.run_probe()['gpuq']['capabilities']
                self.assertEqual('console-task-display-edit-v1' in capabilities,'job-display-cas-v1' in native)
        helper=helper.replace(b'def edit(node,operation,args):pass',b'')
        with patch.object(self.probe,'helper_source',side_effect=source):self.assertNotIn('console-task-display-edit-v1',self.run_probe()['gpuq']['capabilities'])

    def test_host_command_requires_matching_safe_helpers_and_sudo_policy(self):
        self.probe.CONFIG['hostRoot'] = True
        def source(path, owner, **kwargs):
            return b"HOST_COMMAND_CAPABILITY='host-command-v1'" if path.name == 'node-executor.py' else b'helper-source'
        policy='Sudoers entry:\n    RunAsUsers: root\n    Options: !authenticate\n    Commands:\n        '+str(self.probe.ROOT_COMMAND_HELPER)+' ""\n'
        with patch.object(self.probe, 'helper_source', side_effect=source) as read, patch.object(self.probe, 'command', return_value=policy) as command:
            self.assertEqual(self.probe.probe_host_command(), {'version': 1, 'available': True})
            command.assert_called_once_with(['/usr/bin/sudo', '-n', '-ll'], 2)
            self.assertEqual(read.call_args_list[-1].args[1], 0); self.assertTrue(read.call_args_list[-1].kwargs['executable'])
        for unavailable in (str(self.probe.ROOT_COMMAND_HELPER), policy.replace('!authenticate','authenticate'),
                            policy.replace('RunAsUsers: root','RunAsUsers: other'), policy.replace(' ""',' *')):
            with patch.object(self.probe, 'helper_source', side_effect=source), patch.object(self.probe, 'command', return_value=unavailable):
                self.assertFalse(self.probe.probe_host_command()['available'])
        for error in (ValueError('not permitted'), subprocess.TimeoutExpired('sudo', 2), OSError('missing')):
            with patch.object(self.probe, 'helper_source', side_effect=source), patch.object(self.probe, 'command', side_effect=error):
                self.assertFalse(self.probe.probe_host_command()['available'])
        with patch.object(self.probe, 'helper_source', side_effect=[b"HOST_COMMAND_CAPABILITY='host-command-v1'", b'new', b'old']), patch.object(self.probe, 'command') as command:
            self.assertFalse(self.probe.probe_host_command()['available']); command.assert_not_called()
        with patch.object(self.probe, 'helper_source', side_effect=OSError('unsafe helper')), patch.object(self.probe, 'command') as command:
            self.assertFalse(self.probe.probe_host_command()['available']); command.assert_not_called()

    def test_sudo_verbose_listing_matches_observed_no_command_escaped_empty_args(self):
        self.probe.CONFIG['hostRoot'] = True
        helper = str(self.probe.ROOT_COMMAND_HELPER)
        # Read-only Ubuntu observation: -ll COMMAND returns just the path;
        # -ll without COMMAND includes an escaped no-argument marker.
        policy = ('Matching Defaults entries for service-user on node:\n    env_reset\n\n'
                  'User service-user may run the following commands on node:\n\n'
                  'Sudoers entry:\n    RunAsUsers: ALL\n    Options: !authenticate\n    Commands:\n        ALL\n\n'
                  'Sudoers entry:\n    RunAsUsers: root\n    Options: !authenticate\n    Commands:\n\t'
                  + helper + r' \"\"' + '\n')
        def source(path, owner, **kwargs):
            return b"HOST_COMMAND_CAPABILITY='host-command-v1'" if path.name == 'node-executor.py' else b'helper-source'
        def sudo(argv, timeout):
            self.assertEqual(timeout, 2)
            self.assertEqual(argv[:3], ['/usr/bin/sudo', '-n', '-ll'])
            return policy if len(argv) == 3 else helper + '\n'
        with patch.object(self.probe, 'helper_source', side_effect=source), patch.object(self.probe, 'command', side_effect=sudo) as call:
            self.assertEqual(self.probe.probe_host_command(), {'version': 1, 'available': True})
            call.assert_called_once_with(['/usr/bin/sudo', '-n', '-ll'], 2)

    def test_verbose_policy_never_combines_entries_or_accepts_broader_arguments(self):
        self.probe.CONFIG['hostRoot'] = True
        helper = str(self.probe.ROOT_COMMAND_HELPER)
        def source(path, owner, **kwargs):
            return b"HOST_COMMAND_CAPABILITY='host-command-v1'" if path.name == 'node-executor.py' else b'helper-source'
        def entry(command, user='root', options='!authenticate'):
            return f'Sudoers entry:\n    RunAsUsers: {user}\n    Options: {options}\n    Commands:\n        {command}\n'
        denied = [entry(value) for value in (helper, helper+' *', helper+' --status', helper+' "" extra',
                   helper+r' \"\" extra', helper+' "*"', '!'+helper+' ""', helper+'-other ""', 'ALL')]
        denied += [entry(helper+' ""', user='ALL'), entry(helper+' ""', user='root, other'),
                   entry(helper+' ""', options='authenticate'), entry(helper+' ""', options='!authenticate, authenticate'),
                   entry('/unrelated ""')+entry(helper+' ""', options='authenticate'),
                   entry('/unrelated ""')+entry(helper+' ""', user='other'),
                   entry(helper+' ""').replace('    Commands:\n', ''),
                   entry('/unrelated ""').replace('    Commands:', '        '+helper+' ""\n    Commands:')]
        for policy in denied:
            with self.subTest(policy=policy), patch.object(self.probe, 'helper_source', side_effect=source), patch.object(self.probe, 'command', return_value=policy):
                self.assertFalse(self.probe.probe_host_command()['available'])

    def test_helper_source_rejects_links_wrong_owner_permissions_and_oversize(self):
        root = Path(self.temp.name); source = root / 'helper'; source.write_bytes(b'pass\n'); source.chmod(0o700)
        self.assertEqual(self.probe.helper_source(source, os.getuid(), executable=True), b'pass\n')
        with self.assertRaises(ValueError): self.probe.helper_source(source, os.getuid() + 1)
        symlink = root / 'link'; symlink.symlink_to(source)
        with self.assertRaises(OSError): self.probe.helper_source(symlink, os.getuid())
        hardlink = root / 'hardlink'; os.link(source, hardlink)
        with self.assertRaises(ValueError): self.probe.helper_source(source, os.getuid())
        hardlink.unlink(); source.chmod(0o720)
        with self.assertRaises(ValueError): self.probe.helper_source(source, os.getuid())
        source.chmod(0o600)
        with self.assertRaises(ValueError): self.probe.helper_source(source, os.getuid(), executable=True)
        source.write_bytes(b'x' * (self.probe.MAX_HELPER_BYTES + 1))
        with self.assertRaises(ValueError): self.probe.helper_source(source, os.getuid())

    def test_host_capability_branch_remains_independent_of_gpuq_failure(self):
        self.outputs['gpuq'] = ValueError('scheduler unavailable')
        with patch.object(self.probe, 'probe_host_command', return_value={'version': 1, 'available': True}):
            out = self.run_probe()
        self.assertTrue(out['hostCommand']['available']); self.assertFalse(out['gpuq']['connected'])

    def test_old_or_missing_queue_snapshot_does_not_guess_priority_from_owner(self):
        self.outputs['gpuq'] = json.dumps({'daemon': {'health': 'ok'}, 'jobs': [dict(id='J1', owner='alice', state='RUNNING', assigned_gpu_indices=[0], priority=4)]})
        with patch.object(self.probe, 'process_cgroups', return_value={'gpuq-a' + 'a' * 32 + '.service'}):
            self.assertNotIn('scheduling', self.run_probe()['gpus'][0]['processes'][0])

    def test_unknown_metrics_do_not_erase_cards(self):
        self.outputs['base'] = '0, GPU-one, RTX Test, N/A, [Not Supported], N/A\n1, GPU-two, RTX Other, 32768, 8, 0\n'
        out = self.run_probe()
        self.assertEqual(len(out['gpus']), 2)
        for key in ('memoryTotalMiB', 'memoryUsedMiB', 'utilization'):
            self.assertIsNone(out['gpus'][0][key])

    def test_malformed_base_row_preserves_other_cards(self):
        self.outputs['base'] += 'bad-index, GPU-bad, Other, 1, 1, 1\n'
        out = self.run_probe()
        self.assertEqual(len(out['gpus']), 2)
        self.assertIn('gpuError', out)

    def test_sensor_failure_keeps_memory_and_utilization(self):
        self.outputs['sensors'] = ValueError('unsupported field')
        card = self.run_probe()['gpus'][0]
        self.assertEqual(card['memoryUsedMiB'], 2048)
        self.assertEqual(card['utilization'], 75)
        self.assertIsNone(card['temperatureC'])
        self.assertIsNone(card['powerDrawW'])
        self.assertTrue(card['processesAvailable'])

    def test_process_query_failure_keeps_all_cards_and_gpuq(self):
        self.outputs['processes'] = subprocess.TimeoutExpired('nvidia-smi', 3)
        out = self.run_probe()
        self.assertEqual(len(out['gpus']), 2)
        self.assertTrue(out['gpuq']['connected'])
        self.assertTrue(all(not g['processesAvailable'] and g['processes'] == [] and g['processesError'] for g in out['gpus']))

    def test_ps_failure_preserves_process_pid_name_and_memory(self):
        self.outputs['ps'] = ValueError('process exited')
        card = self.run_probe()['gpus'][0]
        self.assertTrue(card['processesAvailable'])
        self.assertIsNone(card['processes'][0]['owner'])
        self.assertEqual(card['processes'][0]['pid'], 321)
        self.assertEqual(card['processes'][0]['name'], 'python')
        self.assertEqual(card['processes'][0]['memoryUsedMiB'], 2000)
        self.assertIn('processesError', card)

    def test_no_processes_is_success_not_unknown_and_does_not_run_ps(self):
        self.outputs['processes'] = ''
        out = self.run_probe()
        self.assertTrue(all(g['processesAvailable'] and g['processes'] == [] for g in out['gpus']))
        self.assertFalse(any(argv[0] == '/usr/bin/ps' for argv, _ in self.calls))

    def test_malformed_process_rows_are_marked_partial(self):
        self.outputs['processes'] += 'GPU-one, not-a-pid, python, N/A\n'
        card = self.run_probe()['gpus'][0]
        self.assertFalse(card['processesAvailable'])
        self.assertEqual(len(card['processes']), 1)
        self.assertIn('processesError', card)

    def test_unknown_process_memory_stays_unknown_and_metadata_fills_missing_name(self):
        self.outputs['processes'] = 'GPU-one, 321, [N/A], [N/A]\n'
        self.outputs['ps'] = '321 alice /private/program/python\n'
        process = self.run_probe()['gpus'][0]['processes'][0]
        self.assertEqual(process['name'], 'python')
        self.assertIsNone(process['memoryUsedMiB'])

    def test_process_counts_and_metadata_request_are_bounded(self):
        self.outputs['processes'] = ''.join(f'GPU-one, {pid}, python, 1\n' for pid in range(1, 600))
        out = self.run_probe()
        card = out['gpus'][0]
        self.assertEqual(len(card['processes']), 128)
        self.assertFalse(card['processesAvailable'])
        ps = next(argv for argv, _ in self.calls if argv[0] == '/usr/bin/ps')
        self.assertEqual(len(ps[2].split(',')), 512)

    def test_gpu_query_failure_does_not_hide_gpuq_status(self):
        self.outputs['base'] = OSError('nvidia unavailable')
        out = self.run_probe()
        self.assertEqual(out['gpus'], [])
        self.assertIn('gpuError', out)
        self.assertTrue(out['gpuq']['connected'])

    def test_gpuq_failure_does_not_hide_gpu_cards(self):
        self.outputs['gpuq'] = ValueError('scheduler unavailable')
        out = self.run_probe()
        self.assertEqual(len(out['gpus']), 2)
        self.assertFalse(out['gpuq']['connected'])

    def test_malformed_gpuq_json_does_not_discard_gpu_metrics(self):
        for value in ([], None, {'daemon': None, 'jobs': []}, {'daemon': {}, 'jobs': None}):
            with self.subTest(value=value):
                self.outputs['gpuq'] = json.dumps(value)
                out = self.run_probe()
                self.assertEqual(len(out['gpus']), 2)
                self.assertFalse(out['gpuq']['connected'])

    def test_subprocess_failure_or_excess_output_is_rejected(self):
        for result in (SimpleNamespace(returncode=1, stdout='error'), SimpleNamespace(returncode=0, stdout='x' * 2_000_001)):
            with self.subTest(returncode=result.returncode), patch.object(self.probe.subprocess, 'run', return_value=result), self.assertRaisesRegex(ValueError, 'status command failed'):
                self.probe.command(['/usr/bin/nvidia-smi'], 2)


if __name__ == '__main__':
    unittest.main()
