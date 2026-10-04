"""Project upgrade preflight/ordering tests: synthetic files, no node services."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'

spec = importlib.util.spec_from_file_location('upgrade_projects', Path(__file__).resolve().parents[1] / 'deploy/upgrade-projects.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeProjects(unittest.TestCase):
    def setUp(self):
        from storage_test_helpers import isolated_platform_pin
        isolated_platform_pin(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base/'home'
        self.units = self.home/'.config/systemd/user'
        self.units.mkdir(parents=True,mode=0o700)
        self.home_patch = patch.object(upgrade.Path,'home',return_value=self.home)
        self.home_patch.start();self.addCleanup(self.home_patch.stop)
        self.timer = patch.object(upgrade,'timer_preflight')
        self.timer_mock = self.timer.start();self.addCleanup(self.timer.stop)
        self.dest, self.source = self.base / 'node', self.base / 'source'
        self.root, self.conda = self.base / 'workspaces', self.base / 'conda'
        for directory in (self.dest, self.source, self.root, self.conda):
            directory.mkdir(mode=0o700)
        self.config = self.dest / 'node-config.json'
        self.config.write_text(json.dumps({'root': str(self.root), 'conda': str(self.conda),
                                         'gpu': '/operator/approved/bin/gpu', 'database': str(self.base / 'gpuq.db'),
                                         'hostRoot': True, 'futureSetting': {'keep': 'unchanged'}}, indent=3) + '\n\n')
        self.config.chmod(0o600)
        (self.source/'node-runtime.json').write_bytes((DEPLOY/'node-runtime.json').read_bytes())
        self.old, self.new = {}, {}
        for name, source_name in upgrade.file_plan('common-p0'):
            self.new[name] = ('# new ' + name + '\nVALUE = 2\n').encode()
            if name == 'sandbox-runner.py':
                self.new[name] = (DEPLOY/source_name).read_bytes()
            (self.source / source_name).write_bytes(self.new[name])
            if name == 'sandbox-runner.py':
                self.old[name] = b'# Existing common P0 runner\n'+self.new[name]
                (self.dest / name).write_bytes(self.old[name])
                (self.dest / name).chmod(0o700)
        for name in ('sandbox-runner.py','job-resources.py','gpuq-ray','cpu-delegation.py'):
            (self.source/name).write_bytes((DEPLOY/name).read_bytes())
            if name=='job-resources.py':self.new[name]=(DEPLOY/name).read_bytes()
        for name in upgrade.P0_HELPERS:
            (self.dest/name).write_bytes((DEPLOY/name).read_bytes());(self.dest/name).chmod(0o700)
            (self.source/name).write_bytes((DEPLOY/name).read_bytes());self.new[name]=(DEPLOY/name).read_bytes();self.old[name]=self.new[name]
        for name in ('gpuq-diagnostics-gc.service','gpuq-diagnostics-gc.timer'):
            content = (DEPLOY/name).read_text().replace('%h/.local/libexec/gpuq-console',str(self.dest))
            (self.units/name).write_text(content)
        self.sentinel_paths = [self.base / 'gpuq.db',
                               self.root / 'users/existing/data', self.root / 'jobs/existing.json']
        for path in self.sentinel_paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'Existing opaque state: must not change\n')
        self.sentinel_paths += [self.dest/name for name in upgrade.P0_HELPERS]
        self.sentinel_paths += list(self.units.iterdir())

    def run_main(self, apply=False, directory=None, source=None, profile='common-p0'):
        arguments = ['--directory', str(directory or self.dest), '--source', str(source or self.source)]
        if profile is not None: arguments += ['--runtime-profile',profile]
        if apply:
            arguments.append('--apply')
        with contextlib.redirect_stdout(io.StringIO()) as output:
            upgrade.main(arguments)
        return json.loads(output.getvalue())

    def snapshot(self, directory=None):
        directory = directory or self.dest
        return {str(path.relative_to(directory)): (path.read_bytes(), path.stat().st_ino, stat.S_IMODE(path.stat().st_mode))
                for path in directory.rglob('*') if path.is_file() and not path.is_symlink()}

    def test_preview_is_default_and_writes_nothing(self):
        before = self.snapshot()
        result = self.run_main()
        self.assertTrue(result['dryRun'])
        self.assertTrue(result['configurationUnchanged'])
        self.assertTrue(result['schedulerUnchanged'])
        self.assertFalse(result['restartRequired'])
        self.assertEqual(before, self.snapshot())
        self.assertEqual(len(list(self.dest.glob('before-projects-*'))), 0)

    def test_config_bytes_inode_mode_and_all_existing_state_unchanged(self):
        before = (self.config.read_bytes(), self.config.stat().st_ino, self.config.stat().st_mode)
        sentinels = {path: (path.read_bytes(), path.stat().st_ino) for path in self.sentinel_paths}
        result = self.run_main(apply=True)
        self.assertEqual(before, (self.config.read_bytes(), self.config.stat().st_ino, self.config.stat().st_mode))
        self.assertEqual(sentinels, {path: (path.read_bytes(), path.stat().st_ino) for path in self.sentinel_paths})
        self.assertTrue(result['upgraded'])
        for name in upgrade.FILES:
            self.assertEqual((self.dest / name).read_bytes(), self.new[name])
            self.assertEqual(stat.S_IMODE((self.dest / name).stat().st_mode), 0o700)

    def test_backup_is_complete_private_and_contains_original_config_bytes(self):
        original = self.config.read_bytes()
        result = self.run_main(apply=True)
        backup = Path(result['backup'])
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o700)
        self.assertEqual(set(path.name for path in backup.iterdir()), {*self.old, 'node-config.json'})
        self.assertEqual((backup / 'node-config.json').read_bytes(), original)
        self.assertEqual(stat.S_IMODE((backup / 'node-config.json').stat().st_mode), 0o600)
        for name, value in self.old.items():
            self.assertEqual((backup / name).read_bytes(), value)
            self.assertEqual(stat.S_IMODE((backup / name).stat().st_mode), 0o700)
        self.assertEqual(list(self.dest.rglob('.project-upgrade-*')), [])

    def test_dependencies_are_durable_before_runner_and_dispatcher_activation(self):
        installed = []
        actual = upgrade.atomic_copy
        dispatcher = (self.dest/'node-executor.py').read_bytes()
        def inspect(source, destination, **kwargs):
            if destination.parent == self.dest:
                if destination.name == 'sandbox-runner.py':
                    self.assertEqual(installed, [name for name in upgrade.node_runtime.manifest()['dependencies'] if name not in upgrade.P0_HELPERS])
                    for name in installed:
                        self.assertEqual((self.dest / name).read_bytes(), self.new[name])
                if destination.name == 'project-ops.py':
                    self.assertEqual(installed, [*[name for name in upgrade.node_runtime.manifest()['dependencies'] if name not in upgrade.P0_HELPERS],'sandbox-runner.py'])
                installed.append(destination.name)
            return actual(source, destination, **kwargs)
        with patch.object(upgrade, 'atomic_copy', side_effect=inspect):
            self.run_main(apply=True)
        self.assertEqual(installed, [name for name in upgrade.FILES if name not in upgrade.P0_HELPERS])
        self.assertEqual((self.dest/'node-executor.py').read_bytes(),dispatcher)

    def test_compile_failure_in_last_file_prevents_every_change_and_backup(self):
        (self.source / 'project-ops.py').write_text('def syntax error!\n')
        before = self.snapshot()
        with self.assertRaises(SyntaxError):
            self.run_main(apply=True)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(list(self.dest.glob('before-projects-*')), [])

    def test_preflight_never_executes_source_or_restarts_services(self):
        sentinel = self.base / 'must-not-exist'
        (self.source / 'project-store.py').write_text('open(' + repr(str(sentinel)) + ',"w").write("bad")\nraise RuntimeError("must not import")\n')
        with patch.object(os, 'system', side_effect=AssertionError('must not launch commands')), patch('subprocess.run', side_effect=AssertionError('must not restart services')), patch('subprocess.Popen', side_effect=AssertionError('must not restart services')):
            result = self.run_main(apply=True)
        self.assertFalse(sentinel.exists())
        self.assertTrue(result['schedulerUnchanged'])

    def test_installed_bytes_are_same_pinned_bytes_that_were_compiled(self):
        actual = upgrade.atomic_copy
        changed = False
        def mutate_after_compile(source, destination, **kwargs):
            nonlocal changed
            if not changed:
                changed = True
                for _,name in upgrade.file_plan('common-p0'):
                    (self.source / name).write_text('uncompiled invalid syntax !!!')
            return actual(source, destination, **kwargs)
        with patch.object(upgrade, 'atomic_copy', side_effect=mutate_after_compile):
            self.run_main(apply=True)
        for name in upgrade.FILES:
            self.assertEqual((self.dest / name).read_bytes(), self.new[name])

    def test_source_symlink_and_source_parent_symlink_rejected(self):
        source = self.source / 'project-store.py'
        source.unlink()
        source.symlink_to(self.source / 'project-ops.py')
        with self.assertRaises(OSError):
            self.run_main(apply=True)
        source.unlink()
        source.write_bytes(self.new['project-store.py'])
        alias = self.base / 'source-alias'
        alias.symlink_to(self.source)
        with self.assertRaises(OSError):
            self.run_main(apply=True, source=alias)

    def test_destination_symlink_and_ancestor_symlink_rejected(self):
        alias = self.base / 'node-alias'
        alias.symlink_to(self.dest)
        with self.assertRaises(OSError):
            self.run_main(apply=True, directory=alias)
        parent_alias = self.base / 'parent-alias'
        parent_alias.symlink_to(self.base)
        with self.assertRaises(OSError):
            self.run_main(apply=True, directory=parent_alias / 'node')

    def test_config_and_existing_dangling_symlinks_are_never_overwritten(self):
        config_data = self.config.read_bytes()
        target = self.base / 'real-config'
        target.write_bytes(config_data)
        target.chmod(0o600)
        self.config.unlink()
        self.config.symlink_to(target)
        with self.assertRaises(OSError):
            self.run_main(apply=True)
        self.config.unlink()
        self.config.write_bytes(config_data)
        self.config.chmod(0o600)
        (self.dest / 'project-store.py').symlink_to(self.base / 'missing')
        with self.assertRaises(OSError):
            self.run_main(apply=True)
        self.assertTrue((self.dest / 'project-store.py').is_symlink())

    def test_hardlinked_source_config_or_existing_program_rejected(self):
        for path in (self.source / 'project-store.py', self.config, self.dest / 'node-executor.py'):
            link = self.base / 'hardlink'
            with self.subTest(path=path.name):
                os.link(path, link)
                with self.assertRaisesRegex(SystemExit, 'Unsafe'):
                    self.run_main(apply=True)
                link.unlink()

    def test_writable_source_existing_program_and_nonprivate_config_rejected(self):
        cases = [(self.source / 'project-store.py', 0o664), (self.dest / 'node-executor.py', 0o775), (self.config, 0o644)]
        for path, mode in cases:
            before = stat.S_IMODE(path.stat().st_mode)
            path.chmod(mode)
            with self.subTest(path=path.name), self.assertRaisesRegex(SystemExit, 'Unsafe'):
                self.run_main(apply=True)
            path.chmod(before)

    def test_source_or_node_directory_group_write_rejected(self):
        for path, mode in ((self.source, 0o775), (self.dest, 0o750)):
            path.chmod(mode)
            with self.subTest(path=path.name), self.assertRaisesRegex(SystemExit, 'Unsafe directory'):
                self.run_main(apply=True)
            path.chmod(0o700)

    def test_foreign_file_owner_rejected(self):
        real = os.fstat
        def wrong_owner(fd):
            info = real(fd)
            if stat.S_ISREG(info.st_mode):
                fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
                values = {name: getattr(info, name) for name in fields}
                values['st_uid'] = os.getuid() + 1
                return SimpleNamespace(**values)
            return info
        with patch.object(upgrade.os, 'fstat', side_effect=wrong_owner), self.assertRaisesRegex(SystemExit, 'Unsafe'):
            self.run_main(apply=True)

    def test_root_invocation_rejected_before_writes(self):
        before = self.snapshot()
        with patch.object(upgrade.os, 'getuid', return_value=0), self.assertRaisesRegex(SystemExit, 'not root'):
            self.run_main(apply=True)
        self.assertEqual(before, self.snapshot())

    def test_relative_traversal_root_and_missing_conda_rejected(self):
        for value in ('relative', '/', str(self.base / '..' / 'unwanted'), str(self.base / 'missing')):
            config = json.loads(self.config.read_bytes())
            config['conda'] = value
            self.config.write_text(json.dumps(config))
            with self.subTest(value=value), self.assertRaises((SystemExit, OSError)):
                self.run_main(apply=True)

    def test_missing_required_config_field_and_invalid_config_type_rejected(self):
        for config in ({'root': str(self.root)}, [], None):
            self.config.write_text(json.dumps(config))
            with self.subTest(config=config), self.assertRaisesRegex(SystemExit, 'Upgrade the execution'):
                self.run_main(apply=True)

    def test_config_concurrent_change_is_preserved_and_stops_before_install(self):
        actual = upgrade.atomic_copy
        external_bytes = self.config.read_bytes() + b'\n'
        def mutate(source, destination, **kwargs):
            result = actual(source, destination, **kwargs)
            if destination.parent != self.dest and destination.name == 'node-config.json':
                self.config.write_bytes(external_bytes)
            return result
        with patch.object(upgrade, 'atomic_copy', side_effect=mutate), self.assertRaisesRegex(SystemExit, 'changed while backing up'):
            self.run_main(apply=True)
        self.assertEqual(self.config.read_bytes(), external_bytes)
        for name, content in self.old.items():
            self.assertEqual((self.dest / name).read_bytes(), content)
        self.assertFalse((self.dest / 'project-store.py').exists())

    def test_install_failure_retains_backup_and_never_claims_success(self):
        actual = upgrade.atomic_copy
        def fail_install(source, destination, **kwargs):
            if destination.parent == self.dest and destination.name == 'sandbox-runner.py':
                raise OSError('synthetic disk failure')
            return actual(source, destination, **kwargs)
        with patch.object(upgrade, 'atomic_copy', side_effect=fail_install), self.assertRaisesRegex(SystemExit, 'did not finish.*no service was restarted'):
            self.run_main(apply=True)
        self.assertEqual(len(list(self.dest.glob('before-projects-*'))), 1)
        self.assertEqual((self.dest / 'node-executor.py').read_bytes(), (DEPLOY/'node-executor.py').read_bytes())
        self.assertEqual((self.dest / 'sandbox-runner.py').read_bytes(), self.old['sandbox-runner.py'])

    def test_oversized_source_rejected_before_any_backup(self):
        with patch.object(upgrade, 'MAX_FILE_BYTES', 32), self.assertRaisesRegex(SystemExit, 'oversized'):
            self.run_main(apply=True)
        self.assertEqual(list(self.dest.glob('before-projects-*')), [])

    def test_runtime_profile_is_required_and_configuration_authority_is_not_exposed(self):
        before = self.snapshot()
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.run_main(apply=True,profile=None)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            upgrade.main(['--directory',str(self.dest),'--runtime-profile','ray-p0','--configure-cpu-delegation'])
        self.assertEqual(before,self.snapshot())

    def test_common_plan_has_complete_dependencies_without_cpu_probe_or_ray_install(self):
        with patch.object(upgrade,'cpu_preflight',side_effect=AssertionError('common must not probe CPU')):
            result = self.run_main(apply=True)
        self.assertEqual(result['runtimeProfile'],'common-p0')
        self.assertFalse(result['dispatcherUnchanged'])
        self.assertTrue(result['p0PrerequisitesVerified'])
        self.assertIsNone(result['kernelEnforcement'])
        self.assertTrue((self.dest/'gpuq-network').exists())
        # Shared budget helpers support optional OCI; this does not enable Ray
        # or run its CPU preflight in the common profile.
        self.assertTrue((self.dest/'job-resources.py').exists())
        self.assertFalse((self.dest/'gpuq-ray').exists())
        self.assertEqual(upgrade.runner_profile((self.dest/'sandbox-runner.py').read_bytes()),'common-p0')

    def test_real_source_common_bundle_is_self_contained_without_replacing_p0_helpers(self):
        for name, source_name in upgrade.file_plan('common-p0'):
            self.new[name] = (DEPLOY/source_name).read_bytes()
            (self.source/source_name).write_bytes(self.new[name])
        before = {path:path.read_bytes() for path in self.sentinel_paths}
        self.run_main(apply=True)
        self.assertEqual(before,{path:path.read_bytes() for path in self.sentinel_paths})
        for name,_ in upgrade.file_plan('common-p0'):
            self.assertEqual((self.dest/name).read_bytes(),self.new[name])

    def test_ray_plan_probes_before_backup_and_installs_resource_helpers_before_runner(self):
        proof = {'cpuMax':'100000 100000','memoryMax':134217728,'pidsMax':32}
        order = []
        actual = upgrade.atomic_copy
        def probe(payload):
            self.assertEqual(payload,(DEPLOY/'cpu-delegation.py').read_bytes())
            self.assertEqual(list(self.dest.glob('before-projects-*')),[])
            order.append('checked')
            return proof
        def install(payload,destination,**kwargs):
            self.assertEqual(order[0],'checked')
            if destination.parent == self.dest:
                if destination.name == 'sandbox-runner.py':
                    for name in upgrade.RAY_FILES:self.assertEqual((self.dest/name).read_bytes(),(DEPLOY/name).read_bytes())
                order.append(destination.name)
            return actual(payload,destination,**kwargs)
        with patch.object(upgrade,'cpu_preflight',side_effect=probe),patch.object(upgrade,'atomic_copy',side_effect=install):
            result = self.run_main(apply=True,profile='ray-p0')
        self.assertEqual(result['kernelEnforcement'],proof)
        self.assertEqual(result['files'],[name for name,_ in upgrade.file_plan('ray-p0')])
        self.assertEqual(upgrade.runner_profile((self.dest/'sandbox-runner.py').read_bytes()),'ray-p0')

    def test_ray_probe_failure_rejects_before_any_write_or_backup(self):
        for error in (subprocess.CalledProcessError(1,['check']),subprocess.TimeoutExpired(['check'],30),ValueError('kernel mismatch')):
            before = self.snapshot()
            with self.subTest(error=type(error).__name__),patch.object(upgrade,'cpu_preflight',side_effect=error),self.assertRaisesRegex(SystemExit,'before any write'):
                self.run_main(apply=True,profile='ray-p0')
            self.assertEqual(before,self.snapshot())
            self.assertEqual(list(self.dest.glob('before-projects-*')),[])

    def test_installed_ray_profile_cannot_be_downgraded_through_project_upgrade(self):
        (self.dest/'sandbox-runner.py').write_bytes((DEPLOY/'sandbox-runner.py').read_bytes())
        before = self.snapshot()
        with self.assertRaisesRegex(SystemExit,'cannot downgrade'):
            self.run_main(apply=True,profile='common-p0')
        self.assertEqual(before,self.snapshot())

    def test_missing_p0_helper_or_gc_unit_is_rejected_with_install_node_direction(self):
        for path in [*(self.dest/name for name in upgrade.P0_HELPERS),self.dest/'sandbox-runner.py',*(self.units/name for name in ('gpuq-diagnostics-gc.service','gpuq-diagnostics-gc.timer'))]:
            payload = path.read_bytes();mode = stat.S_IMODE(path.stat().st_mode);path.unlink()
            before = self.snapshot()
            with self.subTest(file=path.name),self.assertRaisesRegex(SystemExit,'install-node.py'):
                self.run_main(apply=True)
            self.assertEqual(before,self.snapshot())
            path.write_bytes(payload);path.chmod(mode)

    def test_legacy_terminal_or_diagnostic_contract_rejected_without_executing_helpers(self):
        cases = [('node-executor.py',b"def terminal_op(a,b): pass\n"),
                 ('terminal-helper.py',b"FIELDS=['data','offset']\n"),
                 ('job-diagnostics.py',b"def bundle(a,b,c): return {}\n")]
        for name,payload in cases:
            path = self.dest/name;original = path.read_bytes();path.write_bytes(payload)
            before = self.snapshot()
            with self.subTest(file=name),self.assertRaisesRegex(SystemExit,'install-node.py'):
                self.run_main(apply=True)
            self.assertEqual(before,self.snapshot());path.write_bytes(original)

    def test_compatible_helper_contract_accepts_extra_optional_parameters_and_revision(self):
        path = self.dest/'job-diagnostics.py'
        content = path.read_text().replace('def summary(package):','def summary(package, future_option=None):')
        path.write_text('# Local compatible future revision\n'+content)
        self.assertTrue(self.run_main()['p0PrerequisitesVerified'])
        content = content.replace('def summary(package, future_option=None):','def summary(package, *, mandatory):')
        path.write_text(content)
        with self.assertRaisesRegex(SystemExit,'install-node.py'):
            self.run_main()

    def test_gc_timer_must_be_installed_enabled_and_active_for_same_directory(self):
        self.timer_mock.side_effect = subprocess.CalledProcessError(1,['systemctl','is-active'])
        before = self.snapshot()
        with self.assertRaisesRegex(SystemExit,'install-node.py'):
            self.run_main(apply=True)
        self.assertEqual(before,self.snapshot());self.timer_mock.side_effect = None
        path = self.units/'gpuq-diagnostics-gc.service'
        path.write_text(path.read_text().replace(str(self.dest),'/wrong/program/directory'))
        with self.assertRaisesRegex(SystemExit,'install-node.py'):
            self.run_main(apply=True)

    def test_timer_checks_only_read_state_and_never_enable_or_restart(self):
        self.timer.stop()
        with patch.object(upgrade.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as run:
            upgrade.timer_preflight()
        self.assertEqual([call.args[0][2] for call in run.call_args_list],['is-enabled','is-active'])
        for call in run.call_args_list:self.assertEqual(call.kwargs['timeout'],5)
        self.timer_mock = self.timer.start()

    def test_cpu_check_uses_pinned_bytes_check_only_bounded_and_validates_kernel_proof(self):
        payload = (DEPLOY/'cpu-delegation.py').read_bytes()
        proof = {'cpuMax':'100000 100000','memoryMax':134217728,'pidsMax':32}
        with patch.object(upgrade.subprocess,'run',return_value=SimpleNamespace(stdout=json.dumps(proof))) as run:
            self.assertEqual(upgrade.cpu_preflight(payload),proof)
        self.assertEqual(run.call_args.args[0],['/usr/bin/python3','-c',payload.decode(),'--check'])
        self.assertEqual(run.call_args.kwargs['timeout'],30)
        for invalid in ({**proof,'cpuMax':'max 100000'},{**proof,'cpuMax':'200000 100000'},{**proof,'memoryMax':0},{**proof,'pidsMax':2048},{**proof,'memoryMax':True},{**proof,'cpuMax':[]},[]):
            with patch.object(upgrade.subprocess,'run',return_value=SimpleNamespace(stdout=json.dumps(invalid))),self.assertRaises(ValueError):
                upgrade.cpu_preflight(payload)

    def test_changed_p0_prerequisite_during_backup_is_preserved_and_stops_install(self):
        actual = upgrade.atomic_copy
        path = self.dest/'node-executor.py';changed = path.read_bytes()+b'\n# external maintenance\n'
        def mutate(payload,destination,**kwargs):
            result = actual(payload,destination,**kwargs)
            if destination.parent != self.dest and destination.name == 'node-config.json':path.write_bytes(changed)
            return result
        with patch.object(upgrade,'atomic_copy',side_effect=mutate),self.assertRaisesRegex(SystemExit,'changed while backing up'):
            self.run_main(apply=True)
        self.assertEqual(path.read_bytes(),changed)
        self.assertFalse((self.dest/'gpuq-network').exists())
        self.assertEqual((self.dest/'sandbox-runner.py').read_bytes(),self.old['sandbox-runner.py'])

    def test_mismatched_source_runner_and_missing_ray_dependencies_reject_before_write(self):
        path = self.source/'sandbox-runner-common-p0.py';original = path.read_bytes()
        path.write_bytes((DEPLOY/'sandbox-runner.py').read_bytes())
        with self.assertRaisesRegex(SystemExit,'does not match'):
            self.run_main(apply=True)
        path.write_bytes(original)
        for name in ('job-resources.py','gpuq-ray','cpu-delegation.py'):
            path = self.source/name;payload = path.read_bytes();path.unlink()
            with self.subTest(file=name),patch.object(upgrade,'cpu_preflight',side_effect=AssertionError('must validate all files first')),self.assertRaises(FileNotFoundError):
                self.run_main(apply=True,profile='ray-p0')
            self.assertEqual(list(self.dest.glob('before-projects-*')),[]);path.write_bytes(payload)


if __name__ == '__main__':
    unittest.main()
