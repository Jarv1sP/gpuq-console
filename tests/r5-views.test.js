import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTrainingCommand,trainingReadout,elapsedTraining,missionGPUs,missionHTML,quotaLedgerHTML,workbenchCards} from '../dist/workbench-ui.js';
import {datasetCopyRoute,datasetRows} from '../dist/datasets-ui.js';
const machines=[{id:'gpu-1',cards:8},{id:'private-long-id',cards:6}];
test('Chinese training commands resolve only explicit authorized machines, counts and full data references',()=>{
  const version='a'.repeat(64);
  assert.deepEqual(parseTrainingCommand('gpu-1 两张卡 跑 python train.py --name "用" 用 scans@'+version,machines),{machine:'gpu-1',cards:2,command:'python train.py --name "用"',dataset:'scans',version});
  assert.equal(parseTrainingCommand('private-long-id 六张显卡 运行 python train.py 用 data',machines).cards,6);
  for(const phrase of ['gpu-2 两张卡 跑 train 用 data','gpu-1 9张卡 跑 train 用 data','gpu-1 零张卡 跑 train 用 data','gpu-1 十十张卡 跑 train 用 data','gpu-1 两两张卡 跑 train 用 data','gpu-1 2张卡 跑 train 用 data@latest','gpu-1 2张卡 跑 train\nshutdown 用 data'])assert.equal(parseTrainingCommand(phrase,machines),null,phrase);
  assert.equal(parseTrainingCommand('gpu-1 1张卡 跑 train 用 data',[]),null);
});
test('100 percent is training evidence, never a completed state or released reservation',()=>{
  const job={id:'own',userId:'owner',state:'RUNNING',machine:'gpu-1',cards:2,progress:{reported:true,stale:false,snapshot:{epochsCompleted:40,epochsTotal:40,etaSeconds:0,updatedAt:1700000000,metrics:{loss:0}}}};
  const readout=trainingReadout(job);assert.equal(readout.percent,100);assert.equal(readout.completionPending,true);
  assert.match(missionHTML(job),/完成待确认/);assert.match(workbenchCards([job]),/运行中/);
  job.state='SUCCEEDED';assert.equal(trainingReadout(job).completionPending,false);
  job.progress.stale=true;assert.equal(trainingReadout(job).percent,null);assert.equal(trainingReadout(job).eta,'');assert.deepEqual(trainingReadout(job).metrics,[]);
});
test('elapsed time uses only the real current attempt start and stops at confirmed end',()=>{
  assert.equal(elapsedTraining({state:'RUNNING',createdAt:10},1000),null);
  assert.equal(elapsedTraining({state:'PENDING',latestAttempt:{startedAt:10}},1000),null);
  assert.equal(elapsedTraining({state:'RUNNING',latestAttempt:{startedAt:10}},3772),'1:02:42');
  assert.equal(elapsedTraining({state:'SUCCEEDED',latestAttempt:{startedAt:10,finishedAt:72}},500),'01:02');
  assert.equal(elapsedTraining({state:'SUCCEEDED',latestAttempt:{startedAt:10}},500),null);
});
test('hardware portrait displays only allocated cards with actual per-card denominators; duplicate and stale samples are unknown',()=>{
  const job={machine:'gpu-1',assignedIndices:[0,1,1,9]},host={id:'gpu-1',reachable:true,gpus:[{index:0,memoryTotalMiB:8192,memoryUsedMiB:2048,utilization:97},{index:1,memoryTotalMiB:32768,memoryUsedMiB:0,utilization:0}]},snapshot={stale:false,hosts:[host]};
  const cards=missionGPUs(job,snapshot,machines);assert.deepEqual(cards.map(row=>row.index),[0,1]);assert.equal(cards[0].ratio,.25);assert.equal(cards[1].ratio,0);assert.equal(cards[0].total,'8.0');assert.equal(cards[1].total,'32.0');
  host.gpus.push({...host.gpus[0]});assert.equal(missionGPUs(job,snapshot,machines)[0].known,false);
  snapshot.stale=true;assert.ok(missionGPUs(job,snapshot,machines).every(row=>!row.known&&row.ratio===null));
  assert.deepEqual(missionGPUs(job,snapshot,[]),[]);
  assert.match(missionHTML({...job,state:'RUNNING',name:'<unsafe>'},{snapshot,machines}),/fill="url\(#mission-unknown\)"/);assert.doesNotMatch(missionHTML({...job,state:'RUNNING',name:'<unsafe>'},{snapshot,machines}),/<unsafe>/);
});
test('quota ledger excludes foreign, preparing and ended jobs while unknown and elastic maximum stay occupied',()=>{
  const store={principal:{userId:'owner'},users:[{id:'owner',total:8,limits:{'gpu-1':8}}],usage:()=>7,jobs:[{id:'a',userId:'owner',machine:'gpu-1',name:'unknown',state:'UNKNOWN',cards:4,actualCards:1,elastic:{minCards:1}},{id:'b',userId:'owner',machine:'gpu-1',name:'queued',state:'PENDING',cards:3},{id:'c',userId:'owner',name:'PREP-EXCLUDED',state:'PREPARING_DATA',cards:8},{id:'d',userId:'other',name:'FOREIGN-EXCLUDED',state:'UNKNOWN',cards:8},{id:'e',userId:'owner',name:'ENDED-EXCLUDED',state:'SUCCEEDED',cards:8}]};
  const html=quotaLedgerHTML(store,'gpu-1');assert.match(html,/7 \/ 8/);assert.match(html,/4 <small>张/);assert.match(html,/3 <small>张/);assert.doesNotMatch(html,/PREP-EXCLUDED|FOREIGN-EXCLUDED|ENDED-EXCLUDED/);
});
test('copy route needs an approved real source and confirmed target catalog, without inventing a channel or size',()=>{
  const version={version:'a'.repeat(64),state:'NOT_LOCAL',canPrepare:true,sourceMachine:'gpu-2',locations:[{machine:'gpu-2',state:'READY'}]},catalog={machine:'gpu-1',machines:[{machine:'gpu-1',state:'ok'},{machine:'gpu-2',state:'ok'}],datasets:[{dataset:'scans',versions:[version]}]};
  assert.deepEqual(datasetCopyRoute(version,catalog),{source:'gpu-2',target:'gpu-1',bytes:null});
  const html=datasetRows(catalog);assert.match(html,/data-route-source="gpu-2" data-route-target="gpu-1"/);assert.doesNotMatch(html,/实验室内网|61\.0|0\.0 MiB/);
  for(const change of [{canPrepare:false},{sourceMachine:'unauthorized'},{state:'UNKNOWN'},{sourceMachine:'gpu-1'},{locations:[]}])assert.equal(datasetCopyRoute({...version,...change},catalog),null);
  assert.equal(datasetCopyRoute(version,{...catalog,machines:[{machine:'gpu-1',state:'unavailable'},{machine:'gpu-2',state:'ok'}]}),null);
  assert.match(html,/role="columnheader">gpu-1<small>所选服务器/);assert.match(html,/dataset-actions-cell dataset-target/);
});
