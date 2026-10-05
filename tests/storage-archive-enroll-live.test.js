// Real HTTP authentication, SQLite, downloaded standalone CLI and execution
// routing. Only native immutable metadata/seal/certify operations are fake;
// storage-archive.test.py covers their actual pinned-TLS implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
import {installStorageArchive} from '../storage-archive.mjs';

const [hot,cold]=MACHINES.map(m=>m.id),dataset='legacy-original',version='a'.repeat(64);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const registration=machine=>(machine===hot?'c':'d').repeat(64);
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'archive-enroll-live-')),database=join(dir,'portal.sqlite'),bootstrap=join(dir,'bootstrap'),storage=join(dir,'archive.json'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(storage,JSON.stringify({enabled:true,machine:cold,authority:'hdd'}));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
  const calls=[],grants=new Map(),certifications=new Map(),retirements=new Map();let owner,server,service,certified=false,dropRetirement=false;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='storage.archive.events')return {events:[]};
    if(operation==='datasets.list')return {datasets:args.userId===owner?.id?[{dataset,ownerIds:[owner.id],versions:[{version,state:'READY'}]}]:[]};
    if(operation==='transfers.capabilities')return {enabled:false,sources:[]};
    assert.equal(args.userId,owner.id,'native single-owner ACL must match explicit enrollment owner');
    if(operation==='storage.archive.retire'){
      assert.equal(machine,args.mode?hot:cold);assert.equal(args.dataset,dataset);assert.equal(args.version,version);
      if(retirements.has(args.id))assert.deepEqual(retirements.get(args.id),args);else retirements.set(args.id,structuredClone(args));
      if(dropRetirement){dropRetirement=false;throw Error('native committed; reply lost');}
      return {protocol:1,id:args.id,userId:args.userId,dataset,version,recoveryId:args.recoveryId,
        state:'RETIRED',...(args.mode?{sourceRetired:true}:{neverDispatched:true}),proofSha256:'f'.repeat(64)};
    }
    if(operation==='storage.archive.enrollment-check'){
      assert.deepEqual(args,{userId:owner.id,dataset,version});
      assert.equal(certified,false,'a repeated enrollment must resolve its durable row instead of reprobe');
      return {protocol:1,machine,userId:owner.id,dataset,version,state:'READY',role:'protected',manifestSha256:version,manifestBytes:100,registration:registration(machine)};
    }
    if(operation==='storage.archive.provision'){
      assert.equal(machine,cold);assert.equal(args.targetMachine,hot);assert.deepEqual(args.source,{dataset,version});assert.equal(args.expectedRegistration,registration(cold));
      // Seeded old READY operation has no expectedRegistration in its digest.
      // New enrollment must reuse exactly that fixed grant rather than reissue.
      const grant=grants.get(args.opId);assert.ok(grant,'existing fixed grant was reused');
      return {opId:args.opId,state:'READY',grant:structuredClone(grant)};
    }
    if(operation==='storage.archive.certify'){
      assert.equal(machine,hot);assert.equal(args.expectedRegistration,registration(hot));assert.deepEqual(args.target,{dataset,version});
      assert.deepEqual(args.grant,grants.get(args.grant.id));
      const old=certifications.get(args.opId);if(old)assert.deepEqual(old,args);else certifications.set(args.opId,structuredClone(args));
      certified=true;return {opId:args.opId,state:'READY',dataset,version,role:'cache',receiptSha256:'e'.repeat(64)};
    }
    throw Error('Unexpected native mutation '+operation);
  };
  const start=async()=>{
    ({server,service}=await createPortalServer({database,bootstrap,origin,secure:false,bridge,storageArchiveConfigPath:storage}));
    for(const field of ['executionTimer','transferTimer','storageArchiveTimer','maintenanceTimer','notificationTimer','projectCopyTimer'])clearInterval(service[field]);
    await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  };
  await start();
  const stop=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  const post=async(path,body,token)=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    return {http:response.status,body:await response.json()};
  };
  const call=(token,operation,args={})=>post('/api/call',{operation,args},token);
  const login=async(username)=>{const result=await post('/api/login',{username,password});assert.equal(result.http,200);return result.body;};
  const admin=await login('admin');
  owner=(await call(admin.token,'users.create',{username:'alice',password})).body.result;
  assert.ok(owner.id);const policy=await call(admin.token,'policy.save',{userId:owner.id,policyVersion:0,limits:{[hot]:1},total:1});assert.equal(policy.http,200);
  const member=await login('alice'),bob=(await call(admin.token,'users.create',{username:'bob',password})).body.result;
  assert.equal((await call(admin.token,'policy.save',{userId:bob.id,policyVersion:0,limits:{[hot]:1},total:1})).http,200);
  const grantKey=sha([owner.id,cold,dataset,version,hot]);
  const id=`${grantKey.slice(0,8)}-${grantKey.slice(8,12)}-5${grantKey.slice(13,16)}-a${grantKey.slice(17,20)}-${grantKey.slice(20,32)}`;
  grants.set(id,{schema:1,id,sourceMachine:cold,targetMachine:hot,dataset,version,token:'private-existing-grant-token',receipt:{owners:[owner.id]}});
  const download=await fetch(origin+'/gpuctl.mjs');assert.equal(download.status,200);
  const cliFile=join(dir,'gpuctl.mjs'),session=join(dir,'session.json');await writeFile(cliFile,await download.text());
  await writeFile(session,JSON.stringify({url:origin,token:admin.token,principal:admin.principal}),{mode:0o600});
  const cli=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cliFile,'--session-file',session,'--json',...args]);let stdout='',stderr='';
    child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  return {calls,owner,bob,admin,member,call,cli,grants,certifications,get service(){return service;},loseNextRetirementReply:()=>{dropRetirement=true;},
    request:{machine:hot,dataset,version,ownerId:owner.id,key:randomUUID()},
    restart:async()=>{await stop();await start();}};
}

test('downloaded CLI and real HTTP enroll/restart/duplicate preserve current grant and exact owner',async t=>{
  const f=await fixture(t),args=['data','archive-enroll',dataset+'@'+version,'--machine',hot,'--owner-id',f.owner.id,'--key',f.request.key];
  const first=await f.cli(args);assert.equal(first.code,0,first.stderr);assert.equal(JSON.parse(first.stdout).data.phase,'PROVISIONING');
  const old=f.service.db.prepare('SELECT data FROM storage_archives').get();assert.ok(old);
  const duplicate=await f.call(f.admin.token,'datasets.archive.enroll',f.request);assert.equal(duplicate.http,200);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM storage_archives').get().n,1);
  assert.equal(f.calls.filter(c=>c.operation==='storage.archive.enrollment-check').length,2);
  await f.restart();await f.service.reconcileStorageArchive();
  const final=await f.cli(args);assert.equal(final.code,0,final.stderr);assert.equal(JSON.parse(final.stdout).data.phase,'ARCHIVED');
  assert.equal(f.grants.size,1);assert.equal(f.certifications.size,1);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n,0);
  assert.equal(f.service.store.get(f.owner.id).limits[cold]||0,0);
  const catalog=await f.call(f.member.token,'datasets.catalog',{machine:hot});assert.equal(catalog.http,200);
  assert.equal(catalog.body.result.datasets[0].versions[0].locations.find(l=>l.machine===hot).storage.phase,'ARCHIVED');
  assert.equal(f.service.archiveSourceAllowed(f.owner.id,cold,{dataset,version}),true);
  assert.equal(f.service.archiveSourceAllowed(f.bob.id,cold,{dataset,version}),false);
  assert.equal(JSON.stringify([first.stdout,final.stdout,catalog.body,f.service.db.prepare('SELECT data FROM storage_archives').all()]).includes('private-existing-grant-token'),false);
});

test('real HTTP rejects member, forged context and private bridge operations before dispatch',async t=>{
  const f=await fixture(t),before=f.calls.length;
  assert.equal((await f.call(f.member.token,'datasets.archive.enroll',f.request)).http,403);
  for(const extra of [{hostAdmin:true},{userId:f.owner.id},{sourceMachine:cold},{authority:'hdd'},{proof:{owners:[f.owner.id]}}])
    assert.equal((await f.call(f.admin.token,'datasets.archive.enroll',{...f.request,...extra})).http,400);
  for(const operation of ['storage.archive.enrollment-check','storage.archive.provision','storage.archive.certify'])
    assert.notEqual((await f.call(f.admin.token,operation,{userId:f.owner.id,dataset,version})).http,200);
  assert.equal(f.calls.length,before);
  assert.notEqual((await f.call(f.admin.token,'datasets.archive.enroll',{...f.request,ownerId:f.bob.id})).http,200);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM storage_archives').get().n,0);
  assert.equal((await f.call(f.admin.token,'datasets.archive.enroll',f.request)).http,200);
  assert.notEqual((await f.call(f.admin.token,'datasets.archive.enroll',{...f.request,version:'b'.repeat(64)})).http,200);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM storage_archives').get().n,1);
  assert.equal((await f.call(f.admin.token,'users.enabled',{userId:f.owner.id,enabled:false})).http,200);
  await f.service.reconcileStorageArchive();
  assert.equal(JSON.parse(f.service.db.prepare('SELECT data FROM storage_archives').get().data).phase,'BLOCKED');
  assert.equal(f.calls.some(c=>c.operation==='storage.archive.provision'),false);
});

test('real HTTP admin retirement persists terminal proof through restart and rejects private/member calls',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call(f.admin.token,'policy.save',{userId:f.owner.id,policyVersion:1,limits:{[hot]:1,[cold]:1},total:2})).http,200);
  const archive=installStorageArchive(f.service,{enabled:true,machine:cold,authority:'hdd'},{startTimer:false});
  const event={id:randomUUID(),userId:f.owner.id,dataset,version,state:'READY'},row=archive.enqueueEvent(cold,event);
  f.service.db.prepare('INSERT INTO storage_archive_lane VALUES(1,?)').run(row.id);
  const args={machine:cold,ownerId:f.owner.id,dataset,version,eventId:event.id,recoveryId:'unregister-'+'1'.repeat(32)};
  assert.equal((await f.call(f.member.token,'datasets.archive.retire',args)).http,403);
  assert.notEqual((await f.call(f.admin.token,'storage.archive.retire',args)).http,200);
  assert.equal((await f.call(f.admin.token,'datasets.archive.retire',{...args,grantId:row.grantId})).http,400);
  const first=await f.call(f.admin.token,'datasets.archive.retire',args);assert.equal(first.http,200);assert.equal(first.body.result.phase,'FAILED');
  assert.equal(f.service.db.prepare('SELECT * FROM storage_archive_lane').get(),undefined);
  await f.restart();
  const repeat=await f.call(f.admin.token,'datasets.archive.retire',args);assert.equal(repeat.http,200);assert.deepEqual(repeat.body,first.body);
  assert.notEqual((await f.call(f.admin.token,'datasets.archive.retire',{...args,recoveryId:'unregister-'+'2'.repeat(32)})).http,200);
  assert.notEqual((await f.call(f.member.token,'datasets.archive.retry',{machine:cold,dataset,version})).http,200);
  assert.equal(f.calls.filter(c=>c.operation==='storage.archive.retire').length,1);
  assert.equal(f.calls.some(c=>['storage.archive.original','storage.archive.provision','storage.archive.certify'].includes(c.operation)),false);
});

test('real HTTP queued retirement survives lost native reply and restart without dispatching',async t=>{
  const f=await fixture(t),archive=installStorageArchive(f.service,{enabled:true,machine:cold,authority:'hdd'},{startTimer:false});
  const event={id:randomUUID(),userId:f.owner.id,dataset,version,state:'READY'},row=archive.enqueueEvent(hot,event);
  f.service.db.prepare('INSERT INTO storage_archive_lane VALUES(1,?)').run('legitimate-copy');
  const args={machine:hot,ownerId:f.owner.id,dataset,version,eventId:event.id,recoveryId:'unregister-'+'1'.repeat(32)};
  assert.equal((await f.call(f.admin.token,'datasets.archive.retire',{...args,mode:'queued-ingest-v1'})).http,400);
  f.loseNextRetirementReply();assert.notEqual((await f.call(f.admin.token,'datasets.archive.retire',args)).http,200);
  const pending=JSON.parse(f.service.db.prepare('SELECT data FROM storage_archives WHERE id=?').get(row.id).data);
  assert.equal(pending.phase,'QUEUED');assert.ok(pending.retirementIntent);
  await f.restart();await f.service.reconcileStorageArchive();
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM transfers').get().n,0);
  const done=await f.call(f.admin.token,'datasets.archive.retire',args);assert.equal(done.http,200);assert.equal(done.body.result.phase,'FAILED');
  assert.equal(f.service.db.prepare('SELECT archive_id FROM storage_archive_lane').get().archive_id,'legitimate-copy');
  assert.equal(f.calls.filter(c=>c.operation==='storage.archive.retire').length,2);
  assert.equal(f.calls.some(c=>['transfers.source.prepare','transfers.start'].includes(c.operation)),false);
  assert.equal((await f.call(f.admin.token,'datasets.archive.retire',args)).http,200);
});
