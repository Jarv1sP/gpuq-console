import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const password='Task-Metadata-Fixture-Only-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-task-metadata-api-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));const calls=[];let nativeJobs=[];
  const snapshot=()=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,memoryTotalMiB:32768,processesAvailable:true,processes:nativeJobs.length&&index===0?[{pid:42,owner:'private-os-owner',name:'python',memoryUsedMiB:100,scheduling:{jobId:nativeJobs[0].id,priority:2}}]:[]})),gpuq:{connected:true,jobs:m.id==='gpu-1'?nativeJobs:[]}}))}));
  await snapshot();
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args:structuredClone(args)});if(operation==='logs')return {text:'private logs'};return {nodeJobId:'J'+args.job.id,state:'RUNNING',assignedIndices:[0]};};
  let s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);clearInterval(s.maintenanceTimer);
  let a=await s.login('admin',password);
  const owner=(await s.invoke(a.token,'users.create',{username:'alice',name:'张三',password})).result,observer=(await s.invoke(a.token,'users.create',{username:'bob',name:'李四',password})).result;
  for(const u of [owner,observer])await s.invoke(a.token,'policy.save',{userId:u.id,policyVersion:0,total:2,limits:{'gpu-1':2}});
  let member=await s.login('alice',password),other=await s.login('bob',password);
  const settle=async()=>{await new Promise(r=>setImmediate(r));while(s.reconciling)await new Promise(r=>setTimeout(r,5));};
  t.after(async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});});
  const submit=(extra={})=>s.invoke(member.token,'jobs.submit',{machine:'gpu-1',cards:1,name:'正常训练名',description:'数据集 A 的消融\n预计两小时',key:randomUUID(),argv:['python','train.py','--token','SECRET-FIXTURE-ARGV'],...extra}).then(r=>r.result);
  return {get s(){return s},get a(){return a},get member(){return member},get other(){return other},owner,observer,calls,submit,settle,snapshot,
    publish:async job=>{nativeJobs=[{id:job.nodeJobId,name:'portal-wrapper',owner:'internal-native-owner',state:'RUNNING',priority:2,gpu_count:1,assigned_gpu_indices:[0]}];await snapshot();await s.refreshGPUQ();},
    reopen:async()=>{await settle();s.close();s=await PortalService.open(database,undefined,status,bridge);clearInterval(s.executionTimer);clearInterval(s.maintenanceTimer);a=await s.login('admin',password);member=await s.login('alice',password);other=await s.login('bob',password);}
  };
}
test('same-machine members see submitter name/description but no command, logs or task-control authority',async t=>{
  const f=await fixture(t);await f.submit();await f.settle();const job=f.s.store.jobs[0];await f.publish(job);
  const observed=(await f.s.invoke(f.other.token,'state')).state;
  assert.equal(observed.jobs.length,0);assert.equal(observed.users.length,1);
  const task=observed.gpuq.hosts[0].tasks.find(t=>t.id===job.id);assert.equal(task.name,'正常训练名');assert.equal(task.submitter.name,'张三');assert.equal(task.description,'数据集 A 的消融\n预计两小时');
  assert.equal(observed.gpuq.hosts[0].gpus[0].processes[0].task.id,job.id);
  for(const privateText of ['SECRET-FIXTURE-ARGV','private-os-owner','internal-native-owner','private logs','argv'])assert.ok(!JSON.stringify(observed).includes(privateText),privateText);
  for(const operation of ['jobs.logs','jobs.cancel','jobs.watch'])await assert.rejects(f.s.invoke(f.other.token,operation,{jobId:job.id}),e=>e.status===403);
  assert.equal((await f.s.invoke(f.member.token,'jobs.logs',{jobId:job.id})).result.text,'private logs');
  await f.s.invoke(f.a.token,'policy.save',{userId:f.observer.id,policyVersion:1,total:0,limits:{}});
  assert.equal((await f.s.invoke(f.other.token,'state')).state.gpuq.hosts.length,0);
});
test('profile edits persist without changing login/role/grants, and new/old job identities remain distinguishable',async t=>{
  const f=await fixture(t),initial=f.s.store.get(f.owner.id);const original=await f.submit();await f.settle();
  const result=await f.s.invoke(f.member.token,'profile.update',{name:'张三新姓名'});assert.equal(result.result.username,'alice');assert.equal(result.result.role,'member');assert.deepEqual(result.result.limits,initial.limits);
  for(const injected of [{userId:f.observer.id,name:'伪造'},{role:'admin',name:'伪造'},{username:'changed',name:'伪造'}])await assert.rejects(f.s.invoke(f.member.token,'profile.update',injected));
  const created=await f.submit({name:'第二项训练',description:'新任务说明'});assert.equal(created.submitter.name,'张三新姓名');assert.equal(original.submitter.name,'张三');
  await f.reopen();const state=(await f.s.invoke(f.member.token,'state')).state;
  assert.equal(state.users[0].name,'张三新姓名');assert.equal(state.jobs.find(j=>j.id===original.id).submitter.name,'张三');assert.equal(state.jobs.find(j=>j.id===created.id).description,'新任务说明');
  const save=f.s.save;f.s.save=()=>{throw Error('profile-save-fault');};await assert.rejects(f.s.invoke(f.member.token,'profile.update',{name:'不应保存'}),/profile-save-fault/);f.s.save=save;
  assert.equal(f.s.store.get(f.owner.id).name,'张三新姓名');
});
test('metadata failures neither reserve quota nor dispatch, new descriptions bind retry identity and old retries remain compatible',async t=>{
  const f=await fixture(t);for(const extra of [{description:null},{description:'x'.repeat(2001)},{submitterName:'other'}])await assert.rejects(f.submit(extra));assert.equal(f.calls.length,0);assert.equal(f.s.store.jobs.length,0);
  const key=randomUUID(),original=await f.submit({key});await f.settle();
  await f.s.invoke(f.member.token,'profile.update',{name:'后来的姓名'});
  assert.equal((await f.submit({key})).id,original.id);await assert.rejects(f.submit({key,description:'另一个说明'}),e=>e.status===409);
  assert.equal(f.s.store.jobs.length,1);assert.equal(f.calls.filter(c=>c.operation==='sync').length,1);
  const before=f.s.store.jobs.length,save=f.s.save;f.s.save=()=>{throw Error('metadata-save-fault');};await assert.rejects(f.submit({description:'需要原子保存'}),/metadata-save-fault/);f.s.save=save;assert.equal(f.s.store.jobs.length,before);
});
test('registration accepts a separate name, cannot forge privileges, and failed registration retains invite count',async t=>{
  const f=await fixture(t),code=(await f.s.invoke(f.a.token,'invites.rotate',{role:'member'})).result.code;
  await f.s.register({username:'new-member',name:'王五',password,invite:code});const signed=await f.s.login('new-member',password);assert.equal(signed.state.users[0].name,'王五');assert.equal(signed.principal.role,'member');
  const count=f.s.invitations()[0].uses;await assert.rejects(f.s.register({username:'invalid-name',name:'',password,invite:code}));assert.equal(f.s.invitations()[0].uses,count);
  await assert.rejects(f.s.register({username:'forged',name:'王六',password,invite:code,role:'admin'}));
});
