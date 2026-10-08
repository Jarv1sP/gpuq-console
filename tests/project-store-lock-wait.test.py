"""Real flock contention after file authorization, using synthetic uploads."""
import base64
import fcntl
import importlib.util
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('store_lock_upload_fixture', Path(__file__).with_name('project-upload-recovery.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class StoreLockWait(unittest.TestCase):
    setUp = fixture.UploadRecovery.setUp
    tearDown = fixture.UploadRecovery.tearDown
    request = fixture.UploadRecovery.request
    status = fixture.UploadRecovery.status

    def put(self, request, data, offset, final=False):
        # The campus listener calls this writer after authorization. Do not use
        # the legacy RPC file-body endpoint, which current nodes reject.
        return self.ops.files('files.put', {**request, 'offset': offset,
            'final': final, 'data': base64.b64encode(data).decode()})

    def staged_bytes(self):
        return {p.name: p.read_bytes() for p in self.ops.transfer_dir(self.args).iterdir() if p.is_file()}

    def test_short_store_contention_reads_original_upload_after_lock_releases(self):
        request = self.request()
        self.put(request, b'ab', 0)
        original = self.staged_bytes()
        lock = self.ops.store._project(*self.ops.identity(self.args))[0] / '.lock'
        info = lock.stat()
        with lock.open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            released = threading.Event()
            def release():
                fcntl.flock(held, fcntl.LOCK_UN)
                released.set()
            timer = threading.Timer(0.15, release)
            timer.start()
            try:
                result = self.status(request)
                self.assertTrue(released.is_set())
            finally:
                timer.join()
        self.assertEqual((result['uploadId'], result['receivedBytes']), (request['uploadId'], 2))
        self.assertEqual(original, self.staged_bytes())
        after = lock.stat()
        self.assertEqual((info.st_ino, info.st_uid, info.st_mode), (after.st_ino, after.st_uid, after.st_mode))

    def test_short_store_contention_executes_final_write_exactly_once(self):
        request = self.request()
        self.put(request, b'ab', 0)
        lock = self.ops.store._project(*self.ops.identity(self.args))[0] / '.lock'
        with lock.open('a') as held, patch.object(self.ops, 'upload', wraps=self.ops.upload) as upload:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            timer = threading.Timer(0.15, lambda: fcntl.flock(held, fcntl.LOCK_UN))
            timer.start()
            try:
                result = self.put(request, b'cd', 2, True)
            finally:
                timer.join()
            upload.assert_called_once()
            self.assertEqual(upload.call_args.args[0]['uploadId'], request['uploadId'])
            self.assertEqual(upload.call_args.args[0]['offset'], 2)
        self.assertTrue(result['complete'])
        self.assertEqual(self.status(request)['state'], 'COMPLETE')
        self.assertEqual(self.ops.store.dev_paths(*self.ops.identity(self.args))['code'].joinpath('train.py').read_bytes(), b'abcd')

    def test_store_timeout_keeps_fragments_and_never_enters_the_write(self):
        request = self.request()
        self.put(request, b'ab', 0)
        original = self.staged_bytes()
        store_module = sys.modules[type(self.ops.store).__module__]
        lock = self.ops.store._project(*self.ops.identity(self.args))[0] / '.lock'
        with lock.open('a') as held, patch.object(store_module, 'PROJECT_LOCK_WAIT_SECONDS', 0.15, create=True), patch.object(self.ops, 'upload', wraps=self.ops.upload) as upload:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, 'published or changed') as caught:
                self.put(request, b'cd', 2, True)
            elapsed = time.monotonic() - started
            self.assertEqual(caught.exception.code, 'project_busy')
            self.assertGreaterEqual(elapsed, 0.13)
            self.assertLess(elapsed, 1)
            upload.assert_not_called()
        self.assertEqual(original, self.staged_bytes())
        self.assertEqual(self.status(request)['receivedBytes'], 2)

    def test_short_lifecycle_contention_keeps_the_original_reader_scope(self):
        request = self.request()
        self.put(request, b'ab', 0)
        original = self.staged_bytes()
        folder = self.ops.store.lifecycle_folder(*self.ops.identity(self.args))
        lock = folder / (self.args['project'] + '.lock')
        with lock.open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            timer = threading.Timer(0.15, lambda: fcntl.flock(held, fcntl.LOCK_UN))
            timer.start()
            try:
                result = self.status(request)
            finally:
                timer.join()
        self.assertEqual((result['uploadId'], result['receivedBytes']), (request['uploadId'], 2))
        self.assertEqual(original, self.staged_bytes())

    def test_other_lock_errors_are_not_retried(self):
        lock = self.ops.store._project(*self.ops.identity(self.args))[0] / '.lock'
        with patch.object(fcntl, 'flock', side_effect=OSError(5, 'synthetic I/O failure')) as acquire:
            with self.assertRaisesRegex(OSError, 'I/O failure'):
                with self.ops.store._file_lock(lock):
                    self.fail('must not enter an unsafe write')
        acquire.assert_called_once()

    def test_unsafe_lock_permissions_reject_before_attempting_flock(self):
        lock = self.ops.store._project(*self.ops.identity(self.args))[0] / '.lock'
        lock.touch(mode=0o600, exist_ok=True)
        lock.chmod(0o666)
        with patch.object(fcntl, 'flock') as acquire:
            with self.assertRaisesRegex(ValueError, 'Unsafe project lock'):
                with self.ops.store._file_lock(lock):
                    self.fail('must not enter an unsafe write')
        acquire.assert_not_called()
        self.assertEqual(lock.stat().st_uid, os.geteuid())


if __name__ == '__main__':
    unittest.main()
