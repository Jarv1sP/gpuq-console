import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runCloudFileIO} from '../cloud-files-worker.mjs';

const request=()=>({action:'verify',ownerId:'demo-user-3',operationId:randomUUID(),fileId:randomUUID(),receipt:'FIXED_PRIVATE_SEALED_RECEIPT'});
function fakeClock(){let time=0;const waits=[];return {now:()=>time,sleep:async(ms,signal)=>{signal?.throwIfAborted();waits.push(ms);time+=ms;signal?.throwIfAborted();},advance:ms=>time+=ms,waits};}
const forbidden=()=>assert.fail('Verification must not upload, download, read file bytes or reserve storage');

test('pending cloud metadata is confirmed with bounded backoff against exactly one owner and original receipt',async()=>{
  const r=request(),clock=fakeClock(),calls=[],events=[];
  const adapter={upload:forbidden,download:forbidden,async verify(args,{signal}){
    signal.throwIfAborted();calls.push(args);assert.deepEqual(args,{ownerId:r.ownerId,receipt:r.receipt});
    return {id:r.fileId,state:calls.length<3?'VERIFYING':'VERIFIED',receipt:'FINAL_SEALED_RECEIPT'};
  }};
  const out=await runCloudFileIO(r,{adapter,clock,emit:frame=>events.push(frame)});
  assert.equal(out.state,'VERIFIED');assert.equal(calls.length,3);assert.deepEqual(clock.waits,[2000,4000]);
  assert.ok(calls.every(args=>args===calls[0]&&Object.isFrozen(args)));
  assert.deepEqual(events,[0,1,2].map(()=>({kind:'progress',stage:'VERIFYING',bytes:0})));
});

test('permanent pending metadata reaches one fixed five-minute deadline, never returns a false verified result',async()=>{
  const r=request(),clock=fakeClock();let calls=0;
  const adapter={upload:forbidden,download:forbidden,verify:async args=>{calls++;assert.deepEqual(args,{ownerId:r.ownerId,receipt:r.receipt});return {id:r.fileId,state:'VERIFYING'};}};
  await assert.rejects(runCloudFileIO(r,{adapter,clock}),error=>error.code==='CLOUD_CONFIRMATION_TIMEOUT');
  assert.equal(clock.now(),300000);assert.ok(calls<=24);assert.equal(clock.waits.reduce((a,b)=>a+b,0),300000);
  assert.ok(clock.waits.every(ms=>ms>0&&ms<=15000));assert.equal(clock.waits.at(-1),1000);
});

test('unknown state, missing result or wrong immutable file ID stops immediately without another query',async()=>{
  for(const answer of [()=>null,()=>({}),()=>({id:randomUUID(),state:'VERIFIED'}),()=>({state:'VERIFIED'}),r=>({id:r.fileId,state:'READY'}),r=>({id:r.fileId,state:'FAILED'})]){
    const r=request(),clock=fakeClock();let calls=0;
    const adapter={verify:async()=>{calls++;return answer(r);}};
    await assert.rejects(runCloudFileIO(r,{adapter,clock}));assert.equal(calls,1);assert.deepEqual(clock.waits,[]);
  }
});

test('authorization failure is not swallowed or retried as eventual cloud readiness',async()=>{
  const r=request(),clock=fakeClock(),denied=Object.assign(Error('Authorization denied'),{status:403});let calls=0;
  await assert.rejects(runCloudFileIO(r,{clock,adapter:{verify:async()=>{calls++;throw denied;}}}),error=>error===denied);
  assert.equal(calls,1);assert.deepEqual(clock.waits,[]);
});

test('revocation between observations prevents the next metadata query',async()=>{
  const r=request(),clock=fakeClock();let allowed=true,calls=0,queries=0;
  clock.sleep=async ms=>{clock.advance(ms);allowed=false;};
  const adapter={verify:async()=>{calls++;if(!allowed)throw Object.assign(Error('Revoked'),{status:403});queries++;return {id:r.fileId,state:'VERIFYING'};}};
  await assert.rejects(runCloudFileIO(r,{adapter,clock}),error=>error.status===403);assert.equal(calls,2);assert.equal(queries,1);
});

test('cancellation during backoff stops before the next metadata call or success frame',async()=>{
  const r=request(),clock=fakeClock(),controller=new AbortController();let calls=0;
  clock.sleep=async(ms,signal)=>{clock.advance(ms);controller.abort();signal.throwIfAborted();};
  await assert.rejects(runCloudFileIO(r,{clock,signal:controller.signal,adapter:{verify:async()=>{calls++;return {id:r.fileId,state:'VERIFYING'};}}}),error=>error.name==='AbortError');
  assert.equal(calls,1);
});

test('canceled delayed RPC cannot adopt its late verified result or emit another progress frame',async()=>{
  const r=request(),clock=fakeClock(),controller=new AbortController(),events=[];let release,calls=0;
  const pending=runCloudFileIO(r,{clock,signal:controller.signal,emit:value=>events.push(value),adapter:{verify:()=>{calls++;return new Promise(resolve=>release=resolve);}}});
  await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');release({id:r.fileId,state:'VERIFIED'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(events.length,1);
});

test('the overall worker deadline bounds a stuck adapter independently of each RPC timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const r=request(),clock=fakeClock();let calls=0,release;
  const pending=runCloudFileIO(r,{clock,adapter:{verify:()=>{calls++;return new Promise(resolve=>release=resolve);}}});
  const rejected=assert.rejects(pending,error=>error.code==='CLOUD_CONFIRMATION_TIMEOUT');
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(300000);await rejected;
  release({id:r.fileId,state:'VERIFIED'});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test('a response after the fixed deadline is not accepted even when it claims VERIFIED',async()=>{
  const r=request(),clock=fakeClock();let calls=0;
  await assert.rejects(runCloudFileIO(r,{clock,adapter:{verify:async()=>{calls++;clock.advance(300000);return {id:r.fileId,state:'VERIFIED'};}}}),error=>error.code==='CLOUD_CONFIRMATION_TIMEOUT');
  assert.equal(calls,1);assert.deepEqual(clock.waits,[]);
});

test('an already canceled verification makes no adapter call and never widens worker request fields',async()=>{
  const r=request(),controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(runCloudFileIO(r,{signal:controller.signal,adapter:{verify:()=>calls++}}),error=>error.name==='AbortError');
  assert.equal(calls,0);
  for(const fields of [{clock:{}},{hostAdmin:true},{userId:'builtin-admin'},{token:'secret'},{offset:0},{path:'/other'}])
    await assert.rejects(runCloudFileIO({...r,...fields},{adapter:{verify:forbidden}}));
});
