import test from 'node:test';
import assert from 'node:assert/strict';
import {priorityLabel,priorityOptions,priorityDescription,trainingPriority,sampleTime,taskStateLabel,canEditPriority,taskTable,priorityRankOptions,schedulingContractLabel} from '../dist/execution-ui.js';
import {resourceCards} from '../dist/resources-ui.js';

const job={id:'job-1',name:'training',username:'alice',userId:'alice-id',machine:'gpu-1',cards:1,state:'PENDING',priority:'normal',schedulerPriority:2,schedulerState:'PENDING',queueReason:'等待空闲 GPU',schedulerCheckedAt:'2026-09-29T08:00:00Z',canSetPriority:true};
test('rank editor offers five levels and does not promise different yielding',()=>{
  const options=priorityRankOptions('P1');assert.match(options,/value="P1" selected/);assert.match(options,/value="P3"/);assert.doesNotMatch(options,/可中断/);
  assert.match(schedulingContractLabel({yield_policy:'save',restart_policy:'on-preempt'}),/保存后让位.*重新排队/);
  const html=taskTable([{...job,priority:'P1',schedulerPriority:1,schedulerPolicy:{yield_policy:'never',restart_policy:'on-preempt'}}],{admin:true});
  assert.match(html,/P1 低/);assert.match(html,/不让位.*被抢占后重新排队/);assert.match(html,/仅改排队顺序/);assert.match(html,/data-job-priority=/);
});
test('member choices are explicit normal/interruptible idle and never high',()=>{
  const member=priorityOptions(),admin=priorityOptions(true);
  assert.match(member,/<option value="normal" selected>/);assert.match(member,/最低 · 可中断/);assert.doesNotMatch(member,/value="high"/);assert.match(admin,/value="high"/);
  for(const priority of ['normal','idle'])assert.equal(trainingPriority(priority),priority);
  assert.equal(trainingPriority('high',true),'high');assert.throws(()=>trainingPriority('high'),/管理员/);
  for(const value of [null,undefined,'','P0',0,'urgent','toString'])assert.throws(()=>trainingPriority(value,true));
  assert.match(priorityDescription('idle'),/结束进程/);assert.match(priorityDescription('high'),/不自动中断普通/);
});
test('old and external priorities remain unknown or raw P-levels, never assumed normal/idle',()=>{
  assert.equal(priorityLabel(null),'未标注');assert.equal(priorityLabel(undefined),'未标注');assert.equal(priorityLabel(0),'P0（原队列）');assert.equal(priorityLabel(4),'P4（原队列）');assert.equal(priorityLabel('P4'),'未标注');
  assert.match(taskTable([{...job,priority:null,schedulerPriority:4,canSetPriority:false}]),/未标注/);
  assert.match(taskTable([{...job,priority:null,schedulerPriority:4,canSetPriority:false}]),/节点优先级：P4/);
  for(const value of [null,undefined,'','invalid',0,-1,NaN])assert.equal(sampleTime(value),'—');
  assert.notEqual(sampleTime('2026-09-29T08:00:00Z'),'—');assert.notEqual(sampleTime(1790668800),'—');
});
test('priority controls require administrator plus explicit queued capability, never running/unknown',()=>{
  assert.equal(canEditPriority(job),false);assert.equal(canEditPriority(job,true),true);
  for(const changed of [{canSetPriority:false},{canSetPriority:undefined},{state:'SUBMITTING'},{state:'RUNNING'},{state:'UNKNOWN'},{state:'SUCCEEDED'},{cancelRequested:true},{priority:null}])assert.equal(canEditPriority({...job,...changed},true),false);
  assert.doesNotMatch(taskTable([job]),/data-job-priority=/);
  assert.match(taskTable([job],{admin:true}),/data-job-priority="job-1"/);
  assert.doesNotMatch(taskTable([{...job,state:'RUNNING'}],{admin:true}),/data-job-priority=/);
});
test('task table displays scheduler evidence without inventing sampling time or cancellation cause',()=>{
  const html=taskTable([job]);assert.match(html,/普通/);assert.match(html,/等待空闲 GPU/);assert.match(html,/状态：PENDING/);assert.match(html,/更新于/);
  assert.equal(taskStateLabel({...job,state:'CANCELED'}),'已取消');assert.equal(taskStateLabel({...job,state:'CANCELED',preempted:true}),'让位结束');
  const preempted=taskTable([{...job,state:'CANCELED',preempted:true}]);assert.match(preempted,/输出保留，不自动恢复/);assert.match(preempted,/data-job-cancel="job-1" disabled/);
  const unknown=taskTable([{...job,schedulerCheckedAt:null,queueReason:null,schedulerState:null}]);assert.match(unknown,/更新于 —/);assert.match(unknown,/暂无调度说明/);assert.doesNotMatch(unknown,/预计.*开始/);
});
test('data preparation state and escaped task metadata coexist after the frontend merge',()=>{
  const preparing={...job,state:'PREPARING_DATA',schedulerState:null,submitterName:'张三 <script>',description:'等待固定数据版本 <img src=x>',canSetPriority:false};
  const html=taskTable([preparing],{userId:job.userId});
  assert.equal(taskStateLabel(preparing),'准备数据 · 不占 GPU');
  assert.match(html,/准备数据 · 不占 GPU/);assert.match(html,/张三 &lt;script&gt;/);assert.match(html,/等待固定数据版本 &lt;img src=x&gt;/);
  assert.doesNotMatch(html,/<script>|<img|data-job-priority=/);
});
test('scheduler text and identities are escaped and administrators cannot open other users output',()=>{
  const html=taskTable([{...job,id:'" onfocus="bad',name:'<name>',queueReason:'<script>bad</script>',schedulerState:'<state>',schedulerCheckedAt:'<date>',project:'vision'}],{admin:true,userId:'other'});
  assert.doesNotMatch(html,/<name>|<script>|<state>|<date>|data-job-output=/);assert.match(html,/&lt;script&gt;/);
  assert.match(taskTable([{...job,project:'vision'}],{admin:true,userId:'alice-id'}),/data-job-output=/);
});
test('original node queue is readonly, reports raw priorities and unknown policy without claiming control',()=>{
  const machine={id:'gpu-1',cards:1,model:'GPU',memory:'24 GiB'},snapshot={stale:false,checkedAt:'2026-09-29T08:00:00Z',hosts:[{id:machine.id,reachable:true,gpus:[],gpuq:{connected:true,jobs:[{id:'J1',name:'legacy',state:'PENDING',priority:0,state_reason:'<pending>'},{id:'J2',name:'external',state:'RUNNING'}]}}]};
  const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot,admin:true,production:true});
  assert.match(html,/任务记录 · 2 条/);assert.match(html,/data-resource-info="gpu-1:queue-info"/);assert.match(html,/记录只供查看/);assert.match(html,/优先级和让位方式显示服务器返回的值/);assert.match(html,/P0（原队列）/);assert.match(html,/让位策略：未提供/);assert.match(html,/&lt;pending&gt;/);assert.doesNotMatch(html,/data-job-priority|data-job-cancel/);
  const member=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot,production:true});assert.doesNotMatch(member,/legacy|external|J1|J2/);
});
