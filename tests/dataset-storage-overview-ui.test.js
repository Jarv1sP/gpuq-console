import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptOriginal,adaptUploadTarget,adaptStorageOverview,overviewDatasetCatalog,readableDatasetCatalog,aggregateDatasetCatalog,displayStorageCapacity,warehouseStorageCards,datasetWarehouseMachines} from '../dist/dataset-catalog-model.js';
import {warehouseCapacityHTML,warehouseCardHTML,storageCapacityDetailHTML,cacheCapacityRatio,trainingCapacitySegments,trainingCardHTML,trainingLegendHTML} from '../dist/dataset-flow.js';
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
test('upload target adapter (contract pending finalization) requires explicit available true and a nonempty targetMachine',()=>{
 for(const raw of [null,{}, {available:true},{available:true,targetMachine:null},{available:true,targetMachine:''},
  {available:true,targetMachine:' '},{available:true,targetMachine:1},{available:false,targetMachine:'new-warehouse'},
  {available:1,targetMachine:'new-warehouse'},{available:true,machine:'new-warehouse'},{available:true,storageMachine:'new-warehouse'}])assert.equal(adaptUploadTarget(raw),null);
 assert.equal(adaptUploadTarget({available:true,targetMachine:'new-warehouse'}),'new-warehouse');
});
test('an explicit upload target adds a zero-count warehouse without inventing migration, volume or warehouse proof',()=>{
 const model=legacyModel();model.datasets[0].versions[0].warehouse={machine:'server-a',originalConfirmed:true,records:[]};
 const admission={available:true,targetMachine:'new-warehouse'},cards=warehouseStorageCards(null,model,new Map(),model,admission);
 assert.equal(cards.length,2);const target=cards.find(row=>row.machine==='new-warehouse');assert.equal(target.uploadTarget,true);assert.equal(target.datasetCount,0);
 for(const key of ['totalBytes','usedBytes','availableBytes','contentBytes'])assert.equal(target[key],null);
 assert.equal(target.known,false);assert.match(warehouseCardHTML(target),/v4-upload-target[^>]*>↑/);assert.match(warehouseCardHTML(target),/0 个数据集/);
 assert.equal(cards.find(row=>row.machine==='server-a').datasetCount,1);assert.equal(model.datasets[0].versions[0].warehouse.machine,'server-a');
 assert.equal(warehouseStorageCards(null,model,new Map(),model,{available:false,targetMachine:'new-warehouse'}).length,1);
 assert.equal(warehouseStorageCards(null,model,new Map(),model,{available:true}).length,1);
 const existing=warehouseStorageCards(null,model,new Map(),model,{available:true,targetMachine:'server-a'});assert.equal(existing.length,1);assert.equal(existing[0].uploadTarget,true);
});
test('v4 training segments use real independent quantities and clamp the disk bar without altering reported bytes',()=>{
 const raw=snapshot();Object.assign(raw.caches[0],{projectBytes:100,projectUsageComplete:false,projectCollectedAt:at});
 const cache=adaptStorageOverview(raw).caches[0],parts=trainingCapacitySegments(cache),html=trainingCardHTML(cache);
 assert.equal(cache.projectBytes,100);assert.equal(cache.projectUsageComplete,false);assert.equal(cache.projectCollectedAt,at);
 assert.deepEqual(parts.widths,{project:10,data:20,other:40,free:30});assert.equal(parts.other,400);assert.equal(parts.budgetPercent,40);
 assert.match(html,/v4-project-value[^>]*title="部分统计 · 采集于/);assert.match(html,/100 B\+/);assert.match(html,/缓存预算 400 B/);assert.match(trainingLegendHTML([cache]),/容器/);
 for(const data of [0,200,900,Number.MAX_SAFE_INTEGER])for(const project of [null,0,100,900,Number.MAX_SAFE_INTEGER]){
  const p=trainingCapacitySegments({...cache,readyContentBytes:data,projectBytes:project});
  assert(Object.values(p.widths).every(value=>value>=0&&value<=100));assert(Object.values(p.widths).reduce((n,v)=>n+v,0)<=100+1e-9);assert.equal(p.data,data);assert.equal(p.project,project);
 }
});
test('v4 omits unknown container quantities and preserves independent collection timestamps and null disk readings',()=>{
 for(const value of [null,undefined,-1,'100',NaN]){
  const raw=snapshot();raw.caches[0].projectBytes=value;raw.caches[0].volume.collectedAt=at;
  const cache=adaptStorageOverview(raw).caches[0],parts=trainingCapacitySegments(cache);
  assert.equal(cache.projectBytes,null);assert.equal(parts.other,500);assert.doesNotMatch(trainingCardHTML(cache)+trainingLegendHTML([cache]),/容器|v4-project-value/);
  assert.match(trainingCardHTML(cache),/采集于/);
  for(const field of ['totalBytes','usedBytes','availableBytes'])cache.volume[field]=null;
  assert.equal(trainingCapacitySegments(cache).known,false);assert.equal(trainingCapacitySegments(cache).widths,null);assert.match(trainingCardHTML(cache),/未知/);
 }
 const raw=snapshot();raw.caches[0].projectBytes=0;assert.match(trainingCardHTML(adaptStorageOverview(raw).caches[0]),/v4-project-value/,'real zero remains a known container quantity');
});
test('v4 incomplete overview usage cannot show zero while its readable catalog proves READY cache bytes',()=>{
 const raw=snapshot();raw.caches[0].readyContentBytes=0;raw.caches[0].usageComplete=false;
 const model=legacyModel(),facts=displayStorageCapacity(adaptStorageOverview(raw),model);
 assert.equal(facts.caches[0].readyContentBytes,200);assert.equal(facts.caches[0].usageComplete,false);assert.match(trainingCardHTML(facts.caches[0]),/200 B\+/);
 model.datasets[0].versions[0].servers[0].state='NOT_LOCAL';
 assert.equal(displayStorageCapacity(adaptStorageOverview(raw),model).caches[0].readyContentBytes,0,'a released or absent catalog location cannot restore bytes');
});
test('an overview with only existing cache locations preserves independently confirmed catalog absence without inventing preparation permission',()=>{
 const raw=snapshot();raw.caches.push({...structuredClone(raw.caches[0]),machine:'server-b'});
 const legacy={machine:null,machines:[{machine:'server-a',state:'ok'},{machine:'server-b',state:'ok'}],datasets:[{dataset:'samples',versions:[{version,canUse:true,locations:[{machine:'server-a',dataset:'physical-samples',state:'READY',canUse:true}]}]}]};
 const overview=adaptStorageOverview(raw),model=overviewDatasetCatalog(overview,'server-b',legacy),v=model.datasets[0].versions[0];
 assert.equal(v.selected.state,'NOT_LOCAL');assert.equal(v.selected.canPrepare,false);assert.equal(v.servers.find(row=>row.machine==='server-a').state,'READY');
 assert.equal(overviewDatasetCatalog(overview,'server-b').datasets[0].versions[0].selected.state,'UNKNOWN','capacity alone does not prove absence');
 legacy.machines[1].state='unavailable';assert.equal(overviewDatasetCatalog(overview,'server-b',legacy).datasets[0].versions[0].selected.state,'UNKNOWN');
 legacy.machines[1].state='ok';legacy.datasets[0].versions[0].locations.push({machine:'server-b',state:'READY',canUse:true});
 assert.equal(overviewDatasetCatalog(overview,'server-b',legacy).datasets[0].versions[0].selected.state,'UNKNOWN','contradictory old READY cannot be treated as current absence');
 raw.datasets[0].versions[0].caches.push({machine:'server-b',state:'UNKNOWN'});
 assert.equal(overviewDatasetCatalog(adaptStorageOverview(raw),'server-b',legacy).datasets[0].versions[0].selected.state,'UNKNOWN','explicit overview UNKNOWN always wins');
 legacy.datasets[0].versions[0].locations.pop();raw.datasets[0].versions[0].caches.pop();raw.caches[1].state='UNKNOWN';raw.caches[1].usageComplete=false;
 const independent=overviewDatasetCatalog(adaptStorageOverview(raw),'server-b',legacy).datasets[0].versions[0];
 assert.equal(independent.selected.state,'NOT_LOCAL');assert.equal(independent.servers.find(row=>row.machine==='server-b').directoryState,'ok','a failed volume reading cannot erase a complete catalog read');
 assert.equal(independent.selected.canPrepare,false,'directory evidence grants no preparation capability');
});
test('overview retains only explicit same-target preparation receipts with a current readable source',()=>{
 const raw=snapshot();raw.caches.push({...structuredClone(raw.caches[0]),machine:'server-b'});
 const legacy={machine:'server-b',machines:[{machine:'server-a',state:'ok'},{machine:'server-b',state:'ok'}],datasets:[{dataset:'samples',versions:[{
  version,canUse:true,canPrepare:true,state:'NOT_LOCAL',sourceMachine:'server-a',sourceDataset:'physical-samples',
  locations:[{machine:'server-a',dataset:'physical-samples',state:'READY',canUse:true}]}]}]};
 const selected=(data=raw,catalog=legacy)=>overviewDatasetCatalog(adaptStorageOverview(data),'server-b',catalog).datasets[0].versions[0].selected;
 assert.equal(selected().state,'NOT_LOCAL');assert.equal(selected().canPrepare,true);assert.equal(selected().sourceMachine,'server-a');assert.equal(selected().sourceDataset,'physical-samples');
 for(const change of [c=>c.machine=null,c=>c.machine='server-a',c=>c.datasets[0].versions[0].version='b'.repeat(64),
  c=>c.datasets[0].versions[0].canPrepare=false,c=>c.datasets[0].versions[0].canUse=false,
  c=>c.datasets[0].versions[0].sourceDataset='wrong-reference',c=>c.machines[0].state='unavailable']){
  const copy=structuredClone(legacy);change(copy);assert.equal(selected(raw,copy).canPrepare,false);assert.equal(selected(raw,copy).sourceMachine,null);
 }
 for(const change of [r=>r.datasets[0].versions[0].canUse=false,r=>r.datasets[0].versions[0].caches[0].canUse=false,
  r=>r.datasets[0].versions[0].caches[0].state='UNKNOWN',r=>r.datasets[0].versions[0].caches.push({machine:'server-b',state:'UNKNOWN',canUse:true})]){
  const copy=structuredClone(raw);change(copy);assert.equal(selected(copy).canPrepare,false);assert.equal(selected(copy).sourceMachine,null);
 }
});
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
test('v4 warehouse counts use the same visible locations as filtering, with volume counts preferred when supplied',()=>{
 const raw=snapshot();raw.warehouse.volumes[0].machine='server-b';raw.datasets[0].versions[0].originals[0].machine='server-b';
 const overview=adaptStorageOverview(raw),model=overviewDatasetCatalog(overview,null),legacy=legacyModel();
 // A cache-only legacy observation has no warehouse metadata. It may supply
 // known bytes, but must not erase the overview's warehouse membership/count.
 assert.deepEqual(datasetWarehouseMachines(model.datasets[0].versions[0]),['server-b']);
 let [card]=warehouseStorageCards(overview,model,new Map(),legacy);
 assert.equal(card.datasetCount,model.datasets.filter(item=>item.versions.some(v=>datasetWarehouseMachines(v).includes(card.machine))).length);
 assert.equal(card.datasetCount,1);
 raw.warehouse.volumes[0].datasetCount=7;
 [card]=warehouseStorageCards(adaptStorageOverview(raw),model);assert.equal(card.datasetCount,7);
 for(const value of [null,-1,'7']){raw.warehouse.volumes[0].datasetCount=value;assert.equal(warehouseStorageCards(adaptStorageOverview(raw),model)[0].datasetCount,1);}
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
