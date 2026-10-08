import assert from 'node:assert/strict';
import test from 'node:test';
import {adaptOriginal,adaptStorageOverview,overviewDatasetCatalog,hasReadableLocalOriginal} from '../dist/dataset-catalog-model.js';
import {datasetAccess} from '../dist/datasets-ui.js';

const machine='server-a',dataset='training-data',version='a'.repeat(64);
function fixture(){
  return {protocol:'dataset-storage-overview-v1',warehouse:{state:'READY',volumes:[]},
    caches:[{machine,state:'READY',usageComplete:true}],datasets:[{dataset,versions:[{
      version,canUse:true,originals:[{machine,dataset,state:'READY',warehouseReady:true,canUse:true}],
      caches:[{machine,dataset:'private-training-cache',state:'NOT_LOCAL',canUse:false,canPrepare:true}]
    }]}]};
}
function access(raw=fixture(),options){
  const model=overviewDatasetCatalog(adaptStorageOverview(raw),machine),v=model.datasets[0].versions[0];
  return {model,v,result:datasetAccess({...v,state:v.selected.state,canPrepare:v.selected.canPrepare,
    sourceMachine:v.selected.sourceMachine,locations:v.servers},{machine},options)};
}

test('authorized local warehouse permits preparation without manufacturing a READY cache or remote source',()=>{
  const {v,result}=access();
  assert.equal(v.dataset,dataset);assert.equal(v.version,version);
  assert.equal(v.warehouse.originalConfirmed,true);assert.equal(hasReadableLocalOriginal(v,machine),true);
  assert.equal(v.selected.state,'NOT_LOCAL');assert.equal(v.selected.canUse,false);
  assert.equal(v.selected.sourceMachine,null);assert.equal(v.servers.length,1);
  assert.equal(v.servers[0].dataset,'private-training-cache');assert.equal(v.servers[0].state,'NOT_LOCAL');
  assert.equal(v.servers[0].canUse,false);
  assert.equal(result.prepare,true);assert.equal(result.canPrepare,true);
  assert.equal(result.selectable,true,'automatic preparation may precede training');
  assert.equal(result.browseOnly,false);assert.equal(result.ready,false,'training READY still needs a cache proof');
});

test('original readability is preserved strictly, separately from physical confirmation',()=>{
  const raw={machine,dataset,state:'READY',warehouseReady:true,canUse:true};
  assert.equal(adaptOriginal(raw).canUse,true);
  for(const value of [undefined,null,false,1,'true']){
    const original=adaptOriginal({...raw,canUse:value});
    assert.equal(original.confirmed,true);assert.equal(original.canUse,false);
  }
});

test('foreign, unknown, unconfirmed and missing local originals cannot authorize preparation',()=>{
  for(const change of [original=>original.canUse=false,original=>delete original.canUse,
    original=>original.state='UNKNOWN',original=>original.warehouseReady=false,
    original=>delete original.warehouseReady,original=>original.machine='server-b',
    original=>original.dataset='another-dataset']){
    const raw=fixture();change(raw.datasets[0].versions[0].originals[0]);
    const {v,result}=access(raw);
    assert.equal(hasReadableLocalOriginal(v,machine),false);
    assert.equal(result.prepare,false);assert.equal(result.selectable,false);assert.equal(result.ready,false);
    assert.equal(result.browseOnly,true);
  }
  const raw=fixture();raw.datasets[0].versions[0].originals=[];
  assert.equal(access(raw).result.prepare,false);
});

test('the original grant stays bound to its full version and does not bypass target authorization',()=>{
  const raw=fixture();raw.datasets[0].versions.push({...structuredClone(raw.datasets[0].versions[0]),
    version:'b'.repeat(64),originals:[]});
  const {model}=access(raw),v=model.datasets[0].versions[1];
  assert.equal(hasReadableLocalOriginal(v,machine),false);
  for(const options of [{machineAuthorized:false}]){
    const {result}=access(fixture(),options);
    assert.equal(result.prepare,false);assert.equal(result.selectable,false);assert.equal(result.browseOnly,true);
  }
  for(const field of ['canUse','canPrepare']){
    const denied=fixture(),v=denied.datasets[0].versions[0];
    if(field==='canUse')v.canUse=false;else v.caches[0].canPrepare=false;
    assert.equal(access(denied).result.prepare,false);
  }
});

test('contradictory local permissions and capacity-only observations stay closed',()=>{
  const raw=fixture(),v=raw.datasets[0].versions[0];
  v.originals.push({...v.originals[0],canUse:false});
  assert.equal(access(raw).result.prepare,false);
  const capacity=fixture();capacity.datasets[0].versions[0].originals=[];
  capacity.caches[0].volume={id:'cache-disk',state:'READY',totalBytes:1000,availableBytes:1000};
  assert.equal(access(capacity).result.prepare,false);
  const ready=fixture();ready.datasets[0].versions[0].caches[0].state='READY';
  assert.equal(access(ready).result.ready,false,'READY state without cache readability does not admit training');
  ready.datasets[0].versions[0].caches[0].canUse=true;
  assert.equal(access(ready).result.ready,true,'a readable READY cache remains usable');
});
