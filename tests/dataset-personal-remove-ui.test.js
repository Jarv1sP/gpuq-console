import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatasetRemovals,personalRemovalStorageKey,removalStorageKey} from '../dist/dataset-remove-ui.js';
import {MACHINES} from '../dist/machines.js';

const version='a'.repeat(64),operationId='b'.repeat(64),target={machine:MACHINES[0].id,dataset:'personal-physical',version,catalogDataset:'personal-display'};
function fixture(){
 let who={userId:'personal-member',role:'member'},generation=0,allowed=true,result={operationId,dataset:target.dataset,version,state:'UNREGISTERING'};
 const values=new Map(),calls=[],timers=new Map(),completed=[],storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 const options={principal:()=>who,session:()=>generation,machines:()=>MACHINES,personal:true,canRemove:()=>allowed,storage,
  call:async(operation,args)=>{calls.push({operation,args});if(result instanceof Error)throw result;return result;},completed:row=>completed.push(row),
  setTimer:callback=>{const id=timers.size+1;timers.set(id,callback);return id;},clearTimer:id=>timers.delete(id)};
 const api=createDatasetRemovals(options);api.sync(true);
 return {api,options,values,calls,timers,completed,who:value=>who=value,generation:value=>generation=value,allow:value=>allowed=value,respond:value=>result=value};
}
test('personal v1 freezes a complete physical target and persists separately before any dispatch',async()=>{
 const f=fixture();let recorded;f.options.call=async(operation,args)=>{recorded=JSON.parse(f.values.get(personalRemovalStorageKey('personal-member')));f.calls.push({operation,args});return {operationId,dataset:target.dataset,version,state:'UNREGISTERING'};};
 const api=createDatasetRemovals(f.options);api.sync(true);const row=await api.submit(target);
 assert.equal(recorded[0].state,'SUBMITTING');assert.equal(recorded[0].dataset,target.dataset);assert.equal(recorded[0].catalogDataset,target.catalogDataset);
 assert.equal(f.values.has(removalStorageKey('personal-member')),false);assert.deepEqual(f.calls,[{operation:'datasets.unregister',args:{machine:target.machine,dataset:target.dataset,version}}]);assert.equal(row.operationId,operationId);api.stop();f.api.stop();
});
test('personal permission refusal, whole-dataset target and storage denial all cause zero dispatch',async()=>{
 for(const mode of ['permission','whole','storage']){
  const f=fixture();if(mode==='permission')f.allow(false);if(mode==='storage')f.options.storage={getItem:()=>null,setItem:()=>{throw Error('denied');}};
  const api=createDatasetRemovals(f.options);api.sync(true);await assert.rejects(api.submit(mode==='whole'?{...target,version:null}:target));assert.equal(f.calls.length,0);assert.equal(api.rows.length,0);api.stop();f.api.stop();
 }
});
test('lost receipt remains locked after reload and only a supplied original node ID is queried',async()=>{
 const f=fixture();f.respond(Error('receipt lost'));const row=await f.api.submit(target);f.api.stop();const recovered=createDatasetRemovals(f.options);recovered.sync(true);
 assert.equal(recovered.rows[0].state,'UNKNOWN');assert.equal(f.timers.size,0);await assert.rejects(recovered.submit(target),/尚未确认/);await assert.rejects(recovered.query(row.id),/找到原编号/);assert.equal(f.calls.length,1);
 f.respond({operationId,dataset:target.dataset,version,state:'UNREGISTERED',unregistered:true});await recovered.query(row.id,operationId);
 assert.deepEqual(f.calls.at(-1),{operation:'datasets.status',args:{machine:target.machine,operationId}});assert.equal(recovered.rows[0].state,'UNREGISTERED');assert.equal(f.completed.length,1);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);recovered.stop();
});
test('known receipt reload requires a fresh query, malformed targets never confirm success',async()=>{
 const f=fixture(),row=await f.api.submit(target);f.api.stop();const recovered=createDatasetRemovals(f.options);recovered.sync(true);assert.equal(recovered.rows[0].state,'UNKNOWN');assert.equal(f.timers.size,0);
 for(const result of [{operationId,state:'UNREGISTERED',unregistered:true},{operationId,dataset:'other',version,state:'UNREGISTERED',unregistered:true},{operationId,dataset:target.dataset,version:'c'.repeat(64),state:'UNREGISTERED',unregistered:true}]){f.respond(result);await recovered.query(row.id);assert.equal(recovered.rows[0].state,'UNKNOWN');assert.equal(f.completed.length,0);}
 f.respond({operationId,dataset:target.dataset,version,state:'UNREGISTERED',unregistered:false});await recovered.query(row.id);assert.equal(recovered.rows[0].state,'UNREGISTERED');assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);recovered.stop();
});
test('account, role and login generation retire replies without replay or foreign UI records',async()=>{
 for(const mode of ['account','role','login']){
  const f=fixture();let release;f.options.call=()=>new Promise(resolve=>release=resolve);const api=createDatasetRemovals(f.options);api.sync(true);const request=api.submit(target);
  if(mode==='account')f.who({userId:'another-member',role:'member'});if(mode==='role')f.who({userId:'personal-member',role:'admin'});if(mode==='login')f.generation(1);
  api.sync(false);release({operationId,dataset:target.dataset,version,state:'UNREGISTERED',unregistered:true});await request;
  assert.equal(f.completed.length,0);assert.equal(f.timers.size,0);if(mode==='account')assert.deepEqual(api.rows,[]);else assert.equal(api.rows[0].state,'UNKNOWN');api.stop();f.api.stop();
 }
});
test('the personal journal does not overwrite another tab unresolved reference',async()=>{
 const f=fixture();const foreign={...target,id:'another-tab',dataset:'other-personal',state:'UNKNOWN',operationId:null};f.values.set(personalRemovalStorageKey('personal-member'),JSON.stringify([foreign]));
 await f.api.submit(target);const rows=JSON.parse(f.values.get(personalRemovalStorageKey('personal-member')));assert.equal(rows.filter(row=>row.id==='another-tab').length,1);assert.equal(rows.length,2);f.api.stop();
});
test('two already-open personal controllers cannot redispatch a lost receipt for the same physical target',async()=>{
 const f=fixture(),second=createDatasetRemovals(f.options);second.sync(true);f.respond(Error('receipt lost'));
 const row=await f.api.submit(target);assert.equal(row.state,'UNKNOWN');
 await assert.rejects(second.submit(target),/尚未确认/);
 assert.equal(second.rows.find(item=>item.id===row.id).state,'UNKNOWN');assert.equal(second.blocked(target),true);
 assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);assert.equal(f.timers.size,0);
 assert.equal(JSON.parse(f.values.get(personalRemovalStorageKey('personal-member'))).length,1);
 second.stop();f.api.stop();
});
test('a second personal controller also blocks a first request while its receipt is still pending',async()=>{
 const f=fixture();let release;f.options.call=async(operation,args)=>{f.calls.push({operation,args});return new Promise(resolve=>release=resolve);};
 const first=createDatasetRemovals(f.options),second=createDatasetRemovals(f.options);first.sync(true);second.sync(true);
 const pending=first.submit(target);assert.equal(first.rows[0].state,'SUBMITTING');await assert.rejects(second.submit(target),/尚未确认/);assert.equal(f.calls.length,1);
 release({operationId,dataset:target.dataset,version,state:'UNREGISTERED',unregistered:true});await pending;assert.equal(first.rows[0].state,'UNREGISTERED');
 first.stop();second.stop();f.api.stop();
});
test('another controller may delete a distinct target without overwriting a later original receipt',async()=>{
 for(const different of [{dataset:'other-personal'},{version:'c'.repeat(64)},{machine:MACHINES[1].id}]){
  const f=fixture(),second=createDatasetRemovals(f.options);second.sync(true);f.respond(Error('receipt lost'));
  const first=await f.api.submit(target),other={...target,...different},otherOperationId='d'.repeat(64);
  f.respond({operationId:otherOperationId,dataset:other.dataset,version:other.version,state:'FAILED'});
  const next=await second.submit(other);assert.equal(next.state,'FAILED');assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,2);
  f.respond({operationId,dataset:target.dataset,version,state:'UNREGISTERED',unregistered:true});await f.api.query(first.id,operationId);
  f.respond({operationId:otherOperationId,dataset:other.dataset,version:other.version,state:'FAILED'});await second.query(next.id);
  const saved=JSON.parse(f.values.get(personalRemovalStorageKey('personal-member'))),original=saved.find(item=>item.id===first.id);
  assert.equal(original.state,'UNREGISTERED');assert.equal(original.operationId,operationId);assert.equal(original.unregistered,true);
  assert.equal(saved.find(item=>item.id===next.id).operationId,otherOperationId);assert.equal(saved.length,2);
  assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,2);second.stop();f.api.stop();
 }
});
test('personal abandon and dismiss remove only their journal row and it stays removed after another controller writes or reloads',async()=>{
 for(const action of ['abandon','dismiss']){
  const f=fixture(),second=createDatasetRemovals(f.options);second.sync(true);
  const error=Error(action==='abandon'?'receipt lost':'last copy refused');if(action==='dismiss'){error.status=409;error.code='LAST_COPY_UNPROVEN';}f.respond(error);
  const first=await f.api.submit(target),other={...target,dataset:'other-personal'},otherOperationId='d'.repeat(64);
  f.respond({operationId:otherOperationId,dataset:other.dataset,version,state:'UNREGISTERED',unregistered:true});const next=await second.submit(other);
  const key=personalRemovalStorageKey('personal-member'),originalOther=JSON.parse(f.values.get(key)).find(row=>row.id===next.id),dispatches=f.calls.length;
  f.api[action](first.id);f.api.sync(true);assert.equal(f.api.rows.some(row=>row.id===first.id),false);assert.equal(f.calls.length,dispatches,'local record dismissal never calls the server');
  assert.deepEqual(JSON.parse(f.values.get(key)),[originalOther],'the other tab authoritative receipt is not rewritten as UNKNOWN');
  assert.equal(second.rows.some(row=>row.id===first.id),true,'the second controller still has an older snapshot');await second.query(next.id);
  const recovered=createDatasetRemovals(f.options);recovered.sync(true);assert.equal(recovered.rows.some(row=>row.id===first.id),false);assert.equal(recovered.rows.length,1);
  assert.equal(JSON.parse(f.values.get(key)).find(row=>row.id===next.id).operationId,otherOperationId);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,2);
  recovered.stop();second.stop();f.api.stop();
 }
});
