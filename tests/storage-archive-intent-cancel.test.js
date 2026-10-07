import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture as deletionFixture,hosts,version,principal,admin,writes} from './dataset-deletion-fixture.mjs';
import {installStorageArchive} from '../storage-archive.mjs';
import {installTransfers} from '../transfers.mjs';
import {installMaintenance,maintenanceCall} from '../maintenance.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
function fixture(t){
  const f=deletionFixture(t),service=f.service;
  installTransfers(service);clearInterval(service.transferTimer);
  f.archive=installStorageArchive(service,{enabled:true,machine:hosts[1],authority:'hdd'},{startTimer:false});
  f.event={id:randomUUID(),userId:principal.userId,dataset:'personal',version,state:'READY'};
  f.row=f.archive.enqueueEvent(hosts[0],f.event);f.row.phase='BLOCKED';f.row.failures=1;
  f.save=()=>service.db.prepare('UPDATE storage_archives SET data=? WHERE id=?').run(JSON.stringify(f.row),f.row.id);
  f.save();
  f.args=()=>({archiveId:f.row.id,revision:sha(service.db.prepare('SELECT data FROM storage_archives WHERE id=?').get(f.row.id).data)});
  f.cancel=(args=f.args(),actor=admin)=>service.cancelStorageArchiveIntent(actor,args);
  f.transfer=({key=randomUUID(),state='RUNNING',kind='copy',released=false,related=true}={})=>{
    const data={kind,machine:hosts[1],...(kind==='copy'?{from:hosts[0]}:{}),
      reference:{kind:'datasets',dataset:related?'personal':'unrelated',version},
      ...(kind==='copy'?{sourceRelease:{protocol:1,state:released?'RELEASED':'HELD'}}:{}),
      ...(kind==='download'?{downloadProtection:{protocol:1,state:released?'RELEASED':'HELD'}}:{})};
    service.db.prepare('INSERT INTO transfers(id,owner_id,client_key,digest,state,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(),principal.userId,key,'a'.repeat(64),state,1,1,JSON.stringify(data));
  };
  return f;
}

test('blocked intent cancellation is control-only, audited, exact-ID idempotent and survives a lost reply/restart',async t=>{
  const f=fixture(t),args=f.args(),before=structuredClone(f.row);
  // Authorization loss caused the actual BLOCKED class; no owner permission
  // is needed to stop an undispatched request. Only the current admin acts.
  f.users[0].enabled=false;f.users[0].limits[hosts[0]]=0;
  f.service.db.prepare('INSERT INTO storage_archive_lane VALUES(1,?)').run('e'.repeat(64));
  const result=f.cancel(args);
  assert.deepEqual(result,{archiveId:args.archiveId,state:'CANCELED',controlOnly:true,dataDeleted:false});
  const row=f.archive.load(f.row.id);
  for(const field of ['id','kind','owner','machine','dataset','version','eventId','sourceMachine','sourceDataset','copyKey','transferId','grantId','certifyId','policyKey','eventAcknowledged'])assert.deepEqual(row[field],before[field]);
  assert.equal(row.phase,'FAILED');assert.equal(row.failureStage,'retired');
  assert.equal(row.retirement.mode,'undispatched-intent-cancel-v1');assert.equal(row.retirement.revision,args.revision);
  assert.equal(row.retirement.controlOnly,true);assert.equal(row.retirement.dataDeleted,false);
  assert.match(row.retirement.proofSha256,/^[a-f0-9]{64}$/);
  assert.equal(f.service.db.prepare('SELECT archive_id FROM storage_archive_lane').get().archive_id,'e'.repeat(64));
  assert.equal(f.calls.length,0);assert.equal(f.service.db.prepare('SELECT count(*) n FROM transfers').get().n,0);
  assert.equal(f.audits.length,1);assert.equal(f.audits[0][1],'datasets.archive.cancel-intent');
  assert.equal(JSON.parse(f.audits[0][3]).copyNeverAdmitted,true);
  // Ignore the first response, then reinstall the orchestrator over SQLite.
  f.archive=installStorageArchive(f.service,{enabled:true,machine:hosts[1],authority:'hdd'},{startTimer:false});
  assert.deepEqual(f.cancel(args),result);assert.equal(f.audits.length,1);
  assert.throws(()=>f.cancel({...args,revision:'f'.repeat(64)}),/journal changed/);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM storage_archives').get().n,1);
  f.users[0].enabled=true;f.users[0].limits[hosts[0]]=1;
  assert.throws(()=>f.service.retryStorageArchive(principal.userId,hosts[0],f.event),/注销|退役/);
  assert.equal(f.archive.enqueueEvent(hosts[0],f.event).retirement.mode,'undispatched-intent-cancel-v1');
  await assert.rejects(f.archive.advance({...before,phase:'QUEUED',nextCheckAt:0}),/retirement fences/);
  assert.equal(f.calls.length,0,'a stale in-memory worker never dispatches after the durable tombstone');
});

test('only current administrators and the full persisted raw-row revision may cancel',t=>{
  const f=fixture(t),args=f.args();
  for(const [actor,input] of [[principal,args],[{...admin,role:'member'},args],[{...admin,username:'spoof'},args],
    [admin,{...args,ownerId:principal.userId}],[admin,{...args,revision:'a'.repeat(64)}],[admin,{...args,archiveId:'b'.repeat(64)}]])
    assert.throws(()=>f.cancel(input,actor));
  f.users[1].role='member';assert.throws(()=>f.cancel(args),/administrator/);f.users[1].role='admin';
  f.users[1].enabled=false;assert.throws(()=>f.cancel(args),/administrator/);f.users[1].enabled=true;
  f.row.nextCheckAt++;f.save();assert.throws(()=>f.cancel(args),/journal changed/);
  assert.equal(f.archive.load(f.row.id).phase,'BLOCKED');assert.equal(f.audits.length,0);assert.equal(f.calls.length,0);
});

test('queued, running, unknown, acknowledged, retrying and granted archive intents are not reclassified',t=>{
  const changes=[{phase:'QUEUED'},{phase:'COPYING'},{phase:'UNKNOWN'},{eventAcknowledged:true},{retryRequested:true},
    {sourceDataset:'hdd-copy'},{grantId:randomUUID()},{transferId:randomUUID()},{failureStage:'copy'},
    {retirementIntent:{state:'UNKNOWN'}},{receiptSha256:'c'.repeat(64)},{transferState:'UNKNOWN'},
    {sourceDataset:undefined},{sourceMachine:'unknown-node'},{kind:'enrollment'},{certifyId:'unknown'}];
  for(const change of changes){const f=fixture(t);Object.assign(f.row,change);f.save();assert.throws(()=>f.cancel(),/confirmed|undispatched/);assert.equal(f.audits.length,0);}
});

test('durable lane ownership, any matching copy admission and unknown/active protection prevent cancellation',t=>{
  for(const state of ['DISPATCHING','UNKNOWN','RUNNING','SUCCEEDED','CANCELED','FAILED']){
    const f=fixture(t);f.transfer({key:f.row.copyKey,state,released:true});assert.throws(()=>f.cancel(),/durable transfer admission/);
  }
  const lane=fixture(t);lane.service.db.prepare('INSERT INTO storage_archive_lane VALUES(1,?)').run(lane.row.id);
  assert.throws(()=>lane.cancel(),/undispatched/);
  for(const options of [{state:'RUNNING'},{state:'SUCCEEDED'},{kind:'download',state:'CANCELED'},
    {kind:'copy',state:'UNKNOWN',released:true}]){const f=fixture(t);f.transfer(options);assert.throws(()=>f.cancel(),/protection/);}
  const unknown=fixture(t);unknown.service.db.prepare('DROP TABLE transfers').run();assert.throws(()=>unknown.cancel(),/admission.*confirmed/);
  const malformed=fixture(t);malformed.transfer({related:false});malformed.service.db.prepare("UPDATE transfers SET data='{}'").run();
  assert.throws(()=>malformed.cancel(),/Unknown transfer/);
  const stopped=fixture(t);stopped.transfer({state:'SUCCEEDED',released:true});stopped.transfer({related:false});
  assert.equal(stopped.cancel().state,'CANCELED','unrelated active work is preserved; a released independent transfer is not this intent');
});

test('replica and other archive dependencies are retained; failed audit rolls back the permanent fence',t=>{
  const f=fixture(t);
  f.service.db.exec('CREATE TABLE dataset_copies(id TEXT PRIMARY KEY,owner TEXT,target TEXT,data TEXT)');
  const copy={id:'d'.repeat(64),owner:principal.userId,dataset:'personal',version,source:hosts[0],sourceDataset:'personal',target:hosts[1]};
  f.service.db.prepare('INSERT INTO dataset_copies VALUES(?,?,?,?)').run(copy.id,copy.owner,copy.target,JSON.stringify(copy));
  assert.throws(()=>f.cancel(),/replica depends/);f.service.db.prepare('DELETE FROM dataset_copies').run();
  const another=f.archive.enqueueEvent(hosts[2],{...f.event,id:randomUUID()});
  assert.throws(()=>f.cancel(),/Another archive/);
  another.failureStage='retired';another.phase='FAILED';
  f.service.db.prepare('UPDATE storage_archives SET data=? WHERE id=?').run(JSON.stringify(another),another.id);
  const before=f.service.db.prepare('SELECT data FROM storage_archives WHERE id=?').get(f.row.id).data;
  f.auditFailure=true;assert.throws(()=>f.cancel(),/audit full/);
  assert.equal(f.service.db.prepare('SELECT data FROM storage_archives WHERE id=?').get(f.row.id).data,before);
  f.auditFailure=false;assert.equal(f.cancel().state,'CANCELED');assert.equal(f.calls.length,0);
});

test('an authorization change during audit rolls back cancellation instead of reporting success',t=>{
  const f=fixture(t),before=f.service.db.prepare('SELECT data FROM storage_archives WHERE id=?').get(f.row.id).data;
  f.service.audit=()=>{f.users[1].enabled=false;};
  assert.throws(()=>f.cancel(),/authorization changed/);
  assert.equal(f.service.db.prepare('SELECT data FROM storage_archives WHERE id=?').get(f.row.id).data,before);
  assert.equal(f.calls.length,0);
});

test('a worker already awaiting copy preparation retains its lane and cannot be canceled',async t=>{
  const f=fixture(t);f.row.phase='QUEUED';f.save();
  let entered,release;const waiting=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const original=f.service.archiveTransferCall;
  f.service.archiveTransferCall=async(...args)=>{entered();await gate;return original(...args);};
  // advance persists lane/COPYING before it awaits the adapter. Simulate a
  // permission BLOCKED marker while the old request remains in flight.
  const worker=f.archive.advance(structuredClone(f.row));await waiting;
  f.row=f.archive.load(f.row.id);f.row.phase='BLOCKED';f.save();
  assert.throws(()=>f.cancel(),/undispatched/);
  f.users[0].enabled=false;release();await assert.rejects(worker,/changed|暂停|授权已改变/);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM transfers').get().n,0);
  assert.equal(f.archive.load(f.row.id).retirement,undefined);
});

test('cancellation fences a previously queued copy adapter before it can create its durable transfer',async t=>{
  const f=fixture(t),args=f.args();
  const pending=f.service.archiveTransferCall(principal,{key:f.row.copyKey,kind:'copy',from:hosts[0],machine:hosts[1],
    dataset:'personal',version,name:'archive-'+createHash('sha256').update(JSON.stringify([principal.userId,hosts[0],'personal'])).digest('hex').slice(0,24)});
  // transferCall's keyed promise has not entered admission yet. Cancellation
  // commits synchronously; the deferred callback must reread the tombstone.
  assert.equal(f.cancel(args).state,'CANCELED');
  await assert.rejects(pending,/归档发布意图已改变/);
  assert.equal(f.calls.length,0);assert.equal(f.service.db.prepare('SELECT count(*) n FROM transfers').get().n,0);
});

test('lane admission rereads the durable cancellation even if the old worker already read a pre-cancel fence',async t=>{
  const f=fixture(t),args=f.args(),stale={...f.row,phase:'QUEUED',nextCheckAt:0};
  const prepare=f.service.db.prepare.bind(f.service.db);let switched=false;
  f.service.db.prepare=sql=>{
    const statement=prepare(sql);
    if(sql!=='SELECT data FROM storage_archives WHERE id=?')return statement;
    return {get:id=>{
      const old=statement.get(id);
      // Emulate another connection committing while a worker is paused just
      // after its first durable read. The worker receives the OLD read value.
      if(!switched&&id===f.row.id){switched=true;assert.equal(f.cancel(args).state,'CANCELED');}
      return old;
    }};
  };
  try{await assert.rejects(f.archive.advance(stale),/retirement fences/);}
  finally{f.service.db.prepare=prepare;}
  assert.equal(switched,true);assert.equal(f.archive.load(f.row.id).failureStage,'retired');
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM storage_archive_lane').get().n,0);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM transfers').get().n,0);assert.equal(f.calls.length,0);
});

test('cancel is allowed during global maintenance without allowing any archive dispatch or removing maintenance',async t=>{
  const f=fixture(t);installMaintenance(f.service);clearInterval(f.service.maintenanceTimer);
  await maintenanceCall(f.service,admin,'maintenance.set',{scope:'all',enabled:true,reason:'storage repair',revision:0});
  const before=f.service.operationalMaintenance(admin);
  assert.equal(f.cancel().state,'CANCELED');assert.deepEqual(f.service.operationalMaintenance(admin),before);
  assert.throws(()=>f.service.assertMaintenanceAllowed('storage.archive.advance',{machine:hosts[0]},admin),/维护/);
  assert.equal(f.calls.length,0);
});

test('canceled control intent unblocks the normal deletion graph but never replaces physical proof or protection checks',async t=>{
  const f=fixture(t);
  const blocked=await f.start(undefined,admin);assert.equal(blocked.result.state,'BLOCKED');assert.equal(writes(f).length,0);
  f.cancel();
  const done=await f.start(undefined,admin);assert.equal(done.result.state,'DELETED');
  assert.ok(done.result.events.some(event=>event.action==='归档请求已取消（数据未删除）'));
  assert.equal(f.calls.filter(call=>call.op==='storage.dataset-delete.plan').length,hosts.length);
  assert.equal(f.calls.filter(call=>call.op==='storage.dataset-delete.fence').length,hosts.length);
  assert.equal(f.calls.filter(call=>call.op==='storage.dataset-delete.isolate').length,hosts.length);
  assert.equal([...f.nodes.values()].filter(node=>node.plan.complete).length,1);
  assert.ok(f.calls.every(call=>!call.op.startsWith('storage.archive.')));
});
