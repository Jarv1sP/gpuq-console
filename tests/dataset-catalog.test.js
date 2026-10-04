import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetCatalogCall,datasetListView} from '../dataset-catalog.mjs';
import {MACHINES} from '../dist/model.js';
const machines=MACHINES.slice(0,2).map(m=>m.id),version='a'.repeat(64),principal={userId:'demo-user-1',role:'member'};
const users=[{id:principal.userId,username:'alice',name:'Not the username',password:'never-return'}, {id:'reader-2',username:'bob'}, {id:'unrelated',username:'hidden-user'}];
function fixture(bridge){return {bridge,store:{users,get:()=>({id:principal.userId,enabled:true,limits:Object.fromEntries(machines.map(m=>[m,1]))})}};}
const item=(ownerIds,extra={})=>({dataset:'u-misleading-name',ownerIds,versions:[{version,state:'READY',bytes:5,files:1}],...extra});
test('list projects only trusted authorized usernames, not IDs, guessed prefixes or user records',()=>{
  const result=datasetListView({datasets:[item([principal.userId],{ownerLabel:'forged',sourceId:'/private',users})]},users);
  assert.equal(result.datasets[0].ownerLabel,'所属用户：alice');
  assert.deepEqual(result.datasets[0].versions,[{version,state:'READY',canPrepare:false,bytes:5,files:1}]);
  assert.doesNotMatch(JSON.stringify(result),/ownerIds|demo-user-1|Not the username|never-return|hidden-user|forged|\/private/);
});
test('shared users are an ACL view; deleted, legacy and oversized owners stay explicitly unknown',()=>{
  for(const [ids,label] of [
    [['reader-2',principal.userId,principal.userId],'共享授权用户：alice、bob'],
    [['deleted'],'所属用户：未知（账号已删除或未登记）'],
    [[principal.userId,'deleted'],'共享授权用户：alice、未知用户 1 位（账号已删除或未登记）'],
  ])assert.equal(datasetListView({datasets:[item(ids)]},users).datasets[0].ownerLabel,label);
  for(const ids of [undefined,null,[],['bad/id'],Array(65).fill(principal.userId)]){
    const label=datasetListView({datasets:[item(ids)]},users).datasets[0].ownerLabel;
    assert.match(label,/未知/);assert.doesNotMatch(label,/alice|misleading/);
  }
});
test('catalog retains per-location ownership and never unions differing ACLs',async()=>{
  const s=fixture(async machine=>({datasets:[item(machine===machines[0]?[principal.userId]:['reader-2'])]}));
  const result=await datasetCatalogCall(s,principal,'datasets.catalog',{machine:machines[0]});
  const v=result.datasets[0].versions[0];
  assert.equal(v.ownerLabel,'各机授权不同（见副本位置）');
  assert.deepEqual(v.locations.map(location=>location.ownerLabel),['所属用户：alice','所属用户：bob']);
  assert.doesNotMatch(JSON.stringify(result),/共享授权用户|ownerIds|demo-user-1|reader-2/);
});
test('equal ACL sets share one label, while a legacy node cannot silently inherit another owner',async()=>{
  const s=fixture(async machine=>({datasets:[item(machine===machines[0]?[principal.userId,'reader-2']:['reader-2',principal.userId])]}));
  assert.equal((await datasetCatalogCall(s,principal,'datasets.catalog',{machine:machines[0]})).datasets[0].versions[0].ownerLabel,'共享授权用户：alice、bob');
  s.bridge=async machine=>({datasets:[item(machine===machines[0]?[principal.userId]:undefined)]});
  const v=(await datasetCatalogCall(s,principal,'datasets.catalog',{machine:machines[0]})).datasets[0].versions[0];
  assert.match(v.ownerLabel,/未知/);assert.equal(v.locations[0].ownerLabel,'所属用户：alice');assert.match(v.locations[1].ownerLabel,/未知/);
});
test('archive alias merging preserves physical-location ACL differences and version isolation',async()=>{
  const s=fixture(async machine=>({datasets:[item(machine===machines[0]?[principal.userId]:['reader-2'],{dataset:machine===machines[0]?'local':'archive-copy'})]}));
  s.storageArchivePolicy={machine:machines[1]};s.archiveAliases=()=>new Map([['archive-copy@'+version,'local']]);
  const result=await datasetCatalogCall(s,principal,'datasets.catalog',{machine:machines[0]});
  assert.equal(result.datasets.length,1);assert.equal(result.datasets[0].dataset,'local');
  assert.match(result.datasets[0].versions[0].ownerLabel,/各机授权不同/);
  assert.deepEqual(result.datasets[0].versions[0].locations.map(value=>value.dataset),['local','archive-copy']);
});
test('catalog merges authorized locations, never makes a remote READY version local',async()=>{
  const calls=[],s=fixture(async(machine,operation,owner)=>{calls.push({machine,operation,owner});return {datasets:machine===machines[0]?[]:[{dataset:'mine',owners:['secret'],versions:[{version,state:'READY',bytes:5,files:1,sourceId:'private-path'}]}]};});
  const r=await datasetCatalogCall(s,principal,'datasets.catalog',{machine:machines[0]});
  assert.equal(r.datasets[0].versions[0].state,'NOT_LOCAL');assert.equal(r.datasets[0].versions[0].canPrepare,false);
  assert.equal(r.datasets[0].versions[0].locations[0].machine,machines[1]);assert.equal(r.partial,false);
  assert.equal(JSON.stringify(r).includes('private-path'),false);assert.equal(JSON.stringify(r).includes('secret'),false);
  assert.deepEqual(calls.map(c=>c.owner),machines.map(()=>({userId:principal.userId,hostAdmin:false})));
});
test('failed node is unknown and partial, not an empty confirmed catalog',async()=>{
  const s=fixture(async machine=>{if(machine===machines[0])throw Error('secret');return {datasets:[{dataset:'mine',versions:[{version,state:'READY'}]}]};});
  const r=await datasetCatalogCall(s,principal,'datasets.catalog',{machine:machines[0]});assert.equal(r.partial,true);assert.equal(r.datasets[0].versions[0].state,'UNKNOWN');assert.equal(JSON.stringify(r).includes('secret'),false);
});
test('capacity is filesystem budget, with unknown inodes accepted',async()=>{
  const s=fixture(async()=>({filesystemBytes:100,availableBytes:90,reserveBytes:10,usableBytes:80,totalInodes:null,availableInodes:null,inodeUsageKnown:false,guarded:true,path:'/private'}));
  const r=await datasetCatalogCall(s,principal,'datasets.capacity',{machine:machines[0]});assert.equal(r.usableBytes,80);assert.equal(r.totalInodes,null);assert.equal(r.path,undefined);
});
test('catalog rejects client identity/path injection and unauthorized machine before bridge',async()=>{
  let calls=0;const s=fixture(async()=>{calls++;});
  for(const extra of [{hostAdmin:true},{userId:'other'},{path:'/data2'}])await assert.rejects(datasetCatalogCall(s,principal,'datasets.catalog',{machine:machines[0],...extra}),e=>e.status===400);
  await assert.rejects(datasetCatalogCall(s,principal,'datasets.catalog',{machine:'not-granted'}),e=>e.status===403);assert.equal(calls,0);
});
test('catalog and capacity discard results if machine policy changes during read',async()=>{
  for(const operation of ['datasets.catalog','datasets.capacity']){
    const user={id:principal.userId,enabled:true,limits:{[machines[0]]:1}},s={store:{get:()=>user},bridge:async()=>{
      user.limits[machines[0]]=0;
      return {datasets:[{dataset:'private',versions:[{version,state:'READY'}]}],filesystemBytes:100,availableBytes:90,reserveBytes:10,usableBytes:80};
    }};
    await assert.rejects(datasetCatalogCall(s,principal,operation,{machine:machines[0]}),e=>e.status===403);
  }
});
