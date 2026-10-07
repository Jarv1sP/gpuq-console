import test from 'node:test';
import assert from 'node:assert/strict';
import {ATTENTION_WINDOW,failureTime,recentFailure,failureReadKey,attentionCount,attentionStorageKey,createAttentionReads,mergeAttentionActivities} from '../dist/attention-state.js';
import {controlSnapshot} from '../dist/control-ui.js';
import {workbenchCards} from '../dist/workbench-ui.js';

const now=Date.parse('2026-10-05T20:00:00Z');
const job=(id,state='FAILED',extra={})=>({id,userId:'owner',name:id,state,...extra});
const store=(jobs,role='member')=>({principal:{userId:'owner',role},jobs,users:[{id:'owner',role,total:1},{id:'pending',name:'新成员',role:'member',enabled:true,total:0}],data:{machines:[]}});
const memory=()=>{const rows=new Map();return {getItem:key=>rows.get(key)||null,setItem:(key,value)=>rows.set(key,value)};};

test('failure time prefers the completed attempt and accepts existing seconds, milliseconds and ISO dates',()=>{
  assert.equal(failureTime({latestAttempt:{finishedAt:(now-2*ATTENTION_WINDOW)/1000},finishedAt:now,updatedAt:now}),now-2*ATTENTION_WINDOW);
  assert.equal(failureTime({finishedAt:new Date(now-1000).toISOString(),updatedAt:now}),now-1000);
  assert.equal(failureTime({latestAttempt:{finishedAt:null},finishedAt:'invalid',updatedAt:now}),now);
  for(const value of [undefined,null,'',0,-1,Infinity,'invalid'])assert.equal(failureTime({updatedAt:value}),null);
});

test('24 hour boundary is inclusive; missing or future failure evidence is not a new alert',()=>{
  assert.equal(recentFailure({finishedAt:now-ATTENTION_WINDOW},now),true);
  for(const finishedAt of [now-ATTENTION_WINDOW-1,now+1,null])assert.equal(recentFailure({finishedAt},now),false);
  assert.equal(recentFailure({createdAt:now,checkedAt:now},now),false);
});

test('211 historical failures stay in task history without inflating control attention',()=>{
  const failures=Array.from({length:211},(_,index)=>job('old-'+index,'FAILED',{latestAttempt:{finishedAt:(now-ATTENTION_WINDOW-1000)/1000},updatedAt:now}));
  const jobs=[...failures,job('unconfirmed','UNKNOWN'),job('recent','FAILED',{finishedAt:now-1000}),job('no-time')],before=structuredClone(jobs);
  const snapshot=controlSnapshot(store(jobs),{now});
  assert.deepEqual(snapshot.attention.map(row=>row.jobId),['unconfirmed','recent']);
  assert.equal(snapshot.failedJobs.length,213);assert.equal(snapshot.jobs.length,jobs.length);
  const html=workbenchCards(jobs,{historyState:'FAILED'});assert.match(html,/已结束的训练 · 213 项/);
  for(const failure of failures)assert.ok(html.includes('data-workbench-job="'+failure.id+'"'));
  assert.deepEqual(jobs,before);
});

test('recent failures can be acknowledged; UNKNOWN remains actionable and approvals stay in the backend catalog',()=>{
  const failed=job('recent','FAILED',{finishedAt:now-1000}),unknown=job('unknown','UNKNOWN',{finishedAt:now-1000});
  const reads=createAttentionReads({storage:()=>memoryStore,now:()=>now}),memoryStore=memory();
  assert.equal(reads.acknowledge('owner',[failureReadKey('job',failed),failureReadKey('job',unknown)]),true);
  const source=store([failed,unknown],'admin'),users=structuredClone(source.users);
  const snapshot=controlSnapshot(source,{now,seen:reads.read('owner')});
  assert.deepEqual(snapshot.attention.map(row=>row.id),['job:unknown']);
  assert.deepEqual(source.users,users,'moving approvals does not remove or acknowledge account records');
  assert.equal(source.users.filter(row=>row.id==='pending'&&row.enabled&&row.total===0).length,1);
  assert.equal(snapshot.attention.some(row=>row.id.startsWith('user:')),false,'no account administration in the primary control');
  assert.ok(snapshot.attention.every(row=>!row.readKey));assert.equal(snapshot.failedJobs.length,1);
  assert.deepEqual(snapshot.approvals.map(row=>row.id),['pending'],'approval cannot be acknowledged or removed by failure reads');
});

test('read markers persist across reloads, are account-scoped and do not silence a later failure',()=>{
  const storage=memory(),failed=job('same-id','FAILED',{finishedAt:now-2000});
  const key=failureReadKey('job',failed),reads=createAttentionReads({storage:()=>storage,now:()=>now});
  reads.acknowledge('owner',[key]);
  const reloaded=createAttentionReads({storage:()=>storage,now:()=>now});
  assert.equal(reloaded.read('owner').has(key),true);assert.equal(reloaded.read('other').has(key),false);
  assert.notEqual(attentionStorageKey('owner'),attentionStorageKey('other'));
  assert.ok(attentionStorageKey('owner').includes('owner'));
  assert.equal(reloaded.read('owner').has(failureReadKey('job',{...failed,finishedAt:now-1000})),false);
  assert.equal(reloaded.read('owner').has(failureReadKey('data',failed)),false);
});

test('expired read markers are pruned, and invalid markers cannot change task state',()=>{
  const storage=memory(),old=failureReadKey('job',job('old','FAILED',{finishedAt:now-ATTENTION_WINDOW-1})),current=failureReadKey('job',job('new','FAILED',{finishedAt:now}));
  storage.setItem(attentionStorageKey('owner'),JSON.stringify([old,current,'garbage',null,'["user","approval",'+now+']']));
  const reads=createAttentionReads({storage:()=>storage,now:()=>now});assert.deepEqual([...reads.read('owner')],[current]);
  reads.acknowledge('owner',[]);assert.deepEqual(JSON.parse(storage.getItem(attentionStorageKey('owner'))),[current]);
});

for(const phase of ['access','read','write'])test('storage '+phase+' errors fall back to time-only attention without memory-only dismissal',()=>{
  const failed=job('new','FAILED',{finishedAt:now-1000}),storage=memory(),key=failureReadKey('job',failed);
  storage.setItem(attentionStorageKey('owner'),JSON.stringify([key]));
  const reads=createAttentionReads({now:()=>now,storage:()=>{
    if(phase==='access')throw Error('blocked');
    return {...storage,...(phase==='read'?{getItem:()=>{throw Error('blocked');}}:{setItem:()=>{throw Error('full');}})};
  }});
  if(phase==='write')assert.equal(reads.read('owner').has(key),true);
  assert.equal(reads.acknowledge('owner',[key]),false);assert.equal(reads.read('owner'),null);
  assert.equal(controlSnapshot(store([failed,job('old','FAILED',{finishedAt:now-ATTENTION_WINDOW-1})]),{now,seen:reads.read('owner')}).attention.length,1);
});

test('failed data activities use the same time/read rule, deduplicate IDs and retain account and aggregate fences',()=>{
  const activities=[{id:'recent',userId:'owner',state:'FAILED',updatedAt:now-1000},{id:'recent',userId:'owner',state:'FAILED',updatedAt:now-1000},{id:'old',userId:'owner',state:'FAILED',updatedAt:now-ATTENTION_WINDOW-1},{id:'missing',userId:'owner',state:'FAILED'},{id:'foreign',userId:'other',state:'FAILED',updatedAt:now},{id:'active',userId:'owner',state:'RUNNING'}];
  const fixture=store([]),snapshot=controlSnapshot(fixture,{now,activities,activitiesComplete:true});
  assert.deepEqual(snapshot.attention.map(row=>row.id),['data:recent']);assert.equal(snapshot.dataCount,1);assert.equal(snapshot.activities.length,4);
  assert.equal(controlSnapshot(fixture,{now,activities,activitiesComplete:false}).dataCount,null);
  assert.equal(controlSnapshot(fixture,{now,activities,seen:new Set([failureReadKey('data',activities[0])])}).attention.length,0);
});

test('attention count renders 99+ only above 99, while exact snapshot counts are preserved',()=>{
  for(const [value,expected] of [[0,'0'],[1,'1'],[99,'99'],[100,'99+'],[211,'99+']])assert.equal(attentionCount(value),expected);
  assert.equal(controlSnapshot(store(Array.from({length:211},(_,index)=>job('unknown-'+index,'UNKNOWN'))),{now}).attention.length,211);
});

test('unconfirmed data activity remains actionable regardless of age, missing time or stale read markers',()=>{
  for(const state of ['UNKNOWN','PARTIAL','UNCONFIRMED'])for(const updatedAt of [undefined,now-1000,now-2*ATTENTION_WINDOW]){
    const row={id:'unconfirmed',userId:'owner',state,updatedAt};
    const snapshot=controlSnapshot(store([]),{now,activities:[row],seen:new Set([failureReadKey('data',row)])});
    assert.deepEqual(snapshot.attention.map(item=>item.id),['data:unconfirmed'],state+' must not be dismissed');
    assert.equal(snapshot.attention[0].readKey,null,'only confirmed failures may be acknowledged');
  }
});

test('the failure history filter includes every ended failure even with no active focal task',()=>{
  const jobs=[job('success','SUCCEEDED'),job('failed-old'),job('failed-last')],html=workbenchCards(jobs,{historyState:'FAILED'});
  assert.match(html,/<details class="wb-ended" open>/);assert.match(html,/已结束的训练 · 2 项/);
  assert.doesNotMatch(html,/data-workbench-job="success"/);
  for(const id of ['failed-old','failed-last'])assert.equal(html.split('data-workbench-job="'+id+'"').length-1,1);
  assert.match(html,/value="FAILED" selected/);
});

test('partial activity pages never erase known reminders, duplicates update once, only complete lists prove removal',()=>{
  const first=mergeAttentionActivities([],[{id:'unknown',state:'UNKNOWN'},{id:'recent',state:'FAILED',updatedAt:now-1000}], 'owner',true);
  const partial=mergeAttentionActivities(first,[{id:'active',state:'RUNNING'},{id:'recent',state:'FAILED',updatedAt:now-1000}], 'owner',false);
  assert.equal(partial.length,3);assert.deepEqual(controlSnapshot(store([]),{now,activities:partial}).attention.map(row=>row.id),['data:unknown','data:recent']);
  assert.deepEqual(mergeAttentionActivities(partial,[],'owner',false),partial);
  assert.equal(controlSnapshot(store([]),{now,activities:partial,activitiesComplete:false}).dataCount,null);
  const completed=mergeAttentionActivities(partial,[{id:'unknown',state:'SUCCEEDED'}],'owner',true);
  assert.equal(completed.length,1);assert.equal(controlSnapshot(store([]),{now,activities:completed,activitiesComplete:true}).attention.length,0);
});
test('activity cache cannot adopt another owner or carry records across accounts',()=>{
  const first=mergeAttentionActivities([],[{id:'one',state:'UNKNOWN'},{id:'foreign',userId:'other',state:'UNKNOWN'},{id:'foreign-owner',owner:{id:'other'},state:'UNKNOWN'}],'owner',true);
  assert.deepEqual(first.map(row=>row.id),['one']);assert.deepEqual(mergeAttentionActivities(first,[],'other',false),[]);
});
