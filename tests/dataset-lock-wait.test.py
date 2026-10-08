"""Finite lock acquisition waits: no operation replay, no production writes."""
from concurrent.futures import ThreadPoolExecutor
import errno
import importlib.util
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('dataset_lock_wait', Path(__file__).resolve().parents[1]/'deploy'/'dataset-cache.py')
D = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(D)


class LockWaitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache = D.DatasetCache(Path(self.temp.name).resolve()/'cache', reserve_bytes=0, lock_timeout=0.01)

    def tearDown(self):
        self.temp.cleanup()

    def acquire(self, **policy):
        with D.wait_for_locks(**policy), self.cache._locked():
            return 'acquired'

    def test_short_competing_lock_release_succeeds_without_replaying_body(self):
        calls = []
        def work():
            with D.wait_for_locks(timeout=1, total=1), self.cache._locked():
                calls.append('body')
                return True
        with ThreadPoolExecutor() as pool:
            with self.cache._locked():
                result = pool.submit(work)
                time.sleep(0.08)
                self.assertFalse(result.done())
            self.assertTrue(result.result(2))
        self.assertEqual(calls, ['body'])

    def test_total_budget_bounds_a_contended_lock(self):
        with ThreadPoolExecutor() as pool, self.cache._locked():
            start = time.monotonic()
            with self.assertRaises(D.CacheBusy) as caught:
                pool.submit(self.acquire, timeout=1, total=0.06).result(2)
            self.assertLess(time.monotonic()-start, 0.5)
            self.assertEqual(caught.exception.lock_wait, {'scope':'CACHE', 'limit':'TOTAL_BUDGET', 'timeoutSeconds':0.06})

    def test_single_wait_limit_and_version_scope_do_not_expose_lock_path(self):
        name='.locks/private-dataset.'+'a'*64+'.lock'
        with self.cache._lock_file(name):
            with D.wait_for_locks(timeout=.01,total=1), self.assertRaises(D.CacheBusy) as caught:
                with self.cache._lock_file(name):self.fail('contended lock body ran')
        self.assertEqual(caught.exception.lock_wait, {'scope':'VERSION', 'limit':'SINGLE_WAIT', 'timeoutSeconds':.01})
        self.assertNotIn('private-dataset', str(caught.exception))

    def test_nested_helpers_share_cumulative_budget_instead_of_resetting(self):
        clock = [0.0]
        def sleep(seconds):clock[0] += seconds
        # Deterministic contention at two different acquisitions. The second
        # gets only the unspent budget, even through a nested helper scope.
        with D.wait_for_locks(timeout=1, total=0.1):
            with patch.object(D.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(D.time, 'sleep', side_effect=sleep):
                with patch.object(D.fcntl, 'flock', side_effect=[BlockingIOError(), BlockingIOError(), None]):
                    with self.cache._locked():pass
                spent = clock[0]
                self.assertGreater(spent, 0)
                with D.wait_for_locks(timeout=60, total=300), patch.object(D.fcntl, 'flock', side_effect=BlockingIOError()):
                    with self.assertRaises(D.CacheBusy):
                        with self.cache._locked():pass
                self.assertAlmostEqual(clock[0], 0.1)

    def test_cancel_interrupts_wait_before_lock_body(self):
        canceled = threading.Event()
        with ThreadPoolExecutor() as pool, self.cache._locked():
            future = pool.submit(self.acquire, timeout=1, total=1, canceled=canceled.is_set)
            time.sleep(0.04);canceled.set()
            with self.assertRaisesRegex(InterruptedError, 'canceled'):future.result(1)

    def test_context_is_thread_local_and_restored_after_exit(self):
        def normal():
            with self.cache._locked():return True
        with ThreadPoolExecutor() as pool:
            with self.cache._locked():
                waiting = pool.submit(self.acquire, timeout=1, total=1)
                with self.assertRaises(D.CacheBusy):pool.submit(normal).result(1)
            self.assertEqual(waiting.result(2), 'acquired')
        with D.wait_for_locks(timeout=1, total=1):self.assertIsNotNone(D._LOCK_WAIT.get())
        self.assertIsNone(D._LOCK_WAIT.get())

    def test_real_io_error_is_not_retried(self):
        with D.wait_for_locks(), patch.object(D.fcntl, 'flock', side_effect=OSError(errno.EIO, 'disk')) as flock, patch.object(D.time, 'sleep') as sleep:
            with self.assertRaises(OSError):
                with self.cache._locked():pass
        self.assertEqual(flock.call_count, 1);sleep.assert_not_called()

    def test_body_failure_is_not_retried_or_disguised_as_lock_contention(self):
        calls = []
        with D.wait_for_locks(), self.assertRaisesRegex(D.CacheError, 'corrupt metadata'):
            with self.cache._locked():
                calls.append(1)
                raise D.CacheError('corrupt metadata')
        self.assertEqual(calls, [1])

    def test_data_mount_identity_failure_is_immediate(self):
        self.cache.mount = ('original',)
        with D.wait_for_locks(), patch.object(self.cache, '_current_mount', return_value=('changed',)), patch.object(D.time, 'sleep') as sleep:
            with self.assertRaisesRegex(D.CacheError, 'mount identity'):
                with self.cache._locked():pass
        sleep.assert_not_called()

    def test_wait_is_outside_acquired_lock_and_no_budget_spent_on_body(self):
        held = False
        def flock(fd, flags):
            nonlocal held
            if not calls:
                calls.append(1);raise BlockingIOError()
            held = True
        def sleep(seconds):self.assertFalse(held)
        calls = []
        with D.wait_for_locks(total=1), patch.object(D.fcntl, 'flock', side_effect=flock), patch.object(D.time, 'sleep', side_effect=sleep):
            with self.cache._locked():
                remaining = D._LOCK_WAIT.get()['remaining']
                time.monotonic()
                self.assertEqual(D._LOCK_WAIT.get()['remaining'], remaining)

    def test_invalid_or_unbounded_policy_is_rejected(self):
        for policy in ({'timeout':True}, {'timeout':float('nan')}, {'timeout':61}, {'total':301}, {'total':-1}, {'canceled':'stop'}):
            with self.subTest(policy=policy), self.assertRaises(D.CacheError):
                with D.wait_for_locks(**policy):pass


if __name__ == '__main__':unittest.main()
