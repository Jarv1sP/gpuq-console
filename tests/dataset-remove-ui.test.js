import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatasetRemovals,removalTarget,removalStorageKey,removalPreservation} from '../dist/dataset-remove-ui.js';
import {PortalService} from '../portal-service.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MACHINES} from '../dist/machines.js';
const VERSION='a'.repeat(64),OP='b'.repeat(64),target={machine:MACHINES[0].id,dataset:'sample',version:VERSION};

test('preservation distinguishes database original, other complete copies and no proof',()=>{
  const other=MACHINES[1].id,local={machine:target.machine,state:'READY'},remote={machine:other,state:'READY'};
  const view=(locations,options)=>removalPreservation(target,[{version:VERSION,locations}],MACHINES,options);
  assert.deepEqual(view([local,remote]).items[0],{version:VERSION,pending:false,graceEligible:false,kind:'replicas',machines:[other]});
  assert.equal(view([local,remote]).allowed,true);
  const archived={...local,storage:{phase:'ARCHIVED',originalRetained:true,archiveMachine:other}};
  assert.equal(view([archived,remote]).items[0].kind,'archive');
  for(const storage of [{phase:'ARCHIVING',originalRetained:true,archiveMachine:other},{phase:'ARCHIVED',originalRetained:false,archiveMachine:other},{phase:'ARCHIVED',originalRetained:true,archiveMachine:target.machine},{phase:'ARCHIVED',originalRetained:true,archiveMachine:'not-in-inventory'}])assert.equal(view([{...local,storage}]).allowed,false);
  for(const state of ['REGISTERED','STAGING','PREPARING','UNKNOWN','FAILED'])assert.equal(view([local,{...remote,state}]).allowed,false);
  assert.equal(view([local,remote],{partial:true}).allowed,false);
  assert.equal(view([local,{...remote,removalPending:true}]).allowed,false);
  assert.equal(view([{...local,removalPending:true},remote]).pending,true);assert.equal(view([{...local,removalPending:true},remote]).allowed,false);
  assert.equal(view([{...local,removalPending:true,removalGraceEligible:true},remote]).items[0].graceEligible,true);
  assert.equal(removalPreservation(target,[{version:VERSION,locations:[local,remote]},{version:OP,locations:[local]}],MACHINES).allowed,false);
});

test('authoritative pre-dispatch 409 stays BLOCKED with original message, no polling or retry',async()=>{
  for(const code of ['LAST_COPY_UNPROVEN','DATASET_REMOVAL_PENDING']){
    const f=fixture(),message='服务端原文：暂不能删除。';f.fail(Object.assign(Error(message),{status:409,code}));
    const row=await f.api.submit(target);assert.equal(row.state,'BLOCKED');assert.equal(row.error,message);assert.equal(row.blockReason,code);
    assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);assert.equal(f.api.blocked(target),false);assert.equal(f.done.length,0);
    const restored=createDatasetRemovals(f.options);restored.sync(true);assert.equal(restored.rows[0].state,'BLOCKED');assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
    restored.dismiss(row.id);assert.equal(restored.rows.length,0);restored.stop();
  }
  const f=fixture();f.fail(Object.assign(Error('unknown HTTP 409'),{status:409}));const row=await f.api.submit(target);assert.equal(row.state,'UNKNOWN');assert.throws(()=>f.api.dismiss(row.id));f.api.stop();
});
function fixture(){
  let who={userId:'admin-one',role:'admin'},response={operationId:OP,state:'UNREGISTERING'},failure=null,clock=0;
  const values=new Map(),timers=new Map(),calls=[],done=[];let next=0;
  const storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const options={principal:()=>who,machines:()=>MACHINES,storage,now:()=>clock,setTimer:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimer:id=>timers.delete(id),completed:row=>done.push(row),call:async(operation,args)=>{calls.push({operation,args});if(failure)throw failure;return structuredClone(response);}};
  const api=createDatasetRemovals(options);api.sync(true);
  return {api,options,values,timers,calls,done,storage,who:value=>who=value,respond:value=>response=value,fail:value=>failure=value,clock:value=>clock=value};
}
test('unregister submits exactly one scoped target and polls only the server operation ID at 2/5/10 seconds',async()=>{
  const f=fixture();const row=await f.api.submit(target);assert.equal(row.state,'UNREGISTERING');assert.equal(f.done.length,0);
  assert.deepEqual(f.calls,[{operation:'datasets.unregister',args:target}]);assert.equal([...f.timers.values()][0].delay,2000);
  f.clock(2000);await f.api.query(row.id);assert.equal([...f.timers.values()][0].delay,5000);
  f.clock(7000);await f.api.query(row.id);assert.equal([...f.timers.values()][0].delay,10000);
  assert(f.calls.slice(1).every(row=>row.operation==='datasets.status'));assert.deepEqual(f.calls.at(-1).args,{machine:target.machine,operationId:OP});
  f.api.sync(false);assert.equal(f.timers.size,0);f.api.sync(true);assert.equal(f.timers.size,1);f.api.stop();
});
test('only UNREGISTERED with its original receipt confirms completion, including an already absent registration',async()=>{
  for(const unregistered of [true,false]){const f=fixture(),row=await f.api.submit({...target,version:null});assert.deepEqual(f.calls[0].args,{machine:target.machine,dataset:target.dataset});
    f.respond({operationId:OP,state:'UNREGISTERED',unregistered,dataset:target.dataset,version:null});await f.api.query(row.id);assert.equal(f.done.length,1);assert.equal(f.done[0].unregistered,unregistered);assert.equal(f.timers.size,0);f.api.stop();}
});
test('FAILED preserves the node reason, UNKNOWN and timeouts never replay removal or resume automatic polling',async()=>{
  for(const state of ['FAILED','UNKNOWN','timeout']){const f=fixture(),row=await f.api.submit(target);
    if(state==='timeout')f.fail(Error('query timeout'));else f.respond({operationId:OP,state,error:'有训练正在使用'});
    await f.api.query(row.id);assert.equal(f.api.rows[0].state,state==='timeout'?'UNKNOWN':state);assert.equal(f.done.length,0);assert.equal(f.timers.size,0);assert.equal(f.calls.filter(x=>x.operation==='datasets.unregister').length,1);f.api.stop();}
});
test('HTTP errors including a portal-wrapped bridge timeout do not confirm rejection or unlock the target',async()=>{
  for(const status of [400,401,403,408,429,500,504]){const f=fixture();f.fail(Object.assign(Error('bridge outcome unavailable'),{status}));const row=await f.api.submit(target);
    assert.equal(row.state,'UNKNOWN');assert.equal(row.operationId,null);assert.equal(f.api.blocked(target),true);assert.equal(f.done.length,0);assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
    await assert.rejects(f.api.submit(target),/尚未确认/);assert.equal(f.calls.length,1);f.api.stop();}
});
test('malformed IDs, mismatched receipts and a completion without its boolean result cannot report success',async()=>{
  for(const result of [{state:'UNREGISTERED',unregistered:true},{operationId:'c'.repeat(64),state:'UNREGISTERED',unregistered:true},{operationId:OP,state:'UNREGISTERED'},{operationId:OP,state:'UNREGISTERED',unregistered:true,dataset:'other'},{operationId:OP,state:'UNREGISTERED',unregistered:true,version:'c'.repeat(64)}]){const f=fixture(),row=await f.api.submit(target);f.respond(result);await f.api.query(row.id);assert.equal(f.api.rows[0].state,'UNKNOWN');assert.equal(f.done.length,0);f.api.stop();}
});
test('lost initial response persists uncertain intent before dispatch and locks only overlapping targets',async()=>{
  const f=fixture();f.fail(Error('receipt lost'));await f.api.submit(target);const row=f.api.rows[0];assert.equal(row.operationId,null);assert.equal(row.state,'UNKNOWN');
  const stored=JSON.parse(f.values.get(removalStorageKey('admin-one')));assert.equal(stored[0].dataset,target.dataset);assert.equal(stored[0].state,'UNKNOWN');
  await assert.rejects(f.api.submit(target),/尚未确认/);assert.equal(f.api.blocked({...target,version:null}),true);assert.equal(f.api.blocked({...target,version:'c'.repeat(64)}),false);assert.equal(f.api.blocked({...target,machine:MACHINES[1].id}),false);assert.equal(f.api.blocked({...target,dataset:'other'}),false);
  const restored=createDatasetRemovals(f.options);restored.sync(true);assert.equal(restored.rows[0].state,'UNKNOWN');assert.equal(restored.blocked(target),true);assert.equal(f.timers.size,0);await assert.rejects(restored.query(row.id),/找到原编号/);
  f.fail(null);f.respond({operationId:OP,state:'UNREGISTERED',unregistered:true,dataset:target.dataset,version:VERSION});await restored.query(row.id,OP);assert.equal(f.done.length,1);assert.equal(f.calls.filter(x=>x.operation==='datasets.unregister').length,1);restored.stop();
});
test('a known operation survives a lost status response and refresh queries that same ID',async()=>{
  const f=fixture(),row=await f.api.submit(target);f.fail(Error('status lost'));await f.api.query(row.id);f.api.stop();
  const restored=createDatasetRemovals(f.options);restored.sync(true);assert.equal(restored.rows[0].operationId,OP);f.fail(null);f.respond({operationId:OP,state:'UNREGISTERED',unregistered:true});await restored.query(row.id);assert.equal(f.calls.at(-1).args.operationId,OP);assert.equal(f.calls.filter(x=>x.operation==='datasets.unregister').length,1);restored.stop();
});
test('uncertain intent is saved before the request and abandon unlocks locally without any server write',async()=>{
  const f=fixture();let seen;f.options.call=async()=>{seen=JSON.parse(f.values.get(removalStorageKey('admin-one')));throw Error('lost');};
  const api=createDatasetRemovals(f.options);api.sync(true);const row=await api.submit(target);assert.equal(seen[0].state,'SUBMITTING');assert.equal(api.blocked(target),true);
  api.abandon(row.id);assert.equal(api.blocked(target),false);assert.deepEqual(JSON.parse(f.values.get(removalStorageKey('admin-one'))),[]);assert.equal(f.calls.length,0);api.stop();
});
test('account namespaces and late receipts cannot leak operations or unlock another account',async()=>{
  const f=fixture();let release;f.options.call=()=>new Promise(resolve=>release=resolve);const api=createDatasetRemovals(f.options);api.sync(true);const pending=api.submit(target);
  f.who({userId:'admin-two',role:'admin'});api.sync(true);assert.deepEqual(api.rows,[]);assert.equal(api.blocked(target),false);
  release({operationId:OP,state:'UNREGISTERING'});await pending;assert.deepEqual(api.rows,[]);assert.equal(f.done.length,0);assert.equal(f.timers.size,0);
  f.who({userId:'admin-one',role:'admin'});api.sync(true);assert.equal(api.rows[0].operationId,OP);f.who({userId:'admin-one',role:'member'});api.sync(true);assert.deepEqual(api.rows,[]);await assert.rejects(api.submit(target),/只有管理员/);assert.equal(f.timers.size,0);
});
test('revoked machines never get queried and storage denial does not crash or erase in-memory intent',async()=>{
  const f=fixture();f.options.storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};const api=createDatasetRemovals(f.options);api.sync(true);const row=await api.submit(target);assert.equal(api.saved,false);
  f.options.machines=()=>[];const denied=createDatasetRemovals({...f.options,storage:f.storage});denied.sync(true);await assert.rejects(denied.submit(target),/未授权/);api.stop();
  const r=fixture(),known=await r.api.submit(target);r.api.stop();const revoked=createDatasetRemovals({...r.options,machines:()=>[]});revoked.sync(true);await revoked.query(known.id);assert.equal(revoked.rows[0].state,'UNKNOWN');assert.equal(r.calls.length,1);revoked.stop();
});
test('target validation rejects host paths and incomplete immutable hashes',()=>{
  for(const value of [null,{...target,dataset:'../sample'},{...target,dataset:'/data2'},{...target,version:'latest'},{...target,version:'A'.repeat(64)},{...target,machine:''}])assert.throws(()=>removalTarget(value),/目标无效/);
});
test('the catalog display name stays local metadata and never becomes an unregister argument',async()=>{
  const f=fixture();await f.api.submit({...target,catalogDataset:'display-alias'});
  assert.deepEqual(f.calls[0],{operation:'datasets.unregister',args:target});
  const restored=createDatasetRemovals(f.options);restored.sync(true);
  assert.equal(restored.rows[0].dataset,target.dataset);assert.equal(restored.rows[0].catalogDataset,'display-alias');
  restored.stop();f.api.stop();
});
test('a refresh does not drop an older uncertain intent behind a hundred completed receipts',()=>{
  const f=fixture(),pending={...target,id:'pending',state:'UNKNOWN',operationId:null};
  f.values.set(removalStorageKey('admin-one'),JSON.stringify([pending,...Array.from({length:100},(_,i)=>({...target,id:'completed-'+i,state:'UNREGISTERED',operationId:OP,unregistered:true}))]));
  const restored=createDatasetRemovals(f.options);restored.sync(true);assert.equal(restored.blocked(target),true);assert.equal(restored.rows.find(row=>row.id==='pending').state,'UNKNOWN');restored.stop();
});
test('a fully authorized real Portal member receives exactly 403 and never reaches the unregister bridge',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stargate-remove-contract-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),password='Local-Remove-Test-2026!';let writes=0;
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(machine=>({id:machine.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const service=await PortalService.open(join(dir,'db'),bootstrap,status,async()=>{writes++;return {};});clearInterval(service.executionTimer);t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'member',password})).result;await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});const session=await service.login('member',password);
  await assert.rejects(service.invoke(session.token,'datasets.unregister',target),error=>error.status===403);assert.equal(writes,0);
});
