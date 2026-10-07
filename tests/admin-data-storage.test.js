import test from 'node:test';
import assert from 'node:assert/strict';
import {adminDatasetCatalog,adminStorageSummary,adminStorageUsers,adminWarehouseMachines,mountAdminDataStorage,registerDatasetStorageAdmin} from '../dist/admin-data-storage.js';
import {validUsername} from '../dist/model.js';
const machines=[{id:'node-a'},{id:'node-b'}],version='a'.repeat(64),other='b'.repeat(64);
const listing=(machine,dataset='samples',ownerLabel='所属用户：alice',state='READY',bytes=10)=>({machine,state:'ok',datasets:[{dataset,ownerLabel,versions:[{version,state,bytes,files:2,canPrepare:false}]}]});

test('storage summary uses explicit budget thresholds and candidate sizes, never invents unknown totals',()=>{
  const plan={enabled:true,usageBytes:90,budgetBytes:100,lowWater:.61,highWater:.83,candidates:[{bytes:10},{bytes:20}]};
  assert.deepEqual(adminStorageSummary({enabled:true},plan),{budget:{kind:'high',ratio:.9,usageBytes:90,budgetBytes:100,lowWater:.61,highWater:.83},count:2,bytes:30});
  assert.equal(adminStorageSummary(null,plan).budget.kind,'unknown');
  assert.equal(adminStorageSummary({enabled:false},{enabled:false,candidates:[]}).budget.kind,'disabled');
  assert.deepEqual(adminStorageSummary(null,null),{budget:{kind:'unknown'},count:null,bytes:null});
  assert.equal(adminStorageSummary({enabled:true},{...plan,candidates:[{bytes:10},{}]}).bytes,null);
  assert.equal(adminStorageSummary({enabled:true},{...plan,candidates:[{bytes:Number.MAX_SAFE_INTEGER},{bytes:1}]}).bytes,null);
});

test('user statistics sum known physical ready caches, share only explicit names and exclude unknown facts',()=>{
  const catalog={partial:true,datasets:[{dataset:'samples',versions:[{bytes:10,locations:[{state:'READY',bytes:10,ownerLabel:'所属用户：alice'},{state:'READY',bytes:10,ownerLabel:'共享授权用户：alice、bob'},{state:'PREPARING',ownerLabel:'所属用户：alice'},{state:'READY',bytes:10,ownerLabel:'所属用户：未知（授权信息未完整返回）'}]},{bytes:null,locations:[{state:'READY',bytes:10,ownerLabel:'所属用户：bob'}]}]},{dataset:'second',versions:[{bytes:30,locations:[{state:'READY',bytes:30,ownerLabel:'所属用户：bob'}]}]}]};
  const original=structuredClone(catalog);
  assert.deepEqual(adminStorageUsers(catalog),{rows:[{name:'bob',datasets:2,bytes:40},{name:'alice',datasets:1,bytes:20}],excluded:2,partial:true});
  assert.deepEqual(catalog,original);
  assert.equal(adminStorageUsers({datasets:[{dataset:'unsafe',versions:[{bytes:10,locations:[{state:'READY',bytes:10,ownerLabel:'所属用户：<img src=x>'}]}]}]}).rows.length,0);
});
test('user statistics retain valid Chinese and ASCII owners, including deduplicated shared names',()=>{
  const catalog={datasets:[{dataset:'samples',versions:[{bytes:10,locations:[
    {state:'READY',bytes:10,ownerLabel:'所属用户：陈宇轩'},
    {state:'READY',bytes:10,ownerLabel:'所属用户：lab_user-1'},
    {state:'READY',bytes:10,ownerLabel:'所属用户：未知'},
    {state:'READY',bytes:10,ownerLabel:'共享授权用户：陈宇轩、lab_user-1、陈宇轩'},
  ]}]}]};
  const result=adminStorageUsers(catalog);
  assert.deepEqual(new Map(result.rows.map(row=>[row.name,{datasets:row.datasets,bytes:row.bytes}])),
    new Map([['陈宇轩',{datasets:1,bytes:20}],['lab_user-1',{datasets:1,bytes:20}],['未知',{datasets:1,bytes:10}]]));
  assert.equal(result.excluded,0);assert.equal(result.partial,false);
});
test('user statistics exclude illegal account names and unknown owner sentinels',()=>{
  const names=['Alice','0user','a','alice.admin','alice@example.com','a'.repeat(25),'alice smith','<img src=x>',
    '未知（授权信息未完整返回）','未知（账号已删除或未登记）','未知用户 1 位（账号已删除或未登记）'];
  const catalog={datasets:[{dataset:'samples',versions:[{bytes:10,locations:names.map(name=>({state:'READY',bytes:10,ownerLabel:'所属用户：'+name}))}]}]};
  assert.deepEqual(adminStorageUsers(catalog),{rows:[],excluded:names.length,partial:false});
});
test('user statistics count known shared owners without inventing the unknown account',()=>{
  const catalog={datasets:[{dataset:'samples',versions:[{bytes:10,locations:[
    {state:'READY',bytes:10,ownerLabel:'共享授权用户：陈宇轩、alice、未知用户 1 位（账号已删除或未登记）'},
  ]}]}]};
  const result=adminStorageUsers(catalog);
  assert.deepEqual(new Set(result.rows.map(row=>row.name)),new Set(['陈宇轩','alice']));
  assert(result.rows.every(row=>row.datasets===1&&row.bytes===10));assert.equal(result.excluded,0);
});
test('storage owner validation follows the account contract without importing the preview model into the login graph',()=>{
  for(const name of ['alice','lab_user-1','陈宇轩','未知','中文账户123','a'.repeat(24),'a','0user','Alice','alice.admin','alice@example.com','a'.repeat(25),'alice smith','<img src=x>','未知（授权信息未完整返回）']){
    const result=adminStorageUsers({datasets:[{dataset:'samples',versions:[{bytes:10,locations:[{state:'READY',bytes:10,ownerLabel:'所属用户：'+name}]}]}]});
    assert.equal(result.rows.length,validUsername(name)?1:0,name);
    assert.equal(result.excluded,validUsername(name)?0:1,name);
  }
});
test('warehouse marker requires retained ARCHIVED proof bound to the complete immutable version',()=>{
  const storage={dataset:'samples',version,phase:'ARCHIVED',originalRetained:true,archiveMachine:'node-b'},v={version,locations:[{machine:'node-a',dataset:'samples',storage}]};
  const catalog={datasets:[{dataset:'samples',versions:[v]}]};
  assert.deepEqual([...adminWarehouseMachines(catalog)],['node-b']);
  for(const change of [{phase:'COPYING'},{originalRetained:false},{archiveMachine:''},{version:other},{dataset:undefined}]){
    assert.equal(adminWarehouseMachines({datasets:[{versions:[{...v,locations:[{storage:{...storage,...change}}]}]}]}).size,0);
  }
  assert.equal(adminWarehouseMachines(null).size,0);
});

test('administrator catalog retains physical registrations, complete hashes and actual owner labels',()=>{
  const a=listing('node-a'),b=listing('node-b','samples','共享授权用户：alice、bob');
  b.datasets[0].versions.push({version:other,state:'REGISTERED',bytes:20,files:3});
  const before=structuredClone([a,b]),catalog=adminDatasetCatalog('node-a',machines,[a,b]);
  assert.equal(catalog.datasets.length,1);assert.equal(catalog.datasets[0].versions.length,2);
  assert.deepEqual(catalog.datasets[0].versions[0].locations.map(row=>row.ownerLabel),['所属用户：alice','共享授权用户：alice、bob']);
  assert.equal(catalog.datasets[0].versions[0].locations[1].dataset,'samples');
  assert.equal(catalog.datasets[0].versions[1].state,'NOT_LOCAL');assert.equal(catalog.datasets[0].versions[1].canPrepare,false);
  assert.deepEqual([a,b],before);
});
test('different physical aliases are never joined just because their full hashes match',()=>{
  const catalog=adminDatasetCatalog('node-a',machines,[listing('node-a','owned-a'),listing('node-b','owned-b')]);
  assert.deepEqual(catalog.datasets.map(row=>row.dataset),['owned-a','owned-b']);
  assert.equal(catalog.datasets[1].versions[0].locations.length,1);
});
test('contradictory totals remain unknown instead of selecting a convenient quantity',()=>{
  const catalog=adminDatasetCatalog('node-a',machines,[listing('node-a'),listing('node-b','samples','所属用户：alice','READY',30)]);
  assert.equal(catalog.datasets[0].versions[0].bytes,null);assert.equal(catalog.datasets[0].versions[0].files,2);
});
test('missing or duplicated server reads cannot establish absence or an empty successful catalog',()=>{
  for(const reads of [[listing('node-b')],[listing('node-a'),listing('node-a'),listing('node-b')]]){
    const catalog=adminDatasetCatalog('node-a',machines,reads);assert.equal(catalog.partial,true);
    assert.equal(catalog.machines[0].state,'unavailable');assert.equal(catalog.datasets[0].versions[0].state,'UNKNOWN');
  }
});
test('unknown node states and missing owner labels remain unknown',()=>{
  const a=listing('node-a',undefined,undefined,'FUTURE');delete a.datasets[0].ownerLabel;
  const catalog=adminDatasetCatalog('node-a',machines,[a,listing('node-b')]);
  assert.equal(catalog.datasets[0].versions[0].locations[0].state,'UNKNOWN');
  assert.equal(catalog.datasets[0].versions[0].locations[0].ownerLabel,'所属用户：未知（授权信息未完整返回）');
  const ready=listing('node-a');delete ready.datasets[0].ownerLabel;
  const missing=adminDatasetCatalog('node-a',[machines[0]],[ready]);
  assert.deepEqual(adminStorageUsers(missing),{rows:[],excluded:1,partial:false});
});
test('archive and pending-removal proof must match the exact physical name, machine and version',()=>{
  const storage={version,phase:'ARCHIVED',originalRetained:true,archiveMachine:'node-b'};
  const personal={datasets:[{dataset:'wrong',versions:[{version,locations:[{machine:'node-a',dataset:'different',storage}]}]},{dataset:'logical-samples',versions:[{version,locations:[{machine:'node-a',dataset:'samples',storage,removalPending:true}]}]}]};
  const catalog=adminDatasetCatalog('node-a',machines,[listing('node-a'),listing('node-b')],personal);
  assert.deepEqual(catalog.datasets[0].versions[0].locations[0].storage,storage);
  assert.equal(catalog.datasets[0].versions[0].locations[0].removalPending,true);
  assert.equal(catalog.datasets[0].versions[0].locations[1].storage,undefined);
  personal.datasets[1].versions[0].version=other;
  assert.equal(adminDatasetCatalog('node-a',machines,[listing('node-a')],personal).datasets[0].versions[0].locations[0].storage,undefined);
});
test('deletion capability is strictly numeric one and member permission remains an explicit backend fact',()=>{
  const a=listing('node-a');a.datasets[0].versions[0].deletionPermissions={memberAllowed:false,reason:'拒绝'};
  for(const value of [undefined,0,true,'1',2])assert.equal(adminDatasetCatalog('node-a',machines,[a],{datasetDelete:value}).datasetDelete,0);
  const catalog=adminDatasetCatalog('node-a',machines,[a],{datasetDelete:1});assert.equal(catalog.datasetDelete,1);
  assert.deepEqual(catalog.datasets[0].versions[0].locations[0].deletionPermissions,{memberAllowed:false,reason:'拒绝'});
});
test('empty registrations remain visible without inventing a usable version',()=>{
  const catalog=adminDatasetCatalog('node-a',machines,[{machine:'node-a',state:'ok',datasets:[{dataset:'empty',ownerLabel:'所属用户：alice',versions:[]}]},{machine:'node-b',state:'ok',datasets:[]}]);
  assert.equal(catalog.partial,false);assert.equal(catalog.datasets[0].versions.length,0);
  assert.deepEqual(catalog.datasets[0].registrations,[{machine:'node-a',ownerLabel:'所属用户：alice'}]);
});
test('malformed inventory, names and shortened hashes are rejected',()=>{
  assert.throws(()=>adminDatasetCatalog('',machines,[]),TypeError);
  assert.throws(()=>adminDatasetCatalog('node-a',[{id:'../bad'}],[]),TypeError);
  const a=listing('node-a');a.datasets[0].versions[0].version=version.slice(0,12);
  assert.throws(()=>adminDatasetCatalog('node-a',machines,[a]),TypeError);
});
test('storage registers only its own ordered section and teardown delegates to the mounted module',()=>{
  let descriptor;const result=registerDatasetStorageAdmin(value=>{descriptor=value;return 'registered';});
  assert.equal(result,'registered');assert.deepEqual([descriptor.id,descriptor.title,descriptor.order],['storage','数据与存储',20]);
  assert.equal(typeof descriptor.mount,'function');assert.equal(typeof descriptor.unmount,'function');descriptor.unmount();
});
test('non-admin mounting is denied before any directory, policy, pin or cloud request',()=>{
  let calls=0;const el={dataset:{},classList:{add(){}},isConnected:true,textContent:'',querySelectorAll:()=>[],replaceChildren(){}};
  const mounted=mountAdminDataStorage(el,{store:{principal:{userId:'member-a',role:'member'},call(){calls++;}}});
  assert.equal(el.textContent,'需要管理员权限');assert.equal(calls,0);mounted.destroy();assert.equal(calls,0);
});
