import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {createPortalServer} from '../portal-server.mjs';
import {fixture,hosts,version,admin,writes} from './dataset-deletion-fixture.mjs';

const row=f=>JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
const ids=value=>value.steps.map(step=>({machine:step.machine,dataset:step.dataset,operationId:step.operationId}));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function interrupted(t){
  const f=fixture(t);let failed=true;
  f.after=(host,op,args,result)=>{
    if(host===hosts[0]&&op.endsWith('.plan'))result.authority={protocol:'dataset-authority-dependencies-v1',
      sourceMachine:host,dataset:args.dataset,version:args.version,grants:[]};
    if(failed&&op.endsWith('.locations'))throw Error('original locations reply interrupted');
  };
  const original=await f.start();failed=false;
  assert.equal(original.result.state,'UNKNOWN');assert.equal(writes(f).length,0);
  assert.equal(row(f).inspectionComplete,false);
  return {f,original};
}

test('continue durably replaces old UNKNOWN before delayed locations and does not replay duplicate requests',async t=>{
  const {f,original}=await interrupted(t),before=row(f),entered=deferred(),release=deferred();
  let loggedIn=true;
  const current=()=>{if(!loggedIn)throw Object.assign(Error('session ended'),{status:401});};
  f.before=async(host,op)=>{if(host===hosts[0]&&op.endsWith('.locations')){entered.resolve();await release.promise;}};
  try{
    const reply=await f.call('datasets.delete.continue',{operationId:original.first.operationId},admin,current);
    assert.equal(reply.state,'RUNNING');assert.equal(Object.hasOwn(reply,'error'),false);
    assert.equal(row(f).state,'RUNNING');assert.equal(Object.hasOwn(row(f),'error'),false);
    await entered.promise;
    const count=f.calls.length;
    const status=await f.call('datasets.delete.status',{operationId:original.first.operationId},admin,current);
    assert.equal(status.state,'RUNNING');assert.equal(f.calls.length,count,'status never starts another inspection');
    assert.deepEqual(ids(row(f)),ids(before));assert.equal(writes(f).length,0);
    await assert.rejects(f.call('datasets.delete.continue',{operationId:original.first.operationId},admin,current),/还在运行/);
    assert.equal(f.calls.length,count,'duplicate continuation cannot re-plan or start a worker');
  }finally{release.resolve();}
  await f.service.waitDatasetDeletions();
  const result=await f.call('datasets.delete.status',{key:original.args.key},admin,current);
  assert.equal(result.state,'DELETED');assert.deepEqual(ids(row(f)),ids(before));
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,1);
  assert.equal(writes(f).filter(call=>call.op.endsWith('.isolate')).length,hosts.length);
  loggedIn=false;
  await assert.rejects(f.call('datasets.delete.status',{key:original.args.key},admin,current),error=>error.status===401);
  assert.equal(row(f).state,'DELETED','logout after terminal confirmation does not undo the original outcome');
});

test('logout while delayed locations are pending still stops the original continuation before every write',async t=>{
  const {f,original}=await interrupted(t),before=row(f),entered=deferred(),release=deferred();let loggedIn=true;
  const current=()=>{if(!loggedIn)throw Object.assign(Error('session ended'),{status:401});};
  f.before=async(host,op)=>{if(host===hosts[0]&&op.endsWith('.locations')){entered.resolve();await release.promise;}};
  try{
    const reply=await f.call('datasets.delete.continue',{operationId:original.first.operationId},admin,current);
    assert.equal(reply.state,'RUNNING');await entered.promise;
    assert.equal((await f.call('datasets.delete.status',{operationId:original.first.operationId},admin,current)).state,'RUNNING');
    loggedIn=false;
    await assert.rejects(f.call('datasets.delete.status',{operationId:original.first.operationId},admin,current),error=>error.status===401);
  }finally{release.resolve();}
  await f.service.waitDatasetDeletions();
  assert.equal(row(f).state,'UNKNOWN');assert.equal(row(f).events.at(-1).action,'停止推进');
  assert.equal(row(f).events.length,before.events.length+1);
  assert.deepEqual(ids(row(f)),ids(before));assert.equal(row(f).inspectionComplete,false);
  assert.equal(writes(f).length,0);assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
});

test('failed RUNNING persistence starts no observation or node phase and leaves the original journal intact',async t=>{
  const {f,original}=await interrupted(t),before=row(f),calls=f.calls.length;
  f.service.db.exec(`CREATE TRIGGER refuse_running BEFORE UPDATE ON dataset_deletions
    WHEN json_extract(NEW.data,'$.state')='RUNNING' BEGIN SELECT RAISE(FAIL,'journal full'); END;`);
  await assert.rejects(f.call('datasets.delete.continue',{operationId:original.first.operationId},admin),/journal full/);
  await f.service.waitDatasetDeletions();
  assert.deepEqual(row(f),before);assert.equal(writes(f).length,0);
  assert.ok(f.calls.slice(calls).every(call=>call.op.endsWith('.capabilities')),'no task starts before its RUNNING state is durable');
});

test('current authorization is rechecked after worker drain before accepting a continuation',async t=>{
  const f=fixture(t);let lose=true;
  f.after=(host,op,args,result)=>{
    if(op.endsWith('.status'))result.stoppedPhases=Object.keys(result.phases);
    if(lose&&op.endsWith('.isolate')){lose=false;throw Error('original isolate reply interrupted');}
  };
  const original=await f.start(),before=row(f),count=writes(f).length;let authorized=true;
  const current=()=>{if(!authorized)throw Object.assign(Error('session ended'),{status:401});};
  f.after=(host,op,args,result)=>{if(op.endsWith('.status')){result.stoppedPhases=Object.keys(result.phases);authorized=false;}};
  await assert.rejects(f.call('datasets.delete.continue',{operationId:original.first.operationId},admin,current),error=>error.status===401);
  assert.deepEqual(row(f),before);assert.equal(writes(f).length,count);
});

test('real HTTP continuation stays RUNNING across held locations; real logout still revokes its background authentication',async t=>{
  for(const logoutEarly of [false,true])await t.test(logoutEarly?'logout during inspection':'keep login until complete',async t=>{
    const f=fixture(t),dir=await mkdtemp(join(tmpdir(),'delete-continue-http-')),bootstrap=join(dir,'bootstrap');
    const password='Continue-HTTP-Fixture-2026!';await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
    const reserve=net.createServer();await new Promise(done=>reserve.listen(0,'127.0.0.1',done));
    const port=reserve.address().port;await new Promise(done=>reserve.close(done));const origin='http://127.0.0.1:'+port;
    const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:f.service.bridge});
    // Recover an existing v1 deletion owner with its original machine grants;
    // this fixture is not a new-account or personal-quota policy test.
    service.store.get(admin.userId).limits=Object.fromEntries(hosts.map(host=>[host,1]));service.save();
    for(const timer of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[timer]);
    const release=deferred(),entered=deferred();
    t.after(async()=>{release.resolve();await service.waitDatasetDeletions();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(dir,{recursive:true,force:true});});
    await new Promise(done=>server.listen(port,'127.0.0.1',done));
    const post=async(path,body,token)=>{
      const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Connection:'close',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
      return {http:response.status,data:await response.json()};
    };
    const login=await post('/api/login',{username:'admin',password});assert.equal(login.http,200);const token=login.data.token;
    const call=(operation,args={})=>post('/api/call',{operation,args},token);
    let interrupted=true;
    f.after=(host,op,args,result)=>{
      if(op.endsWith('.plan'))result.owners=[admin.userId];
      if(host===hosts[0]&&op.endsWith('.plan'))result.authority={protocol:'dataset-authority-dependencies-v1',sourceMachine:host,dataset:args.dataset,version:args.version,grants:[]};
      if(interrupted&&op.endsWith('.locations'))throw Error('original locations reply interrupted');
    };
    const first=await call('datasets.delete',{dataset:'personal',version,key:randomUUID()});assert.equal(first.http,200);
    await service.waitDatasetDeletions();const id=first.data.result.operationId;
    assert.equal((await call('datasets.delete.status',{operationId:id})).data.result.state,'UNKNOWN');interrupted=false;
    f.before=async(host,op)=>{if(host===hosts[0]&&op.endsWith('.locations')){entered.resolve();await release.promise;}};
    try{
      const continued=await call('datasets.delete.continue',{operationId:id});assert.equal(continued.http,200);
      assert.equal(continued.data.result.state,'RUNNING');assert.equal(Object.hasOwn(continued.data.result,'error'),false);await entered.promise;
      assert.equal((await call('datasets.delete.status',{operationId:id})).data.result.state,'RUNNING');
      if(logoutEarly){assert.equal((await call('logout')).http,200);assert.equal((await call('datasets.delete.status',{operationId:id})).http,401);}
    }finally{release.resolve();}
    await service.waitDatasetDeletions();
    const journal=JSON.parse(service.db.prepare('SELECT data FROM dataset_deletions WHERE id=?').get(id).data);
    assert.equal(journal.state,logoutEarly?'UNKNOWN':'DELETED');
    if(logoutEarly){assert.equal(writes(f).length,0);assert.equal(journal.events.at(-1).action,'停止推进');}
    else{assert.equal((await call('datasets.delete.status',{operationId:id})).data.result.state,'DELETED');assert.equal((await call('logout')).http,200);}
  });
});
