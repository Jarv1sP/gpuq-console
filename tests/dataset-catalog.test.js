import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetCatalogCall} from '../dataset-catalog.mjs';
import {MACHINES} from '../dist/model.js';
const machines=MACHINES.slice(0,2).map(m=>m.id),version='a'.repeat(64),principal={userId:'demo-user-1',role:'member'};
function fixture(bridge){return {bridge,store:{get:()=>({id:principal.userId,enabled:true,limits:Object.fromEntries(machines.map(m=>[m,1]))})}};}
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
