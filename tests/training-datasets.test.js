import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolveTrainingDataset} from '../training-datasets.mjs';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';

const ref={dataset:'sample',version:'a'.repeat(64)},machine='gpu-1';
function fixture(){
  const user={id:'demo-user-1',username:'member',enabled:true,role:'member',limits:{[machine]:1}},calls=[];
  const status={protocol:'dataset-training-source-v1',datasetWarehouseRead:1,machine,...ref,
    datasetReadMode:'warehouse',authority:'hdd',state:'READY',warehouseReady:true,reference:{...ref}};
  const service={store:{get:()=>structuredClone(user)},bridge:async(m,op,args)=>{
    calls.push({machine:m,operation:op,args});await service.onReply?.();return structuredClone(status);
  }};
  return {service,user,calls,status};
}

test('warehouse read uses only the actual training bridge with owner-only identity',async()=>{
  const f=fixture();f.service.resolveDataset=()=>assert.fail('warehouse never consults the hot resolver');
  assert.deepEqual(await resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse'),{status:f.status,reference:ref});
  assert.deepEqual(f.calls,[{machine,operation:'datasets.training.status',args:{userId:f.user.id,hostAdmin:false,...ref,datasetReadMode:'warehouse'}}]);
  f.status.reference.dataset='physical';
  assert.deepEqual((await resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse')).reference,{dataset:'physical',version:ref.version,mountAs:'sample'});
});

test('unconfirmed, changed or nonlocal warehouse receipts never become cache reads',async()=>{
  for(const changed of [{protocol:'old'},{machine:'gpu-2'},{datasetWarehouseRead:0},{datasetReadMode:'cache'},
    {version:'b'.repeat(64)},{warehouseReady:false},{reference:{...ref,path:'/root'}},{reference:{...ref,version:'b'.repeat(64)}}]){
    const f=fixture();Object.assign(f.status,changed);
    await assert.rejects(resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse'));
    assert.equal(f.calls.length,1);
  }
  const f=fixture();f.status.state='NOT_READY';f.status.warehouseReady=false;delete f.status.reference;
  assert.equal((await resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse')).reference,null);
  f.status.reference={...ref};await assert.rejects(resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse'));
});

test('authorization revoked during observation rejects the result without a second RPC',async()=>{
  const f=fixture();f.service.onReply=()=>{f.user.limits={};};
  await assert.rejects(resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse'),e=>e.status===403);
  assert.equal(f.calls.length,1);
});

test('every warehouse read failure is safely normalized, including preparation rereads',async()=>{
  for(const status of [undefined,403,503]){
    const f=fixture(),raw=Object.assign(Error('/private/warehouse/other-owner/record.json token=private'),{status,secret:'private'});
    const original=f.service.bridge;let reads=0;
    f.service.bridge=async(...args)=>{if(++reads===1)return original(...args);throw raw;};
    await resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse');
    await assert.rejects(resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse'),error=>{
      assert.notEqual(error,raw);
      assert.equal(error.status,status===403?403:503);
      assert.equal(error.code,status===403?'DATASET_TRAINING_FORBIDDEN':'DATASET_TRAINING_SOURCE_UNAVAILABLE');
      assert.doesNotMatch(error.message,/private|other-owner|record\.json|token/);
      assert.equal(error.secret,undefined);
      return true;
    });
    assert.equal(reads,2);
  }
});

test('a failed warehouse reply rechecks account and maintenance before its safe projection',async()=>{
  for(const scenario of ['revoked','maintenance']){
    const f=fixture();
    f.service.bridge=async()=>{
      if(scenario==='revoked')f.user.limits={};else f.service.maintenanceFor=()=>true;
      throw Error('/private/path');
    };
    await assert.rejects(resolveTrainingDataset(f.service,f.user.id,machine,ref,'warehouse'),error=>
      error.code===(scenario==='revoked'?'DATASET_TRAINING_AUTH_CHANGED':'MAINTENANCE_ACTIVE')&&!error.message.includes('/private'));
  }
});

test('legacy cache resolver errors retain their original behavior and identity',async()=>{
  const f=fixture(),raw=Error('legacy resolver error');
  f.service.resolveDataset=async()=>{throw raw;};
  await assert.rejects(resolveTrainingDataset(f.service,f.user.id,machine,ref,'cache'),error=>error===raw);
  assert.equal(f.calls.length,0);
});

test('legacy cache mode preserves the existing resolver and persisted submission identity',async()=>{
  const f=fixture(),original={status:{...ref,state:'READY'},reference:{...ref}};
  f.service.resolveDataset=async()=>original;
  assert.equal(await resolveTrainingDataset(f.service,f.user.id,machine,ref),original);
  assert.equal(f.calls.length,0);
  const args={machine,cards:1,argv:['python','train.py'],key:randomUUID(),project:'project',release:'b'.repeat(64),datasets:[ref]};
  const old=normalizeJobSubmission(args,{role:'member'}),cache=normalizeJobSubmission({...args,datasetReadMode:'cache'},{role:'member'});
  assert.deepEqual(cache,old);
  const warehouse=normalizeJobSubmission({...args,datasetReadMode:'warehouse'},{role:'member'});
  assert.notEqual(warehouse.digest,old.digest);
  const job=createSubmittedJob(warehouse,f.user,false);assert.equal(job.spec.datasetReadMode,'warehouse');
  assert.equal(Object.hasOwn(createSubmittedJob(old,f.user,false).spec,'datasetReadMode'),false);
  for(const extra of [{datasetReadMode:'automatic'},{datasetReadMode:true},{datasetReadMode:'warehouse',datasets:[]},{datasetReadMode:'warehouse',project:undefined,release:undefined}])
    assert.throws(()=>normalizeJobSubmission({...args,...extra},{role:'member'}));
});
