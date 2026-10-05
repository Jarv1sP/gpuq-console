import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import tomllib
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

    def test_explicit_oci_cohort_is_independent_of_disabled_disk_quota(self):
        c = config(); c['storageQuota'] = {'enabled': False}; c['personalOci']['owners'] = [USER]
        self.assertEqual(o.policy(c, USER), c['personalOci'])
        self.assertFalse(o.module('storage-quota').ensure(c, USER, Path('/not-created'))['enabled'])
        for user in (None, 'demo-user-4', '*', 'all', 'demo-user-3\n'):
            with self.subTest(user=user), self.assertRaisesRegex(ValueError, 'Authenticated owner'):
                o.policy(c, user)

    def test_explicit_oci_cohort_rejects_invalid_keys_and_owner_lists(self):
        for owners in ([], '*', ['all'], ['*'], [USER, USER], [123], ['builtin-admin-extra']):
            c = config(); c['personalOci']['owners'] = owners
            with self.subTest(owners=owners), self.assertRaisesRegex(ValueError, 'owner cohort'):
                o.policy(c, USER)
        c = config(); c['personalOci'].update(owners=[USER], socket='/var/run/docker.sock')
        with self.assertRaisesRegex(ValueError, 'capability policy'): o.policy(c, USER)

    def test_foreign_explicit_oci_owner_is_rejected_before_any_write(self):
        c = config(); c['storageQuota'] = {'enabled': False}; c['personalOci']['owners'] = [USER]
        with patch.object(o.os, 'open', side_effect=AssertionError), \
             patch.object(o.Path, 'mkdir', side_effect=AssertionError):
            with self.assertRaisesRegex(ValueError, 'Authenticated owner'):
                o.PersonalOCI(c, 'demo-user-4')

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

    def anonymous_manager(self, root):
        manager = self.manager()
        manager.folder = Path(root).resolve()/'private-oci'
        manager.folder.mkdir(mode=0o700)
        for name in ('home', 'home/.config', 'home/.config/containers', 'home/.config/containers/registries.conf.d'):
            (manager.folder/name).mkdir(mode=0o700)
        manager.env = {'PATH': '/usr/bin:/bin', 'HOME': str(manager.folder/'home'),
                       'REGISTRY_AUTH_FILE': str(manager.folder/'anonymous-registry-auth.json'),
                       'CONTAINERS_REGISTRIES_CONF': str(manager.folder/'anonymous-registries.conf')}
        # Preserve real private-HOME checks; do not depend on the test host's
        # administrator /etc ownership or its legitimate registry drop-ins.
        original = manager.registry_dropin_state
        manager.registry_dropin_state = lambda path, uid: ('safe-system',) if path == o.REGISTRY_DROPINS else original(path, uid)
        return manager

    def test_anonymous_registry_auth_is_valid_private_json_and_named_identity_bound(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            with manager.registry_auth() as (env, fd):
                self.assertEqual(env['REGISTRY_AUTH_FILE'], str(manager.folder/'anonymous-registry-auth.json'))
                self.assertEqual(json.loads(os.pread(fd, 1024, 0)), {'auths': {}})
                self.assertEqual(env['CONTAINERS_REGISTRIES_CONF'], str(manager.folder/'anonymous-registries.conf'))
                policy = tomllib.loads(Path(env['CONTAINERS_REGISTRIES_CONF']).read_text())
                self.assertEqual(policy['credential-helpers'], ['containers-auth.json'])
                self.assertEqual(policy['unqualified-search-registries'], [])
                self.assertEqual(os.fstat(fd).st_mode & 0o777, 0o600)
            with self.assertRaises(OSError): os.fstat(fd)
            with manager.registry_auth() as (_, fd):
                self.assertEqual(os.pread(fd, 1024, 0), o.ANONYMOUS_AUTH_RAW)

    def test_anonymous_registry_auth_rejects_links_and_untrusted_content(self):
        for kind in ('symlink', 'hardlink', 'empty', 'credentials', 'helpers', 'mode'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root); path = Path(manager.env['REGISTRY_AUTH_FILE'])
                other = Path(root)/'other'; other.write_bytes(o.ANONYMOUS_AUTH_RAW); other.chmod(0o600)
                if kind == 'symlink': path.symlink_to(other)
                elif kind == 'hardlink': os.link(other, path)
                else:
                    path.write_bytes(b'' if kind == 'empty' else b'{"auths":{"private":{}}}' if kind == 'credentials'
                                     else b'{"auths":{},"credHelpers":{}}' if kind == 'helpers' else o.ANONYMOUS_AUTH_RAW)
                    path.chmod(0o644 if kind == 'mode' else 0o600)
                with self.assertRaises((ValueError, OSError)):
                    with manager.registry_auth(): self.fail('Unsafe anonymous auth accepted')

    def test_anonymous_registry_auth_rejects_replacement_and_disappearance(self):
        for kind in ('replace', 'delete', 'content'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root)
                with manager.registry_auth(): pass
                path = Path(manager.env['REGISTRY_AUTH_FILE'])
                if kind == 'replace':
                    replacement = manager.folder/'replacement'; replacement.write_bytes(o.ANONYMOUS_AUTH_RAW)
                    replacement.chmod(0o600); os.replace(replacement, path)
                elif kind == 'delete': path.unlink()
                else: path.write_bytes(b'{"auths":{}} ')
                with self.assertRaises((ValueError, OSError)):
                    with manager.registry_auth(): self.fail('Changed anonymous auth accepted')

    def test_anonymous_registry_auth_detects_replace_during_operation(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            with self.assertRaisesRegex(ValueError, 'during operation'):
                with manager.registry_auth():
                    path = Path(manager.env['REGISTRY_AUTH_FILE']); replacement = manager.folder/'replacement'
                    replacement.write_bytes(o.ANONYMOUS_AUTH_RAW); replacement.chmod(0o600); os.replace(replacement, path)

    def test_managed_command_inherits_only_private_paths_and_no_host_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            def fake(*args, **kwargs):
                path = Path(kwargs['env']['REGISTRY_AUTH_FILE'])
                self.assertEqual(path, manager.folder/'anonymous-registry-auth.json')
                self.assertNotIn('pass_fds', kwargs)
                self.assertEqual(json.loads(path.read_bytes()), {'auths': {}})
                self.assertNotIn('HTTP_PROXY', kwargs['env'])
                self.assertNotIn('DOCKER_CONFIG', kwargs['env'])
                return SimpleNamespace(returncode=0, stdout='5.8.8\n', stderr='')
            with patch.dict(os.environ, {'HTTP_PROXY': 'http://secret.invalid', 'DOCKER_CONFIG': '/private/host'}), \
                 patch.object(o.subprocess, 'run', side_effect=fake):
                self.assertEqual(manager.run('version'), '5.8.8')

    def test_private_registry_paths_cannot_be_redirected(self):
        for key, value in (('REGISTRY_AUTH_FILE', '/dev/null'), ('REGISTRY_AUTH_FILE', '/private/host/auth.json'),
                           ('CONTAINERS_REGISTRIES_CONF', '/etc/containers/registries.conf')):
            with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root); manager.env[key] = value
                with patch.object(o.subprocess, 'run') as engine, self.assertRaisesRegex(ValueError, 'path changed'):
                    manager.run('info')
                engine.assert_not_called()

    def test_anonymous_registry_create_race_fails_closed_without_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); path = Path(manager.env['REGISTRY_AUTH_FILE'])
            real_open = os.open
            def race(name, flags, *args, **kwargs):
                if name == path.name:
                    if flags & os.O_CREAT: raise FileExistsError('another initializer won')
                    raise FileNotFoundError('not present at first open')
                return real_open(name, flags, *args, **kwargs)
            with patch.object(o.os, 'open', side_effect=race), self.assertRaises(FileExistsError):
                with manager.registry_auth(): self.fail('Race accepted')
            self.assertFalse(path.exists())

    def test_anonymous_registry_short_write_is_retained_and_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); path = Path(manager.env['REGISTRY_AUTH_FILE'])
            real_write = os.write
            with patch.object(o.os, 'write', side_effect=lambda fd, raw: real_write(fd, raw[:3])):
                with self.assertRaisesRegex(ValueError, 'incomplete'):
                    with manager.registry_auth(): self.fail('Short write accepted')
            self.assertEqual(path.read_bytes(), o.ANONYMOUS_AUTH_RAW[:3])
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                with manager.registry_auth(): self.fail('Partial JSON silently repaired')

    def test_anonymous_registry_policy_rejects_external_credential_helper(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            path = Path(manager.env['CONTAINERS_REGISTRIES_CONF'])
            path.write_bytes(b'credential-helpers = ["private-helper"]\n'); path.chmod(0o600)
            with self.assertRaises(ValueError):
                with manager.registry_auth(): self.fail('External credential helper accepted')

    def test_registry_dropins_reject_nonempty_links_modes_and_foreign_owner(self):
        for kind in ('nonempty', 'symlink', 'mode', 'foreign-owner'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                manager = self.manager(); base = Path(root).resolve()/'private'; base.mkdir(mode=0o700)
                path = base/'registries.conf.d'
                if kind == 'symlink': path.symlink_to(base, target_is_directory=True)
                else:
                    path.mkdir(mode=0o700)
                    if kind == 'nonempty': (path/'override.conf').write_text('credential-helpers=["private-helper"]')
                    if kind == 'mode': path.chmod(0o777)
                uid = os.geteuid()+1 if kind == 'foreign-owner' else os.geteuid()
                with self.assertRaises((ValueError, OSError)):
                    manager.registry_dropin_state(path, uid)

    def test_registry_dropins_safe_absence_empty_and_created_path_are_distinct(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.manager(); base = Path(root).resolve()/'private'; base.mkdir(mode=0o700)
            path = base/'containers/registries.conf.d'
            absent = manager.registry_dropin_state(path, os.geteuid())
            self.assertEqual(absent[0], 'absent')
            (base/'containers').mkdir(mode=0o700); path.mkdir(mode=0o700)
            present = manager.registry_dropin_state(path, os.geteuid())
            self.assertEqual(present[0], 'empty'); self.assertNotEqual(absent, present)

    def test_external_system_dropin_is_checked_before_engine_invocation(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); manager.registry_dropin_state = Mock(side_effect=ValueError('administrator review'))
            with patch.object(o.subprocess, 'run') as engine, self.assertRaisesRegex(ValueError, 'administrator review'):
                manager.run('version')
            engine.assert_not_called()
            self.assertEqual(manager.registry_dropin_state.call_args.args, (o.REGISTRY_DROPINS, 0))

    def test_private_home_dropin_and_mid_operation_changes_are_refused(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            path = manager.folder/'home/.config/containers/registries.conf.d'
            (path/'override.conf').write_text('credential-helpers=["private-helper"]')
            with self.assertRaisesRegex(ValueError, 'administrator review'):
                with manager.registry_auth(): self.fail('Private helper override accepted')
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            with self.assertRaisesRegex(ValueError, 'changed during operation'):
                with manager.registry_auth():
                    path = manager.folder/'home/.config/containers/registries.conf.d'
                    path.rmdir(); path.mkdir(mode=0o700)

    def test_anonymous_registry_home_cannot_be_redirected(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); manager.env['HOME'] = '/private/host'
            with self.assertRaisesRegex(ValueError, 'path changed'):
                with manager.registry_auth(): self.fail('Foreign registry HOME accepted')

    def test_base_pull_is_one_attempt_with_verified_tls(self):
        manager = self.manager()
        manager.load = Mock(return_value={'schema': 1, 'owner': manager.owner, 'project': 'vision',
                                         'image': manager.policy['baseImage'], 'container': None})
        manager.run = Mock(side_effect=['', 'sha256:'+SHA])
        with patch.object(manager.s, 'atomic_json'):
            result = manager.checkpoint('vision')
        self.assertEqual(result['image'], 'sha256:'+SHA)
        self.assertEqual(manager.run.call_args_list[0].args,
                         ('pull', '--signature-policy', str(o.SIGNATURE_POLICY), '--quiet', '--policy=missing',
                          '--retry=0', '--tls-verify=true', manager.policy['baseImage']))
        self.assertEqual(manager.run.call_args_list[1].args,
                         ('image', 'inspect', '--format={{.Id}}', manager.policy['baseImage']))

    def test_signature_policy_allows_only_exact_approved_base_digest(self):
        value = json.loads(o.signature_policy_raw(config()['personalOci']['baseImage']))
        self.assertEqual(value['default'], [{'type':'reject'}])
        self.assertEqual(value['transports'], {'docker':{config()['personalOci']['baseImage']:[{'type':'insecureAcceptAnything'}]}})
        for image in ('ubuntu:latest', 'docker.io/library/ubuntu', 'sha256:'+SHA):
            with self.assertRaises(ValueError): o.signature_policy_raw(image)

    def test_immutable_image_id_accepts_only_full_sha256(self):
        for value in (SHA, 'sha256:'+SHA):
            self.assertEqual(o.immutable_image_id(value), 'sha256:'+SHA)
        for value in ('ubuntu:latest', 'sha256:'+SHA[:12], SHA[:12], 'sha512:'+SHA,
                      SHA.upper(), ' '+SHA, SHA+'\n', None, 123):
            with self.subTest(value=value), self.assertRaises(ValueError):
                o.immutable_image_id(value)

    def test_base_and_published_image_accept_podman_bare_full_id(self):
        manager = self.manager()
        manager.load = Mock(return_value={'schema':1,'owner':manager.owner,'project':'vision',
                                         'image':manager.policy['baseImage'],'container':None})
        manager.run = Mock(side_effect=['', SHA])
        with patch.object(manager.s, 'atomic_json'):
            self.assertEqual(manager.checkpoint('vision')['image'], 'sha256:'+SHA)
        manager.run = Mock(return_value=SHA)
        self.assertEqual(manager.verify_image('vision', {'schema':1,'owner':manager.owner,
                         'project':'vision','image':'sha256:'+SHA}), 'sha256:'+SHA)

    def test_commit_canonicalizes_full_id_before_durable_head(self):
        manager = self.manager()
        manager.load = Mock(return_value={'schema':1,'owner':manager.owner,'project':'vision',
                         'image':'sha256:'+SHA,'container':'gpuq-dev-'+'c'*32})
        metadata={'Config':{'Labels':{'io.gpuq.owner':manager.owner,'io.gpuq.project':'vision'}},
                  'State':{'Running':False,'Pid':0,'Status':'exited'}}
        manager.run = Mock(side_effect=[json.dumps([metadata]), SHA, ''])
        with patch.object(manager.s, 'atomic_json') as durable:
            self.assertEqual(manager.checkpoint('vision')['image'], 'sha256:'+SHA)
            self.assertEqual(durable.call_args.args[1]['image'], 'sha256:'+SHA)

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

    def test_execute_reads_existing_delegate_and_enforced_kernel_budget_only(self):
        manager = self.manager(); manager.verify_host = Mock(); manager.arguments = Mock(return_value=[])
        group = '/user.slice/amax-term-unit-test.service'
        state = 'Delegate=yes\nKillMode=control-group\nMemoryMax=8589934592\nTasksMax=2048\nControlGroup='+group+'\n'
        resources = SimpleNamespace(read_budget=Mock(side_effect=ValueError('budget verified sentinel')))
        with patch.object(o.os, 'getuid', return_value=1000), \
             patch.object(o.Path, 'read_text', return_value='0::'+group+'\n'), \
             patch.object(o.subprocess, 'run', return_value=SimpleNamespace(stdout=state)) as systemctl, \
             patch.object(o, 'module', return_value=resources), \
             self.assertRaisesRegex(ValueError, 'budget verified sentinel'):
            manager._execute({'project':'vision','id':'test'}, {'environmentMode':'oci'}, True, [], [], registry_env={})
        self.assertEqual(systemctl.call_count, 1)
        self.assertEqual(systemctl.call_args.args[0][:3], ['/usr/bin/systemctl','--user','show'])
        resources.read_budget.assert_called_once_with({'project':'vision','id':'test'}, group, [], True)

    def test_named_mounts_use_only_open_descriptor_sources_including_controls(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); source = manager.folder/'workspace'; source.mkdir(mode=0o700)
            sdk = manager.folder/'sdk.pyz'; sdk.write_bytes(b'fixed sdk'); sdk.chmod(0o600)
            directory = os.open(source, os.O_RDONLY|os.O_DIRECTORY); archive = os.open(sdk, os.O_RDONLY)
            try:
                sources = {directory:str(source), archive:str(sdk)}
                with patch.object(o.os, 'readlink', side_effect=lambda name:sources[int(name.rsplit('/',1)[-1])]), \
                     manager.named_mounts([(directory,'/workspace',False)], ['--ro-bind-data',str(archive),'/opt/gpuq/sdk.pyz']):
                    args = manager.arguments({'project':'vision','argv':['/bin/bash']}, {'environmentMode':'oci'}, True, [], [(directory,'/workspace',False)])
                    self.assertIn(str(source)+':/workspace:rw', args)
                    control = o.translate_control(['--ro-bind-data',str(archive),'/opt/gpuq/sdk.pyz'], manager._mount_sources)
                    self.assertIn(str(sdk)+':/opt/gpuq/sdk.pyz:ro', control)
                    self.assertFalse(any('/proc/' in arg for arg in args+control))
                self.assertEqual(manager._mount_sources, {})
            finally: os.close(directory); os.close(archive)

    def test_named_mounts_reject_path_replacement_and_writable_ancestors(self):
        for replace in (False, True):
            with self.subTest(replace=replace), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root); source = manager.folder/'workspace'; source.mkdir(mode=0o700)
                descriptor = os.open(source, os.O_RDONLY|os.O_DIRECTORY)
                try:
                    if not replace: manager.folder.chmod(0o777)
                    with patch.object(o.os, 'readlink', return_value=str(source)), self.assertRaises(ValueError):
                        with manager.named_mounts([(descriptor,'/workspace',False)], []):
                            source.rename(manager.folder/'old-workspace'); source.mkdir(mode=0o700)
                finally: os.close(descriptor)

    def test_named_mounts_reject_symlink_and_deleted_or_client_path(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); source = manager.folder/'workspace'; source.mkdir(mode=0o700)
            linked = manager.folder/'linked'; linked.symlink_to(source, target_is_directory=True)
            descriptor = os.open(source, os.O_RDONLY|os.O_DIRECTORY)
            try:
                for name in (str(linked), str(source)+' (deleted)', '../host', '/tmp:rw'):
                    with self.subTest(name=name), patch.object(o.os,'readlink',return_value=name), self.assertRaises((ValueError,OSError)):
                        with manager.named_mounts([(descriptor,'/workspace',False)], []): self.fail('Unsafe named source accepted')
            finally: os.close(descriptor)

    def test_only_small_valid_resource_memfd_is_privately_snapshotted_and_cleaned(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); (manager.folder/'tmp').mkdir(mode=0o700)
            path = manager.folder/'synthetic-resources'; raw = json.dumps({'schemaVersion':1,'cpuLimit':2,
                'memoryLimitBytes':8*1024**3,'pidsLimit':2048,'gpuCount':0}).encode(); path.write_bytes(raw)
            descriptor = os.open(path, os.O_RDONLY)
            try:
                with patch.object(o.os,'readlink',return_value='/memfd:gpuq-resources (deleted)'):
                    with manager.named_mounts([(descriptor,'/run/gpuq/resources.json',True)], []):
                        snapshot = Path(manager._mount_sources[descriptor]); self.assertEqual(snapshot.read_bytes(),raw)
                        self.assertEqual(snapshot.stat().st_mode & 0o777,0o600)
                    self.assertFalse(snapshot.exists())
                    for target, readonly in (('/etc/shadow',True),('/run/gpuq/resources.json',False)):
                        with self.assertRaises(ValueError):
                            with manager.named_mounts([(descriptor,target,readonly)], []): self.fail('Unsupported memfd accepted')
            finally: os.close(descriptor)

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
