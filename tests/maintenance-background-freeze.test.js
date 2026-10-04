import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {maintenanceCall} from '../maintenance.mjs';
import {seedLegacy} from './maintenance-fixture.mjs';
import {maintainTaskNotes} from '../community.mjs';

const machine=MACHINES[0].id;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,{accelerate=false,notificationConfig=null}={}){
  const folder=await mkdtemp(join(tmpdir(),'gpuq-background-freeze-')),bootstrap=join(folder,'bootstrap'),database=join(folder,'portal.sqlite');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Fixture-maintenance-freeze-2026!'}));
  const calls=[],receipts=new Map();let service,currentNotifications=notificationConfig,intercept;
  const bridge=async(host,operation,args)=>{
    calls.push({host,operation,args});
    if(intercept)await intercept(operation,args);
    if(operation==='datasets.upload.status')return {uploadId:args.uploadId,state:'RECEIVING_MANIFEST',manifestOffset:0,checkedAt:'fresh-remote-result'};
    if(operation==='datasets.upload.pause')return {uploadId:args.uploadId,state:'FAILED',manifestOffset:0};
    if(operation==='host.status')return receipts.get(args.id)||{id:args.id,state:'UNKNOWN',stdout:'',stderr:''};
    if(operation==='transfers.confirm-source-release')throw Error('No unrequested source cleanup');
    throw Error('Unapproved fixture operation');
  };
  const open=async()=>{
    const original=globalThis.setInterval;
    // Real Node timer callback and real SQLite; only its wall-clock interval is
    // accelerated in this isolated fixture, never in production or application.
    if(accelerate)globalThis.setInterval=(fn,ms,...args)=>original(fn,[15000,5000].includes(ms)?10:ms,...args);
    try{service=await PortalService.open(database,bootstrap,undefined,bridge,currentNotifications);}finally{globalThis.setInterval=original;}
    return service;
  };
  await open();t.after(async()=>{service.close();await rm(folder,{recursive:true,force:true});});
  const user=service.store.users[0];user.limits[machine]=1;user.total=1;service.save();
  const held={version:1,revision:1,global:{reason:'second-cohort fixture maintenance',since:'2026-10-05T00:00:00.000Z'},machines:{}};
  service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify(held));
  const waiting=randomUUID(),failed=randomUUID(),uploadId=randomUUID(),sourceLease={protocol:1,state:'HELD',unknown:'preserve'};
  const insert=service.db.prepare('INSERT INTO transfers(id,owner_id,client_key,digest,state,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)');
  insert.run(waiting,user.id,randomUUID(),'existing-waiting-digest','WAITING_CLIENT',100,101,JSON.stringify({kind:'upload',machine,uploadId,result:{state:'RECEIVING_MANIFEST',manifestOffset:0,unknown:'old result'},future:{nested:['unchanged']}}));
  insert.run(failed,user.id,randomUUID(),'existing-real-copy-digest','FAILED',102,103,JSON.stringify({kind:'copy',from:MACHINES[1].id,machine,reference:{kind:'dataset',dataset:'protected-real-migration',version:'a'.repeat(64)},sourceRelease:sourceLease,sourceTicket:{id:failed,token:'fixture-private-ticket'},result:{state:'FAILED',attempt:1},future:'preserve'}));
  const rows=()=>service.db.prepare('SELECT * FROM transfers ORDER BY id').all();
  return {calls,receipts,waiting,failed,uploadId,user,rows,get service(){return service;},intercept(fn){intercept=fn;},hold(){service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify({...held,revision:3}));},clear(){const value={...held,revision:2,global:null};service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify(value));},reopen:async(options={})=>{service.close();if(Object.hasOwn(options,'notifications'))currentNotifications=options.notifications;await open();}};
}

test('global maintenance preserves real WAITING_CLIENT/FAILED data and source protections byte-for-byte across timer ticks and restart',async t=>{
  const f=await fixture(t,{accelerate:true}),before=f.rows();
  await sleep(45);assert.deepEqual(f.rows(),before);assert.deepEqual(f.calls,[]);
  await f.service.reconcileTransfers();assert.deepEqual(f.rows(),before);assert.deepEqual(f.calls,[]);
  await f.reopen();await sleep(45);assert.deepEqual(f.rows(),before);assert.deepEqual(f.calls,[]);
  assert.equal(f.service.globalMaintenanceActive(),true);
  f.clear();await sleep(45);
  assert.ok(f.calls.some(call=>call.operation==='datasets.upload.status'));
  const after=f.rows();assert.equal(after.find(row=>row.id===f.waiting).id,f.waiting);assert.equal(after.find(row=>row.id===f.waiting).state,'WAITING_CLIENT');
  assert.equal(JSON.parse(after.find(row=>row.id===f.waiting).data).result.checkedAt,'fresh-remote-result');
  assert.deepEqual(after.find(row=>row.id===f.failed),before.find(row=>row.id===f.failed));
  assert.equal(f.calls.some(call=>call.operation==='transfers.start'||call.operation==='datasets.upload.begin'||call.operation==='datasets.upload.discard'),false);
});

test('global maintenance freezes only automatic polling: explicit original owner status/cancel remain available, no discard or new upload',async t=>{
  const f=await fixture(t),principal={userId:f.user.id,username:f.user.username,role:'admin'};
  const before=f.rows();await f.service.reconcileTransfers();assert.deepEqual(f.rows(),before);assert.deepEqual(f.calls,[]);
  const status=await f.service.transferCall(principal,'transfers.status',{id:f.waiting});assert.equal(status.id,f.waiting);assert.equal(status.state,'WAITING_CLIENT');assert.equal(f.calls.at(-1).operation,'datasets.upload.status');
  const canceled=await f.service.transferCall(principal,'transfers.cancel',{id:f.waiting});assert.equal(canceled.id,f.waiting);assert.equal(canceled.state,'CANCELED');assert.equal(f.calls.at(-1).operation,'datasets.upload.pause');
  assert.deepEqual(f.rows().find(row=>row.id===f.failed),before.find(row=>row.id===f.failed));
  assert.ok(f.calls.every(call=>call.args.userId===f.user.id));assert.equal(f.calls.some(call=>['datasets.upload.begin','datasets.upload.discard','transfers.start'].includes(call.operation)),false);
});

test('corrupt persisted global maintenance fails closed before background RPC or existing row writes',async t=>{
  const f=await fixture(t),before=f.rows();f.service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run('{}');
  await assert.rejects(f.service.reconcileTransfers(),/维护状态损坏/);assert.deepEqual(f.rows(),before);assert.deepEqual(f.calls,[]);
});

test('background poll queued behind an explicit owner read rechecks a newly held global fence before dispatch',async t=>{
  const f=await fixture(t);f.clear();let release,started;
  const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
  f.intercept(async operation=>{if(operation==='datasets.upload.status'){started();await gate;}});
  const read=f.service.transferCall({userId:f.user.id,username:f.user.username,role:'admin'},'transfers.status',{id:f.waiting});await ready;
  const poll=f.service.reconcileTransfers();f.hold();release();await read;const afterExplicit=f.rows();await poll;
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'datasets.upload.status');assert.deepEqual(f.rows(),afterExplicit);
});

test('held startup and real timer preserve SENDING, expired notices and subscriptions even without config; clear resumes original durable notice once',async t=>{
  const sent=[],config={chatByUserId:{'builtin-admin':'12345'},send:async(chat,payload)=>sent.push({chat,payload})};
  const f=await fixture(t,{accelerate:true,notificationConfig:config}),jobId=randomUUID(),eventKey=createHash('sha256').update(JSON.stringify(['terminal','SUCCEEDED'])).digest('hex'),now=Date.now()/1000;
  f.service.store.jobs.push({id:jobId,userId:f.user.id,username:f.user.username,name:'existing notification fixture',machine,state:'SUCCEEDED',cards:1,spec:{argv:['true']}});f.service.save();
  f.service.db.prepare('INSERT INTO job_notification_subscriptions(job_id,user_id,enabled,generation,seen_keys) VALUES(?,?,1,7,?)').run(jobId,f.user.id,JSON.stringify([eventKey]));
  const insert=f.service.db.prepare('INSERT INTO job_notification_outbox(id,job_id,user_id,generation,event_key,payload,state,attempts,next_at,created_at,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  insert.run(41,jobId,f.user.id,7,eventKey,'original durable fixture body','SENDING',2,now-1,now-10,null);
  insert.run(42,jobId,f.user.id,7,'expired-receipt',null,'SENT',1,1,1,429);
  const rows=()=>({subscriptions:f.service.db.prepare('SELECT * FROM job_notification_subscriptions ORDER BY job_id').all(),outbox:f.service.db.prepare('SELECT * FROM job_notification_outbox ORDER BY id').all()}),before=rows();
  await f.reopen({notifications:null});await sleep(45);f.service.captureJobNotifications();await f.service.flushJobNotifications();
  assert.deepEqual(rows(),before);assert.deepEqual(sent,[]);assert.deepEqual(f.calls,[]);
  await f.reopen({notifications:config});await sleep(45);assert.deepEqual(rows(),before);assert.deepEqual(sent,[]);assert.deepEqual(f.calls,[]);
  f.clear();await sleep(55);await f.service.flushJobNotifications();
  assert.deepEqual(sent,[{chat:'12345',payload:'original durable fixture body'}]);
  assert.deepEqual(rows().subscriptions,before.subscriptions);
  const remaining=rows().outbox;assert.equal(remaining.length,1);assert.equal(remaining[0].id,41);assert.equal(remaining[0].generation,7);assert.equal(remaining[0].state,'SENT');assert.equal(remaining[0].attempts,3);assert.equal(remaining[0].payload,null);
  await f.service.flushJobNotifications();assert.equal(sent.length,1);
});

test('global maintenance pauses legacy command observation, preserving its raw data and original key until actual timer resumes',async t=>{
  const f=await fixture(t,{accelerate:true}),actor={id:f.user.id,username:f.user.username},legacy=seedLegacy(f.service,f.user,{state:'UNKNOWN',approver:actor,result:{state:'UNKNOWN',checkedAt:'original',future:'unchanged'}});
  const data=JSON.parse(f.service.db.prepare('SELECT data FROM maintenance_requests WHERE id=?').get(legacy.id).data);data.future={unknown:['keep']};f.service.db.prepare('UPDATE maintenance_requests SET data=? WHERE id=?').run(JSON.stringify(data),legacy.id);
  const rows=()=>f.service.db.prepare('SELECT * FROM maintenance_requests ORDER BY seq').all(),before=rows();
  f.receipts.set(legacy.data.executionKey,{id:legacy.data.executionKey,state:'SUCCEEDED',stdout:'original operation completed',stderr:'',exitCode:0});
  await f.reopen();await sleep(45);await f.service.reconcileMaintenance();assert.deepEqual(rows(),before);assert.deepEqual(f.calls,[]);
  f.clear();await sleep(55);
  const hostCalls=f.calls.filter(call=>call.operation==='host.status');assert.equal(hostCalls.length,1);assert.deepEqual(hostCalls[0],{host:machine,operation:'host.status',args:{id:legacy.data.executionKey,userId:actor.id,username:actor.username,hostAdmin:true}});
  const after=rows()[0];assert.equal(after.id,legacy.id);assert.equal(after.state,'SUCCEEDED');assert.equal(after.revision,before[0].revision+1);assert.deepEqual(JSON.parse(after.data).future,data.future);
  assert.equal(f.calls.some(call=>['host.exec','host.cancel'].includes(call.operation)),false);
});

test('explicit legacy status is still available during global pause and never dispatches a new command',async t=>{
  const f=await fixture(t),actor={id:f.user.id,username:f.user.username},legacy=seedLegacy(f.service,f.user,{state:'UNKNOWN',approver:actor});
  f.receipts.set(legacy.data.executionKey,{id:legacy.data.executionKey,state:'SUCCEEDED',stdout:'old result',stderr:'',exitCode:0});
  const result=await maintenanceCall(f.service,{userId:f.user.id,username:f.user.username,role:'admin'},'maintenance.get',{id:legacy.id});assert.equal(result.state,'SUCCEEDED');assert.equal(result.execution.id,legacy.data.executionKey);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'host.status');assert.equal(f.calls[0].args.id,legacy.data.executionKey);
});

test('invalid global maintenance prevents notification and legacy background writes or fake sender calls',async t=>{
  const sent=[],f=await fixture(t,{notificationConfig:{chatByUserId:{'builtin-admin':'12345'},send:async()=>sent.push('unexpected')}});
  const transferRows=f.rows(),notices=f.service.db.prepare('SELECT * FROM job_notification_outbox').all();
  f.service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run('{}');
  assert.throws(()=>f.service.captureJobNotifications(),/维护状态损坏/);await assert.rejects(f.service.flushJobNotifications(),/维护状态损坏/);await assert.rejects(f.service.reconcileMaintenance(),/维护状态损坏/);
  assert.deepEqual(f.rows(),transferRows);assert.deepEqual(f.service.db.prepare('SELECT * FROM job_notification_outbox').all(),notices);assert.deepEqual(f.calls,[]);assert.deepEqual(sent,[]);
});

test('held startup retains expired community rows and completed-job notes; normal clear restores ordinary cleanup without removing general notes',async t=>{
  const f=await fixture(t,{accelerate:true}),jobId=randomUUID();
  f.service.store.jobs.push({id:jobId,userId:f.user.id,username:f.user.username,machine,state:'SUCCEEDED',cards:1,spec:{argv:['true']}});f.service.save();
  f.service.db.prepare('INSERT INTO community_chat(id,author_id,body,created_at,updated_at,revision) VALUES(71,?,?,1,1,3)').run(f.user.id,'old durable chat fixture');
  f.service.db.prepare('INSERT INTO community_keys(author_id,client_key,operation,digest,entity_id,created_at) VALUES(?,?,?,?,71,1)').run(f.user.id,randomUUID(),'message.create','retain-old-idempotency-key');
  f.service.db.prepare('INSERT INTO community_rate(author_id,bucket,count,until_ms) VALUES(?,?,5,1)').run(f.user.id,'chat');
  f.service.db.prepare('INSERT INTO community_notes(id,author_id,job_id,body,created_at,updated_at,revision) VALUES(72,?,?,?,1,1,2)').run(f.user.id,jobId,'completed task note fixture');
  f.service.db.prepare('INSERT INTO community_notes(id,author_id,job_id,body,created_at,updated_at,revision) VALUES(73,?,NULL,?,1,1,4)').run(f.user.id,'general durable note fixture');
  const rows=()=>Object.fromEntries(['community_chat','community_keys','community_rate','community_notes'].map(table=>[table,f.service.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])),before=rows();
  await f.reopen();await sleep(45);assert.equal(maintainTaskNotes(f.service),0);assert.deepEqual(rows(),before);assert.deepEqual(f.calls,[]);
  f.clear();await f.reopen();
  const after=rows();assert.deepEqual(after.community_chat,[]);assert.deepEqual(after.community_keys,[]);assert.deepEqual(after.community_rate,[]);assert.deepEqual(after.community_notes,[before.community_notes.find(row=>row.id===73)]);
});

test('global-held initial login prune preserves expired rows but never grants their credential; normal startup resumes GC',async t=>{
  const f=await fixture(t),expiredToken='a'.repeat(64),hash=createHash('sha256').update(expiredToken).digest('hex');
  f.service.db.prepare('INSERT INTO login_sessions(token_hash,user_id,username,role,created_at,touched_at,expires_at) VALUES(?,?,?,?,1,2,3)').run(hash,f.user.id,f.user.username,'admin');
  f.service.db.prepare('INSERT INTO login_sessions(token_hash,user_id,username,role,created_at,touched_at,expires_at) VALUES(?,?,?,?,1,2,3)').run('b'.repeat(64),f.user.id,f.user.username,'admin');
  const rows=()=>f.service.db.prepare('SELECT * FROM login_sessions ORDER BY token_hash').all(),before=rows();
  await f.reopen();assert.deepEqual(rows(),before);
  assert.throws(()=>f.service.principal(expiredToken),error=>error.status===401);assert.equal(rows().length,1);assert.equal(rows()[0].token_hash,'b'.repeat(64));
  f.clear();await f.reopen();assert.deepEqual(rows(),[]);
});

test('held restart preserves all existing tables, schemas, typed unknown rows and SQLite sequences exactly',async t=>{
  const f=await fixture(t,{accelerate:true});
  f.service.db.exec('CREATE TABLE future_private_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, unknown_text TEXT, unknown_blob BLOB, unknown_real REAL)');
  f.service.db.prepare('INSERT INTO future_private_ledger(unknown_text,unknown_blob,unknown_real) VALUES(?,?,?)').run('opaque future metadata',Buffer.from([0,255,7]),0.25);
  seedLegacy(f.service,f.user,{state:'UNKNOWN',approver:{id:f.user.id,username:f.user.username},future:{keep:'original'}});
  const snapshot=()=>({schema:f.service.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name').all(),tables:Object.fromEntries(f.service.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>[name,f.service.db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]))}),before=snapshot();
  await f.reopen();await sleep(55);assert.deepEqual(snapshot(),before);assert.deepEqual(f.calls,[]);
});

test('per-machine maintenance does not acquire a global background pause',async t=>{
  const f=await fixture(t);f.service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify({version:1,revision:2,global:null,machines:{[machine]:{reason:'one machine held',since:'2026-10-05T00:00:00.000Z'}}}));
  assert.equal(f.service.globalMaintenanceActive(),false);await f.service.reconcileTransfers();assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'datasets.upload.status');assert.equal(f.rows().find(row=>row.id===f.waiting).state,'WAITING_CLIENT');
});
