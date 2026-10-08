import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {trainingPlan,trainingSource} from './training-storage-fixture.mjs';

const password='Training-Capacity-Dispatch-Fixture-2026!';
const ref={dataset:'training-data',version:'a'.repeat(64)},machine=MACHINES[0].id;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'training-storage-dispatch-'));
  const database=join(dir,'state.sqlite'),bootstrap=join(dir,'bootstrap.json'),status=join(dir,'status.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,health:'ok',observeOnly:false,jobs:[]}}))}));
  const calls=[],works=[];let service,planGate,availableBytes=2**40;
  const bridge=async(target,operation,args)=>{
    calls.push({machine:target,operation,args:structuredClone(args)});
    if(operation==='datasets.status')return {...ref,state:'READY'};
    if(operation==='datasets.training.status')return trainingSource(target,args);
    if(operation==='storage.training.plan'){
      if(planGate)await planGate.promise;
      return trainingPlan(target,args,{availableBytes});
    }
    if(operation==='sync'){
      const current=service.store.jobs.find(j=>j.id===args.job.id);
      assert.equal(current.dispatchPending,false);
      assert.equal(Object.hasOwn(args.job,'trainingStoragePlan'),false,'private capacity snapshot is not a native job field');
      return {state:'PENDING',assignedIndices:[]};
    }
    if(operation==='cancel')return {state:'CANCELED',assignedIndices:[]};
    throw Error('Unexpected fixture RPC: '+operation);
  };
  service=await PortalService.open(database,bootstrap,status,bridge);
  clearInterval(service.executionTimer);service.reconciling=true;
  const admin=await service.login('admin',password);
  const submit=async()=>(await service.invoke(admin.token,'jobs.submit',{machine,cards:1,argv:['true'],key:randomUUID(),datasets:[ref]})).result;
  const start=()=>{service.reconciling=false;const work=service.reconcile();works.push(work);return work;};
  t.after(async()=>{planGate?.resolve();await Promise.allSettled(works);await service.tail;service.close();await rm(dir,{recursive:true,force:true});});
  return {service,admin,calls,submit,start,job:id=>service.store.jobs.find(j=>j.id===id),
    capacity:value=>availableBytes=value,hold:()=>planGate=deferred()};
}

test('manual training rejects insufficient selected storage without a reservation or retargeting',async t=>{
  const f=await fixture(t);f.capacity(0);
  await assert.rejects(f.submit(),e=>e.status===409&&e.code==='SUBMISSION_REJECTED');
  assert.equal(f.service.store.jobs.length,0);
  assert.ok(f.calls.every(c=>c.machine===machine));
  assert.equal(f.calls.some(c=>['sync','datasets.prepare'].includes(c.operation)),false);
});

test('first dispatch refreshes selected storage and never sends an outdated admission',async t=>{
  const f=await fixture(t),reply=await f.submit(),job=f.job(reply.id);
  assert.equal(Object.hasOwn(reply,'trainingStoragePlan'),false);
  assert.equal(job.trainingStoragePlan.fits,true);
  f.capacity(0);await f.start();
  assert.equal(job.dispatchPending,true);assert.equal(job.state,'SUBMITTING');
  assert.match(job.error,/容量不足/);assert.equal(f.calls.some(c=>c.operation==='sync'),false);
  f.capacity(2**40);await f.service.reconcile();
  assert.equal(job.dispatchPending,false);assert.equal(job.state,'PENDING');
  assert.equal(f.calls.filter(c=>c.operation==='sync').length,1);
  assert.equal(f.calls.filter(c=>c.operation==='storage.training.plan').length,3);
});

test('capacity I/O does not block cancellation and cancellation prevents first sync',async t=>{
  const f=await fixture(t),reply=await f.submit(),gate=f.hold(),work=f.start();await tick();
  const canceled=await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:reply.id});
  assert.equal(canceled.result.cancelRequested,true);
  gate.resolve();await work;
  assert.equal(f.job(reply.id).state,'CANCELED');assert.equal(f.job(reply.id).dispatchPending,true);
  assert.equal(f.calls.some(c=>c.operation==='sync'),false);
  assert.equal(f.calls.filter(c=>c.operation==='cancel').length,1);
});

test('a changed immutable job spec fences a capacity reply before native dispatch',async t=>{
  const f=await fixture(t),reply=await f.submit(),gate=f.hold(),work=f.start();await tick();
  await f.service.enqueue(()=>{f.job(reply.id).spec.argv=['changed'];f.service.save();});
  gate.resolve();await work;
  assert.equal(f.job(reply.id).dispatchPending,true);
  assert.match(f.job(reply.id).error,/任务已改变/);
  assert.equal(f.calls.some(c=>c.operation==='sync'),false);
});

test('legacy unmarked jobs keep their original first-dispatch protocol',async t=>{
  const f=await fixture(t),reply=await f.submit(),job=f.job(reply.id);
  delete job.trainingStoragePlan;f.service.save();f.calls.length=0;
  await f.start();
  assert.deepEqual(f.calls.map(c=>c.operation),['sync']);
  assert.equal(job.state,'PENDING');assert.equal(job.dispatchPending,false);
});
