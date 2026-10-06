import test from 'node:test';
import assert from 'node:assert/strict';
import {canFullDelete,createDatasetFullDeletion,fullDeleteActions,fullDeleteStorageKey,fullDeleteCopyRoles,fullDeleteStepLabel} from '../dist/dataset-full-delete-state.js';
import {DemoClient} from '../dist/client.js';
import {maintenanceBlocks} from '../dist/maintenance-state.js';

const version='a'.repeat(64),key='10000000-0000-4000-8000-000000000001',operationId='20000000-0000-4000-8000-000000000001';
const stepId='30000000-0000-4000-8000-000000000001',target={dataset:'scans',version},admin={userId:'alice',role:'admin'},member={userId:'alice',role:'member'};
const catalog=(allowed=true,capability=1)=>({datasetDelete:capability,datasets:[{dataset:target.dataset,versions:[{version,locations:[{machine:'node-long-id-8',deletionPermissions:{memberAllowed:allowed}}]}]}]});
const task=(args,overrides={})=>({...args,operationId,state:'PLANNED',steps:[{machine:'node-long-id-8',dataset:'physical-scans',operationId:stepId,phase:'plan',state:'PLANNED',complete:true}],events:[],...overrides});
function fixture({who=admin,value=catalog(),storageValue,handler,management=true}={}){
  let principal=who,inventory=value,clock=0,session=0;const memory=storageValue||new Map(),calls=[],timers=new Map();let serial=0;
  const storage={getItem:id=>memory.get(id),setItem:(id,value)=>memory.set(id,value)};
  const options={management,principal:()=>principal,catalog:()=>inventory,session:()=>session,call:async(operation,args)=>{calls.push({operation,args:structuredClone(args),account:principal?.userId});return handler?handler(operation,args):task(args);},storage,now:()=>clock,makeKey:()=>key,setTimer:(callback,delay)=>{timers.set(++serial,{callback,delay});return serial;},clearTimer:id=>timers.delete(id)};
  const model=createDatasetFullDeletion(options);model.sync();
  return {model,options,calls,memory,timers,setPrincipal:value=>{principal=value;session++;model.sync();},setCatalog:value=>{inventory=value;},setTime:value=>{clock=value;}};
}

test('entry gates use strict capability and current version deletionPermissions; no ownership-label guesses',()=>{
  assert.equal(canFullDelete(member,catalog(),target.dataset,version),true);
  for(const cap of [0,undefined,null,true,'1'])assert.equal(canFullDelete(admin,{...catalog(),datasetDelete:cap},target.dataset,version),false);
  assert.equal(canFullDelete(admin,catalog(false),target.dataset,version),true);
  assert.equal(canFullDelete(member,catalog(false),target.dataset,version),false);
  const unknown=catalog();delete unknown.datasets[0].versions[0].locations[0].deletionPermissions;
  unknown.datasets[0].ownerLabel='所属用户：alice';unknown.datasets[0].owners=['alice'];
  assert.equal(canFullDelete(member,unknown,target.dataset,version),false);
  const mixed=catalog(false);mixed.datasets[0].versions[0].locations.push({deletionPermissions:{memberAllowed:true}});
  assert.equal(canFullDelete(member,mixed,target.dataset,version),true);
  assert.equal(canFullDelete(member,mixed,target.dataset,'b'.repeat(64)),false);
  assert.equal(canFullDelete(null,mixed,target.dataset,version),false);
});
test('fixed UUID and frozen target are persisted before one deletion dispatch; DELETED needs matching authoritative receipt',async()=>{
  let f;f=fixture({handler:async(operation,args)=>{
    assert.equal(operation,'datasets.delete');assert.deepEqual(args,{...target,key});
    const saved=JSON.parse(f.memory.get(fullDeleteStorageKey(admin.userId)));assert.equal(saved[0].key,key);assert.equal(saved[0].state,'SUBMITTING');
    return task(args,{state:'DELETED',retainUntil:'2026-10-13T10:00:00Z'});
  }});
  const result=await f.model.submit(target.dataset,version);
  assert.equal(result.state,'DELETED');assert.equal(result.confirmed,true);assert.equal(result.task.retainUntil,'2026-10-13T10:00:00Z');
  await f.model.submit(target.dataset,version);assert.equal(f.calls.length,1,'Reopening a target never creates another deletion/key');
});
test('failure to persist blocks dispatch, rather than losing an idempotency key',async()=>{
  const f=fixture(),model=createDatasetFullDeletion({...f.options,storage:{getItem:()=>null,setItem:()=>{throw Error('storage blocked');}}});
  await assert.rejects(model.submit(target.dataset,version),/无法保存删除请求编号/);assert.equal(f.calls.length,0);assert.equal(model.rows.length,0);
});
test('403 preserves backend refusal and 409 unsupported is blocked, not advertised as deleted',async()=>{
  for(const [status,code,message] of [[403,undefined,'这份数据只能由管理员删除。'],[409,'DATASET_DELETE_UNSUPPORTED','服务器的删除能力未确认，请等待节点更新或恢复连接。'],[409,undefined,'服务器的删除能力未确认，请等待节点更新或恢复连接。']]){
    const f=fixture({who:member,handler:async()=>{throw Object.assign(Error(message),{status,code});}});
    const row=await f.model.submit(target.dataset,version);assert.equal(row.state,'BLOCKED');assert.equal(row.error,message);assert.equal(row.confirmed,false);assert.equal(row.operationId,null);assert.equal(f.calls.length,1);
  }
});
test('lost initial receipt queries the original key once; never replays delete even on authoritative 404',async()=>{
  for(const status of [404,403,503]){
    const f=fixture({handler:async operation=>{throw Object.assign(Error(operation==='datasets.delete'?'reply lost':'删除记录不存在或无权查看。'),{status:operation==='datasets.delete'?503:status});}});
    const row=await f.model.submit(target.dataset,version);assert.equal(row.state,'UNKNOWN');
    assert.deepEqual(f.calls.map(call=>[call.operation,call.args]),[['datasets.delete',{...target,key}],['datasets.delete.status',{key}]]);
    await f.model.query(key);await f.model.submit(target.dataset,version);
    assert.equal(f.calls.filter(call=>call.operation==='datasets.delete').length,1);assert.equal(f.model.rows[0].key,key);
    assert.deepEqual(f.model.rows[0].error,'删除记录不存在或无权查看。');
  }
});
test('lost receipt can recover DELETED by key with the frozen target and server operation ID',async()=>{
  const f=fixture({handler:async(operation,args)=>{if(operation==='datasets.delete')throw Error('socket closed');return task({...target,key:args.key},{state:'DELETED'});}});
  const row=await f.model.submit(target.dataset,version);assert.equal(row.state,'DELETED');assert.equal(row.operationId,operationId);assert.equal(f.calls.length,2);
});
test('incomplete, mismatched or unsupported task receipts never prove success',async()=>{
  for(const overrides of [{key:'40000000-0000-4000-8000-000000000001'},{dataset:'other-data'},{version:'b'.repeat(64)},{operationId:'not-an-id'},{state:'READY'},{steps:null},{events:null},{steps:[{machine:'node',dataset:'physical',phase:'plan',state:'PLANNED'}]}]){
    const f=fixture({handler:async()=>task({...target,key},{state:'DELETED',...overrides})});
    const row=await f.model.submit(target.dataset,version);assert.equal(row.state,'UNKNOWN');assert.equal(row.confirmed,false);assert.equal(f.calls.filter(call=>call.operation==='datasets.delete').length,1);
  }
});
test('refresh turns even persisted completion into unknown and resumes by original key only',async()=>{
  const f=fixture({handler:async(operation,args)=>task({...target,key:args.key},{state:'DELETED'})});await f.model.submit(target.dataset,version);
  const model=createDatasetFullDeletion(f.options);model.sync(true);assert.equal(model.rows[0].state,'UNKNOWN');assert.equal(model.rows[0].confirmed,false);assert.equal(f.timers.size,0);
  await model.query(key);assert.equal(model.rows[0].state,'DELETED');assert.deepEqual(f.calls.at(-1).args,{key});
  const stored=JSON.parse(f.memory.get(fullDeleteStorageKey(admin.userId)));stored[0].state='SUBMITTING';f.memory.set(fullDeleteStorageKey(admin.userId),JSON.stringify(stored));
  const unfinished=createDatasetFullDeletion(f.options);unfinished.sync();assert.equal(unfinished.rows[0].state,'UNKNOWN');assert.equal(unfinished.rows[0].key,key);
});
test('account switches and late replies cannot publish another account record or replay authentication',async()=>{
  let finish;const f=fixture({handler:()=>new Promise(resolve=>{finish=resolve;})});const pending=f.model.submit(target.dataset,version);
  f.setPrincipal({userId:'bob',role:'admin'});finish(task({...target,key},{state:'DELETED'}));await pending;
  assert.deepEqual(f.model.rows,[]);assert.equal(f.memory.has(fullDeleteStorageKey('bob')),false);
  f.setPrincipal(admin);assert.equal(f.model.rows[0].state,'UNKNOWN');assert.equal(f.model.rows[0].key,key);
  assert.equal(f.calls.length,1);
});
test('status 404 and foreign operation IDs remain UNKNOWN; original known ID is never replaced',async()=>{
  let mode='normal';const f=fixture({handler:async(operation,args)=>{
    if(operation==='datasets.delete')return task(args);
    if(mode==='foreign')return task({...target,key},{state:'DELETED',operationId:'50000000-0000-4000-8000-000000000001'});
    throw Object.assign(Error('删除记录不存在或无权查看。'),{status:404});
  }});
  await f.model.submit(target.dataset,version);mode='foreign';await f.model.query(key);assert.equal(f.model.rows[0].state,'UNKNOWN');assert.equal(f.model.rows[0].operationId,operationId);
  mode='404';await f.model.query(key);assert.equal(f.model.rows[0].state,'UNKNOWN');assert.equal(f.model.rows[0].error,'删除记录不存在或无权查看。');
});
test('members cannot continue, cancel or restore; UNKNOWN has no write actions even for administrators',async()=>{
  for(const state of ['DELETED','WAITING_CONTINUE','FAILED','BLOCKED','UNKNOWN']){
    const row={state,confirmed:true,operationId,task:task({...target,key},{state,canContinue:true,steps:[{machine:'node-long-id-8',dataset:'physical-scans',operationId:stepId,phase:'commit',state:'ISOLATED',complete:true,retainUntil:'2026-10-13T10:00:00Z'}]})};
    assert.deepEqual(fullDeleteActions(row,member),[]);if(state==='UNKNOWN')assert.deepEqual(fullDeleteActions(row,admin),[]);
  }
  const f=fixture({who:member,handler:async(operation,args)=>task(args,{state:'WAITING_CONTINUE',canContinue:true})});await f.model.submit(target.dataset,version);
  for(const action of ['continue','cancel','restore'])await assert.rejects(f.model.act(key,action,'node-long-id-8'),/需要管理员处理/);
  assert.equal(f.calls.length,1);
});
test('WAITING_CONTINUE uses actual canContinue; confirmed admin actions bind the same operation ID',async()=>{
  for(const canContinue of [false,undefined,'true'])assert(!fullDeleteActions({confirmed:true,operationId,state:'WAITING_CONTINUE',task:{canContinue}},admin).includes('continue'));
  const f=fixture({handler:async(operation,args)=>task({...target,key},{state:operation==='datasets.delete'?'WAITING_CONTINUE':'RUNNING',canContinue:true})});
  await f.model.submit(target.dataset,version);await f.model.act(key,'continue');assert.deepEqual(f.calls.at(-1),{operation:'datasets.delete.continue',args:{operationId},account:admin.userId});
  await f.model.act(key,'cancel');assert.deepEqual(f.calls.at(-1).args,{operationId});assert.equal(f.calls.at(-1).operation,'datasets.delete.cancel');
});
test('restore binds the unique complete physical source and verifies its different receipt shape before querying',async()=>{
  const source={machine:'node-long-id-8',dataset:'physical-scans',operationId:stepId,phase:'commit',state:'ISOLATED',complete:true,retainUntil:'2026-10-13T10:00:00Z'};
  const f=fixture({handler:async(operation,args)=>{
    if(operation==='datasets.delete.restore')return {operationId,machine:args.machine,dataset:source.dataset,version,state:'RESTORED'};
    return task({...target,key},{state:operation==='datasets.delete'?'DELETED':'BLOCKED',steps:[{...source,...(operation==='datasets.delete.status'?{restoreState:'RESTORED'}:{})}]});
  }});
  await f.model.submit(target.dataset,version);await assert.rejects(f.model.act(key,'restore','not-the-source'),/完整保留副本/);
  const row=await f.model.act(key,'restore',source.machine);assert.equal(row.state,'BLOCKED');assert.equal(row.lastAction.state,'RESTORED');
  assert.deepEqual(f.calls.slice(-2).map(call=>[call.operation,call.args]),[['datasets.delete.restore',{operationId,machine:source.machine}],['datasets.delete.status',{key}]]);
  assert(!fullDeleteActions(row,admin).includes('continue'),'Restored original task cannot restart deletion');
});
test('active polling reads only; closing stops polling, UNKNOWN never starts a timer',async()=>{
  const f=fixture();f.model.sync(true);await f.model.submit(target.dataset,version);assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,2000);
  f.model.sync(false);assert.equal(f.timers.size,0);assert.equal(f.calls.length,1);
});
test('browser HTTP client preserves the exact unsupported code and refusal text',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>({ok:false,status:409,json:async()=>({code:'DATASET_DELETE_UNSUPPORTED',error:'服务器的删除能力未确认，请等待节点更新或恢复连接。'})});
  try{await assert.rejects(new DemoClient().transport('call',{}),error=>error.status===409&&error.code==='DATASET_DELETE_UNSUPPORTED'&&error.message==='服务器的删除能力未确认，请等待节点更新或恢复连接。');}
  finally{globalThis.fetch=previous;}
});
test('maintenance permits deletion status and cancellation, while delete/continue/restore remain blocked',()=>{
  const state={operationalMaintenance:{version:1,global:{reason:'检查',since:'2026-10-06T10:00:00Z'},machines:{}}};
  for(const operation of ['datasets.delete.status','datasets.delete.cancel'])assert.equal(maintenanceBlocks(operation,{key,operationId},state,admin),null);
  for(const operation of ['datasets.delete','datasets.delete.continue','datasets.delete.restore'])assert.equal(maintenanceBlocks(operation,{key,operationId},state,admin).reason,'检查');
});

test('primary interface treats administrators like members; management alone exposes privileged actions',async()=>{
  assert.equal(canFullDelete(admin,catalog(false),target.dataset,version,false),false);
  assert.equal(canFullDelete(admin,catalog(true),target.dataset,version,false),true);
  const f=fixture({management:false,handler:async(operation,args)=>task(args,{state:'WAITING_CONTINUE',canContinue:true})});
  await f.model.submit(target.dataset,version);assert.deepEqual(fullDeleteActions(f.model.rows[0],admin,false),[]);
  for(const action of ['continue','cancel','restore'])await assert.rejects(f.model.act(key,action,'node-long-id-8'),/需要管理员处理/);
  assert.equal(f.calls.length,1);
});
test('role labels require an actual original proof; complete cache is not an original, unknown remains factual',()=>{
  const value=catalog();value.datasets[0].versions[0].locations=[
    {machine:'cache',state:'READY',storage:{phase:'ARCHIVED',originalRetained:true,archiveMachine:'original'}},
    {machine:'original',state:'READY'},
    {machine:'unknown',state:'UNKNOWN'}
  ];
  const roles=fullDeleteCopyRoles(value,target.dataset,version);
  assert.equal(fullDeleteStepLabel({machine:'original',complete:true},roles),'隔离原件（可恢复）');
  assert.equal(fullDeleteStepLabel({machine:'cache',complete:true},roles),'移除缓存');
  assert.equal(fullDeleteStepLabel({machine:'unknown',complete:true},roles),'隔离完整副本（可恢复）');
  assert.equal(fullDeleteStepLabel({machine:'unknown',complete:false},roles),'检查并移除');
  for(const invalid of [{phase:'ARCHIVED',originalRetained:false,archiveMachine:'original'},{phase:'ARCHIVING',originalRetained:true,archiveMachine:'original'},{phase:'ARCHIVED',originalRetained:'true',archiveMachine:'original'}]){
    value.datasets[0].versions[0].locations[0].storage=invalid;
    assert.deepEqual(fullDeleteCopyRoles(value,target.dataset,version).originals,[]);
  }
});
test('primary/management journals preserve independent original keys across both controllers',async()=>{
  const f=fixture(),otherKey='60000000-0000-4000-8000-000000000001';
  const value=catalog();value.datasets.push({dataset:'other-data',versions:value.datasets[0].versions});
  f.setCatalog(value);const second=createDatasetFullDeletion({...f.options,makeKey:()=>otherKey});second.sync();
  await f.model.submit(target.dataset,version);await second.submit('other-data',version);
  assert.deepEqual(JSON.parse(f.memory.get(fullDeleteStorageKey(admin.userId))).map(row=>row.key).sort(),[key,otherKey]);
  f.model.sync();assert.equal(f.model.rows.length,2);await f.model.query(key);
  assert.equal(JSON.parse(f.memory.get(fullDeleteStorageKey(admin.userId))).length,2);
});
