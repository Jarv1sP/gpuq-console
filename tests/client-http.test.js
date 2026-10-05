import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost,visibleControls} from '../client-http.mjs';
const url='https://portal.example';
function fixture(responses){const calls=[];return {calls,options:{sleep:async()=>{},fetchImpl:async(...args)=>{calls.push(args);const item=responses.shift();if(item instanceof Error)throw item;return item;}}};}
test('read-only 502 during deployment retries and returns the actual status result',async()=>{
 const f=fixture([new Response('<html>Bad Gateway</html>',{status:502}),new Response(JSON.stringify({result:{state:'READY'}}))]);
 const result=await apiPost(url,'call',{operation:'datasets.status',args:{dataset:'existing'}},f.options);
 assert.equal(result.result.state,'READY');assert.equal(f.calls.length,2);assert.equal(f.calls[0][1].redirect,'error');
});
test('read-only retries are bounded and preserve HTTP status, never mention a static preview',async()=>{
 const f=fixture([502,502,502].map(status=>new Response('',{status})));
 await assert.rejects(apiPost(url,'call',{operation:'state'},f.options),e=>e.status===502&&/HTTP 502/.test(e.message)&&!e.message.includes('preview'));
 assert.equal(f.calls.length,3);
});
test('unregister and job submission are never replayed on ambiguous gateway failure',async()=>{
 for(const operation of ['datasets.unregister','jobs.submit','datasets.upload.commit']){
  const f=fixture([new Response('',{status:502})]);
  await assert.rejects(apiPost(url,'call',{operation},f.options),/操作结果尚未确认/);assert.equal(f.calls.length,1);
 }
});
test('malformed successful JSON and 404 are reported accurately without leaking HTML',async()=>{
 for(const status of [200,404]){
  const f=fixture([new Response('<html>private-token-do-not-print</html>',{status})]);
  await assert.rejects(apiPost(url,'call',{operation:'datasets.status'},f.options),e=>e.message.includes('HTTP '+status)&&!e.message.includes('private-token'));
  assert.equal(f.calls.length,1);
 }
});
test('401 JSON error does not retry or lose useful details',async()=>{
 const f=fixture([new Response(JSON.stringify({error:'会话失效'}),{status:401})]);
 await assert.rejects(apiPost(url,'call',{operation:'state'},f.options),/HTTP 401.*会话失效/);assert.equal(f.calls.length,1);
});
test('HTTP error messages visibly escape CSI, ESC, bidi and line separators without terminal control bytes',async()=>{
 const detail='CSI:\u009b2J ESC:\x1b[31m BIDI:\u202e\u2066 LINES:\u2028\u2029';
 const f=fixture([new Response(JSON.stringify({error:detail}),{status:403})]);
 await assert.rejects(apiPost(url,'call',{operation:'state'},f.options),error=>{
  assert.equal(error.status,403);
  assert.equal(error.message,'state：HTTP 403 — CSI:\\u{009b}2J ESC:\\u{001b}[31m BIDI:\\u{202e}\\u{2066} LINES:\\u{2028}\\u{2029}');
  assert.doesNotMatch(error.message,/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  return true;
 });
 assert.equal(f.calls.length,1);
});
test('HTTP error truncation follows escaping and never leaves a partial visible escape',async()=>{
 for(const control of ['\u009b','\x1b','\u202e','\u2028','\u2029','\u{e0001}']){
  const escape=visibleControls(control);
  for(let cut=0;cut<=escape.length;cut++){
   const prefix='x'.repeat(600-cut),f=fixture([new Response(JSON.stringify({error:prefix+control+'tail'}),{status:403})]);
   await assert.rejects(apiPost(url,'call',{operation:'state'},f.options),error=>{
    const detail=error.message.slice('state：HTTP 403 — '.length);
    assert.equal(detail,prefix+(cut===escape.length?escape:''));
    assert.ok(detail.length<=600);
    assert.doesNotMatch(detail,/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    return true;
   });
   assert.equal(f.calls.length,1);
  }
 }
});
test('shared CLI escaping preserves its explicit multiline LF behavior',()=>{
 assert.equal(visibleControls('first\nsecond\r\u2028\u2029'),'first\\u{000a}second\\u{000d}\\u{2028}\\u{2029}');
 assert.equal(visibleControls('first\nsecond\r\u2028\u2029',true),'first\nsecond\\u{000d}\\u{2028}\\u{2029}');
 assert.equal(visibleControls(null),'');
});
test('connection and response body failures retry reads but not mutations',async()=>{
 for(const fail of [new TypeError('fetch failed'),{status:200,ok:true,json:async()=>{throw new TypeError('terminated');}}]){
  const f=fixture([fail,new Response('{"state":{}}')]);
  await apiPost(url,'call',{operation:'state'},f.options);assert.equal(f.calls.length,2);
  const mutation=fixture([fail]);await assert.rejects(apiPost(url,'call',{operation:'datasets.unregister'},mutation.options),/操作结果尚未确认/);assert.equal(mutation.calls.length,1);
 }
});
