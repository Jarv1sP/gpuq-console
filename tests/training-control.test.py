"""Training IPC: temporary DB/files and an optional real CPU-only namespace."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
import zipfile
from contextlib import closing

ROOT = Path(__file__).resolve().parents[1]
module = importlib.util.spec_from_file_location('training_control_test', ROOT / 'deploy/training-control.py')
C = importlib.util.module_from_spec(module); module.loader.exec_module(C)
sys.path.insert(0, str(ROOT / 'gpuq'))
from gpuq.constants import SCHEMA_VERSION, CHECKPOINT_EXIT_CODE


class TrainingControl(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / 'code'; self.workspace.mkdir()
        self.output = self.root / 'output'; self.output.mkdir()
        self.spec = {'id': str(uuid.uuid4())}
        self.job = 'Jabcdef012345'; self.attempt = 'A' + uuid.uuid4().hex
        self.control = self.root / 'control' / self.attempt; self.control.mkdir(parents=True)
        self.archive = self.root / 'sdk.pyz'
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for path in (ROOT / 'gpuq').rglob('*.py'):
                archive.write(path, str(path.relative_to(ROOT / 'gpuq')))
        self.config = {'controlRoot': str(self.control.parent), 'database': str(self.root / 'state.db'), 'gpuqArchive': str(self.archive)}
        with closing(sqlite3.connect(self.config['database'])) as db:
            db.execute('CREATE TABLE jobs(id TEXT, submit_key TEXT)')
            db.execute('CREATE TABLE attempts(id TEXT, job_id TEXT, control_dir TEXT)')
            db.execute('INSERT INTO jobs VALUES (?,?)', (self.job, self.spec['id']))
            db.execute('INSERT INTO attempts VALUES (?,?,?)', (self.attempt, self.job, str(self.control)))
            db.commit()
        self.env = {'GPUQ_JOB_ID': self.job, 'GPUQ_ATTEMPT_ID': self.attempt, 'GPUQ_CONTROL_DIR': str(self.control),
                    'GPUQ_ACTUAL_GPU_COUNT': '2', 'GPUQ_WORLD_SIZE': '2', 'GPUQ_ALLOWED_GPU_COUNTS': '1,2,3',
                    'GPUQ_TARGET_GLOBAL_BATCH_SIZE': '12', 'GPUQ_PER_DEVICE_MICRO_BATCH_SIZE': '2',
                    'PRIVATE_TOKEN': 'must-not-cross', 'PYTHONPATH': '/host/private'}

    def prepare(self, **environment):
        return C.prepare(self.config, self.spec, self.workspace, {'output': self.output}, {**self.env, **environment})

    def test_only_owned_attempt_and_matching_sdk_are_mounted(self):
        args, fds = self.prepare()
        try:
            self.assertEqual(os.fstat(fds[0]).st_ino, self.control.stat().st_ino)
            self.assertEqual(os.fstat(fds[1]).st_ino, self.archive.stat().st_ino)
            env = {args[i+1]: args[i+2] for i, item in enumerate(args) if item == '--setenv'}
            self.assertEqual(env['GPUQ_JOB_ID'], self.job)
            self.assertEqual(env['GPUQ_CONSOLE_JOB_ID'], self.spec['id'])
            self.assertEqual(env['GPUQ_CONTROL_DIR'], '/run/gpuq/control')
            self.assertEqual(env['GPUQ_ALLOWED_GPU_COUNTS'], '1,2,3')
            self.assertEqual(env['PYTHONPATH'], '/opt/gpuq/sdk.pyz')
            self.assertNotIn('PRIVATE_TOKEN', env)
            self.assertNotIn(self.config['database'], args)
            self.assertNotIn(str(self.control.parent), args)
        finally:
            for fd in fds: os.close(fd)

    def test_old_configuration_is_a_noop(self):
        self.assertEqual(C.prepare({}, self.spec, self.workspace, None, {}), ([], []))

    def test_wrong_attempt_job_or_portal_binding_never_mounts(self):
        for changes in ({'GPUQ_ATTEMPT_ID': '../other'}, {'GPUQ_JOB_ID': 'J0000'},
                        {'GPUQ_CONTROL_DIR': str(self.control.parent)}, {'GPUQ_WORLD_SIZE': '2; bad'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.prepare(**changes)
        self.spec['id'] = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, 'does not belong'): self.prepare()

    def test_checkpoint_namespace_and_host_paths_resolve_to_same_job_output(self):
        (self.output / 'model.pt').write_bytes(b'checkpoint')
        for path in ('/outputs/model.pt', str(self.output / 'model.pt')):
            args, fds = self.prepare(GPUQ_RESUME_CHECKPOINT=path)
            try:
                at = args.index('GPUQ_RESUME_CHECKPOINT'); self.assertEqual(args[at+1], '/outputs/model.pt')
            finally:
                for fd in fds: os.close(fd)
        (self.workspace / 'state.pt').write_bytes(b'legacy')
        self.assertEqual(C.resume_path('/workspace/state.pt', {'/workspace': self.workspace}), '/workspace/state.pt')

    def test_missing_outside_or_symlink_escape_checkpoint_fails_not_fresh_start(self):
        (self.output / 'escape').symlink_to(self.archive)
        for path in ('/outputs/missing', '/etc/passwd', '/outputs/../code', '/outputs/escape', '/outputs//bad', 'relative'):
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                self.prepare(GPUQ_RESUME_CHECKPOINT=path)

    def test_attempt_directory_cannot_be_a_symlink(self):
        self.control.rmdir(); self.control.symlink_to(self.output, target_is_directory=True)
        with self.assertRaises(OSError): self.prepare()

    def test_both_runners_keep_terminal_and_unconfigured_jobs_unchanged(self):
        for name in ('sandbox-runner.py', 'sandbox-runner-common-p0.py'):
            source = (ROOT / 'deploy' / name).read_text()
            self.assertIn("if terminal or not cfg.get('controlRoot')", source)
            self.assertIn('*control_fds', source)
            self.assertIn('for descriptor in control_fds:os.close(descriptor)', source)
            self.assertIn('return code', source)

    def test_real_namespace_checkpoint_exit_progress_and_next_attempt_resume(self):
        bwrap = shutil.which('bwrap')
        if not bwrap: self.skipTest('bubblewrap not installed; no GPU test is implied')
        base = [bwrap, '--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr',
                '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
                '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
                '--dir', '/opt/gpuq', '--bind', str(self.workspace), '/workspace',
                '--bind', str(self.output), '/outputs', '--clearenv']
        probe = subprocess.run(base + ['--', '/usr/bin/python3', '-c', 'pass'], capture_output=True, text=True)
        if probe.returncode:
            self.skipTest('local namespace unavailable: ' + probe.stderr.strip()[:160])
        request = {'version': SCHEMA_VERSION, 'nonce': 'test-nonce', 'attempt_id': self.attempt,
                   'requested_by_job_id': 'Jhigher', 'created_at': time.time()}
        (self.control / 'request.json').write_text(json.dumps(request))
        script = '''import json,os
from pathlib import Path
from gpuq.checkpoint import checkpoint_at_epoch_end
from gpuq.progress import ProgressReporter
p=ProgressReporter(report_interval_seconds=0)
assert p.update(phase='train',epochs_completed=2,epochs_total=4,metrics={'loss':0.5})
def save():
    with open('/outputs/model.json.tmp','w') as f:
        json.dump({'epoch':2,'model':3,'optimizer':7,'scheduler':2,'rng':11},f);f.flush();os.fsync(f.fileno())
    os.replace('/outputs/model.json.tmp','/outputs/model.json')
    fd=os.open('/outputs',os.O_RDONLY);os.fsync(fd);os.close(fd)
    return {'checkpoint_path':'/outputs/model.json','resume_epoch':2}
checkpoint_at_epoch_end(save)
raise AssertionError('a checkpoint request must stop this attempt')
'''
        args, fds = self.prepare()
        try: result = subprocess.run(base + args + ['--', '/usr/bin/python3', '-c', script], pass_fds=fds, capture_output=True, text=True)
        finally:
            for fd in fds: os.close(fd)
        self.assertEqual(result.returncode, CHECKPOINT_EXIT_CODE, result.stderr)
        ack = json.loads((self.control / 'ack.json').read_text())
        self.assertEqual(ack['nonce'], 'test-nonce'); self.assertEqual(ack['attempt_id'], self.attempt)
        progress = json.loads((self.control / 'progress.json').read_text())
        self.assertEqual(progress['job_id'], self.job); self.assertEqual(progress['attempt_id'], self.attempt)
        self.attempt = 'A' + uuid.uuid4().hex; self.control = self.control.parent / self.attempt; self.control.mkdir()
        with closing(sqlite3.connect(self.config['database'])) as db:
            db.execute('INSERT INTO attempts VALUES (?,?,?)', (self.attempt, self.job, str(self.control)))
            db.commit()
        self.env.update(GPUQ_ATTEMPT_ID=self.attempt, GPUQ_CONTROL_DIR=str(self.control))
        args, fds = self.prepare(GPUQ_RESUME_CHECKPOINT=ack['checkpoint_path'])
        resume = "from gpuq.checkpoint import resume_checkpoint_path; import json; s=json.load(open(resume_checkpoint_path())); assert s=={'epoch':2,'model':3,'optimizer':7,'scheduler':2,'rng':11}; print(s['epoch']+1)"
        try: result = subprocess.run(base + args + ['--', '/usr/bin/python3', '-c', resume], pass_fds=fds, capture_output=True, text=True)
        finally:
            for fd in fds: os.close(fd)
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(result.stdout.strip(), '3')
        self.assertFalse((self.control / 'ack.json').exists())


if __name__ == '__main__': unittest.main(verbosity=2)
