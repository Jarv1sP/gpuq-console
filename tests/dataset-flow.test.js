import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseSummary,hasDatabaseOriginal,cacheFact,cacheProgress,cacheIconHTML,databaseGroundHTML,datasetLifecycle,datasetFlowRoute,datasetFlowDetailHTML,uploadJourneyHTML,cacheBudget,cacheGaugeHTML,cachePreviewHTML} from '../dist/dataset-flow.js';
import {cacheAdminHTML} from '../dist/dataset-cache-admin.js';
import {datasetRows,archiveStatus} from '../dist/datasets-ui.js';
const hash='a'.repeat(64),other='b'.repeat(64);
const storage=(phase='ARCHIVED',extra={})=>({dataset:'samples',version:hash,phase,archiveMachine:'sample-database-node',localMachine:'sample-training-node',originalRetained:phase==='ARCHIVED',...extra});
const version=(value=storage())=>({version:hash,state:'REGISTERED',canPrepare:true,locations:[{machine:'sample-training-node',dataset:'samples',state:'REGISTERED',canPrepare:true,storage:value}]});
test('each immutable version has one identity-bound slot for the row and mobile card more menu, without a placeholder action',()=>{
  const html=datasetRows({machine:'sample-training-node',machines:[{machine:'sample-training-node',state:'ok'}],datasets:[{dataset:'samples',versions:[version()]}]});
  assert.equal((html.match(/data-dataset-more-slot /g)||[]).length,1);
  assert.match(html,/data-dataset-more-slot data-machine="sample-training-node" data-dataset="samples" data-version="a{64}" data-dataset-state="REGISTERED"/);
  assert.doesNotMatch(html,/删除数据集|<button[^>]*>更多/);
});
test('retention binds the selected node physical cache name and hash, never a logical training alias or a remote cache',()=>{
  const v=version();v.locations[0].dataset='physical-cache';
  const html=datasetFlowDetailHTML('logical-training-alias',v,{machine:'sample-training-node'},null);
  assert.match(html,/data-cache-pin-slot data-dataset="physical-cache" data-version="a{64}" data-machine="sample-training-node"/);
  assert.doesNotMatch(datasetFlowDetailHTML('logical-training-alias',v,{machine:'another-node'},null),/data-cache-pin-slot/);
  assert.equal(hasDatabaseOriginal(v),true,'the storage row may carry a logical alias with the same immutable hash');
});
test('database preservation needs exact version, retained original and consistent destinations; mixed records use the conservative state',()=>{
  assert.equal(databaseSummary(version()).saved,true);
  assert.doesNotMatch(archiveStatus(storage('ARCHIVED',{version:other}),hash),/原件已保存/);
  assert.doesNotMatch(archiveStatus(storage('FAILED',{version:other}),hash),/data-retry-archive/);
  for(const value of [storage('ARCHIVED',{originalRetained:false}),storage('ARCHIVED',{version:other}),storage('ARCHIVED',{archiveMachine:null}),storage('FUTURE')]){
    assert.equal(databaseSummary(version(value)).saved,false);assert.doesNotMatch(databaseGroundHTML(version(value)),/原件已保存/);
  }
  for(const [phase,label] of [['QUEUED','等待存入'],['COPYING','存入中'],['PROVISIONING','校验中'],['CERTIFYING','检查恢复能力'],['FAILED','存入仓库失败'],['BLOCKED','待确认']]){
    const v=version(storage(phase));assert.equal(databaseSummary(v).label,label);assert.doesNotMatch(databaseGroundHTML(v),/\d+%|原件已保存/);
  }
  const v=version();v.locations.push({machine:'another-node',dataset:'samples',storage:storage('COPYING')});assert.equal(databaseSummary(v).phase,'COPYING');
  v.locations[1].storage=storage('ARCHIVED',{archiveMachine:'different-database'});assert.equal(databaseSummary(v).kind,'unknown');
  v.locations[1].storage=storage('FAILED');assert.equal(databaseSummary(v).kind,'failed');
});
test('an empty cache is recoverable only with same-version database proof and explicit preparation permission; unknown and staging never become released',()=>{
  const v=version(),catalog={machine:'sample-training-node'};
  assert.equal(cacheFact(v,catalog.machine,catalog,'REGISTERED').kind,'recoverable');
  assert.equal(cacheFact({...v,canPrepare:false},catalog.machine,catalog,'NOT_LOCAL').kind,'none');
  assert.equal(cacheFact(version(storage('ARCHIVED',{version:other})),catalog.machine,catalog,'REGISTERED').kind,'none');
  for(const state of ['UNKNOWN','STAGING','FAILED','PREPARING','READY'])assert.notEqual(cacheFact(v,catalog.machine,catalog,state).kind,'recoverable');
  assert.equal(cacheFact(v,'another-node',catalog,'NOT_LOCAL').kind,'none','selected-machine permission cannot grant another cell');
  assert.equal(hasDatabaseOriginal(version(null)),false);assert.equal(databaseSummary(version(null)).kind,'none');
  assert.match(databaseGroundHTML(version(null)),/仅服务器缓存 · 未存入仓库/);
  assert.doesNotMatch(databaseGroundHTML(v)+uploadJourneyHTML(null,catalog.machine),/已释放|SSD|HDD|NVMe|归档|GC/);
});
test('progress has an explicit byte contract and current catalog renders no percentage or invented lifecycle time',()=>{
  assert.equal(cacheProgress({totalBytes:100,remainingBytes:38}),62);
  assert.doesNotMatch(cacheIconHTML({kind:'fetch',progress:null}),/<rect|\d+%/);
  assert.match(cacheIconHTML({kind:'fetch',progress:{totalBytes:100,remainingBytes:50}}),/<rect x="0" y="7" width="14" height="7"/);
  assert.doesNotMatch(cacheIconHTML({kind:'ready',progress:{totalBytes:100,remainingBytes:50}}),/<rect/);
  for(const progress of [null,{}, {totalBytes:0,remainingBytes:0},{totalBytes:100,remainingBytes:101},{totalBytes:100,remainingBytes:-1},{totalBytes:'100',remainingBytes:10},{totalBytes:100,remainingBytes:.5},{totalBytes:1e100,remainingBytes:0}])assert.equal(cacheProgress(progress),null);
  const v=version();v.state='PREPARING';v.locations[0].state='PREPARING';
  assert.equal(cacheFact(v,'sample-training-node',{machine:'sample-training-node'},'PREPARING').progress,null);
  const stages=datasetLifecycle(v,{machine:'sample-training-node'});assert.ok(stages.some(row=>row.label.startsWith('取回到')&&row.state==='current'));assert.ok(stages.every(row=>!Object.hasOwn(row,'time')));assert.ok(!stages.some(row=>row.label==='上传'||row.label==='可用于训练'));
  const local=version(null);local.locations[0].state='READY';assert.deepEqual(datasetLifecycle(local,{machine:'sample-training-node'}).map(row=>row.label),['缓存就绪','可用于训练']);
  assert.deepEqual(datasetLifecycle(local,{machine:'sample-training-node'},{trainingAllowed:false}).map(row=>row.label),['缓存就绪'],'metadata visibility preserves READY but is not training permission');
});
test('preparing detail route needs the returned source, its READY location and confirmed target, without guessing a database route',()=>{
  const catalog={machine:'sample-training-node',machines:[{machine:'sample-training-node',state:'ok'}]},v={...version(),state:'PREPARING',sourceMachine:'sample-source-node',bytes:7*1024**3};
  v.locations.push({machine:'sample-source-node',dataset:'physical-source',state:'READY'});
  assert.deepEqual(datasetFlowRoute(v,catalog),{source:'sample-source-node',target:catalog.machine,bytes:7*1024**3});
  for(const changed of [{...v,sourceMachine:null},{...v,sourceMachine:catalog.machine},{...v,canPrepare:false},{...v,state:'UNKNOWN'},{...v,locations:[]}])assert.equal(datasetFlowRoute(changed,catalog),null);
  assert.equal(datasetFlowRoute(v,{...catalog,machines:[{machine:catalog.machine,state:'unavailable'}]}),null);
  assert.equal(datasetFlowRoute({...v,bytes:null},catalog).bytes,null);
});
test('upload journey has exactly three stages and cannot invent database capability or mark unknown results ready',()=>{
  for(const kind of [null,'campus-direct','tail-upload','vps-relay']){
    const html=uploadJourneyHTML(kind?{kind}:null,'sample-node-with-long-name','UPLOADING');
    assert.equal((html.match(/<li /g)||[]).length,3);assert.match(html,/你的电脑/);assert.doesNotMatch(html,/数据库|已释放/);assert.equal((html.match(/data-stage-state="complete"/g)||[]).length,1);
  }
  assert.equal((uploadJourneyHTML({kind:'campus-direct'},'sample-node','READY').match(/data-stage-state="complete"/g)||[]).length,3);
  assert.equal((uploadJourneyHTML(null,'sample-node','UNKNOWN').match(/data-stage-state="complete"/g)||[]).length,0);
  assert.match(uploadJourneyHTML({kind:'tail-upload'},'sample-node','UPLOADING'),/Tail 备用/);
  assert.doesNotMatch(uploadJourneyHTML({kind:'tail-upload'},'sample-node','UPLOADING'),/通道未确认|>直传</);
});
test('cache budget uses plan bytes and its returned watermarks, rejects missing/inconsistent facts and disables telemetry when collection is off',()=>{
  const status={enabled:true,capacity:{usedBytes:99999999}},plan={enabled:true,usageBytes:900,budgetBytes:1000,lowWater:.61,highWater:.83,candidates:[],protectedUnknown:[{}],unavailableAuthorities:['missing']};
  const budget=cacheBudget(status,plan);assert.equal(budget.kind,'high');assert.equal(budget.ratio,.9);
  const html=cacheGaugeHTML('sample-node',status,plan);assert.match(html,/90%/);assert.match(html,/x1="61"/);assert.match(html,/x1="83"/);assert.match(html,/2 项状态待确认，不会被释放/);assert.doesNotMatch(html,/99999999|删除按钮/);
  for(const value of [{...plan,usageBytes:null},{...plan,budgetBytes:0},{...plan,highWater:2},{...plan,lowWater:.9},{...plan,usageBytes:1e100},{...plan,usageBytes:.5}])assert.equal(cacheBudget(status,value).kind,'unknown');
  assert.equal(cacheBudget({enabled:false},plan).kind,'unknown');
  const disabled=cacheGaugeHTML('sample-node',{enabled:false},{...plan,enabled:false});assert.match(disabled,/自动释放未开启/);assert.doesNotMatch(disabled,/class="cache-mark-|90%/);
  assert.match(cachePreviewHTML('sample-node',plan),/当前不需要释放/);assert.doesNotMatch(cachePreviewHTML('sample-node',plan),/没有可释放的缓存/);
  assert.equal(cacheAdminHTML(false),'');
});
