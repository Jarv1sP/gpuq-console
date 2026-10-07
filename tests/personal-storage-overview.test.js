import test from 'node:test';
import assert from 'node:assert/strict';
import {MACHINES} from '../dist/model.js';
import {datasetStorageOverviewCall} from '../dataset-storage-overview.mjs';
import {adaptStorageOverview,overviewDatasetCatalog} from '../dist/dataset-catalog-model.js';

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
