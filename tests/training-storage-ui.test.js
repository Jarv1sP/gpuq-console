// Backend training storage reply, 2026-10-08; preconnection only, no mock in dist.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoClient} from '../dist/client.js';
import {maintenanceBlocks} from '../dist/maintenance-state.js';
import {createDatasetReadChoice,trainingStorageMessage,trainingSelectionHTML} from '../dist/training-storage-ui.js';
const context={identity:'member:1',machine:'fixture-node-long-8',datasets:[{dataset:'sample',version:'a'.repeat(64)}]};
const capability=(ref=context.datasets[0],patch={})=>({protocol:1,machine:context.machine,...ref,warehouse:{available:true,reason:null},...patch});
const unknownOperation=(status=400,message='未知执行操作。')=>Object.assign(Error(message),{status});
const clientFixture=invoke=>{const client=new DemoClient();client.service={invoke,login:async username=>({token:username,principal:{userId:username},state:{}})};return client;};
test('unknown 400/404 capabilities are probed once even for concurrent versions and reopened forms',async()=>{
  for(const status of [400,404])for(const message of ['未知执行操作。','未知操作。','Unknown operation datasets.training.capabilities']){
    let calls=0;const client=clientFixture(async()=>{calls++;throw unknownOperation(status,message);});
    const choice=createDatasetReadChoice({call:(...args)=>client.call(...args)});
    await choice.sync({...context,datasets:[...context.datasets,{dataset:'second',version:'b'.repeat(64)}]});
    assert.equal(calls,1);assert.equal(choice.state().available,false);assert.equal(choice.state().loading,false);assert.deepEqual(choice.args(context),{});
    choice.reset();await choice.sync(context);await choice.sync({...context,machine:'another-node'});
    assert.equal(calls,1,'closing, reopening and changing machine preserve the session-level unsupported record');
    assert.throws(()=>choice.choose('warehouse'),/尚未确认/);
  }
});
test('ordinary errors and other operations never enter the unavailable-capability cache',async()=>{
  for(const failure of [unknownOperation(400,'参数无效。'),unknownOperation(404,'找不到数据集。'),unknownOperation(401),unknownOperation(403),unknownOperation(429),unknownOperation(500),unknownOperation(503),unknownOperation(504)]){
    let calls=0;const client=clientFixture(async()=>{calls++;throw failure;});
    for(let attempt=0;attempt<2;attempt++)await assert.rejects(client.call('datasets.training.capabilities',context.datasets[0]),error=>error===failure);
    assert.equal(calls,2,'errors without a 400/404 unknown-operation reply must remain retryable');
  }
  let calls=0;const client=clientFixture(async()=>{calls++;throw unknownOperation();});
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(client.call('datasets.list',{}),/未知执行操作/);
  assert.equal(calls,2,'no other operation is cached');
});
test('successful and protocol-0 replies keep querying the exact machine/version',async()=>{
  for(const protocol of [0,1]){
    const calls=[],client=clientFixture(async(_,op,args)=>{calls.push({op,args});return {result:capability(args,{protocol})};});
    for(const ref of [context.datasets[0],{dataset:'second',version:'b'.repeat(64)}])assert.equal((await client.call('datasets.training.capabilities',{machine:context.machine,...ref})).protocol,protocol);
    assert.equal(calls.length,2);assert.deepEqual(calls.map(item=>item.args.version),['a'.repeat(64),'b'.repeat(64)]);
  }
});
test('changing account or refreshing the page allows a fresh capability probe',async()=>{
  let calls=0;const invoke=async()=>{calls++;throw unknownOperation();},client=clientFixture(invoke);
  await assert.rejects(client.call('datasets.training.capabilities',{}),/未知执行操作/);
  await assert.rejects(client.call('datasets.training.capabilities',{}),/未知执行操作/);assert.equal(calls,1);
  await client.login('another-account','fixture');await assert.rejects(client.call('datasets.training.capabilities',{}),/未知执行操作/);assert.equal(calls,2);
  const refreshed=clientFixture(invoke);await assert.rejects(refreshed.call('datasets.training.capabilities',{}),/未知执行操作/);assert.equal(calls,3);
});
test('an old unknown reply and queued versions cannot disable a new account or leak an old request',async()=>{
  let rejectOld;const calls=[],client=clientFixture(async(token,op,args)=>{
    calls.push({token,op,args});if(calls.length===1)return new Promise((_,reject)=>{rejectOld=reject;});return {result:capability()};
  });
  client.token='old-account';
  const old=assert.rejects(client.call('datasets.training.capabilities',{dataset:'first'}),error=>error.code==='STALE_SESSION');
  const queued=assert.rejects(client.call('datasets.training.capabilities',{dataset:'queued'}),error=>error.code==='STALE_SESSION');
  await new Promise(resolve=>setImmediate(resolve));const login=client.login('new-account','fixture');rejectOld(unknownOperation());
  await Promise.all([old,queued,login]);assert.equal(calls.length,1);
  assert.equal((await client.call('datasets.training.capabilities',{dataset:'new'})).protocol,1);
  assert.equal(calls.length,2);assert.equal(calls[1].token,'new-account');assert.equal(calls.some(item=>item.args.dataset==='queued'),false);
});
test('a cancelled queued capability read never reaches the transport',async()=>{
  let release;const calls=[],client=clientFixture(async(_,op,args)=>{calls.push(args);if(calls.length===1)return new Promise(resolve=>{release=resolve;});return {result:capability()};});
  const first=client.call('datasets.training.capabilities',{dataset:'first'}),controller=new AbortController();
  const queued=assert.rejects(client.call('datasets.training.capabilities',{dataset:'cancelled'},{signal:controller.signal}),error=>error.name==='AbortError');
  await new Promise(resolve=>setImmediate(resolve));controller.abort();release({result:capability()});await first;await queued;
  assert.deepEqual(calls,[{dataset:'first'}]);assert.equal(client.inflight.size,0);
});
test('warehouse reads require exact protocol, machine and every fixed dataset; cache keeps legacy keys',async()=>{
  for(const patch of [{},{protocol:0},{protocol:2},{protocol:'1'},{machine:'another-node'},{dataset:'another-set'},{version:'b'.repeat(64)},{warehouse:{available:'true'}},{warehouse:{available:false,reason:'节点未就绪'}}]){
    const calls=[],choice=createDatasetReadChoice({call:async(op,args)=>{calls.push({op,args});return capability(undefined,patch);}});
    await choice.sync(context);assert.deepEqual(calls,[{op:'datasets.training.capabilities',args:{machine:context.machine,...context.datasets[0]}}]);
    assert.deepEqual(choice.args(context),{});const available=!Object.keys(patch).length;assert.equal(choice.state().available,available);
    if(available){choice.choose('warehouse');assert.deepEqual(choice.args(context),{datasetReadMode:'warehouse'});choice.choose('cache');assert.deepEqual(choice.args(context),{});}
    else assert.throws(()=>choice.choose('warehouse'),/尚未确认/);
  }
  const refs=[...context.datasets,{dataset:'second',version:'b'.repeat(64)}];
  const choice=createDatasetReadChoice({call:async(_,ref)=>capability(ref,{warehouse:{available:ref.dataset==='sample',reason:ref.dataset==='second'?'未 READY':null}})});
  await choice.sync({...context,datasets:refs});assert.equal(choice.state().available,false);assert.equal(choice.state().reason,'未 READY');
});
test('old, denied, absent, AUTO and zero-authorization contexts never enable direct reads',async()=>{
  for(const value of [null,{},undefined]){const choice=createDatasetReadChoice({call:async()=>value});await choice.sync(context);assert.equal(choice.state().available,false);}
  const denied=createDatasetReadChoice({call:async()=>{throw Object.assign(Error('无权查看'),{status:403});}});await denied.sync(context);assert.equal(denied.state().available,false);
  let calls=0;const absent=createDatasetReadChoice({call:async()=>{calls++;return capability();}});
  for(const ctx of [null,{...context,identity:''},{...context,machine:''},{...context,machine:'auto'},{...context,datasets:[]}])await absent.sync(ctx);
  assert.equal(calls,0);assert.deepEqual(absent.args(null),{});
});
test('late capabilities cannot cross account, machine, version, or a closed form',async()=>{
  for(const next of [{...context,identity:'other-account:2'},{...context,machine:'other-node'},{...context,datasets:[{dataset:'sample',version:'b'.repeat(64)}]},null]){
    let release,signal;const choice=createDatasetReadChoice({call:async(_,args,options)=>{signal??=options.signal;if(args.machine===context.machine&&args.version===context.datasets[0].version&&!release)return new Promise(resolve=>{release=resolve;});return {...args,protocol:0};}});
    const old=choice.sync(context);await Promise.resolve();await choice.sync(next);assert.equal(signal.aborted,true);
    release(capability());await old;assert.equal(choice.state().available,false);assert.deepEqual(choice.args(next),{});
  }
});
test('a selected warehouse mode never silently falls back under a mismatched submission',async()=>{
  const choice=createDatasetReadChoice({call:async()=>capability()});await choice.sync(context);choice.choose('warehouse');
  for(const next of [{...context,identity:'other-account'},{...context,machine:'other-node'},{...context,datasets:[]}])assert.throws(()=>choice.args(next),/重新核对/);
});
test('capacity numbers are shown only for confirmed single-volume byte shortages',()=>{
  const error={status:409,code:'SUBMISSION_REJECTED',message:'原错误 <img src=x>',storage:{protocol:1,reasonCode:'TRAINING_STORAGE_INSUFFICIENT',requiredBytes:4*1024**3,availableBytes:1024**3}};
  assert.equal(trainingStorageMessage(error),'空间不足 · 需要 4 GiB · 可用 1 GiB');assert.equal(trainingStorageMessage({...error,status:503}),'空间不足 · 需要 4 GiB · 可用 1 GiB');
  for(const patch of [{protocol:0},{reasonCode:'TRAINING_STORAGE_UNKNOWN'},{requiredBytes:null},{availableBytes:null},{requiredBytes:'4096'},{availableBytes:NaN},{availableBytes:Infinity},{requiredBytes:-1}])assert.equal(trainingStorageMessage({...error,storage:{...error.storage,...patch}}),error.message);
  for(const patch of [{status:502},{status:200},{code:'OTHER'}])assert.equal(trainingStorageMessage({...error,...patch}),error.message);
});
test('transport retains storage only for the explicit protocol-1 rejection envelope',async()=>{
  const original=globalThis.fetch,storage={protocol:1,reasonCode:'TRAINING_STORAGE_INSUFFICIENT',requiredBytes:1024,availableBytes:0};
  try{
    for(const [status,code,protocol,allowed] of [[409,'SUBMISSION_REJECTED',1,true],[503,'SUBMISSION_REJECTED',1,true],[502,'SUBMISSION_REJECTED',1,false],[409,'OTHER',1,false],[503,'SUBMISSION_REJECTED',0,false]]){
      const value={...storage,protocol};globalThis.fetch=async()=>new Response(JSON.stringify({error:'原错误',code,storage:value}),{status});
      const client=new DemoClient();client.remote=true;
      await assert.rejects(client.call('jobs.submit',{key:'unchanged'}),error=>{assert.equal(error.message,'原错误');assert.deepEqual(error.storage,allowed?value:undefined);return true;});
    }
  }finally{globalThis.fetch=original;}
});
test('maintenance permits only the storage capability read, never a warehouse submission',()=>{
  const data={operationalMaintenance:{version:1,global:{reason:'维修'},machines:{}}};
  for(const role of ['member','admin']){
    assert.equal(maintenanceBlocks('datasets.training.capabilities',{machine:context.machine},data,{role}),null);
    assert.ok(maintenanceBlocks('jobs.submit',{machine:context.machine,datasetReadMode:'warehouse'},data,{role}));
  }
});
test('AUTO summary requires the confirmed selected machine, escapes IDs and explains only defined reasons and exclusions',()=>{
  const job={machine:'fixture-node-8',selectionSummary:{protocol:1,selectedMachine:'fixture-node-8',reason:'storage-fit-and-resource-rank',storageVerified:true,storageExcluded:[{machine:'fixture-node-6',reason:'storage-insufficient'},{machine:'<img src=x>',reason:'storage-unverified'},{machine:'ignored',reason:'unknown'}]}};
  const html=trainingSelectionHTML(job);assert.match(html,/已分配到/);assert.match(html,/aria-label="自动选择原因"/);assert.match(html,/按存储容量、显卡和排队情况选择/);assert.match(html,/fixture-node-6 空间不足/);assert.match(html,/&lt;img src=x&gt; 空间未核实/);assert.doesNotMatch(html,/<img|ignored|已预留/);
  for(const patch of [null,{}, {...job.selectionSummary,protocol:0},{...job.selectionSummary,selectedMachine:'other'}])assert.equal(trainingSelectionHTML({...job,selectionSummary:patch}),'');
});
