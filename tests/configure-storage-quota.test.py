import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]/'deploy'
spec = importlib.util.spec_from_file_location('quota_install_test', HERE/'configure-storage-quota.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)


def policy():
    return {'schema': 1, 'serviceUid': 1000, 'platformRoot': '/srv/gpuq', 'datasetsRoot': '/srv/data',
            'volumes': {'data': {'uuid': '11111111-1111-1111-1111-111111111111', 'mountPoint': '/srv', 'filesystem': 'xfs'}},
            'owners': {'demo-user-3': {'projectId': 10003, 'limits': {'data': {'bytes': 1048576, 'inodes': 100}}}}}


class InstallerTests(unittest.TestCase):
    def test_plan_only_reads_and_never_mounts_or_installs(self):
        with patch.object(c.pwd, 'getpwuid', return_value=Mock(pw_name='gpuq')), patch.object(c.q, 'volume_for', return_value=('data','/dev/example')), patch.object(c.q, 'quotactl', return_value={'bytes':0,'inodes':0,'usedBytes':0,'usedInodes':0}) as quota, patch.object(c, 'put_new', side_effect=AssertionError):
            result, files, wrapper, sudoers = c.plan(policy())
        self.assertEqual(result['phase'], 'DRY_RUN')
        self.assertFalse(result['mountsChanged'])
        self.assertFalse(result['servicesStarted'])
        self.assertEqual(quota.call_args.args, ('/dev/example',10003))
        self.assertIn(b'/usr/bin/python3 -I ', wrapper)
        self.assertIn(b' ""\n', sudoers)
        self.assertEqual(set(files), {'storage-quota.py','platform-root-guard.py'})

    def test_nonzero_project_ids_are_not_reassigned(self):
        with patch.object(c.pwd, 'getpwuid', return_value=Mock(pw_name='gpuq')), patch.object(c.q, 'volume_for', return_value=('data','/dev/example')), patch.object(c.q, 'quotactl', return_value={'bytes':0,'inodes':0,'usedBytes':4096,'usedInodes':1}), self.assertRaisesRegex(ValueError, 'already used'):
            c.plan(policy())

    def test_execute_requires_root(self):
        with patch.object(c.os, 'geteuid', return_value=1000), self.assertRaisesRegex(ValueError, 'administrator'):
            c.execute(policy(),'a'*64)

    def test_new_file_write_never_overwrites_partial_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve()/'file'
            c.put_new(path,b'original',0o600)
            with self.assertRaises(FileExistsError): c.put_new(path,b'replacement',0o600)
            self.assertEqual(path.read_bytes(), b'original')

    def test_symlink_install_parent_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); (root/'dir').mkdir(); (root/'alias').symlink_to(root/'dir')
            with self.assertRaises(OSError): c.put_new(root/'alias'/'file',b'x',0o600)

    def test_finite_aligned_limits_required(self):
        p=policy();p['owners']['demo-user-3']['limits']['data']['bytes']=0
        with self.assertRaisesRegex(ValueError, 'finite'): c.q.validate_policy(p)


if __name__ == '__main__': unittest.main()
