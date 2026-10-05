import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseSummary,hasDatabaseOriginal,cacheFact,cacheProgress,cacheIconHTML,databaseGroundHTML,datasetLifecycle,datasetFlowDetailHTML,uploadJourneyHTML,cacheBudget,cacheGaugeHTML,cachePreviewHTML} from '../dist/dataset-flow.js';
import {cacheRetentionSession,cacheAdminHTML} from '../dist/dataset-cache-admin.js';
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
  for(const [phase,label] of [['QUEUED','等待存入'],['COPYING','存入中'],['PROVISIONING','校验中'],['CERTIFYING','检查恢复能力'],['FAILED','存入数据库失败'],['BLOCKED','待确认']]){
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
  assert.match(databaseGroundHTML(version(null)),/仅本机缓存 · 未存入数据库/);
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
});
test('upload journey has exactly three stages and cannot invent database capability or mark unknown results ready',()=>{
  for(const kind of [null,'campus-direct','vps-relay']){
    const html=uploadJourneyHTML(kind?{kind}:null,'sample-node-with-long-name','UPLOADING');
    assert.equal((html.match(/<li /g)||[]).length,3);assert.match(html,/你的电脑/);assert.doesNotMatch(html,/数据库|已释放/);assert.equal((html.match(/data-stage-state="complete"/g)||[]).length,1);
  }
  assert.equal((uploadJourneyHTML({kind:'campus-direct'},'sample-node','READY').match(/data-stage-state="complete"/g)||[]).length,3);
  assert.equal((uploadJourneyHTML(null,'sample-node','UNKNOWN').match(/data-stage-state="complete"/g)||[]).length,0);
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
function fixture(){
  const target={machine:'sample-node',dataset:'samples',version:hash},pins=new Set(['someone-else']),calls=[];
  let authorized=true,mode='normal',gate;
  const model=cacheRetentionSession({allowed:()=>authorized,uuid:()=> '11111111-1111-4111-8111-111111111111',call:async(operation,args)=>{
    calls.push({operation,args:structuredClone(args)});
    if(gate)await (gate.operation===operation?gate.promise:gate.operation?undefined:gate);
    if(operation==='datasets.storage.status'){if(mode==='status-failed')throw Error('Status failed');return {version:{...target,state:'READY',pinCount:pins.size}};}
    if(operation==='datasets.storage.pin'){pins.add(args.pinId);if(mode==='lost'){mode='normal';throw Error('Reply lost');}return {pinned:true,pinId:mode==='wrong-id'?'foreign-id':args.pinId};}
    if(operation==='datasets.storage.unpin'){const unpinned=pins.delete(args.pinId);if(mode==='lost-unpin'){mode='normal';throw Error('Unpin reply lost');}return {unpinned};}
    throw Error(operation);
  }});
  return {model,target,pins,calls,set authorized(value){authorized=value},set mode(value){mode=value},set gate(value){gate=value}};
}
test('manual retention needs a matching pin receipt plus a separate exact-version status; count alone never exposes a generic unpin',async()=>{
  const f=fixture();await f.model.query(f.target);assert.equal(f.model.state(f.target).record,null);
  await assert.rejects(f.model.unpin(f.target),/本会话/);assert.equal(f.calls.filter(row=>row.operation.endsWith('.unpin')).length,0);
  await f.model.pin(f.target);assert.equal(f.model.state(f.target).record.phase,'retained');
  assert.deepEqual(f.calls.slice(-3).map(row=>row.operation),['datasets.storage.status','datasets.storage.pin','datasets.storage.status']);
  assert.match(f.calls.at(-2).args.pinId,/^manual-/);
  await f.model.unpin(f.target);assert.equal(f.model.state(f.target).record.phase,'released');assert.deepEqual([...f.pins],['someone-else']);
});
test('lost pin reply stays uncertain after a read; explicit retry reuses the identical pin request and cannot touch another pin',async()=>{
  const f=fixture();f.mode='lost';await assert.rejects(f.model.pin(f.target),/Reply lost/);
  assert.equal(f.calls.at(-1).operation,'datasets.storage.status','lost reply triggers a read, never a write replay');
  await f.model.query(f.target);assert.equal(f.model.state(f.target).record.phase,'uncertain');
  await f.model.retry(f.target);assert.equal(f.model.state(f.target).record.phase,'retained');
  const requests=f.calls.filter(row=>row.operation==='datasets.storage.pin');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(f.pins.size,2);
  const g=fixture();g.mode='wrong-id';await g.model.pin(g.target);assert.equal(g.model.state(g.target).record.phase,'uncertain');
});
test('a lost release reply is read first and remains uncertain; a same-ID idempotent retry can confirm release',async()=>{
  const f=fixture();await f.model.pin(f.target);const ownId=f.model.state(f.target).record.pinId;
  f.mode='lost-unpin';await assert.rejects(f.model.unpin(f.target),/Unpin reply lost/);
  assert.equal(f.calls.at(-1).operation,'datasets.storage.status');assert.equal(f.model.state(f.target).record.phase,'uncertain');
  await f.model.retry(f.target);assert.equal(f.model.state(f.target).record.phase,'released');
  const releases=f.calls.filter(row=>row.operation==='datasets.storage.unpin');assert.equal(releases.length,2);assert.deepEqual(releases[0],releases[1]);assert.equal(releases[0].args.pinId,ownId);assert.deepEqual([...f.pins],['someone-else']);
});
test('zero authorization and auth reset fence reads, writes and delayed pin receipts without retaining IDs across sessions',async()=>{
  const f=fixture();f.authorized=false;await assert.rejects(f.model.pin(f.target),/授权已改变/);assert.deepEqual(f.calls,[]);
  f.authorized=true;await f.model.pin(f.target);f.model.reset();assert.equal(f.model.state(f.target).record,null);await assert.rejects(f.model.unpin(f.target),/本会话/);
  const g=fixture();let release;g.gate=new Promise(resolve=>release=resolve);const pending=g.model.pin(g.target);g.model.reset();release();await assert.rejects(pending,/授权已改变/);assert.equal(g.model.state(g.target).record,null);assert.equal(g.calls.filter(row=>row.operation==='datasets.storage.pin').length,0);
});
test('an already dispatched pin reply cannot restore a previous account session or issue a post-auth query',async()=>{
  const f=fixture();let release;f.gate={operation:'datasets.storage.pin',promise:new Promise(resolve=>release=resolve)};
  const pending=f.model.pin(f.target);while(!f.calls.some(row=>row.operation==='datasets.storage.pin'))await new Promise(resolve=>setTimeout(resolve,0));
  f.model.reset();f.authorized=false;release();await assert.rejects(pending,/授权已改变/);
  assert.equal(f.model.state(f.target).record,null);assert.equal(f.calls.filter(row=>row.operation==='datasets.storage.status').length,1);
  assert.equal(f.calls.filter(row=>row.operation==='datasets.storage.pin').length,1);
});
test('a failed pre-write status query does not invent a pending retention write or retry a previously confirmed pin',async()=>{
  const f=fixture();await f.model.pin(f.target);const writes=f.calls.filter(row=>row.operation==='datasets.storage.pin').length;
  f.mode='status-failed';await assert.rejects(f.model.unpin(f.target),/Status failed/);
  assert.equal(f.model.state(f.target).record.intent,'pin');assert.equal(f.model.state(f.target).record.phase,'retained');
  assert.equal(f.calls.filter(row=>row.operation==='datasets.storage.unpin').length,0);
  await assert.rejects(f.model.retry(f.target),/没有待确认/);assert.equal(f.calls.filter(row=>row.operation==='datasets.storage.pin').length,writes);
});
