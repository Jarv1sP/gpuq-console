"""Feature-on preparation/dispatch cleanup against real durable lease journals.

Disposable cache and SQLite scheduler fixtures only; GPUQ and systemd inspection
are replaced by explicit evidence. No network, actual GPU, or services are used.
"""
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('node_dataset_fixture', Path(__file__).with_name('node-datasets.test.py'))
F = importlib.util.module_from_spec(spec); spec.loader.exec_module(F)


class PreparedLeaseIntegration(unittest.TestCase):
    def setUp(self):
        F.NodeDatasets.setUp(self)
        shutil.copy2(F.DEPLOY/'storage-leases.py',self.base/'storage-leases.py')
        self.node.CONFIG['storageArchive']={'enabled':True,'machine':'cold-node','authority':'hdd'}
        self.cache.materialize(self.user,'example',self.version)

    tearDown = F.NodeDatasets.tearDown

    def prepare(self):
        return self.node.storage_lease_operation('storage.lease.prepare',{'job':self.job})

    def cancel_hold(self):
        return self.node.storage_lease_operation('storage.lease.cancel',{'job':self.job})

    def receipt(self):
        return self.node.ROOT/'jobs'/(self.job['id']+'.datasets.json')

    def leases(self):
        with self.cache._locked(): return self.cache._leases('example',self.version)

    def native(self):
        with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
            db.execute('INSERT INTO jobs(id,submit_key) VALUES (?,?)',('native-job',self.job['id']));db.commit()

    def terminal(self):
        return dict(job=dict(state='SUCCEEDED',active_attempt_id=None),
                    attempts=[dict(state='EXITED_SUCCESS',unit_name='gpuq-fixture')],
                    leases=[],scale_up_reservations=[])

    def test_prepared_hold_without_handoff_receipt_is_released_on_no_dispatch_cancel(self):
        self.assertEqual(self.prepare()['state'],'HELD')
        self.assertFalse(self.receipt().exists());self.assertEqual(len(self.leases()),1)
        with patch.object(self.node,'gpu') as gpu:
            result=self.node.process('cancel',{'job':self.job})
            self.assertEqual(result['state'],'CANCELED');gpu.assert_not_called()
            self.assertEqual(self.cancel_hold()['released'],True)
            self.assertEqual(self.cancel_hold()['released'],True)
        self.assertEqual(self.leases(),[])
        with self.assertRaises(ValueError):self.prepare()
        self.assertTrue(self.cache.evict(self.admin,'example',self.version)['evicted'])

    def test_submission_preflight_failure_retains_until_trusted_no_dispatch_cancel(self):
        self.job.update(priority='normal',preemptIdleOnly=True);self.prepare()
        with (patch.object(self.node,'priority_capability',side_effect=ValueError('preflight unavailable')),
              patch.object(self.node,'gpu') as gpu):
            with self.assertRaisesRegex(ValueError,'preflight unavailable'):
                self.node.process('sync',{'job':self.job})
            gpu.assert_not_called()
        self.assertEqual(len(self.leases()),1);self.assertFalse(self.receipt().exists())
        self.assertTrue(self.cancel_hold()['released']);self.assertEqual(self.leases(),[])

    def test_handoff_no_dispatch_then_lost_cleanup_reply_retries_without_reacquire(self):
        self.prepare();self.node.acquire_datasets(self.job)
        self.assertTrue(self.receipt().exists());self.assertEqual(len(self.leases()),1)
        self.assertTrue(self.cancel_hold()['released'])
        self.assertFalse(self.receipt().exists());self.assertEqual(self.leases(),[])
        self.assertTrue(self.cancel_hold()['released'])
        with self.assertRaises(ValueError):self.node.acquire_datasets(self.job)

    def test_unknown_submit_marker_never_releases_prepared_or_handed_off_leases(self):
        self.prepare();self.node.acquire_datasets(self.job)
        (self.node.ROOT/'jobs'/(self.job['id']+'.dataset-dispatch-attempted')).touch()
        with patch.object(self.node,'gpu') as gpu:
            self.assertEqual(self.node.process('cancel',{'job':self.job})['state'],'UNKNOWN')
            with self.assertRaisesRegex(ValueError,'unknown'):self.cancel_hold()
            gpu.assert_not_called()
        self.assertEqual(len(self.leases()),1)

    def test_native_running_or_unit_not_stopped_cannot_be_cleaned_by_preparation_cancel(self):
        self.prepare();self.node.acquire_datasets(self.job);self.native()
        running=dict(job=dict(state='RUNNING',active_attempt_id='a'),attempts=[],leases=[],scale_up_reservations=[])
        with patch.object(self.node,'gpu',return_value=running) as gpu:
            with self.assertRaisesRegex(ValueError,'unconfirmed'):self.cancel_hold()
            self.assertEqual(gpu.call_args.args,('show','native-job'))
        with patch.object(self.node,'gpu',return_value=self.terminal()),patch.object(self.node,'dataset_unit_stopped',return_value=False):
            with self.assertRaisesRegex(ValueError,'unconfirmed'):self.cancel_hold()
        self.assertEqual(len(self.leases()),1)

    def test_native_terminal_cleanup_is_idempotent_after_legacy_receipt_is_gone(self):
        self.prepare();self.node.acquire_datasets(self.job);self.native()
        with patch.object(self.node,'gpu',return_value=self.terminal()) as gpu,patch.object(self.node,'dataset_unit_stopped',return_value=True):
            self.assertTrue(self.cancel_hold()['released']);self.assertFalse(self.receipt().exists())
            self.assertTrue(self.cancel_hold()['released'])
            self.assertTrue(all(call.args[0]=='show' for call in gpu.call_args_list))
        self.assertEqual(self.leases(),[])
        with self.assertRaises(ValueError):self.node.acquire_datasets(self.job)

    def exact_cleanup_fixture(self):
        self.prepare();self.node.acquire_datasets(self.job)
        native='J0123456789ab';attempt='A'+'a'*32
        (self.node.ROOT/'jobs'/(self.job['id']+'.json')).write_text(json.dumps(self.job))
        with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
            db.execute('INSERT INTO jobs(id,submit_key) VALUES (?,?)',(native,self.job['id']));db.commit()
        data=self.terminal();data['job'].update(id=native,submit_key=self.job['id'],version=7)
        data['attempts'][0].update(id=attempt,ordinal=2)
        expected=dict(nodeJobId=native,attemptId=attempt,attemptOrdinal=2,nativeVersion=7)
        return data,expected

    def exact_cleanup(self,expected):
        return self.node.storage_lease_operation('storage.lease.cancel',{'job':self.job,'expectedNative':expected})

    def test_explicit_native_snapshot_cleanup_preserves_history_and_never_calls_cancel_submit(self):
        data,expected=self.exact_cleanup_fixture()
        before=(self.node.ROOT/'jobs'/(self.job['id']+'.json')).read_bytes()
        with patch.object(self.node,'gpu',return_value=data) as gpu,patch.object(self.node,'dataset_unit_stopped',return_value=True):
            for _ in range(2):self.assertEqual(self.exact_cleanup(expected)['reconciledNative'],expected)
            self.assertTrue(all(c.args==('show',expected['nodeJobId']) for c in gpu.call_args_list))
        self.assertEqual(self.leases(),[]);self.assertFalse(self.receipt().exists())
        self.assertEqual((self.node.ROOT/'jobs'/(self.job['id']+'.json')).read_bytes(),before)
        self.assertFalse((self.node.ROOT/'jobs'/(self.job['id']+'.canceled')).exists())

    def test_explicit_cleanup_missing_native_or_spec_does_not_cancel_prepare(self):
        data,expected=self.exact_cleanup_fixture()
        spec=self.node.ROOT/'jobs'/(self.job['id']+'.json');spec.unlink()
        with patch.object(self.node,'gpu') as gpu:
            with self.assertRaisesRegex(ValueError,'identity'):self.exact_cleanup(expected)
            spec.write_text(json.dumps(self.job))
            with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:db.execute('DELETE FROM jobs');db.commit()
            with self.assertRaisesRegex(ValueError,'identity'):self.exact_cleanup(expected)
            gpu.assert_not_called()
        self.assertEqual(len(self.leases()),1);self.assertTrue(self.receipt().exists())
        self.assertFalse((self.node.ROOT/'jobs'/(self.job['id']+'.canceled')).exists())

    def test_changed_native_generation_or_active_unit_keeps_all_leases(self):
        import copy
        data,expected=self.exact_cleanup_fixture()
        changed=[]
        for fields in ({'id':'Jffffffffffff'},{'submit_key':'other'},{'version':8},{'state':'RUNNING','active_attempt_id':'Anew'}):
            value=copy.deepcopy(data);value['job'].update(fields);changed.append(value)
        for fields in ({'id':'A'+'b'*32},{'ordinal':3},{'state':'RUNNING'}):
            value=copy.deepcopy(data);value['attempts'][0].update(fields);changed.append(value)
        value=copy.deepcopy(data);value['leases']=[{'id':'held'}];changed.append(value)
        for value in changed:
            with patch.object(self.node,'gpu',return_value=value),patch.object(self.node,'dataset_unit_stopped',return_value=True):
                with self.assertRaisesRegex(ValueError,'unconfirmed'):self.exact_cleanup(expected)
            self.assertEqual(len(self.leases()),1)
        with patch.object(self.node,'gpu',return_value=data),patch.object(self.node,'dataset_unit_stopped',return_value=False):
            with self.assertRaisesRegex(ValueError,'unconfirmed'):self.exact_cleanup(expected)
        self.assertEqual(len(self.leases()),1);self.assertTrue(self.receipt().exists())

    def test_retry_refresh_must_match_snapshot_before_any_generation_is_released(self):
        data,expected=self.exact_cleanup_fixture()
        folder=self.node.ROOT/'storage-leases'/'training'/self.job['id']
        (folder/'retry-fixture.json').write_text('{}')
        newer=json.loads(json.dumps(data));newer['job']['version']=8
        with patch.object(self.node,'gpu',side_effect=[data,newer]),patch.object(self.node,'dataset_unit_stopped',return_value=True):
            with self.assertRaisesRegex(ValueError,'unconfirmed'):self.exact_cleanup(expected)
        self.assertEqual(len(self.leases()),1);self.assertTrue(self.receipt().exists())

    def test_reconciliation_waits_for_job_lock_and_rechecks_after_it_changes(self):
        import fcntl
        data,expected=self.exact_cleanup_fixture();entered=threading.Event()
        def cleanup():
            entered.set();return self.exact_cleanup(expected)
        path=self.node.ROOT/'jobs'/(self.job['id']+'.lock')
        with open(path,'a') as lock,ThreadPoolExecutor(max_workers=1) as pool,patch.object(self.node,'gpu',return_value=data) as gpu:
            fcntl.flock(lock,fcntl.LOCK_EX)
            pending=pool.submit(cleanup);self.assertTrue(entered.wait(3));time.sleep(.02)
            gpu.assert_not_called();data['job']['version']=8
            fcntl.flock(lock,fcntl.LOCK_UN)
            with self.assertRaisesRegex(ValueError,'unconfirmed'):pending.result(timeout=3)
        self.assertEqual(len(self.leases()),1);self.assertTrue(self.receipt().exists())

    def test_legacy_runner_holds_same_lock_until_its_dataset_mount_is_open(self):
        import os
        data,expected=self.exact_cleanup_fixture()
        # Production legacy READY submissions have no preparation journal.
        shutil.rmtree(self.node.ROOT/'storage-leases'/'training'/self.job['id'])
        retained=self.leases();entered=threading.Event();advance=threading.Event();cleanup_entered=threading.Event()
        def proof(job):
            entered.set()
            if not advance.wait(3):raise AssertionError('Fixture runner did not advance')
            return {'fixture':'current authorized runner'}
        def cleanup():cleanup_entered.set();return self.exact_cleanup(expected)
        with ThreadPoolExecutor(max_workers=2) as pool,patch.object(self.node,'dataset_runner_proof',side_effect=proof),patch.object(self.node,'gpu',return_value=data) as gpu:
            runner=pool.submit(self.node.dataset_open_mounts,self.job,runner=True);self.assertTrue(entered.wait(3))
            pending=pool.submit(cleanup);self.assertTrue(cleanup_entered.wait(3));time.sleep(.02);gpu.assert_not_called()
            data['job'].update(state='RUNNING',version=8,active_attempt_id='A'+'b'*32)
            advance.set()
            opened=runner.result(timeout=3)
            try:
                with self.assertRaisesRegex(ValueError,'unconfirmed'):pending.result(timeout=3)
                self.assertEqual(self.leases(),retained);self.assertTrue(self.receipt().exists())
            finally:
                for descriptor,_ in opened:os.close(descriptor)

    def test_expected_snapshot_fields_cannot_authorize_prepare_or_bypass_validation(self):
        data,expected=self.exact_cleanup_fixture()
        for value in (None,{},dict(expected,attemptOrdinal=True),dict(expected,nativeVersion=-1),dict(expected,attemptId='../../attempt')):
            with self.assertRaisesRegex(ValueError,'identity'):self.exact_cleanup(value)
        with self.assertRaisesRegex(ValueError,'request'):
            self.node.storage_lease_operation('storage.lease.prepare',{'job':self.job,'expectedNative':expected})
        self.assertEqual(len(self.leases()),1)

    def test_missing_receipt_still_requires_native_stopped_proof(self):
        self.prepare();self.native();self.assertFalse(self.receipt().exists())
        with patch.object(self.node,'gpu',return_value=self.terminal()),patch.object(self.node,'dataset_unit_stopped',return_value=False):
            with self.assertRaisesRegex(ValueError,'unconfirmed'):self.cancel_hold()
        self.assertEqual(len(self.leases()),1)

    def test_lost_prepare_reply_followed_by_cancel_fences_future_prepare(self):
        self.prepare()  # Treat the HELD reply as lost by the portal.
        self.assertTrue(self.cancel_hold()['released'])
        with self.assertRaises(ValueError):self.prepare()
        self.assertEqual(self.leases(),[])

    def test_legacy_runner_without_journal_waits_before_opening_ready_mount(self):
        locked = threading.Event()
        def holder():
            with self.cache._locked():
                locked.set()
                time.sleep(2.2)
        self.node.CONFIG['storageArchive']['enabled'] = False
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(holder)
            self.assertTrue(locked.wait(5))
            mounts = self.node.dataset_open_mounts(self.job)
            pending.result(timeout=5)
        try:
            self.assertEqual(len(mounts), 1)
            self.assertEqual(mounts[0][1], '/data2/example')
            self.assertEqual(len(self.leases()), 1)
            self.assertFalse((self.node.ROOT/'storage-leases'/'training'/self.job['id']).exists())
        finally:
            for descriptor, _ in mounts:
                __import__('os').close(descriptor)


if __name__=='__main__':unittest.main()
