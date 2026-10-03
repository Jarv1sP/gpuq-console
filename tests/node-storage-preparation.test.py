"""Feature-on preparation/dispatch cleanup against real durable lease journals.

Disposable cache and SQLite scheduler fixtures only; GPUQ and systemd inspection
are replaced by explicit evidence. No network, actual GPU, or services are used.
"""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
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


if __name__=='__main__':unittest.main()
