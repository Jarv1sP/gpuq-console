import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
import {DemoService,credential} from '../dist/service.js';

const password='Isolated-Login-Lane-2026!';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'login-lane-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const service=await PortalService.open(join(dir,'db'),bootstrap);
  t.after(async()=>{if(!service.closing)service.close();await rm(dir,{recursive:true,force:true});});
  return service;
}
test('real password authentication bypasses a held mutation tail without replaying writes',async t=>{
  const service=await fixture(t),held=deferred(),started=deferred();let writes=0;
  const mutation=service.enqueue(async()=>{writes++;started.resolve();await held.promise;});
  await started.promise;
  try{
    const login=await service.login('admin',password);
    assert.equal(login.principal.role,'admin');assert.equal(service.principal(login.token).userId,'builtin-admin');
    assert.equal(service.pending,1);assert.equal(writes,1);assert.equal(service.loginPending,0);
    await assert.rejects(service.login('admin','incorrect'),/用户名或密码错误/);
  }finally{held.resolve();await mutation;}
  assert.equal(writes,1);
});
test('login keeps fresh GPU status and does not skip its local snapshot refresh',async t=>{
  const service=await fixture(t);let refreshed=0;
  service.refreshGPUQ=async()=>{refreshed++;service.gpuq={checkedAt:'2026-10-07T00:00:00Z',stale:true,hosts:[]};};
  const login=await service.login('admin',password);
  assert.equal(refreshed,1);assert.equal(login.state.gpuq.checkedAt,'2026-10-07T00:00:00Z');
});
test('global admission is bounded and duplicate account attempts are not queued',async t=>{
  const service=await fixture(t),held=deferred(),entered=deferred();let reads=0;
  service.refreshGPUQ=async()=>{if(++reads===2)entered.resolve();await held.promise;};
  const admin=service.login('admin',password),unknown=service.login('unknown',password);
  const unknownError=assert.rejects(unknown,/用户名或密码错误/);
  await entered.promise;
  await assert.rejects(service.login('admin',password),e=>e.status===429);
  await assert.rejects(service.login('third',password),e=>e.status===429);
  assert.equal(service.loginPending,2);assert.equal(reads,2);
  held.resolve();await admin;await unknownError;
  assert.equal(service.loginPending,0);assert.equal(service.loginAdmissions.size,0);
});
for(const change of ['reset','disable','delete','role'])test('credential/identity '+change+' during authentication rejects and revokes its new token',async t=>{
  const service=await fixture(t),held=deferred(),issued=deferred();
  const original=DemoService.prototype.login;
  t.mock.method(DemoService.prototype,'login',async function(...args){
    const result=await original.apply(this,args);issued.resolve(result.token);await held.promise;return result;
  });
  const pending=service.login('admin',password),denied=assert.rejects(pending,e=>e.status===403);
  const token=await issued.promise;assert.equal(service.loginSessions.principal(token).userId,'builtin-admin');
  const user=service.store.users.find(u=>u.username==='admin');
  if(change==='reset')service.credentials.set('admin',await credential('New-Isolated-Password-2026!',600000));
  if(change==='disable')user.enabled=false;
  if(change==='delete')service.store.users=service.store.users.filter(u=>u.id!==user.id);
  if(change==='role')user.role='member';
  held.resolve();await denied;
  assert.equal(service.db.prepare('SELECT count(*) n FROM login_sessions').get().n,0);
  assert.equal(service.loginPending,0);
});
test('a role edit before hashing does not grant a newly changed principal',async t=>{
  const service=await fixture(t),held=deferred(),entered=deferred();
  service.refreshGPUQ=async()=>{entered.resolve();await held.promise;};
  const pending=service.login('admin',password),denied=assert.rejects(pending,e=>e.status===403);
  await entered.promise;service.store.users[0].role='member';held.resolve();await denied;
  assert.equal(service.db.prepare('SELECT count(*) n FROM login_sessions').get().n,0);
});
test('failed logins retain inherited throttling and closing rejects before issuing',async t=>{
  const service=await fixture(t);
  for(let i=0;i<5;i++)await assert.rejects(service.login('admin','incorrect'),/用户名或密码错误/);
  await assert.rejects(service.login('admin',password),/尝试次数过多/);
  service.close();await assert.rejects(service.login('admin',password),e=>e.status===503);
  assert.equal(service.loginPending,0);
});
test('reset while the original password hash is pending denies before token issuance',async t=>{
  const service=await fixture(t),original=service.issueSession.bind(service);let issuance=0;
  service.issueSession=principal=>{issuance++;return original(principal);};
  const pending=service.login('admin',password),denied=assert.rejects(pending,e=>e.status===403);
  // A genuine PBKDF2 hash yields to the event loop; swap the trusted record then.
  await new Promise(setImmediate);
  service.credentials.set('admin',await credential('Changed-Isolated-2026!',1));
  await denied;
  assert.equal(issuance,1,'the session admission hook, not a skipped password check, rejects');
  assert.equal(service.db.prepare('SELECT count(*) n FROM login_sessions').get().n,0);
});
test('shutdown revokes a credential issued by an unfinished login before closing SQLite',async t=>{
  const service=await fixture(t),held=deferred(),issued=deferred(),original=DemoService.prototype.login;
  t.mock.method(DemoService.prototype,'login',async function(...args){
    const result=await original.apply(this,args);issued.resolve(result.token);await held.promise;return result;
  });
  const pending=service.login('admin',password),denied=assert.rejects(pending,e=>e.status===503);
  const token=await issued.promise;
  const revoke=service.revokeSession.bind(service);let revoked=false;
  service.revokeSession=value=>{if(value===token)revoked=true;return revoke(value);};
  service.close();assert.equal(revoked,true);held.resolve();await denied;
  assert.equal(service.loginPending,0);
});
