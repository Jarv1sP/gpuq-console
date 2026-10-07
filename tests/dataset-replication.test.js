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
    f.calls.push({machine,operation,args});if(f.onBridge)await f.onBridge(machine,operation,args);
    if(operation==='datasets.list')return {datasets:machine===source?[{dataset:ref.dataset,versions:[{...ref,state:'READY'}]}]:machine!==target?[]:f.local?[{dataset:ref.dataset,versions:[{...ref,state:'READY'}]}]:f.copied?[{dataset:actual,versions:[{version:ref.version,state:'READY'}]}]:[]};
    if(operation==='datasets.status')return {dataset:args.dataset,version:args.version,state:(args.dataset===ref.dataset&&f.local||args.dataset===actual&&f.copied)?'READY':'REGISTERED',...(f.recovery&&args.dataset===actual&&!f.copied?{recoveryConfigured:true}:{})};
    if(operation==='datasets.prepare'){
      if(f.recoverError)throw f.recoverError;
      const result=f.recoverResult||{dataset:args.dataset,version:args.version,state:'PREPARING'};
      if(result.state==='READY')f.copied=true;
      return result;
    }
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

test('administrator preparation keeps the real capability identity and personal transfer authority',async t=>{
  const f=fixture(t),bridge=f.service.bridge,seen=[];
  f.service.bridge=async(...args)=>{
    const value=await bridge(...args);
    return args[1]==='datasets.list'?{...value,datasetDelete:1}:value;
  };
  f.service.datasetDeleteCapabilities=async who=>{
    assert.equal(who.userId,f.user.id);
    assert.equal(who.username,f.user.username);
    assert.equal(who.role,f.user.role,'capability identity must match the authenticated account');
    seen.push(who);return {datasetDelete:1};
  };
  assert.equal((await f.service.prepareDataset(f.user.id,target,ref)).state,'PREPARING');
  assert.equal(seen.length,1);
  assert.ok(f.calls.filter(call=>call.operation==='transfers.create').every(call=>call.who.role==='member'));
  assert.ok(f.calls.filter(call=>call.operation==='datasets.status').every(call=>call.args.hostAdmin===false));
});

test('administrator catalog identity never makes another owner private input usable',async t=>{
  const f=fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(...args)=>{
    const value=await bridge(...args);
    if(args[1]!=='datasets.list')return value;
    return {...value,datasetDelete:1,datasets:value.datasets.map(row=>({...row,ownerIds:['demo-user-2']}))};
  };
  f.service.datasetDeleteCapabilities=async who=>{
    assert.equal(who.role,'admin');return {datasetDelete:1};
  };
  await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),error=>error.status===403);
  assert.equal(f.records.size,0);
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

test('evicted historical successful copy restores its exact physical receipt without another copy',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.finish();f.recovery=true;
  const transfer=f.row().transferId,key=f.row().key,start=f.calls.length;
  const result=await f.service.prepareDataset(f.user.id,target,ref);
  assert.equal(result.state,'PREPARING');assert.equal(result.dataset,ref.dataset);
  assert.deepEqual(f.calls.slice(start).filter(c=>c.operation==='datasets.prepare'),[
    {machine:target,operation:'datasets.prepare',args:{userId:f.user.id,hostAdmin:false,dataset:actual,version:ref.version}}
  ]);
  assert.equal(f.row().transferId,transfer);assert.equal(f.row().key,key);assert.equal(f.records.size,1);
  assert.equal(f.calls.slice(start).some(c=>c.operation.startsWith('transfers.')||c.operation==='datasets.list'),false);
});

test('recovery after portal restart keeps the physical alias and fixed version',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.finish();f.recovery=true;
  f.recoverResult={dataset:actual,version:ref.version,state:'READY'};installDatasetReplication(f.service);
  assert.equal((await f.service.prepareDataset(f.user.id,target,ref)).state,'READY');
  assert.deepEqual((await f.service.resolveDataset(f.user.id,target,ref)).reference,{dataset:actual,version:ref.version,mountAs:ref.dataset});
  assert.equal(f.calls.filter(c=>c.operation==='transfers.create').length,1);
});

test('concurrent receipt recovery requests coalesce before a second prepare dispatch',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.finish();f.recovery=true;
  const result=await Promise.all([f.service.prepareDataset(f.user.id,target,ref),f.service.prepareDataset(f.user.id,target,ref)]);
  assert.ok(result.every(r=>r.state==='PREPARING'));
  assert.equal(f.calls.filter(c=>c.operation==='datasets.prepare').length,1);
  assert.equal(f.calls.filter(c=>c.operation==='transfers.create').length,1);
});

test('authority or ACL rejection during recovery never falls back to another source or transfer',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.finish();f.recovery=true;
  for(const error of [Error('authority fixed source changed'),Object.assign(Error('owner access revoked'),{status:403})]){
    f.recoverError=error;const start=f.calls.length;
    await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),e=>e===error);
    assert.equal(f.calls.slice(start).filter(c=>c.operation==='datasets.prepare').length,1);
    assert.equal(f.calls.slice(start).some(c=>c.operation.startsWith('transfers.')||c.operation==='datasets.list'),false);
  }
  assert.equal(f.records.size,1);
});

test('policy revocation before receipt recovery blocks the prepare side effect',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.finish();f.recovery=true;
  f.onBridge=(_,operation,args)=>{if(operation==='datasets.status'&&args.dataset===actual)f.user.enabled=false;};
  await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),e=>e.status===403);
  assert.equal(f.calls.some(c=>c.operation==='datasets.prepare'),false);
});

test('another owner\'s visible READY copy is not preparation authority',async t=>{
  const f=fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(machine,operation,args)=>{
    if(operation==='datasets.list')return {datasets:[{dataset:ref.dataset,ownerIds:['demo-user-2'],versions:[{version:ref.version,state:'READY',canPrepare:true}]}]};
    return bridge(machine,operation,args);
  };
  const value=(await datasetCatalogCall(f.service,{userId:f.user.id},'datasets.catalog',{machine:target})).datasets[0].versions[0];
  assert.equal(value.state,'READY');assert.equal(value.canUse,false);
  await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),e=>e.status===403);
  assert.equal(f.calls.some(c=>['datasets.prepare','transfers.create'].includes(c.operation)),false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dataset_copies').get().n,0);
});

test('zero machine quota rejects prepare before directory reads or copy creation',async t=>{
  const f=fixture(t);f.user.limits={};f.user.total=0;
  await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),e=>e.status===403);
  assert.equal(f.calls.length,0);assert.equal(f.records.size,0);
});

test('foreign local READY cannot skip the owned remote copy lifecycle',async t=>{
  const f=fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(machine,operation,args)=>{
    if(operation==='datasets.list')return {datasets:[{dataset:ref.dataset,ownerIds:[machine===source?f.user.id:'demo-user-2'],versions:[{version:ref.version,state:'READY'}]}]};
    return bridge(machine,operation,args);
  };
  const value=(await datasetCatalogCall(f.service,{userId:f.user.id},'datasets.catalog',{machine:target})).datasets[0].versions[0];
  assert.equal(value.canUse,true);assert.equal(value.state,'NOT_LOCAL');assert.equal(value.sourceMachine,source);
  assert.equal((await f.service.prepareDataset(f.user.id,target,ref)).state,'PREPARING');
  assert.equal(f.records.size,1);assert.equal(f.calls.filter(c=>c.operation==='transfers.create').length,1);
});

test('recovery rejects mismatched physical name or content version from the node',async t=>{
  const f=fixture(t);await f.service.prepareDataset(f.user.id,target,ref);f.finish();f.recovery=true;
  for(const result of [{dataset:ref.dataset,version:ref.version,state:'READY'},{dataset:actual,version:'b'.repeat(64),state:'READY'}]){
    f.copied=false;f.recoverResult=result;
    await assert.rejects(f.service.prepareDataset(f.user.id,target,ref),e=>e.status===502);
  }
  assert.equal(f.calls.filter(c=>c.operation==='transfers.create').length,1);
});
