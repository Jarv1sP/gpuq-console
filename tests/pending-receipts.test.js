import test from 'node:test';
import assert from 'node:assert/strict';
import {jobCompletion} from '../job-observation.mjs';
import {pendingJobReason} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';
import {completionMatchesJob,completionHTML,nativeObservationHTML} from '../dist/job-diagnostics-ui.js';

const id='11111111-1111-4111-8111-111111111111',key='22222222-2222-4222-8222-222222222222';
const job=()=>({id,key,digest:'a'.repeat(64),userId:'owner',machine:MACHINES[0].id,
  state:'SUBMITTING',dispatchPending:true,cards:1,spec:{id,userId:'owner',argv:['true']}});

test('admitted submission without a native ID waits without claiming lost records or manual recovery',()=>{
  for(const state of ['SUBMITTING','PENDING','QUEUED','PREPARING_DATA']){
    const value={...job(),state},before=structuredClone(value),result=jobCompletion(value);
    assert.equal(result.state,'WAITING');assert.equal(result.completed,false);
    assert.equal(result.nativeObservation.status,'WAITING');
    assert.deepEqual(result.nativeObservation.manualRecovery,{required:false,reason:null});
    assert.equal(result.submission.key,key);assert.equal(result.submission.status,'RECORDED');
    assert.equal(completionMatchesJob(result,value),true);assert.match(completionHTML(result),/等待中/);
    assert.match(nativeObservationHTML(result.nativeObservation),/等待节点确认/);
    assert.equal(completionMatchesJob({...result,completed:true},value),false);
    assert.equal(completionMatchesJob(result,{...value,userId:'other'}),false);
    assert.deepEqual(value,before);
  }
});

test('an authenticated pending native receipt is waiting even before the Portal submission catches up',()=>{
  const value={...job(),nodeJobId:'J0123456789ab'};
  const result=jobCompletion(value,{nodeJobId:value.nodeJobId,state:'PENDING',assignedIndices:[],
    nativeObservation:{protocol:'native-observation-v1',status:'CONFIRMED',jobId:id,userId:value.userId,
      nodeJobId:value.nodeJobId,submitKey:id,specVerified:true,state:'PENDING',nativeVersion:1,
      observedAt:100,latestAttempt:null,latestRetry:null,progress:null}});
  assert.equal(result.state,'WAITING');assert.equal(result.completed,false);
  assert.equal(result.nativeObservation.status,'CONFIRMED');
  assert.deepEqual(result.nativeObservation.manualRecovery,{required:false,reason:null});
});

test('missing native identities in historical, unknown, canceled and already-attempted jobs stay unconfirmed',()=>{
  for(const patch of [{state:'FAILED'},{state:'SUCCEEDED'},{state:'UNKNOWN'},
    {state:'CANCELED'},{cancelRequested:true},{latestAttempt:{id:'old',ordinal:1,state:'EXITED_FAILURE'}},
    {spec:{id:'other',userId:'owner',argv:['true']}}]){
    const result=jobCompletion({...job(),...patch});
    assert.equal(result.state,'UNCONFIRMED');assert.equal(result.completed,false);
  }
  const result=jobCompletion({...job(),nodeJobId:'J0123456789ab'});
  assert.equal(result.state,'UNCONFIRMED');assert.equal(result.nativeObservation.manualRecovery.required,true);
});

function queueFixture(){
  const machine=MACHINES[0],now=Date.parse('2026-10-10T12:00:00Z');
  const pending={...job(),state:'PENDING',createdAt:new Date(now).toISOString(),schedulerPriority:2};
  const draining=Array.from({length:machine.cards-2},(_,i)=>({id:'canceled-'+i,machine:machine.id,
    state:'UNKNOWN',cancelRequested:true,assignedIndices:[i],schedulerCheckedAt:new Date(now).toISOString(),
    latestAttempt:{id:'attempt-'+i,state:'DRAINING',finishedAt:null}}));
  const service={store:{jobs:[pending,...draining],get:()=>({id:'owner',role:'admin',enabled:true,limits:{[machine.id]:8}})},
    gpuq:{checkedAt:new Date(now).toISOString(),stale:false,hosts:[{id:machine.id,reachable:true,gpus:[],
      gpuq:{connected:true,jobs:[{id:'running',state:'RUNNING',assigned_gpu_indices:[machine.cards-2,machine.cards-1]}]}}]}};
  return {service,pending,draining,machine,now};
}

test('fresh DRAINING allocations explain full cards even when CUDA process lists are empty',()=>{
  const f=queueFixture(),before=structuredClone(f.service.gpuq),jobs=structuredClone(f.service.store.jobs);
  const reason=pendingJobReason(f.service,f.pending,f.now);
  assert.match(reason,/显卡已满/);assert.match(reason,/等待任务收尾/);
  assert.ok(reason.includes(`${f.draining.length} 张`));
  assert.deepEqual(f.service.gpuq,before);assert.deepEqual(f.service.store.jobs,jobs);
});

test('released, expired and other-machine attempt reports cannot claim DRAINING occupancy',()=>{
  for(const patch of [{assignedIndices:[]},{schedulerCheckedAt:'2026-10-10T11:00:00Z'},
    {machine:MACHINES[1].id},{latestAttempt:{state:'CANCELED',finishedAt:100}}]){
    const f=queueFixture();for(const value of f.draining)Object.assign(value,patch);
    assert.equal(pendingJobReason(f.service,f.pending,f.now),'等待调度器分配，原因未上报');
  }
});
