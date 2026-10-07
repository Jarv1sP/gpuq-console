import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptOriginal,adaptStorageOverview,overviewDatasetCatalog,readableDatasetCatalog} from '../dist/dataset-catalog-model.js';
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
test('null, invalid and incomplete quantities stay unknown; real zero stays zero',()=>{
 const raw=snapshot();raw.warehouse.volumes[0].volume.totalBytes=null;raw.caches[0].readyContentBytes=0;raw.caches[0].usageComplete=false;
 const result=adaptStorageOverview(raw);assert.equal(result.warehouse.totalBytes,null);assert.equal(result.warehouse.known,false);assert.equal(cacheCapacityRatio(result.caches[0]),null);
 assert.match(warehouseCapacityHTML(result.warehouse,at),/未知/);assert.match(storageCapacityDetailHTML(result.caches[0]),/未知/);
 raw.caches[0].usageComplete=true;assert.equal(cacheCapacityRatio(adaptStorageOverview(raw).caches[0]),0);
 for(const value of [-1,'300',NaN]){raw.caches[0].readyContentBytes=value;assert.equal(adaptStorageOverview(raw).caches[0].readyContentBytes,null);}
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
test('契约待定稿: explicit proof only, never infer confirmation from READY, machine name or path',()=>{
 for(const state of ['READY','ARCHIVED','CONFIRMED'])assert.equal(adaptOriginal({machine:'server-a',dataset:'samples',state,path:'/warehouse'}).confirmed,false);
 assert.equal(adaptOriginal({state:'READY',confirmed:false,proof:{}}).confirmed,false);
 assert.equal(adaptOriginal({machine:'server-a',state:'READY',confirmed:true}).confirmed,true);
 assert.equal(adaptOriginal({machine:'server-a',proof:{receipt:'explicit-node-proof'}}).confirmed,true);
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
 raw.datasets[0].versions[0].originals[0].confirmed=true;
 assert.equal(overviewDatasetCatalog(adaptStorageOverview(raw),'server-a').datasets[0].versions[0].warehouse.originalConfirmed,true);
});
test('unreachable cache nodes remain unavailable and never supply a preparation source',()=>{
 const raw=snapshot();raw.caches[0].state='UNAVAILABLE';
 const model=overviewDatasetCatalog(adaptStorageOverview(raw),'server-a');assert.equal(model.machines[0].state,'unavailable');assert.equal(model.partial,true);
 assert.equal(model.datasets[0].versions[0].selected.sourceMachine,null);
});
