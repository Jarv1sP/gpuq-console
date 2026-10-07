import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installStorageArchive} from '../storage-archive.mjs';
import {MACHINES} from '../dist/model.js';

// Use the public sample inventory; production's 3090 -> 5090 cutover has the
// same immutable machine identity boundary without importing private config.
const [hot,oldSource,other,newSource]=MACHINES.map(m=>m.id);
const version='a'.repeat(64),nextVersion='b'.repeat(64);
function fixture(t){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE transfers (state TEXT, data TEXT)');
  const user={id:'demo-user-1',username:'alice',role:'member',enabled:true,limits:Object.fromEntries(MACHINES.map(m=>[m.id,1]))};
  const stranger={...user,id:'demo-user-2',username:'bob'};
  const admin={...user,id:'demo-user-99',username:'admin',role:'admin'};
  const f={db,user,stranger,admin,calls:[],maintenance:[],events:[],now:1000};
  const service=f.service={db,store:{get:id=>structuredClone([user,stranger,admin].find(u=>u.id===id)),users:[user,stranger,admin]},
    audit:()=>{},transferSnapshotByKey:()=>null,
    assertMaintenanceAllowed:(_op,args)=>f.maintenance.push(args),
    bridge:async(machine,op,args)=>{
      f.calls.push({machine,op,args});await f.onCall?.(machine,op,args);
      if(op==='storage.archive.events')return {events:machine===hot?f.events:[]};
      if(op==='storage.archive.retire'){
        if(args.mode==='authority-target-v1')return {protocol:1,state:'REVOKED',opId:args.opId,userId:args.userId,
          grantId:args.grantId,sourceMachine:oldSource,targetMachine:f.old.machine,
          source:{dataset:f.old.sourceDataset,version:f.old.version},target:{dataset:f.old.dataset,version:f.old.version},proofSha256:'e'.repeat(64),...f.proofOverride};
        if(args.mode==='authority-source-v1')return {protocol:1,state:'RETIRED',opId:args.opId,userId:args.userId,grantId:args.grantId,
          source:{dataset:f.old.sourceDataset,version:f.old.version},unregister:{operationId:'f'.repeat(64),state:'UNREGISTERED',unregistered:true,recoveryId:'unregister-'+'2'.repeat(32)}};
        return {protocol:1,state:'RETIRED',id:args.id,userId:args.userId,dataset:args.dataset,version:args.version,
          recoveryId:args.recoveryId,...(args.mode==='queued-ingest-v1'?{sourceRetired:true}:{neverDispatched:true}),proofSha256:'f'.repeat(64)};
      }
      throw Error('Unexpected dispatch after cutover: '+op);
    },archiveTransferCall:async()=>{assert.fail('Old intent must not dispatch a transfer');}};
  f.install=(machine=oldSource,authority='hdd',enabled=true)=>f.archive=installStorageArchive(service,{enabled,machine,authority},{clock:()=>f.now,startTimer:false});
  f.install();f.actor={userId:admin.id,username:admin.username,role:'admin'};
  f.save=row=>db.prepare('UPDATE storage_archives SET data=? WHERE id=?').run(JSON.stringify(row),row.id);
  f.raw=id=>db.prepare('SELECT data FROM storage_archives WHERE id=?').get(id).data;
  f.seed=(machine,dataset,v=version,{sourceDataset='warehouse-'+dataset,logicalDataset=dataset,owner=user.id,archived=true}={})=>{
    const row=f.archive.enqueueEvent(machine,{id:randomUUID(),userId:owner,dataset,version:v,state:'READY'});
    if(archived)Object.assign(row,{phase:'ARCHIVED',sourceDataset,logicalDataset,grantId:randomUUID(),receiptSha256:'c'.repeat(64),eventAcknowledged:true});
    f.save(row);return row;
  };
  f.authority=()=>{
    f.old=f.seed(hot,'old-ref');f.replacement=f.seed(other,'replacement',nextVersion);
    f.request={machine:hot,dataset:f.old.dataset,version:f.old.version,ownerId:user.id,key:randomUUID(),
      recoveryId:'unregister-'+'1'.repeat(32),replacement:{machine:other,dataset:f.replacement.dataset,version:f.replacement.version}};
  };
  t.after(()=>{service.closing=true;db.close();});return f;
}

test('cutover retains exact historical source visibility without rewriting its journal',async t=>{
  const f=fixture(t),old=f.seed(hot,'old-ref'),raw=f.raw(old.id);f.install(newSource);
  assert.deepEqual(f.service.archiveState(f.user.id,hot,old),{dataset:old.dataset,version,phase:'ARCHIVED',archiveMachine:oldSource,localMachine:hot,originalRetained:true});
  assert.equal(f.service.archiveMachineVisible(f.user.id,oldSource),true);
  assert.equal(f.service.archiveSourceAllowed(f.user.id,oldSource,{dataset:old.sourceDataset,version}),true);
  for(const [owner,machine,ref] of [[f.stranger.id,oldSource,{dataset:old.sourceDataset,version}],
    [f.user.id,newSource,{dataset:old.sourceDataset,version}],[f.user.id,oldSource,{dataset:old.sourceDataset,version:nextVersion}],
    [f.user.id,oldSource,{dataset:'not-enrolled',version}]])assert.equal(f.service.archiveSourceAllowed(owner,machine,ref),false);
  assert.equal(f.service.archiveMachineVisible(f.stranger.id,oldSource),false);
  await f.service.reconcileStorageArchive();assert.equal(f.raw(old.id),raw);
  assert.equal(f.calls.every(call=>call.op==='storage.archive.events'),true);
});

test('history requires canonical policy, known machines and unchanged authority; disabled policy grants no source',t=>{
  for(const change of [row=>{row.policyKey='0'.repeat(64);},row=>{row.sourceMachine='unknown';},row=>{row.machine='unknown';}]){
    const f=fixture(t),old=f.seed(hot,'old-ref');change(old);f.save(old);f.install(newSource);
    assert.equal(f.service.archiveSourceAllowed(f.user.id,oldSource,{dataset:old.sourceDataset,version}),false);
    assert.equal(f.service.archiveState(f.user.id,old.machine,old).originalRetained,false);
  }
  for(const args of [[newSource,'different-authority'],[newSource,'hdd',false]]){
    const f=fixture(t),old=f.seed(hot,'old-ref');f.install(...args);
    assert.equal(f.service.archiveMachineVisible(f.user.id,oldSource),false);
    assert.equal(f.service.archiveSourceAllowed(f.user.id,oldSource,{dataset:old.sourceDataset,version}),false);
  }
});

test('source-scoped aliases isolate identical physical names and versions across the cutover',t=>{
  const f=fixture(t);f.seed(hot,'old-ref',version,{sourceDataset:'same-source',logicalDataset:'old-logical'});f.install(newSource);
  f.seed(other,'new-ref',version,{sourceDataset:'same-source',logicalDataset:'new-logical'});
  const alias='same-source@'+version;
  assert.equal(f.service.archiveAliases(f.user.id,oldSource).get(alias),'old-logical');
  assert.equal(f.service.archiveAliases(f.user.id,newSource).get(alias),'new-logical');
  assert.equal(f.service.archiveAliases(f.user.id).get(alias),'new-logical');
  assert.equal(f.service.archiveAliases(f.stranger.id,oldSource).size,0);
});

test('new registrations and replica certification cannot adopt an old-policy warehouse source',t=>{
  const f=fixture(t),old=f.seed(hot,'old-ref');f.install(newSource);
  assert.equal(f.service.enqueueArchiveReplica(f.user.id,other,old,{dataset:'replica',version}),null);
  const row=f.archive.enqueueEvent(hot,{id:randomUUID(),userId:f.user.id,dataset:old.dataset,version,state:'READY'});
  assert.equal(row.sourceMachine,newSource);assert.equal(row.sourceDataset,null);assert.equal(row.phase,'QUEUED');
  assert.notEqual(row.policyKey,old.policyKey);assert.equal(f.calls.length,0);
});

test('old pending intent cannot retry or advance, and reconciliation preserves its bytes and unknown lane',async t=>{
  for(const held of [false,true]){
    const f=fixture(t),row=f.seed(hot,'pending',version,{archived:false});row.phase='COPYING';f.save(row);
    if(held)f.db.prepare('INSERT INTO storage_archive_lane VALUES(1,?)').run(row.id);
    const raw=f.raw(row.id);f.install(newSource);
    assert.throws(()=>f.service.retryStorageArchive(f.user.id,hot,row),/policy changed/);
    await assert.rejects(f.archive.advance(f.archive.load(row.id)),/policy changed/);
    assert.equal(f.calls.length,0);await f.service.reconcileStorageArchive();assert.equal(f.raw(row.id),raw);
    assert.equal(f.calls.every(call=>call.op==='storage.archive.events'),true);
    assert.equal(f.db.prepare('SELECT archive_id FROM storage_archive_lane').get()?.archive_id,held?row.id:undefined);
  }
});

test('an unheld historical pending intent cannot starve new-policy dispatch, while an unknown old lane still fences it',async t=>{
  for(const held of [false,true]){
    const f=fixture(t),old=f.seed(hot,'old-pending',version,{archived:false}),raw=f.raw(old.id);
    if(held)f.db.prepare('INSERT INTO storage_archive_lane VALUES(1,?)').run(old.id);
    f.install(newSource);const current=f.seed(hot,'current-pending',nextVersion,{archived:false}),copies=[];
    f.service.archiveTransferCall=async(principal,args)=>{copies.push({principal,args});return {id:randomUUID(),state:'RUNNING'};};
    await f.service.reconcileStorageArchive();assert.equal(f.raw(old.id),raw);assert.equal(copies.length,held?0:1);
    if(!held){assert.equal(copies[0].args.machine,newSource);assert.equal(copies[0].args.key,current.copyKey);}
    assert.equal(f.db.prepare('SELECT archive_id FROM storage_archive_lane').get()?.archive_id,held?old.id:current.id);
  }
});

test('historical same-source authority retirement routes proof and source RPC to its immutable old machine',async t=>{
  const f=fixture(t);f.authority();f.install(newSource);
  const result=await f.service.retireStorageAuthority(f.actor,f.request);
  assert.equal(result.archiveMachine,oldSource);assert.equal(result.phase,'FAILED');assert.equal(result.originalRetained,false);
  assert.deepEqual(f.calls.map(call=>[call.machine,call.args.mode]),[[hot,'authority-target-v1'],[oldSource,'authority-source-v1']]);
  assert.equal(f.maintenance.every(args=>args.from===oldSource),true);
  const calls=f.calls.length;assert.deepEqual(await f.service.retireStorageAuthority(f.actor,f.request),result);assert.equal(f.calls.length,calls);
});

test('cross-source replacement and account/source overrides are rejected before any RPC',t=>{
  const f=fixture(t);f.authority();f.install(newSource);
  const newer=f.seed(other,'new-replacement',nextVersion);
  assert.throws(()=>f.service.retireStorageAuthority(f.actor,{...f.request,replacement:{machine:other,dataset:newer.dataset,version:newer.version}}),/Cross-authority/);
  assert.throws(()=>f.service.retireStorageAuthority(f.actor,{...f.request,sourceMachine:newSource}),/exact removed reference/);
  assert.throws(()=>f.service.retireStorageAuthority(f.actor,{...f.request,ownerId:f.stranger.id}),/Exact archived authority/);
  assert.throws(()=>f.service.retireStorageAuthority({userId:f.user.id,username:f.user.username,role:'member'},f.request),/administrator/);
  assert.equal(f.calls.length,0);
});

test('historical retirement retains protection on journal write failure before fencing RPC',async t=>{
  const f=fixture(t);f.authority();f.install(newSource);const raw=f.raw(f.old.id);
  f.db.exec("CREATE TRIGGER reject_archive_update BEFORE UPDATE ON storage_archives BEGIN SELECT RAISE(ABORT,'journal write failed'); END");
  await assert.rejects(f.service.retireStorageAuthority(f.actor,f.request),/journal write failed/);
  assert.equal(f.calls.length,0);assert.equal(f.raw(f.old.id),raw);
  assert.equal(f.service.archiveSourceAllowed(f.user.id,oldSource,{dataset:f.old.sourceDataset,version}),true);
});

test('failed REVOKING journal write cannot issue source retirement; failed terminal write remains visibly fenced',async t=>{
  for(const stage of ['REVOKING','FAILED']){
    const f=fixture(t);f.authority();f.install(newSource);
    f.db.exec(`CREATE TRIGGER reject_archive_update BEFORE UPDATE ON storage_archives
      WHEN json_extract(NEW.data,'${stage==='REVOKING'?'$.retirementIntent.state':'$.phase'}')='${stage}'
      BEGIN SELECT RAISE(ABORT,'journal write failed'); END`);
    await assert.rejects(f.service.retireStorageAuthority(f.actor,f.request),/journal write failed/);
    assert.equal(f.calls.filter(call=>call.args.mode==='authority-source-v1').length,stage==='REVOKING'?0:1);
    const row=f.archive.load(f.old.id);assert.equal(row.phase,'ARCHIVED');assert.ok(row.retirementIntent);
    assert.equal(f.service.archiveState(f.user.id,hot,row).originalRetained,false);
    const raw=f.raw(row.id);f.install(newSource);f.calls=[];await f.service.reconcileStorageArchive();
    assert.equal(f.raw(row.id),raw);assert.equal(f.calls.every(call=>call.op==='storage.archive.events'),true);
  }
});

test('historical authority retirement rejects old proof source drift and immutable row drift before source RPC',async t=>{
  for(const change of [f=>{f.proofOverride={sourceMachine:newSource};},f=>{f.onCall=()=>{
    const row=f.archive.load(f.old.id);row.sourceMachine=newSource;f.save(row);
  };}]){
    const f=fixture(t);f.authority();f.install(newSource);change(f);
    await assert.rejects(f.service.retireStorageAuthority(f.actor,f.request),/not confirmed|identity changed/);
    assert.equal(f.calls.some(call=>call.args.mode==='authority-source-v1'),false);
  }
});

test('lost historical target receipt survives restart without background RPC, then explicit retry uses the same machine and IDs',async t=>{
  const f=fixture(t);f.authority();f.install(newSource);f.onCall=()=>{throw Error('lost target receipt');};
  await assert.rejects(f.service.retireStorageAuthority(f.actor,f.request),/lost target receipt/);
  const pending=f.raw(f.old.id);assert.equal(f.archive.load(f.old.id).retirementIntent.state,'FENCING');
  f.onCall=null;f.calls=[];f.install(newSource);await f.service.reconcileStorageArchive();assert.equal(f.raw(f.old.id),pending);
  assert.equal(f.calls.every(call=>call.op==='storage.archive.events'),true);f.calls=[];
  assert.throws(()=>f.service.retireStorageAuthority(f.actor,{...f.request,key:randomUUID()}),/identity/);assert.equal(f.calls.length,0);
  await f.service.retireStorageAuthority(f.actor,f.request);
  assert.deepEqual(f.calls.map(call=>call.machine),[hot,oldSource]);
  assert.equal(f.calls.every(call=>call.args.opId===f.request.key),true);
});

test('historical queued and same-HDD retirement retain exact original event and normal receipt semantics',async t=>{
  for(const machine of [hot,oldSource]){
    const f=fixture(t),row=f.seed(machine,'unregistered',version,{archived:false});f.install(newSource);
    const args={machine,dataset:row.dataset,version,ownerId:f.user.id,eventId:row.eventId,recoveryId:'unregister-'+'1'.repeat(32)};
    assert.throws(()=>f.service.retireStorageArchive(f.actor,{...args,ownerId:f.stranger.id}),/Only a never-dispatched/);
    assert.throws(()=>f.service.retireStorageArchive(f.actor,{...args,eventId:randomUUID()}),/Only a never-dispatched/);
    assert.equal(f.calls.length,0);const result=await f.service.retireStorageArchive(f.actor,args);
    assert.equal(result.phase,'FAILED');assert.equal(result.archiveMachine,oldSource);assert.equal(f.calls[0].machine,machine);
    assert.equal(f.calls[0].args.mode,machine===hot?'queued-ingest-v1':undefined);
    assert.equal(f.maintenance.every(value=>value.from===oldSource),true);
    const calls=f.calls.length;assert.deepEqual(await f.service.retireStorageArchive(f.actor,args),result);assert.equal(f.calls.length,calls);
  }
});

test('historical queued retirement write failure and lost receipt never permit background dispatch',async t=>{
  const failed=fixture(t),row=failed.seed(hot,'write-failure',version,{archived:false});failed.install(newSource);
  const args={machine:hot,dataset:row.dataset,version,ownerId:failed.user.id,eventId:row.eventId,recoveryId:'unregister-'+'1'.repeat(32)};
  failed.db.exec("CREATE TRIGGER reject_archive_update BEFORE UPDATE ON storage_archives BEGIN SELECT RAISE(ABORT,'journal write failed'); END");
  await assert.rejects(failed.service.retireStorageArchive(failed.actor,args),/journal write failed/);assert.equal(failed.calls.length,0);
  const f=fixture(t),queued=f.seed(hot,'lost-receipt',version,{archived:false});f.install(newSource);
  const request={...args,dataset:queued.dataset,eventId:queued.eventId};f.onCall=()=>{throw Error('lost receipt');};
  await assert.rejects(f.service.retireStorageArchive(f.actor,request),/lost receipt/);const pending=f.raw(queued.id);
  f.onCall=null;f.calls=[];f.install(newSource);await f.service.reconcileStorageArchive();assert.equal(f.raw(queued.id),pending);
  assert.equal(f.calls.every(call=>call.op==='storage.archive.events'),true);f.calls=[];
  await f.service.retireStorageArchive(f.actor,request);assert.deepEqual(f.calls.map(call=>call.machine),[hot]);
});
