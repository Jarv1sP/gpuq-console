"""Native retry authority and real cache journals, isolated CPU fixtures only."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('preparation_fixture',Path(__file__).with_name('node-storage-preparation.test.py'))
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)


class NativeRetryGeneration(unittest.TestCase):
    def setUp(self):
        F.PreparedLeaseIntegration.setUp(self)
        self.node.CONFIG['controlRoot']=str(self.base/'control')
        self.native_id='J0123456789ab';self.first='A'+'1'*32;self.current='A'+'2'*32
        self.epoch=time.time()-1000
        self.node.atomic_json(self.node.ROOT/'jobs'/(self.job['id']+'.json'),self.job)
        with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
            db.executescript('DROP TABLE jobs; CREATE TABLE jobs(id TEXT,submit_key TEXT,owner TEXT,argv_json TEXT,state TEXT);'
                'CREATE TABLE attempts(id TEXT,job_id TEXT,ordinal INTEGER,state TEXT,unit_name TEXT,control_dir TEXT,created_at REAL,finished_at REAL);'
                'CREATE TABLE events(id INTEGER PRIMARY KEY,job_id TEXT,event_type TEXT,created_at REAL);')
            db.execute('INSERT INTO jobs VALUES (?,?,?,?,?)',(self.native_id,self.job['id'],self.node.gpuq_owner(self.job),
                json.dumps(['/usr/bin/python3',str(self.node.HERE/'sandbox-runner.py'),self.job['id']]),'RUNNING'))
            db.execute('INSERT INTO events VALUES (?,?,?,?)',(10,self.native_id,'JOB_RETRIED',self.epoch+30))
            db.commit()
        self.attempt(self.first,1,'CANCELED',10,20)
        self.attempt(self.current,2,'RUNNING',40,None)
        self.environment=patch.dict(os.environ,{'GPUQ_JOB_ID':self.native_id,'GPUQ_ATTEMPT_ID':self.current,
            'GPUQ_CONTROL_DIR':str(Path(self.node.CONFIG['controlRoot'])/self.current)})
        self.environment.start();self.addCleanup(self.environment.stop)
        self.groups=patch.object(self.node,'dataset_runner_group',side_effect=lambda:'/fixture/gpuq-'+os.environ['GPUQ_ATTEMPT_ID'].lower()+'.service')
        self.groups.start();self.addCleanup(self.groups.stop)
        self.current_unit_original=self.node.dataset_current_unit
        self.current_unit=patch.object(self.node,'dataset_current_unit',return_value=True)
        self.current_unit.start();self.addCleanup(self.current_unit.stop)
        self.units=patch.object(self.node,'dataset_unit_stopped',return_value=True)
        self.units.start();self.addCleanup(self.units.stop)
        self.s=self.node.storage_leases();self.s.n=self.node
        self.s.prepare(self.job);self.s.handoff(self.job)
        self.s.finalize_training(self.job)
        self.receipt().unlink()
        self.base_record=self.s.root/'training'/self.job['id']/'record.json'
        self.base_bytes=self.base_record.read_bytes()

    tearDown=F.PreparedLeaseIntegration.tearDown
    receipt=F.PreparedLeaseIntegration.receipt
    leases=F.PreparedLeaseIntegration.leases

    def attempt(self,identifier,ordinal,state,created,finished):
        with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
            db.execute('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?)',(identifier,self.native_id,ordinal,state,
                'gpuq-'+identifier.lower(),str(Path(self.node.CONFIG['controlRoot'])/identifier),
                self.epoch+created,self.epoch+finished if finished is not None else None));db.commit()

    def sql(self,statement,args=()):
        with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
            db.execute(statement,args);db.commit()

    def mount(self):
        values=self.node.dataset_open_mounts(self.job,runner=True)
        for descriptor,_ in values:os.close(descriptor)
        return values

    def retry_record(self,event=10):
        return self.base_record.with_name('retry-'+str(event)+'.json')

    def terminal(self):
        with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
            db.row_factory=sqlite3.Row
            attempts=[dict(value) for value in db.execute('SELECT * FROM attempts ORDER BY ordinal')]
        return {'job':{'id':self.native_id,'submit_key':self.job['id'],'state':'FAILED','active_attempt_id':None},
                'attempts':attempts,'leases':[],'scale_up_reservations':[]}

    def next_attempt(self,*,new_epoch=False):
        self.sql('UPDATE attempts SET state=?,finished_at=? WHERE id=?',('PREEMPTED',self.epoch+50,self.current))
        self.current='A'+'3'*32
        if new_epoch:self.sql('INSERT INTO events VALUES (?,?,?,?)',(20,self.native_id,'JOB_RETRIED',self.epoch+55))
        self.attempt(self.current,3,'RUNNING',60,None)
        os.environ.update(GPUQ_ATTEMPT_ID=self.current,GPUQ_CONTROL_DIR=str(Path(self.node.CONFIG['controlRoot'])/self.current))

    def test_verified_retry_creates_independent_namespace_and_preserves_base_bytes(self):
        self.assertEqual(len(self.mount()),1)
        self.assertEqual(self.leases()[0]['jobId'],'retry:'+self.job['id']+':10')
        self.assertEqual(json.loads(self.retry_record().read_text())['state'],'HANDED_OFF')
        self.assertEqual(self.base_record.read_bytes(),self.base_bytes)
        self.mount();self.assertEqual(len(self.leases()),1)

    def test_original_prepared_first_attempt_needs_no_retry_epoch(self):
        self.sql('DELETE FROM events');self.sql('DELETE FROM attempts WHERE id=?',(self.first,))
        self.sql('UPDATE attempts SET ordinal=1')
        base=json.loads(self.base_bytes)
        lease=self.cache.acquire_lease(self.user,'example',self.version,self.job['id'])
        base.update(state='HELD',leases=[lease]);self.s._save(self.base_record,base)
        self.mount()
        self.assertEqual(self.leases()[0]['jobId'],self.job['id'])
        self.assertFalse(self.retry_record().exists())

    def test_fixed_system_python_canonical_path_is_valid_for_first_and_retry_attempts(self):
        # GPUQ persists the resolved interpreter, e.g. python3 -> python3.10.
        # Model that exact system alias on hosts whose /usr/bin/python3 is not
        # itself a symlink; the runner and every other path still resolve normally.
        resolve=Path.resolve
        def canonical(path,*args,**kwargs):
            if path==Path('/usr/bin/python3'):return Path('/usr/bin/python3.10')
            return resolve(path,*args,**kwargs)
        self.sql('UPDATE jobs SET argv_json=?',(json.dumps([
            '/usr/bin/python3.10',str(self.node.HERE/'sandbox-runner.py'),self.job['id']]),))
        with patch.object(Path,'resolve',canonical):
            proof=self.node.dataset_runner_proof(self.job)
            self.assertEqual(proof['retry']['id'],10)
            self.sql('DELETE FROM events');self.sql('DELETE FROM attempts WHERE id=?',(self.first,))
            self.sql('UPDATE attempts SET ordinal=1')
            self.assertIsNone(self.node.dataset_runner_proof(self.job)['retry'])

    def test_current_system_python_canonical_path_works_without_resolver_mock(self):
        canonical=str(Path('/usr/bin/python3').resolve(strict=True))
        self.sql('UPDATE jobs SET argv_json=?',(json.dumps([
            canonical,str(self.node.HERE/'sandbox-runner.py'),self.job['id']]),))
        self.assertEqual(self.node.dataset_runner_proof(self.job)['nativeJobId'],self.native_id)

    def test_system_python_alias_does_not_authorize_other_aliases_flags_or_wrappers(self):
        alias=self.base/'untrusted-python';alias.symlink_to('/usr/bin/python3')
        runner=str(self.node.HERE/'sandbox-runner.py');jid=self.job['id']
        canonical=str(Path('/usr/bin/python3').resolve(strict=True))
        cases=[['python3',runner,jid],[str(alias),runner,jid],
               ['/usr/bin/../bin/python3',runner,jid],['/usr/local/bin/python3',runner,jid],
               [canonical,'-I',runner,jid],[canonical,runner,jid,'extra'],
               [canonical,'/tmp/sandbox-runner.py',jid],[canonical,runner,'other-job'],
               [canonical,runner],None,{}]
        for argv in cases:
            with self.subTest(argv=argv):
                self.sql('UPDATE jobs SET argv_json=?',(json.dumps(argv),))
                with self.assertRaisesRegex(ValueError,'wrapper identity differs'):
                    self.node.dataset_runner_proof(self.job)
        self.assertEqual(self.leases(),[])

    def test_legacy_absent_journal_still_acquires_but_retry_history_cannot_lose_base(self):
        self.base_record.unlink()
        self.mount();self.assertEqual(self.leases()[0]['jobId'],self.job['id'])
        self.cache.release_lease(self.admin,'example',self.version,self.leases()[0]['id'])
        self.receipt().unlink()
        self.base_record.write_bytes(self.base_bytes);self.base_record.chmod(0o600)
        self.mount();self.base_record.unlink()
        with self.assertRaisesRegex(ValueError,'without their permanent base fence'):self.mount()
        self.assertEqual(self.leases()[0]['jobId'],'retry:'+self.job['id']+':10')

    def test_plain_prepare_and_handoff_still_cannot_reopen_base(self):
        with self.assertRaisesRegex(ValueError,'finalized'):self.s.prepare(self.job)
        with self.assertRaisesRegex(ValueError,'not ready'):self.node.acquire_datasets(self.job)
        self.assertFalse(self.retry_record().exists());self.assertEqual(self.leases(),[])

    def test_no_explicit_native_retry_event_is_not_authority(self):
        self.sql('DELETE FROM events')
        with self.assertRaisesRegex(ValueError,'verified explicit'):self.mount()
        self.assertFalse(self.retry_record().exists())

    def test_future_retry_event_and_unstopped_predecessor_timestamps_are_rejected(self):
        self.sql('UPDATE events SET created_at=?',(self.epoch+45,))
        with self.assertRaisesRegex(ValueError,'retry epoch'):self.mount()
        self.sql('UPDATE events SET created_at=?',(self.epoch+15,))
        with self.assertRaisesRegex(ValueError,'retry precedes termination'):self.mount()
        self.assertEqual(self.leases(),[])

    def test_other_base_finalization_states_remain_permanent_fences(self):
        original=json.loads(self.base_bytes)
        for state in ('CANCELED','CANCELING','RELEASING'):
            with self.subTest(state=state):
                self.s._save(self.base_record,{**original,'state':state})
                with self.assertRaisesRegex(ValueError,'previous preparation was finalized'):self.mount()
        self.assertFalse(self.retry_record().exists());self.assertEqual(self.leases(),[])

    def test_cancellation_between_first_and_second_proof_retains_hold_without_execution(self):
        original=self.node.dataset_runner_proof;calls=[]
        def changing(job):
            calls.append(1)
            if len(calls)==2:(self.node.ROOT/'jobs'/(self.job['id']+'.canceled')).touch()
            return original(job)
        with patch.object(self.node,'dataset_runner_proof',side_effect=changing):
            with self.assertRaisesRegex(ValueError,'cancellation is newer'):self.mount()
        self.assertEqual(len(self.leases()),1)
        self.assertEqual(self.base_record.read_bytes(),self.base_bytes)

    def test_untrusted_spec_owner_wrapper_submit_key_and_cgroup_are_denied(self):
        cases=[('UPDATE jobs SET owner=?',('other',)),('UPDATE jobs SET submit_key=?',('different',)),
               ('UPDATE jobs SET argv_json=?',(json.dumps(['/usr/bin/python3','/tmp/evil.py',self.job['id']]),))]
        for statement,args in cases:
            with self.subTest(statement=statement):
                self.sql(statement,args)
                with self.assertRaises(ValueError):self.mount()
                self.sql('UPDATE jobs SET owner=?,submit_key=?,argv_json=?',(self.node.gpuq_owner(self.job),self.job['id'],
                    json.dumps(['/usr/bin/python3',str(self.node.HERE/'sandbox-runner.py'),self.job['id']])))
        with patch.object(self.node,'dataset_runner_group',return_value='/user.slice/unrelated.service'):
            with self.assertRaisesRegex(ValueError,'cgroup'):self.mount()
        persisted=self.node.ROOT/'jobs'/(self.job['id']+'.json')
        self.node.atomic_json(persisted,{**self.job,'name':'changed'})
        with self.assertRaisesRegex(ValueError,'immutable'):self.mount()
        self.assertEqual(self.leases(),[])

    def test_stale_attempt_and_unknown_prior_unit_are_denied(self):
        os.environ['GPUQ_ATTEMPT_ID']=self.first
        os.environ['GPUQ_CONTROL_DIR']=str(Path(self.node.CONFIG['controlRoot'])/self.first)
        with self.assertRaisesRegex(ValueError,'current native attempt'):self.mount()
        os.environ['GPUQ_ATTEMPT_ID']=self.current
        os.environ['GPUQ_CONTROL_DIR']=str(Path(self.node.CONFIG['controlRoot'])/self.current)
        with patch.object(self.node,'dataset_unit_stopped',return_value=False):
            with self.assertRaisesRegex(ValueError,'termination is unconfirmed'):self.mount()
        self.assertEqual(self.leases(),[])

    def test_current_unit_requires_exact_cgroup_and_main_pid_not_a_matching_basename(self):
        unit='gpuq-'+self.current.lower()+'.service';group='/user.slice/'+unit
        def result(cgroup,pid=None):return SimpleNamespace(returncode=0,stdout=
            'LoadState=loaded\nActiveState=active\nMainPID='+str(os.getpid() if pid is None else pid)+'\nControlGroup='+cgroup+'\n')
        with patch.object(self.node.subprocess,'run',return_value=result(group)):
            self.assertTrue(self.current_unit_original(unit,group))
            self.assertFalse(self.current_unit_original(unit,'/untrusted/'+unit))
        with patch.object(self.node.subprocess,'run',return_value=result(group,123456789)):
            self.assertFalse(self.current_unit_original(unit,group))
        with patch.object(self.node,'dataset_current_unit',return_value=False):
            with self.assertRaisesRegex(ValueError,'verified native unit main process'):self.mount()

    def test_late_canceled_marker_or_permanent_rejection_blocks_retry(self):
        canceled=self.node.ROOT/'jobs'/(self.job['id']+'.canceled');canceled.touch()
        with self.assertRaisesRegex(ValueError,'cancellation is newer'):self.mount()
        canceled.unlink()
        rejected=self.node.ROOT/'jobs'/(self.job['id']+'.dataset-not-submitted.json');rejected.write_text('{}')
        with self.assertRaisesRegex(ValueError,'permanently rejected'):self.mount()
        self.assertEqual(self.leases(),[])

    def test_preempt_restart_reuses_epoch_and_tracks_each_consumer(self):
        self.mount();leases=self.leases();self.next_attempt();self.mount()
        self.assertEqual(self.leases(),leases)
        self.assertEqual(json.loads(self.retry_record().read_text())['consumers'],['A'+'2'*32,'A'+'3'*32])
        self.assertEqual(self.base_record.read_bytes(),self.base_bytes)

    def test_next_epoch_retires_only_previous_namespace(self):
        self.mount();old=self.leases()[0]['id']
        unrelated=self.cache.acquire_lease(self.user,'example',self.version,'another-job')
        self.next_attempt(new_epoch=True);self.mount()
        self.assertEqual(json.loads(self.retry_record().read_text())['state'],'RELEASED')
        self.assertEqual({value['jobId'] for value in self.leases()},{'another-job','retry:'+self.job['id']+':20'})
        self.assertNotIn(old,{value['id'] for value in self.leases()})
        self.assertIn(unrelated['leaseId'],{value['id'] for value in self.leases()})
        self.assertEqual(self.base_record.read_bytes(),self.base_bytes)

    def test_partial_acquisition_recovers_unjournaled_lease_by_exact_epoch(self):
        original=self.s._save
        def fail(path,record):
            if path==self.retry_record() and record['leases']:raise OSError('fixture disk failure')
            return original(path,record)
        with patch.object(self.s,'_save',side_effect=fail):
            with self.assertRaisesRegex(OSError,'disk failure'):self.mount()
        self.assertEqual(len(self.leases()),1)
        self.assertEqual(json.loads(self.retry_record().read_text())['leases'],[])
        self.next_attempt(new_epoch=True);self.mount()
        self.assertEqual(len(self.leases()),1)
        self.assertEqual(self.leases()[0]['jobId'],'retry:'+self.job['id']+':20')

    def test_cleanup_discards_stale_terminal_snapshot_and_keeps_current_generation(self):
        self.mount();stale=self.terminal()
        fresh={**stale,'job':{**stale['job'],'state':'RUNNING','active_attempt_id':self.current}}
        with patch.object(self.node,'gpu',return_value=fresh) as gpu:
            self.assertFalse(self.node.release_datasets(self.job,stale))
            gpu.assert_called_once_with('show',self.native_id)
        self.assertEqual(len(self.leases()),1)

    def test_cleanup_waiting_on_job_flock_rechecks_after_new_generation_handoff(self):
        stale=self.terminal();stale['attempts']=[{**value,'state':'EXITED_FAILURE'} for value in stale['attempts']]
        current=self.terminal();current['job']['state']='RUNNING';current['job']['active_attempt_id']=self.current
        waiting=threading.Event()
        def cleanup():
            with open(self.node.ROOT/'jobs'/(self.job['id']+'.lock'),'a') as guard:
                waiting.set();fcntl.flock(guard,fcntl.LOCK_EX)
                return self.node.release_datasets(self.job,stale)
        with patch.object(self.node,'gpu',return_value=current):
            with open(self.node.ROOT/'jobs'/(self.job['id']+'.lock'),'a') as guard:
                fcntl.flock(guard,fcntl.LOCK_EX)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending=pool.submit(cleanup);self.assertTrue(waiting.wait(3))
                    self.s.runner_handoff(self.job,self.node.dataset_runner_proof(self.job))
                    fcntl.flock(guard,fcntl.LOCK_UN)
                    self.assertFalse(pending.result(timeout=5))
        self.assertEqual(len(self.leases()),1)

    def test_unknown_old_generation_consumer_blocks_retirement(self):
        self.mount();old=json.loads(self.retry_record().read_text());old['consumers'].append('A'+'9'*32)
        self.s._save(self.retry_record(),old)
        self.next_attempt(new_epoch=True)
        with self.assertRaisesRegex(ValueError,'not confirmed stopped'):self.mount()
        self.assertEqual(len(self.leases()),1)
        self.assertEqual(self.leases()[0]['jobId'],'retry:'+self.job['id']+':10')

    def test_cleanup_requires_every_consumer_stopped_and_preserves_base(self):
        self.mount();self.next_attempt();self.mount()
        self.sql('UPDATE attempts SET state=?,finished_at=? WHERE id=?',('EXITED_FAILURE',self.epoch+70,self.current))
        terminal=self.terminal()
        missing={**terminal,'attempts':terminal['attempts'][:-1]}
        with patch.object(self.node,'gpu',return_value=missing):
            with self.assertRaisesRegex(ValueError,'every generation consumer'):self.node.release_datasets(self.job,missing)
        # Do not let receipt cleanup happen before all generation proof checks.
        self.assertEqual(len(self.leases()),1)
        with patch.object(self.node,'gpu',return_value=terminal):
            self.assertTrue(self.node.release_datasets(self.job,terminal))
        self.assertEqual(self.leases(),[])
        self.assertEqual(self.base_record.read_bytes(),self.base_bytes)
        self.assertEqual(json.loads(self.retry_record().read_text())['state'],'RELEASED')

    def test_native_same_epoch_after_finalization_does_not_reopen(self):
        self.mount()
        record=json.loads(self.retry_record().read_text());record['state']='RELEASED'
        self.s._save(self.retry_record(),record)
        with self.assertRaisesRegex(ValueError,'generation was finalized'):self.mount()

    def test_unregister_after_final_lease_release_does_not_leave_stuck_receipt(self):
        self.mount()
        self.sql('UPDATE attempts SET state=?,finished_at=? WHERE id=?',('EXITED_FAILURE',self.epoch+70,self.current))
        terminal=self.terminal();original=self.s.finalize_training
        def retire_then_unregister(*args,**kwargs):
            result=original(*args,**kwargs)
            self.cache.evict(self.admin,'example',self.version)
            self.cache.unregister(self.admin,'example',self.version)
            return result
        with patch.object(self.node,'gpu',return_value=terminal),patch.object(self.s,'finalize_training',side_effect=retire_then_unregister):
            self.assertTrue(self.node.release_datasets(self.job,terminal))
        self.assertFalse(self.receipt().exists())
        self.assertEqual(self.base_record.read_bytes(),self.base_bytes)

    def test_unknown_receipt_cannot_release_any_generation(self):
        self.mount()
        self.sql('UPDATE attempts SET state=?,finished_at=? WHERE id=?',('EXITED_FAILURE',self.epoch+70,self.current))
        terminal=self.terminal()
        self.node.atomic_json(self.receipt(),[{'unrelated':True}])
        with patch.object(self.node,'gpu',return_value=terminal):
            with self.assertRaisesRegex(ValueError,'does not belong'):self.node.release_datasets(self.job,terminal)
        self.assertEqual(len(self.leases()),1)

    def test_changed_native_authority_after_handoff_does_not_start_training(self):
        original=self.node.dataset_runner_proof;calls=[]
        def changing(job):
            calls.append(1)
            if len(calls)==2:self.sql('UPDATE attempts SET state=? WHERE id=?',('TERM_REQUESTED',self.current))
            return original(job)
        with patch.object(self.node,'dataset_runner_proof',side_effect=changing):
            with self.assertRaisesRegex(ValueError,'current native attempt'):self.mount()
        self.assertEqual(len(self.leases()),1)  # Retain until stopped proof, never guess.

    def test_job_flock_prevents_runner_from_using_prelock_proof(self):
        started=threading.Event()
        def runner():started.set();return self.mount()
        with open(self.node.ROOT/'jobs'/(self.job['id']+'.lock'),'a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending=pool.submit(runner);self.assertTrue(started.wait(3))
                time.sleep(.05);self.assertFalse(pending.done())
                self.sql('UPDATE jobs SET state=?',('CANCELED',))
                fcntl.flock(lock,fcntl.LOCK_UN)
                with self.assertRaisesRegex(ValueError,'current authorized'):pending.result(timeout=5)
        self.assertEqual(self.leases(),[])


if __name__=='__main__':unittest.main()
