import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchCards,stateWord,stateClass} from '../dist/workbench-ui.js';

const job=(id,state,extra={})=>({id,userId:'owner',name:id,machine:'gpu-1',cards:1,state,...extra});
const focal=html=>html.match(/class="job hero-frame[^"]*" data-workbench-job="([^"]+)"/)?.[1];
const rowCount=(html,id)=>html.split('data-workbench-job="'+id+'"').length-1;

test('204 failed terminal jobs belong to history, preserving every failure and input record',()=>{
  const failed=Array.from({length:204},(_,index)=>job('failed-'+index,'FAILED',{error:'failure-'+index+' <details>'}));
  const jobs=[...failed,job('waiting','PENDING')],before=structuredClone(jobs),html=workbenchCards(jobs);
  assert.equal(focal(html),'waiting');
  assert.ok(html.includes('已结束的训练 · 204 项'));
  assert.ok(!html.includes('wb-attention'));
  assert.ok(!html.includes('需要处理'));
  for(const item of failed){assert.equal(rowCount(html,item.id),1);assert.ok(html.includes(item.error.replace('<details>','&lt;details&gt;')));}
  assert.deepEqual(jobs,before);
});

test('historical failure never displaces a current pending job as the focal task',()=>{
  const html=workbenchCards([job('old-failure','FAILED'),job('waiting','PENDING'),job('newer-failure','FAILED')]);
  assert.equal(focal(html),'waiting');assert.ok(html.includes('已结束的训练 · 2 项'));
});

test('an all-terminal list keeps the latest failed task visible as recent history, not attention',()=>{
  const html=workbenchCards([job('old-success','SUCCEEDED'),job('last-failure','FAILED',{error:'original failure'})]);
  assert.equal(focal(html),'last-failure');assert.ok(html.includes('最近一次训练'));
  assert.ok(html.includes('训练失败'));assert.ok(html.includes('original failure'));
  assert.ok(!html.includes('需要处理'));assert.ok(html.includes('已结束的训练 · 1 项'));
});

test('unconfirmed cancellation remains active and clearly says it is canceling',()=>{
  const pending=job('cancel-pending','PENDING',{cancelRequested:true}),html=workbenchCards([job('failed','FAILED'),pending]);
  assert.equal(stateWord(pending),'正在取消');assert.equal(stateClass(pending),'st-cancel');
  assert.equal(focal(html),pending.id);assert.ok(html.includes('正在取消'));
  assert.ok(html.includes('已结束的训练 · 1 项'));assert.equal(rowCount(html,pending.id),1);
});

test('UNKNOWN remains active and attention-worthy; only scheduler terminal states enter history',()=>{
  const html=workbenchCards([job('done','SUCCEEDED'),job('canceled','CANCELED'),job('failed','FAILED'),job('unknown','UNKNOWN')]);
  assert.equal(focal(html),'unknown');assert.ok(html.includes('需要处理'));
  assert.ok(html.includes('状态待核对'));assert.ok(html.includes('已结束的训练 · 3 项'));
  for(const id of ['done','canceled','failed','unknown'])assert.equal(rowCount(html,id),1);
});

test('empty workbench and explicit active focus retain their existing behavior',()=>{
  assert.ok(workbenchCards([]).includes('开始一次训练'));
  const html=workbenchCards([job('running','RUNNING'),job('waiting','PENDING'),job('failed','FAILED')],{focusId:'waiting'});
  assert.equal(focal(html),'waiting');assert.ok(html.includes('其他进行中的训练'));
  assert.ok(html.includes('已结束的训练 · 1 项'));
});
