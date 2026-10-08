import test from 'node:test';
import assert from 'node:assert/strict';
import {formatTimestamp} from '../dist/time-format.js';
import {nativeObservationHTML,completionHTML,allocationHistoryHTML,diagnosticsHTML} from '../dist/job-diagnostics-ui.js';
import {sampleTime} from '../dist/execution-ui.js';
import {trajectoryHTML} from '../dist/workbench-ui.js';

test('shared timestamps never format missing, nonpositive or invalid values as a real date',()=>{
  for(const value of [undefined,null,'',' ',0,-1,NaN,Infinity,-Infinity,'invalid','NaN','0','-1','1970-01-01T00:00:00Z','1969-12-31T23:59:59Z',false,[],{},1e20]){
    assert.equal(formatTimestamp(value),'—',String(value));
    assert.equal(formatTimestamp(value,{clock:true}),'—',String(value));
    assert.equal(sampleTime(value),'—',String(value));
  }
  const seconds=1790668800.125,date=new Date(seconds*1000),format={year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hour12:false};
  assert.equal(formatTimestamp(seconds),date.toLocaleString('zh-CN',{hour12:false}));
  assert.equal(formatTimestamp(date.toISOString()),date.toLocaleString('zh-CN',{hour12:false}));
  assert.equal(formatTimestamp(date.getTime(),{seconds:false}),date.toLocaleString('zh-CN',{hour12:false}));
  assert.equal(formatTimestamp(seconds,{format}),date.toLocaleString('zh-CN',format));
  assert.equal(formatTimestamp(seconds,{clock:true,format:{hour:'2-digit',minute:'2-digit',hour12:false}}),date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}));
});
test('observations, completed tasks, diagnostics, leases and trajectories reuse the invalid-time guard',()=>{
  for(const value of [0,-1,NaN,'invalid']){
    const observed=nativeObservationHTML({protocol:'native-observation-v1',readOnly:true,status:'CONFIRMED',state:'SUCCEEDED',observedAt:value});
    assert.match(observed,/<dt>观察时间<\/dt><dd>—<\/dd>/);
    assert.match(completionHTML({protocol:'job-completion-v1',completed:true,state:'SUCCEEDED',completedAttempt:{ordinal:1},observedAt:value}),/ · —<\/p>$/);
    const diagnostics=diagnosticsHTML({state:'PARTIAL',attempts:[{started_at:value,finished_at:value}],captures:[{updatedAt:value}],historyAvailable:true,allocationHistory:[{acquired_at:value,released_at:value}]});
    assert.doesNotMatch(diagnostics,/1969|1970|Invalid Date/);assert.match(diagnostics,/—/);
    assert.doesNotMatch(allocationHistoryHTML({historyAvailable:true,allocationHistory:[{acquired_at:value,released_at:value}]}),/1969|1970|Invalid Date/);
    const trajectory=trajectoryHTML({state:'FAILED',createdAt:value,finishedAt:value});assert.doesNotMatch(trajectory,/1969|1970|Invalid Date|<time\b/);assert.match(trajectory,/<span class="t">—<\/span>/);
  }
});
