import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {storageUsageCall,STORAGE_USAGE_TIMEOUT_MS} from '../storage-usage.mjs';
import {MACHINES} from '../dist/model.js';

const digest=id=>createHash('sha256').update(id).digest('hex');
const member={userId:'demo-user-1',username:'alice',role:'member'};
const admin={userId:'builtin-admin',username:'admin',role:'admin'};
function sample(overrides={}){
  const a=digest(member.userId),b=digest('demo-user-2');
  return {storageOverview:{protocol:'dataset-storage-node-v1',cache:{projectCollectedAt:new Date().toISOString(),
    projectUsage:{protocol:1,complete:true,owners:[{owner:a,complete:true,projectBytes:8192},{owner:b,complete:true,projectBytes:16384}],
      projects:[{owner:a,project:'first',name:'first',bytes:4096},{owner:b,project:'private',name:'private',bytes:12288}],...overrides}}}};
}
function fixture(){
  const users=[{id:admin.userId,username:'admin',name:'管理员',role:'admin',enabled:true,limits:{}},
    {id:member.userId,username:'alice',name:'Alice',role:'member',enabled:true,limits:{}},
    {id:'demo-user-2',username:'bob',name:'Bob',role:'member',enabled:false,limits:{}}],calls=[];
  const service={store:{users,get:id=>users.find(row=>row.id===id)},
    db:{prepare:()=>assert.fail('usage must not read/write SQL'),exec:()=>assert.fail('usage must not change schema')},
    bridge:async(machine,operation,args)=>{calls.push({machine,operation,args});return sample();}};
  return {service,users,calls,call:(op='storage.usage.mine',who=member,args={})=>storageUsageCall(service,who,op,args)};
}

test('mine uses the current principal, including zero-quota accounts, and projects only their allocations',async()=>{
  const f=fixture(),value=await f.call();
  assert.equal(value.protocol,1);assert.match(value.checkedAt,/Z$/);assert.equal(value.machines.length,MACHINES.length);
  for(const row of value.machines){assert.equal(row.available,true);assert.equal(row.complete,true);assert.equal(row.projectBytes,8192);
    assert.deepEqual(row.projects,[{project:'first',name:'first',bytes:4096}]);}
  assert.doesNotMatch(JSON.stringify(value),/private|Bob|bob|owner|demo-user-2/);
  assert.deepEqual(f.calls,MACHINES.map(({id:machine})=>({machine,operation:'datasets.capacity',args:{userId:'builtin-admin',hostAdmin:true}})));
});

test('users is administrator-only before any node access; disabled or forged principals cannot read mine',async()=>{
  const f=fixture();
  await assert.rejects(f.call('storage.usage.users'),error=>error.status===403);
  for(const who of [null,{...member,role:'admin'},{userId:'demo-user-2',role:'member'}, {...member,userId:'unknown'}])
    await assert.rejects(f.call('storage.usage.mine',who),error=>error.status===403);
  assert.equal(f.calls.length,0);
});

test('users provides labels and each account projection without owner hashes, paths, or invented disabled-account zeros',async()=>{
  const f=fixture(),value=await f.call('storage.usage.users',admin);
  assert.deepEqual(value.users.map(row=>[row.userId,row.label]),[['builtin-admin','管理员'],['demo-user-1','Alice'],['demo-user-2','Bob']]);
  assert.equal(value.users[2].machines[0].projectBytes,16384);
  assert.deepEqual(value.users[2].machines[0].projects,[{project:'private',name:'private',bytes:12288}]);
  assert.equal(value.users[0].machines[0].projectBytes,0);
  assert.doesNotMatch(JSON.stringify(value),new RegExp(digest(member.userId)+'|owner|hostAdmin|limits'));
});

test('strict empty args reject injected identity, machine and path before I/O',async()=>{
  const f=fixture();
  for(const args of [null,[],{machine:MACHINES[0].id},{userId:'demo-user-2'},{hostAdmin:true},{path:'/private'},{refresh:true}])
    await assert.rejects(f.call('storage.usage.mine',member,args),error=>error.status===400);
  await assert.rejects(f.call('unknown'),error=>error.status===400);
  assert.equal(f.calls.length,0);
});

test('legacy, missing and wrong node protocols are unavailable with null usage, not zero',async()=>{
  for(const value of [{},{storageOverview:{protocol:'dataset-storage-node-v1',cache:{projectBytes:123}}},
    {storageOverview:{protocol:'old',cache:{projectUsage:{protocol:1}}}},sample({protocol:2})]){
    const f=fixture();f.service.bridge=async()=>value;
    const result=await f.call();
    assert.ok(result.machines.every(row=>row.available===false&&row.projectBytes===null&&row.complete===false&&row.projects.length===0));
    assert.match(result.machines[0].reason,/暂不支持/);
  }
});

test('missing bridge and failed node reads return unavailable without leaking node errors',async()=>{
  for(const bridge of [null,async()=>{throw Error('secret key /srv/private database');}]){
    const f=fixture();f.service.bridge=bridge;const result=await f.call();
    assert.ok(result.machines.every(row=>row.available===false&&row.projectBytes===null));
    assert.doesNotMatch(JSON.stringify(result),/secret|\/srv|database|key/);
  }
});

test('incomplete samples and unallocated OCI layers remain null while known individual project rows survive',async()=>{
  const f=fixture();f.service.bridge=async()=>sample({complete:false});
  let result=await f.call();assert.equal(result.machines[0].available,true);assert.equal(result.machines[0].complete,false);
  assert.equal(result.machines[0].projectBytes,null);assert.equal(result.machines[0].projects[0].bytes,4096);
  const g=fixture();g.service.bridge=async()=>sample({owners:[{owner:digest(member.userId),complete:false,projectBytes:null}],
    projects:[{owner:digest(member.userId),project:'first',name:'first',bytes:null}]});
  result=await g.call();assert.equal(result.machines[0].projectBytes,null);assert.equal(result.machines[0].projects[0].bytes,null);
});

test('a missing account is known zero only after a complete, timestamped sample',async()=>{
  for(const complete of [true,false]){
    const f=fixture();f.service.bridge=async()=>sample({owners:[],projects:[],complete});
    const row=(await f.call()).machines[0];assert.equal(row.complete,complete);assert.equal(row.projectBytes,complete?0:null);
  }
  const f=fixture();f.service.bridge=async()=>{const value=sample();value.storageOverview.cache.projectCollectedAt=null;return value;};
  assert.equal((await f.call()).machines[0].projectBytes,null);
});

test('malformed, duplicate and unsafe allocations fail closed; display names cannot inject foreign fields',async()=>{
  const a=digest(member.userId);
  for(const overrides of [{complete:'true'},{owners:[{owner:a,complete:true,projectBytes:-1}]},
    {owners:[{owner:a,complete:true,projectBytes:null}]},{owners:[{owner:a,complete:true,projectBytes:1},{owner:a,complete:true,projectBytes:1}]},
    {projects:[{owner:a,project:'../secret',bytes:1}]},{projects:[{owner:a,project:'first',bytes:Number.MAX_SAFE_INTEGER+1}]},
    {projects:[{owner:a,project:'first',bytes:1},{owner:a,project:'first',bytes:1}]}]){
    const f=fixture();f.service.bridge=async()=>sample(overrides);
    assert.ok((await f.call()).machines.every(row=>row.available===false&&row.projectBytes===null));
  }
  const f=fixture();f.service.bridge=async()=>sample({projects:[{owner:a,project:'first',name:'/secret password',bytes:4096}]});
  assert.equal((await f.call()).machines[0].projects[0].name,'first');
});

test('full and legacy owner records are never summed without a device/inode proof',async()=>{
  const f=fixture(),a=digest(member.userId);
  f.service.bridge=async()=>sample({owners:[{owner:a,complete:true,projectBytes:100},{owner:a.slice(0,32),complete:true,projectBytes:200}],projects:[]});
  const row=(await f.call()).machines[0];assert.equal(row.complete,false);assert.equal(row.projectBytes,null);
});

test('concurrent refreshes reuse the same bounded node observations but never reuse another account projection',async()=>{
  const f=fixture();const [mine,all]=await Promise.all([f.call(),f.call('storage.usage.users',admin)]);
  assert.equal(f.calls.length,MACHINES.length);assert.equal(mine.machines[0].projectBytes,8192);assert.equal(all.users[2].machines[0].projectBytes,16384);
  await f.call();assert.equal(f.calls.length,MACHINES.length);
});

test('account revocation while a capacity read is pending rejects the entire response',async()=>{
  const f=fixture();let release;
  const gate=new Promise(resolve=>release=resolve);f.service.bridge=async()=>{await gate;return sample();};
  const result=f.call();f.users[1].enabled=false;release();
  await assert.rejects(result,error=>error.status===403);
});

test('timeouts stay unavailable and hold the underlying lane until the old read ends',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();let release;
  const gate=new Promise(resolve=>release=resolve);
  f.service.bridge=async(machine,operation,args)=>{f.calls.push({machine,operation,args});await gate;return sample();};
  const pending=f.call();await Promise.resolve();t.mock.timers.tick(STORAGE_USAGE_TIMEOUT_MS+1);
  const result=await pending;assert.ok(result.machines.every(row=>row.available===false&&row.projectBytes===null));
  await f.call();assert.equal(f.calls.length,MACHINES.length);release();
});
