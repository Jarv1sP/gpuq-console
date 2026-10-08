// Backend training storage reply, 2026-10-08; preconnection only, no mock in dist.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoClient} from '../dist/client.js';
import {maintenanceBlocks} from '../dist/maintenance-state.js';
import {createDatasetReadChoice,trainingStorageMessage,trainingSelectionHTML} from '../dist/training-storage-ui.js';
const context={identity:'member:1',machine:'fixture-node-long-8',datasets:[{dataset:'sample',version:'a'.repeat(64)}]};
const capability=(ref=context.datasets[0],patch={})=>({protocol:1,machine:context.machine,...ref,warehouse:{available:true,reason:null},...patch});
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
test('AUTO summary requires the confirmed selected machine, escapes IDs and explains only defined exclusions',()=>{
  const job={machine:'fixture-node-8',selectionSummary:{protocol:1,selectedMachine:'fixture-node-8',storageExcluded:[{machine:'fixture-node-6',reason:'storage-insufficient'},{machine:'<img src=x>',reason:'storage-unverified'},{machine:'ignored',reason:'unknown'}]}};
  const html=trainingSelectionHTML(job);assert.match(html,/自动选择/);assert.match(html,/fixture-node-6 空间不足/);assert.match(html,/&lt;img src=x&gt; 空间未核实/);assert.doesNotMatch(html,/<img|ignored/);
  for(const patch of [null,{}, {...job.selectionSummary,protocol:0},{...job.selectionSummary,selectedMachine:'other'}])assert.equal(trainingSelectionHTML({...job,selectionSummary:patch}),'');
});
