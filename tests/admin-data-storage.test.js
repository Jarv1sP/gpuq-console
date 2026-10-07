import test from 'node:test';
import assert from 'node:assert/strict';
import {adminDatasetCatalog,adminStorageSummary,mountAdminDataStorage,registerDatasetStorageAdmin} from '../dist/admin-data-storage.js';
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
  assert.equal(catalog.datasets[0].versions[0].locations[0].ownerLabel,'所属用户：未知');
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
