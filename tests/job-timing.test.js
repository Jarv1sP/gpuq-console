import test from 'node:test';
import assert from 'node:assert/strict';
import {jobTiming,jobTimingText,jobFeedbackText} from '../dist/job-progress.js';
import {jobTimingHTML,jobOverviewHTML,elapsedTraining} from '../dist/workbench-ui.js';
import {publicJob,schedulerResult,executionCall} from '../execution.mjs';

const workerEnd=1791096621.3531966,portalEnd='2026-10-04T20:59:08.610Z';
const fixture=()=>({id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',userId:'demo-user-1',name:'timing',machine:'gpu-1',state:'CANCELED',
  createdAt:'2026-10-03T21:04:42.564Z',finishedAt:portalEnd,cancelRequested:true,spec:{argv:['true']},
  latestAttempt:{id:'Afixture',ordinal:1,state:'CANCELED',exitCode:15,failureReason:null,startedAt:1791061513.3825824,finishedAt:workerEnd}});

test('historical terminal projection distinguishes node exit from fourteen-hour-later portal observation without mutation',()=>{
  const job=fixture(),before=structuredClone(job),view=publicJob(job);
  assert.equal(view.workerFinishedAt,'2026-10-04T06:50:21.353Z');
  assert.equal(view.terminalObservedAt,portalEnd);
  assert.equal(view.finishedAt,portalEnd,'retain documented legacy field, not a history migration');
  assert.equal(view.workerTimeSource,'scheduler-attempt');
  assert.equal(view.latestAttempt.exitCode,15);assert.equal(view.latestAttempt.failureReason,null);
  assert.deepEqual(job,before);
});

test('missing/PARTIAL runner receipt is not needed to display explicit scheduler attempt evidence and does not invent a reason',()=>{
  const job={...fixture(),diagnostics:{state:'PARTIAL'}};
  assert.equal(jobTiming(job).workerFinishedAt,'2026-10-04T06:50:21.353Z');
  assert.match(jobFeedbackText(job),/退出码 15/);
  assert.doesNotMatch(jobFeedbackText(job),/canceled by user|OOM|模型/);
  assert.equal(job.latestAttempt.failureReason,null);
});

test('no attempt evidence never falls back to portal finishedAt as worker exit',()=>{
  const job={...fixture(),latestAttempt:null};
  assert.equal(jobTiming(job).workerFinishedAt,null);
  assert.equal(jobTiming(job).workerTimeSource,null);
  assert.match(jobTimingText(job),/节点运行结束：未确认.*门户确认终态：2026/);
  assert.match(jobTimingHTML(job),/节点运行结束<\/dt><dd>未确认/);
});

test('unknown, active, lost or reversed/out-of-range attempt timestamps cannot fabricate worker completion',()=>{
  for(const changes of [{state:'RUNNING'},{state:'LOST'},{state:'STUCK'},{finishedAt:null},{finishedAt:NaN},{finishedAt:Infinity},
    {finishedAt:1e300},{finishedAt:1},{startedAt:workerEnd+1},{startedAt:'1791061513'}]){
    const job=fixture();Object.assign(job.latestAttempt,changes);
    assert.equal(jobTiming(job).workerFinishedAt,null,JSON.stringify(changes));
  }
  const job={...fixture(),state:'UNKNOWN'};
  assert.equal(jobTiming(job).terminalObservedAt,null);assert.equal(jobTimingText(job),'');assert.equal(jobTimingHTML(job),'');
});

test('new scheduler terminal observation retains its own clock and original node timestamp',()=>{
  const job={...fixture(),state:'RUNNING'};delete job.finishedAt;
  schedulerResult(job,{state:'CANCELED',latestAttempt:{id:'Afixture',ordinal:1,state:'CANCELED',exit_code:15,
    started_at:1791061513.3825824,finished_at:workerEnd,failure_reason:null}});
  const view=publicJob(job);assert.equal(view.terminalObservedAt,job.checkedAt);
  assert.equal(view.workerFinishedAt,'2026-10-04T06:50:21.353Z');
  const original=job.finishedAt;schedulerResult(job,{state:'CANCELED'});
  assert.equal(job.finishedAt,original);assert.equal(publicJob(job).workerFinishedAt,null,'never keep an unsupported old attempt report');
});

test('terminal watch projects both clocks without node calls, writes, resubmission or cancellation',async()=>{
  const job=fixture(),user={id:job.userId,enabled:true,limits:{'gpu-1':1}};
  const service={store:{get:id=>id===user.id?user:{...user,id},jobs:[job]},bridge:()=>assert.fail('no node call'),save:()=>assert.fail('no DB write')};
  const before=structuredClone(job),view=await executionCall(service,{userId:user.id,role:'member'},'jobs.watch',{jobId:job.id});
  assert.equal(view.workerFinishedAt,'2026-10-04T06:50:21.353Z');assert.equal(view.terminalObservedAt,portalEnd);assert.deepEqual(job,before);
  await assert.rejects(executionCall(service,{userId:'demo-user-2',role:'member'},'jobs.watch',{jobId:job.id}),e=>e.status===403);
});

test('overview and CLI label both clocks with full dates while elapsed training uses only the attempt',()=>{
  const job=fixture(),html=jobOverviewHTML(job),text=jobTimingText(job);
  assert.match(html,/节点运行结束/);assert.match(html,/门户确认终态/);
  assert.match(html,/datetime="2026-10-04T06:50:21\.353Z"/);assert.match(html,/datetime="2026-10-04T20:59:08\.610Z"/);
  assert.match(text,/2026-10-04T06:50:21\.353Z.*2026-10-04T20:59:08\.610Z/);
  assert.equal(elapsedTraining(job),'9:45:07');
  job.finishedAt='2030-01-01T00:00:00Z';assert.equal(elapsedTraining(job),'9:45:07');
});
