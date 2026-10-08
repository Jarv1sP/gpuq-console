import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingStoragePlan,trainingStorageDigest,validateTrainingStoragePlan,projectStorageFootprint,trainingStorageErrorBody} from '../training-storage.mjs';
import {MACHINES} from '../dist/model.js';
import {projectFootprint,trainingPlan,trainingSource} from './training-storage-fixture.mjs';

const machine=MACHINES[0].id,release='a'.repeat(64),image='sha256:'+'b'.repeat(64);
const baseArgs=()=>({userId:'demo-user-1',hostAdmin:false,datasets:[],datasetReadMode:'cache',projectFootprint:null,datasetFootprints:[]});
const probe=()=>({protocol:'portable-project-v1',enabled:true,environmentMode:'oci',architecture:'amd64',project:'vision',release,image,releaseReady:true,...projectFootprint});
function fixture(){
  const user={id:'demo-user-1',username:'alice',role:'member',enabled:true,total:2,limits:{[machine]:2}},calls=[];
  const service={store:{get:()=>structuredClone(user)},projectCopyProbe:async()=>probe(),maintenanceFor:()=>false,
    bridge:async(id,operation,args)=>{
      calls.push({id,operation,args});assert.equal(id,machine);assert.equal(args.userId,user.id);assert.equal(args.hostAdmin,false);
      if(operation==='datasets.training.status')return trainingSource(id,args);
      if(operation==='storage.training.plan')return trainingPlan(id,args);
      throw Error('No unknown, write, collect, transfer or scheduler operation is allowed');
    }};
  return {user,service,calls};
}

test('training plan digest uses fixed semantic ASCII bytes across key ordering',()=>{
  const args=baseArgs(),reversed=Object.fromEntries(Object.entries(args).reverse());
  assert.equal(trainingStorageDigest(args),trainingStorageDigest(reversed));
  assert.equal(trainingStorageDigest(args),'2cc5836e21ccf86bc3860dc79b9c1bc2d44f80a32763cff5aaf21eae78ec3709');
});

test('fresh physical volume snapshot is accepted only with recomputed fit and exact owner/tuple',()=>{
  const args=baseArgs(),plan=trainingPlan(machine,args);
  assert.deepEqual(validateTrainingStoragePlan(plan,machine,args),plan);
  for(const change of [{owner:'demo-user-2'},{machine:MACHINES[1].id},{requestSHA256:'f'.repeat(64)},{noReclaim:false},{fits:false},
    {checkedAt:new Date(Date.now()-31000).toISOString()},{checkedAt:new Date(Date.now()+6000).toISOString()},{volumes:[]}]){
    assert.throws(()=>validateTrainingStoragePlan({...plan,...change},machine,args),e=>e.code==='TRAINING_STORAGE_UNKNOWN');
  }
});

test('space, active dataset reservations, inodes, cache budget and personal quotas each gate independently',()=>{
  const args={...baseArgs(),datasets:[{dataset:'data',version:release}],datasetFootprints:[{dataset:'data',version:release,bytes:1024,files:1,directories:1}]};
  for(const options of [{availableBytes:0},{availableBytes:100000,activeReservedBytes:100000},{budgetBytes:1},{quotaBytes:1}]){
    assert.throws(()=>validateTrainingStoragePlan(trainingPlan(machine,args,options),machine,args),e=>e.code==='TRAINING_STORAGE_INSUFFICIENT'&&e.status===409);
  }
  const plan=trainingPlan(machine,args);plan.volumes[0].availableInodes=0;plan.volumes[0].usableInodes=0;plan.fits=false;
  assert.throws(()=>validateTrainingStoragePlan(plan,machine,args),e=>e.code==='TRAINING_STORAGE_INSUFFICIENT');
});

test('insufficient capacity reports only verified role/required/usable counts, never private device identities',()=>{
  const args=baseArgs(),plan=trainingPlan(machine,args,{availableBytes:123});
  assert.throws(()=>validateTrainingStoragePlan(plan,machine,args),error=>{
    assert.equal(error.status,409);assert.equal(error.code,'TRAINING_STORAGE_INSUFFICIENT');
    assert.match(error.message,new RegExp(`项目卷：所需 ${plan.volumes[0].requiredBytes} 字节，可用 ${plan.volumes[0].usableBytes} 字节`));
    assert.match(error.message,/不会自动删除数据、换机或使用系统盘/);
    assert.equal(error.message.includes(plan.volumes[0].volumeDeviceId),false);
    assert.equal(error.message.includes(args.userId),false);assert.equal(error.message.includes('/'),false);
    const reply=trainingStorageErrorBody(error);
    assert.equal(reply.storage.requiredBytes,plan.volumes[0].requiredBytes);
    assert.equal(reply.storage.availableBytes,plan.volumes[0].usableBytes);
    assert.deepEqual(reply.storage.volumes[0].roles,['project']);
    assert.equal(JSON.stringify(reply).includes(plan.volumes[0].volumeDeviceId),false);
    return true;
  });
  for(const options of [{budgetBytes:1},{quotaBytes:1}]){
    const dataArgs={...args,datasets:[{dataset:'data',version:release}],datasetFootprints:[{dataset:'data',version:release,bytes:1024,files:1,directories:1}]};
    assert.throws(()=>validateTrainingStoragePlan(trainingPlan(machine,dataArgs,options),machine,dataArgs),error=>{
      assert.match(error.message,/(?:缓存预算|个人额度)：所需 \d+ 字节，可用 \d+ 字节/);
      assert.equal(trainingStorageErrorBody(error).storage.requiredBytes,null,'a budget refusal cannot be presented as physical-volume exhaustion');
      assert.equal(trainingStorageErrorBody(error).storage.availableBytes,null);return true;
    });
  }
});

test('unknown capacity exposes null counts, and malformed private error data is never serialized',()=>{
  let unknown;
  try{validateTrainingStoragePlan({},machine,baseArgs());}catch(error){unknown=error;}
  assert.deepEqual(trainingStorageErrorBody(unknown),{storage:{protocol:1,reasonCode:'TRAINING_STORAGE_UNKNOWN',requiredBytes:null,availableBytes:null,volumes:[]}});
  assert.deepEqual(trainingStorageErrorBody({trainingStorage:{...unknown.trainingStorage,path:'/private',owner:'someone'}}),{});
  assert.deepEqual(trainingStorageErrorBody({trainingStorage:{...unknown.trainingStorage,requiredBytes:0}}),{});
  assert.deepEqual(trainingStorageErrorBody({trainingStorage:{...unknown.trainingStorage,reasonCode:'TRAINING_STORAGE_INSUFFICIENT',volumes:[{roles:['system'],requiredBytes:1,availableBytes:1,requiredInodes:1,availableInodes:1}]}}),{});
  assert.deepEqual(trainingStorageErrorBody(Error('unrelated')),{});
});

test('display-only capacity, missing quotas, malformed fields and optimistic fitting assertions fail closed',()=>{
  const args=baseArgs(),plan=trainingPlan(machine,args);
  const variants=[{protocol:'dataset-storage-node-v1',usableBytes:2**40},
    {...plan,quota:{enabled:true,volumes:null}},{...plan,cacheBudget:{enabled:false,budgetBytes:0,usedOrReservedBytes:0,requiredBytes:0}}];
  for(const value of variants)assert.throws(()=>validateTrainingStoragePlan(value,machine,args),e=>e.code==='TRAINING_STORAGE_UNKNOWN');
  for(const [key,value] of [['guarded',false],['readOnly',true],['usableBytes',0],['activeReservedBytes',NaN],['availableBytes',null],['availableInodes',null]]){
    const bad=structuredClone(plan);bad.volumes[0][key]=value;
    assert.throws(()=>validateTrainingStoragePlan(bad,machine,args),e=>e.code==='TRAINING_STORAGE_UNKNOWN');
  }
  const full=trainingPlan(machine,args,{availableBytes:0});full.fits=true;
  assert.throws(()=>validateTrainingStoragePlan(full,machine,args),e=>e.code==='TRAINING_STORAGE_UNKNOWN');
});

test('same-volume roles are de-duplicated and cache/warehouse requirements cannot change interpretation',()=>{
  const args={...baseArgs(),datasets:[{dataset:'data',version:release}],datasetFootprints:[{dataset:'data',version:release,bytes:0,files:0,directories:0}]};
  const plan=trainingPlan(machine,args);assert.deepEqual(plan.volumes[0].roles,['project','cache']);
  assert.equal(validateTrainingStoragePlan(plan,machine,args).volumes.length,1);
  const duplicate=structuredClone(plan);duplicate.volumes.push(duplicate.volumes[0]);
  assert.throws(()=>validateTrainingStoragePlan(duplicate,machine,args),e=>e.code==='TRAINING_STORAGE_UNKNOWN');
  assert.throws(()=>validateTrainingStoragePlan(plan,machine,{...args,datasetReadMode:'warehouse'}),e=>e.code==='TRAINING_STORAGE_UNKNOWN');
});

test('unknown READY source image footprints are never guessed or supplied from job arguments',()=>{
  assert.equal(projectStorageFootprint(probe(),{project:'vision',release},machine).codeBytes,1);
  for(const change of [{codeBytes:undefined},{codeEntries:false},{imageUnpackedBytes:0},{releaseReady:false},{release:'f'.repeat(64)}]){
    assert.throws(()=>projectStorageFootprint({...probe(),...change},{project:'vision',release},machine),e=>e.code==='TRAINING_STORAGE_UNKNOWN');
  }
});

test('manual project/data admission uses only authenticated fresh reads; no prepare, reclaim or GPU call',async()=>{
  const f=fixture(),request={project:{project:'vision',release},datasets:[{dataset:'data',version:release}]};
  const plan=await trainingStoragePlan(f.service,f.user,machine,request);
  assert.equal(plan.fits,true);assert.deepEqual(f.calls.map(c=>c.operation),['datasets.training.status','storage.training.plan']);
  assert.equal(f.calls[1].args.projectFootprint.image,image);
  assert.equal(f.calls[1].args.projectFootprint.sourceMachine,machine);
});

test('manual insufficient/unknown target fails without reselect, writes, owner fallback or root disk',async()=>{
  for(const fault of ['full','old']){
    const f=fixture(),bridge=f.service.bridge;
    f.service.bridge=async(...args)=>args[1]==='storage.training.plan'?fault==='full'?trainingPlan(args[0],args[2],{availableBytes:0}):{}:bridge(...args);
    await assert.rejects(trainingStoragePlan(f.service,f.user,machine,{project:{},datasets:[]}),e=>e.code==='TRAINING_STORAGE_'+(fault==='full'?'INSUFFICIENT':'UNKNOWN'));
  }
});

test('warehouse local source is separately confirmed and consumes no cache role',async()=>{
  const f=fixture(),request={project:{},datasets:[{dataset:'data',version:release}],datasetReadMode:'warehouse'};
  const plan=await trainingStoragePlan(f.service,f.user,machine,request);
  assert.deepEqual(plan.volumes[0].roles,['project']);assert.equal(plan.cacheBudget.requiredBytes,0);
  assert.ok(f.calls.every(c=>c.id===machine));
});

test('capability/footprint mismatch, account revocation and maintenance during a read block admission',async()=>{
  for(const fault of ['old','wrong-machine','changed-count','revoked','maintained']){
    const f=fixture(),bridge=f.service.bridge;
    f.service.bridge=async(...args)=>{
      const value=await bridge(...args);
      if(args[1]==='datasets.training.status'){
        if(fault==='old')value.protocol='legacy';
        if(fault==='wrong-machine')value.machine=MACHINES[1].id;
        if(fault==='changed-count')value.footprintBytes++;
        if(fault==='revoked')f.user.enabled=false;
        if(fault==='maintained')f.service.maintenanceFor=()=>true;
      }
      return value;
    };
    await assert.rejects(trainingStoragePlan(f.service,f.user,machine,{project:{},datasets:[{dataset:'data',version:release}],datasetReadMode:'warehouse'}));
    assert.equal(f.calls.some(c=>c.operation==='storage.training.plan'),false);
  }
});

test('every new external admission read uses fixed safe errors and rechecks authorization on failure',async()=>{
  for(const lane of ['project','alias','source','plan'])for(const status of [400,403,503]){
    const f=fixture(),bridge=f.service.bridge;
    const error=Object.assign(Error('podman --root /private/owner/secret-overlay timeout token=secret-fixture'),{status});
    let request={project:{},datasets:[]};
    if(lane==='project'){
      request.project={project:'vision',release};f.service.projectCopyProbe=async()=>{throw error;};
    }else if(lane==='alias'){
      request.datasets=[{dataset:'data',version:release}];f.service.resolveDataset=async()=>{throw error;};
      // A failed optional alias read may continue only through independently
      // verified source data; do not force an UNKNOWN on a valid fallback.
      if(status!==403){assert.equal((await trainingStoragePlan(f.service,f.user,machine,request)).fits,true);continue;}
    }else if(lane==='source'){
      request={project:{},datasets:[{dataset:'data',version:release}],datasetReadMode:'warehouse'};
      f.service.bridge=async(...args)=>{if(args[1]==='datasets.training.status')throw error;return bridge(...args);};
    }else f.service.bridge=async()=>{throw error;};
    await assert.rejects(trainingStoragePlan(f.service,f.user,machine,request),actual=>{
      assert.equal(actual.status,status===403?403:503);
      assert.equal(actual.code,status===403?'TRAINING_STORAGE_FORBIDDEN':'TRAINING_STORAGE_UNKNOWN');
      assert.equal(actual.message.includes('/private'),false);assert.equal(actual.message.includes('secret-fixture'),false);
      if(status!==403)assert.deepEqual(trainingStorageErrorBody(actual).storage,{protocol:1,reasonCode:'TRAINING_STORAGE_UNKNOWN',requiredBytes:null,availableBytes:null,volumes:[]});
      return true;
    });
  }
  const f=fixture();f.service.projectCopyProbe=async()=>{f.user.enabled=false;throw Error('/private/transport');};
  await assert.rejects(trainingStoragePlan(f.service,f.user,machine,{project:{project:'vision',release},datasets:[]}),error=>
    error.status===403&&error.code==='TRAINING_STORAGE_FORBIDDEN'&&!error.message.includes('/private'));
});
