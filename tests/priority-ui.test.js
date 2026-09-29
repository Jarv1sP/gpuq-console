import test from 'node:test';
import assert from 'node:assert/strict';
import {priorityLabel,priorityOptions,priorityDescription,trainingPriority,sampleTime,taskStateLabel,canEditPriority,taskTable} from '../dist/execution-ui.js';
import {resourceCards} from '../dist/resources-ui.js';

const job={id:'job-1',name:'training',username:'alice',userId:'alice-id',machine:'gpu-1',cards:1,state:'PENDING',priority:'normal',schedulerPriority:2,schedulerState:'PENDING',queueReason:'等待空闲 GPU',schedulerCheckedAt:'2026-09-29T08:00:00Z',canSetPriority:true};
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
  for(const value of [null,undefined,'','invalid'])assert.equal(sampleTime(value),'未提供');
  assert.notEqual(sampleTime('2026-09-29T08:00:00Z'),'未提供');assert.notEqual(sampleTime(1790668800),'未提供');
});
test('priority controls require administrator plus explicit queued capability, never running/unknown',()=>{
  assert.equal(canEditPriority(job),false);assert.equal(canEditPriority(job,true),true);
  for(const changed of [{canSetPriority:false},{canSetPriority:undefined},{state:'SUBMITTING'},{state:'RUNNING'},{state:'UNKNOWN'},{state:'SUCCEEDED'},{cancelRequested:true},{priority:null}])assert.equal(canEditPriority({...job,...changed},true),false);
  assert.doesNotMatch(taskTable([job]),/data-job-priority=/);
  assert.match(taskTable([job],{admin:true}),/data-job-priority="job-1"/);
  assert.doesNotMatch(taskTable([{...job,state:'RUNNING'}],{admin:true}),/data-job-priority=/);
});
test('task table displays scheduler evidence without inventing sampling time or cancellation cause',()=>{
  const html=taskTable([job]);assert.match(html,/普通/);assert.match(html,/等待空闲 GPU/);assert.match(html,/调度状态：PENDING/);assert.match(html,/核对时间/);
  assert.equal(taskStateLabel({...job,state:'CANCELED'}),'已取消');assert.equal(taskStateLabel({...job,state:'CANCELED',preempted:true}),'让位结束');
  const preempted=taskTable([{...job,state:'CANCELED',preempted:true}]);assert.match(preempted,/输出保留，不自动恢复/);assert.match(preempted,/data-job-cancel="job-1" disabled/);
  const unknown=taskTable([{...job,schedulerCheckedAt:null,queueReason:null,schedulerState:null}]);assert.match(unknown,/核对时间：未提供/);assert.match(unknown,/暂无调度说明/);assert.doesNotMatch(unknown,/预计.*开始/);
});
test('scheduler text and identities are escaped and administrators cannot open other users output',()=>{
  const html=taskTable([{...job,id:'" onfocus="bad',name:'<name>',queueReason:'<script>bad</script>',schedulerState:'<state>',schedulerCheckedAt:'<date>',project:'vision'}],{admin:true,userId:'other'});
  assert.doesNotMatch(html,/<name>|<script>|<state>|<date>|data-job-output=/);assert.match(html,/&lt;script&gt;/);
  assert.match(taskTable([{...job,project:'vision'}],{admin:true,userId:'alice-id'}),/data-job-output=/);
});
test('original node queue is readonly, reports raw priorities and unknown policy without claiming control',()=>{
  const machine={id:'gpu-1',cards:1,model:'GPU',memory:'24 GiB'},snapshot={stale:false,checkedAt:'2026-09-29T08:00:00Z',hosts:[{id:machine.id,reachable:true,gpus:[],gpuq:{connected:true,jobs:[{id:'J1',name:'legacy',state:'PENDING',priority:0,state_reason:'<pending>'},{id:'J2',name:'external',state:'RUNNING'}]}}]};
  const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot,admin:true,production:true});
  assert.match(html,/调度记录，只读/);assert.match(html,/服务器原始档位/);assert.match(html,/P0（原队列）/);assert.match(html,/让位策略：未提供/);assert.match(html,/&lt;pending&gt;/);assert.doesNotMatch(html,/data-job-priority|data-job-cancel/);
  const member=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot,production:true});assert.doesNotMatch(member,/legacy|external|J1|J2/);
});
