import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './maintenance-fixture.mjs';
import {MACHINES} from '../dist/model.js';
import {recoveryPlan,executeRecovery,recoveryChecks,maintenanceBlocks} from '../dist/maintenance-state.js';

test('global staged recovery protects remaining machines first and carries real CAS revisions',async t=>{
  const f=await fixture(t),ids=MACHINES.map(machine=>machine.id);
  let state=await f.call('set',{scope:ids[0],enabled:true,reason:'原有单机原因',revision:0},f.admin.token);
  state=await f.call('set',{scope:'all',enabled:true,reason:'全局原因',revision:state.revision},f.admin.token);
  const plan=recoveryPlan(state,MACHINES,[ids[0],ids[1]]),calls=[];
  const result=await executeRecovery(plan,async(operation,args)=>{
    calls.push({operation,args});const result=await f.call('set',args,f.admin.token);
    for(const id of ids.slice(2))assert.ok(f.service.maintenanceFor(id),'remaining server never loses admission protection');
    if(args.scope!=='all')assert.ok(result.global,'global lock stays on until the last step');
    return result;
  });
  assert.deepEqual(calls.map(call=>[call.args.scope,call.args.enabled]),[[ids[2],true],[ids[3],true],[ids[0],false],['all',false]]);
  assert.deepEqual(calls.map(call=>call.args.revision),[2,3,4,5]);assert.equal(result.revision,6);
  for(const id of ids.slice(0,2))assert.equal(f.service.maintenanceFor(id),null);
  for(const id of ids.slice(2))assert.equal(f.service.maintenanceFor(id).reason,'全局原因');
});
test('independent maintenance reasons and nonselected scopes survive a partial recovery',async t=>{
  const f=await fixture(t),ids=MACHINES.map(machine=>machine.id);
  let state=await f.call('set',{scope:ids[1],enabled:true,reason:'单机维修',revision:0},f.admin.token);
  const original=structuredClone(state.machines[ids[1]]);
  state=await f.call('set',{scope:'all',enabled:true,reason:'平台维护',revision:1},f.admin.token);
  await executeRecovery(recoveryPlan(state,MACHINES,[ids[0]]),(operation,args)=>f.call('set',args,f.admin.token));
  state=await f.call('status',{},f.admin.token);assert.deepEqual(state.machines[ids[1]],original);
  const plan=recoveryPlan(state,MACHINES,[ids[2]]);assert.deepEqual(plan.steps,[{scope:ids[2],enabled:false}]);
  await executeRecovery(plan,(operation,args)=>f.call('set',args,f.admin.token));
  assert.equal(f.service.maintenanceFor(ids[2]),null);assert.deepEqual((await f.call('status',{},f.admin.token)).machines[ids[1]],original);
});
test('conflict after one applied step stops, exposes that step, and leaves global admission closed',async t=>{
  const f=await fixture(t),ids=MACHINES.map(machine=>machine.id);
  const state=await f.call('set',{scope:'all',enabled:true,reason:'诊断',revision:0},f.admin.token),calls=[];
  await assert.rejects(executeRecovery(recoveryPlan(state,MACHINES,[ids[0]]),async(operation,args)=>{
    calls.push(args);if(calls.length===2)await f.call('set',{scope:ids[0],enabled:true,reason:'另一窗口',revision:2},f.admin.token);
    return f.call('set',args,f.admin.token);
  }),error=>{assert.equal(error.status,409);assert.match(error.message,/维护状态已由其他窗口修改，请刷新后确认/);assert.deepEqual(error.applied,[{scope:ids[1],enabled:true,reason:'诊断',revision:2}]);return true;});
  assert.equal(calls.length,2);assert.equal((await f.call('status',{},f.admin.token)).revision,3);assert.ok(f.service.globalMaintenanceActive());
});
test('required recovery checks fail closed on stale, unreachable or UNKNOWN observations; ROOT is a warning',()=>{
  const data={gpuq:{stale:false,checkedAt:new Date().toISOString(),hosts:[{id:'gpu-1',reachable:true,gpuq:{connected:true}}]},jobs:[]};
  assert.equal(recoveryChecks(data,'gpu-1',[{machine:'gpu-1',hostAdmin:true}]).ready,true);
  assert.equal(recoveryChecks({...data,gpuq:{...data.gpuq,stale:true}},'gpu-1').ready,false);
  data.gpuq.hosts[0].reachable=false;assert.equal(recoveryChecks(data,'gpu-1').ready,false);data.gpuq.hosts[0].reachable=true;
  data.jobs.push({id:'unknown',machine:'gpu-1',state:'UNKNOWN'});assert.equal(recoveryChecks(data,'gpu-1').ready,false);
});
test('client maintenance guard blocks platform writes for admin and member, while preserving ROOT and read/stop operations',()=>{
  const data={operationalMaintenance:{version:1,global:{reason:'维修'},machines:{}},jobs:[{id:'job',machine:'gpu-1'}]};
  for(const role of ['member','admin'])for(const operation of ['jobs.submit','projects.publish','files.put','datasets.upload.begin','transfers.create','terminal.open'])assert.ok(maintenanceBlocks(operation,{machine:'gpu-1'},data,{role}));
  for(const operation of ['state','logout','maintenance.status','maintenance.set','jobs.logs','jobs.cancel','files.get','projects.status','terminal.detach','terminal.close','host.status'])assert.equal(maintenanceBlocks(operation,{machine:'gpu-1'},data,{role:'member'}),null);
  assert.equal(maintenanceBlocks('terminal.exchange',{machine:'gpu-1',input:''},data,{role:'member'}),null);
  assert.ok(maintenanceBlocks('terminal.exchange',{machine:'gpu-1',input:'eA==',hostAdmin:true},data,{role:'member'}));
  assert.equal(maintenanceBlocks('terminal.open',{machine:'gpu-1',hostAdmin:true},data,{role:'admin'}),null);
  data.operationalMaintenance.global=null;data.operationalMaintenance.machines['gpu-1']={reason:'单机'};
  assert.equal(maintenanceBlocks('files.put',{machine:'gpu-2'},data,{role:'member'}),null);
  assert.ok(maintenanceBlocks('jobs.priority',{jobId:'job'},data,{role:'admin'}));
});
