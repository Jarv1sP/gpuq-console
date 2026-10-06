import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {installDatasetDeletion} from '../dataset-deletion.mjs';
import {fixture,hosts,version,principal,admin,request,writes} from './dataset-deletion-fixture.mjs';

test('persist original key/child IDs, fence source first, isolate every target before original, retain complete bytes',async t=>{
  const f=fixture(t),r=await f.start();
  assert.equal(r.first.state,'PLANNED');assert.equal(r.result.state,'DELETED');assert.equal(r.result.steps.length,hosts.length);
  assert.equal(writes(f)[0].host,hosts[0]);assert.equal(writes(f).at(-1).host,hosts[0]);
  assert.ok(writes(f).slice(0,hosts.length).every(c=>c.op.endsWith('.fence')));
  const source=writes(f).at(-1);assert.equal(source.args.targets.length,hosts.length-1);
  assert.ok(source.args.targets.every(r=>r.state==='ISOLATED'&&r.isolated&&r.complete===false));
  assert.ok(Date.parse(r.result.retainUntil)>=Date.now()+7*86400*1000-1000);
  assert.doesNotMatch(JSON.stringify(r.result),/snapshotSha256|owners|demo-user|grant|token|registration|rootIdentity/);
  for(const child of r.result.steps)assert.equal(f.nodes.get(child.operationId).plan.machine,child.machine);
  const count=writes(f).length;
  assert.equal((await f.call('datasets.delete',r.args)).operationId,r.first.operationId);assert.equal(writes(f).length,count);
});
test('client cannot choose owner, role, paths, proof, targets, retention or child UUID',async t=>{
  const f=fixture(t);
  for(const extra of [{owners:['another']},{hostAdmin:true},{userId:admin.userId},{force:true},{retentionDays:0},{machine:hosts[0]},
    {targets:[]},{authorization:{}},{sourcePath:'/private'}, {operationId:randomUUID()}, {key:'a'.repeat(64)},{version:'latest'},{dataset:'../data'}])
    await assert.rejects(f.call('datasets.delete',{...request(),...extra}));
  assert.equal(f.calls.length,0);
});
test('capability must confirm the complete trusted inventory, not just granted visible nodes',async t=>{
  const f=fixture(t);f.users[0].limits={[hosts[0]]:1};
  f.after=(host,op,args,result)=>{if(host===hosts.at(-1)&&op.endsWith('capabilities'))result.datasetDelete=0;};
  await assert.rejects(f.call('datasets.delete',request()),e=>e.status===409&&e.code==='DATASET_DELETE_UNSUPPORTED');
  assert.deepEqual(f.calls.map(c=>c.host),hosts);assert.equal(writes(f).length,0);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,0);
});
test('offline or mismatched capability never means an absent dataset',async t=>{
  const f=fixture(t);f.before=(host,op)=>{if(host===hosts[1])throw Error('offline');};
  await assert.rejects(f.call('datasets.delete',request()),/offline/);assert.equal(writes(f).length,0);
  f.before=null;f.after=(host,op,args,result)=>{if(op.endsWith('capabilities'))result.machine='untrusted';};
  await assert.rejects(f.call('datasets.delete',request()));assert.equal(writes(f).length,0);
});
test('source provenance is mandatory for members; unknown/admin/shared originals remain admin-only',async t=>{
  const f=fixture(t);f.personal=false;
  const {result}=await f.start();assert.equal(result.state,'BLOCKED');assert.equal(writes(f).length,0);
  const g=fixture(t);g.personal=false;assert.equal((await g.start(request(),admin)).result.state,'DELETED');
});
test('every present physical version rechecks its own provenance, never supplied source owners',async t=>{
  const f=fixture(t,{onlySource:false});
  f.after=(host,op,args,result)=>{if(host===hosts[1]&&op.endsWith('.plan'))result.memberAllowed=false;};
  const {result}=await f.start();assert.equal(result.state,'BLOCKED');assert.equal(writes(f).length,0);
});
test('different/multiple owners and absence without complete source fail before fencing',async t=>{
  const f=fixture(t);f.after=(host,op,args,result)=>{if(op.endsWith('.plan'))result.owners=[principal.userId,'someone'];};
  assert.equal((await f.start()).result.state,'BLOCKED');assert.equal(writes(f).length,0);
  const g=fixture(t);g.missing=true;
  const r=await g.start();assert.notEqual(r.result.state,'DELETED');assert.equal(writes(g).length,0);
});
test('global or hidden-node maintenance blocks acceptance; queries remain read-only',async t=>{
  const f=fixture(t);f.maintenance=true;await assert.rejects(f.call('datasets.delete',request()),e=>e.code==='MAINTENANCE_ACTIVE');assert.equal(f.calls.length,0);
});
test('audit persistence failure precedes every node plan and rolls back physical fences',async t=>{
  const f=fixture(t);f.auditFailure=true;await assert.rejects(f.call('datasets.delete',request()),/audit full/);
  assert.equal(writes(f).length,0);assert.ok(f.calls.every(c=>c.op.endsWith('capabilities')));
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletion_fences').get().n,0);
});
test('same key with changed target and cross-account reuse or status are rejected',async t=>{
  const f=fixture(t),{args,first}=await f.start();
  await assert.rejects(f.call('datasets.delete',{...args,dataset:'another'}));
  const other={...principal,userId:'demo-user-2',username:'bob'};f.users.push({...f.users[0],id:other.userId,username:other.username});
  await assert.rejects(f.call('datasets.delete',args,other),e=>e.status===404);
  for(const value of [{key:args.key},{operationId:first.operationId}])await assert.rejects(f.call('datasets.delete.status',value,other),e=>e.status===404);
  const count=f.calls.length;f.users[0].limits={};await assert.rejects(f.call('datasets.delete.status',{key:args.key}),e=>e.status===403);assert.equal(f.calls.length,count);
});
test('different keys cannot concurrently delete the same version namespace',async t=>{
  const f=fixture(t),a=request(),b=request();
  const results=await Promise.allSettled([f.call('datasets.delete',a),f.call('datasets.delete',b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await f.service.waitDatasetDeletions();
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,1);
});
test('revoked account or logout after a late fence reply cannot dispatch isolation',async t=>{
  for(const logout of [false,true]){
    const f=fixture(t);let loggedIn=true;
    f.after=(host,op)=>{if(op.endsWith('.fence')){if(logout)loggedIn=false;else f.users[0].enabled=false;}};
    const r=await f.call('datasets.delete',request(),principal,()=>{if(!loggedIn)throw Object.assign(Error('logged out'),{status:403});});
    await f.service.waitDatasetDeletions();
    assert.equal(writes(f).length,1);assert.ok(writes(f).every(c=>c.op.endsWith('fence')));
    assert.equal(JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions WHERE id=?').get(r.operationId).data).state,'BLOCKED');
  }
});
test('maintenance activated after target isolation preserves original and stops all later writes',async t=>{
  const f=fixture(t);f.after=(host,op)=>{if(host!==hosts[0]&&op.endsWith('.isolate'))f.maintenance=true;};
  const {result}=await f.start();assert.equal(result.state,'BLOCKED');assert.ok(!writes(f).some(c=>c.host===hosts[0]&&c.op.endsWith('.isolate')));
});
test('ambiguous dispatch is never replayed by key, status, delayed receipt or restart',async t=>{
  const f=fixture(t);let lost=true;
  f.after=(host,op)=>{if(lost&&op.endsWith('.fence')){lost=false;throw Object.assign(Error('reply lost'),{status:504});}};
  const {args,first,result}=await f.start();assert.equal(result.state,'UNKNOWN');assert.equal(writes(f).length,1);
  const count=writes(f).length;await f.call('datasets.delete',args);await f.call('datasets.delete.status',{operationId:first.operationId});
  installDatasetDeletion(f.service,{pollMs:1,waitMs:10});
  await f.call('datasets.delete.status',{key:args.key});assert.equal(writes(f).length,count);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,1);
});
test('stopped native worker or unknown result cannot advance from a dispatch marker',async t=>{
  const f=fixture(t);f.after=(host,op,args)=>{if(op.endsWith('.fence'))f.nodes.get(args.operationId).phases={};};
  const {result}=await f.start();assert.equal(result.state,'UNKNOWN');assert.equal(writes(f).length,1);
});
test('REVOKED/RETIRED, wrong generation, missing dependent proof and premature deadline never confirm deletion',async t=>{
  for(const change of [{state:'REVOKED'},{state:'RETIRED'},{isolated:false},{snapshotSha256:'e'.repeat(64)},
    {generation:'bad'},{retainUntil:0},{authorityReferences:[{unconfirmed:true}]}]){
    const f=fixture(t);f.after=(host,op,args,result)=>{if(op.endsWith('.status')&&result.phases.isolate)Object.assign(result.phases.isolate.result,change);};
    const {result}=await f.start();assert.notEqual(result.state,'DELETED');assert.ok(!writes(f).some(c=>c.host===hosts[0]&&c.op.endsWith('.isolate')));
  }
});
test('node lease/pin failure stops before retiring original and never auto-restores or kills training',async t=>{
  const f=fixture(t);f.after=(host,op,args,result)=>{if(host!==hosts[0]&&op.endsWith('.status')&&result.phases.isolate)result.phases.isolate={ok:false,error:'active lease'};};
  const {result}=await f.start();assert.equal(result.state,'BLOCKED');
  assert.ok(!writes(f).some(c=>c.host===hosts[0]&&c.op.endsWith('isolate')));assert.ok(!f.calls.some(c=>/cancel|stop|restore|unregister/.test(c.op)));
});
test('retired external archive intent is an event only, never evidence of complete data isolation',async t=>{
  const f=fixture(t);f.service.db.exec('CREATE TABLE storage_archives(data TEXT)');
  f.service.db.prepare('INSERT INTO storage_archives VALUES(?)').run(JSON.stringify({id:'retired-intent',machine:hosts[0],sourceMachine:hosts[1],dataset:'personal',version,failureStage:'authority-retired',phase:'BLOCKED'}));
  const {result}=await f.start();assert.equal(result.state,'DELETED');
  assert.ok(result.events.some(e=>e.action==='外部替代退役'&&e.state==='RETIRED'));
  assert.ok(writes(f).length>=hosts.length*2,'actual isolation still required');
});
test('unknown/in-flight copy mapping blocks deletion instead of guessing physical names',async t=>{
  const f=fixture(t);f.service.db.exec('CREATE TABLE dataset_copies(data TEXT)');
  f.service.db.prepare('INSERT INTO dataset_copies VALUES(?)').run(JSON.stringify({id:'copy',owner:principal.userId,target:hosts[1],source:hosts[0],dataset:'personal',sourceDataset:'personal',version,transferId:randomUUID()}));
  f.service.transferSnapshot=()=>({state:'UNKNOWN'});
  const {result}=await f.start();assert.equal(result.state,'BLOCKED');assert.equal(writes(f).length,0);
});
test('an unmapped authority dependent blocks the original before any fence',async t=>{
  const f=fixture(t);f.after=(host,op,args,result)=>{if(host===hosts[0]&&op.endsWith('.plan'))result.authority={protocol:'dataset-authority-dependencies-v1',sourceMachine:host,dataset:'personal',version,grants:[{id:randomUUID(),targetMachine:hosts[1],receiptSha256:'e'.repeat(64)}]};};
  const {result}=await f.start();assert.equal(result.state,'BLOCKED');assert.equal(writes(f).length,0);
});
test('restoration is explicit administrator CLI scope; original grants are never returned/reissued',async t=>{
  const f=fixture(t),{first}=await f.start();const args={operationId:first.operationId,machine:hosts[0]};
  const count=writes(f).length;await assert.rejects(f.call('datasets.delete.restore',args),e=>e.status===403);assert.equal(writes(f).length,count);
  const restored=await f.call('datasets.delete.restore',args,admin);assert.equal(restored.state,'RESTORED');
  const actions=writes(f).slice(count);assert.equal(actions.filter(c=>c.op.endsWith('.restore')).length,1);
  assert.equal(actions.filter(c=>c.op.endsWith('.release-absence')).length,hosts.length-1);
  assert.ok(!actions.some(c=>/grant|seal|unregister|cancel/.test(c.op)));
  const now=writes(f).length;assert.equal((await f.call('datasets.delete.restore',args,admin)).state,'RESTORED');assert.equal(writes(f).length,now);
  assert.equal(f.service.datasetDeletionBlocked(hosts[0],{dataset:'personal',version}),false);
  assert.equal((await f.call('datasets.delete.status',{operationId:first.operationId})).state,'BLOCKED');
});
test('corrupt or expired restore remains unknown and keeps the original deletion lock',async t=>{
  const f=fixture(t),{first}=await f.start();f.after=(host,op,args,result)=>{if(op.endsWith('.status')&&result.phases.restore)result.phases.restore={ok:false,error:'retention expired'};};
  const args={operationId:first.operationId,machine:hosts[0]};
  assert.equal((await f.call('datasets.delete.restore',args,admin)).state,'UNKNOWN');
  assert.equal(f.service.datasetDeletionBlocked(hosts[0],{dataset:'personal',version}),true);
  const count=writes(f).length;assert.equal((await f.call('datasets.delete.restore',args,admin)).state,'UNKNOWN');assert.equal(writes(f).length,count);
});
