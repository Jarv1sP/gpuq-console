import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {datasetLabelCall} from '../dataset-labels.mjs';
const machine=MACHINES[0].id,replica=MACHINES[1].id,version='a'.repeat(64),dataset='training-data';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'dataset-label-test-')),bootstrap=join(dir,'bootstrap'),password='Dataset-Label-Fixture-2026!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[];let users=[];
  const records=host=>({datasets:[
    {dataset:host===replica?'receipt-bound-replica':dataset,ownerIds:users.map(user=>user.id),versions:[{version,state:'READY',bytes:1024,files:1}]},
    {dataset:'empty-shell',ownerIds:users.map(user=>user.id),versions:[]},
    {dataset:'invalid-versions',ownerIds:users.map(user=>user.id),versions:[{version:'bad',state:'READY'}]},
  ]});
  const bridge=async(host,operation,args)=>{calls.push({host,operation,args});
    if(operation==='datasets.list')return records(host);
    if(operation==='transfers.capabilities')return {enabled:false,protocol:'lan-transfer-v1',sources:[]};
    throw Error('Unexpected node write '+operation);
  };
  let service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  let admin=await service.login('admin',password);const tokens=new Map();
  for(const username of ['alice','bob']){
    const user=(await service.invoke(admin.token,'users.create',{username,password})).result;users.push(user);
    await service.invoke(admin.token,'policy.save',{userId:user.id,policyVersion:0,total:1,limits:{[machine]:1,[replica]:1}});
    tokens.set(username,(await service.login(username,password)).token);
  }
  const aliases=()=>{service.datasetAliases=(owner,host)=>host===replica?new Map([['receipt-bound-replica@'+version,dataset]]):new Map();};aliases();
  return {calls,users,records,get service(){return service;},get admin(){return admin;},
    call:async(operation,args,username='alice')=>(await service.invoke(username==='admin'?admin.token:tokens.get(username),operation,args)).result,
    restart:async()=>{service.close();service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);aliases();admin=await service.login('admin',password);for(const user of users)tokens.set(user.username,(await service.login(user.username,password)).token);}};
}
test('personal readable names persist without changing dataset identifiers, files, versions or leases',async t=>{
  const f=await fixture(t),before=structuredClone(f.records(machine));
  const initial=await f.call('datasets.label.get',{machine,dataset});assert.equal(initial.revision,0);assert.equal(initial.displayName,null);
  const changed=await f.call('datasets.label.set',{machine,dataset,displayName:'插接演示（400 条）',revision:0});
  assert.equal(changed.revision,1);assert.equal(changed.name,'插接演示（400 条）');assert.equal(changed.dataset,dataset);assert.equal(changed.scope,'personal');
  const list=await f.call('datasets.list',{machine});assert.equal(list.datasets[0].name,changed.name);assert.equal(list.datasets[0].displayNameRevision,1);
  assert.equal(list.datasets[0].dataset,dataset);assert.equal(list.datasets[0].versions[0].version,version);
  assert.deepEqual(f.records(machine),before);assert.ok(f.calls.every(c=>['datasets.list','transfers.capabilities'].includes(c.operation)));
  await f.restart();assert.equal((await f.call('datasets.label.get',{machine,dataset})).name,changed.name);
});
test('generated IDs default to original names without changing ownership, access or personal label scope',async t=>{
  const f=await fixture(t),upload='u-0123456789abcdef-ZJU-MoCap',workspace='w-fedcba9876543210-4ddress';
  const before={datasets:[upload,workspace].map(dataset=>({dataset,ownerIds:f.users.map(user=>user.id),
    versions:[{version,state:'READY',bytes:1024,files:1}]}))};
  f.service.bridge=async(host,operation,args)=>{f.calls.push({host,operation,args});
    if(operation==='datasets.list')return structuredClone(before);
    if(operation==='transfers.capabilities')return {enabled:false,protocol:'lan-transfer-v1',sources:[]};
    throw Error('Unexpected node write '+operation);
  };
  const initial=await f.call('datasets.label.get',{machine,dataset:upload});
  assert.equal(initial.name,'ZJU-MoCap');assert.equal(initial.displayName,null);assert.equal(initial.revision,0);
  assert.equal(initial.dataset,upload);assert.equal(initial.ownerId,f.users[0].id);
  for(const operation of ['datasets.list','datasets.catalog']){
    const result=await f.call(operation,{machine});
    const u=result.datasets.find(row=>row.dataset===upload),w=result.datasets.find(row=>row.dataset===workspace);
    assert.equal(u.name,'ZJU-MoCap');assert.equal(w.name,'4ddress');
    assert.equal(u.versions[0].version,version);
    assert.equal(operation==='datasets.list'?u.ownerLabel:u.versions[0].ownerLabel,'共享授权用户：alice、bob');
    assert.equal(u.displayNameRevision,0);
  }
  await f.call('datasets.label.set',{machine,dataset:upload,displayName:'人体动作',revision:0});
  assert.equal((await f.call('datasets.label.get',{machine,dataset:upload})).name,'人体动作');
  assert.equal((await f.call('datasets.label.get',{machine,dataset:upload},'bob')).name,'ZJU-MoCap');
  assert.deepEqual(before.datasets.map(row=>row.dataset),[upload,workspace]);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM dataset_labels').get().n,1,'Defaults create no metadata rows');
  assert.ok(f.calls.every(c=>['datasets.list','transfers.capabilities'].includes(c.operation)),'No node mutation or renamed paths');
});
test('shared readers choose independent personal names; member cannot edit another account',async t=>{
  const f=await fixture(t);
  await f.call('datasets.label.set',{machine,dataset,displayName:'Alice 的名称',revision:0});
  await f.call('datasets.label.set',{machine,dataset,displayName:'Bob 的名称',revision:0},'bob');
  assert.equal((await f.call('datasets.catalog',{machine})).datasets[0].name,'Alice 的名称');
  assert.equal((await f.call('datasets.catalog',{machine},'bob')).datasets[0].name,'Bob 的名称');
  await assert.rejects(f.call('datasets.label.set',{machine,dataset,displayName:'forged',revision:1,ownerId:f.users[1].id}),e=>e.status===403);
  await assert.rejects(f.call('datasets.label.get',{machine,dataset,ownerId:f.users[1].id}),e=>e.status===403);
});
test('administrator delegates only to usable target-viewer data, not elevated catalog visibility',async t=>{
  const f=await fixture(t),ownerId=f.users[0].id;
  const changed=await f.call('datasets.label.set',{machine,dataset,ownerId,displayName:'管理员代设',revision:0},'admin');
  assert.equal(changed.ownerId,ownerId);assert.equal((await f.call('datasets.label.get',{machine,dataset})).name,'管理员代设');
  assert.equal((await f.call('datasets.label.get',{machine,dataset},'bob')).name,dataset);
  // The shared directory may elevate metadata listing, never an operation
  // that reads payloads or changes node data. Renaming still checks the viewer.
  assert.ok(f.calls.every(c=>['datasets.list','transfers.capabilities'].includes(c.operation)));
  const bridge=f.service.bridge;f.service.bridge=async(host,operation,args)=>operation==='datasets.list'?
    {datasets:f.records(host).datasets.map(item=>({...item,ownerIds:[f.users[1].id]}))}:bridge(host,operation,args);
  await assert.rejects(f.call('datasets.label.set',{machine,dataset,ownerId,displayName:'无授权不许',revision:1},'admin'),e=>e.status===403);
  assert.equal(f.service.db.prepare('SELECT name FROM dataset_labels WHERE owner_id=?').get(ownerId).name,'管理员代设');
});
test('foreign READY metadata is visible but cannot read or create a personal label',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(host,operation,args)=>operation==='datasets.list'?
    {datasets:f.records(host).datasets.map(item=>({...item,ownerIds:[f.users[1].id]}))}:bridge(host,operation,args);
  const item=(await f.call('datasets.catalog',{machine})).datasets.find(item=>item.dataset===dataset);
  assert.equal(item.versions[0].state,'READY');assert.equal(item.versions[0].canUse,false);
  for(const operation of ['datasets.label.get','datasets.label.set'])
    await assert.rejects(f.call(operation,{machine,dataset,...(operation.endsWith('set')?{displayName:'非法名称',revision:0}:{})}),e=>e.status===403);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM dataset_labels').get().n,0);
});
test('zero-quota members may browse their dataset metadata but cannot mutate labels',async t=>{
  const f=await fixture(t),owner=f.service.store.get(f.users[0].id);
  await f.call('policy.save',{userId:owner.id,policyVersion:owner.policyVersion,total:0,limits:{}},'admin');
  const item=(await f.call('datasets.catalog',{})).datasets.find(item=>item.dataset===dataset);
  assert.equal(item.versions[0].canUse,false);
  await assert.rejects(f.call('datasets.label.set',{machine,dataset,displayName:'无额度名称',revision:0}),e=>e.status===403);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM dataset_labels').get().n,0);
});
test('replica and archive aliases inherit logical labels without guessing generated prefixes',async t=>{
  const f=await fixture(t);
  const changed=await f.call('datasets.label.set',{machine:replica,dataset:'receipt-bound-replica',displayName:'统一名称',revision:0});
  assert.equal(changed.dataset,dataset);
  for(const host of [machine,replica]){
    const raw=await f.call('datasets.list',{machine:host});assert.equal(raw.datasets[0].name,'统一名称');
    const catalog=await f.call('datasets.catalog',{machine:host});assert.equal(catalog.datasets.length,1);assert.equal(catalog.datasets[0].name,'统一名称');
  }
  f.service.datasetAliases=()=>new Map();f.service.storageArchivePolicy={machine:replica};f.service.archiveAliases=()=>new Map([['receipt-bound-replica@'+version,dataset]]);
  assert.equal((await f.call('datasets.catalog',{machine})).datasets[0].name,'统一名称');
  await assert.rejects(f.call('datasets.label.set',{machine,dataset:'u-guessed-prefix-training-data',displayName:'不可猜',revision:0}),e=>e.status===404);
});
test('revision CAS rejects stale and concurrent edits without silent overwrite',async t=>{
  const f=await fixture(t),requests=['第一个','第二个'].map(displayName=>f.call('datasets.label.set',{machine,dataset,displayName,revision:0}));
  const results=await Promise.allSettled(requests);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  const before=await f.call('datasets.label.get',{machine,dataset});
  await assert.rejects(f.call('datasets.label.set',{machine,dataset,displayName:'旧版本',revision:0}),e=>e.status===409);
  assert.deepEqual(await f.call('datasets.label.get',{machine,dataset}),before);
});
test('empty registrations are hidden by default, explicit includeEmpty reaches no node flag',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.call('datasets.list',{machine})).datasets.map(d=>d.dataset),[dataset]);
  assert.deepEqual((await f.call('datasets.list',{machine,includeEmpty:true})).datasets.map(d=>d.dataset),[dataset,'empty-shell','invalid-versions']);
  assert.ok(f.calls.every(c=>!Object.hasOwn(c.args,'includeEmpty')));
  await assert.rejects(f.call('datasets.list',{machine,includeEmpty:1}),e=>e.status===400);
});
test('labels validate Chinese/Unicode length, controls, revision and fields before remote calls',async t=>{
  const f=await fixture(t);
  for(const displayName of ['', ' '.repeat(10),'a'.repeat(81),'line\nfeed','zero\u200Bwidth',null,5])
    await assert.rejects(f.call('datasets.label.set',{machine,dataset,displayName,revision:0}),e=>e.status===400);
  for(const extra of [{revision:-1},{revision:'0'},{revision:Number.MAX_SAFE_INTEGER},{dataset:'../path'},{dataset:123},{hostAdmin:true},{userId:'builtin-admin'}])
    await assert.rejects(f.call('datasets.label.set',{machine,dataset,displayName:'名称',revision:0,...extra}));
  assert.equal(f.calls.length,0);
  assert.equal((await f.call('datasets.label.set',{machine,dataset,displayName:'  中文💡  ',revision:0})).name,'中文💡');
});
test('policy change during catalog read rejects the pending label write',async t=>{
  const f=await fixture(t),bridge=f.service.bridge,entered=deferred(),gate=deferred();
  f.service.bridge=async(host,operation,args)=>{if(operation==='datasets.list'){entered.resolve();await gate.promise;}return bridge(host,operation,args);};
  const pending=f.call('datasets.label.set',{machine,dataset,displayName:'未授权',revision:0});await entered.promise;
  f.service.store.users.find(u=>u.id===f.users[0].id).limits={};gate.resolve();
  await assert.rejects(pending,e=>e.status===403);assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM dataset_labels').get().n,0);
});
test('failed catalog does not pretend missing data or store a label without evidence',async t=>{
  const f=await fixture(t);f.service.bridge=async()=>{throw Error('private diagnostic');};
  await assert.rejects(f.call('datasets.label.set',{machine,dataset,displayName:'不能写',revision:0}),e=>e.status===503&&!e.message.includes('private'));
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM dataset_labels').get().n,0);
});
