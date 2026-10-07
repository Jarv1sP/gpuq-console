import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {MACHINES} from '../dist/model.js';
import {installDatasetReplication} from '../dataset-replication.mjs';
import {installDatasetCacheActions} from '../dataset-cache-actions.mjs';

const [target,source]=MACHINES.map(value=>value.id),ref={dataset:'sample',version:'a'.repeat(64)};
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const user={id:'demo-user-1',username:'alice',role:'member',enabled:true,limits:{[target]:1,[source]:1},total:2};
  const who={userId:user.id,username:user.username,role:user.role};
  const f={db,user,who,calls:[],native:new Map(),transfers:new Map(),local:true,ready:false,protocol:1,releasable:true};
  const service={db,store:{get:id=>id===user.id?structuredClone(user):{...user,id,username:'bob'}},audit:()=>{},bridge:async(machine,operation,args)=>{
    f.calls.push({machine,operation,args});
    if(f.onBridge)await f.onBridge(machine,operation,args);
    if(operation==='datasets.list')return {datasets:machine===source||machine===target&&f.local?[{dataset:ref.dataset,ownerIds:[user.id],versions:[{version:ref.version,state:machine===source||f.ready?'READY':'REGISTERED',...(f.local?{warehouseReady:true,warehouseCanPrepare:true}: {})}]}]:[]};
    if(operation==='datasets.status')return {dataset:args.dataset,version:args.version,state:f.ready?'READY':'REGISTERED',...(f.local?{warehouseReady:true,warehouseCanPrepare:true}: {})};
    if(operation==='storage.cache-action.capabilities')return {protocol:f.protocol,prepare:true,release:f.releasable,...(!f.releasable?{reason:'CACHE_IN_USE'}:{})};
    if(operation==='storage.cache-action.prepare'||operation==='storage.cache-action.release'){
      const row={key:args.key,dataset:args.dataset,version:args.version,state:'RUNNING',phase:'RUNNING'};f.native.set(args.key,row);
      if(f.lost){f.lost=false;throw Error('reply lost');}return row;
    }
    if(operation==='storage.cache-action.status')return f.native.get(args.key);
    if(operation==='storage.cache-action.cancel'){const row=f.native.get(args.key);row.state=f.cancelUnknown?'UNKNOWN':'CANCELED';return row;}
    throw Error('unexpected operation '+operation);
  },transferSnapshot:(owner,id)=>[...f.transfers.values()].find(value=>value.owner===owner&&value.id===id),transferSnapshotByKey:(owner,key)=>f.transfers.get(key),transferCall:async(principal,operation,args)=>{
    f.calls.push({operation,args});assert.equal(principal.role,'member');
    if(operation==='transfers.capabilities')return {enabled:true,sources:[source]};
    if(operation==='transfers.create'){
      const row={id:randomUUID(),owner:principal.userId,state:'RUNNING'};f.transfers.set(args.key,row);
      if(f.lost){f.lost=false;throw Error('reply lost');}return row;
    }
    const row=[...f.transfers.values()].find(value=>value.id===args.id);assert.ok(row);
    if(operation==='transfers.cancel')row.state='CANCELED';return row;
  }};
  installDatasetReplication(service);installDatasetCacheActions(service);f.service=service;
  f.call=(operation,args)=>service.datasetCacheActionsCall(who,'datasets.cache.'+operation,args);
  f.start=(action='prepare',key=randomUUID())=>f.call(action,{machine:target,...ref,key});
  return f;
}
test('local cache actions preserve original identity, status is read-only, and READY is a current fact',async t=>{
  const f=fixture(t),key=randomUUID(),out=await f.start('prepare',key);
  assert.equal(out.state,'RUNNING');assert.equal(out.key,key);
  const creates=()=>f.calls.filter(value=>value.operation==='storage.cache-action.prepare').length;
  assert.equal((await f.start('prepare',key)).operationId,out.operationId);assert.equal(creates(),1);
  f.native.get(key).state='READY';assert.equal((await f.call('status',{operationId:out.operationId})).state,'READY');
  f.native.get(key).state='UNKNOWN';assert.equal((await f.call('status',{key})).state,'UNKNOWN');assert.equal(creates(),1);
  assert.ok(f.calls.filter(value=>value.operation.startsWith('storage.cache-action.')).every(value=>value.args.hostAdmin===false));
});
test('lost ACK survives restart and never replays prepare/release',async t=>{
  const f=fixture(t);f.lost=true;const out=await f.start('release');assert.equal(out.state,'UNKNOWN');
  installDatasetCacheActions(f.service);f.native.get(out.key).state='RELEASED';
  assert.equal((await f.call('status',{key:out.key})).state,'RELEASED');
  assert.equal((await f.start('release',out.key)).operationId,out.operationId);
  assert.equal(f.calls.filter(value=>value.operation==='storage.cache-action.release').length,1);
});
test('UUID binds action, full version and target; untrusted selectors fail before bridge',async t=>{
  const f=fixture(t),out=await f.start();
  await assert.rejects(f.start('release',out.key),error=>error.code==='CACHE_ACTION_KEY_CONFLICT');
  await assert.rejects(f.call('prepare',{machine:target,...ref,version:'b'.repeat(64),key:out.key}),error=>error.code==='CACHE_ACTION_KEY_CONFLICT');
  const calls=f.calls.length;
  for(const field of ['owner','hostAdmin','path','source','disk','role','proof'])await assert.rejects(f.call('prepare',{machine:target,...ref,key:randomUUID(),[field]:'x'}));
  assert.equal(f.calls.length,calls);
});
test('old nodes, protected caches and zero machine grants do not dispatch writes',async t=>{
  const f=fixture(t);f.protocol=0;await assert.rejects(f.start(),error=>error.status===409);f.protocol=1;f.releasable=false;
  await assert.rejects(f.start('release'),error=>error.code==='CACHE_IN_USE');f.user.limits[target]=0;
  await assert.rejects(f.start(),error=>error.status===403);
  assert.equal(f.native.size,0);
});
test('cross-owner status and changed authorization cannot expose a receipt',async t=>{
  const f=fixture(t),out=await f.start();
  await assert.rejects(f.service.datasetCacheActionsCall({userId:'demo-user-2',username:'bob',role:'member'},'datasets.cache.status',{operationId:out.operationId}),error=>error.status===403);
  f.user.enabled=false;await assert.rejects(f.call('status',{operationId:out.operationId}),error=>error.status===403);
});
test('cross-node prepare uses only the existing shared transfer and lost ACK recovers original ID without unsafe cancel',async t=>{
  const f=fixture(t);f.local=false;f.lost=true;
  const out=await f.start();assert.equal(out.state,'UNKNOWN');assert.equal(f.transfers.size,1);
  installDatasetCacheActions(f.service);
  const observed=await f.call('status',{operationId:out.operationId});assert.equal(observed.state,'RUNNING');assert.ok(observed.transferId);
  const canceled=await f.call('cancel',{operationId:out.operationId});assert.equal(canceled.state,'RUNNING');assert.equal(canceled.canCancel,false);assert.equal(canceled.errorCode,'CACHE_SHARED_WORKER');
  assert.equal(f.transfers.size,1);assert.equal(f.calls.filter(value=>value.operation==='transfers.create').length,1);
  assert.equal(f.calls.some(value=>value.operation==='transfers.resume'),false);
  assert.equal(f.calls.some(value=>value.operation==='transfers.cancel'),false);
});
test('unconfirmed cancel stays UNKNOWN; same key does not restart',async t=>{
  const f=fixture(t),out=await f.start('release');f.cancelUnknown=true;
  assert.equal((await f.call('cancel',{operationId:out.operationId})).state,'UNKNOWN');
  await f.start('release',out.key);
  assert.equal(f.calls.filter(value=>value.operation==='storage.cache-action.release').length,1);
});
test('two same-account cache actions and a training consumer retain their shared original transfer on cancel',async t=>{
  const f=fixture(t);f.local=false;
  const first=await f.start(),second=await f.start();
  const original=[...f.transfers.values()][0];original.trainingConsumer='job-fixed';
  assert.equal(f.transfers.size,1);
  for(const operationId of [first.operationId,second.operationId]){
    const result=await f.call('cancel',{operationId});assert.equal(result.canCancel,false);assert.equal(result.errorCode,'CACHE_SHARED_WORKER');
  }
  assert.equal(original.state,'RUNNING');assert.equal(original.trainingConsumer,'job-fixed');
  assert.equal(f.calls.some(value=>['transfers.cancel','storage.cache-action.cancel'].includes(value.operation)),false);
});
test('audit failure creates neither operation nor native work',async t=>{
  const f=fixture(t);f.service.audit=()=>{throw Error('audit unavailable');};
  await assert.rejects(f.start(),/audit unavailable/);assert.equal(f.native.size,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dataset_cache_actions').get().n,0);
});
test('native status rechecks login and target authorization after bridge resolves',async t=>{
  const f=fixture(t),out=await f.start();
  f.onBridge=(machine,operation)=>{if(operation==='storage.cache-action.status')f.user.limits[target]=0;};
  await assert.rejects(f.call('status',{operationId:out.operationId}),error=>error.status===403);
  const row=JSON.parse(f.db.prepare('SELECT data FROM dataset_cache_actions WHERE id=?').get(out.operationId).data);
  assert.equal(row.state,'RUNNING');
});
test('completed action receipt never claims the current cache location',async t=>{
  const f=fixture(t),out=await f.start('release');f.native.get(out.key).state='RELEASED';
  const done=await f.call('status',{operationId:out.operationId});
  assert.equal(done.receiptOnly,true);assert.equal(done.locationState,'NOT_OBSERVED');
  f.native.get(out.key).state='RUNNING';
  assert.equal((await f.call('status',{operationId:out.operationId})).state,'RELEASED');
});
test('durably bound physical cache status is accepted only with exact logical mount and full version',async t=>{
  const f=fixture(t);f.local=false;const out=await f.start();
  f.service.resolveDataset=async()=>({status:{dataset:'wc-exact',version:ref.version,state:'READY'},reference:{dataset:'wc-exact',version:ref.version,mountAs:ref.dataset}});
  assert.equal((await f.call('status',{operationId:out.operationId})).state,'READY');
  f.service.resolveDataset=async()=>({status:{dataset:'wc-guessed',version:ref.version,state:'READY'},reference:{dataset:'wc-guessed',version:ref.version,mountAs:'other'}});
  assert.equal((await f.call('status',{operationId:out.operationId})).state,'UNKNOWN');
});
