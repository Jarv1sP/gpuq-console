import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeObservationHTML,completionHTML,completionMatchesJob} from '../dist/job-diagnostics-ui.js';
test('read-only server observation distinguishes retry and unknown and escapes attempt metadata',()=>{
  assert.match(nativeObservationHTML({status:'CONFIRMED',state:'SUCCEEDED'}),/待确认/);
  assert.match(nativeObservationHTML({protocol:'native-observation-v1',readOnly:true,status:'UNKNOWN'}),/待确认/);
  const html=nativeObservationHTML({protocol:'native-observation-v1',readOnly:true,status:'CONFIRMED',state:'RUNNING',retryDetected:true,observedAt:1700000000,latestAttempt:{ordinal:2,id:'<img src=x>'}});
  assert.match(html,/已观察到服务器重试 · 运行中/);assert.match(html,/第 2 次/);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
});
test('completion evidence is bound to the fixed job, owner and node before display',()=>{
  const job={id:'fixed',userId:'owner',machine:'node',nodeJobId:'J0123456789ab'},value={protocol:'job-completion-v1',readOnly:true,jobId:job.id,userId:job.userId,machine:job.machine,nodeJobId:job.nodeJobId,completed:true,state:'SUCCEEDED',completedAttempt:{id:'A2'}};
  assert.equal(completionMatchesJob(value,job),true);
  for(const patch of [{jobId:'other'},{userId:'other'},{machine:'other'},{nodeJobId:'other'},{protocol:'old'},{readOnly:false},{completed:1},{state:'FAILED'},{state:'UNCONFIRMED'},{completedAttempt:null}])assert.equal(completionMatchesJob({...value,...patch},job),false,JSON.stringify(patch));
  assert.equal(completionMatchesJob({...value,completed:false,state:'UNCONFIRMED',completedAttempt:null},job),true);
});
test('unconfirmed completion never becomes success from a log or observation alone',()=>{
  assert.match(completionHTML({protocol:'job-completion-v1',completed:false,state:'SUCCEEDED'}),/完成待确认/);
  assert.match(completionHTML({protocol:'job-completion-v1',completed:true,state:'UNCONFIRMED'}),/完成待确认/);
  assert.match(completionHTML({protocol:'job-completion-v1',completed:true,state:'SUCCEEDED',completedAttempt:{ordinal:2},observedAt:1700000000}),/已核验完成/);
});
