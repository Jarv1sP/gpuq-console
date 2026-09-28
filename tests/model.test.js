import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoStore} from '../dist/model.js';

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
