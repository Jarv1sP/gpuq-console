import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
import {DemoClient} from '../dist/client.js';
import {MACHINES} from '../dist/model.js';

const password='Workspace-Read-Test-Password-2026!';
const chunk=Buffer.alloc(1024**2,42).toString('base64');
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-workspace-read-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(machine=>({id:machine.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const calls=[];let handle=async()=>({path:'incoming/sample.bin',offset:0,data:chunk,eof:true,size:1024**2});
  const service=await PortalService.open(join(dir,'db'),bootstrap,status,async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});return handle(machine,operation,args);
  });
  clearInterval(service.executionTimer);
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const user=await service.login('alice',password);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {service,calls,admin,user,member,respond:fn=>handle=fn};
}

test('one MiB personal reads omit the dashboard but retain exact result and trusted identity for both roles',async t=>{
  const f=await fixture(t),buildState=f.service.state;
  let stateCalls=0;f.service.state=()=>{stateCalls++;throw Error('dashboard must not be built for a data chunk');};
  for(const login of [f.user,f.admin]){
    const result=await f.service.invoke(login.token,'datasets.workspace.get',{machine:'gpu-1',path:'incoming/sample.bin',offset:0});
    assert.deepEqual(Object.keys(result).sort(),['principal','result']);
    assert.deepEqual(result.principal,login.principal);assert.equal(result.result.data,chunk);
    assert.equal(Buffer.from(result.result.data,'base64').length,1024**2);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<1400000);
    assert.deepEqual(f.calls.at(-1),{machine:'gpu-1',operation:'datasets.workspace.get',args:{path:'incoming/sample.bin',offset:0,userId:login.principal.userId,hostAdmin:false}});
  }
  assert.equal(stateCalls,0);assert.equal(f.service.store.jobs.length,0);f.service.state=buildState;
});

test('workspace siblings retain full state while ordinary file bodies refuse without dispatch',async t=>{
  const f=await fixture(t),buildState=f.service.state;let stateCalls=0;
  f.service.state=function(principal){stateCalls++;return buildState.call(this,principal);};
  f.respond(async()=>({path:'incoming/sample.bin',size:1,entries:[]}));
  const out=await f.service.invoke(f.user.token,'datasets.workspace.list',{machine:'gpu-1',path:'.'});
  assert.ok(out.state);assert.equal(out.principal.userId,f.member.id);
  const beforeFile=f.calls.length;
  await assert.rejects(f.service.invoke(f.user.token,'files.get',{machine:'gpu-1',path:'sample.bin',offset:0}),error=>error.status===410&&error.code==='CAMPUS_FILE_REQUIRED');
  assert.equal(f.calls.length,beforeFile);
  assert.equal(stateCalls,1);
  const before=f.calls.length;
  await assert.rejects(f.service.invoke(f.user.token,'datasets.workspace.put',{machine:'gpu-1',path:'incoming/sample.bin',offset:0,data:'Kg==',truncate:false}),error=>error.status===409&&error.code==='CAMPUS_DATA_PLANE_REQUIRED');
  assert.equal(f.calls.length,before);assert.equal(stateCalls,1);
});

test('the slim reply does not bypass authentication, machine grants, path or actor validation',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.invoke('invalid','datasets.workspace.get',{machine:'gpu-1',path:'incoming/sample.bin',offset:0}),e=>e.status===401);
  for(const extra of [{machine:'gpu-2'},{userId:'builtin-admin'},{hostAdmin:true},{path:'/root/key'},{path:'../private'},{offset:-1},{offset:'0'},{data:'Kg=='},{operation:'files.get'}]){
    await assert.rejects(f.service.invoke(f.user.token,'datasets.workspace.get',{machine:'gpu-1',path:'incoming/sample.bin',offset:0,...extra}));
  }
  assert.equal(f.calls.length,0);
  f.service.revokeSession(f.user.token);
  await assert.rejects(f.service.invoke(f.user.token,'datasets.workspace.get',{machine:'gpu-1',path:'incoming/sample.bin',offset:0}),e=>e.status===401);
  assert.equal(f.calls.length,0);
});

test('data reads retain the existing serialized dispatch queue and maintenance gate',async t=>{
  const f=await fixture(t),started=deferred(),released=deferred();
  f.respond(async()=>{started.resolve();await released.promise;return {data:chunk};});
  const first=f.service.invoke(f.user.token,'datasets.workspace.get',{machine:'gpu-1',path:'incoming/sample.bin',offset:0});
  await started.promise;
  const second=f.service.invoke(f.user.token,'datasets.workspace.list',{machine:'gpu-1',path:'.'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,1);
  released.resolve();await first;await second;assert.equal(f.calls.length,2);
  f.service.assertMaintenanceAllowed=()=>{throw Object.assign(Error('maintenance'),{status:503});};
  await assert.rejects(f.service.invoke(f.user.token,'datasets.workspace.get',{machine:'gpu-1',path:'incoming/sample.bin',offset:0}),e=>e.status===503);
  assert.equal(f.calls.length,2);
});

test('result-only chunks leave the browser cache intact and still pass through the acceptance fence',async()=>{
  const client=new DemoClient(),cached={users:[{id:'alice'}],jobs:[{id:'old-job'}]};
  client.token='alice-token';client.principal={username:'alice',userId:'alice',role:'member'};client.data=cached;
  const result={path:'incoming/sample.bin',data:'Kg==',offset:0,eof:true,size:1};let accepted;
  client.service={invoke:async()=>({result,principal:{...client.principal}})};
  assert.equal(await client.call('datasets.workspace.get',{}, {accept:value=>accepted=value}),result);
  assert.equal(client.data,cached);assert.equal(accepted,result);assert.equal(client.principal.userId,'alice');
});

test('a delayed result-only read is rejected across an auth generation transition before cache, principal or acceptance change',async()=>{
  const client=new DemoClient(),gate=deferred(),cached={users:[{id:'alice'}],jobs:[]};let accepted=false;
  client.token='alice-token';client.principal={username:'alice',userId:'alice',role:'member'};client.data=cached;
  client.service={invoke:()=>gate.promise};
  const read=client.call('datasets.workspace.get',{}, {accept:()=>accepted=true});
  const rejected=assert.rejects(read,error=>error.code==='STALE_SESSION');
  client.authGeneration++;client.token='bob-token';client.principal={username:'bob',userId:'bob',role:'member'};client.data={users:[{id:'bob'}],jobs:[]};
  gate.resolve({result:{data:'private-alice'},principal:{username:'alice',userId:'alice',role:'member'}});
  await rejected;assert.equal(accepted,false);assert.equal(client.principal.userId,'bob');assert.equal(client.data.users[0].id,'bob');
});
