import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

HERE = Path(__file__).resolve().parents[1]/'deploy'
spec = importlib.util.spec_from_file_location('oci_test', HERE/'personal-oci.py')
o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
USER = 'demo-user-3'
SHA = 'a'*64
GPU = 'GPU-12345678-1111-2222-3333-123456789012'


def config():
    return {'root': '/srv/gpuq', 'storageQuota': {'enabled': True}, 'personalOci': {
        'enabled': True, 'baseImage': 'docker.io/library/ubuntu@sha256:'+SHA,
        'podmanSHA256': SHA, 'runtimeSHA256': SHA, 'cdiSHA256': SHA}}


class OCITests(unittest.TestCase):
    def manager(self):
        manager = o.PersonalOCI.__new__(o.PersonalOCI)
        manager.config, manager.user, manager.policy = config(), USER, config()['personalOci']
        manager.owner = hashlib.sha256(USER.encode()).hexdigest()
        manager.folder = Path('/srv/gpuq/oci')/manager.owner
        manager.env = {'PATH': '/usr/bin:/bin', 'HOME': str(manager.folder/'home')}
        manager.s = o.module('project-store')
        return manager

    def test_default_disabled_and_no_silent_shared_fallback(self):
        with self.assertRaisesRegex(ValueError, 'not enabled'): o.policy({})

    def test_requires_kernel_quota(self):
        c = config(); c['storageQuota']['enabled'] = False
        with self.assertRaisesRegex(ValueError, 'hard quotas'): o.policy(c)

    def test_oci_cohort_requires_authenticated_included_owner(self):
        c = config(); c['storageQuota']['owners'] = [USER]
        self.assertEqual(o.policy(c, USER), c['personalOci'])
        with self.assertRaisesRegex(ValueError, 'Authenticated'): o.policy(c)
        with self.assertRaisesRegex(ValueError, 'hard quotas'): o.policy(c, 'demo-user-4')

    def test_excluded_oci_owner_is_rejected_before_any_workspace_write(self):
        c = config(); c['storageQuota']['owners'] = ['demo-user-4']
        with patch.object(o, 'protected_file', side_effect=AssertionError), \
             patch.object(o.os, 'open', side_effect=AssertionError), \
             patch.object(o.Path, 'mkdir', side_effect=AssertionError):
            with self.assertRaisesRegex(ValueError, 'hard quotas'):
                o.PersonalOCI(c, USER)

    def test_config_rejects_rootful_socket_paths_tags_and_unknown_flags(self):
        for replacement in ('ubuntu:latest', '/tmp/image', 'docker.io/lib/foo@sha256:bad', '--privileged'):
            c = config(); c['personalOci']['baseImage'] = replacement
            with self.subTest(replacement=replacement), self.assertRaises(ValueError): o.policy(c)
        c = config(); c['personalOci']['socket'] = '/var/run/docker.sock'
        with self.assertRaises(ValueError): o.policy(c)

    def test_owned_graphroot_and_no_remote_socket(self):
        command = self.manager().command('version')
        self.assertEqual(command[0], '/usr/bin/podman')
        self.assertIn('--cgroup-manager=cgroupfs', command)
        self.assertTrue(command[command.index('--root')+1].endswith(self.manager().owner+'/graph'))
        self.assertFalse(any('socket' in v or '--remote' in v for v in command))

    def verify_capability(self, host):
        manager = self.manager()
        manager.s = SimpleNamespace(directory=MagicMock())
        manager.run = Mock(side_effect=['5.8.8', json.dumps({'host': host})])
        with patch.object(o, 'protected_file') as protected, \
             patch.object(o.os, 'geteuid', return_value=1000), \
             patch.object(o.os, 'fstat', return_value=SimpleNamespace(st_uid=0, st_mode=0o40755)), \
             patch.object(o.os, 'listdir', side_effect=[[], ['gpuq-nvidia.json'], []]), \
             patch.object(o.Path, 'exists', lambda p: str(p) in ('/etc/cdi', '/run/cdi')), \
             patch.object(o.Path, 'is_symlink', return_value=False):
            result = manager.verify_host()
            protected.assert_any_call('/usr/bin/crun', SHA, executable=True)
        self.assertEqual(manager.run.call_args_list[-1].args, ('info', '--format=json'))
        return result

    def test_runtime_capability_accepts_pinned_absolute_name(self):
        for name in ('crun', '/usr/bin/crun'):
            with self.subTest(name=name):
                result = self.verify_capability({'security': {'rootless': True}, 'cgroupVersion': 'v2',
                    'ociRuntime': {'name': name, 'path': '/usr/bin/crun'}})
                self.assertEqual(result['podman'], '5.8.8')
                self.assertIs(result['rootless'], True)
                self.assertIs(result['gpuDevelopment'], False)

    def test_runtime_capability_rejects_unpinned_alias_and_unsafe_host(self):
        safe = {'security': {'rootless': True}, 'cgroupVersion': 'v2',
                'ociRuntime': {'name': '/usr/bin/crun', 'path': '/usr/bin/crun'}}
        wrong = [
            {**safe, 'ociRuntime': {'name': 'crun', 'path': '/tmp/crun'}},
            {**safe, 'ociRuntime': {'name': 'crun', 'path': '/usr/local/bin/crun'}},
            {**safe, 'ociRuntime': {'name': 'crun'}},
            {**safe, 'ociRuntime': {'name': 'crun-alias', 'path': '/usr/bin/crun'}},
            {**safe, 'ociRuntime': {'name': '/tmp/crun', 'path': '/usr/bin/crun'}},
            {**safe, 'security': {'rootless': False}},
            {**safe, 'security': {'rootless': 1}},
            {**safe, 'security': {}},
            {**safe, 'cgroupVersion': 'v1'},
            {**safe, 'cgroupVersion': 2},
        ]
        for host in wrong:
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, 'Rootless cgroup-v2/crun'):
                self.verify_capability(host)

    def test_development_has_no_devices_no_host_network_or_privilege(self):
        args = self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [], [(8, '/workspace', False)])
        self.assertNotIn('--device', args)
        self.assertNotIn('--privileged', args)
        self.assertIn('--cgroups=split', args)
        self.assertIn('--image-volume=ignore', args)
        self.assertIn('--network=slirp4netns:allow_host_loopback=false', args)
        self.assertIn('--env=NVIDIA_VISIBLE_DEVICES=void', args)

    def test_development_rejects_scheduler_gpu_injection(self):
        with self.assertRaisesRegex(ValueError, 'cannot have GPUs'):
            self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [GPU], [])

    def test_development_accepts_resource_environment_but_no_attempt_mount(self):
        args = self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [], [],
                                       ['--setenv', 'GPUQ_CPU_LIMIT', '2', '--setenv', 'PATH', '/opt/gpuq/bin:/usr/bin'])
        self.assertIn('GPUQ_CPU_LIMIT=2', args)
        self.assertIn('PATH=/opt/gpuq/bin:/usr/bin', args)
        with self.assertRaisesRegex(ValueError, 'scheduler controls'):
            self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [], [],
                                     ['--bind-fd', '8', '/run/gpuq/control'])

    def test_scheduler_cdi_exact_uuid_never_all_index_or_duplicate(self):
        raw = json.dumps({'kind': 'nvidia.com/gpu', 'devices': [{'name': 'all'}, {'name': GPU}]}).encode()
        self.assertEqual(o.cdi_devices(raw, [GPU]), ['nvidia.com/gpu='+GPU])
        for values in ([], ['all'], ['0'], [GPU, GPU], ['GPU-'+('f'*36)]):
            with self.subTest(values=values), self.assertRaises(ValueError): o.cdi_devices(raw, values)

    def test_cdi_missing_uuid_or_duplicate_spec_rejected(self):
        for devices in ([{'name': 'all'}], [{'name': GPU}, {'name': GPU}]):
            with self.assertRaises(ValueError): o.cdi_devices(json.dumps({'kind': 'nvidia.com/gpu', 'devices': devices}), [GPU])

    def test_mount_injection_not_a_supported_command(self):
        for target in ('/workspace/../etc', '/tmp:ro', 'relative'):
            with self.assertRaises(ValueError):
                self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [], [(8, target, False)])

    def test_control_translation_only_attempt_sdk_and_hami(self):
        result = o.translate_control(['--dir','/run/gpuq','--bind-fd','12','/run/gpuq/control','--setenv','GPUQ_ATTEMPT_ID','A123'])
        self.assertIn('/proc/'+str(os.getpid())+'/fd/12:/run/gpuq/control:rw', result)
        for args in (['--bind-fd','12','/etc'], ['--dev-bind','/dev/nvidia0','/dev/nvidia0'], ['--setenv','bad;command','x']):
            with self.assertRaises(ValueError): o.translate_control(args)

    def test_release_cannot_select_another_owner_or_tag(self):
        m = self.manager(); m.run = Mock(return_value='sha256:'+SHA)
        receipt = {'schema': 1, 'owner': m.owner, 'project': 'vision', 'image': 'sha256:'+SHA}
        self.assertEqual(m.verify_image('vision', receipt), 'sha256:'+SHA)
        for key, value in (('owner', 'f'*64), ('project', 'other'), ('image', 'ubuntu:latest')):
            bad = {**receipt, key: value}
            with self.assertRaises(ValueError): m.verify_image('vision', bad)

    def test_missing_published_image_does_not_pull_or_fallback(self):
        m = self.manager(); m.run = Mock(return_value='sha256:'+'b'*64)
        with self.assertRaisesRegex(ValueError, 'no tag fallback'):
            m.verify_image('vision', {'schema': 1, 'owner': m.owner, 'project': 'vision', 'image': 'sha256:'+SHA})
        self.assertEqual(m.run.call_count, 1)

    def test_running_or_foreign_dev_container_is_not_committed(self):
        for running, owner in ((True, None), (False, 'f'*64)):
            m = self.manager()
            m.load = Mock(return_value={'schema': 1, 'owner': m.owner, 'project': 'vision', 'image': 'sha256:'+SHA, 'container': 'gpuq-dev-'+'c'*32})
            m.run = Mock(return_value=json.dumps([{'Config': {'Labels': {'io.gpuq.owner': owner or m.owner, 'io.gpuq.project': 'vision'}}, 'State': {'Running': running, 'Pid': 0, 'Status': 'exited'}}]))
            with self.assertRaises(ValueError): m.checkpoint('vision')
            self.assertEqual(m.run.call_count, 1)

    def test_commit_head_is_durable_before_deleting_writable_layer(self):
        m = self.manager()
        value = {'schema': 1, 'owner': m.owner, 'project': 'vision', 'image': 'sha256:'+SHA, 'container': 'gpuq-dev-'+'c'*32}
        m.load = Mock(return_value=value)
        m.run = Mock(side_effect=[json.dumps([{'Config': {'Labels': {'io.gpuq.owner': m.owner, 'io.gpuq.project': 'vision'}}, 'State': {'Running': False, 'Pid': 0, 'Status': 'exited'}}]), 'sha256:'+SHA])
        with patch.object(m.s, 'atomic_json', side_effect=OSError('full')):
            with self.assertRaises(OSError): m.checkpoint('vision')
        self.assertEqual(m.run.call_count, 2)  # No rm after a failed durable head.

    def test_project_oci_publish_hash_and_owner_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); (root/'base').mkdir()
            s = o.module('project-store')
            backend = Mock(); backend.publish.return_value = {'schema': 1, 'owner': hashlib.sha256(USER.encode()).hexdigest(), 'project': 'vision', 'image': 'sha256:'+SHA}
            # This is an immutable-publication unit fixture in a temporary
            # tree, not the node's real platform root. Keep the production
            # guard unchanged; scope its mock to only these fixture objects.
            with patch.object(s, 'check_platform_root'), patch.object(s.ProjectStore, '_oci', return_value=backend):
                store = s.ProjectStore(root, root/'base', reserve_bytes=0)
                store.create(USER, 'vision', 'oci')
                (store.dev_paths(USER, 'vision')['code']/'train.py').write_text('print(1)')
                published = store.publish(USER, 'vision')
                release = store.release(USER, 'vision', published['release'])
                self.assertEqual(release['meta']['environmentMode'], 'oci')
                self.assertEqual(release['meta']['oci']['image'], 'sha256:'+SHA)
                self.assertNotIn('env', release['meta']['content'])
                backend.verify_image.assert_called_once()


if __name__ == '__main__': unittest.main()
