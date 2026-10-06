import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,readdir,chmod,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,hosts,principal,admin} from './dataset-deletion-fixture.mjs';

async function nativeFixture(t){
  const root=await mkdtemp(join(tmpdir(),'portal-real-retention-'));
  t.after(async()=>{
    const writable=async path=>{await chmod(path,0o700);for(const item of await readdir(path,{withFileTypes:true})){
      const child=join(path,item.name);if(item.isDirectory())await writable(child);else if(!item.isSymbolicLink())await chmod(child,0o600);
    }};
    await writable(root);await rm(root,{recursive:true,force:true});
  });
  const f=fixture(t,{options:{capabilityTimeoutMs:5000}}),calls=[];
  const bridge=(host,op,args)=>new Promise((resolve,reject)=>{
    calls.push({host,op,args});
    const child=spawn(process.env.PYTHON||'python3',[new URL('./dataset_deletion_node_fixture.py',import.meta.url).pathname,root]);
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.on('error',reject);child.on('close',code=>code?reject(Error(stderr)):resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({host,op,args}));
  });
  f.service.bridge=bridge;
  return {f,root,bridge,calls};
}

test('Portal to real node adapter: last complete personal version remains recoverable; negative namespaces are durable; restore creates a new generation',async t=>{
  const {f,root,bridge,calls}=await nativeFixture(t);
  const source=await bridge(hosts[0],'fixture.publish',{userId:principal.userId,hostAdmin:false});
  const original=join(root,hosts[0],'cache','.registry','personal',source.version+'.json');
  const registered=await readFile(original);
  const originalInode=(await stat(original)).ino;
  const r=await f.start({dataset:'personal',version:source.version,key:randomUUID()});
  assert.equal(r.result.state,'DELETED',JSON.stringify(r.result));
  await assert.rejects(readFile(original),e=>e.code==='ENOENT');
  const step=r.result.steps.find(s=>s.machine===hosts[0]);
  const retained=join(root,hosts[0],'cache','.trash','retire-'+step.operationId.replaceAll('-',''),'payload','ready','data','train.txt');
  assert.equal((await readFile(retained)).toString(),'actual complete recoverable bytes');
  for(const host of hosts){
    const fence=JSON.parse(await readFile(join(root,host,'cache','.retirements','personal',source.version+'.json')));
    assert.equal(fence.state,'ISOLATED');
  }
  const count=calls.length;await f.call('datasets.delete.status',{key:r.args.key});
  assert.ok(calls.slice(count).every(c=>c.op==='storage.dataset-delete.status'));
  assert.equal((await f.call('datasets.delete.restore',{operationId:r.first.operationId,machine:hosts[0]},admin)).state,'RESTORED');
  assert.deepEqual(await readFile(original),registered);
  assert.notEqual((await stat(original)).ino,originalInode,'restoration must persist a new registration generation');
  assert.equal((await readFile(join(root,hosts[0],'cache','ready','personal',source.version,'data','train.txt'))).toString(),'actual complete recoverable bytes');
  for(const host of hosts){
    const fence=JSON.parse(await readFile(join(root,host,'cache','.retirements','personal',source.version+'.json')));
    assert.equal(fence.state,host===hosts[0]?'RESTORED':'RELEASED');
  }
});

test('real authority grant used by two physical aliases is fully isolated before original revocation and never resurrected by restore',async t=>{
  const {f,root,bridge,calls}=await nativeFixture(t),sourceActor={userId:principal.userId,hostAdmin:false},adminActor={userId:admin.userId,hostAdmin:true};
  const source=await bridge(hosts[0],'fixture.publish',sourceActor);
  await bridge(hosts[0],'fixture.enable-authority',adminActor);
  const grant=await bridge(hosts[0],'fixture.seal',{...adminActor,version:source.version,targetMachine:hosts[1]});
  for(const dataset of ['replica-alias-one','replica-alias-two'])
    await bridge(hosts[1],'fixture.replicate',{...adminActor,grant,dataset,owner:principal.userId});
  const r=await f.start({dataset:'personal',version:source.version,key:randomUUID()});
  assert.equal(r.result.state,'DELETED',JSON.stringify(r.result));
  assert.equal(r.result.steps.length,hosts.length+2,'both actual aliases plus every base namespace are included');
  assert.equal(r.result.steps.filter(s=>s.complete).length,3,'all complete bytes remain retained');
  assert.doesNotMatch(JSON.stringify(r.result),/grantId|receiptSha256|authorityReferences|snapshotSha256|token/);
  const isolation=calls.filter(c=>c.op==='storage.dataset-delete.isolate');
  assert.equal(isolation.at(-1).host,hosts[0]);
  assert.deepEqual(isolation.at(-1).args.targets.filter(s=>s.complete).map(s=>s.dataset).sort(),['replica-alias-one','replica-alias-two']);
  for(const step of r.result.steps.filter(s=>s.complete)){
    const payload=join(root,step.machine,'cache','.trash','retire-'+step.operationId.replaceAll('-',''),'payload','ready','data','train.txt');
    assert.equal((await readFile(payload)).toString(),'actual complete recoverable bytes');
  }
  assert.equal((await bridge(hosts[0],'fixture.old-grant-denied',{...adminActor,grant})).denied,true);
  const count=calls.length;assert.equal((await f.call('datasets.delete.status',{key:r.args.key})).state,'DELETED');
  assert.ok(calls.slice(count).every(c=>c.op==='storage.dataset-delete.status'),'query never rewrites or replays any phase');
  assert.equal((await f.call('datasets.delete.restore',{operationId:r.first.operationId,machine:hosts[0]},admin)).state,'RESTORED');
  assert.equal((await bridge(hosts[0],'fixture.old-grant-denied',{...adminActor,grant})).denied,true);
  for(const step of r.result.steps.filter(s=>s.machine===hosts[1]&&s.complete)){
    assert.equal(JSON.parse(await readFile(join(root,step.machine,'cache','.retirements',step.dataset,source.version+'.json'))).state,'RESTORED');
    assert.equal((await readFile(join(root,step.machine,'cache','ready',step.dataset,source.version,'data/train.txt'))).toString(),'actual complete recoverable bytes');
    assert.equal((await f.service.bridge(step.machine,'datasets.prepare',{...sourceActor,dataset:step.dataset,version:source.version})).state,'READY');
  }
});

test('actual local CLI restore is recognized through current journal even though old node isolate phase remains saved',async t=>{
  const {f,root,bridge,calls}=await nativeFixture(t);
  const source=await bridge(hosts[0],'fixture.publish',{userId:principal.userId,hostAdmin:false});
  const r=await f.start({dataset:'personal',version:source.version,key:randomUUID()}),step=r.result.steps.find(s=>s.machine===hosts[0]);
  assert.equal(r.result.state,'DELETED');
  const restored=await bridge(hosts[0],'fixture.local-restore',{userId:admin.userId,hostAdmin:true,operationId:step.operationId});
  assert.equal(restored.state,'RESTORED');
  const oldPhase=JSON.parse(await readFile(join(root,hosts[0],'operations',step.operationId+'.isolate.result.json')));
  assert.equal(oldPhase.result.state,'ISOLATED');
  const count=calls.length,current=await f.call('datasets.delete.status',{key:r.args.key});
  assert.equal(current.state,'BLOCKED');assert.equal(current.steps.find(s=>s.machine===hosts[0]).state,'RESTORED');
  assert.ok(calls.slice(count).every(c=>c.op==='storage.dataset-delete.status'));
});

test('real cancel after lost target isolation restores full bytes and releases every node namespace',async t=>{
  const {f,root,bridge,calls}=await nativeFixture(t),actor={userId:principal.userId,hostAdmin:false};
  const source=await bridge(hosts[0],'fixture.publish',actor);let lost=true;
  f.service.bridge=async(host,op,args)=>{const result=await bridge(host,op,args);if(lost&&host===hosts[1]&&op.endsWith('.isolate')){lost=false;throw Error('lost isolated target reply');}return result;};
  const r=await f.start({dataset:'personal',version:source.version,key:randomUUID()});assert.equal(r.result.state,'UNKNOWN');
  await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  const result=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);assert.equal(result.state,'CANCELED',JSON.stringify(result));
  assert.equal((await readFile(join(root,hosts[0],'cache','ready','personal',source.version,'data/train.txt'))).toString(),'actual complete recoverable bytes');
  for(const host of hosts){const fence=JSON.parse(await readFile(join(root,host,'cache','.retirements','personal',source.version+'.json')));assert.equal(fence.state,'RELEASED');}
  assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
  assert.ok(calls.every(c=>c.op!=='datasets.unregister'));
});
test('complete independent transfer under another name is untouched by dataset deletion',async t=>{
  const {f,root,bridge,calls}=await nativeFixture(t),actor={userId:principal.userId,hostAdmin:false};
  const source=await bridge(hosts[0],'fixture.publish',actor);
  await bridge(hosts[1],'fixture.independent',{userId:admin.userId,hostAdmin:true,owner:principal.userId,dataset:'separate-copy'});
  const independent=join(root,hosts[1],'cache','ready','separate-copy',source.version,'data/train.txt'),before=await readFile(independent);
  const r=await f.start({dataset:'personal',version:source.version,key:randomUUID()});assert.equal(r.result.state,'DELETED',JSON.stringify(r.result));
  assert.deepEqual(await readFile(independent),before);
  assert.ok(!calls.some(c=>c.op.startsWith('storage.dataset-delete.')&&c.args.dataset==='separate-copy'));
  assert.equal(r.result.copyNotice,'其他名称下的副本不受影响');
});

test('cancel after actual authority original isolation restores every alias for preparation while old grants stay dead',async t=>{
  const {f,root,bridge,calls}=await nativeFixture(t),owner={userId:principal.userId,hostAdmin:false},administrator={userId:admin.userId,hostAdmin:true};
  const source=await bridge(hosts[0],'fixture.publish',owner);
  await bridge(hosts[0],'fixture.enable-authority',administrator);
  const grant=await bridge(hosts[0],'fixture.seal',{...administrator,version:source.version,targetMachine:hosts[1]});
  for(const dataset of ['replica-alias-one','replica-alias-two'])await bridge(hosts[1],'fixture.replicate',{...administrator,grant,dataset,owner:principal.userId});
  let lost=true;
  f.service.bridge=async(host,op,args)=>{
    const result=await bridge(host,op,args);
    if(lost&&host===hosts[0]&&op.endsWith('.isolate')){lost=false;throw Error('original isolation response lost');}
    return result;
  };
  const r=await f.start({dataset:'personal',version:source.version,key:randomUUID()});
  // Read-only status confirms late isolation, but no collection commit was
  // dispatched after the lost reply. It must not claim DELETED.
  assert.equal(r.result.state,'WAITING_CONTINUE');assert.equal(r.result.canContinue,true);assert.ok(r.result.steps.every(step=>step.state==='ISOLATED'));
  assert.equal(calls.filter(call=>call.op==='storage.dataset-delete.commit').length,0);
  assert.equal((await bridge(hosts[0],'fixture.old-grant-denied',{...administrator,grant})).denied,true);
  await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  const result=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);assert.equal(result.state,'CANCELED',JSON.stringify(result));
  for(const [host,dataset] of [[hosts[0],'personal'],[hosts[1],'replica-alias-one'],[hosts[1],'replica-alias-two']]){
    assert.equal((await readFile(join(root,host,'cache','ready',dataset,source.version,'data/train.txt'))).toString(),'actual complete recoverable bytes');
    assert.equal((await f.service.bridge(host,'datasets.prepare',{...owner,dataset,version:source.version})).state,'READY');
  }
  assert.equal((await bridge(hosts[0],'fixture.old-grant-denied',{...administrator,grant})).denied,true);
  assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
  assert.ok(calls.every(call=>call.op!=='datasets.unregister'));
});
