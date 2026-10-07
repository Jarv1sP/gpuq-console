import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptOriginal,adaptStorageOverview,overviewDatasetCatalog,readableDatasetCatalog,aggregateDatasetCatalog,displayStorageCapacity,warehouseStorageCards,datasetWarehouseMachines} from '../dist/dataset-catalog-model.js';
import {warehouseCapacityHTML,storageCapacityDetailHTML,cacheCapacityRatio} from '../dist/dataset-flow.js';
const version='a'.repeat(64),at='2026-10-08T01:23:00Z';
const volume=(extra={})=>({id:'volume-a',state:'READY',checkedAt:at,totalBytes:1000,usedBytes:700,availableBytes:300,reserveBytes:50,usableBytes:250,...extra});
const snapshot=()=>({protocol:'dataset-storage-overview-v1',checkedAt:at,partial:false,filePreviewAvailable:false,
 warehouse:{state:'READY',volumes:[{machine:'server-a',volume:volume(),originalContentBytes:600,warnings:[]}]},
 caches:[{machine:'server-a',state:'READY',volume:volume(),readyContentBytes:200,readyVersionCount:3,budgetBytes:400,usageComplete:true}],
 datasets:[{dataset:'samples',displayName:'示例数据',versions:[{version,ownerLabel:'所属用户：alice',contentBytes:600,fileCount:12,canUse:true,originals:[{machine:'server-a',dataset:'samples',state:'READY'}],caches:[{machine:'server-a',dataset:'physical-samples',state:'READY',canUse:true,canPrepare:false}]}]}]});
test('unsupported overview responses preserve legacy UI instead of inventing capacity',()=>{
 for(const raw of [null,{},404,{protocol:0},{...snapshot(),protocol:'future'}, {...snapshot(),caches:null}])assert.equal(adaptStorageOverview(raw),null);
});
test('warehouse, registered cache and physical disk use independent quantities',()=>{
 const result=adaptStorageOverview(snapshot());assert.equal(result.warehouse.contentBytes,600);assert.equal(result.warehouse.usedBytes,700);
 assert.equal(result.warehouse.availableBytes,300);assert.equal(cacheCapacityRatio(result.caches[0]),.5);assert.equal(result.caches[0].shared,true);
 const html=warehouseCapacityHTML(result.warehouse,result.checkedAt)+storageCapacityDetailHTML(result.caches[0]);
 for(const label of ['数据集','其他','可用','缓存','磁盘','与仓库同盘'])assert(html.includes(label));
 assert.doesNotMatch(html,/原件|软件预算|所在磁盘|承载卷|只预警|<p|<script/);
 assert.match(html,/title="检查于/);assert.equal((html.match(/class="(?:cache|used|free|reserve)"/g)||[]).length,20);
});
test('null and invalid quantities stay unknown; incomplete confirmed quantities keep a plus and real zero stays zero',()=>{
 const raw=snapshot();raw.warehouse.volumes[0].volume.totalBytes=null;raw.caches[0].readyContentBytes=0;raw.caches[0].usageComplete=false;
 const result=adaptStorageOverview(raw);assert.equal(result.warehouse.totalBytes,null);assert.equal(result.warehouse.known,false);assert.equal(cacheCapacityRatio(result.caches[0]),0);
 assert.match(warehouseCapacityHTML(result.warehouse,at),/未知/);assert.doesNotMatch(storageCapacityDetailHTML(result.caches[0]),/>未知/,'a known partial zero is 0+, not unknown');
 assert.match(storageCapacityDetailHTML(result.caches[0]),/0 B\+<small>/);assert.match(storageCapacityDetailHTML(result.caches[0]),/title="部分统计/);
 raw.caches[0].usageComplete=true;assert.equal(cacheCapacityRatio(adaptStorageOverview(raw).caches[0]),0);
 for(const value of [-1,'300',NaN]){raw.caches[0].readyContentBytes=value;assert.equal(adaptStorageOverview(raw).caches[0].readyContentBytes,null);}
});
test('warehouse other content never becomes negative when logical content exceeds physical usage',()=>{
 const raw=snapshot();raw.warehouse.volumes[0].originalContentBytes=800;
 const result=adaptStorageOverview(raw);assert.equal(result.warehouse.known,true);
 assert.match(warehouseCapacityHTML(result.warehouse,at),/其他 <b class="num">0 B/);
 assert.doesNotMatch(warehouseCapacityHTML(result.warehouse,at),/data-v3-percent="-/);
});
const legacyModel=()=>aggregateDatasetCatalog({machine:'server-a',checkedAt:at,partial:false,
 machines:[{machine:'server-a',state:'ok'},{machine:'server-b',state:'ok'}],datasets:[{dataset:'samples',versions:[{
  version,state:'READY',canUse:true,bytes:200,files:2,ownerLabel:'所属用户：alice',locations:[
   {machine:'server-a',dataset:'physical-a',state:'READY',canUse:true},{machine:'server-b',dataset:'physical-b',state:'READY',canUse:true}]}]}]});
const oldCapacity={machine:'server-a',available:true,filesystemBytes:1000,availableBytes:300,reserveBytes:50,usableBytes:250};
test('v4 makes one card per observed warehouse with unique logical versions, not one aggregate or one card per cache',()=>{
 const model=legacyModel(),v=model.datasets[0].versions[0];
 v.warehouse={originalConfirmed:true,machine:'server-b',records:[{machine:'server-a',storage:{version,archiveMachine:'server-b',phase:'ARCHIVED',originalRetained:true}}]};
 model.datasets[0].versions.push({...structuredClone(v),version:'b'.repeat(64),bytes:300});
 model.datasets.push({...structuredClone(model.datasets[0]),dataset:'more',versions:[{...structuredClone(v),bytes:50,warehouse:{originals:[{machine:'server-a',state:'READY',confirmed:false}]}}]});
 const cards=warehouseStorageCards(null,model,new Map([['server-a',oldCapacity],['server-b',oldCapacity]]));
 assert.equal(cards.length,2);assert.equal(cards.find(row=>row.machine==='server-b').contentBytes,500);assert.equal(cards.find(row=>row.machine==='server-b').datasetCount,1);
 assert.equal(cards.find(row=>row.machine==='server-a').contentBytes,50);assert.equal(cards.find(row=>row.machine==='server-a').datasetCount,1);
 for(const row of cards){assert.equal(row.totalBytes,null);assert.equal(row.availableBytes,null);assert.equal(row.known,false);}
 assert.deepEqual(datasetWarehouseMachines(v),['server-b']);
 assert.deepEqual(warehouseStorageCards(null,null,new Map()),[],'missing observations never create a fictional warehouse');
});
test('v4 uses only explicitly identified warehouse volumes, and unknown snapshots with collection time stay unknown',()=>{
 const model=legacyModel(),v=model.datasets[0].versions[0];v.warehouse={originalConfirmed:true,machine:'server-a',records:[]};
 const capacity={...oldCapacity,storageOverview:{protocol:'dataset-storage-node-v1',warehouse:{state:'READY',volume:{filesystemBytes:2000,usedBytes:1100,availableBytes:900,reserveBytes:100,collectedAt:at}}}};
 const [card]=warehouseStorageCards(null,model,new Map([['server-a',capacity]]));
 assert.equal(card.totalBytes,2000);assert.equal(card.usedBytes,1100);assert.equal(card.availableBytes,900);assert.equal(card.contentBytes,200);assert.equal(card.collectedAt,at);
 const raw=snapshot();raw.partial=true;raw.warehouse.state='UNKNOWN';raw.warehouse.volumes[0].volume.collectedAt=at;
 raw.warehouse.volumes[0].volume.totalBytes=null;raw.caches[0].volume=volume({totalBytes:null,usedBytes:null,availableBytes:null,collectedAt:at});
 const overview=adaptStorageOverview(raw);
 assert.equal(warehouseStorageCards(overview,model,new Map([['server-a',capacity]]))[0].totalBytes,null,'a past successful timestamp is not a current capacity');
 assert.equal(displayStorageCapacity(overview,model,new Map([['server-a',oldCapacity]])).caches[0].volume.totalBytes,null,'old cached reads cannot fill a failed collected snapshot');
});
test('the existing catalog and public capacity shape render all three components without overview or an invented budget',()=>{
 const model=legacyModel(),result=displayStorageCapacity(null,model,new Map([['server-a',oldCapacity]]));
 assert.equal(result.warehouse.contentBytes,200,'one version is not counted twice for two copies');assert.equal(result.warehouse.totalBytes,null);
 assert.equal(result.caches[0].readyContentBytes,200);assert.equal(result.caches[1].readyContentBytes,200);
 assert.equal(result.caches[0].budgetBytes,null);assert.equal(result.caches[0].volume.totalBytes,1000);assert.equal(result.caches[0].volume.usedBytes,700);
 assert.equal(result.caches[0].volume.availableBytes,300);assert.equal(result.caches[0].volume.id,null);assert.equal(result.caches[0].shared,false);
 assert.equal(result.caches[1].volume.totalBytes,null);assert.equal(result.protocol,undefined);
 const html=warehouseCapacityHTML(result.warehouse,at)+storageCapacityDetailHTML(result.caches[0]);
 assert.match(html,/capacity-strata/);assert.match(html,/capacity-cache-rail/);assert.match(html,/capacity-disk/);assert.match(html,/200 B/);assert.match(html,/700 B/);assert.match(html,/可用 300 B/);
});
test('fallback respects the readable set and only READY copies contribute to cache quantities',()=>{
 const model=legacyModel();model.datasets.push({...structuredClone(model.datasets[0]),dataset:'private',versions:model.datasets[0].versions.map(v=>({...v,bytes:900,canUse:false,ownerLabel:'所属用户：bob',servers:v.servers.map(row=>({...row,ownerLabel:'所属用户：bob'}))}))});
 model.datasets[0].versions[0].servers[1].state='PREPARING';
 const result=displayStorageCapacity(null,readableDatasetCatalog(model,{userId:'alice',username:'alice',role:'member'}));
 assert.equal(result.warehouse.contentBytes,200);assert.equal(result.caches[0].readyContentBytes,200);assert.equal(result.caches[1].readyContentBytes,0);
 assert.equal(displayStorageCapacity(null,readableDatasetCatalog(model,{userId:'admin',role:'admin'})).warehouse.contentBytes,1100);
});
test('missing catalog, invalid capacity and failed nodes do not turn into zero capacity or a shared warehouse disk',()=>{
 const empty=displayStorageCapacity(null,null,new Map(),[{id:'server-a'}]);
 assert.equal(empty.warehouse.contentBytes,null);assert.equal(empty.caches[0].readyContentBytes,null);assert.equal(empty.caches[0].volume.totalBytes,null);
 for(const capacity of [null,{...oldCapacity,available:false},{...oldCapacity,availableBytes:1001},{...oldCapacity,filesystemBytes:'1000'}]){
  assert.equal(displayStorageCapacity(null,legacyModel(),new Map([['server-a',capacity]])).caches[0].volume.totalBytes,null);
 }
 const model=legacyModel();model.machines[0].state='unavailable';
 assert.equal(displayStorageCapacity(null,model).caches[0].readyContentBytes,null);
 model.machines[0].state='ok';model.datasets[0].versions[0].bytes=null;
 assert.equal(displayStorageCapacity(null,model).caches[0].readyContentBytes,null,'a READY copy with no size is unknown, not a zero-size copy');
 model.datasets[0].versions[0].bytes=200;model.capacityUsageComplete=false;
 assert.match(storageCapacityDetailHTML(displayStorageCapacity(null,model).caches[0]),/200 B\+/,'filtered metadata supplies a lower bound, not complete fleet usage');
});
test('a partial new overview fills only missing display facts and cannot mint a protocol or overwrite known values',()=>{
 const raw=snapshot();raw.partial=true;raw.warehouse.state='UNKNOWN';raw.warehouse.volumes=[];
 raw.caches[0].volume=volume({totalBytes:null,usedBytes:null,availableBytes:null});raw.caches[0].readyContentBytes=null;
 const actual=adaptStorageOverview(raw),result=displayStorageCapacity(actual,legacyModel(),new Map([['server-a',oldCapacity]]));
 assert.equal(result.warehouse.contentBytes,200);assert.equal(result.warehouse.totalBytes,null);assert.equal(result.caches[0].readyContentBytes,200);
 assert.equal(result.caches[0].budgetBytes,400);assert.equal(result.caches[0].volume.usedBytes,700);assert.equal(result.partial,true);
 assert.equal(result.protocol,undefined);assert.equal(actual.caches[0].readyContentBytes,null,'never mutate authoritative observations');
});
test('only the same node and volume are deduplicated; conflicting observations lose certainty',()=>{
 const raw=snapshot();raw.warehouse.volumes.push(structuredClone(raw.warehouse.volumes[0]));
 assert.equal(adaptStorageOverview(raw).warehouse.totalBytes,1000);
 raw.warehouse.volumes.push({...structuredClone(raw.warehouse.volumes[0]),machine:'server-b'});
 assert.equal(adaptStorageOverview(raw).warehouse.totalBytes,2000);
 raw.caches[0].machine='server-c';assert.equal(adaptStorageOverview(raw).caches[0].shared,false);
 raw.warehouse.volumes.push({...structuredClone(raw.warehouse.volumes[0]),originalContentBytes:601});
 assert.equal(adaptStorageOverview(raw).warehouse.contentBytes,null);assert.equal(adaptStorageOverview(raw).warehouse.known,false);
});
test('space warnings never change reading or upload permissions, shared and unknown facts are not low space',()=>{
 const raw=snapshot();raw.warehouse.warnings=[{code:'CACHE_WAREHOUSE_SHARED_VOLUME'},{code:'WAREHOUSE_CAPACITY_UNKNOWN'}];
 assert.equal(adaptStorageOverview(raw).warehouse.warning,false);
 raw.warehouse.warnings.push({code:'WAREHOUSE_USAGE_HIGH'});let result=adaptStorageOverview(raw);
 assert.equal(result.warehouse.warning,true);assert.match(warehouseCapacityHTML(result.warehouse,at),/仓库空间不足/);assert.equal(result.datasets[0].versions[0].canUse,true);
 raw.warehouse.warnings=[];raw.warehouse.volumes[0].volume=volume({usedBytes:950,availableBytes:50,usableBytes:0});
 assert.equal(adaptStorageOverview(raw).warehouse.warning,true);
});
test('only warehouseReady true proves a warehouse copy; no state, historical proof, machine name or path can substitute',()=>{
 for(const state of ['READY','ARCHIVED','CONFIRMED'])assert.equal(adaptOriginal({machine:'server-a',dataset:'samples',state,path:'/warehouse'}).confirmed,false);
 assert.equal(adaptOriginal({state:'READY',confirmed:false,proof:{}}).confirmed,false);
 assert.equal(adaptOriginal({machine:'server-a',state:'READY',confirmed:true}).confirmed,false);
 assert.equal(adaptOriginal({machine:'server-a',proof:{receipt:'explicit-node-proof'}}).confirmed,false);
 for(const value of [undefined,null,false,1,'true'])assert.equal(adaptOriginal({warehouseReady:value}).confirmed,false);
 assert.equal(adaptOriginal({machine:'server-a',warehouseReady:true}).confirmed,true);
 assert.equal(adaptOriginal({state:'backend-raw-state'}).state,'backend-raw-state');
});
test('overview aggregation keeps full hashes, physical references, ownership and explicit readability',()=>{
 const raw=snapshot();raw.datasets.push({...structuredClone(raw.datasets[0]),dataset:'foreign'});raw.datasets[1].versions[0].canUse=false;raw.datasets[1].versions[0].ownerLabel='所属用户：bob';
 const result=overviewDatasetCatalog(adaptStorageOverview(raw),'server-a');
 assert.equal(result.datasets[0].versions[0].warehouse.originalConfirmed,false);assert.equal(result.datasets[0].versions[0].warehouse.state,'unknown');
 assert.equal(result.datasets[0].versions[0].servers[0].dataset,'physical-samples');assert.equal(result.datasets[0].displayName,'示例数据');
 assert.equal(result.datasets[0].versions[0].version,version);
 assert.deepEqual(readableDatasetCatalog(result,{userId:'alice-id',username:'alice',role:'member'}).datasets.map(row=>row.dataset),['samples']);
 assert.equal(readableDatasetCatalog(result,{userId:'admin',role:'admin'}).datasets.length,2);
 raw.datasets[0].versions[0].originals[0].warehouseReady=true;
 assert.equal(overviewDatasetCatalog(adaptStorageOverview(raw),'server-a').datasets[0].versions[0].warehouse.originalConfirmed,true);
});
test('unreachable cache nodes remain unavailable and never supply a preparation source',()=>{
 const raw=snapshot();raw.caches[0].state='UNAVAILABLE';
 const model=overviewDatasetCatalog(adaptStorageOverview(raw),'server-a');assert.equal(model.machines[0].state,'unavailable');assert.equal(model.partial,true);
 assert.equal(model.datasets[0].versions[0].selected.sourceMachine,null);
});
