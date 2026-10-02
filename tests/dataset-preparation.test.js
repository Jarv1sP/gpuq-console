import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceDataPreparation,DATA_PREPARING} from '../dataset-preparation.mjs';
import {usage} from '../execution.mjs';

const ref={dataset:'sample',version:'a'.repeat(64)};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture({jobs=1,total=1}={}){
  const user={id:'u1',username:'alice',role:'member',enabled:true,total,limits:{'gpu-1':total},policyVersion:1};
  const records=Array.from({length:jobs},(_,index)=>({id:'job-'+index,userId:user.id,machine:'gpu-1',cards:1,
    digest:'digest-'+index,spec:{argv:['python','train.py']},datasets:[ref],state:DATA_PREPARING,cancelRequested:false}));
  let tail=Promise.resolve(),inQueue=false;
  const calls=[],saves=[];
  const service={store:{jobs:records,get:id=>{if(id!==user.id||service.deleted)throw Error('missing user');return structuredClone(user);}},
    gpuq:{stale:false,hosts:[{id:'gpu-1',reachable:true,gpuq:{connected:true,observeOnly:false}}]},
    enqueue:fn=>{const result=tail.then(async()=>{inQueue=true;try{return await fn();}finally{inQueue=false;}});tail=result.catch(()=>{});return result;},
    save:()=>{if(service.saveFailure)throw Error('save failed');saves.push(structuredClone(records));},
    bridge:async(machine,operation,args)=>{assert.equal(inQueue,false,'remote I/O must not hold the mutation queue');calls.push({machine,operation,args});return {state:'READY',dataset:args.dataset,version:args.version};},
    refreshGPUQ:async()=>assert.equal(inQueue,false,'status refresh must not hold the mutation queue')};
  return {service,user,jobs:records,calls,saves};
}

test('slow node observation does not block mutations; cancellation prevents dispatch or cache-worker cancellation',{timeout:2000},async()=>{
  const f=fixture(),entered=deferred(),response=deferred();
  f.service.bridge=async()=>{entered.resolve();return response.promise;};
  const work=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
  await f.service.enqueue(()=>{f.jobs[0].cancelRequested=true;});
  response.resolve({...ref,state:'REGISTERED'});await work;
  assert.equal(f.jobs[0].state,'CANCELED');assert.equal(usage(f.jobs,f.user.id),0);
});

test('role, grants, enabled state and full account fingerprint are rechecked after I/O',async()=>{
  for(const change of [u=>u.role='admin',u=>u.total=2,u=>u.limits['gpu-1']=2,u=>u.enabled=false,u=>u.username='renamed',u=>u.policyVersion++]){
    const f=fixture(),entered=deferred(),response=deferred();
    f.service.bridge=async()=>{entered.resolve();return response.promise;};
    const work=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
    await f.service.enqueue(()=>change(f.user));response.resolve({...ref,state:'READY'});await work;
    assert.equal(f.jobs[0].state,'FAILED');assert.equal(usage(f.jobs,f.user.id),0);
  }
});

test('removed user or mutated immutable job cannot promote a stale READY observation',async()=>{
  for(const change of [f=>f.service.deleted=true,f=>f.jobs[0].spec.argv=['changed']]){
    const f=fixture(),entered=deferred(),response=deferred();
    f.service.bridge=async()=>{entered.resolve();return response.promise;};
    const work=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
    await f.service.enqueue(()=>change(f));response.resolve({...ref,state:'READY'});await work;
    assert.equal(f.jobs[0].state,'FAILED');assert.equal(usage(f.jobs,f.user.id),0);
  }
});

test('concurrent preparation completion checks quota and reserves atomically',async()=>{
  const f=fixture({jobs:2});
  await Promise.all(f.jobs.map(job=>advanceDataPreparation(f.service,job,usage)));
  assert.equal(f.jobs.filter(job=>job.state==='SUBMITTING').length,1);
  assert.equal(f.jobs.filter(job=>job.state===DATA_PREPARING).length,1);
  assert.equal(usage(f.jobs,f.user.id),1);
  const waiting=f.jobs.find(job=>job.state===DATA_PREPARING);
  assert.match(waiting.queueReason,/等待个人可用卡数额度/);
  f.jobs.find(job=>job.state==='SUBMITTING').state='SUCCEEDED';
  await advanceDataPreparation(f.service,waiting,usage);assert.equal(waiting.state,'SUBMITTING');
});

test('duplicate observation for one job shares one operation and cannot reserve twice',async()=>{
  const f=fixture(),response=deferred();let calls=0;
  f.service.bridge=async()=>{calls++;return response.promise;};
  const first=advanceDataPreparation(f.service,f.jobs[0],usage),second=advanceDataPreparation(f.service,f.jobs[0],usage);
  assert.equal(first,second);response.resolve({...ref,state:'READY'});await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(f.saves.length,1);assert.equal(usage(f.jobs,f.user.id),1);
  await advanceDataPreparation(f.service,f.jobs[0],usage);assert.equal(calls,1);
});

test('a verified personal replica keeps the logical user path and leases its real ID',async()=>{
  const f=fixture();let observations=0;
  const actual={dataset:'u-personal-copy',version:ref.version,mountAs:ref.dataset};
  f.service.resolveDataset=async()=>{observations++;return {status:{...ref,state:'READY'},reference:actual};};
  await advanceDataPreparation(f.service,f.jobs[0],usage);
  assert.equal(observations,1);assert.equal(f.jobs[0].state,'SUBMITTING');
  assert.deepEqual(f.jobs[0].datasets,[ref]);assert.deepEqual(f.jobs[0].spec.datasets,[actual]);
});

test('failed durable reservation restores all in-memory fields and can retry safely',async()=>{
  const f=fixture(),before=structuredClone(f.jobs[0]);f.service.saveFailure=true;
  await assert.rejects(advanceDataPreparation(f.service,f.jobs[0],usage),/save failed/);
  assert.deepEqual(f.jobs[0],before);assert.equal(usage(f.jobs,f.user.id),0);
  f.service.saveFailure=false;await advanceDataPreparation(f.service,f.jobs[0],usage);
  assert.equal(f.jobs[0].state,'SUBMITTING');assert.equal(f.saves.length,1);
});

test('cancellation save failure retains pending cancellation and never reserves',async()=>{
  const f=fixture();f.jobs[0].cancelRequested=true;f.service.saveFailure=true;
  await assert.rejects(advanceDataPreparation(f.service,f.jobs[0],usage),/save failed/);
  assert.equal(f.jobs[0].state,DATA_PREPARING);assert.equal(f.jobs[0].cancelRequested,true);
  assert.equal(f.calls.length,0);assert.equal(usage(f.jobs,f.user.id),0);
  f.service.saveFailure=false;await advanceDataPreparation(f.service,f.jobs[0],usage);assert.equal(f.jobs[0].state,'CANCELED');
});

test('preparing or failed data never enters scheduler submission; actor is always owner-only',async()=>{
  const f=fixture();
  f.service.bridge=async(machine,operation,args)=>{f.calls.push({operation,args});return {...ref,state:operation==='datasets.status'?'REGISTERED':'PREPARING'};};
  await advanceDataPreparation(f.service,f.jobs[0],usage);
  assert.equal(f.jobs[0].state,DATA_PREPARING);assert.equal(usage(f.jobs,f.user.id),0);
  assert.deepEqual(f.calls.map(call=>call.operation),['datasets.status','datasets.prepare']);
  assert.ok(f.calls.every(call=>call.args.userId===f.user.id&&call.args.hostAdmin===false));
  f.service.bridge=async()=>({...ref,state:'FAILED'});
  await advanceDataPreparation(f.service,f.jobs[0],usage);assert.equal(f.jobs[0].state,'FAILED');
});

test('wrong data version, invalid project, unavailable host and shutdown fail closed',async()=>{
  const mismatch=fixture();mismatch.service.bridge=async()=>({...ref,version:'b'.repeat(64),state:'READY'});
  await assert.rejects(advanceDataPreparation(mismatch.service,mismatch.jobs[0],usage),/版本不符/);
  assert.equal(mismatch.jobs[0].state,DATA_PREPARING);
  const project=fixture();Object.assign(project.jobs[0],{project:'p',release:'r'});
  project.service.bridge=async(_machine,operation)=>operation==='projects.verify'?{state:'READY',project:'other',release:'r'}:{...ref,state:'READY'};
  await advanceDataPreparation(project.service,project.jobs[0],usage);assert.equal(project.jobs[0].state,'FAILED');
  const offline=fixture();offline.service.gpuq.stale=true;
  await advanceDataPreparation(offline.service,offline.jobs[0],usage);assert.equal(offline.jobs[0].state,DATA_PREPARING);
  assert.match(offline.jobs[0].queueReason,/等待服务器恢复/);
  const closed=fixture();closed.service.closing=true;
  await advanceDataPreparation(closed.service,closed.jobs[0],usage);assert.equal(closed.calls.length,0);assert.equal(closed.saves.length,0);
});
