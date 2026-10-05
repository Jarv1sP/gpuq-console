import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoStore} from '../dist/model.js';
import {MACHINES} from '../dist/machines.js';
import {mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('demo authorization and requests follow renamed inventory IDs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-demo-inventory-'));
  const inventory=MACHINES.map((machine,index)=>({...machine,id:'inventory-server-with-a-long-name-'+(index+1)}));
  try{
    await copyFile(new URL('../dist/model.js',import.meta.url),join(dir,'model.js'));
    await copyFile(new URL('../dist/task-metadata.js',import.meta.url),join(dir,'task-metadata.js'));
    await writeFile(join(dir,'package.json'),JSON.stringify({type:'module'}));
    await writeFile(join(dir,'machines.js'),'export const MACHINES='+JSON.stringify(inventory)+';');
    const {DemoStore:ConfiguredStore}=await import(pathToFileURL(join(dir,'model.js')).href);
    const store=new ConfiguredStore(),user=store.get('demo-chen');
    assert.deepEqual(Object.keys(user.limits),inventory.slice(0,3).map(machine=>machine.id));
    assert.ok(store.snapshot().users.every(member=>Object.keys(member.limits).every(id=>inventory.some(machine=>machine.id===id))));
    assert.equal(store.request(user.id,inventory[0].id,1).machine,inventory[0].id);
    assert.throws(()=>store.request(user.id,MACHINES[0].id,1),/未授权/,'old example IDs must not authorize a renamed server');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('save per-machine permissions and enforce cross-machine total',()=>{
  const s=new DemoStore();s.save('demo-chen',{limits:{'gpu-1':2,'gpu-2':2},total:3});
  s.request('demo-chen','gpu-1',2);s.request('demo-chen','gpu-2',1);
  assert.throws(()=>s.request('demo-chen','gpu-2',1),/跨机器总上限/);
  assert.equal(s.usage('demo-chen'),3);
});
test('deny ungranted machines and per-machine overflow without adding jobs',()=>{
  const s=new DemoStore();assert.throws(()=>s.request('demo-chen','gpu-4',1),/未授权/);
  assert.throws(()=>s.request('demo-chen','gpu-1',3),/这台机器的上限/);assert.equal(s.jobs.length,0);
});
test('reject malformed permissions atomically',()=>{
  const s=new DemoStore();const before=s.get('demo-chen');
  for(const policy of [{limits:{unknown:1},total:1},{limits:{'gpu-3':7},total:7},{limits:{'gpu-1':1.5},total:2},{limits:{'gpu-1':1},total:2},{limits:{},total:1},{limits:{'gpu-1':1},total:NaN}])assert.throws(()=>s.save('demo-chen',policy));
  assert.deepEqual(s.get('demo-chen'),before);
});
test('pause and quota reductions do not terminate running demo jobs',()=>{
  const s=new DemoStore();s.request('demo-chen','gpu-1',2);s.setEnabled('demo-chen',false);
  assert.throws(()=>s.request('demo-chen','gpu-2',1),/已暂停/);assert.equal(s.jobs.length,1);
  s.setEnabled('demo-chen',true);s.save('demo-chen',{limits:{'gpu-2':1},total:1});
  assert.equal(s.usage('demo-chen'),2);assert.throws(()=>s.request('demo-chen','gpu-2',1),/总上限/);
});
test('releasing usage permits a new request and enforces ownership',()=>{
  const s=new DemoStore();const j=s.request('demo-chen','gpu-1',2);
  assert.throws(()=>s.release(j.id,'demo-lin'),/其他用户/);assert.equal(s.jobs.length,1);
  s.release(j.id,'demo-chen');assert.equal(s.usage('demo-chen'),0);s.request('demo-chen','gpu-1',2);
});
test('new users start with no GPU permissions and names are unique',()=>{
  const s=new DemoStore();const u=s.create('测试用户','test-user');assert.equal(u.total,0);assert.deepEqual(u.limits,{});
  assert.throws(()=>s.create('重复用户','test-user'),/已存在/);assert.throws(()=>s.create('名称','bad name'),/用户名/);
  assert.throws(()=>s.request(u.id,'gpu-1',1),/未授权/);
});
test('the simulated machine cannot be overallocated across users',()=>{
  const s=new DemoStore();s.save('demo-chen',{limits:{'gpu-1':8},total:8});s.save('demo-lin',{limits:{'gpu-1':2},total:2});
  s.request('demo-chen','gpu-1',8);assert.throws(()=>s.request('demo-lin','gpu-1',1),/资源暂时不足/);
});
test('invalid requests do not mutate state; refresh creates a clean demo',()=>{
  const s=new DemoStore();for(const n of [0,-1,1.5,NaN,Infinity])assert.throws(()=>s.request('demo-chen','gpu-1',n));
  assert.equal(s.jobs.length,0);s.request('demo-chen','gpu-1',1);assert.equal(new DemoStore().jobs.length,0);
});
