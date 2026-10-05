import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
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
    if(op==='transfers.cancel'){const row=f.transfers.get(args.id);row.state='CANCELED';return row;}
    if(op==='transfers.resume'){
      const row=f.transfers.get(args.id);
      if(['FAILED','PAUSED'].includes(row.state))row.state='RUNNING';
      return row;
    }
    if(op==='transfers.confirm-source-release')return {schema:1,id:args.id,userId:user.id,sourceMachine:hot,targetMachine:cold,reference:{kind:'datasets',...ref},manifestSha256:manifest.manifestSha256,attempt:1,state:f.transfers.get(args.id)?.state||'SUCCEEDED',confirmedStopped:true};
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

function enrollmentFixture(t){
  const f=fixture(t);f.events=[];
  f.admin={id:'demo-user-99',username:'admin',enabled:true,role:'admin',limits:{[hot]:1}};
  f.service.store.get=id=>structuredClone(id===f.admin.id?f.admin:id===f.user.id?f.user:null);
  f.actor={userId:f.admin.id,username:f.admin.username,role:'admin'};
  f.request={machine:hot,...ref,ownerId:f.user.id,key:randomUUID()};
  const bridge=f.service.bridge;
  f.service.bridge=async(machine,op,args)=>{
    if(op!=='storage.archive.enrollment-check')return bridge(machine,op,args);
    f.calls.push({machine,op,args});await f.onCheck?.(machine,args);
    return {protocol:1,machine,userId:args.userId,dataset:args.dataset,version:args.version,state:'READY',role:'protected',manifestSha256:args.version,manifestBytes:100,registration:(machine===hot?'c':'d').repeat(64),...f.probeOverride};
  };
  return f;
}

function retirementFixture(t){
  const f=enrollmentFixture(t);f.user.limits[cold]=1;
  const event={id:randomUUID(),userId:f.user.id,...ref,state:'READY'};
  const row=f.archive.enqueueEvent(cold,event);
  f.db.prepare('INSERT INTO storage_archive_lane VALUES(1,?)').run(row.id);
  f.retire={machine:cold,...ref,ownerId:f.user.id,eventId:event.id,recoveryId:'unregister-'+'1'.repeat(32)};
  const bridge=f.service.bridge;
  f.service.bridge=async(machine,op,args)=>{
    if(op!=='storage.archive.retire')return bridge(machine,op,args);
    f.calls.push({machine,op,args});await f.onRetire?.();
    return {protocol:1,id:args.id,userId:args.userId,dataset:args.dataset,version:args.version,
      recoveryId:args.recoveryId,state:'RETIRED',neverDispatched:true,proofSha256:'f'.repeat(64),...f.retireOverride};
  };
  f.rowId=row.id;return f;
}

test('explicit retirement durably fails only old intent, frees its lane and never retries',async t=>{
  const f=retirementFixture(t);
  const [a,b]=await Promise.all([f.service.retireStorageArchive(f.actor,f.retire),f.service.retireStorageArchive(f.actor,f.retire)]);
  assert.deepEqual(a,b);assert.equal(a.phase,'FAILED');assert.equal(f.archive.load(f.rowId).failureStage,'retired');
  assert.equal(f.db.prepare('SELECT * FROM storage_archive_lane').get(),undefined);
  assert.equal(f.calls.filter(c=>c.op==='storage.archive.retire').length,1);
  assert.deepEqual(await f.service.retireStorageArchive(f.actor,{...f.retire}),a);
  assert.throws(()=>f.service.retryStorageArchive(f.user.id,cold,ref),/不能重试/);
  f.install();await f.service.reconcileStorageArchive();
  assert.equal(f.archive.load(f.rowId).failureStage,'retired');
  assert.equal(f.calls.some(c=>['storage.archive.original','storage.archive.provision','storage.archive.certify'].includes(c.op)),false);
});

test('retirement rejects missing/mismatched proof, authorization and cross-machine/seal contexts',async t=>{
  for(const override of [{state:'UNKNOWN'},{neverDispatched:false},{userId:'demo-user-2'},{version:'b'.repeat(64)},{proofSha256:null}]){
    const f=retirementFixture(t);f.retireOverride=override;
    await assert.rejects(f.service.retireStorageArchive(f.actor,f.retire),/not confirmed/);
    assert.equal(f.db.prepare('SELECT archive_id FROM storage_archive_lane').get().archive_id,f.rowId);
    assert.equal(f.archive.load(f.rowId).phase,'PROVISIONING');
  }
  const f=retirementFixture(t);
  assert.throws(()=>f.service.retireStorageArchive(f.principal,f.retire),/administrator/);
  for(const change of [{machine:hot},{ownerId:'demo-user-2'},{eventId:randomUUID()},{hostAdmin:true}])
    assert.throws(()=>f.service.retireStorageArchive(f.actor,{...f.retire,...change}));
  for(const change of [{kind:'replica'},{sourceDataset:'other'},{transferId:randomUUID()},{phase:'CERTIFYING'},{eventAcknowledged:true}]){
    const row=f.archive.load(f.rowId);f.db.prepare('UPDATE storage_archives SET data=? WHERE id=?').run(JSON.stringify({...row,...change}),f.rowId);
    assert.throws(()=>f.service.retireStorageArchive(f.actor,f.retire),/never-dispatched/);
    f.db.prepare('UPDATE storage_archives SET data=? WHERE id=?').run(JSON.stringify(row),f.rowId);
  }
  f.onRetire=()=>{f.admin.role='member';};await assert.rejects(f.service.retireStorageArchive(f.actor,f.retire),/authorization changed/);
  assert.equal(f.archive.load(f.rowId).phase,'PROVISIONING');
});

test('retirement cannot clear another lane and a late original reply cannot resurrect the row',async t=>{
  const f=retirementFixture(t);let entered,unblock;
  const ready=new Promise(r=>entered=r),wait=new Promise(r=>unblock=r);
  f.onCall=async(_,op)=>{if(op==='storage.archive.original'){entered();await wait;}};
  const reconcile=f.service.reconcileStorageArchive();await ready;
  f.db.prepare('UPDATE storage_archive_lane SET archive_id=?').run('another-fixed-lane');
  await f.service.retireStorageArchive(f.actor,f.retire);
  unblock();await reconcile;
  assert.equal(f.archive.load(f.rowId).failureStage,'retired');assert.equal(f.archive.load(f.rowId).phase,'FAILED');
  assert.equal(f.db.prepare('SELECT archive_id FROM storage_archive_lane').get().archive_id,'another-fixed-lane');
});

test('explicit admin enrollment reuses exact HDD original, not transfer or forged outbox',async t=>{
  const f=enrollmentFixture(t);
  const [first,again]=await Promise.all([f.service.enrollStorageArchive(f.actor,f.request),f.service.enrollStorageArchive(f.actor,f.request)]);
  assert.deepEqual(first,again);assert.equal(first.phase,'PROVISIONING');assert.equal(f.archive.rows().length,1);
  assert.equal(f.calls.filter(c=>c.op==='storage.archive.enrollment-check').length,2);
  await f.service.reconcileStorageArchive();
  const row=f.archive.rows()[0];assert.equal(row.phase,'ARCHIVED');assert.equal(row.sourceDataset,ref.dataset);
  assert.equal(f.transfers.size,0);assert.equal(f.calls.some(c=>c.op==='storage.archive.ack'),false);
  assert.equal(f.calls.find(c=>c.op==='storage.archive.provision').args.expectedRegistration,'d'.repeat(64));
  assert.equal(f.calls.find(c=>c.op==='storage.archive.certify').args.expectedRegistration,'c'.repeat(64));
  assert.equal((await f.service.enrollStorageArchive(f.actor,f.request)).phase,'ARCHIVED');
  assert.equal(f.service.archiveSourceAllowed(f.user.id,cold,ref),true);
  assert.equal(f.service.archiveSourceAllowed('demo-user-2',cold,ref),false);
});

test('enrollment rejects member, disabled/revoked owner, arbitrary source and reused key',async t=>{
  const f=enrollmentFixture(t);
  assert.throws(()=>f.service.enrollStorageArchive(f.principal,f.request),/administrator/);
  f.admin.role='member';assert.throws(()=>f.service.enrollStorageArchive(f.actor,f.request),/administrator/);f.admin.role='admin';
  f.user.enabled=false;assert.throws(()=>f.service.enrollStorageArchive(f.actor,f.request),/permission changed/);f.user.enabled=true;
  f.user.limits[hot]=0;assert.throws(()=>f.service.enrollStorageArchive(f.actor,f.request),/permission changed/);f.user.limits[hot]=1;
  assert.throws(()=>f.service.enrollStorageArchive(f.actor,{...f.request,sourceMachine:other}),/requires/);
  await f.service.enrollStorageArchive(f.actor,f.request);
  assert.throws(()=>f.service.enrollStorageArchive(f.actor,{...f.request,version:'b'.repeat(64)}),/cannot change/);
  assert.equal(f.archive.rows().length,1);
});

test('enrollment fails closed on missing, mismatched or unknown replicas and policy races',async t=>{
  for(const override of [{userId:'demo-user-2'},{manifestSha256:'b'.repeat(64)},{state:'UNKNOWN'},{role:'cache'},{registration:null}]){
    const f=enrollmentFixture(t);f.probeOverride=override;
    await assert.rejects(f.service.enrollStorageArchive(f.actor,f.request),/not confirmed/);assert.equal(f.archive.rows().length,0);
  }
  for(const mutate of [f=>{f.admin.role='member';},f=>{f.user.enabled=false;},f=>{f.user.limits[hot]=0;}]){
    const f=enrollmentFixture(t);f.onCheck=()=>mutate(f);
    await assert.rejects(f.service.enrollStorageArchive(f.actor,f.request));assert.equal(f.archive.rows().length,0);
  }
  const f=enrollmentFixture(t);f.onCheck=()=>{throw Error('missing original');};
  await assert.rejects(f.service.enrollStorageArchive(f.actor,f.request),/missing original/);assert.equal(f.archive.rows().length,0);
});

test('owner revocation after explicit enrollment prevents authority sealing',async t=>{
  const f=enrollmentFixture(t);await f.service.enrollStorageArchive(f.actor,f.request);f.user.enabled=false;
  await f.service.reconcileStorageArchive();
  assert.equal(f.archive.rows()[0].phase,'BLOCKED');assert.equal(f.calls.some(c=>c.op==='storage.archive.provision'),false);
});

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
  assert.deepEqual(f.calls.find(c=>c.op==='transfers.start').args.archiveLane,{schema:1,targetMachine:cold,authority:'hdd'});
  const transfer=f.service.transferSnapshotByKey(f.user.id,row.copyKey);
  assert.deepEqual(transfer.archiveLane,{schema:1,targetMachine:cold,authority:'hdd'});
  assert.equal(f.service.archiveSourceAllowed(f.user.id,cold,{dataset:'cold-copy',version:ref.version}),true);
  assert.equal(f.service.archiveSourceAllowed(f.user.id,cold,{dataset:'not-enrolled',version:ref.version}),false);
  const durable=JSON.stringify(f.archive.rows());assert.equal(durable.includes('private-grant-token'),false);assert.equal(durable.includes('x'.repeat(43)),false);
});
test('fixed archive authority is rechecked after awaiting source preparation',async t=>{
  const f=fixture(t);
  f.onCall=(_,op)=>{if(op==='transfers.source.prepare')f.service.storageArchivePolicy={enabled:true,machine:cold,authority:'changed'};};
  await f.service.reconcileStorageArchive();
  assert.equal(f.calls.some(c=>c.op==='transfers.start'),false);
  const row=f.db.prepare('SELECT data FROM transfers').get();
  assert.equal(JSON.parse(row.data).archiveLane.authority,'hdd');
});
test('public copy cannot claim internal archive admission or upload to cold store',async t=>{
  const f=fixture(t),request={key:randomUUID(),kind:'copy',from:hot,machine:cold,...ref,name:'mine'};
  await assert.rejects(f.service.transferCall(f.principal,'transfers.create',request),e=>e.status===403);
  await assert.rejects(f.service.transferCall(f.principal,'transfers.create',{...request,managedArchive:1}));
  await assert.rejects(f.service.transferCall(f.principal,'transfers.create',{...request,archiveLane:{schema:1,targetMachine:cold,authority:'hdd'}}));
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
test('legacy managed copies without a durable lane are not silently relabelled on retry',async t=>{
  const f=fixture(t);await f.service.reconcileStorageArchive();const row=f.archive.rows()[0];
  f.transfers.get(row.transferId).state='PAUSED';await f.service.reconcileStorageArchive();
  const durable=f.db.prepare('SELECT data FROM transfers WHERE id=?').get(row.transferId),data=JSON.parse(durable.data);
  delete data.archiveLane;f.db.prepare('UPDATE transfers SET data=? WHERE id=?').run(JSON.stringify(data),row.transferId);
  f.service.retryStorageArchive(f.user.id,hot,ref);await f.service.reconcileStorageArchive();
  assert.equal(f.calls.some(c=>c.op==='transfers.resume'),false);
  assert.equal(f.transfers.size,1);assert.equal(f.transfers.get(row.transferId).state,'PAUSED');
  assert.equal(Object.hasOwn(JSON.parse(f.db.prepare('SELECT data FROM transfers WHERE id=?').get(row.transferId).data),'archiveLane'),false);
});
async function legacyStopped(f,state='FAILED'){
  await f.service.reconcileStorageArchive();const row=f.archive.rows()[0];
  f.transfers.get(row.transferId).state=state;await f.service.reconcileStorageArchive();
  const data=JSON.parse(f.db.prepare('SELECT data FROM transfers WHERE id=?').get(row.transferId).data);
  delete data.archiveLane;
  const payload={kind:data.kind,machine:data.machine,reference:data.reference,from:data.from,timeoutSec:data.timeoutSec,name:data.name,managedArchive:1};
  const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  f.db.prepare('UPDATE transfers SET data=?,digest=? WHERE id=?').run(JSON.stringify(data),digest,row.transferId);
  return {...row,legacyDigest:digest};
}
test('authentic legacy ordinary admission resumes the same ID and converges without relabelling',async t=>{
  for(const stopped of ['FAILED','PAUSED']){
    const f=fixture(t),before=await legacyStopped(f,stopped),id=before.transferId;
    await assert.rejects(f.service.transferCall(f.principal,'transfers.resume',{id}),/数据集页面/);
    const count=f.calls.length;f.service.retryStorageArchive(f.user.id,hot,ref);await f.service.reconcileStorageArchive();
    const calls=f.calls.slice(count),renew=calls.find(c=>c.op==='transfers.source.prepare'),resume=calls.find(c=>c.op==='transfers.resume');
    assert.equal(renew.args.id,id);assert.equal(renew.args.renew,true);assert.equal(renew.args.hostAdmin,false);
    assert.deepEqual(resume.args,{id,userId:f.user.id,source:{id,token:'x'.repeat(43),...manifest}});
    assert.equal(f.archive.rows()[0].phase,'COPYING');assert.equal(f.transfers.size,1);
    let durable=f.db.prepare('SELECT * FROM transfers WHERE id=?').get(id);
    assert.equal(durable.digest,before.legacyDigest);assert.equal(Object.hasOwn(JSON.parse(durable.data),'archiveLane'),false);
    f.finish();await f.service.reconcileStorageArchive();
    const after=f.archive.rows()[0];assert.equal(after.phase,'ARCHIVED');assert.equal(after.eventAcknowledged,true);
    assert.equal(after.transferId,id);assert.equal(after.copyKey,before.copyKey);assert.equal(f.transfers.size,1);
    durable=f.db.prepare('SELECT * FROM transfers WHERE id=?').get(id);
    assert.equal(durable.digest,before.legacyDigest);assert.equal(JSON.parse(durable.data).sourceRelease.state,'RELEASED');
    for(const key of ['archiveLane','archiveAdmission','allowRelay'])assert.equal(Object.hasOwn(JSON.parse(durable.data),key),false);
    assert.equal(f.db.prepare('SELECT * FROM storage_archive_lane').get(),undefined);
  }
});
test('legacy resume rejects changed immutable metadata, missing lease, or new-schema digest',async t=>{
  for(const mutate of [d=>d.reference.version='d'.repeat(64),d=>d.from=other,d=>d.machine=other,d=>d.name='changed',
    d=>d.sourceTicket.id=randomUUID(),d=>d.sourceTicket.token='bad',d=>d.sourceRelease.state='RELEASED',
    d=>d.owner.id='demo-user-2',d=>d.allowRelay=true,d=>d.archiveLane=null]){
    const f=fixture(t),row=await legacyStopped(f);
    const data=JSON.parse(f.db.prepare('SELECT data FROM transfers WHERE id=?').get(row.transferId).data);mutate(data);
    f.db.prepare('UPDATE transfers SET data=? WHERE id=?').run(JSON.stringify(data),row.transferId);
    f.service.retryStorageArchive(f.user.id,hot,ref);await f.service.reconcileStorageArchive();
    assert.equal(f.calls.some(c=>c.op==='transfers.resume'),false);assert.equal(f.transfers.size,1);
  }
});
test('legacy resume rechecks fixed intent, account, source identity and cancellation after renewal',async t=>{
  for(const mutate of [f=>f.user.limits[hot]=0,f=>f.service.storageArchivePolicy={enabled:true,machine:cold,authority:'changed'},
    f=>{const row=f.db.prepare('SELECT * FROM transfers').get(),data=JSON.parse(row.data);data.cancelRequested=true;f.db.prepare('UPDATE transfers SET data=? WHERE id=?').run(JSON.stringify(data),row.id);},
    f=>{f.service.archiveIntentAllowed=()=>false;},
    f=>{const row=f.db.prepare('SELECT * FROM transfers').get(),data=JSON.parse(row.data);data.sourceTicket.entries++;f.db.prepare('UPDATE transfers SET data=? WHERE id=?').run(JSON.stringify(data),row.id);}]){
    const f=fixture(t),row=await legacyStopped(f);f.service.retryStorageArchive(f.user.id,hot,ref);
    f.onCall=(_,op)=>{if(op==='transfers.source.prepare')mutate(f);};
    await f.service.reconcileStorageArchive();
    assert.equal(f.calls.some(c=>c.op==='transfers.resume'),false);assert.equal(f.transfers.get(row.transferId).state,'FAILED');
    assert.equal(f.calls.some(c=>c.op==='storage.archive.certify'),false);
  }
});
test('legacy resume never restarts an unknown or canceled node or trusts a changed source reply',async t=>{
  for(const state of ['UNKNOWN','CANCELED']){
    const f=fixture(t),row=await legacyStopped(f);f.service.retryStorageArchive(f.user.id,hot,ref);
    f.transfers.get(row.transferId).state=state;await f.service.reconcileStorageArchive();
    assert.equal(f.calls.some(c=>c.op==='transfers.resume'),false);assert.equal(f.calls.filter(c=>c.op==='transfers.source.prepare').length,1);
  }
  for(const field of ['id','manifestSha256','entries','totalBytes']){
    const f=fixture(t),row=await legacyStopped(f);f.service.retryStorageArchive(f.user.id,hot,ref);
    const bridge=f.service.bridge;f.service.bridge=async(...request)=>{const result=await bridge(...request);if(request[1]==='transfers.source.prepare')result[field]=field==='id'?randomUUID():field==='manifestSha256'?'d'.repeat(64):result[field]+1;return result;};
    await f.service.reconcileStorageArchive();assert.equal(f.calls.some(c=>c.op==='transfers.resume'),false);
    assert.equal(f.transfers.get(row.transferId).state,'FAILED');
  }
});
test('legacy ambiguous cancellation converges through original cancel/status without replay',async t=>{
  const f=fixture(t),before=await legacyStopped(f),id=before.transferId;
  const data=JSON.parse(f.db.prepare('SELECT data FROM transfers WHERE id=?').get(id).data);data.cancelRequested=true;
  f.db.prepare('UPDATE transfers SET data=?,state=? WHERE id=?').run(JSON.stringify(data),'UNKNOWN',id);
  f.service.retryStorageArchive(f.user.id,hot,ref);await f.service.reconcileStorageArchive();
  const row=f.archive.rows()[0];assert.equal(row.phase,'FAILED');assert.equal(row.transferState,'CANCELED');
  assert.equal(row.transferId,id);assert.equal(row.copyKey,before.copyKey);assert.equal(f.transfers.size,1);
  assert.equal(f.calls.some(c=>c.op==='transfers.resume'),false);assert.equal(f.calls.filter(c=>c.op==='transfers.start').length,1);
  assert.equal(f.service.transferSnapshot(f.user.id,id).sourceRelease.state,'RELEASED');
  assert.throws(()=>f.service.retryStorageArchive(f.user.id,hot,ref),/永久取消/);
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
