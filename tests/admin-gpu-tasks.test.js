import test from 'node:test';
import assert from 'node:assert/strict';
import {adminTasks,registerGpuTasksAdmin} from '../dist/admin-gpu-tasks.js';
import {createAdminRegistry} from '../dist/admin-ui.js';
import {resourceCards} from '../dist/resources-ui.js';
import {controlSnapshot} from '../dist/control-ui.js';

test('task filters preserve unknown/cancel-pending and failed history without changing evidence',()=>{
  const store={jobs:[{id:'one',userId:'owner',machine:'first',state:'UNKNOWN'},
    {id:'two',userId:'other',machine:'second',state:'RUNNING',cancelRequested:true},
    {id:'three',userId:'other',machine:'first',state:'FAILED'}]},original=structuredClone(store.jobs);
  assert.deepEqual(adminTasks(store).map(row=>row.id),['one','two']);
  assert.deepEqual(adminTasks(store,{owner:'other'}).map(row=>row.id),['two']);
  assert.deepEqual(adminTasks(store,{machine:'first'}).map(row=>row.id),['one']);
  assert.deepEqual(adminTasks(store,{owner:'other',machine:'first',state:'ended'}).map(row=>row.id),['three']);
  assert.deepEqual(adminTasks(store,{state:'all'}),original);assert.deepEqual(store.jobs,original);
});
test('task provider registers a real privileged mount at order 10, and unregisters cleanly',()=>{
  const registry=createAdminRegistry(),remove=registerGpuTasksAdmin(section=>registry.register(section));
  assert.deepEqual(registry.list().map(row=>[row.id,row.order]),[['tasks',10]]);
  assert.equal(typeof registry.get('tasks').mount,'function');remove();assert.deepEqual(registry.list(),[]);
});
test('admin access remains distinct from management presentation',()=>{
  const machine={id:'long-inventory-machine',cards:1,model:'MODEL',memory:'32 GiB'},snapshot={stale:false,hosts:[{id:machine.id,reachable:true,gpus:[{index:0,memoryUsedMiB:1,memoryTotalMiB:32768,processesAvailable:true,processes:[{pid:1,name:'PRIVATE-PROGRAM',owner:'PRIVATE-USER'}]}],gpuq:{connected:true}}]};
  const input={machines:[machine],snapshot,admin:true,production:true,userId:'owner'};
  const main=resourceCards({...input,management:false});assert.match(main,/不限个人额度/);assert.doesNotMatch(main,/data-resource-root|PRIVATE-PROGRAM|PRIVATE-USER/);assert.doesNotMatch(main,/未授权查看/);
  const admin=resourceCards({...input,management:true,idPrefix:'admin-'});assert.doesNotMatch(admin,/data-resource-root/,'ROOT belongs to maintenance, not the task renderer');assert.match(admin,/PRIVATE-PROGRAM/);assert.match(admin,/PRIVATE-USER/);assert.match(admin,/id="admin-resource-identity"/);
});
test('main control excludes root and pending approval views while preserving immutable approvals',()=>{
  const store={principal:{userId:'owner',role:'admin'},users:[{id:'owner',role:'admin',enabled:true},{id:'pending',role:'member',enabled:true,total:0}],jobs:[],data:{machines:[]}};
  const snapshot=controlSnapshot(store,{sessions:[{id:'root',userId:'owner',hostAdmin:true},{id:'dev',userId:'owner',hostAdmin:false}]});
  assert.deepEqual(snapshot.sessions.map(row=>row.id),['dev']);assert.deepEqual(snapshot.attention,[]);assert.deepEqual(snapshot.approvals.map(row=>row.id),['pending']);
  store.principal.role='member';assert.deepEqual(controlSnapshot(store).approvals,[]);
});
