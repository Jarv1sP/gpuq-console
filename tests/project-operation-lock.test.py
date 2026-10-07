"""Real local flock contention, no remote services or user files."""
import fcntl
import importlib.util
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('upload_lock_fixture', Path(__file__).with_name('project-upload-recovery.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class OperationLock(fixture.UploadRecovery):
    def test_short_contention_waits_before_reading_original_upload(self):
        request = self.request()
        self.put(request, b'ab', 0)
        path = self.ops.folder/(self.ops.key(self.args)+'.lock')
        with path.open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            released = threading.Event()
            def release():
                fcntl.flock(held, fcntl.LOCK_UN)
                released.set()
            timer = threading.Timer(0.15, release)
            timer.start()
            try:
                state = self.status(request)
                self.assertTrue(released.is_set())
            finally:
                timer.join()
        self.assertEqual((state['uploadId'], state['receivedBytes']), (request['uploadId'], 2))
        self.assertTrue(self.put(request, b'cd', 2, True)['complete'])

    def test_timeout_preserves_original_upload_and_has_explicit_recovery_error(self):
        request = self.request()
        self.put(request, b'ab', 0)
        before = {p.name:p.read_bytes() for p in self.ops.transfer_dir(self.args).iterdir() if p.is_file()}
        path = self.ops.folder/(self.ops.key(self.args)+'.lock')
        with path.open('a') as held, patch.object(sys.modules[type(self.ops).__module__], 'PROJECT_LOCK_WAIT_SECONDS', 0.15):
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, 'busy.*original upload'):
                self.put(request, b'cd', 2, True)
            self.assertLess(time.monotonic()-started, 1)
        self.assertEqual(before, {p.name:p.read_bytes() for p in self.ops.transfer_dir(self.args).iterdir() if p.is_file()})
        self.assertEqual(self.status(request)['receivedBytes'], 2)

    def test_other_lock_errors_are_not_retried_or_hidden(self):
        with patch.object(self.ops.store, 'lifetime'), patch.object(fcntl, 'flock', side_effect=OSError(5, 'synthetic I/O failure')) as lock:
            with self.assertRaisesRegex(OSError, 'I/O failure'):
                with self.ops.guard(self.args):
                    self.fail('operation must not run')
        self.assertEqual(lock.call_count, 1)

    def test_unsafe_operation_lock_rejects_before_upload(self):
        path = self.ops.folder/(self.ops.key(self.args)+'.lock')
        path.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'Unsafe project operation lock'):
            self.put(self.request(), b'abcd', 0, True)

    def test_owner_quota_route_does_not_require_or_accept_a_project(self):
        with patch.object(self.node, 'storage_quota_status', return_value={'enabled':False}) as quota:
            self.assertEqual(self.node.process('projects.quota', {'userId':self.args['userId']}), {'enabled':False})
            quota.assert_called_once_with(self.args['userId'])
            for extra in ({'project':'test'}, {'hostAdmin':True}, {'userId':self.args['userId'], 'ownerId':'demo-user-4'}):
                with self.assertRaisesRegex(ValueError, 'Invalid quota status fields'):
                    self.node.process('projects.quota', {'userId':self.args['userId'], **extra})


if __name__ == '__main__':
    unittest.main()
