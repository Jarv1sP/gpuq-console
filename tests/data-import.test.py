"""Cloud import isolation/security tests. No real HTTP, systemd or GPU calls."""
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import uuid
from storage_test_helpers import local_data_mounts

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


class Response(io.BytesIO):
    def __init__(self, body=b'hello', status=200, headers=None, on_read=None):
        super().__init__(body)
        self.status = status
        self.headers = {'Content-Length': str(len(body)), **(headers or {})}
        self.on_read = on_read

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read(self, count=-1):
        if self.on_read:
            self.on_read()
        return super().read(count)


class DataImportTests(unittest.TestCase):
    def setUp(self):
        from storage_test_helpers import isolated_platform_pin
        isolated_platform_pin(self)
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.data_mount = local_data_mounts(self.base)
        self.data_mount.start()
        self.addCleanup(self.data_mount.stop)
        for name in ('platform-root-guard.py','node-executor.py', 'scheduling-policy.py', 'dataset-cache.py', 'data-workspace.py', 'data-import.py'):
            shutil.copy2(DEPLOY/name, self.base/name)
        (self.base/'node-config.json').write_text(json.dumps({'root': str(self.base/'state'),
            'datasets': {'root': str(self.base/'cache'), 'mountPoint': str(self.base), 'sources': {}, 'reserveBytes': 0}}))
        spec = importlib.util.spec_from_file_location('data_import_node_test', self.base/'node-executor.py')
        self.n = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.n
        spec.loader.exec_module(self.n)
        self.mount = patch.object(self.n, 'dataset_mount_check'); self.mount.start()
        self.i = self.n.data_imports()
        self.d = sys.modules['gpuq_data_import']
        self.user = 'demo-user-1'
        self.key = str(uuid.uuid4())
        self.url = 'https://cdn.example.com/download?signature=NEVER-RETURN-THIS'
        self.starts = []
        self.launch = patch.object(self.n, 'run', side_effect=lambda argv, **kwargs: self.starts.append(argv)); self.launch_mock = self.launch.start()
        self.stopped = patch.object(self.i.w, 'unit_stopped', return_value=True); self.stopped_mock = self.stopped.start()
        self.module, self.cache, self.owner, _ = self.i.storage(self.user)

    def tearDown(self):
        self.stopped.stop(); self.launch.stop(); self.mount.stop()
        self.temp.cleanup()

    def call(self, action, **args):
        return self.n.process('datasets.import.'+action, {'userId': self.user, 'hostAdmin': False, **args})

    def start(self, **args):
        return self.call('start', **{'key': self.key, 'path': 'downloads/archive.tar', 'url': self.url, **args})

    def worker(self, response, generation='1'):
        self.connection = MagicMock()
        with patch.object(self.d, 'open_download', return_value=(self.connection, response)) as mocked:
            code = self.i.worker(self.user, self.key, generation)
        return code, mocked

    def status(self):
        return self.call('status', operationId=self.key)

    def seed_partial(self, body=b'hel', total=5, etag='"version1"'):
        task = self.i.load(self.user, self.key)
        task.update(state='PAUSED', totalBytes=total, bytes=len(body), etag=etag)
        self.i.save(task)
        _, _, _, folder = self.i.storage(self.user, self.key)
        (folder/'payload.part').write_bytes(body)
        os.chmod(folder/'payload.part', 0o600)

    def test_detached_launch_and_private_receipts(self):
        result = self.start()
        self.assertEqual(result['state'], 'QUEUED')
        command = self.starts[-1]
        self.assertEqual(command[-4:], ['--data-import-worker', self.user, self.key, '1'])
        self.assertIn('--property=KillMode=control-group', command)
        self.assertIn('--property=StandardError=null', command)
        self.assertNotIn(self.url, repr(command))
        self.assertNotIn('NEVER-RETURN-THIS', json.dumps(result))
        self.assertEqual(self.call('list')['imports'][0]['operationId'], self.key)
        _, _, _, folder = self.i.storage(self.user, self.key)
        self.assertEqual((folder/'task.json').stat().st_mode & 0o777, 0o600)
        self.assertNotIn(str(self.base), json.dumps(self.call('list')))

    def test_complete_checksum_and_no_automatic_unpack(self):
        digest = hashlib.sha256(b'hello').hexdigest()
        self.start(sha256=digest, expectedBytes=5)
        code, _ = self.worker(Response())
        self.assertEqual(code, 0)
        self.assertEqual((self.owner/'data/downloads/archive.tar').read_bytes(), b'hello')
        result = self.status()
        self.assertEqual(result['state'], 'READY')
        self.assertEqual(result['bytes'], 5)
        self.assertEqual(result['sha256'], digest)
        self.assertEqual(self.cache._reserved(), 0)
        self.assertNotIn('url', self.i.load(self.user, self.key))
        count = len(self.starts)
        self.assertEqual(self.start(sha256=digest, expectedBytes=5)['state'], 'READY')
        self.assertEqual(len(self.starts), count)

    def test_aliyun_sha1_verified_and_refreshed_link_resume(self):
        sha1 = hashlib.sha1(b'hello').hexdigest()
        self.start(sourceKind='aliyun', expectedSha1=sha1, expectedBytes=5)
        self.seed_partial(etag=None)
        self.start(sourceKind='aliyun', expectedSha1=sha1, expectedBytes=5,
                   url='https://other.example.com/file?signature=REFRESHED')
        code, opening = self.worker(Response(b'lo', 206, {'Content-Range': 'bytes 3-4/5'}), '2')
        self.assertEqual(code, 0)
        self.assertEqual(opening.call_args.args[1:], (3, None, 'aliyun'))
        self.assertEqual(self.status()['sha1'], sha1)

    def test_strong_etag_resume(self):
        self.start(); self.seed_partial(); self.start()
        code, opening = self.worker(Response(b'lo', 206, {'Content-Range': 'bytes 3-4/5', 'ETag': '"version1"'}), '2')
        self.assertEqual(code, 0)
        self.assertEqual(opening.call_args.args[1:3], (3, '"version1"'))

    def test_changed_etag_and_bad_range_do_not_append(self):
        for headers in ({'Content-Range': 'bytes 3-4/5', 'ETag': '"other"'},
                        {'Content-Range': 'bytes 2-3/5', 'ETag': '"version1"'},
                        {'Content-Range': 'bytes 3-4/6', 'ETag': '"version1"'}):
            with self.subTest(headers=headers):
                self.key = str(uuid.uuid4()); self.start(); self.seed_partial(); self.start()
                code, _ = self.worker(Response(b'lo', 206, headers), '2')
                self.assertEqual(code, 1)
                self.assertEqual(self.status()['errorCode'], 'CHANGED')
                _, _, _, folder = self.i.storage(self.user, self.key)
                self.assertEqual((folder/'payload.part').read_bytes(), b'hel')

    def test_range_ignored_and_unverifiable_resume_rejected(self):
        self.start(); self.seed_partial(); self.start()
        self.assertEqual(self.worker(Response(), '2')[0], 1)
        self.assertEqual(self.status()['errorCode'], 'RESUME')
        self.key = str(uuid.uuid4()); self.start(); self.seed_partial(etag=None); self.start()
        code, opening = self.worker(Response(), '2')
        self.assertEqual(code, 1); opening.assert_not_called()

    def test_etag_alone_does_not_allow_cross_resource_url_replacement(self):
        self.start(); self.seed_partial()
        for url in ('https://cdn.example.com/another', 'https://other.example.com/download'):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'checksum'):
                self.start(url=url)
        self.assertEqual(self.start(url='https://cdn.example.com/download?signature=NEW')['state'], 'QUEUED')

    def test_expired_link_pauses_and_does_not_leak_secret(self):
        self.start()
        self.assertEqual(self.worker(Response(b'', 403))[0], 1)
        result = self.status()
        self.assertEqual(result['state'], 'PAUSED'); self.assertTrue(result['canResume'])
        self.assertEqual(result['errorCode'], 'EXPIRED')
        self.assertNotIn(self.url, json.dumps(result))
        self.assertNotIn('NEVER-RETURN-THIS', json.dumps(self.call('list')))

    def test_short_network_body_and_unknown_exception_are_sanitized(self):
        self.start()
        self.assertEqual(self.worker(Response(b'hel', headers={'Content-Length': '5', 'ETag': '"v1"'}))[0], 1)
        self.assertEqual(self.status()['state'], 'PAUSED')
        self.assertEqual(self.status()['bytes'], 3)
        self.assertEqual(self.cache._reserved(), 0)
        self.start()
        with patch.object(self.d, 'open_download', side_effect=OSError(self.url)):
            self.assertEqual(self.i.worker(self.user, self.key, '2'), 1)
        self.assertNotIn('NEVER-RETURN-THIS', json.dumps(self.status()))

    def test_size_and_encoding_rejected_before_payload_write(self):
        for headers, expected in [({'Content-Length': ''}, 'SIZE'),
                                  ({'Content-Encoding': 'gzip'}, 'ENCODING'),
                                  ({'Content-Length': '10000000000000000'}, 'QUOTA')]:
            with self.subTest(headers=headers):
                self.key = str(uuid.uuid4()); self.start()
                self.assertEqual(self.worker(Response(headers=headers))[0], 1)
                self.assertEqual(self.status()['errorCode'], expected)
                self.assertEqual(self.status()['bytes'], 0)
        self.key = str(uuid.uuid4()); self.start(expectedBytes=100)
        self.assertEqual(self.worker(Response())[0], 1)
        self.assertEqual(self.status()['errorCode'], 'CHANGED')

    def test_checksum_mismatch_never_publishes(self):
        self.start(expectedSha1='0'*40)
        self.assertEqual(self.worker(Response())[0], 1)
        self.assertEqual(self.status()['errorCode'], 'CHECKSUM')
        self.assertFalse((self.owner/'data/downloads/archive.tar').exists())

    def test_existing_destination_preserved(self):
        (self.owner/'data'/'downloads').mkdir()
        target = self.owner/'data/downloads/archive.tar'
        target.write_bytes(b'prior')
        self.start()
        self.assertEqual(self.worker(Response())[0], 1)
        self.assertEqual(self.status()['errorCode'], 'EXISTS')
        self.assertEqual(target.read_bytes(), b'prior')

    def test_symlink_destination_and_parent_never_traversed(self):
        outside = self.base/'untouched'; outside.mkdir()
        (self.owner/'data/downloads').symlink_to(outside, target_is_directory=True)
        self.start(); self.assertEqual(self.worker(Response())[0], 1)
        self.assertFalse((outside/'archive.tar').exists())

    def test_ownership_and_fields_validation(self):
        self.start()
        for extra in ({'hostAdmin': True}, {'hostAdmin': 0}, {'headers': {'Authorization': 'x'}},
                      {'proxy': 'http://localhost:7890'}, {'sourceKind': 'unknown'}, {'sha256': 'x'},
                      {'expectedSha1': 'f'*64}, {'expectedBytes': -1}, {'path': '../escape'}, {'path': '/data2/a'}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.start(**extra)
        with self.assertRaises(ValueError):
            self.n.process('datasets.import.status', {'userId': 'demo-user-2', 'operationId': self.key})
        with self.assertRaises(ValueError):
            self.n.process('datasets.import.list', {'userId': '../../root'})
        self.assertNotEqual(self.i.unit(self.i.load(self.user, self.key)),
                            self.i.unit({'userId': 'demo-user-2', 'operationId': self.key}))

    def test_same_key_identity_is_immutable_and_live_duplicate_does_not_launch(self):
        self.start(expectedBytes=5)
        for extra in ({'path': 'new'}, {'expectedBytes': 6}, {'sha256': 'f'*64}, {'sourceKind': 'aliyun'}):
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'different'):
                self.start(**{'expectedBytes': 5, **extra})
        self.stopped_mock.return_value = False
        self.start(expectedBytes=5, url='https://new.example.com/x')
        self.assertEqual(len(self.starts), 1)

    def test_unknown_unit_cannot_resume_or_admit_a_second_import(self):
        self.start()
        self.stopped_mock.side_effect = OSError('no service manager')
        self.assertFalse(self.status()['canResume'])
        self.start(); self.assertEqual(len(self.starts), 1)
        with self.assertRaisesRegex(ValueError, 'Another'):
            self.start(key=str(uuid.uuid4()))

    def test_stale_worker_does_not_release_live_reservation(self):
        self.start(); task = self.i.load(self.user, self.key)
        self.i.reservation(task, 123)
        self.assertEqual(self.i.worker(self.user, self.key, '999'), 0)
        self.assertEqual(self.cache._reserved(), 123)

    def test_duplicate_worker_cannot_clear_reservation(self):
        self.start(); task = self.i.load(self.user, self.key)
        _, _, _, folder = self.i.storage(self.user, self.key)
        with (folder/'worker.lock').open('w') as lock:
            os.chmod(folder/'worker.lock', 0o600)
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.i.reservation(task, 123)
            self.assertEqual(self.i.worker(self.user, self.key, '1'), 0)
            self.assertEqual(self.cache._reserved(), 123)

    def test_cancel_queued_and_cancel_during_download(self):
        self.start()
        result = self.call('cancel', operationId=self.key)
        self.assertEqual(result['state'], 'CANCELED')
        self.assertEqual(self.call('cancel', operationId=self.key)['state'], 'CANCELED')
        self.assertEqual(self.i.worker(self.user, self.key, '1'), 0)
        self.assertFalse((self.owner/'data/downloads/archive.tar').exists())
        self.start()
        self.stopped_mock.return_value = False
        once = [False]
        def cancel():
            if not once[0]:
                once[0] = True
                self.assertEqual(self.call('cancel', operationId=self.key)['state'], 'CANCELING')
        self.assertEqual(self.worker(Response(on_read=cancel), '2')[0], 1)
        self.assertEqual(self.status()['state'], 'CANCELED')
        self.assertFalse((self.owner/'data/downloads/archive.tar').exists())

    def test_file_limit_user_quota_space_and_session_limits(self):
        self.i.limits['maxUploadBytes'] = 4
        self.start(); self.assertEqual(self.worker(Response())[0], 1)
        self.assertEqual(self.status()['errorCode'], 'QUOTA')
        self.i.limits['maxUploadBytes'] = 100
        self.i.limits['maxUserBytes'] = 4
        self.key = str(uuid.uuid4()); self.start(); self.assertEqual(self.worker(Response())[0], 1)
        self.assertEqual(self.status()['errorCode'], 'QUOTA')
        self.i.limits['maxUserBytes'] = 100
        self.key = str(uuid.uuid4()); self.start()
        with patch.object(type(self.cache), '_free', side_effect=ValueError('disk full')):
            self.assertEqual(self.worker(Response())[0], 1)
        self.assertEqual(self.status()['errorCode'], 'SPACE')
        self.i.limits['maxUserSessions'] = 3
        with self.assertRaisesRegex(ValueError, 'Too many'):
            self.start(key=str(uuid.uuid4()))

    def test_ambiguous_launch_fence_and_generation_resume(self):
        self.launch_mock.side_effect = ValueError(self.url)
        self.start()
        self.stopped_mock.return_value = False
        self.assertEqual(self.status()['errorCode'], 'START_UNCONFIRMED')
        self.assertFalse(self.status()['canResume'])
        self.assertNotIn('NEVER-RETURN-THIS', json.dumps(self.status()))
        self.stopped_mock.return_value = True
        self.launch_mock.side_effect = lambda argv, **kw: self.starts.append(argv)
        self.start()
        self.assertEqual(self.i.worker(self.user, self.key, '1'), 0)
        self.assertEqual(self.worker(Response(), '2')[0], 0)

    def test_commit_recovery_after_link_and_after_unlink(self):
        for unlink in (False, True):
            with self.subTest(unlink=unlink):
                self.key = str(uuid.uuid4())
                path = 'downloads/recover-'+self.key
                self.start(path=path)
                self.seed_partial(b'hello')
                task = self.i.load(self.user, self.key)
                task.update(phase='COMMITTING', sha256=hashlib.sha256(b'hello').hexdigest())
                self.i.save(task)
                _, _, _, folder = self.i.storage(self.user, self.key)
                (self.owner/'data/downloads').mkdir(exist_ok=True)
                os.link(folder/'payload.part', self.owner/'data'/path)
                if unlink:
                    (folder/'payload.part').unlink()
                self.start(path=path)
                code, opened = self.worker(Response(), '2')
                self.assertEqual(code, 0); opened.assert_not_called()
                self.assertEqual(self.status()['state'], 'READY')
                self.assertEqual((self.owner/'data'/path).stat().st_nlink, 1)

    def test_terminal_lifetime_lock_excludes_import(self):
        lock = self.i.w.lifetime(self.user)
        try:
            with self.assertRaises(ValueError):
                self.start()
        finally:
            os.close(lock)

    def test_interrupted_commit_mutated_visible_file_is_not_marked_ready(self):
        self.start(); self.seed_partial(b'hello')
        task = self.i.load(self.user, self.key)
        task.update(phase='COMMITTING', sha256=hashlib.sha256(b'hello').hexdigest())
        self.i.save(task)
        _, _, _, folder = self.i.storage(self.user, self.key)
        (self.owner/'data/downloads').mkdir()
        final = self.owner/'data/downloads/archive.tar'
        os.link(folder/'payload.part', final)
        final.write_bytes(b'other')
        self.start()
        self.assertEqual(self.worker(Response(), '2')[0], 1)
        self.assertEqual(self.status()['errorCode'], 'CHANGED')
        self.assertEqual(final.read_bytes(), b'other')

    def test_history_is_bounded_without_systemctl_for_completed_tasks(self):
        self.start(); self.worker(Response())
        self.stopped_mock.reset_mock()
        result = self.call('list')
        self.assertEqual(result['total'], 1); self.assertEqual(result['limit'], 50)
        self.assertFalse(result['imports'][0]['canDiscard'])
        self.stopped_mock.assert_not_called()
        self.assertTrue(self.status()['canDiscard'])
        self.stopped_mock.return_value = False
        self.assertFalse(self.status()['canDiscard'])

    def test_discard_is_idempotent_clears_staging_not_completed_data(self):
        self.start(); self.seed_partial()
        task = self.i.load(self.user, self.key); self.i.reservation(task, 123)
        expected = {'discarded': True, 'operationId': self.key}
        self.assertEqual(self.call('discard', operationId=self.key), expected)
        self.assertEqual(self.call('discard', operationId=self.key), expected)
        self.assertEqual(self.cache._reserved(), 0)
        self.assertEqual(self.call('list')['total'], 0)
        self.key = str(uuid.uuid4()); self.start(); self.worker(Response())
        self.call('discard', operationId=self.key)
        self.assertEqual((self.owner/'data/downloads/archive.tar').read_bytes(), b'hello')

    def test_discard_rejects_active_unknown_foreign_path_and_live_file_lock(self):
        self.start(); self.seed_partial()
        for result in (False, OSError('unknown')):
            with self.subTest(result=result):
                self.stopped_mock.side_effect = result if isinstance(result, Exception) else None
                self.stopped_mock.return_value = False
                with self.assertRaisesRegex(ValueError, 'unconfirmed'):
                    self.call('discard', operationId=self.key)
        self.stopped_mock.side_effect = None; self.stopped_mock.return_value = True
        _, _, _, folder = self.i.storage(self.user, self.key)
        with (folder/'worker.lock').open('w') as lock:
            os.chmod(folder/'worker.lock', 0o600)
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, 'released'):
                self.call('discard', operationId=self.key)
        with self.assertRaises(ValueError):
            self.call('discard', operationId='../'+self.key)
        self.assertEqual(self.n.process('datasets.import.discard', {'userId': 'demo-user-2', 'operationId': self.key}),
                         {'discarded': True, 'operationId': self.key})
        self.assertEqual((folder/'payload.part').read_bytes(), b'hel')

    def test_discard_refuses_unexpected_symlink_and_preserves_commit_link(self):
        self.start(); self.seed_partial()
        _, _, _, folder = self.i.storage(self.user, self.key)
        target = self.base/'target'; target.write_text('keep')
        (folder/'unexpected').symlink_to(target)
        with self.assertRaises(ValueError):
            self.call('discard', operationId=self.key)
        self.assertEqual(target.read_text(), 'keep')
        self.assertTrue((folder/'task.json').exists())
        (folder/'unexpected').unlink()
        task = self.i.load(self.user, self.key); task['phase'] = 'COMMITTING'; self.i.save(task)
        final = self.owner/'data/preserved'; os.link(folder/'payload.part', final)
        self.call('discard', operationId=self.key)
        self.assertEqual(final.read_bytes(), b'hel'); self.assertEqual(final.stat().st_nlink, 1)

    def test_url_validation_public_addresses_and_mixed_dns(self):
        for url in ('http://example.com/f', 'https://example.com:8080/f', 'https://user:pass@example.com',
                    'https://localhost/f', 'https://example.com/f#secret', 'https://example.com/\nX',
                    'https://example.com\\@127.0.0.1', 'https://[fe80::1%en0]/'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.d.checked_url(url)
        self.assertEqual(self.d.checked_url(self.url)[0], 'cdn.example.com')
        for address in ('127.0.0.1', '10.1.2.3', '192.168.1.1', '100.64.0.1', '169.254.169.254',
                        '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1'):
            self.assertFalse(self.d.public_address(address), address)
        self.assertTrue(self.d.public_address('8.8.8.8'))
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443)),
                   (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]
        with patch.object(self.d.socket, 'getaddrinfo', return_value=records), self.assertRaisesRegex(ValueError, 'public'):
            self.d.resolve_public('mixed.example.com')

    def test_redirect_each_hop_checked_and_fixed_aliyun_referer(self):
        first = MagicMock(); first.getresponse.return_value = Response(b'', 302, {'Location': 'https://other.example.com/x'})
        second = MagicMock(); second.getresponse.return_value = Response()
        with patch.object(self.d, 'resolve_public', return_value=['checked']) as resolve, \
             patch.object(self.d, 'PinnedHTTPS', side_effect=[first, second]):
            conn, _ = self.d.open_download(self.url, source_kind='aliyun')
        self.assertIs(conn, second)
        self.assertEqual([call.args[0] for call in resolve.call_args_list], ['cdn.example.com', 'other.example.com'])
        headers = second.request.call_args.kwargs['headers']
        self.assertEqual(headers['Referer'], 'https://www.alipan.com/')
        self.assertNotIn('Cookie', headers); self.assertNotIn('Authorization', headers)
        first.getresponse.return_value = Response(b'', 302, {'Location': 'http://127.0.0.1/private'})
        with patch.object(self.d, 'resolve_public', return_value=['checked']), patch.object(self.d, 'PinnedHTTPS', return_value=first), self.assertRaises(ValueError):
            self.d.open_download(self.url)

    def test_clouddrive_headers_are_public_allowlisted_and_never_auth(self):
        headers={'User-Agent':'CloudDrive/1.1.1','Referer':'https://www.alipan.com/','Origin':'https://www.alipan.com'}
        self.assertEqual(self.d.checked_headers(headers,'aliyun'),headers)
        for bad in ({'Authorization':'Bearer private'},{'Cookie':'secret'}, {'User-Agent':'x\r\nCookie:secret'}, {'Referer':'https://evil.test/'}, {'Origin':'https://www.alipan.com/?secret=1'}):
            with self.assertRaises(ValueError):self.d.checked_headers(bad,'aliyun')
        with self.assertRaises(ValueError):self.d.checked_headers(headers,'https')
        response=Response(b'ok',200,{'Content-Length':'2'});connection=MagicMock();connection.getresponse.return_value=response
        with patch.object(self.d,'resolve_public',return_value=['checked']),patch.object(self.d,'PinnedHTTPS',return_value=connection):
            self.d.open_download(self.url,source_kind='aliyun',download_headers=headers)
        sent=connection.request.call_args.kwargs['headers'];self.assertEqual(sent['User-Agent'],'CloudDrive/1.1.1');self.assertNotIn('Cookie',sent)

    def test_clouddrive_descriptor_headers_stay_private_and_reach_worker(self):
        headers = {'User-Agent': 'CloudDrive/1.1.1', 'Referer': 'https://www.alipan.com/',
                   'Origin': 'https://www.alipan.com'}
        result = self.start(sourceKind='aliyun', expectedBytes=5,
                            expectedSha1=hashlib.sha1(b'hello').hexdigest(), downloadHeaders=headers)
        self.assertEqual(self.i.load(self.user, self.key)['downloadHeaders'], headers)
        for public in (result, self.status(), self.call('list')):
            self.assertNotIn('downloadHeaders', json.dumps(public))
            self.assertNotIn('CloudDrive/1.1.1', json.dumps(public))
            self.assertNotIn('NEVER-RETURN-THIS', json.dumps(public))
        self.assertNotIn('CloudDrive/1.1.1', repr(self.starts))
        _, _, _, folder = self.i.storage(self.user, self.key)
        self.assertEqual((folder/'task.json').stat().st_mode & 0o777, 0o600)
        code, opening = self.worker(Response())
        self.assertEqual(code, 0)
        self.assertEqual(opening.call_args.kwargs['download_headers'], headers)
        self.assertNotIn('downloadHeaders', self.status())

    def test_clouddrive_refresh_replaces_public_headers_without_changing_file_identity(self):
        digest = hashlib.sha1(b'hello').hexdigest()
        self.start(sourceKind='aliyun', expectedBytes=5, expectedSha1=digest,
                   downloadHeaders={'User-Agent': 'CloudDrive/old'})
        self.seed_partial(etag=None)
        headers = {'User-Agent': 'CloudDrive/new', 'Origin': 'https://www.alipan.com'}
        self.start(sourceKind='aliyun', expectedBytes=5, expectedSha1=digest,
                   downloadHeaders=headers, url='https://other.example.com/file?sig=REFRESHED')
        code, opening = self.worker(Response(b'lo', 206, {'Content-Range': 'bytes 3-4/5'}), '2')
        self.assertEqual(code, 0)
        self.assertEqual(opening.call_args.kwargs['download_headers'], headers)
        self.assertEqual(self.status()['sha1'], digest)

    def test_bad_descriptors_are_rejected_before_launch_or_private_record_change(self):
        bad = [None, [], True, 'PRIVATE', {'Authorization': 'Bearer PRIVATE_ACCOUNT'},
               {'Cookie': 'PRIVATE_COOKIE'}, {'Host': 'localhost'}, {'Range': 'bytes=0-'},
               {'User-Agent': 'x'*513}, {'User-Agent': ''}, {'User-Agent': 'x\x7f'},
               {'Referer': 'https://www.alipan.com@evil.example/'},
               {'Origin': 'https://www.alipan.com:443/'},
               {'Origin': 'https://www.alipan.com/?token=PRIVATE'},
               {'Origin': 'https://www.alipan.com/#PRIVATE'}, {'origin': 'https://www.alipan.com'}]
        # None deliberately means no provider headers; every other malformed descriptor fails.
        self.start(sourceKind='aliyun', downloadHeaders={'User-Agent': 'CloudDrive/1'})
        previous = self.i.load(self.user, self.key)
        launches = len(self.starts)
        for headers in bad[1:]:
            with self.subTest(headers=headers), self.assertRaises(ValueError) as failure:
                self.start(sourceKind='aliyun', downloadHeaders=headers)
            self.assertNotIn('PRIVATE', str(failure.exception))
            self.assertEqual(self.i.load(self.user, self.key), previous)
            self.assertEqual(len(self.starts), launches)
        with self.assertRaises(ValueError):
            self.start(sourceKind='https', downloadHeaders={'User-Agent': 'CloudDrive/1'})

    def test_redirects_forward_only_checked_public_headers_and_recheck_each_destination(self):
        first, second = MagicMock(), MagicMock()
        first.getresponse.return_value = Response(b'', 302, {'Location': 'https://other.example.com/file'})
        second.getresponse.return_value = Response(b'hello')
        headers = {'User-Agent': 'CloudDrive/1', 'Referer': 'https://www.alipan.com/',
                   'Origin': 'https://www.alipan.com'}
        with patch.object(self.d, 'resolve_public', return_value=['checked']) as resolve, \
                patch.object(self.d, 'PinnedHTTPS', side_effect=[first, second]):
            self.d.open_download(self.url, source_kind='aliyun', download_headers=headers)
        self.assertEqual([call.args[0] for call in resolve.call_args_list],
                         ['cdn.example.com', 'other.example.com'])
        for connection in (first, second):
            sent = connection.request.call_args.kwargs['headers']
            self.assertEqual(set(sent), {'User-Agent', 'Referer', 'Origin', 'Accept-Encoding'})
            self.assertEqual(sent['User-Agent'], headers['User-Agent'])
            self.assertNotIn('Authorization', sent); self.assertNotIn('Cookie', sent)

    def test_worker_revalidates_private_headers_before_network_and_sanitizes_failure(self):
        self.start(sourceKind='aliyun', downloadHeaders={'User-Agent': 'CloudDrive/1'})
        task = self.i.load(self.user, self.key)
        task['downloadHeaders'] = {'Authorization': 'Bearer PRIVATE_ACCOUNT'}
        self.i.save(task)
        with patch.object(self.d, 'resolve_public') as resolve, patch.object(self.d, 'PinnedHTTPS') as connection:
            self.assertEqual(self.i.worker(self.user, self.key, '1'), 1)
        resolve.assert_not_called(); connection.assert_not_called()
        self.assertEqual(self.status()['errorCode'], 'HEADERS')
        self.assertNotIn('PRIVATE_ACCOUNT', json.dumps(self.status()))

    def test_pinned_connection_uses_validated_address_and_tls_hostname(self):
        context = MagicMock(); sock = MagicMock()
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]
        with patch.object(self.d.ssl, 'create_default_context', return_value=context), \
             patch.object(self.d.socket, 'socket', return_value=sock), \
             patch.object(self.d.socket, 'getaddrinfo') as dns:
            connection = self.d.PinnedHTTPS('original.example.com', records)
            connection.connect()
        dns.assert_not_called()
        sock.connect.assert_called_once_with(('8.8.8.8', 443))
        context.wrap_socket.assert_called_once_with(sock, server_hostname='original.example.com')


if __name__ == '__main__':
    unittest.main()
