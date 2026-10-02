import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,seedLegacy} from './maintenance-fixture.mjs';
import {MACHINES} from '../dist/model.js';

test('all obsolete writes return 410 for members/admins without dispatch or durable changes',async t=>{
  const f=await fixture(t),r=seedLegacy(f.service,f.owner),before=f.service.db.prepare('SELECT * FROM maintenance_requests').all(),audit=f.service.db.prepare('SELECT * FROM audit').all();
  for(const token of [f.member.token,f.admin.token])for(const op of ['create','preview','approve','return','withdraw','cancel','execute','get.extra','unknown']){
    await assert.rejects(f.call(op,{id:r.id,key:randomUUID(),revision:1,previewToken:'old-token',hostAdmin:true,script:'id'},token),e=>e.status===410&&e.message.includes('已停用'));
  }
  assert.deepEqual(f.service.db.prepare('SELECT * FROM maintenance_requests').all(),before);
  assert.deepEqual(f.service.db.prepare('SELECT * FROM audit').all(),audit);assert.deepEqual(f.calls,[]);
});
test('pending and terminal history survive reopen, remain private and never run',async t=>{
  const f=await fixture(t),pending=seedLegacy(f.service,f.owner),complete=seedLegacy(f.service,f.owner,{state:'SUCCEEDED',result:{state:'SUCCEEDED',stdout:'old output',stderr:'',exitCode:0,truncated:{}}});
  const before=f.service.db.prepare('SELECT * FROM maintenance_requests ORDER BY seq').all(),audit=f.service.db.prepare('SELECT * FROM audit').all();await f.reopen();
  for(const r of [pending,complete]){const view=await f.call('get',{id:r.id});assert.equal(view.actionable,false);assert.equal(view.readOnly,true);assert.equal(view.retired,true);assert.equal(view.script,r.data.payload.script);}
  await assert.rejects(f.call('get',{id:pending.id},f.second.token),e=>e.status===404);
  assert.deepEqual(f.service.db.prepare('SELECT * FROM maintenance_requests ORDER BY seq').all(),before);
  const afterAudit=f.service.db.prepare('SELECT * FROM audit').all();
  assert.deepEqual(afterAudit.slice(0,audit.length),audit);assert.ok(afterAudit.slice(audit.length).every(row=>row.operation==='login'));assert.deepEqual(f.calls,[]);
});
test('already dispatched commands only poll original actor/key, never cancel or relaunch',async t=>{
  const f=await fixture(t),actor={id:'removed-former-admin',username:'former-admin'},pending=seedLegacy(f.service,f.owner);
  for(const state of ['DISPATCHING','RUNNING','CANCELING','UNKNOWN']){
    const r=seedLegacy(f.service,f.owner,{state,approver:actor});
    f.receipts.set(r.data.executionKey,{id:r.data.executionKey,state:'RUNNING',stdout:'',stderr:'',exitCode:null});
  }
  await f.reopen();await f.service.reconcileMaintenance();assert.equal(f.calls.length,4);
  for(const call of f.calls){assert.equal(call.operation,'host.status');assert.equal(call.args.userId,actor.id);assert.equal(call.args.username,actor.username);assert.equal(call.args.key,undefined);}
  assert.equal((await f.call('get',{id:pending.id})).state,'PENDING');
  assert.equal(f.service.store.jobs.length,0);
});
test('missing and malformed status receipts remain unknown; bounded completion is retained',async t=>{
  const f=await fixture(t),r=seedLegacy(f.service,f.owner,{state:'RUNNING',approver:{id:'old-admin',username:'old'}});
  assert.equal((await f.call('get',{id:r.id})).state,'UNKNOWN');
  f.receipts.set(r.data.executionKey,{id:randomUUID(),state:'SUCCEEDED'});assert.equal((await f.call('get',{id:r.id})).state,'UNKNOWN');
  f.receipts.set(r.data.executionKey,{id:r.data.executionKey,state:'FAILED',stdout:'测'.repeat(30000),stderr:'old failure',exitCode:7});
  const result=await f.call('get',{id:r.id});assert.equal(result.state,'FAILED');assert.equal(result.result.exitCode,7);assert.ok(Buffer.byteLength(result.result.stdout)<=65536);assert.equal(result.result.truncated.stdout,true);
  const count=f.calls.length;await f.reopen();assert.equal((await f.call('get',{id:r.id})).result.stderr,'old failure');assert.equal(f.calls.length,count);
  assert.ok(f.calls.every(c=>c.operation==='host.status'));
});
test('pagination and access revocation keep other owners and machine records private',async t=>{
  const f=await fixture(t);for(let i=0;i<5;i++)seedLegacy(f.service,f.owner);seedLegacy(f.service,f.other);
  const first=await f.call('list',{limit:2});assert.equal(first.items.length,2);assert.ok(first.nextCursor);assert.equal(first.items[0].script,undefined);assert.equal(first.items[0].result,undefined);
  const next=await f.call('list',{cursor:first.nextCursor,limit:2});assert.equal(next.items.length,2);assert.notEqual(first.items[0].id,next.items[0].id);
  assert.equal((await f.call('list',{},f.admin.token)).items.length,6);
  await f.service.invoke(f.admin.token,'policy.save',{userId:f.owner.id,policyVersion:1,limits:{},total:0});
  assert.equal((await f.call('list')).items.length,0);await assert.rejects(f.call('get',{id:first.items[0].id}),e=>e.status===403);
  assert.equal((await f.call('get',{id:first.items[0].id},f.admin.token)).state,'PENDING');
  for(const args of [{limit:0},{limit:51},{cursor:'-1'},{cursor:'1.5'},{other:true}])await assert.rejects(f.call('list',args));
});
test('polling does not grow unchanged audit; persistence failure never dispatches',async t=>{
  const f=await fixture(t),r=seedLegacy(f.service,f.owner,{state:'RUNNING',approver:{id:'old-admin',username:'old'}});
  f.receipts.set(r.data.executionKey,{id:r.data.executionKey,state:'RUNNING',stdout:'',stderr:''});
  const count=f.service.db.prepare('SELECT count(*) AS n FROM audit').get().n;await f.call('get',{id:r.id});await f.call('get',{id:r.id});assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM audit').get().n,count);
  f.receipts.get(r.data.executionKey).state='SUCCEEDED';f.service.db.exec("CREATE TRIGGER fail_retired_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
  await assert.rejects(f.call('get',{id:r.id}),/audit failure/);assert.equal(f.service.db.prepare('SELECT state FROM maintenance_requests WHERE id=?').get(r.id).state,'RUNNING');
  assert.ok(f.calls.every(c=>c.operation==='host.status'));
});
test('separate administrator exec remains available while ordinary members cannot invoke root',async t=>{
  const f=await fixture(t),request={machine:MACHINES[0].id,key:randomUUID(),argv:['id']};
  await assert.rejects(f.service.invoke(f.member.token,'host.exec',request),e=>e.status===403);
  const result=(await f.service.invoke(f.admin.token,'host.exec',request)).result;assert.equal(result.state,'SUCCEEDED');assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'host.exec');assert.equal(f.calls[0].args.hostAdmin,true);
});
