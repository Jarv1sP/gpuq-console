import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {storageUsageCall,STORAGE_USAGE_TIMEOUT_MS} from '../storage-usage.mjs';
import {MACHINES} from '../dist/model.js';

test('personal storage returns healthy machines while one capacity read hangs, within four seconds',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  assert.equal(STORAGE_USAGE_TIMEOUT_MS,4000);
  const user={id:'demo-user-1',enabled:true,role:'member',limits:{}},principal={userId:user.id,role:user.role};
  const owner=createHash('sha256').update(user.id).digest('hex'),offline=MACHINES.at(-1).id,calls=[];
  const collectedAt=new Date().toISOString();let release;
  const gate=new Promise(resolve=>release=resolve);
  const sample={storageOverview:{protocol:'dataset-storage-node-v1',cache:{projectCollectedAt:collectedAt,
    projectUsage:{protocol:1,complete:true,owners:[{owner,complete:true,projectBytes:8192}],
      projects:[{owner,project:'first',name:'first',bytes:4096}]}}}};
  const service={store:{users:[user],get:id=>id===user.id?user:null},bridge:(machine,operation,args)=>{
    calls.push({machine,operation,args});return machine===offline?gate:Promise.resolve(sample);
  }};
  const start=Date.now(),pending=storageUsageCall(service,principal,'storage.usage.mine',{});
  await new Promise(setImmediate);t.mock.timers.tick(4000);
  const value=await pending;
  assert.equal(Date.now()-start,4000);
  const unknown=value.machines.find(row=>row.machine===offline);
  assert.equal(unknown.available,false);assert.equal(unknown.projectBytes,null);assert.equal(unknown.complete,false);
  assert.deepEqual(unknown.projects,[]);
  for(const row of value.machines.filter(row=>row.machine!==offline)){
    assert.equal(row.available,true);assert.equal(row.projectBytes,8192);assert.equal(row.collectedAt,collectedAt);
    assert.deepEqual(row.projects,[{project:'first',name:'first',bytes:4096}]);
  }
  const cached=await storageUsageCall(service,principal,'storage.usage.mine',{});
  assert.deepEqual(cached.machines,value.machines);assert.equal(calls.length,MACHINES.length);
  assert.ok(calls.every(row=>row.operation==='datasets.capacity'&&row.args.userId==='builtin-admin'&&row.args.hostAdmin===true));
  release(sample);
});
