import test from 'node:test';
import assert from 'node:assert/strict';
import {createUploadMeter} from '../dist/dataset-upload-metrics.js';

test('hashing and manifest progress never become file upload progress',()=>{
  const meter=createUploadMeter(()=>0);
  assert.equal(meter.report({state:'HASHING',bytes:100,totalBytes:100}),null);
  assert.equal(meter.report({state:'RECEIVING_MANIFEST',bytes:50,totalBytes:100}),null);
});
test('speed and remaining time start with a second confirmed offset, excluding resumed bytes',()=>{
  let time=100;const meter=createUploadMeter(()=>time);
  assert.deepEqual(meter.report({state:'UPLOADING',bytes:600,totalBytes:1000}),{bytes:600,totalBytes:1000,time:100,percent:60,speed:null,seconds:null});
  time=2100;const result=meter.report({state:'UPLOADING',bytes:800,totalBytes:1000});
  assert.equal(result.speed,100);assert.equal(result.seconds,2);assert.equal(result.percent,80);
});
test('invalid, backwards, changed-total and clock-reversal reports cannot advance confirmed progress',()=>{
  let time=100;const meter=createUploadMeter(()=>time),initial=meter.report({state:'UPLOADING',bytes:10,totalBytes:100});
  for(const [bytes,totalBytes] of [[9,100],[11,101],[101,100],[-1,100],[1.5,100],[10,NaN]])assert.equal(meter.report({state:'UPLOADING',bytes,totalBytes}),initial);
  time=99;assert.equal(meter.report({state:'UPLOADING',bytes:20,totalBytes:100}),initial);
});
test('zero bytes do not invent a percentage or speed and reset clears the previous upload',()=>{
  let time=0;const meter=createUploadMeter(()=>time);
  assert.equal(meter.report({state:'UPLOADING',bytes:0,totalBytes:0}).percent,null);
  meter.reset();time=1000;assert.equal(meter.value,null);
  assert.equal(meter.report({state:'UPLOADING',bytes:0,totalBytes:100}).speed,null);
  time=2000;assert.equal(meter.report({state:'UPLOADING',bytes:100,totalBytes:100}).seconds,0);
});
