"""Personal upload security/recovery tests; local temporary files only."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY/filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


D = module('personal_dataset_cache_test', 'dataset-cache.py')
U = module('personal_dataset_upload_test', 'dataset-upload.py')


class PersonalUploads(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.cache = D.DatasetCache(self.base/'cache', reserve_bytes=0)
        def workspace(user):
            if not isinstance(user, str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)', user):
                raise ValueError('Invalid identity')
        self.calls = []
        self.node = SimpleNamespace(dataset_cache=lambda: (D, self.cache),
            CONFIG={'datasets': {}}, workspace=workspace, HERE=DEPLOY, ENV={},
            run=lambda argv, **kwargs: self.calls.append(argv))
        self.u = U.DatasetUploads(self.node)
        self.active = patch.object(self.u, 'active', return_value=True)
        self.active.start()
        self.user = 'demo-user-1'

    def tearDown(self):
        self.active.stop()
        for root, dirs, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root)/name
                if not path.is_symlink():
                    os.chmod(path, 0o600)
        self.temp.cleanup()

    def call(self, action, user=None, **args):
        return self.u.process('datasets.upload.'+action, {'userId': user or self.user, 'hostAdmin': False, **args})

    def admit(self, files=None, name='sample', key=None, user=None, directories=None, declared_total=None):
        files = {'train.txt': b'hello-world', 'empty': b''} if files is None else files
        manifest = {'schema': 1, 'directories': directories or [], 'files': [
            {'path': p, 'size': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for p, v in files.items()]}
        raw = json.dumps(manifest, separators=(',', ':'), ensure_ascii=False).encode()
        args = dict(name=name, key=key or str(uuid.uuid4()), manifestBytes=len(raw),
            manifestSha256=hashlib.sha256(raw).hexdigest(), totalBytes=sum(map(len, files.values())) if declared_total is None else declared_total,
            entries=len(files)+len(manifest['directories']))
        result = self.call('begin', user=user, **args)
        return result, args, raw, files

    def seal(self, files=None, user=None, **kwargs):
        response, args, raw, content = self.admit(files=files, user=user, **kwargs)
        upload = response['uploadId']
        for offset in range(0, len(raw), D.CHUNK_BYTES):
            self.call('manifest', user=user, uploadId=upload, offset=offset,
                data=base64.b64encode(raw[offset:offset+D.CHUNK_BYTES]).decode())
        response = self.call('seal', user=user, uploadId=upload)
        self.assertEqual(response['state'], 'SEALING')
        self.assertEqual(self.u.worker(user or self.user, upload, 'seal'), 0)
        return self.call('status', user=user, uploadId=upload), args, content

    def fill(self, upload, files, user=None):
        for path, data in files.items():
            for offset in range(0, max(1, len(data)), D.CHUNK_BYTES):
                self.call('chunk', user=user, uploadId=upload, path=path, offset=offset,
                    data=base64.b64encode(data[offset:offset+D.CHUNK_BYTES]).decode())

    def test_full_lifecycle_is_private_immutable_and_token_free(self):
        result, _, files = self.seal()
        upload = result['uploadId']
        self.assertEqual(result['state'], 'UPLOADING')
        self.assertEqual(result['dataset'], 'u-'+hashlib.sha256(self.user.encode()).hexdigest()[:16]+'-sample')
        self.assertNotIn('token', json.dumps(result).lower())
        self.assertNotIn(str(self.base), json.dumps(result))
        self.assertFalse(self.call('status', uploadId=upload, path='empty')['file']['complete'])
        self.fill(upload, files)
        response = self.call('commit', uploadId=upload)
        self.assertEqual(response['state'], 'PUBLISHING')
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        self.assertEqual(self.call('status', uploadId=upload)['state'], 'READY')
        self.assertEqual(self.call('status', uploadId=upload, path='empty')['file']['complete'], True)
        for action, args in [('discard', {}), ('chunk', {'path': 'train.txt', 'offset': 0, 'data': 'eA=='})]:
            with self.assertRaises(ValueError):
                self.call(action, uploadId=upload, **args)
        ready = self.cache._paths(result['dataset'], result['version'])['ready']/'data'
        self.assertEqual((ready/'train.txt').read_bytes(), files['train.txt'])
        self.assertEqual((ready/'train.txt').stat().st_mode & 0o777, 0o444)
        self.assertEqual(self.cache._reserved(), 0)

    def test_archive_intent_precedes_commit_and_lost_ack_keeps_ready(self):
        result, _, files = self.seal()
        upload = result['uploadId']
        self.fill(upload, files)
        events = []
        def begin(args):
            self.assertEqual(self.cache.status(D.Principal(self.user), result['dataset'], result['version'])['state'], 'STAGING')
            events.append(args)
            return {'id': upload}
        def ready(args):
            self.assertEqual(self.cache.status(D.Principal(self.user), result['dataset'], result['version'])['state'], 'READY')
            raise OSError('simulated lost acknowledgement')
        self.node.CONFIG['storageArchive'] = {'enabled': True}
        self.node.storage_archive = lambda: SimpleNamespace(outbox_begin=begin, outbox_ready=ready)
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        self.assertEqual(self.call('status', uploadId=upload)['state'], 'READY')
        self.assertEqual(events, [{'opId': upload, 'userId': self.user, 'reference': {'dataset': result['dataset'], 'version': result['version']}, 'origin': 'upload'}])
        self.assertEqual(self.u.load(self.user, upload)['archiveEventId'], upload)

    def test_archive_intent_failure_prevents_new_publication(self):
        result, _, files = self.seal()
        self.fill(result['uploadId'], files)
        self.node.CONFIG['storageArchive'] = {'enabled': True}
        def unavailable(args):
            raise ValueError('outbox unavailable')
        self.node.storage_archive = lambda: SimpleNamespace(outbox_begin=unavailable)
        self.call('commit', uploadId=result['uploadId'])
        self.assertEqual(self.u.worker(self.user, result['uploadId'], 'commit'), 1)
        self.assertNotEqual(self.cache.status(D.Principal(self.user), result['dataset'], result['version'])['state'], 'READY')

    def test_peer_copy_never_recursively_enrolls_archive(self):
        result, _, files = self.seal()
        self.fill(result['uploadId'], files)
        self.node.CONFIG['storageArchive'] = {'enabled': True}
        def forbidden():
            raise AssertionError('peer copy must not create an archive intent')
        self.node.storage_archive = forbidden
        self.call('commit', uploadId=result['uploadId'])
        session = self.u.load(self.user, result['uploadId'])
        session['workerUnit'] = 'gpuq-transfer-test'
        self.u.save(session)
        self.assertEqual(self.u.worker(self.user, result['uploadId'], 'commit'), 0)
        self.assertNotIn('archiveEventId', self.u.load(self.user, result['uploadId']))

    def test_same_name_different_users_and_spoofing(self):
        one, _, _ = self.seal()
        two, _, _ = self.seal(user='demo-user-2')
        self.assertNotEqual(one['dataset'], two['dataset'])
        with self.assertRaises(FileNotFoundError):
            self.call('status', user='demo-user-2', uploadId=one['uploadId'])
        for extra in ({'hostAdmin': True}, {'hostAdmin': 0}, {'hostAdmin': 'false'}, {'owners': [self.user]},
                      {'sourceId': '/tmp'}, {'path': '/data2'}, {'actor': {}}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.call('status', uploadId=one['uploadId'], **extra)
        outsider = D.Principal('demo-user-2')
        with self.assertRaises(PermissionError):
            self.cache.status(outsider, one['dataset'], one['version'])

    def test_begin_idempotency_manifest_resume_and_key_conflict(self):
        response, args, raw, _ = self.admit()
        upload = response['uploadId']
        self.call('manifest', uploadId=upload, offset=0, data=base64.b64encode(raw[:20]).decode())
        self.assertEqual(self.call('begin', **args)['manifestOffset'], 20)
        self.assertEqual(self.call('manifest', uploadId=upload, offset=0,
            data=base64.b64encode(raw[:20]).decode())['offset'], 20)
        with self.assertRaisesRegex(ValueError, 'different specification'):
            self.call('begin', **{**args, 'name': 'different'})
        with self.assertRaises(ValueError):
            self.call('manifest', uploadId=upload, offset=0, data=base64.b64encode(b'wrong').decode())
        with self.assertRaises(ValueError):
            self.call('seal', uploadId=upload)

    def test_paths_wrong_bytes_offsets_and_index_identity(self):
        result, _, files = self.seal()
        upload = result['uploadId']
        for path in ('../secret', '/etc/passwd', 'unknown', '.ssh/id', 'a\\b'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.call('chunk', uploadId=upload, path=path, offset=0, data='eA==')
        with self.assertRaises(ValueError):
            self.call('chunk', uploadId=upload, path='train.txt', offset=1, data='eA==')
        chunk = dict(uploadId=upload, path='train.txt', offset=0, data=base64.b64encode(b'hello').decode())
        self.call('chunk', **chunk)
        first = self.cache._reserved()
        self.call('chunk', **chunk)
        self.assertEqual(self.cache._reserved(), first)
        with self.assertRaises(ValueError):
            self.call('chunk', **{**chunk, 'data': base64.b64encode(b'wrong').decode()})
        index = self.u.folder(self.user, upload)/'index.sqlite'
        os.utime(index, None)
        with self.assertRaisesRegex(ValueError, 'index changed'):
            self.call('chunk', **chunk)

    def test_manifest_hash_totals_and_path_validation(self):
        for broken in ('hash', 'totals', 'path'):
            response, args, raw, _ = self.admit(name='bad-'+broken,
                files={'../escape': b'bad'} if broken == 'path' else {'x': b'abc'},
                declared_total=4 if broken == 'totals' else None)
            upload = response['uploadId']
            if broken == 'hash':
                raw = b' '+raw[1:]
            self.call('manifest', uploadId=upload, offset=0, data=base64.b64encode(raw).decode())
            self.call('seal', uploadId=upload)
            self.assertEqual(self.u.worker(self.user, upload, 'seal'), 1)
            self.assertEqual(self.call('status', uploadId=upload)['state'], 'FAILED')
            self.call('discard', uploadId=upload)
            self.assertEqual(self.u.worker(self.user, upload, 'discard'), 0)
        self.assertEqual(self.cache._reserved(), 0)

    def test_quota_and_public_cache_share_reservations(self):
        self.node.CONFIG['datasets']['uploads'] = {'maxUserBytes': 100000, 'maxActiveUploads': 1}
        self.u = U.DatasetUploads(self.node)
        one, _, _, _ = self.admit(files={'x': b'1234567890'})
        self.assertGreater(self.cache._reserved(), 10)
        with self.assertRaisesRegex(ValueError, 'unfinished'):
            self.admit(files={'x': b'1'}, name='second')
        self.u.limits['maxActiveUploads'] = 4
        with self.assertRaisesRegex(ValueError, 'quota'):
            self.admit(files={'x': b'123456'}, name='second')
        with patch.object(D.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=1, f_frsize=1)):
            with self.assertRaisesRegex(ValueError, 'free space'):
                self.call('manifest', uploadId=one['uploadId'], offset=0, data='eA==')

    def test_shared_volume_policy_keeps_space_and_concurrency_guards(self):
        self.node.CONFIG['datasets']['uploads'] = {'maxUserBytes': 0, 'maxActiveUploads': 2}
        self.u = U.DatasetUploads(self.node)
        one, _, _, _ = self.admit(files={'x': b'one'})
        two, _, _, _ = self.admit(files={'x': b'two'}, name='second')
        self.assertNotEqual(one['uploadId'], two['uploadId'])
        self.assertGreater(self.cache._reserved(), 100000)
        with self.assertRaisesRegex(ValueError, 'unfinished'):
            self.admit(files={'x': b'three'}, name='third')
        self.u.limits['maxActiveUploads'] = 4
        with patch.object(self.cache, '_free', side_effect=ValueError('Insufficient free space')):
            with self.assertRaisesRegex(ValueError, 'free space'):
                self.admit(files={'x': b'four'}, name='fourth')

    def test_only_user_byte_budget_accepts_explicit_zero(self):
        for key in U.DEFAULTS:
            self.node.CONFIG['datasets']['uploads'] = {key: 0}
            if key == 'maxUserBytes':
                self.assertEqual(U.DatasetUploads(self.node).limits[key], 0)
            else:
                with self.assertRaises(ValueError):
                    U.DatasetUploads(self.node)
        for value in (False, -1, None, '0'):
            self.node.CONFIG['datasets']['uploads'] = {'maxUserBytes': value}
            with self.assertRaises(ValueError):
                U.DatasetUploads(self.node)

    def test_failed_publish_can_receive_remaining_chunks_and_retry(self):
        result, args, files = self.seal()
        upload = result['uploadId']
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 1)
        failed = self.call('begin', **args)
        self.assertEqual((failed['state'], failed['resumeState']), ('FAILED', 'UPLOADING'))
        self.fill(upload, files)
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)

    def test_lost_worker_receipt_and_ready_eviction_are_not_false_success(self):
        result, args, files = self.seal()
        upload = result['uploadId']
        self.fill(upload, files)
        self.call('commit', uploadId=upload)
        with patch.object(self.u, 'active', return_value=False):
            status = self.call('begin', **args)
            self.assertEqual((status['state'], status['resumeState']), ('FAILED', 'UPLOADING'))
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        self.cache.evict(D.Principal(self.user, True), result['dataset'], result['version'])
        missing = self.call('status', uploadId=upload)
        self.assertEqual((missing['state'], missing['resumeState']), ('FAILED', 'RECEIVING_MANIFEST'))
        self.call('seal', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'seal'), 0)
        self.fill(upload, files)
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)

    def test_discard_unfinished_upload_releases_storage_without_other_data(self):
        one, _, files = self.seal()
        two, _, _ = self.seal(name='keep')
        self.fill(one['uploadId'], files)
        self.call('discard', uploadId=one['uploadId'])
        self.assertEqual(self.u.worker(self.user, one['uploadId'], 'discard'), 0)
        self.assertEqual(self.call('status', uploadId=one['uploadId'])['state'], 'DISCARDED')
        self.assertEqual(self.call('status', uploadId=two['uploadId'])['state'], 'UPLOADING')
        with self.assertRaises(FileNotFoundError):
            self.cache.status(D.Principal(self.user), one['dataset'], one['version'])

    def test_crash_after_stage_creation_is_discardable(self):
        response, _, raw, _ = self.admit()
        upload = response['uploadId']
        self.call('manifest', uploadId=upload, offset=0, data=base64.b64encode(raw).decode())
        self.call('seal', uploadId=upload)
        original = self.u.save
        def crash(value):
            if value['state'] == 'UPLOADING':
                raise KeyboardInterrupt('simulated hard worker kill')
            return original(value)
        with patch.object(self.u, 'save', side_effect=crash), self.assertRaises(KeyboardInterrupt):
            self.u.worker(self.user, upload, 'seal')
        session = self.u.load(self.user, upload)
        self.assertIn('version', session)
        self.assertEqual(self.cache.status(D.Principal(self.user), session['dataset'], session['version'])['state'], 'STAGING')
        with patch.object(self.u, 'active', return_value=False):
            self.call('discard', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'discard'), 0)
        self.assertEqual(self.cache._reserved(), 0)
        with self.assertRaises(FileNotFoundError):
            self.cache.status(D.Principal(self.user), session['dataset'], session['version'])

    def test_chunk_fsync_accounting_crash_recovers_without_tree_scan(self):
        result, _, _ = self.seal(files={'x': b'1234567890'})
        upload = result['uploadId']
        original = D._write_json
        def crash(path, value, *args, **kwargs):
            if path.name == 'TRANSFER.json' and value['remainingBytes'] == 5:
                raise KeyboardInterrupt('simulated kill after payload fsync')
            return original(path, value, *args, **kwargs)
        with patch.object(D, '_write_json', side_effect=crash), self.assertRaises(KeyboardInterrupt):
            self.call('chunk', uploadId=upload, path='x', offset=0, data=base64.b64encode(b'12345').decode())
        with patch.object(D, '_manifest', side_effect=AssertionError('chunk must not parse manifest')):
            self.call('chunk', uploadId=upload, path='x', offset=5, data=base64.b64encode(b'67890').decode())
        stage = self.cache._paths(result['dataset'], result['version'])['.staging']
        self.assertEqual(self.cache._transfer(stage)['remainingBytes'], 0)
        self.assertGreater(self.cache._reserved(), 0)  # Metadata remains reserved until READY.
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        self.assertEqual(self.cache._reserved(), 0)

    def test_owner_change_and_symlinks_fail_closed(self):
        result, _, _ = self.seal(files={'x': b'abc'})
        upload = result['uploadId']
        path = self.cache._paths(result['dataset'], result['version'])['.staging']/'data'/'x'
        secret = self.base/'not-a-dataset'
        secret.write_bytes(b'keep')
        path.symlink_to(secret)
        with self.assertRaises(OSError):
            self.call('chunk', uploadId=upload, path='x', offset=0, data='YWJj')
        self.assertEqual(secret.read_bytes(), b'keep')
        path.unlink()
        self.cache.set_owners(D.Principal(self.user, True), result['dataset'], ['demo-user-2'])
        with self.assertRaises(PermissionError):
            self.call('chunk', uploadId=upload, path='x', offset=0, data='YWJj')

    def test_no_small_manifest_entry_limit_and_full_limits_remain(self):
        result, _, _ = self.seal(files={str(i): b'' for i in range(5000)})
        self.assertEqual(result['entries'], 5000)
        self.assertEqual(D.MAX_ENTRIES, 500000)
        self.assertEqual(D.MAX_JSON_BYTES, 64*1024**2)

    def test_admin_unregister_retires_only_missing_version_and_frees_quota(self):
        result, args, files = self.seal()
        upload = result['uploadId']
        self.fill(upload, files)
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        self.u.limits['maxUserUploads'] = 1
        self.u.limits['maxUserBytes'] = self.u.load(self.user, upload)['reserveBytes']
        with self.assertRaisesRegex(ValueError, 'count limit'):
            self.admit(name='second')
        self.cache.unregister(D.Principal(self.user, True), result['dataset'], result['version'])
        # New admission also reconciles old READY histories, without requiring
        # callers to poll each old upload first.
        second, _, _, _ = self.admit(name='second')
        self.assertEqual(second['state'], 'RECEIVING_MANIFEST')
        self.assertEqual(self.call('begin', **args)['state'], 'DISCARDED')
        self.assertFalse((self.u.folder(self.user, upload)/'index.sqlite').exists())
        self.assertFalse((self.u.folder(self.user, upload)/'manifest.part').exists())
        self.assertFalse(self.u.binding(result['dataset'], result['version']).exists())

    def test_missing_registration_with_ready_or_read_error_never_retires(self):
        result, _, files = self.seal()
        upload = result['uploadId']
        self.fill(upload, files)
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        with patch.object(self.cache, '_record_identity', side_effect=OSError('simulated I/O failure')):
            with self.assertRaises(OSError):
                self.call('status', uploadId=upload)
        version = self.cache._paths(result['dataset'])['.registry']/(result['version']+'.json')
        version.unlink()  # Corruption, not a completed administrator unregister.
        with self.assertRaisesRegex(ValueError, 'replicas or leases'):
            self.call('status', uploadId=upload)
        self.assertEqual(self.u.load(self.user, upload)['state'], 'READY')
        self.assertTrue((self.u.folder(self.user, upload)/'index.sqlite').exists())

    def test_publish_rechecks_exclusive_ownership_after_hashing(self):
        result, _, files = self.seal()
        upload = result['uploadId']
        self.fill(upload, files)
        self.call('commit', uploadId=upload)
        scan = D._scan
        def change_owners(path):
            actual = scan(path)
            self.cache.set_owners(D.Principal(self.user, True), result['dataset'], [self.user, 'demo-user-2'])
            return actual
        with patch.object(D, '_scan', side_effect=change_owners):
            self.assertEqual(self.u.worker(self.user, upload, 'commit'), 1)
        self.assertFalse(self.cache._paths(result['dataset'], result['version'])['ready'].exists())
        self.assertEqual(self.call('status', uploadId=upload)['state'], 'FAILED')

    def test_empty_directory_metadata_and_inode_reservations_survive_seal(self):
        result, _, _ = self.seal(files={}, directories=['empty-tree'])
        upload = result['uploadId']
        session = self.u.load(self.user, upload)
        reserved = D._read_json(self.u.reservation(self.user, upload))
        self.assertEqual(reserved, self.u.reservation_value(session, sealed=True))
        self.assertGreaterEqual(reserved['bytes'], 8192)
        self.assertEqual(reserved['inodes'], 17)
        self.call('commit', uploadId=upload)
        # Disk bytes alone cannot permit an inode-starved empty tree to publish.
        low = SimpleNamespace(f_bavail=1024**5, f_frsize=1, f_files=10000, f_favail=1024)
        with patch.object(D.os, 'fstatvfs', return_value=low):
            self.assertEqual(self.u.worker(self.user, upload, 'commit'), 1)
        stage = self.cache._paths(result['dataset'], result['version'])['.staging']
        self.assertFalse((stage/'data'/'empty-tree').exists())
        self.assertEqual(self.call('status', uploadId=upload)['state'], 'FAILED')
        self.call('commit', uploadId=upload)
        self.assertEqual(self.u.worker(self.user, upload, 'commit'), 0)
        self.assertEqual(self.cache._upload_reserved(), (0, 0))

    def test_zero_byte_entries_and_canceled_history_have_finite_limits(self):
        self.u.limits['maxUserEntries'] = 1
        one, _, _, _ = self.admit(files={'empty': b''})
        with self.assertRaisesRegex(ValueError, 'entry quota'):
            self.admit(files={'second': b''}, name='another')
        self.call('discard', uploadId=one['uploadId'])
        self.assertEqual(self.u.worker(self.user, one['uploadId'], 'discard'), 0)
        self.u.limits['maxUserSessions'] = 1
        with self.assertRaisesRegex(ValueError, 'history limit'):
            self.admit(files={'empty': b''}, name='another')

    def test_ready_recovery_persists_receipt_and_releases_active_upload_slot(self):
        result, args, files = self.seal()
        upload = result['uploadId']
        self.fill(upload, files)
        self.call('commit', uploadId=upload)
        save = self.u.save
        def kill_after_publish(session):
            if session['state'] == 'READY':
                raise KeyboardInterrupt('simulated kill before publication receipt')
            return save(session)
        with patch.object(self.u, 'save', side_effect=kill_after_publish), self.assertRaises(KeyboardInterrupt):
            self.u.worker(self.user, upload, 'commit')
        self.assertEqual(self.u.load(self.user, upload)['state'], 'PUBLISHING')
        with patch.object(self.u, 'active', return_value=False):
            self.assertEqual(self.call('begin', **args)['state'], 'READY')
        self.assertEqual(self.u.load(self.user, upload)['state'], 'READY')
        self.assertEqual(self.cache._reserved(), 0)
        self.u.limits['maxActiveUploads'] = 1
        self.assertEqual(self.admit(name='another')[0]['state'], 'RECEIVING_MANIFEST')


if __name__ == '__main__':
    unittest.main()
