import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost} from '../client-http.mjs';
const url='https://portal.example';
function fixture(responses){const calls=[];return {calls,options:{sleep:async()=>{},fetchImpl:async(...args)=>{calls.push(args);const item=responses.shift();if(item instanceof Error)throw item;return item;}}};}
test('read-only 502 during deployment retries and returns the actual status result',async()=>{
 const f=fixture([new Response('<html>Bad Gateway</html>',{status:502}),new Response(JSON.stringify({result:{state:'READY'}}))]);
 const result=await apiPost(url,'call',{operation:'datasets.status',args:{dataset:'existing'}},f.options);
 assert.equal(result.result.state,'READY');assert.equal(f.calls.length,2);assert.equal(f.calls[0][1].redirect,'error');
});
test('read-only retries are bounded and preserve HTTP status, never mention a static preview',async()=>{
 const f=fixture(Array.from({length:8},()=>new Response('',{status:502}))),delays=[];
 f.options.sleep=async ms=>{delays.push(ms);};
 await assert.rejects(apiPost(url,'call',{operation:'state'},f.options),e=>e.status===502&&/HTTP 502/.test(e.message)&&!e.message.includes('preview'));
 assert.equal(f.calls.length,8);assert.deepEqual(delays,[500,1000,2000,4000,8000,16000,16000]);
 assert.equal(delays.reduce((a,b)=>a+b,0),47500);
});
test('read-only state survives a 45-second deployment window without a mutation or tight polling',async()=>{
 let elapsed=0;const calls=[],delays=[],body={operation:'state',args:{}};
 const result=await apiPost(url,'call',body,{
  sleep:async ms=>{delays.push(ms);elapsed+=ms;},
  fetchImpl:async(target,options)=>{calls.push({target,body:JSON.parse(options.body)});return elapsed<45000?new Response('',{status:503}):new Response('{"state":{"ready":true}}');}
 });
 assert.equal(result.state.ready,true);assert.equal(calls.length,8);assert.equal(elapsed,47500);
 assert.ok(calls.every(call=>JSON.stringify(call.body)===JSON.stringify(body)));
 assert.ok(delays.every(ms=>ms>=500));
});
test('caller cancellation aborts the backoff and never makes another request',async()=>{
 const controller=new AbortController();let count=0;
 await assert.rejects(apiPost(url,'call',{operation:'state'},{signal:controller.signal,
  fetchImpl:async()=>{count++;return new Response('',{status:502});},
  sleep:async(ms,signal)=>{controller.abort(new Error('user stopped'));signal.throwIfAborted();}
 }),/user stopped/);
 assert.equal(count,1);
});
test('unregister and job submission are never replayed on ambiguous gateway failure',async()=>{
 for(const operation of ['datasets.unregister','jobs.submit','datasets.upload.commit','files.put','login']){
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
test('connection and response body failures retry reads but not mutations',async()=>{
 for(const fail of [new TypeError('fetch failed'),{status:200,ok:true,json:async()=>{throw new TypeError('terminated');}}]){
  const f=fixture([fail,new Response('{"state":{}}')]);
  await apiPost(url,'call',{operation:'state'},f.options);assert.equal(f.calls.length,2);
  const mutation=fixture([fail]);await assert.rejects(apiPost(url,'call',{operation:'datasets.unregister'},mutation.options),/操作结果尚未确认/);assert.equal(mutation.calls.length,1);
 }
});
