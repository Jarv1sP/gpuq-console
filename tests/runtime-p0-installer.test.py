"""Candidate-only installer boundary: AST slices and mocks, never an install."""
import argparse
import ast
import io
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'deploy/install-node.py').read_text()
TREE = ast.parse(SOURCE)
START = next(i for i, node in enumerate(TREE.body)
             if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'delegation' for t in node.targets))
PREFLIGHT = compile(ast.Module(body=TREE.body[START:START + 2], type_ignores=[]), '<installer preflight>', 'exec')


class InstallerBoundary(unittest.TestCase):
    def run_preflight(self, configure=False, effects=None, profile='ray-p0'):
        run = Mock(side_effect=effects, return_value='{}')
        namespace = {'source': ROOT, 'a': SimpleNamespace(configure_cpu_delegation=configure, runtime_profile=profile),
                     'os': SimpleNamespace(getuid=lambda: 1234), 'subprocess': subprocess, 'run': run}
        return run, namespace

    def test_configuration_flag_is_explicit_and_defaults_off(self):
        parser_nodes = TREE.body[3:]
        parser_nodes = parser_nodes[:next(i for i, node in enumerate(parser_nodes)
                                         if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'a' for t in node.targets)) + 1]
        parser = compile(ast.Module(body=parser_nodes, type_ignores=[]), '<installer flags>', 'exec')
        base = ['install-node.py', '--inventory', 'unused', '--node', 'gpu-1', '--collector-key', 'unused', '--executor-key', 'unused']
        for explicit in (False, True):
            namespace = {'argparse': argparse}
            with patch.object(sys, 'argv', base + (['--configure-cpu-delegation'] if explicit else [])):
                exec(parser, namespace)
            self.assertIs(namespace['a'].configure_cpu_delegation, explicit)

    def test_default_runs_only_unprivileged_check_before_mutations(self):
        run, namespace = self.run_preflight()
        exec(PREFLIGHT, namespace)
        run.assert_called_once_with('/usr/bin/python3', str(ROOT / 'deploy/cpu-delegation.py'), '--check')
        self.assertLess(SOURCE.index("str(delegation),'--check'"), SOURCE.index('os.umask'))
        self.assertLess(SOURCE.index("str(delegation),'--check'"), SOURCE.index('shutil.copy2'))

    def test_common_profile_has_no_new_cpu_check_or_configuration(self):
        run, namespace = self.run_preflight(profile='common-p0')
        exec(PREFLIGHT, namespace)
        run.assert_not_called()
        self.assertIn("default='common-p0'", SOURCE)

    def test_profile_selects_runner_without_node_config_change(self):
        start = next(i for i, node in enumerate(TREE.body) if isinstance(node, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == 'runner_source' for t in node.targets))
        code = compile(ast.Module(body=TREE.body[start:start + 4], type_ignores=[]), '<runner selection>', 'exec')
        for profile, expected in [('common-p0', 'sandbox-runner-common-p0.py'), ('ray-p0', 'sandbox-runner.py')]:
            copy = Mock(); destination = Mock(); destination.__truediv__ = Mock(return_value=Mock())
            namespace = {'source': ROOT, 'dest': destination, 'a': SimpleNamespace(runtime_profile=profile),
                         'shutil': SimpleNamespace(copy2=copy)}
            exec(code, namespace)
            self.assertEqual(copy.call_args_list[0].args[0], ROOT / 'deploy' / expected)
            self.assertEqual(len(copy.call_args_list), 3 if profile == 'ray-p0' else 1)

    def test_explicit_configuration_targets_current_uid_then_checks_live_limits(self):
        run, namespace = self.run_preflight(configure=True)
        with patch('sys.stdout', io.StringIO()): exec(PREFLIGHT, namespace)
        self.assertEqual([call.args for call in run.call_args_list], [
            ('sudo', '/usr/bin/python3', str(ROOT / 'deploy/cpu-delegation.py'), '--configure', '1234'),
            ('/usr/bin/python3', str(ROOT / 'deploy/cpu-delegation.py'), '--check')])

    def test_failed_live_probe_aborts_without_followup_or_state_changes(self):
        run, namespace = self.run_preflight(effects=subprocess.CalledProcessError(1, 'fixture', stderr='cpu.max missing'))
        with self.assertRaisesRegex(SystemExit, 'existing runner and scheduler are unchanged') as error:
            exec(PREFLIGHT, namespace)
        self.assertIn('cpu.max missing', str(error.exception)); self.assertEqual(run.call_count, 1)

    def test_failed_explicit_setup_does_not_proceed_to_check_or_install(self):
        run, namespace = self.run_preflight(configure=True, effects=subprocess.CalledProcessError(1, 'fixture'))
        with self.assertRaises(subprocess.CalledProcessError): exec(PREFLIGHT, namespace)
        self.assertEqual(run.call_count, 1)

    def test_preserves_profiles_and_root_grants_stay_explicit_and_scoped(self):
        self.assertIn("'gpuq-diagnostics-gc.service','gpuq-diagnostics-gc.timer'", SOURCE)
        self.assertIn("run('systemctl','--user','enable','--now','gpuq-diagnostics-gc.timer')", SOURCE)
        self.assertIn("'job-resources.py','gpuq-ray'", SOURCE)
        for forbidden in ('environmentMode', "'daemon-reexec'", "'restart'"):
            self.assertNotIn(forbidden, SOURCE)
        root_gate = next(node for node in TREE.body if isinstance(node, ast.If)
                         and isinstance(node.test, ast.Attribute) and node.test.attr == 'enable_host_root')
        grants = [node.value for node in ast.walk(TREE) if isinstance(node, ast.Constant)
                  and isinstance(node.value, str) and 'NOPASSWD:' in node.value]
        gated_grants = [node.value for node in ast.walk(root_gate) if isinstance(node, ast.Constant)
                        and isinstance(node.value, str) and 'NOPASSWD:' in node.value]
        self.assertEqual(grants, gated_grants)
        self.assertCountEqual(grants, [' ALL=(root) NOPASSWD: /usr/local/libexec/gpuq-console-root-shell\n',
                                 ' ALL=(root) NOPASSWD: /usr/local/libexec/gpuq-console-admin-command ""\n'])


if __name__ == '__main__': unittest.main()
