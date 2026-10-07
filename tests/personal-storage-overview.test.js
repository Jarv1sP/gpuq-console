import test from 'node:test';
import assert from 'node:assert/strict';
import {MACHINES} from '../dist/model.js';
import {datasetStorageOverviewCall} from '../dataset-storage-overview.mjs';
import {adaptStorageOverview,overviewDatasetCatalog,displayStorageCapacity} from '../dist/dataset-catalog-model.js';

const machine=MACHINES[0].id,version='a'.repeat(64),dataset='h-0123456789abcdef-own-data';
function fixture(role='personal-original'){
 const user={id:'demo-user-1',username:'member',enabled:true,role:'member',limits:{[machine]:1}},calls=[];
 const volume={filesystemBytes:1000,usedBytes:100,availableBytes:800,reserveBytes:0,usableBytes:800,
  volumeDeviceId:'f'.repeat(64),checkedAt:'2026-01-01T00:00:00Z',readOnly:false,guarded:true};
 const service={store:{get:()=>user,users:[user]},bridge:async(id,operation,args)=>{
  calls.push({id,operation,args});
  if(operation==='datasets.list')return {datasets:id===machine?[{dataset,ownerIds:[user.id],versions:[{version,state:'READY',bytes:42,files:1,canPrepare:false,storageTier:'hdd',...(role?{storageRole:role}:{})}]}]:[]};
  if(operation==='datasets.capacity')return {...volume,storageOverview:{protocol:'dataset-storage-node-v1',cache:{volume,budgetBytes:100},warehouse:null}};
  throw Error('Unexpected metadata operation '+operation);
 }};
 return {service,user,calls};
}
test('personal HDD original stays usable in the overview but never inflates central SSD cache counters',async()=>{
 const f=fixture(),value=await datasetStorageOverviewCall(f.service,{userId:f.user.id,username:f.user.username,role:'member'},{});
 const cache=value.caches.find(row=>row.machine===machine);assert.equal(cache.readyContentBytes,0);assert.equal(cache.readyVersionCount,0);
 const v=value.datasets[0].versions[0];assert.deepEqual(v.caches,[]);assert.deepEqual(v.originals,[]);assert.equal(v.personalOriginals[0].storageTier,'hdd');
 const model=overviewDatasetCatalog(adaptStorageOverview(value),machine),local=model.datasets[0].versions[0].selected;
 assert.equal(local.state,'READY');assert.equal(local.canUse,true);assert.equal(local.storageRole,'personal-original');assert.equal(local.storageTier,'hdd');
 assert.equal(model.datasets[0].versions[0].warehouse.originalConfirmed,false,'Private local original is not a managed warehouse backup');
 assert.ok(f.calls.every(call=>['datasets.list','datasets.capacity'].includes(call.operation)));
});
test('an h-prefixed legacy registration alone never supplies a private-root role',async()=>{
 const f=fixture(null),value=await datasetStorageOverviewCall(f.service,{userId:f.user.id,role:'member'},{});
 assert.equal(value.caches.find(row=>row.machine===machine).readyContentBytes,42);
 assert.equal(Object.hasOwn(value.datasets[0].versions[0],'personalOriginals'),false);
});
test('only a complete matching catalog proves absence while explicit original readability survives overview projection',()=>{
 const raw={protocol:'dataset-storage-overview-v1',checkedAt:'2026-01-01T00:00:00Z',partial:false,
  warehouse:{state:'NOT_CONFIGURED',volumes:[]},caches:[{machine,state:'READY',usageComplete:true,volume:{}}],
  datasets:[{dataset:'sample',versions:[{version,canUse:true,originals:[{machine,dataset:'sample',state:'READY',warehouseReady:true,canUse:true}],caches:[]}]}]};
 const legacy={machine,machines:[{machine,state:'ok'}],datasets:[{dataset:'sample',versions:[{version,canUse:true,locations:[]}]}]};
 assert.equal(overviewDatasetCatalog(adaptStorageOverview(raw),machine).datasets[0].versions[0].selected.state,'UNKNOWN','capacity alone cannot prove an absent cache');
 let model=overviewDatasetCatalog(adaptStorageOverview(raw),machine,legacy);assert.equal(model.datasets[0].versions[0].selected.state,'NOT_LOCAL');
 assert.equal(model.datasets[0].versions[0].canUse,true,'only explicit per-location reading evidence supplies readability');
 assert.equal(model.datasets[0].versions[0].warehouse.originalConfirmed,true);
 raw.caches[0].state='UNKNOWN';
 model=overviewDatasetCatalog(adaptStorageOverview(raw),machine,legacy);assert.equal(model.datasets[0].versions[0].selected.state,'NOT_LOCAL','capacity unknown is independent of a complete directory observation');
 raw.caches[0].usageComplete=false;raw.datasets[0].versions[0].canUse=false;raw.datasets[0].versions[0].originals[0].canUse=false;
 legacy.machines[0].state='unavailable';
 model=overviewDatasetCatalog(adaptStorageOverview(raw),machine,legacy);assert.equal(model.datasets[0].versions[0].selected.state,'UNKNOWN');
 assert.equal(model.datasets[0].versions[0].canUse,false,'confirmed backup alone never supplies file permission');
});
test('personal originals never inflate managed cache or warehouse fallback even when overview usage is incomplete',async()=>{
 const f=fixture(),value=await datasetStorageOverviewCall(f.service,{userId:f.user.id,role:'member'},{});
 value.caches.find(row=>row.machine===machine).usageComplete=false;
 const overview=adaptStorageOverview(value),legacy={machine,machines:MACHINES.map(row=>({machine:row.id,state:'ok'})),datasets:[]};
 const model=overviewDatasetCatalog(overview,machine,legacy);
 for(const observed of [overview,null]){
  const display=displayStorageCapacity(observed,model);
  assert.equal(display.caches.find(row=>row.machine===machine).readyContentBytes,0);
  assert.equal(display.warehouse.contentBytes,0,'private versions are not central warehouse contents');
 }
 assert.equal(model.datasets[0].versions[0].selected.canUse,true,'accounting separation does not hide legitimate local training');
});
