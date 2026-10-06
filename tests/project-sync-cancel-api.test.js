import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {snapshotSyncCall} from '../snapshot-sync.mjs';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const principal={userId:'fixture-owner',username:'fixture',role:'member'},user={id:principal.userId};
const args=()=>({machine:'fixture-node',project:'draft',key:randomUUID(),snapshotId:randomUUID(),source:{kind:'release',machine:'offline-source',project:'origin',release:'a'.repeat(64)},manifestSha256:'b'.repeat(64),revision:'c'.repeat(64)});

test('cancel derives target owner, preserves exact source proof, never reads or requires an offline source',async()=>{
  const calls=[],audits=[],value=args(),service={bridge:async(machine,operation,request)=>{calls.push({machine,operation,request});return {state:'CANCELED',preservesBytes:true};},audit:(...values)=>audits.push(values)};
  const auth=machine=>{assert.equal(machine,'fixture-node');};
  const result=await snapshotSyncCall(service,principal,user,'projects.sync.cancel',value,auth);
  assert.equal(result.state,'CANCELED');assert.deepEqual(calls,[{machine:'fixture-node',operation:'projects.sync.cancel',request:{...Object.fromEntries(Object.entries(value).filter(([key])=>key!=='machine')),userId:principal.userId}}]);
  assert.deepEqual(audits,[['fixture','projects.sync.cancel','fixture-node','draft']]);
  assert.equal(Object.hasOwn(calls[0].request,'hostAdmin'),false);
});

test('cancel rejects identity overrides, unknown fields and incomplete/stale-shaped proof before bridge',async()=>{
  const value=args(),service={bridge:()=>{throw Error('must not dispatch');},audit(){}};
  for(const extra of [{userId:'other'},{hostAdmin:true},{force:true},{path:'x'},{snapshotId:'../snapshot'},{revision:1},{manifestSha256:'latest'},{source:{kind:'git',commit:'HEAD'}},{source:{...value.source,path:'/host'}}])await assert.rejects(snapshotSyncCall(service,principal,user,'projects.sync.cancel',{...value,...extra},()=>{}));
  for(const field of ['snapshotId','source','manifestSha256','revision']){const copy={...value};delete copy[field];await assert.rejects(snapshotSyncCall(service,principal,user,'projects.sync.cancel',copy,()=>{}));}
  assert.equal(await snapshotSyncCall(service,principal,user,'projects.sync.force-cancel',value,()=>{}),undefined,'Unknown operation stays outside this handler and cannot dispatch');
});

test('failed or ambiguous node cancellation is not replayed by the boundary',async()=>{
  let calls=0;const service={bridge:async()=>{calls++;throw Error('lost acknowledgement');},audit(){}};
  await assert.rejects(snapshotSyncCall(service,principal,user,'projects.sync.cancel',args(),()=>{}),/lost acknowledgement/);assert.equal(calls,1);
});

test('normal Portal API rechecks current grant/role, and maintenance still permits only status/cancel',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-sync-cancel-api-')),bootstrap=join(dir,'bootstrap'),password='Fixture-Cancel-2026!',calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(machine,operation,request)=>{calls.push({machine,operation,request});return {state:'CANCELED',preservesBytes:true};});
  clearInterval(service.executionTimer);t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result,machine=MACHINES[0].id;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[machine]:1}});const login=await service.login('alice',password),value={...args(),machine};
  await service.invoke(login.token,'projects.sync.cancel',value);assert.equal(calls.length,1);assert.equal(calls[0].request.userId,member.id);
  await assert.rejects(service.invoke(login.token,'projects.sync.force-cancel',value));assert.equal(calls.length,1);
  await assert.rejects(service.invoke(login.token,'projects.sync.cancel',{...value,machine:MACHINES[1].id}),e=>e.status===403);assert.equal(calls.length,1);
  const maintenance=(await service.invoke(admin.token,'maintenance.status',{})).result;
  await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:true,reason:'Fixture only',revision:maintenance.revision});
  await service.invoke(login.token,'projects.sync.status',{machine,project:value.project,key:value.key});
  await service.invoke(login.token,'projects.sync.cancel',value);assert.equal(calls.length,3);
  await assert.rejects(service.invoke(login.token,'projects.sync.seal',{machine,project:value.project,key:value.key}),e=>e.code==='MAINTENANCE_ACTIVE');assert.equal(calls.length,3);
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:1,total:0,limits:{}});
  await assert.rejects(service.invoke(login.token,'projects.sync.cancel',value),e=>e.status===403);assert.equal(calls.length,3);
});
