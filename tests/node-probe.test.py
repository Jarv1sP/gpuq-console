"""Read-only GPU telemetry tests with mocked fixed subprocesses, never real GPUs."""
import importlib.util
import json
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
