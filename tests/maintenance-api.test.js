import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHmac} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const password='Maintenance-Fixture-Only-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-api-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const snapshot=async({reachable=true,available=true,complete=true,pid=null,stale=false,connected=true}={})=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date(Date.now()-(stale?240000:0)).toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable,hostCommand:{version:1,available},
    gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:complete,processes:pid?[{pid}]:[]})),gpuq:{connected,jobs:[]}}))}));
  await snapshot();const calls=[],receipts=new Map();let fault=null;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});const key=args.key||args.id;
    if(operation==='host.exec'&&!receipts.has(key))receipts.set(key,{id:key,state:'RUNNING',stdout:'',stderr:'',exitCode:null});
    if(fault)throw fault;
    if(!receipts.has(key))throw Error('No receipt');
    if(operation==='host.cancel')receipts.get(key).state='CANCELED';
    return structuredClone(receipts.get(key));
  };
  let s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);clearInterval(s.maintenanceTimer);
  let a=await s.login('admin',password);
  const owner=(await s.invoke(a.token,'users.create',{username:'requester',password})).result;
  const other=(await s.invoke(a.token,'users.create',{username:'other',password})).result;
  const reviewer=(await s.invoke(a.token,'users.create',{username:'reviewer',password,role:'admin'})).result;
  await s.invoke(a.token,'policy.full',{userId:owner.id,policyVersion:0});
  await s.invoke(a.token,'policy.full',{userId:other.id,policyVersion:0});
  let member=await s.login(owner.username,password),b=await s.login(other.username,password),second=await s.login(reviewer.username,password);
  const call=(operation,args,token=member.token)=>s.invoke(token,'maintenance.'+operation,args).then(r=>r.result);
  const create=(extra={},token=member.token)=>call('create',{key:randomUUID(),machine:'gpu-1',title:'检查系统依赖',reason:'训练缺少系统库，需管理员检查',script:'printf "checked\\n"',...extra},token);
  const preview=id=>call('preview',{id},a.token);
  const approve=(p,extra={},token=a.token)=>call('approve',{id:p.request.id,revision:p.request.revision,previewToken:p.previewToken,...extra},token);
  t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true});});
  return {get s(){return s},get a(){return a},get member(){return member},get second(){return second},get b(){return b},owner,other,reviewer,calls,receipts,call,create,preview,approve,snapshot,fault:value=>fault=value,
    reopen:async()=>{s.close();s=await PortalService.open(database,undefined,status,bridge);clearInterval(s.executionTimer);clearInterval(s.maintenanceTimer);a=await s.login('admin',password);member=await s.login(owner.username,password);b=await s.login(other.username,password);second=await s.login(reviewer.username,password);}
  };
}
test('creation is owner-key idempotent, immutable, not a root grant, and never dispatches',async t=>{
  const f=await fixture(t),key=randomUUID(),first=await f.create({key}),again=await f.create({key});
  assert.equal(first.id,again.id);assert.notEqual(first.id,key);assert.equal(first.state,'PENDING');assert.match(first.scriptSha256,/^[a-f0-9]{64}$/);
  assert.equal(f.calls.length,0);assert.equal(f.s.store.get(f.owner.id).role,'member');
  await assert.rejects(f.create({key,script:'different'}),e=>e.status===409);
  assert.notEqual((await f.create({key},f.b.token)).id,first.id);
  for(const extra of [{userId:'builtin-admin'},{hostAdmin:true},{role:'admin'},{approvedBy:'admin'},{executionKey:key},{argv:['id']}])await assert.rejects(f.create(extra));
  for(const op of ['preview','approve','return','cancel'])await assert.rejects(f.call(op,{id:first.id},f.member.token),e=>e.status===403);
  await assert.rejects(f.s.invoke(f.member.token,'host.exec',{machine:'gpu-1',key,argv:['id']}),e=>e.status===403);
  assert.equal(f.calls.length,0);
});
test('private reads, required reasons, withdrawal, resubmission, limits and input validation',async t=>{
  const f=await fixture(t),first=await f.create();
  await assert.rejects(f.call('get',{id:first.id},f.b.token),e=>e.status===404);
  await assert.rejects(f.call('return',{id:first.id,revision:1,reason:' '},f.a.token));
  const returned=await f.call('return',{id:first.id,revision:1,reason:'请补充具体库名'},f.a.token);assert.equal(returned.state,'RETURNED');assert.equal(returned.decision.reason,'请补充具体库名');
  await assert.rejects(f.preview(first.id),e=>e.status===409);
  const next=await f.create({parentId:first.id});assert.equal(next.parentId,first.id);
  await assert.rejects(f.call('withdraw',{id:next.id,revision:1},f.a.token),e=>e.status===403);
  assert.equal((await f.call('withdraw',{id:next.id,revision:1})).state,'WITHDRAWN');
  for(const extra of [{script:''},{script:'x'.repeat(8193)},{script:'\0'},{script:'\x1b[2J'},{script:'\ud800'},{timeoutSec:0},{timeoutSec:true},{cwd:'relative'},{machine:'auto'},{title:''},{reason:''},{title:'x'.repeat(121)}])await assert.rejects(f.create(extra));
  for(let i=0;i<20;i++)await f.create();await assert.rejects(f.create(),e=>e.status===429);
  const page=await f.call('list',{limit:3});assert.equal(page.items.length,3);assert.ok(page.nextCursor);assert.equal(page.items[0].script,undefined);assert.equal(page.items[0].result,undefined);
  assert.equal((await f.call('list',{cursor:page.nextCursor,limit:3})).items.length,3);assert.equal(f.calls.length,0);
});
test('preview binds reviewer, revision, script and occupancy; two approvals dispatch once',async t=>{
  const f=await fixture(t),first=await f.create(),p=await f.preview(first.id);assert.equal(p.impact.complete,true);
  await assert.rejects(f.approve(p,{},f.second.token),e=>e.status===409);
  await f.snapshot({pid:123});await assert.rejects(f.approve(p),e=>e.status===409);
  assert.equal(f.calls.length,0);const fresh=await f.preview(first.id);
  const results=await Promise.all([f.approve(fresh),f.approve(fresh)]);assert.ok(results.every(r=>r.state==='RUNNING'));
  assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);
  const launch=f.calls.find(c=>c.operation==='host.exec');assert.notEqual(launch.args.key,first.id);
  assert.equal(launch.args.userId,'builtin-admin');assert.equal(launch.args.hostAdmin,true);assert.deepEqual(launch.args.argv,['/bin/bash','--noprofile','--norc','-c',first.script]);
  await f.reopen();assert.equal((await f.approve(fresh)).state,'RUNNING');assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);
});
test('preview expires or invalidates on restart; old nodes block approval but incomplete occupancy can be acknowledged',async t=>{
  const f=await fixture(t),first=await f.create();let p=await f.preview(first.id);
  const [body]=p.previewToken.split('.'),proof=JSON.parse(Buffer.from(body,'base64url'));proof.expires=Date.now()-1;
  const stale=Buffer.from(JSON.stringify(proof)).toString('base64url');p.previewToken=stale+'.'+createHmac('sha256',f.s.maintenanceSecret).update(stale).digest('hex');
  await assert.rejects(f.approve(p),e=>e.status===409);
  p=await f.preview(first.id);await f.reopen();await assert.rejects(f.approve(p),e=>e.status===409);
  for(const options of [{available:false},{reachable:false},{stale:true}]){await f.snapshot(options);await assert.rejects(f.preview(first.id),e=>e.status===503);}
  await f.snapshot({complete:false,connected:false});p=await f.preview(first.id);assert.equal(p.impact.complete,false);
  await assert.rejects(f.approve(p),e=>e.status===409);assert.equal(f.calls.length,0);
  assert.equal((await f.approve(p,{acknowledgeUnknown:true})).state,'RUNNING');
});
test('real SQLite/audit failures roll back before dispatch; result-save failure keeps durable intent',async t=>{
  const f=await fixture(t),first=await f.create(),p=await f.preview(first.id);
  f.s.db.exec("CREATE TRIGGER reject_approval BEFORE UPDATE ON maintenance_requests WHEN NEW.state='DISPATCHING' BEGIN SELECT RAISE(ABORT,'sql-approval-fault'); END");
  await assert.rejects(f.approve(p),/sql-approval-fault/);assert.equal(f.calls.length,0);assert.equal((await f.call('get',{id:first.id})).state,'PENDING');f.s.db.exec('DROP TRIGGER reject_approval');
  const audit=f.s.audit;f.s.audit=()=>{throw Error('audit-fault');};await assert.rejects(f.approve(p),/audit-fault/);f.s.audit=audit;assert.equal(f.calls.length,0);
  f.s.db.exec("CREATE TRIGGER reject_result BEFORE UPDATE ON maintenance_requests WHEN NEW.state='RUNNING' BEGIN SELECT RAISE(ABORT,'sql-result-fault'); END");
  await assert.rejects(f.approve(p),/sql-result-fault/);assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);
  assert.equal(f.s.db.prepare('SELECT state FROM maintenance_requests WHERE id=?').get(first.id).state,'DISPATCHING');f.s.db.exec('DROP TRIGGER reject_result');
  await f.reopen();await f.s.reconcileMaintenance();assert.equal((await f.call('get',{id:first.id})).state,'RUNNING');assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);
  const auditRows=f.s.db.prepare("SELECT outcome FROM audit WHERE operation LIKE 'maintenance.%'").all();assert.ok(auditRows.every(r=>!r.outcome.includes(first.script)));
});
test('dispatch uncertainty and missing receipts never retry root; completion and bounded output survive restart',async t=>{
  const f=await fixture(t),first=await f.create(),p=await f.preview(first.id);f.fault(Error('lost-response'));
  assert.equal((await f.approve(p)).state,'UNKNOWN');await f.reopen();assert.equal((await f.approve(p)).state,'UNKNOWN');assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);
  const key=f.calls.find(c=>c.operation==='host.exec').args.key;f.receipts.delete(key);f.fault(null);
  assert.equal((await f.call('get',{id:first.id})).state,'UNKNOWN');assert.equal((await f.call('cancel',{id:first.id,revision:f.s.db.prepare('SELECT revision FROM maintenance_requests WHERE id=?').get(first.id).revision},f.a.token)).state,'UNKNOWN');
  f.receipts.set(key,{id:key,state:'FAILED',stdout:'x'.repeat(70000),stderr:'real-maintenance-error',exitCode:7});
  const failed=await f.call('get',{id:first.id});assert.equal(failed.state,'FAILED');assert.equal(failed.result.exitCode,7);assert.equal(failed.result.stderr,'real-maintenance-error');assert.equal(failed.result.stdout.length,65536);assert.equal(failed.result.truncated.stdout,true);
  const before=f.calls.length;await f.reopen();assert.equal((await f.call('get',{id:first.id})).result.stderr,'real-maintenance-error');assert.equal(f.calls.length,before);
});
test('withdraw/return versus approve ordering, and cancel do not re-dispatch or touch training',async t=>{
  const f=await fixture(t),first=await f.create(),p=await f.preview(first.id);
  await f.call('withdraw',{id:first.id,revision:1});await assert.rejects(f.approve(p),e=>e.status===409);assert.equal(f.calls.length,0);
  const second=await f.create(),review=await f.preview(second.id),launched=await f.approve(review);
  await assert.rejects(f.call('withdraw',{id:second.id,revision:launched.revision}),e=>e.status===409);
  assert.equal((await f.call('cancel',{id:second.id,revision:launched.revision},f.second.token)).state,'CANCELED');
  assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);assert.equal(f.calls.filter(c=>c.operation==='host.cancel')[0].args.userId,'builtin-admin');assert.equal(f.s.store.jobs.length,0);
});
test('requester withdrawal of machine access blocks new approval and detail/list, not admin inspection',async t=>{
  const f=await fixture(t),first=await f.create(),p=await f.preview(first.id);
  await f.s.invoke(f.a.token,'policy.save',{userId:f.owner.id,policyVersion:1,limits:{},total:0});
  await assert.rejects(f.approve(p),e=>e.status===403);await assert.rejects(f.call('get',{id:first.id}),e=>e.status===403);
  assert.equal((await f.call('list',{})).items.length,0);assert.equal((await f.call('get',{id:first.id},f.a.token)).state,'PENDING');assert.equal(f.calls.length,0);
});
test('historical execution owner can be demoted/deleted; current admin can inspect/cancel but not execute again',async t=>{
  const f=await fixture(t),first=await f.create();const p=await f.call('preview',{id:first.id},f.second.token);const running=await f.approve(p,{},f.second.token);
  await f.s.invoke(f.a.token,'users.role',{userId:f.reviewer.id,role:'member'});
  await f.s.invoke(f.a.token,'users.enabled',{userId:f.reviewer.id,enabled:false});await f.s.invoke(f.a.token,'users.delete',{userId:f.reviewer.id});
  const status=await f.call('get',{id:first.id});assert.equal(status.state,'RUNNING');assert.equal(f.calls.at(-1).args.userId,f.reviewer.id);
  assert.equal((await f.call('cancel',{id:first.id,revision:status.revision},f.a.token)).state,'CANCELED');assert.equal(f.calls.at(-1).args.userId,f.reviewer.id);
  assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);assert.ok(running.revision>1);
});
test('two different reviewers compete safely; decision failure cannot replace the winning approval',async t=>{
  const f=await fixture(t),r=await f.create(),one=await f.preview(r.id),two=await f.call('preview',{id:r.id},f.second.token);
  const results=await Promise.allSettled([f.approve(one),f.approve(two,{},f.second.token)]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(results.find(v=>v.status==='rejected').reason.status,409);
  assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);
});
test('revoked pages cannot hide older visible records; malformed receipts and half-drained stops stay nonterminal',async t=>{
  const f=await fixture(t),r=await f.create();
  for(let n=0;n<5;n++)await f.create({machine:'gpu-2'});
  await f.s.invoke(f.a.token,'policy.save',{userId:f.owner.id,policyVersion:1,limits:{'gpu-1':1},total:1});
  assert.deepEqual((await f.call('list',{limit:2})).items.map(x=>x.id),[r.id]);
  const running=await f.approve(await f.preview(r.id)),key=running.execution.id;f.receipts.set(key,{id:'wrong',state:'SUCCEEDED'});
  const unknown=await f.call('get',{id:r.id});assert.equal(unknown.state,'UNKNOWN');assert.equal(unknown.result.state,'RUNNING','old evidence is retained, not replaced by fake success');
  f.receipts.set(key,{id:key,state:'CANCELING',exitCode:null});
  assert.equal((await f.call('get',{id:r.id})).state,'CANCELING');assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);
});
test('create SQL/audit rollback and storage limits do not discard or dispatch old requests',async t=>{
  const f=await fixture(t),key=randomUUID(),audit=f.s.audit;f.s.audit=()=>{throw Error('create-audit-fault');};
  await assert.rejects(f.create({key}),/create-audit-fault/);f.s.audit=audit;assert.equal(f.s.db.prepare('SELECT count(*) AS n FROM maintenance_requests').get().n,0);
  const r=await f.create({key});f.s.db.exec("CREATE TRIGGER reject_create BEFORE INSERT ON maintenance_requests BEGIN SELECT RAISE(ABORT,'create-sql-fault'); END");
  await assert.rejects(f.create(),/create-sql-fault/);f.s.db.exec('DROP TRIGGER reject_create');assert.equal((await f.call('get',{id:r.id})).state,'PENDING');assert.equal(f.calls.length,0);
  const seed=f.s.db.prepare('SELECT * FROM maintenance_requests WHERE id=?').get(r.id),insert=f.s.db.prepare('INSERT INTO maintenance_requests(id,owner_id,client_key,digest,state,revision,created_at,updated_at,data) VALUES(?,?,?,?,?,1,?,?,?)');
  f.s.db.exec('BEGIN');try{for(let n=1;n<10000;n++)insert.run(randomUUID(),'retired-owner',randomUUID(),seed.digest,'RETURNED',seed.created_at,seed.updated_at,seed.data);f.s.db.exec('COMMIT');}catch(e){f.s.db.exec('ROLLBACK');throw e;}
  await assert.rejects(f.create(),e=>e.status===507);assert.equal((await f.create({key})).id,r.id,'idempotent retries still work at history limit');assert.equal(f.s.db.prepare('SELECT count(*) AS n FROM maintenance_requests').get().n,10000);
});
test('UTF8 output bounds hold and unchanged state polling does not append endless audit events',async t=>{
  const f=await fixture(t),r=await f.create(),running=await f.approve(await f.preview(r.id));
  const at=f.s.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  await f.call('get',{id:r.id});await f.call('get',{id:r.id});assert.equal(f.s.db.prepare('SELECT count(*) AS n FROM audit').get().n,at);
  f.receipts.set(running.execution.id,{id:running.execution.id,state:'SUCCEEDED',stdout:'中'.repeat(30000),stderr:'错'.repeat(30000),exitCode:0});
  const result=(await f.call('get',{id:r.id})).result;
  assert.ok(Buffer.byteLength(result.stdout)<=65536);assert.ok(Buffer.byteLength(result.stderr)<=65536);assert.equal(result.truncated.stdout,true);assert.equal(result.truncated.stderr,true);
});
