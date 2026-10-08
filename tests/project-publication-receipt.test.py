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

    def worker(self, operation):
        task=self.ops.receipt(self.args)
        return self.ops.worker(operation,task['publicationId'],task['projectGeneration'])

    def test_final_receipt_failure_preserves_exit_zero_and_status_recovers_committed_ready(self):
        operation = self.start()
        original = self.n.atomic_json
        def write(path, value):
            if value.get('state') == 'READY': raise OSError('synthetic final receipt failure')
            original(path, value)
        with patch.object(self.n,'atomic_json',side_effect=write):
            self.assertEqual(self.worker(operation),0)
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
            self.assertEqual(self.worker(operation),0)
        restarted = type(self.ops)(self.n)
        restarted.store.reserve_bytes = 0
        self.assertEqual(self.status(restarted)['state'],'READY')
        self.assertEqual(restarted.pending(self.args)['state'],'READY')

    def test_status_recovery_does_not_overwrite_a_newer_publication_intent(self):
        operation = self.start()
        original = self.n.atomic_json
        with patch.object(self.n,'atomic_json',side_effect=lambda p,v: (_ for _ in ()).throw(OSError('receipt')) if v.get('state')=='READY' else original(p,v)):
            self.assertEqual(self.worker(operation),0)
        newer = {**self.args,'state':'PUBLISHING','progress':{'phase':'scanning'},
                 'publicationId':str(uuid.uuid4()),
                 'projectUUID':self.ops.store.project_uuid(*self.ops.identity(self.args)),
                 'projectGeneration':self.ops.store.generation(*self.ops.identity(self.args))}
        @contextmanager
        def new_intent(args):
            original(self.ops.receipt_path(args),newer)
            yield
        with patch.object(self.ops,'guard',side_effect=new_intent):
            self.status()
        self.assertEqual(self.ops.pending(self.args),newer)

    def test_precommit_failure_remains_failed_even_if_an_old_ready_version_exists(self):
        self.assertEqual(self.worker(self.start()),0)
        previous = self.status()['latestReadyRelease']
        operation = self.start()
        with patch.object(self.ops.store,'publish',side_effect=ValueError('synthetic precommit failure')):
            self.assertEqual(self.worker(operation),1)
        status = self.status()
        self.assertEqual(status['state'],'FAILED')
        self.assertEqual(status['latestReadyRelease'],previous)
        self.assertIn('precommit',status['error'])

    def test_stopped_worker_without_commit_proof_is_unknown_not_success_or_failure(self):
        self.assertEqual(self.worker(self.start()),0)
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
            self.assertEqual(self.worker(operation),0)
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
            self.assertEqual(self.worker(operation),0)
        self.assertEqual(self.status()['state'],'READY')

    def test_keyed_publication_retries_current_receipt_without_starting_another_worker(self):
        key = str(uuid.uuid4())
        with patch.object(self.n,'run',return_value='') as run,patch.object(self.ops,'active',return_value=True):
            started = self.f.call('projects.publish',key=key)
            repeated = self.f.call('projects.publish',key=key)
            self.assertEqual(run.call_count,1)
            self.assertEqual(started['publication'],{'id':key,'state':'PUBLISHING'})
            self.assertEqual(repeated['publication'],started['publication'])
        self.assertEqual(self.worker(started['operationId']),0)
        restarted = type(self.ops)(self.n);restarted.store.reserve_bytes=0
        with patch.object(self.n,'run',side_effect=AssertionError('no second worker')):
            result = restarted.process('projects.publish',{**self.args,'key':key})
        self.assertEqual(result['publicationProtocol'],1)
        self.assertEqual(result['publication'],{'id':key,'state':'READY','release':result['latestReadyRelease']})

    def test_keyed_failure_and_unknown_never_expose_previous_ready_as_publication_release(self):
        self.assertEqual(self.worker(self.start()),0)
        for failed in (True,False):
            key=str(uuid.uuid4())
            with patch.object(self.n,'run',return_value=''),patch.object(self.ops,'active',return_value=False):
                started=self.f.call('projects.publish',key=key)
            if failed:
                with patch.object(self.ops.store,'publish',side_effect=ValueError('new publish failed')):
                    self.assertEqual(self.worker(started['operationId']),1)
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
            self.assertEqual(self.worker(started['operationId']),0)
        result=self.status()
        self.assertEqual(result['publication'],{'id':key,'state':'READY','release':result['latestReadyRelease']})

    def test_corrupt_publication_identity_or_commit_is_not_a_ready_proof(self):
        operation=self.start();self.assertEqual(self.worker(operation),0)
        original=self.ops.pending(self.args)
        for change in ({'publicationId':'bad'},{'committedRelease':'a'*64},{'release':'b'*64},{'state':'garbage'}):
            self.n.atomic_json(self.ops.receipt_path(self.args),{**original,**change})
            with self.assertRaises(ValueError):self.status()

    def test_publication_key_and_privilege_fields_are_strict(self):
        for extra in ({'key':'bad'},{'key':None},{'key':True},{'publicationId':str(uuid.uuid4())},{'hostAdmin':True},{'projectGeneration':'a'*64},{'requestedAt':1}):
            with self.assertRaises(ValueError):self.f.call('projects.publish',**extra)
        with self.assertRaises(ValueError):self.f.call('projects.status',key=str(uuid.uuid4()))

    def replace_project(self, *, same_second=False):
        path, meta = self.ops.store._project(*self.ops.identity(self.args))
        path.rename(path.with_name('previous-project'))
        self.ops.store.create(*self.ops.identity(self.args))
        if same_second:
            current, _ = self.ops.store._project(*self.ops.identity(self.args))
            self.n.atomic_json(current/'project.json',meta)

    def test_same_name_same_second_reset_does_not_show_old_failure_or_replay_its_key(self):
        key=str(uuid.uuid4())
        with patch.object(self.n,'run',return_value=''):
            started=self.f.call('projects.publish',key=key)
        with patch.object(self.ops.store,'publish',side_effect=ValueError('old root-owned file')):
            self.assertEqual(self.worker(started['operationId']),1)
        receipt=self.ops.receipt_path(self.args).read_bytes()
        self.replace_project(same_second=True)
        status=self.status()
        self.assertEqual(status['state'],'DRAFT')
        self.assertEqual(status['releases'],[])
        self.assertNotIn('error',status)
        self.assertNotIn('publication',status)
        with patch.object(self.n,'run',side_effect=AssertionError('old key must not run')):
            with self.assertRaisesRegex(ValueError,'earlier project'):
                self.f.call('projects.publish',key=key)
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(),receipt)

    def test_legacy_receipt_provably_before_project_creation_is_hidden_without_rewriting(self):
        created=self.ops.store.status(*self.ops.identity(self.args))['createdAt']
        value={**self.args,'publicationId':str(uuid.uuid4()),'state':'FAILED',
               'error':'old failure','progress':{'startedAt':created-1}}
        self.n.atomic_json(self.ops.receipt_path(self.args),value)
        receipt=self.ops.receipt_path(self.args).read_bytes()
        self.assertEqual(self.status()['state'],'DRAFT')
        self.assertNotIn('publication',self.status())
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(),receipt)
        for start in (None,created,created+1):
            value['progress']={'startedAt':start}
            self.n.atomic_json(self.ops.receipt_path(self.args),value)
            before=self.ops.receipt_path(self.args).read_bytes()
            status=self.status()
            self.assertEqual(status['state'],'UNKNOWN','Unbound legacy evidence is retained, not attributed as this project\'s failure')
            self.assertEqual(status['publication']['state'],'UNKNOWN')
            self.assertNotEqual(status.get('error'),value['error'])
            self.assertEqual(self.ops.receipt_path(self.args).read_bytes(),before)
        with patch.object(self.ops.store,'status',side_effect=AssertionError('Unknown start cannot prove an older project')):
            self.assertTrue(self.ops.belongs_to_project(self.args,{**value,'progress':{}}))

    def test_delayed_worker_cannot_publish_replacement_project_or_newer_intent(self):
        operation=self.start();old=self.ops.pending(self.args)
        self.replace_project(same_second=True)
        with patch.object(self.ops.store,'publish',side_effect=AssertionError('no stale worker')):
            with self.assertRaisesRegex(ValueError,'earlier project'):
                self.ops.worker(operation,old['publicationId'],old['projectGeneration'])
        with patch.object(self.n,'run',return_value=''):
            newer=self.f.call('projects.publish',key=str(uuid.uuid4()))
        receipt=self.ops.receipt_path(self.args).read_bytes()
        with patch.object(self.ops.store,'publish',side_effect=AssertionError('no substituted intent')):
            with self.assertRaisesRegex(ValueError,'original intent'):
                self.ops.worker(operation,old['publicationId'],old['projectGeneration'])
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(),receipt)
        self.assertNotEqual(newer['publication']['id'],old['publicationId'])

    def test_generation_is_owner_scoped_and_corruption_is_not_silently_discarded(self):
        self.start();value=self.ops.pending(self.args)
        with self.assertRaises(ValueError):
            self.ops.store.generation('demo-user-4',self.args['project'])
        self.n.atomic_json(self.ops.receipt_path(self.args),{**value,'projectGeneration':'bad'})
        with self.assertRaisesRegex(ValueError,'generation'):self.status()

    def test_same_generation_replacement_before_worker_lock_cannot_publish_or_overwrite_new_uuid(self):
        operation=self.start();old=self.ops.receipt(self.args)
        lifetime=self.ops.store.lifetime;interleaved=False;new_key=str(uuid.uuid4())
        @contextmanager
        def before_lifetime(*args,**kwargs):
            nonlocal interleaved
            if not interleaved:
                interleaved=True
                with patch.object(self.n,'run',return_value=''),patch.object(self.ops,'active',return_value=False):
                    self.f.call('projects.publish',key=new_key)
            with lifetime(*args,**kwargs):yield
        with patch.object(self.ops.store,'lifetime',side_effect=before_lifetime), \
                patch.object(self.ops.store,'publish',side_effect=AssertionError('Old worker cannot copy or commit')):
            with self.assertRaisesRegex(ValueError,'original intent'):
                self.ops.worker(operation,old['publicationId'],old['projectGeneration'])
        current=self.ops.receipt(self.args)
        self.assertEqual(current['publicationId'],new_key)
        self.assertEqual(current['projectGeneration'],old['projectGeneration'])
        self.assertEqual(current['state'],'PUBLISHING')
        self.assertEqual(self.ops.historical_receipt(self.args,old['publicationId']),old)
        self.assertEqual(self.ops.store.status(*self.ops.identity(self.args))['releases'],[])

    def test_late_progress_and_failure_do_not_clobber_a_replaced_receipt(self):
        operation=self.start();old=self.ops.receipt(self.args)
        newer={**old,'publicationId':str(uuid.uuid4()),'progress':{'phase':'new-request'}}
        def publish(*args,progress,**kwargs):
            # Simulate an external receipt replacement despite the normal
            # guard. Both the callback and its failure path must stay fenced.
            self.n.atomic_json(self.ops.receipt_path(self.args),newer)
            progress({'phase':'scanning'})
        with patch.object(self.ops.store,'publish',side_effect=publish):
            with self.assertRaisesRegex(ValueError,'not overwritten'):
                self.ops.worker(operation,old['publicationId'],old['projectGeneration'])
        self.assertEqual(self.ops.receipt(self.args),newer)

    def test_unconfirmed_native_state_cannot_replace_an_intent_while_worker_owns_guard(self):
        operation=self.start();old=self.ops.receipt(self.args)
        publish=self.ops.store.publish;new_key=str(uuid.uuid4())
        def concurrent_publish(*args,**kwargs):
            with patch.object(self.ops,'active',return_value=False),patch.object(self.n,'run',return_value=''):
                with self.assertRaisesRegex(ValueError,'operation is busy'):
                    self.f.call('projects.publish',key=new_key)
            self.assertEqual(self.ops.receipt(self.args)['publicationId'],old['publicationId'])
            return publish(*args,**kwargs)
        with patch.object(self.ops.store,'publish',side_effect=concurrent_publish):
            self.assertEqual(self.ops.worker(operation,old['publicationId'],old['projectGeneration']),0)
        self.assertEqual(self.ops.receipt(self.args)['publicationId'],old['publicationId'])
        self.assertIsNone(self.ops.historical_receipt(self.args,new_key))

    def test_late_final_receipt_does_not_clobber_a_replaced_intent_after_commit(self):
        operation=self.start();old=self.ops.receipt(self.args)
        newer={**old,'publicationId':str(uuid.uuid4()),'progress':{'phase':'new-request'}}
        publish=self.ops.store.publish
        def replaced_after_commit(*args,**kwargs):
            result=publish(*args,**kwargs)
            self.n.atomic_json(self.ops.receipt_path(self.args),newer)
            return result
        with patch.object(self.ops.store,'publish',side_effect=replaced_after_commit):
            self.assertEqual(self.ops.worker(operation,old['publicationId'],old['projectGeneration']),0)
        self.assertEqual(self.ops.receipt(self.args),newer)
        self.assertTrue(self.ops.store.status(*self.ops.identity(self.args))['latestReadyRelease'])

    def test_worker_without_original_invocation_identity_never_adopts_current_or_legacy_intent(self):
        operation=self.start();task=self.ops.receipt(self.args)
        for receipt in (task,{k:v for k,v in task.items() if k!='projectGeneration'}):
            self.n.atomic_json(self.ops.receipt_path(self.args),receipt)
            before=self.ops.receipt_path(self.args).read_bytes()
            with patch.object(self.ops.store,'publish',side_effect=AssertionError('No unbound worker')):
                for params in ((),(task['publicationId'],),(None,task['projectGeneration'])):
                    with self.assertRaisesRegex(ValueError,'identity is unconfirmed'):
                        self.ops.worker(operation,*params)
            self.assertEqual(self.ops.receipt_path(self.args).read_bytes(),before)

    def test_detached_worker_command_binds_the_original_publication_and_generation(self):
        with patch.object(self.n,'run',return_value='') as run:
            result=self.f.call('projects.publish',key=str(uuid.uuid4()))
        task=self.ops.receipt(self.args)
        self.assertEqual(run.call_args.args[0][-4:],['--project-worker',result['operationId'],task['publicationId'],task['projectGeneration']])

    def test_replaced_publication_keeps_exact_receipt_and_old_key_never_replays_even_after_new_intent(self):
        key=str(uuid.uuid4())
        with patch.object(self.n,'run',return_value=''):
            old=self.f.call('projects.publish',key=key)
        with patch.object(self.ops.store,'publish',side_effect=ValueError('old failure')):
            self.assertEqual(self.worker(old['operationId']),1)
        before=self.ops.receipt_path(self.args).read_bytes()
        self.replace_project(same_second=True)
        with patch.object(self.n,'run',return_value=''):
            newer=self.f.call('projects.publish',key=str(uuid.uuid4()))
        archived=self.ops.historical_receipt_path(self.args,key)
        self.assertEqual(archived.read_bytes(),before)
        current=self.ops.receipt_path(self.args).read_bytes()
        with patch.object(self.n,'run',side_effect=AssertionError('Old key must not run')):
            with self.assertRaisesRegex(ValueError,'not replayed'):
                self.f.call('projects.publish',key=key)
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(),current)
        self.assertNotEqual(newer['publication']['id'],key)

    def test_historical_receipts_reject_other_owner_and_links_without_starting_a_worker(self):
        operation=self.start();old=self.ops.receipt(self.args)
        with patch.object(self.ops.store,'publish',side_effect=ValueError('old failure')):
            self.assertEqual(self.worker(operation),1)
        key=old['publicationId']
        with patch.object(self.n,'run',return_value=''):
            self.f.call('projects.publish',key=str(uuid.uuid4()))
        path=self.ops.historical_receipt_path(self.args,key);valid=path.read_bytes()
        current=self.ops.receipt_path(self.args).read_bytes()
        self.n.atomic_json(path,{**old,'userId':'demo-user-4'})
        with patch.object(self.n,'run',side_effect=AssertionError('No foreign receipt worker')):
            with self.assertRaisesRegex(ValueError,'identity mismatch'):
                self.f.call('projects.publish',key=key)
        path.unlink();target=self.n.ROOT/'isolated-receipt';target.write_bytes(valid);path.symlink_to(target)
        with patch.object(self.n,'run',side_effect=AssertionError('No symlink receipt worker')):
            with self.assertRaises(OSError):self.f.call('projects.publish',key=key)
        self.assertEqual(self.ops.receipt_path(self.args).read_bytes(),current)


if __name__ == '__main__': unittest.main()
