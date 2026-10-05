"""Private data workspaces: local files only; never starts systemd or a GPU."""
import base64
import hashlib
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
from storage_test_helpers import local_data_mounts

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


class DataWorkspaceTests(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.data_mount = local_data_mounts(self.base)
        self.data_mount.start()
        self.addCleanup(self.data_mount.stop)
        for name in ('platform-root-guard.py','node-executor.py', 'scheduling-policy.py', 'dataset-cache.py', 'data-workspace.py'):
            shutil.copy2(DEPLOY/name, self.base/name)
        config = {'root': str(self.base/'state'), 'hostRoot': True,
                  'datasets': {'root': str(self.base/'cache'), 'mountPoint': str(self.base), 'sources': {}, 'reserveBytes': 0}}
        (self.base/'node-config.json').write_text(json.dumps(config))
        spec = importlib.util.spec_from_file_location('data_workspace_node_test', self.base/'node-executor.py')
        self.n = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.n
        spec.loader.exec_module(self.n)
        self.mount = patch.object(self.n, 'dataset_mount_check')
        self.mount.start()
        self.w = self.n.data_workspaces()
        self.user = 'demo-user-1'
        self.starts = []
        self.launch = patch.object(self.n, 'run', side_effect=lambda argv, **kwargs: self.starts.append(argv))
        self.launch.start()
        self.stopped = patch.object(self.w, 'unit_stopped', return_value=False)
        self.stopped.start()
        self.module, self.cache, self.owner = self.w.storage(self.user)

    def tearDown(self):
        self.stopped.stop();self.launch.stop();self.mount.stop()
        for root, dirs, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root)/name
                if not path.is_symlink():os.chmod(path, 0o600)
        self.temp.cleanup()

    def call(self, action, user=None, **args):
        return self.n.process('datasets.workspace.'+action, {'userId': user or self.user, 'hostAdmin': False, **args})

    def fill(self, path='sample/train.txt', text=b'private training data'):
        with patch.object(self.n.os, 'statvfs', return_value=SimpleNamespace(f_bavail=10**15, f_frsize=1)):
            return self.call('put', path=path, data=base64.b64encode(text).decode(), offset=0)

    def publish(self, **args):
        return self.call('publish', path='sample', name='sample', key=str(uuid.uuid4()), **args)

    def test_private_workspace_chunk_upload_download_and_nested_parent_creation(self):
        self.assertEqual(self.call('status')['state'], 'EDITABLE')
        self.assertEqual(self.fill()['size'], 21)
        listing = self.call('list')
        self.assertEqual(listing['path'], '.')
        self.assertEqual(listing['entries'][0]['name'], 'sample')
        got = self.call('get', path='sample/train.txt', offset=0)
        self.assertEqual(base64.b64decode(got['data']), b'private training data')
        self.assertEqual(self.call('list', user='demo-user-2')['entries'], [])
        with self.assertRaises(FileNotFoundError):self.call('get', user='demo-user-2', path='sample/train.txt')
        self.assertNotIn(str(self.base), json.dumps(got))
        self.assertEqual(self.call('list', path='sample')['entries'][0]['type'], 'file')

    def test_traversal_links_special_files_and_spoofed_identity_are_rejected(self):
        self.fill()
        for path in ('../operations', '/data2', 'sample/../train.txt', 'sample\\train.txt', 'sample//train.txt', '\x00'):
            with self.subTest(path=path), self.assertRaises(ValueError):self.call('list', path=path)
        (self.owner/'data'/'link').symlink_to(self.owner/'operations', target_is_directory=True)
        with self.assertRaises(OSError):self.call('list', path='link')
        os.link(self.owner/'data'/'sample/train.txt', self.owner/'data'/'hard')
        with self.assertRaisesRegex(ValueError, 'regular files'):self.call('get', path='hard')
        for extra in ({'hostAdmin': True}, {'hostAdmin': 0}, {'root': '/data2'}, {'owners': [self.user]}, {'sourceId': 'anything'}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):self.call('list', **extra)
        with self.assertRaises(ValueError):self.call('list', user='../../root')

    def test_publication_async_owner_only_and_immutable_copy(self):
        self.fill()
        result = self.publish()
        self.assertEqual(result['state'], 'PUBLISHING')
        self.assertEqual(self.starts[-1][-3:], ['--data-workspace-worker', self.user, result['operationId']])
        self.assertIn('--property=MemoryMax=2G', self.starts[-1])
        for action, args in [('put', dict(path='other',data='',offset=0)), ('publish', dict(path='sample',name='other',key=str(uuid.uuid4())))]:
            with self.assertRaisesRegex(ValueError, 'pending'):self.call(action, **args)
        self.assertEqual(self.w.worker(self.user, result['operationId']), 0)
        ready = self.call('status', operationId=result['operationId'])
        self.assertEqual(ready['state'], 'READY')
        self.assertEqual(ready['files'], 1)
        self.assertNotIn(str(self.base), json.dumps(ready))
        self.assertEqual(self.n.CONFIG['datasets']['sources'], {})
        with self.assertRaises(FileNotFoundError):self.call('status', user='demo-user-2', operationId=result['operationId'])
        other = self.module.Principal('demo-user-2')
        with self.assertRaises(PermissionError):self.cache.status(other, ready['dataset'], ready['version'])
        published = self.cache._paths(ready['dataset'], ready['version'])['ready']/'data'/'train.txt'
        self.assertEqual(published.stat().st_mode & 0o777, 0o444)
        (self.owner/'data'/'sample/train.txt').write_bytes(b'changed source')
        self.assertEqual(published.read_bytes(), b'private training data')
        # Global cache has no reusable approved path to mutable personal data.
        self.assertFalse(self.cache.list_datasets(self.module.Principal(self.user))['datasets'][0]['versions'][0]['canPrepare'])

    def test_publish_key_idempotent_conflict_and_no_root_publication(self):
        self.fill()
        key = str(uuid.uuid4())
        first = self.call('publish', path='sample', name='sample', key=key)
        again = self.call('publish', path='sample', name='sample', key=key)
        self.assertEqual(first, again);self.assertEqual(len(self.starts), 1)
        with self.assertRaisesRegex(ValueError, 'different request'):
            self.call('publish', path='sample', name='other', key=key)
        for path in ('.', '..', '/data2', '../.registry', ''):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.call('publish', path=path, name='sample', key=str(uuid.uuid4()))

    def test_archive_intent_is_durable_before_publish_and_lost_ack_is_not_publish_failure(self):
        self.fill()
        result = self.publish()
        events = []
        def begin(args):
            events.append(args)
            self.assertNotEqual(self.cache.status(self.module.Principal(self.user), **args['reference'])['state'], 'READY')
            return {'id': args['opId']}
        def ready(args):
            raise OSError('simulated outbox ack failure')
        self.n.CONFIG['storageArchive'] = {'enabled': True}
        with patch.object(self.n, 'storage_archive', return_value=SimpleNamespace(outbox_begin=begin, outbox_ready=ready)):
            self.assertEqual(self.w.worker(self.user, result['operationId']), 0)
        published = self.call('status', operationId=result['operationId'])
        self.assertEqual(published['state'], 'READY')
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['origin'], 'workspace')
        self.assertEqual(events[0]['reference'], {'dataset': published['dataset'], 'version': published['version']})

    def test_same_uuid_across_users_gets_distinct_worker_units(self):
        key=str(uuid.uuid4())
        self.assertNotEqual(self.w.unit(self.user,key),self.w.unit('demo-user-2',key))

    def test_workspace_publication_never_mutates_direct_upload_registration(self):
        self.fill()
        manifest=self.module._scan(self.owner/'data/sample')
        upload_name='u-'+hashlib.sha256(self.user.encode()).hexdigest()[:16]+'-sample'
        registered=self.cache.register_manifest(self.module.Principal(self.user,True),upload_name,manifest,[self.user])
        record=self.cache.root/'.registry'/upload_name/(registered['version']+'.json')
        before=record.read_bytes()
        result=self.publish()
        self.assertEqual(self.w.worker(self.user,result['operationId']),0)
        self.assertEqual(record.read_bytes(),before)
        self.assertEqual(json.loads(record.read_bytes())['sourceId'],None)
        workspace=self.call('status',operationId=result['operationId'])
        self.assertTrue(workspace['dataset'].startswith('w-'))
        self.assertNotEqual(workspace['dataset'],upload_name)

    def test_recovery_requires_stopped_worker_and_exclusive_lifetime_then_fences_late_start(self):
        self.fill();result=self.publish();key=result['operationId']
        with self.assertRaisesRegex(ValueError,'termination'):
            self.w.recover(self.user,key)
        self.assertEqual(self.call('status',operationId=key)['state'],'PUBLISHING')
        with patch.object(self.w,'unit_stopped',return_value=True):
            held=self.w.lifetime(self.user)
            try:
                with self.assertRaisesRegex(ValueError,'busy'):self.w.recover(self.user,key)
            finally:os.close(held)
            recovered=self.w.recover(self.user,key)
        self.assertEqual(recovered['state'],'FAILED')
        self.assertTrue((self.owner/'data/sample/train.txt').exists())
        self.w.writable({'userId':self.user})
        with self.assertRaisesRegex(ValueError,'no longer owns'):self.w.worker(self.user,key)
        with self.assertRaises(ValueError):self.call('recover',operationId=key)

    def test_ambiguous_launch_or_missing_worker_never_unlocks_workspace(self):
        self.fill();key = str(uuid.uuid4())
        with patch.object(self.n, 'run', side_effect=TimeoutError('launch uncertain')):
            with self.assertRaises(TimeoutError):self.call('publish', path='sample', name='sample', key=key)
        with patch.object(self.w, 'unit_stopped', return_value=True):
            self.assertEqual(self.call('status', operationId=key)['state'], 'UNKNOWN')
        with self.assertRaisesRegex(ValueError, 'pending'):self.w.writable({'userId': self.user})
        with self.assertRaisesRegex(ValueError, 'pending'):
            self.w.terminal_mount({'userId': self.user, 'cards': 0, 'dataWorkspace': True}, str(uuid.uuid4()))

    def test_terminal_lifetime_and_pending_guard_exclude_publication(self):
        self.fill()
        spec = {'userId': self.user, 'username': 'alice', 'dataWorkspace': True, 'cards': 0}
        fd, lock = self.w.terminal_mount(spec, str(uuid.uuid4()))
        try:
            self.assertEqual(os.fstat(fd).st_ino, (self.owner/'data').stat().st_ino)
            self.assertNotEqual(os.fstat(fd).st_ino, self.cache.root.stat().st_ino)
            with self.assertRaisesRegex(ValueError, 'busy'):self.publish()
        finally:os.close(fd);os.close(lock)
        for extra in ({'project': 'code'}, {'hostAdmin': True}, {'cards': 1}, {'dataWorkspace': 'true'}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):self.w.terminal_mount({**spec, **extra}, str(uuid.uuid4()))
        self.assertEqual(self.publish()['state'], 'PUBLISHING')

    def test_running_or_uncertain_terminal_blocks_publish_even_before_mount(self):
        self.fill();folder = self.n.ROOT/'terminals';folder.mkdir()
        jid = str(uuid.uuid4())
        (folder/(jid+'.json')).write_text(json.dumps({'userId': self.user, 'dataWorkspace': True}))
        with self.assertRaisesRegex(ValueError, 'Close all'):self.publish()
        with patch.object(self.w, 'unit_stopped', return_value=True):
            self.assertEqual(self.publish()['state'], 'PUBLISHING')

    def test_terminal_scope_fences_every_existing_session_operation(self):
        context = {'userId': self.user, 'username': 'alice', 'hostAdmin': False}
        self.assertNotEqual(self.n.terminal_pointer(context), self.n.terminal_pointer({**context, 'dataWorkspace': True}))
        folder = self.n.ROOT/'terminals';folder.mkdir()
        jid = str(uuid.uuid4())
        (folder/(jid+'.json')).write_text(json.dumps({**context, 'dataWorkspace': True}))
        self.assertTrue(self.n.terminal_owned({**context, 'dataWorkspace': True}, jid)['dataWorkspace'])
        for changes in ({}, {'hostAdmin': True}, {'userId': 'demo-user-2'}, {'project': 'sample'}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'not owned'):
                self.n.terminal_owned({**context, **changes}, jid)
        for changes in ({'hostAdmin': True}, {'project': 'sample'}, {'dataWorkspace': 'true'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.n.terminal_pointer({**context, 'dataWorkspace': True, **changes})

    def test_worker_rejects_link_and_releases_only_after_failure_receipt(self):
        self.fill()
        (self.owner/'data/sample/link').symlink_to(self.base/'node-config.json')
        result = self.publish()
        self.assertEqual(self.w.worker(self.user, result['operationId']), 1)
        failure = self.call('status', operationId=result['operationId'])
        self.assertEqual(failure['state'], 'FAILED')
        self.assertIn('symlinks', failure['error'])
        self.w.writable({'userId': self.user})
        self.assertEqual(self.cache.list_datasets(self.module.Principal(self.user)), {'datasets': []})

    def test_status_rechecks_current_copy_and_registration_without_rewriting_history(self):
        self.fill();result=self.publish();key=result['operationId']
        self.assertEqual(self.w.worker(self.user,key),0)
        ready=self.call('status',operationId=key)
        history=(self.owner/'operations'/(key+'.json')).read_bytes()
        admin=self.module.Principal(self.user,True)
        self.cache.evict(admin,ready['dataset'],ready['version'])
        missing=self.call('status',operationId=key)
        self.assertEqual((missing['state'],missing['publicationState']),('NOT_READY','READY'))
        self.cache.unregister(admin,ready['dataset'])
        removed=self.call('status',operationId=key)
        self.assertEqual((removed['state'],removed['publicationState']),('UNREGISTERED','READY'))
        self.assertEqual((self.owner/'operations'/(key+'.json')).read_bytes(),history)
        self.assertTrue(self.call('status')['editable'])

    def test_workspace_publication_does_not_mutate_a_direct_upload_registration(self):
        self.fill()
        manifest = self.module._scan(self.owner/'data/sample')
        dataset = 'u-'+hashlib.sha256(self.user.encode()).hexdigest()[:16]+'-sample'
        registered = self.cache.register_manifest(self.module.Principal(self.user, True), dataset, manifest, [self.user])
        identity = self.cache._record_identity(dataset, registered['version'])
        result = self.publish()
        self.w.worker(self.user, result['operationId'])
        # Direct uploads bind to sourceId=None and pin registration identity.
        # Reusing the same user-visible name must not mutate their source or
        # invalidate their resumable transfer/commit/discard authorization.
        self.assertEqual(self.cache._record_identity(dataset, registered['version']), identity)
        self.assertIsNone(self.cache._record(self.module.Principal(self.user), dataset, registered['version'])['sourceId'])

    def test_mount_removed_and_metadata_symlink_fail_closed(self):
        with patch.object(self.n, 'dataset_mount_check', side_effect=ValueError('missing mount')):
            with self.assertRaisesRegex(ValueError, 'missing mount'):self.call('list')
        (self.owner/'current.json').symlink_to(self.base/'node-config.json')
        with self.assertRaises(OSError):self.call('status')

    def test_publication_survives_real_contention_longer_than_old_two_second_timeout(self):
        self.fill();task=self.publish();out=[]
        with self.cache._locked():
            worker=threading.Thread(target=lambda:out.append(self.w.worker(self.user,task['operationId'])))
            worker.start();time.sleep(2.15)
            self.assertTrue(worker.is_alive())
            self.assertEqual(self.w.receipt(self.user,task['operationId'])['state'],'PUBLISHING')
        worker.join(5)
        self.assertFalse(worker.is_alive());self.assertEqual(out,[0])
        self.assertEqual(self.call('status',operationId=task['operationId'])['state'],'READY')

    def test_publication_wait_timeout_is_bounded_and_never_reports_ready(self):
        self.fill();task=self.publish();out=[]
        def run():
            with self.module.wait_for_locks(timeout=.05,total=.05):
                out.append(self.w.worker(self.user,task['operationId']))
        with self.cache._locked():
            worker=threading.Thread(target=run);worker.start();worker.join(2)
            self.assertFalse(worker.is_alive())
        self.assertEqual(out,[1]);receipt=self.w.receipt(self.user,task['operationId'])
        self.assertEqual(receipt['state'],'FAILED');self.assertIn('busy',receipt['error'])
        self.assertEqual(self.cache.list_datasets(self.module.Principal(self.user))['datasets'],[])

    def test_publication_real_scan_error_is_not_retried(self):
        self.fill();task=self.publish()
        with patch.object(self.module,'_scan',side_effect=self.module.CacheError('corrupt source')) as scan:
            self.assertEqual(self.w.worker(self.user,task['operationId']),1)
        self.assertEqual(scan.call_count,1)
        self.assertEqual(self.w.receipt(self.user,task['operationId'])['state'],'FAILED')

    def test_systemd_and_cgroup_stop_confirmation_is_fail_closed(self):
        self.stopped.stop()
        fake = SimpleNamespace(returncode=0, stdout='LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n')
        with patch('subprocess.run', return_value=fake):
            self.assertTrue(self.w.unit_stopped('amax-term-example.service'))
        for changes in ('', fake.stdout.replace('MainPID=0', 'MainPID=42'), fake.stdout.replace('inactive', 'activating')):
            with patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=changes)):
                self.assertFalse(self.w.unit_stopped('amax-term-example.service'))
        self.stopped.start()


if __name__ == '__main__':unittest.main()
