"""Local publication commit/receipt faults; no systemd, SSH or real node calls."""
import importlib.util
from contextlib import contextmanager
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

source = Path(__file__).with_name('node-projects.test.py')
spec = importlib.util.spec_from_file_location('publication_receipt_fixture', source)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class PublicationReceiptTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.NodeProjects()
        self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.ops, self.n, self.args = self.f.ops, self.f.n, self.f.args
        paths = self.ops.store.dev_paths(*self.ops.identity(self.args))
        (paths['env']/'bin').mkdir()
        (paths['env']/'bin/python').write_text('synthetic interpreter, never executed')
        (paths['env']/'pyvenv.cfg').write_text('home = /opt/conda/bin\n')

    def start(self):
        with patch.object(self.n,'run',return_value=''),patch.object(self.ops,'active',return_value=False):
            return self.f.call('projects.publish')['operationId']

    def status(self, ops=None):
        ops = ops or self.ops
        with patch.object(ops,'active',return_value=False):
            return ops.status(self.args)

    def test_final_receipt_failure_preserves_exit_zero_and_status_recovers_committed_ready(self):
        operation = self.start()
        original = self.n.atomic_json
        def write(path, value):
            if value.get('state') == 'READY': raise OSError('synthetic final receipt failure')
            original(path, value)
        with patch.object(self.n,'atomic_json',side_effect=write):
            self.assertEqual(self.ops.worker(operation),0)
            receipt = self.ops.pending(self.args)
            self.assertEqual(receipt['state'],'PUBLISHING')
            self.assertEqual(receipt['progress']['phase'],'complete')
            self.assertEqual(self.status()['state'],'READY')
        status = self.status()
        self.assertEqual(status['state'],'READY')
        self.assertEqual(self.ops.pending(self.args)['state'],'READY')
        self.assertEqual(status['latestReadyRelease'],receipt['committedRelease'])
        self.assertNotIn('error',status)

    def test_recovery_does_not_depend_on_the_worker_python_object(self):
        operation = self.start()
        original = self.n.atomic_json
        with patch.object(self.n,'atomic_json',side_effect=lambda p,v: (_ for _ in ()).throw(OSError('receipt')) if v.get('state')=='READY' else original(p,v)):
            self.assertEqual(self.ops.worker(operation),0)
        restarted = type(self.ops)(self.n)
        restarted.store.reserve_bytes = 0
        self.assertEqual(self.status(restarted)['state'],'READY')
        self.assertEqual(restarted.pending(self.args)['state'],'READY')

    def test_status_recovery_does_not_overwrite_a_newer_publication_intent(self):
        operation = self.start()
        original = self.n.atomic_json
        with patch.object(self.n,'atomic_json',side_effect=lambda p,v: (_ for _ in ()).throw(OSError('receipt')) if v.get('state')=='READY' else original(p,v)):
            self.assertEqual(self.ops.worker(operation),0)
        newer = {**self.args,'state':'PUBLISHING','progress':{'phase':'scanning'}}
        @contextmanager
        def new_intent(args):
            original(self.ops.receipt_path(args),newer)
            yield
        with patch.object(self.ops,'guard',side_effect=new_intent):
            self.status()
        self.assertEqual(self.ops.pending(self.args),newer)

    def test_precommit_failure_remains_failed_even_if_an_old_ready_version_exists(self):
        self.assertEqual(self.ops.worker(self.start()),0)
        previous = self.status()['latestReadyRelease']
        operation = self.start()
        with patch.object(self.ops.store,'publish',side_effect=ValueError('synthetic precommit failure')):
            self.assertEqual(self.ops.worker(operation),1)
        status = self.status()
        self.assertEqual(status['state'],'FAILED')
        self.assertEqual(status['latestReadyRelease'],previous)
        self.assertIn('precommit',status['error'])

    def test_stopped_worker_without_commit_proof_is_unknown_not_success_or_failure(self):
        self.assertEqual(self.ops.worker(self.start()),0)
        previous = self.status()['latestReadyRelease']
        self.start()  # No worker completion for this new request.
        status = self.status()
        self.assertEqual(status['state'],'UNKNOWN')
        self.assertEqual(status['latestReadyRelease'],previous)

    def test_total_postcommit_receipt_failure_is_not_falsely_written_failed(self):
        operation = self.start()
        original = self.n.atomic_json
        def write(path, value):
            if value.get('state') == 'READY' or value.get('progress',{}).get('phase') == 'complete':
                raise OSError('all postcommit receipts unavailable')
            self.assertNotEqual(value.get('state'),'FAILED')
            original(path,value)
        with patch.object(self.n,'atomic_json',side_effect=write):
            self.assertEqual(self.ops.worker(operation),0)
        status = self.status()
        self.assertEqual(status['state'],'UNKNOWN')
        self.assertTrue(status['latestReadyRelease'])
        self.assertEqual(status['releases'][0]['state'],'READY')

    def test_error_after_complete_does_not_revoke_durable_publication(self):
        operation = self.start()
        original = self.ops.store.publish
        def publish(*args, **kwargs):
            original(*args,**kwargs)
            raise OSError('synthetic postcommit cleanup error')
        with patch.object(self.ops.store,'publish',side_effect=publish):
            self.assertEqual(self.ops.worker(operation),0)
        self.assertEqual(self.status()['state'],'READY')

    def test_keyed_publication_retries_current_receipt_without_starting_another_worker(self):
        key = str(uuid.uuid4())
        with patch.object(self.n,'run',return_value='') as run,patch.object(self.ops,'active',return_value=True):
            started = self.f.call('projects.publish',key=key)
            repeated = self.f.call('projects.publish',key=key)
            self.assertEqual(run.call_count,1)
            self.assertEqual(started['publication'],{'id':key,'state':'PUBLISHING'})
            self.assertEqual(repeated['publication'],started['publication'])
        self.assertEqual(self.ops.worker(started['operationId']),0)
        restarted = type(self.ops)(self.n);restarted.store.reserve_bytes=0
        with patch.object(self.n,'run',side_effect=AssertionError('no second worker')):
            result = restarted.process('projects.publish',{**self.args,'key':key})
        self.assertEqual(result['publicationProtocol'],1)
        self.assertEqual(result['publication'],{'id':key,'state':'READY','release':result['latestReadyRelease']})

    def test_keyed_failure_and_unknown_never_expose_previous_ready_as_publication_release(self):
        self.assertEqual(self.ops.worker(self.start()),0)
        for failed in (True,False):
            key=str(uuid.uuid4())
            with patch.object(self.n,'run',return_value=''),patch.object(self.ops,'active',return_value=False):
                started=self.f.call('projects.publish',key=key)
            if failed:
                with patch.object(self.ops.store,'publish',side_effect=ValueError('new publish failed')):
                    self.assertEqual(self.ops.worker(started['operationId']),1)
            status=self.status()
            self.assertTrue(status['latestReadyRelease'])
            self.assertEqual(status['publication'],{'id':key,'state':'FAILED' if failed else 'UNKNOWN'})
            with patch.object(self.n,'run',side_effect=AssertionError('no retry')),patch.object(self.ops,'active',return_value=False):
                self.assertEqual(self.f.call('projects.publish',key=key)['publication'],status['publication'])

    def test_key_survives_postcommit_receipt_failure_and_only_commit_proof_recovers_it(self):
        key=str(uuid.uuid4())
        with patch.object(self.n,'run',return_value=''):
            started=self.f.call('projects.publish',key=key)
        original=self.n.atomic_json
        with patch.object(self.n,'atomic_json',side_effect=lambda p,v: (_ for _ in ()).throw(OSError('receipt')) if v.get('state')=='READY' else original(p,v)):
            self.assertEqual(self.ops.worker(started['operationId']),0)
        result=self.status()
        self.assertEqual(result['publication'],{'id':key,'state':'READY','release':result['latestReadyRelease']})

    def test_corrupt_publication_identity_or_commit_is_not_a_ready_proof(self):
        operation=self.start();self.assertEqual(self.ops.worker(operation),0)
        original=self.ops.pending(self.args)
        for change in ({'publicationId':'bad'},{'committedRelease':'a'*64},{'release':'b'*64},{'state':'garbage'}):
            self.n.atomic_json(self.ops.receipt_path(self.args),{**original,**change})
            with self.assertRaises(ValueError):self.status()

    def test_publication_key_and_privilege_fields_are_strict(self):
        for extra in ({'key':'bad'},{'key':None},{'key':True},{'publicationId':str(uuid.uuid4())},{'hostAdmin':True}):
            with self.assertRaises(ValueError):self.f.call('projects.publish',**extra)
        with self.assertRaises(ValueError):self.f.call('projects.status',key=str(uuid.uuid4()))


if __name__ == '__main__': unittest.main()
