import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const handle='11111111-1111-4111-8111-111111111111';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function fixture(t,bridge,{role='admin'}={}){
 const dir=await mkdtemp(join(tmpdir(),'remote-read-')),bootstrap=join(dir,'bootstrap');
 const password='Remote-Read-Only-Fixture-2026!';
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 const service=await PortalService.open(join(dir,'database'),bootstrap,undefined,bridge);
 for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);
 service.store.users[0].limits=Object.fromEntries(MACHINES.map(m=>[m.id,m.cards]));service.store.users[0].total=100;
 service.store.users[0].role=role;
 const {token}=await service.login('admin',password);
 t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
 return {service,token,user:service.store.users[0]};
}
const args=machine=>({machine,id:handle});
const uploadArgs=machine=>({machine,project:'paper',path:'src/train.py',totalSize:1,sha256:'a'.repeat(64)});
test('host/upload status bypass a stalled global mutation tail, without dashboard recomputation',async t=>{
 const calls=[],{service,token}=await fixture(t,async(machine,operation,request)=>{calls.push({machine,operation,request});return {state:'COMPLETE'};});
 const blocked=deferred(),write=service.enqueue(()=>blocked.promise);await Promise.resolve();
 try{
  const host=await service.invoke(token,'host.status',args('gpu-1'));
  const upload=await service.invoke(token,'files.upload.status',{machine:'gpu-2',project:'paper',path:'src/train.py',totalSize:1,sha256:'a'.repeat(64)});
  assert.equal(host.result.state,'COMPLETE');assert.equal(upload.result.state,'COMPLETE');
  assert.equal(Object.hasOwn(host,'state'),false);assert.equal(Object.hasOwn(upload,'state'),false);
  assert.equal(service.pending,1);assert.deepEqual(calls.map(x=>x.operation),['host.status','files.upload.status']);
 }finally{blocked.resolve();await write;}
});
test('file reads bypass a stalled write tail and retain the exact download fingerprint',async t=>{
 const calls=[],{service,token}=await fixture(t,async(machine,operation,request)=>{calls.push({machine,operation,request});return {data:'YQ=='};});
 const blocked=deferred(),write=service.enqueue(()=>blocked.promise);await Promise.resolve();
 try{
  const fingerprint='a'.repeat(64),result=await service.invoke(token,'files.get',{machine:'gpu-1',project:'paper',path:'result.bin',offset:2,fingerprint});
  await service.invoke(token,'files.list',{machine:'gpu-2',project:'paper',path:'.'});
  assert.equal(result.result.data,'YQ==');assert.equal(Object.hasOwn(result,'state'),false);
  assert.equal(service.pending,1);assert.deepEqual(calls.map(value=>value.operation),['files.get','files.list']);
  assert.equal(calls[0].request.fingerprint,fingerprint);assert.equal(calls[0].request.offset,2);
 }finally{blocked.resolve();await write;}
});
for(const change of ['disabled','machine','logout'])test('file content is not disclosed after '+change+' during read',async t=>{
 const blocked=deferred(),{service,token,user}=await fixture(t,()=>blocked.promise,{role:'member'});
 const read=service.invoke(token,'files.get',{machine:'gpu-1',project:'paper',path:'result.bin',offset:0});await Promise.resolve();
 if(change==='disabled')user.enabled=false;
 if(change==='machine')user.limits['gpu-1']=0;
 if(change==='logout')service.revokeSession(token);
 blocked.resolve({data:'private'});
 await assert.rejects(read,error=>[401,403].includes(error.status));assert.equal(service.remoteReadPending,0);
});
test('file mutations stay serialized and are sent once after the mutation tail drains',async t=>{
 const calls=[],{service,token}=await fixture(t,async(machine,operation)=>{calls.push(operation);return {size:1,complete:true};});
 const blocked=deferred(),write=service.enqueue(()=>blocked.promise);await Promise.resolve();
 const upload=service.invoke(token,'files.put',{machine:'gpu-1',path:'x.py',data:'YQ==',offset:0,truncate:true});
 await Promise.resolve();assert.deepEqual(calls,[]);assert.equal(service.pending,2);
 blocked.resolve();await write;await upload;assert.deepEqual(calls,['files.put']);
});
test('read admission is bounded per node and globally; it does not create another wait queue',async t=>{
 const blocked=deferred(),{service,token}=await fixture(t,()=>blocked.promise);
 const reads=[service.invoke(token,'host.status',args('gpu-1')),service.invoke(token,'host.status',args('gpu-1')),
  service.invoke(token,'host.status',args('gpu-2')),service.invoke(token,'host.status',args('gpu-2'))];
 await assert.rejects(service.invoke(token,'host.status',args('gpu-1')),e=>e.status===429);
 await assert.rejects(service.invoke(token,'host.status',args('gpu-3')),e=>e.status===429);
 assert.equal(service.remoteReadPending,4);blocked.resolve({state:'RUNNING'});await Promise.all(reads);
 assert.equal(service.remoteReadPending,0);assert.equal(service.remoteReadMachines.size,0);
});
for(const change of ['disabled','machine','role','logout'])test('revocation before reply fences '+change+' and discloses no remote result',async t=>{
 const blocked=deferred(),{service,token,user}=await fixture(t,()=>blocked.promise,{role:change==='machine'?'member':'admin'});
 const read=service.invoke(token,change==='machine'?'files.upload.status':'host.status',change==='machine'?uploadArgs('gpu-1'):args('gpu-1'));await Promise.resolve();
 if(change==='disabled')user.enabled=false;
 if(change==='machine')user.limits['gpu-1']=0;
 if(change==='role')user.role='member';
 if(change==='logout')service.revokeSession(token);
 blocked.resolve({private:'must-not-escape'});
 await assert.rejects(read,e=>[401,403].includes(e.status)&&!e.message.includes('must-not-escape'));
 assert.equal(service.remoteReadPending,0);
});
test('revocation while admission waits for its first microtask sends no request',async t=>{
 const calls=[],{service,token,user}=await fixture(t,async(...args)=>{calls.push(args);return {};},{role:'member'});
 const read=service.invoke(token,'files.upload.status',uploadArgs('gpu-1'));user.limits['gpu-1']=0;
 await assert.rejects(read,e=>e.status===403);assert.deepEqual(calls,[]);assert.equal(service.remoteReadPending,0);
});
test('revocation suppresses private remote failure details as well as successful output',async t=>{
 const blocked=deferred(),{service,token}=await fixture(t,()=>blocked.promise);
 const read=service.invoke(token,'host.status',args('gpu-1'));await Promise.resolve();
 service.revokeSession(token);blocked.reject(Error('PRIVATE remote command output'));
 await assert.rejects(read,e=>e.status===401&&!e.message.includes('PRIVATE'));
 assert.equal(service.remoteReadPending,0);
});
test('a six-by-30-second mutation backlog cannot impose the old 180-second status wait',async t=>{
 const {service,token}=await fixture(t,async()=>({state:'SUCCEEDED'}));
 t.mock.timers.enable({apis:['setTimeout']});
 const writes=Array.from({length:6},()=>service.enqueue(()=>new Promise(resolve=>setTimeout(resolve,30000))));
 await Promise.resolve();
 const result=await service.invoke(token,'host.status',args('gpu-1'));
 assert.equal(result.result.state,'SUCCEEDED');assert.equal(service.pending,6);
 for(let index=0;index<6;index++){t.mock.timers.tick(30000);await new Promise(setImmediate);}
 await Promise.all(writes);assert.equal(service.pending,0);
});
test('snapshot args cannot be rerouted after admission and failure keeps status without replay',async t=>{
 const calls=[],failure=Object.assign(Error('fixed transient'),{status:503,code:'NODE_CONNECT_FAILED'});
 const {service,token}=await fixture(t,async(machine)=>{calls.push(machine);throw failure;});
 const request=args('gpu-1'),read=service.invoke(token,'host.status',request);request.machine='gpu-2';
 await assert.rejects(read,e=>e===failure);assert.deepEqual(calls,['gpu-1']);assert.equal(service.remoteReadPending,0);
});
test('elapsed read deadline rejects, retains in-flight capacity, and never replays on late completion',async t=>{
 const blocked=deferred(),calls=[],{service,token}=await fixture(t,(...args)=>{calls.push(args);return blocked.promise;});
 t.mock.timers.enable({apis:['setTimeout']});
 const read=service.invoke(token,'host.status',args('gpu-1'));await Promise.resolve();
 t.mock.timers.tick(35001);await assert.rejects(read,e=>e.status===504&&e.code==='NODE_READ_TIMEOUT');
 assert.equal(service.remoteReadPending,1);assert.equal(calls.length,1);
 blocked.resolve({state:'SUCCEEDED'});await new Promise(setImmediate);
 assert.equal(service.remoteReadPending,0);assert.equal(calls.length,1);
});
test('member host status and unknown machines are rejected before any bridge dispatch',async t=>{
 const calls=[],{service,token,user}=await fixture(t,async(...args)=>{calls.push(args);return {};});
 await assert.rejects(service.invoke(token,'host.status',args('unknown')),e=>e.status===403);
 user.role='member';await assert.rejects(service.invoke(token,'host.status',args('gpu-1')),e=>[401,403].includes(e.status));
 assert.deepEqual(calls,[]);
});
