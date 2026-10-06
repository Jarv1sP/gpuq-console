import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateDatasetCatalog} from '../dist/dataset-catalog-model.js';

const version='a'.repeat(64),other='b'.repeat(64);
const storage=(extra={})=>({dataset:'logical-data',version,phase:'ARCHIVED',archiveMachine:'archive-node',originalRetained:true,...extra});
const location=(extra={})=>({machine:'training-node',dataset:'physical-copy',state:'READY',ownerLabel:'共享授权用户：示例成员',canPrepare:false,storage:storage(),...extra});
const item=(extra={})=>({dataset:'logical-data',name:'中文训练集',displayNameRevision:3,labelScope:'personal',versions:[{version,bytes:0,files:0,state:'READY',canPrepare:false,ownerLabel:'共享授权用户：示例成员',locations:[location()]}],...extra});
const catalog=(datasets=[item()],extra={})=>({machine:'training-node',partial:false,checkedAt:'2026-10-06T00:00:00Z',machines:[{machine:'training-node',state:'ok'},{machine:'other-training-node',state:'ok'},{machine:'unreachable-node',state:'unavailable'}],datasets,...extra});
const one=value=>aggregateDatasetCatalog(value).datasets[0].versions[0];
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;}

test('catalog model is pure, preserves exact IDs, physical cache aliases, personal names and zero quantities',()=>{
  const input=freeze(catalog()),before=JSON.stringify(input),result=aggregateDatasetCatalog(input),dataset=result.datasets[0],v=dataset.versions[0];
  assert.equal(typeof globalThis.document,'undefined');assert.equal(JSON.stringify(input),before);
  assert.equal(dataset.dataset,'logical-data');assert.equal(dataset.displayName,'中文训练集');assert.equal(dataset.displayNameRevision,3);
  assert.equal(v.version,version);assert.equal(v.bytes,0);assert.equal(v.files,0);assert.equal(v.ownerLabel,'共享授权用户：示例成员');
  assert.equal(v.servers[0].dataset,'physical-copy');assert.equal(v.warehouse.records[0].storage.dataset,'logical-data');
  assert.deepEqual(v.selected,{machine:'training-node',state:'READY',canPrepare:false,sourceMachine:null,sourceDataset:null,error:null});
  assert.equal(result.checkedAt,input.checkedAt);assert.equal(result.partial,true);
  v.warehouse.records[0].storage.phase='FAILED';assert.equal(input.datasets[0].versions[0].locations[0].storage.phase,'ARCHIVED');
  assert.equal(Object.hasOwn(dataset,'latestVersion'),false);assert.equal(Object.hasOwn(result,'capacity'),false);
});

test('only exact logical ID and full version aggregate; shared names, prefixes and different hashes stay distinct',()=>{
  const first=item(),duplicate=item({versions:[{...first.versions[0],locations:[location({machine:'other-training-node',dataset:'receipt-bound-copy'})]}]});
  const otherVersion=item({versions:[{...first.versions[0],version:other,locations:[location({storage:storage({version:other})})]}]});
  const lookalike=item({dataset:'another-logical-data'});
  const result=aggregateDatasetCatalog(catalog([first,duplicate,otherVersion,lookalike]));
  assert.equal(result.datasets.length,2);assert.equal(result.datasets[0].versions.length,2);
  assert.deepEqual(result.datasets[0].versions.map(row=>row.version),[version,other]);
  const v=result.datasets[0].versions[0];assert.equal(v.servers[1].dataset,'receipt-bound-copy');assert.equal(v.servers[1].state,'READY');
  assert.equal(result.datasets[1].dataset,'another-logical-data');
});

test('omitted location is absence only for a confirmed node; unavailable and unlisted nodes stay unknown',()=>{
  const v=one(catalog());assert.equal(v.servers.find(row=>row.machine==='other-training-node').state,'NOT_LOCAL');
  const missing=v.servers.find(row=>row.machine==='unreachable-node');assert.equal(missing.state,'UNKNOWN');assert.equal(missing.observed,false);assert.equal(missing.dataset,null);
  const input=catalog();input.datasets[0].versions[0].locations.push(location({machine:'returned-node',state:'UNKNOWN',storage:undefined}));
  const result=aggregateDatasetCatalog(input);assert.equal(result.machines.find(row=>row.machine==='returned-node').state,'unavailable');
  assert.equal(result.datasets[0].versions[0].servers.find(row=>row.machine==='returned-node').state,'UNKNOWN');
  assert.equal(result.checkedAt,input.checkedAt);
  assert.equal(aggregateDatasetCatalog({...input,checkedAt:undefined}).checkedAt,null);
});

test('selected transfer state is retained without promoting a remote READY copy into local readiness',()=>{
  const input=catalog();const v=input.datasets[0].versions[0];v.state='PREPARING';v.canPrepare=true;v.sourceMachine='other-training-node';v.sourceDataset='physical-source';v.locations=[location({machine:'other-training-node',dataset:'physical-source'})];
  const result=one(input);assert.equal(result.selected.state,'PREPARING');assert.equal(result.selected.canPrepare,true);
  assert.equal(result.selected.sourceMachine,'other-training-node');assert.equal(result.selected.sourceDataset,'physical-source');
  assert.equal(result.servers[0].observed,false);assert.equal(result.servers[0].dataset,null);
  input.machines[0].state='unavailable';assert.equal(one(input).selected.state,'UNKNOWN');
});

test('same hash with contradictory local observations or quantities becomes unknown rather than choosing a winner',()=>{
  const input=catalog(),v=input.datasets[0].versions[0];input.datasets.push(item({versions:[{...v,bytes:10,files:20,locations:[location({state:'FAILED'})]}]}));
  const result=one(input);assert.equal(result.servers[0].conflict,true);assert.equal(result.selected.state,'UNKNOWN');assert.equal(result.selected.canPrepare,false);
  assert.equal(result.servers[0].dataset,null);assert.equal(result.bytes,null);assert.equal(result.files,null);
  const repeat=catalog([item(),item()]);assert.equal(one(repeat).servers[0].conflict,false);assert.equal(one(repeat).selected.state,'READY');
});

test('selected in-flight transfer overlays a registered local cache row',()=>{
  const input=catalog(),v=input.datasets[0].versions[0];
  v.state='PREPARING';v.locations[0].state='REGISTERED';v.canPrepare=true;
  const result=one(input);
  assert.equal(result.selected.state,'PREPARING');
  assert.equal(result.servers[0].state,'PREPARING');
  assert.equal(result.servers[0].dataset,'physical-copy');
  v.state='FAILED';assert.equal(one(input).selected.state,'FAILED');
});

test('a selected READY claim without that node\'s READY physical cache stays unknown',()=>{
  const input=catalog(),v=input.datasets[0].versions[0];
  v.locations=[location({machine:'other-training-node'})];
  assert.equal(one(input).selected.state,'UNKNOWN');
  assert.equal(one(input).servers[1].state,'READY');
  v.locations=[location({state:'REGISTERED'})];
  assert.equal(one(input).selected.state,'UNKNOWN');
});

test('preserved warehouse original requires same immutable version, ARCHIVED, retained and a destination',()=>{
  assert.equal(one(catalog()).warehouse.state,'saved');assert.equal(one(catalog()).warehouse.originalConfirmed,true);
  for(const change of [{version:other},{originalRetained:false},{archiveMachine:null},{archiveMachine:''},{dataset:''},{phase:'FUTURE'},{phase:'BLOCKED'}]){
    const input=catalog();input.datasets[0].versions[0].locations[0].storage=storage(change);
    assert.equal(one(input).warehouse.state,'unknown',JSON.stringify(change));assert.equal(one(input).warehouse.originalConfirmed,false);
  }
});

test('warehouse pending, failed, conflicting destinations and missing records remain separate facts',()=>{
  for(const phase of ['QUEUED','COPYING','PROVISIONING','CERTIFYING']){
    const input=catalog();input.datasets[0].versions[0].locations[0].storage=storage({phase});
    assert.equal(one(input).warehouse.state,'pending');assert.equal(one(input).warehouse.phase,phase);assert.equal(one(input).warehouse.originalConfirmed,false);
  }
  const input=catalog(),v=input.datasets[0].versions[0];v.locations[0].storage=storage({phase:'FAILED',error:'test failure'});
  assert.equal(one(input).warehouse.state,'failed');assert.equal(one(input).warehouse.records[0].storage.error,'test failure');
  v.locations[0].storage=storage();v.locations.push(location({machine:'other-training-node',storage:storage({archiveMachine:'another-archive-node'})}));
  assert.equal(one(input).warehouse.state,'unknown');assert.equal(one(input).warehouse.originalConfirmed,false);
  v.locations.forEach(row=>delete row.storage);assert.equal(one(input).warehouse.state,'unrecorded');assert.equal(one(input).warehouse.machine,null);
  assert.equal(Object.hasOwn(one(input).warehouse,'released'),false);assert.equal(Object.hasOwn(one(input).warehouse,'progress'),false);
});

test('personal label metadata is not a training ID or a guessed revision; conflicting labels fall back to ID',()=>{
  for(const change of [{labelScope:'shared'},{displayNameRevision:undefined},{displayNameRevision:-1},{name:''},{labelScope:undefined}]){
    const input=catalog([item(change)]),result=aggregateDatasetCatalog(input).datasets[0];
    assert.equal(result.displayName,'logical-data');assert.equal(result.displayNameRevision,null);assert.equal(result.labelScope,null);
  }
  const result=aggregateDatasetCatalog(catalog([item(),item({name:'另一个名称',displayNameRevision:4})])).datasets[0];
  assert.equal(result.displayName,'logical-data');assert.equal(result.displayNameRevision,null);
});

test('future states and pending removal facts remain unknown or protected, never READY or released',()=>{
  const input=catalog();const v=input.datasets[0].versions[0];v.state='FUTURE';v.locations[0]={...location(),state:'FUTURE',removalPending:true,removalGraceEligible:true};
  const result=one(input);assert.equal(result.selected.state,'UNKNOWN');assert.equal(result.servers[0].removalPending,true);assert.equal(result.servers[0].removalGraceEligible,true);
  assert.equal(result.servers[0].ownerLabel,'共享授权用户：示例成员');
});

test('valid empty catalog is distinct from an invalid response; invalid IDs or short versions cannot become empty success',()=>{
  assert.deepEqual(aggregateDatasetCatalog(catalog([])).datasets,[]);
  for(const value of [null,{},catalog(undefined,{datasets:null}),catalog([],{machines:null}),catalog([],{machine:'../node'}),catalog([item({dataset:'../data'})]),catalog([item({versions:[{version:'a',locations:[]}]})])])
    assert.throws(()=>aggregateDatasetCatalog(value),TypeError);
});
