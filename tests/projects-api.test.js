import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const release='a'.repeat(64),password='Project-Test-Long-Password-2026';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'gpuq-project-api-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
 const calls=[];let ready=true;
 const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args});if(operation==='projects.verify')return {project:args.project,release:args.release,state:ready?'READY':'DRAFT'};if(operation.startsWith('projects.'))return {project:args.project,state:'DRAFT',releases:[],latestReadyRelease:null};if(operation==='sync')return {state:'RUNNING',nodeJobId:'node-'+args.job.id};return {entries:[]};};
 const service=await PortalService.open(join(dir,'db'),bootstrap,status,bridge);clearInterval(service.executionTimer);
 const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
 await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{'gpu-1':2}});
 const user=await service.login('alice',password),other=(await service.invoke(admin.token,'users.create',{username:'other',password})).result;
 await service.invoke(admin.token,'policy.save',{userId:other.id,policyVersion:0,total:2,limits:{'gpu-1':2}});
 const otherLogin=await service.login('other',password);
 const call=(op,args={},token=user.token)=>service.invoke(token,op,{machine:'gpu-1',...args});
 const settle=async()=>{await new Promise(r=>setImmediate(r));while(service.reconciling)await new Promise(r=>setTimeout(r,2));};
 return {service,calls,user,admin,member,otherLogin,call,ready:v=>ready=v,settle,close:async()=>{await settle();service.close();await rm(dir,{recursive:true,force:true});}};
}
test('project operations bind authenticated owner and explicit node without reserving GPUs',async()=>{
 const f=await fixture();try{
  for(const op of ['projects.list','projects.create','projects.status','projects.publish']){
   await f.call(op,op==='projects.list'?{}:{project:'my-project'});
   const sent=f.calls.at(-1);assert.equal(sent.machine,'gpu-1');assert.equal(sent.args.userId,f.member.id);assert.equal(sent.args.hostAdmin,undefined);
  }
  assert.equal(f.service.store.jobs.length,0);
  for(const extra of [{userId:'builtin-admin'},{path:'/root'},{hostAdmin:true},{release}])await assert.rejects(f.call('projects.create',{project:'my-project',...extra}));
  await assert.rejects(f.call('projects.list',{machine:'gpu-2'}),e=>e.status===403);
  await assert.rejects(f.call('projects.verify',{project:'my-project',release}));
 }finally{await f.close();}
});
test('project jobs pin one release and verify it before quota reservation',async()=>{
 const f=await fixture();try{
  const args={project:'my-project',release,cards:1,argv:['python','train.py'],key:randomUUID()};
  f.ready(false);await assert.rejects(f.call('jobs.submit',args),e=>e.status===409);assert.equal(f.service.store.jobs.length,0);
  f.ready(true);const result=(await f.call('jobs.submit',args)).result;await f.settle();
  assert.equal(result.project,'my-project');assert.equal(result.release,release);assert.equal(f.calls.find(c=>c.operation==='sync').args.job.release,release);
  assert.equal((await f.call('jobs.submit',args)).result.id,result.id);
  await assert.rejects(f.call('jobs.submit',{...args,release:'b'.repeat(64)}),e=>e.status===409);
  for(const bad of [{project:undefined},{release:undefined},{project:'../bad'},{release:'latest'}])await assert.rejects(f.call('jobs.submit',{...args,key:randomUUID(),...bad}));
 }finally{await f.close();}
});
test('project terminal forbids host-root combination and retains context on all operations',async()=>{
 const f=await fixture();try{
  for(const operation of ['terminal.open','terminal.exchange','terminal.close']){
   await f.call(operation,{project:'my-project',key:randomUUID(),id:randomUUID()});
   assert.equal(f.calls.at(-1).args.project,'my-project');assert.equal(f.calls.at(-1).args.userId,f.member.id);
  }
  await assert.rejects(f.call('terminal.open',{project:'my-project',key:randomUUID(),hostAdmin:true},f.admin.token));
 }finally{await f.close();}
});
test('project outputs require same authenticated owner, machine, project and job',async()=>{
 const f=await fixture();try{
  const job=(await f.call('jobs.submit',{project:'my-project',release,cards:1,argv:['true'],key:randomUUID()})).result;await f.settle();
  const args={project:'my-project',area:'output',runId:job.id,path:'.'};
  await f.call('files.list',args);
  for(const token of [f.admin.token,f.otherLogin.token])await assert.rejects(f.call('files.list',args,token),e=>e.status===403);
  await assert.rejects(f.call('files.put',args));
  await assert.rejects(f.call('files.list',{...args,project:'other-project'}),e=>e.status===403);
  await assert.rejects(f.call('files.list',{...args,runId:undefined}));
  await assert.rejects(f.call('files.list',{...args,project:undefined}));
  await assert.rejects(f.call('files.put',{project:'my-project',truncate:true}));
 }finally{await f.close();}
});
