import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installStorageArchive,storageArchivePolicy} from '../storage-archive.mjs';
import {installTransfers} from '../transfers.mjs';
import {datasetCatalogCall} from '../dataset-catalog.mjs';
import {MACHINES} from '../dist/model.js';
import {installMaintenance} from '../maintenance.mjs';

const [hot,cold,other]=MACHINES.map(m=>m.id),ref={dataset:'u-personal-new',version:'a'.repeat(64)};
const manifest={state:'READY',manifestBytes:100,manifestSha256:'b'.repeat(64),totalBytes:30,entries:2};
function fixture(t){
  const db=new DatabaseSync(':memory:');
  const user={id:'demo-user-1',username:'alice',role:'member',enabled:true,limits:{[hot]:1,[cold]:0,[other]:1},total:1};
  const f={db,user,calls:[],transfers:new Map(),events:[{id:randomUUID(),userId:user.id,...ref,state:'READY'}],now:1000,ready:false};
  const service=f.service={db,store:{get:id=>{assert.equal(id,user.id);return structuredClone(user);},users:[user]},audit:()=>{},bridge:async(machine,op,args)=>{
    f.calls.push({machine,op,args});if(f.onCall)await f.onCall(machine,op,args);
    if(op==='storage.archive.events')return {events:machine===hot?f.events:[]};
    if(op==='storage.archive.ack')return {id:args.id,acknowledged:true};
    if(op==='storage.archive.original')return {...args,protected:true};
    if(op==='transfers.capabilities')return {enabled:true,sourceReady:true,protocol:'lan-transfer-v1',sources:[hot,cold,other]};
    if(op==='transfers.source.prepare')return {id:args.id,token:'x'.repeat(43),...manifest};
    if(op==='transfers.start'){
      if(!f.transfers.has(args.id))f.transfers.set(args.id,{id:args.id,state:'RUNNING'});
      return f.transfers.get(args.id);
    }
    if(op==='transfers.status')return f.transfers.get(args.id);
    if(op==='transfers.resume'){
      const row=f.transfers.get(args.id);
      if(['FAILED','PAUSED'].includes(row.state))row.state='RUNNING';
      return row;
    }
    if(op==='transfers.confirm-source-release')return {schema:1,id:args.id,userId:user.id,sourceMachine:hot,targetMachine:cold,reference:{kind:'datasets',...ref},manifestSha256:manifest.manifestSha256,attempt:1,state:'SUCCEEDED',confirmedStopped:true};
    if(op==='transfers.release-source')return {id:args.id,released:true};
    if(op==='storage.archive.provision')return {opId:args.opId,state:'READY',grant:{schema:1,id:args.opId,sourceMachine:cold,targetMachine:args.targetMachine,...args.source,token:'private-grant-token',receipt:{owners:[user.id]}}};
    if(op==='storage.archive.certify')return {opId:args.opId,state:'READY',...args.target,role:'cache',receiptSha256:'c'.repeat(64)};
    if(op==='datasets.list')return {datasets:machine===cold?[{dataset:'cold-copy',versions:[{version:ref.version,state:'READY'}]},{dataset:'not-enrolled',versions:[{version:ref.version,state:'READY'}]}]:[]};
    throw Error('Unexpected fixture operation '+op);
  }};
  installTransfers(service);
  f.install=()=>f.archive=installStorageArchive(service,{enabled:true,machine:cold,authority:'hdd'},{clock:()=>f.now,startTimer:false});
  f.install();
  f.principal={userId:user.id,username:user.username,role:'member'};
  f.finish=()=>{for(const row of f.transfers.values())Object.assign(row,{state:'SUCCEEDED',dataset:'cold-copy',version:ref.version});};
  t.after(()=>{service.closing=true;clearInterval(service.transferTimer);db.close();});
  return f;
}

test('archive policy is explicit fixed configuration, disabled by default',()=>{
  assert.deepEqual(storageArchivePolicy(),{enabled:false});
  for(const policy of [{enabled:true,machine:'not-a-node',authority:'hdd'},{enabled:true,machine:cold,authority:'../x'},{enabled:true,machine:cold,authority:'hdd',endpoint:'https://evil'}])assert.throws(()=>storageArchivePolicy(policy));
});

test('maintenance pauses discovery and an in-flight copy cannot advance to seal/certify',async t=>{
  const f=fixture(t);installMaintenance(f.service);
  const enable=()=>f.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify({version:1,revision:1,global:{reason:'repair',since:new Date().toISOString()},machines:{}}));
  await f.service.reconcileStorageArchive();f.finish();const before=f.archive.rows()[0];
  f.onCall=(_,op)=>{if(op==='transfers.status')enable();};
  await f.service.reconcileStorageArchive();
  assert.equal(f.calls.some(c=>c.op==='storage.archive.provision'||c.op==='storage.archive.certify'),false);
  const held=f.archive.rows()[0];assert.equal(held.phase,before.phase);assert.equal(held.failures,before.failures);
  assert.ok(f.db.prepare('SELECT archive_id FROM storage_archive_lane').get());
  const count=f.calls.length;await f.service.reconcileStorageArchive();assert.equal(f.calls.length,count);
});
test('new immutable event archives through existing transfer without cold GPU permission',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();assert.equal(f.transfers.size,1);
  const row=f.archive.rows()[0];assert.equal(row.phase,'COPYING');assert.equal(f.user.limits[cold],0);
  f.finish();await f.service.reconcileStorageArchive();
  const finished=f.archive.rows()[0];assert.equal(finished.phase,'ARCHIVED');assert.equal(finished.eventAcknowledged,true);
  assert.equal(f.calls.find(c=>c.op==='transfers.source.prepare').args.hostAdmin,false);
  assert.equal(f.service.archiveSourceAllowed(f.user.id,cold,{dataset:'cold-copy',version:ref.version}),true);
  assert.equal(f.service.archiveSourceAllowed(f.user.id,cold,{dataset:'not-enrolled',version:ref.version}),false);
  const durable=JSON.stringify(f.archive.rows());assert.equal(durable.includes('private-grant-token'),false);assert.equal(durable.includes('x'.repeat(43)),false);
});
test('public copy cannot claim internal archive admission or upload to cold store',async t=>{
  const f=fixture(t),request={key:randomUUID(),kind:'copy',from:hot,machine:cold,...ref,name:'mine'};
  await assert.rejects(f.service.transferCall(f.principal,'transfers.create',request),e=>e.status===403);
  await assert.rejects(f.service.transferCall(f.principal,'transfers.create',{...request,managedArchive:1}));
  await assert.rejects(f.service.archiveTransferCall(f.principal,request),e=>e.status===403);
  assert.equal(f.transfers.size,0);
});
test('portal restart reuses copy and grant IDs; never certifies before copied version matches',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();const before=structuredClone(f.archive.rows()[0]);
  f.install();await f.service.reconcileStorageArchive();assert.equal(f.transfers.size,1);
  assert.equal(f.archive.rows()[0].copyKey,before.copyKey);assert.equal(f.archive.rows()[0].grantId,before.grantId);
  f.finish();[...f.transfers.values()][0].version='d'.repeat(64);
  await f.service.reconcileStorageArchive();assert.notEqual(f.archive.rows()[0].phase,'ARCHIVED');
  assert.equal(f.calls.some(c=>c.op==='storage.archive.certify'),false);
});
test('revocation while copying blocks authority certification and preserves source',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();f.finish();
  f.onCall=(_,op)=>{if(op==='transfers.status')f.user.limits[hot]=0;};
  await f.service.reconcileStorageArchive();assert.equal(f.archive.rows()[0].phase,'BLOCKED');
  assert.equal(f.calls.some(c=>c.op==='storage.archive.certify'),false);
});
test('lost certification reply retries original IDs with no grant persisted',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();f.finish();let lost=true;
  f.onCall=(_,op)=>{if(op==='storage.archive.certify'&&lost){lost=false;throw Error('private error with a token');}};
  await f.service.reconcileStorageArchive();const before=f.archive.rows()[0];assert.equal(before.phase,'CERTIFYING');
  assert.equal(JSON.stringify(before).includes('token'),false);f.install();f.now+=300001;await f.service.reconcileStorageArchive();
  assert.equal(f.archive.rows()[0].phase,'ARCHIVED');assert.equal(f.archive.rows()[0].certifyId,before.certifyId);
});
test('wrong grant owner/source/target/version cannot certify or release protection',async t=>{
  for(const mutation of [g=>g.receipt.owners=['demo-user-2'],g=>g.sourceMachine=other,g=>g.targetMachine=other,g=>g.version='d'.repeat(64)]){
    const f=fixture(t);await f.service.reconcileStorageArchive();f.finish();const bridge=f.service.bridge;
    f.service.bridge=async(...args)=>{const value=await bridge(...args);if(args[1]==='storage.archive.provision')mutation(value.grant);return value;};
    await f.service.reconcileStorageArchive();assert.notEqual(f.archive.rows()[0].phase,'ARCHIVED');assert.equal(f.calls.some(c=>c.op==='storage.archive.certify'),false);
  }
});
test('catalog exposes only the owners enrolled archive even without a storage-node compute grant',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();f.finish();await f.service.reconcileStorageArchive();
  const catalog=await datasetCatalogCall(f.service,f.principal,'datasets.catalog',{machine:other});
  assert.equal(catalog.datasets.length,1);assert.equal(catalog.datasets[0].dataset,ref.dataset);
  assert.equal(catalog.datasets[0].versions[0].sourceMachine,cold);assert.equal(catalog.datasets[0].versions[0].sourceDataset,'cold-copy');
  const copied=await f.service.transferCall(f.principal,'transfers.create',{key:randomUUID(),kind:'copy',from:cold,machine:other,dataset:'cold-copy',version:ref.version,name:'replica'});
  assert.equal(copied.state,'RUNNING');
  await assert.rejects(f.service.transferCall(f.principal,'transfers.create',{key:randomUUID(),kind:'copy',from:cold,machine:other,dataset:'not-enrolled',version:ref.version,name:'bad'}),e=>e.status===403);
});
test('replica certification reuses known protected original without another copy',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();f.finish();await f.service.reconcileStorageArchive();const count=f.transfers.size;
  f.service.enqueueArchiveReplica(f.user.id,other,ref,{dataset:'other-local',version:ref.version});
  await f.service.reconcileStorageArchive();assert.equal(f.transfers.size,count);
  const replica=f.archive.rows().find(r=>r.kind==='replica');assert.equal(replica.phase,'ARCHIVED');assert.equal(replica.sourceDataset,'cold-copy');
});
test('invalid or old un-enrolled data never creates an archive job',async t=>{
  const f=fixture(t);f.events=[];await f.service.reconcileStorageArchive();assert.equal(f.archive.rows().length,0);
  assert.throws(()=>f.archive.enqueueEvent(hot,{...ref,userId:f.user.id,id:randomUUID(),state:'STAGING'}));
  assert.equal(f.service.enqueueArchiveReplica(f.user.id,hot,ref,ref),null);
});

test('one durable automatic lane survives restart and unknown replies without starting another copy',async t=>{
  const f=fixture(t);f.events.push({...f.events[0],id:randomUUID(),dataset:'second'});
  await f.service.reconcileStorageArchive();const first=f.archive.rows()[0];
  assert.equal(f.transfers.size,1);f.now+=15000;f.install();
  f.onCall=(_,op)=>{if(op==='transfers.status')throw Error('reply lost');};
  await f.service.reconcileStorageArchive();f.now+=15000;await f.service.reconcileStorageArchive();
  assert.equal(f.transfers.size,1);
  assert.equal(f.db.prepare('SELECT archive_id FROM storage_archive_lane').get().archive_id,first.id);
  assert.equal(f.archive.rows()[1].phase,'QUEUED');
});

test('failed copy requires explicit retry; only the background lane resumes the original identity',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();const before=f.archive.rows()[0];
  f.transfers.get(before.transferId).state='PAUSED';await f.service.reconcileStorageArchive();
  assert.equal(f.archive.rows()[0].phase,'FAILED');
  f.finish();f.now+=300001;await f.service.reconcileStorageArchive();
  assert.equal(f.archive.rows()[0].phase,'FAILED');
  const original=f.service.archiveTransferCall,resumes=[];
  f.service.archiveTransferCall=async(who,args,options)=>{resumes.push(options);return original(who,args,options);};
  const calls=f.calls.length;f.service.retryStorageArchive(f.user.id,hot,ref);
  assert.equal(f.calls.length,calls);assert.equal(f.archive.rows()[0].retryRequested,true);
  await f.service.reconcileStorageArchive();
  // A status race may discover completion during resume's stopped-state gate.
  // The next observation still uses the original identity, never a new job.
  f.now+=300001;await f.service.reconcileStorageArchive();assert.equal(f.archive.rows()[0].phase,'ARCHIVED');
  assert.ok(resumes.length>0);assert.ok(resumes.every(value=>value.resume===true));assert.equal(f.archive.rows()[0].copyKey,before.copyKey);
  assert.equal(f.transfers.size,1);assert.equal(f.archive.rows()[0].transferId,before.transferId);
});

test('paused managed copy resumes through the private lane, not the public transfer action',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();const row=f.archive.rows()[0];
  f.transfers.get(row.transferId).state='PAUSED';await f.service.reconcileStorageArchive();
  await assert.rejects(f.service.transferCall(f.principal,'transfers.resume',{id:row.transferId}),/数据集页面/);
  f.service.retryStorageArchive(f.user.id,hot,ref);await f.service.reconcileStorageArchive();
  assert.equal(f.transfers.get(row.transferId).state,'RUNNING');assert.equal(f.transfers.size,1);
  f.finish();await f.service.reconcileStorageArchive();assert.equal(f.archive.rows()[0].phase,'ARCHIVED');
});

test('revoked owner keeps the active lane and must explicitly retry after authorization returns',async t=>{
  const f=fixture(t);f.events.push({...f.events[0],id:randomUUID(),dataset:'second'});
  await f.service.reconcileStorageArchive();f.user.limits[hot]=0;
  await f.service.reconcileStorageArchive();assert.equal(f.archive.rows()[0].phase,'BLOCKED');
  assert.throws(()=>f.service.retryStorageArchive(f.user.id,hot,ref));
  f.user.limits[hot]=1;f.now+=300001;await f.service.reconcileStorageArchive();
  assert.equal(f.archive.rows()[0].phase,'BLOCKED');assert.equal(f.transfers.size,1);
  f.service.retryStorageArchive(f.user.id,hot,ref);await f.service.reconcileStorageArchive();
  assert.equal(f.archive.rows()[0].phase,'COPYING');assert.equal(f.transfers.size,1);
});

test('confirmed stopped failure frees lane but retry cannot bypass another active archive',async t=>{
  const f=fixture(t);f.events.push({...f.events[0],id:randomUUID(),dataset:'second'});
  await f.service.reconcileStorageArchive();const first=f.archive.rows()[0];
  f.transfers.get(first.transferId).state='FAILED';await f.service.reconcileStorageArchive();
  f.now+=15000;await f.service.reconcileStorageArchive();assert.equal(f.transfers.size,2);
  f.service.retryStorageArchive(f.user.id,hot,ref);
  const active=f.archive.rows()[1];await f.service.reconcileStorageArchive();
  assert.equal(f.db.prepare('SELECT archive_id FROM storage_archive_lane').get().archive_id,active.id);
  assert.equal(f.archive.rows()[0].retryRequested,true);
});

test('permanently canceled archive never receives a replacement transfer on retry',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();const row=f.archive.rows()[0];
  f.transfers.get(row.transferId).state='CANCELED';await f.service.reconcileStorageArchive();
  assert.throws(()=>f.service.retryStorageArchive(f.user.id,hot,ref),/永久取消/);
  assert.equal(f.archive.rows()[0].copyKey,row.copyKey);assert.equal(f.transfers.size,1);
});

test('failed provision and certification require explicit retry with their original IDs',async t=>{
  for(const stage of ['storage.archive.provision','storage.archive.certify']){
    const f=fixture(t);await f.service.reconcileStorageArchive();f.finish();
    const bridge=f.service.bridge;let failed=true;
    f.service.bridge=async(machine,op,args)=>{
      if(op===stage&&failed)return {opId:args.opId,state:'FAILED'};
      return bridge(machine,op,args);
    };
    await f.service.reconcileStorageArchive();const before=f.archive.rows()[0];assert.equal(before.phase,'FAILED');
    failed=false;f.now+=300001;await f.service.reconcileStorageArchive();assert.equal(f.archive.rows()[0].phase,'FAILED');
    f.service.retryStorageArchive(f.user.id,hot,ref);await f.service.reconcileStorageArchive();
    const after=f.archive.rows()[0];assert.equal(after.phase,'ARCHIVED');
    assert.equal(after.grantId,before.grantId);assert.equal(after.certifyId,before.certifyId);
    assert.equal(f.calls.filter(call=>call.op===stage).at(-1).args.retry,true);
  }
});

test('changed trusted storage machine or authority cannot reuse a pending archive',async t=>{
  for(const policy of [{enabled:true,machine:other,authority:'hdd'},{enabled:true,machine:cold,authority:'other-hdd'}]){
    const f=fixture(t);await f.service.reconcileStorageArchive();const before=f.archive.rows()[0];
    const calls=f.calls.length;f.archive=installStorageArchive(f.service,policy,{clock:()=>f.now,startTimer:false});
    await f.service.reconcileStorageArchive();
    assert.equal(f.calls.slice(calls).every(call=>call.op==='storage.archive.events'),true);
    assert.throws(()=>f.service.retryStorageArchive(f.user.id,hot,ref),/policy changed/);
    assert.equal(f.archive.rows()[0].sourceMachine,before.sourceMachine);
    assert.equal(f.transfers.size,1);
  }
});

test('re-registration reuses immutable source grant but certifies the new local registration',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();f.finish();await f.service.reconcileStorageArchive();
  const before=f.archive.rows()[0];f.events=[{...f.events[0],id:randomUUID()}];
  await f.service.reconcileStorageArchive();const after=f.archive.rows()[1];
  assert.equal(after.phase,'ARCHIVED');assert.equal(f.transfers.size,1);
  assert.equal(after.sourceDataset,before.sourceDataset);assert.equal(after.grantId,before.grantId);
  assert.notEqual(after.certifyId,before.certifyId);assert.notEqual(after.eventId,before.eventId);
});

test('replicas with different local names reuse one immutable source-to-target grant',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();f.finish();await f.service.reconcileStorageArchive();
  f.service.enqueueArchiveReplica(f.user.id,other,ref,{dataset:'replica-a',version:ref.version});
  f.service.enqueueArchiveReplica(f.user.id,other,ref,{dataset:'replica-b',version:ref.version});
  const rows=f.archive.rows().filter(row=>row.kind==='replica');
  assert.equal(rows.length,2);assert.equal(rows[0].grantId,rows[1].grantId);
  assert.notEqual(rows[0].certifyId,rows[1].certifyId);
});
