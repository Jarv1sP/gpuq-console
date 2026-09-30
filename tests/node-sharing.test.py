"""Pinned/shared admission and HAMi namespace mapping; no CUDA/library execution."""
import hashlib
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
import uuid

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'gpuq'))
from gpuq.backends import GpuDevice
from gpuq.coordinator import Coordinator
from gpuq.hami import runtime_environment
from gpuq.store import Store
from gpuq.submission import validate_submission

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'deploy'/filename);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
P=load('placement_policy','scheduling-policy.py');C=load('placement_control','training-control.py')

class Sharing(unittest.TestCase):
    def job(self,**changes):return {'cards':1,'priority':'normal','preemptIdleOnly':True,'placement':{'gpuIndices':[3],'shared':True,'vramMiB':4097,'hami':False},**changes}

    def test_fixed_and_shared_native_arguments_and_runtime_gpu_set(self):
        job=self.job();args=P.allocation_arguments(job)
        self.assertEqual(args,['--gpu','3','--share','--vram-gb','4.0009765625'])
        with self.assertRaisesRegex(ValueError,'ownership'):P.allocated_spec(job,['3'],['GPU-test'])
        for changes in ({'priority':'idle'},{'elastic':{}},{'placement':{'gpuIndices':[3,3],'shared':False}}):
            with self.assertRaises(ValueError):P.gpu_placement({**job,**changes})

    def test_native_uuid_binding_survives_index_drift_but_rejects_other_gpus_or_jobs(self):
        with tempfile.TemporaryDirectory() as temp:
            config={'database':str(Path(temp)/'db')};job={**self.job(),'id':str(uuid.uuid4())};env={'GPUQ_ATTEMPT_ID':'A1','GPUQ_JOB_ID':'J1'}
            with closing(sqlite3.connect(config['database'])) as db:
                db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT,placement TEXT,requested_gpu_uuids_json TEXT)')
                db.execute('CREATE TABLE attempts(id TEXT,job_id TEXT,gpu_uuids_json TEXT,gpu_indices_json TEXT)')
                db.execute('INSERT INTO jobs VALUES (?,?,?,?)',('J1',job['id'],'pinned','["GPU-physical"]'))
                db.execute('INSERT INTO attempts VALUES (?,?,?,?)',('A1','J1','["GPU-physical"]','[4]'));db.commit()
            # The submitted GPU3 is now the same physical UUID at index4.
            self.assertEqual(P.allocated_spec(job,['4'],['GPU-physical'],config,env)['cards'],1)
            for indices,uuids,who in ((['3'],['GPU-physical'],env),(['4'],['GPU-other'],env),(['4'],['GPU-physical'],{**env,'GPUQ_JOB_ID':'Jother'})):
                with self.assertRaises(ValueError):P.allocated_spec(job,indices,uuids,config,who)

    def test_uuid_binding_uses_a_real_private_native_schema_without_migration(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);database=root/'native.db';store=Store(database).initialize()
            try:
                submit_key=str(uuid.uuid4());raw={'submit_key':submit_key,'name':'pinned-test','owner':'alice','priority':2,'dispatch_mode':'queue','yield_policy':'never','checkpoint_capability':'none','restart_policy':'never','gpu_count':1,'placement':'pinned','requested_gpu_uuids':['GPU-0'],'argv':[sys.executable,'-c','pass'],'cwd':str(root),'env':{}}
                native=store.submit_job(validate_submission(raw,1,managed_gpu_uuids=('GPU-0',)));aid='A'+uuid.uuid4().hex
                attempt=store.create_attempt(native['id'],attempt_id=aid,state='RUNNING',gpu_uuids=['GPU-0'],gpu_indices=[4],unit_name='gpuq-'+aid.lower(),unit_token='own-test',boot_id='test-boot',control_dir=str(root/'control'),log_path=str(root/'log'))
                store.acquire_leases(native['id'],aid,{'GPU-0':4})
                job={**self.job(),'id':submit_key};env={'GPUQ_ATTEMPT_ID':aid,'GPUQ_JOB_ID':native['id']}
                self.assertEqual(P.allocated_spec(job,['4'],['GPU-0'],{'database':str(database)},env)['cards'],1)
                with self.assertRaises(ValueError):P.allocated_spec({**job,'id':str(uuid.uuid4())},['4'],['GPU-0'],{'database':str(database)},env)
                self.assertEqual(store.check_integrity()['schema_version'],11)
            finally:store.close()

    def coordinator(self,leases=(),holder_shared=False):
        device=GpuDevice(index=3,uuid='GPU-test',memory_total_mib=24576,memory_used_mib=8192,memory_free_mib=16384,utilization_percent=25,compute_pids=(123,))
        c=Coordinator.__new__(Coordinator);c._snapshot=(device,);c._quarantines={};c._statuses={'Aholder':object()};c.config=SimpleNamespace(max_idle_memory_mb=512)
        c.store=SimpleNamespace(list_scale_up_reservations=Mock(return_value=[]),list_leases=Mock(return_value=list(leases)),get_attempt=Mock(return_value={'id':'Aholder','state':'RUNNING'}),get_job=Mock(return_value={'state':'RUNNING','share_gpu':holder_shared,'vram_mb':4096}))
        return c,device

    def test_only_requester_consents_for_external_or_running_ordinary_holder(self):
        shared={'share_gpu':True,'requested_gpu_uuids':['GPU-test'],'vram_mb':4096}
        for leases in ([],[{'gpu_uuid':'GPU-test','attempt_id':'Aholder','job_id':'Jholder'}]):
            c,device=self.coordinator(leases)
            self.assertEqual(c._shared_devices_for_job(shared),[device])
        c,_=self.coordinator();self.assertEqual(c._shared_devices_for_job({**shared,'vram_mb':20000}),[])
        c._quarantines={'GPU-test':object()};self.assertEqual(c._shared_devices_for_job(shared),[])

    def test_shared_reservations_count_and_an_ordinary_starting_holder_is_protected(self):
        lease={'gpu_uuid':'GPU-test','attempt_id':'Aholder','job_id':'Jholder'};shared={'share_gpu':True,'requested_gpu_uuids':['GPU-test'],'vram_mb':14000}
        c,_=self.coordinator([lease],True);self.assertEqual(c._shared_devices_for_job(shared),[])
        c,_=self.coordinator([lease]);c.store.get_attempt.return_value={'id':'Aholder','state':'STARTING'};self.assertEqual(c._shared_devices_for_job(shared),[])

    def test_bridge_requires_capability_before_forwarding_explicit_sharing(self):
        for ready in (False,True):
            with self.subTest(ready=ready),tempfile.TemporaryDirectory() as temp:
                root=Path(temp)
                for name in ('node-executor.py','scheduling-policy.py'):shutil.copy2(ROOT/'deploy'/name,root/name)
                config={'root':str(root/'state'),'cards':8,'gpu':'/not/a/gpu','database':str(root/'db')};(root/'node-config.json').write_text(json.dumps(config))
                with closing(sqlite3.connect(config['database'])) as db:db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT)');db.commit()
                mod=importlib.util.spec_from_file_location('sharing_node_test',root/'node-executor.py');node=importlib.util.module_from_spec(mod);mod.loader.exec_module(node)
                job={**self.job(),'id':str(uuid.uuid4()),'userId':'demo-user-1','username':'alice','argv':['python','small.py'],'name':'test','minVramGiB':0};commands=[]
                def run(command,**_):
                    args=command[2:];commands.append(args)
                    if args[0]=='status':return json.dumps({'daemon':{'capabilities':['priority-policy-v1','preempt-idle-only-v1',*(['gpu-placement-v1','gpu-sharing-v1'] if ready else [])]}})
                    if args[0]=='submit':return json.dumps({'job_id':'Jabc'})
                    if args[0]=='show':return json.dumps({'job':{'state':'PENDING'},'attempts':[]})
                    raise AssertionError(args)
                with patch.object(node,'run',side_effect=run),patch.object(node.SCHEDULING,'allocation_ready',return_value=True):
                    if ready:node.process('sync',{'job':job})
                    else:
                        with self.assertRaisesRegex(ValueError,'not ready'):node.process('sync',{'job':job})
                if ready:
                    submitted=next(c for c in commands if c[0]=='submit');self.assertEqual(submitted[1:6],['--gpu','3','--share','--vram-gb','4.0009765625'])
                else:self.assertNotIn('submit',[c[0] for c in commands])

    def test_hami_mount_uses_checked_library_and_attempt_cache_namespace(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'sdk.pyz';archive.touch();library=root/'hami/libvgpu.so';library.parent.mkdir();library.write_bytes(b'\x7fELFtest-only-runtime')
            sha=hashlib.sha256(library.read_bytes()).hexdigest();manifest=library.with_name('manifest.json');manifest.write_text(json.dumps({'sha256':sha,'sm_supported':True}))
            control=root/'control'/('A'+uuid.uuid4().hex);control.mkdir(parents=True);workspace=root/'workspace';workspace.mkdir()
            jobid='Jabc';jid=str(uuid.uuid4());config={'gpuqArchive':str(archive),'controlRoot':str(control.parent),'database':str(root/'db')}
            with closing(sqlite3.connect(config['database'])) as db:
                db.execute('CREATE TABLE jobs(id TEXT, submit_key TEXT)');db.execute('CREATE TABLE attempts(id TEXT,job_id TEXT,control_dir TEXT)');db.execute('INSERT INTO jobs VALUES (?,?)',(jobid,jid));db.execute('INSERT INTO attempts VALUES (?,?,?)',(control.name,jobid,str(control)))
                db.commit()
            native={'hami_core':True,'vram_mb':4096,'sm_percent':50};env={'GPUQ_CONTROL_DIR':str(control),'GPUQ_JOB_ID':jobid,'GPUQ_ATTEMPT_ID':control.name,'UNRELATED_TOKEN':'must-not-forward',**runtime_environment(archive,{'control_dir':str(control)},native)}
            spec={'id':jid,'placement':{'gpuIndices':[3],'shared':True,'vramMiB':4096,'hami':True,'smPercent':50}}
            args,fds=C.prepare(config,spec,workspace,None,env)
            try:
                mapped={args[i+1]:args[i+2] for i,v in enumerate(args) if v=='--setenv'}
                self.assertEqual(mapped['LD_PRELOAD'],'/opt/gpuq/libvgpu.so');self.assertEqual(mapped['CUDA_DEVICE_MEMORY_SHARED_CACHE'],'/run/gpuq/control/hami/usage.cache')
                self.assertEqual(mapped['CUDA_DEVICE_MEMORY_LIMIT'],'4096m');self.assertEqual(mapped['CUDA_DEVICE_SM_LIMIT'],'50')
                self.assertEqual(os.fstat(fds[-1]).st_ino,library.stat().st_ino)
                self.assertNotIn('UNRELATED_TOKEN',mapped);self.assertEqual(args[args.index('/opt/gpuq/libvgpu.so')-2],'--ro-bind-data')
                with self.assertRaises(OSError):os.write(fds[-1],b'cannot-edit-library')
            finally:
                for fd in fds:os.close(fd)
            with self.assertRaises(ValueError):C.prepare(config,spec,workspace,None,{**env,'LD_PRELOAD':'/unrelated/library.so'})
            manifest.write_text(json.dumps({'sha256':sha,'sm_supported':False}))
            with self.assertRaises(ValueError):C.prepare(config,spec,workspace,None,env)
            library.write_bytes(b'\x7fELFchanged')
            with self.assertRaises(ValueError):C.hami_library(config,100)

if __name__=='__main__':unittest.main()
