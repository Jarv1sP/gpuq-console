import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installDatasetReplication} from '../dataset-replication.mjs';
import {datasetCatalogCall} from '../dataset-catalog.mjs';
import {MACHINES} from '../dist/model.js';
const [target,source]=MACHINES.map(m=>m.id),ref={dataset:'my-data',version:'a'.repeat(64)},actual='u-personal-replica';
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const user={id:'demo-user-1',username:'alice',role:'admin',enabled:true,limits:{[target]:1,[source]:1},total:1};
  const f={db,user,calls:[],records:new Map(),local:false,copied:false,enabled:true,lost:false};
  f.service={db,store:{get:()=>structuredClone(user)},bridge:async(machine,operation,args)=>{
    f.calls.push({machine,operation,args});if(f.onBridge)await f.onBridge(machine,operation);
    if(operation==='datasets.list')return {datasets:machine===source?[{dataset:ref.dataset,versions:[{...ref,state:'READY'}]}]:f.local?[{dataset:ref.dataset,versions:[{...ref,state:'READY'}]}]:f.copied?[{dataset:actual,versions:[{version:ref.version,state:'READY'}]}]:[]};
    if(operation==='datasets.status')return {dataset:args.dataset,version:args.version,state:(args.dataset===ref.dataset&&f.local||args.dataset===actual&&f.copied)?'READY':'REGISTERED'};
    throw Error('unexpected '+operation);
  },transferSnapshot:(owner,id)=>[...f.records.values()].find(v=>v.id===id&&v.owner===owner),transferSnapshotByKey:(owner,key)=>{const row=f.records.get(key);return row?.owner===owner?row:null;},transferCall:async(who,operation,args)=>{
    f.calls.push({who,operation,args});assert.equal(who.role,'member');
    if(operation==='transfers.capabilities')return {enabled:f.enabled,sources:user.limits[source]?[source]:[]};
    if(operation==='transfers.create'){
      if(!f.records.has(args.key))f.records.set(args.key,{owner:who.userId,id:randomUUID(),state:'RUNNING'});
      if(f.lost){f.lost=false;throw Error('response lost');}return f.records.get(args.key);
    }
    const value=[...f.records.values()].find(v=>v.id===args.id);assert.ok(value);
    if(operation==='transfers.resume')value.state='RUNNING';return value;
  }};
  installDatasetReplication(f.service);
  f.row=()=>JSON.parse(db.prepare('SELECT data FROM dataset_copies LIMIT 1').get().data);
  f.result=()=>[...f.records.values()].at(-1);
  f.finish=()=>Object.assign(f.result(),{state:'SUCCEEDED',result:{dataset:actual,version:ref.version}});
  return f;
}
test('approved direct transfer is preparable but not falsely local READY',async t=>{
  const f=fixture(t),catalog=await datasetCatalogCall(f.service,{userId:f.user.id},'datasets.catalog',{machine:target});
  assert.equal(catalog.datasets[0].versions[0].state,'NOT_LOCAL');assert.equal(catalog.datasets[0].versions[0].sourceMachine,source);
  assert.equal((await f.service.prepareDataset(f.user.id,target,ref)).state,'PREPARING');
  assert.equal(f.records.size,1);assert.ok(f.calls.filter(c=>c.operation==='datasets.status').every(c=>c.args.hostAdmin===false));
});
test('success receipt alone is insufficient; real READY maps the stable training name',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.finish();
  assert.notEqual((await f.service.resolveDataset(f.user.id,target,ref)).status.state,'READY');
  f.copied=true;const result=await f.service.resolveDataset(f.user.id,target,ref);
  assert.equal(result.status.state,'READY');assert.equal(result.status.dataset,ref.dataset);
  assert.deepEqual(result.reference,{dataset:actual,version:ref.version,mountAs:ref.dataset});
  const catalog=await datasetCatalogCall(f.service,{userId:f.user.id},'datasets.catalog',{machine:target});
  assert.equal(catalog.datasets.length,1);assert.equal(catalog.datasets[0].dataset,ref.dataset);assert.equal(catalog.datasets[0].versions[0].state,'READY');
});
test('portal restart observes original transfer, never creates a second copy',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);const id=f.row().transferId;
  installDatasetReplication(f.service);await f.service.prepareDataset(f.user.id,target,ref);
  assert.equal(f.row().transferId,id);assert.equal(f.records.size,1);assert.equal(f.calls.filter(c=>c.operation==='transfers.create').length,1);
});
test('lost create reply reuses its persistent key after restart',async t=>{
  const f=fixture(t);f.lost=true;await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),/response lost/);const key=f.row().key;
  installDatasetReplication(f.service);await f.service.prepareDataset(f.user.id,target,ref);
  assert.equal(f.row().key,key);assert.equal(f.records.size,1);
});
test('lost reply recovers a finished target without querying an offline source',async t=>{
  const f=fixture(t);f.lost=true;await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),/response lost/);
  f.finish();f.copied=true;f.onBridge=(machine)=>{if(machine===source)throw Error('source offline');};
  installDatasetReplication(f.service);const result=await f.service.prepareDataset(f.user.id,target,ref);
  assert.equal(result.state,'READY');assert.equal(result.dataset,ref.dataset);assert.equal(f.row().transferId,f.result().id);
  assert.equal(f.records.size,1);assert.equal(f.calls.filter(c=>c.operation==='transfers.create').length,1);
});
test('failed copies require explicit retry and resume the same transfer',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.result().state='FAILED';const id=f.row().transferId;
  assert.equal((await f.service.prepareDataset(f.user.id,target,ref,{retry:false})).state,'FAILED');
  assert.equal(f.calls.some(c=>c.operation==='transfers.resume'),false);
  assert.equal((await f.service.prepareDataset(f.user.id,target,ref)).state,'PREPARING');assert.equal(f.row().transferId,id);
});
test('fresh local READY wins over any failed historical copy',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.result().state='FAILED';f.local=true;
  assert.equal((await f.service.prepareDataset(f.user.id,target,ref,{retry:false})).state,'READY');
});
test('concurrent preparations coalesce and never expose an alias to another owner',async t=>{
  const f=fixture(t);await Promise.all([f.service.prepareDataset(f.user.id,target,ref),f.service.prepareDataset(f.user.id,target,ref)]);
  assert.equal(f.records.size,1);assert.equal(f.calls.filter(c=>c.operation==='transfers.create').length,1);
  f.finish();assert.equal(f.service.datasetAliases('other',target).size,0);
});
test('revoked source grant or disabled LAN path cannot start a copy',async t=>{
  const f=fixture(t);f.user.limits[source]=0;await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),e=>e.status===403);
  f.user.limits[source]=1;f.enabled=false;await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),/没有可用/);assert.equal(f.records.size,0);
});
test('revocation during catalog reads prevents a prepare side effect',async t=>{
  const f=fixture(t);f.onBridge=(_,op)=>{if(op==='datasets.list')f.user.enabled=false;};
  await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),e=>e.status===403);assert.equal(f.records.size,0);
});
test('mismatched target version cannot become a training alias',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.finish();f.result().result.version='b'.repeat(64);f.copied=true;
  const result=await f.service.resolveDataset(f.user.id,target,ref);assert.notEqual(result.status.state,'READY');assert.equal(f.service.datasetAliases(f.user.id,target).size,0);
});
