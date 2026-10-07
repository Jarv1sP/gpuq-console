import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetCacheWatch,cacheProgress} from '../dist/dataset-cache-watch.js';
const ref={machine:'server-a',dataset:'sample',version:'a'.repeat(64),totalBytes:4096},operationId='b'.repeat(64);
function fixture(){let owner='alice',active=true,allowed=true,reply={...ref,state:'PREPARING'},ready=0,changes=0,timer,requests=[];
 const watch=datasetCacheWatch({identity:()=>owner,active:()=>active,allowed:()=>allowed,call:async(operation,args)=>{requests.push({owner,operation,args});return typeof reply==='function'?reply():reply;},onReady:()=>{ready++;},onChange:()=>{changes++;},schedule:(fn,delay)=>{timer={fn,delay};return timer;},cancel:value=>{if(value===timer)timer=null;}});
 return {watch,requests,get ready(){return ready;},get timer(){return timer;},get changes(){return changes;},reply:value=>reply=value,owner:value=>owner=value,active:value=>{active=value;watch.sync();},allowed:value=>allowed=value};
}
test('cache progress requires confirmed counters, never a fabricated percent',()=>{
 assert.equal(cacheProgress({},4096),null);assert.equal(cacheProgress({bytes:4096},4096),null);assert.deepEqual(cacheProgress({remainingBytes:1024},4096),{bytes:3072,totalBytes:4096});
 assert.deepEqual(cacheProgress({bytes:1,totalBytes:4},8),{bytes:1,totalBytes:4});
 for(const value of [{bytes:-1,totalBytes:4},{bytes:5,totalBytes:4},{remainingBytes:5},{bytes:'1',totalBytes:4}])assert.equal(cacheProgress(value,4),null);
});
test('observe original worker through progress to READY, refresh once and stop',async()=>{
 const f=fixture(),row=f.watch.begin(ref,{dispatching:true});await f.watch.poll();assert.equal(f.requests.length,0);
 f.watch.settled(row,{...ref,state:'PREPARING',operationId});f.reply({...ref,state:'PREPARING',operationId,remainingBytes:1024});await f.watch.poll();
 assert.deepEqual(f.requests[0],{owner:'alice',operation:'datasets.status',args:{machine:ref.machine,operationId}});assert.deepEqual(row.progress,{bytes:3072,totalBytes:4096});
 f.reply({...ref,state:'READY',operationId});await f.watch.poll();await Promise.resolve();assert.equal(row.state,'READY');assert.equal(f.ready,1);assert.equal(f.timer,null);await f.watch.poll();assert.equal(f.requests.length,2);
});
test('lost first reply only queries fixed version and never dispatches prepare',async()=>{
 const f=fixture(),row=f.watch.begin(ref,{dispatching:true});f.watch.settled(row,null,Error('reply lost'));await f.watch.poll();
 assert.deepEqual(f.requests[0].args,{machine:ref.machine,dataset:ref.dataset,version:ref.version});assert(f.requests.every(row=>row.operation==='datasets.status'));
 f.reply({...ref,state:'FAILED',error:'copy failed'});await f.watch.poll();assert.equal(row.state,'FAILED');assert.equal(row.error,'copy failed');assert.equal(f.ready,0);assert.equal(f.timer,null);
});
test('old node or mismatched receipt is UNKNOWN and cannot enable READY',async()=>{
 const f=fixture(),row=f.watch.begin(ref);for(const value of [{state:'READY'},{...ref,version:'c'.repeat(64),state:'READY'},{...ref,dataset:'other',state:'READY'}]){f.reply(value);await f.watch.poll();assert.equal(row.state,'UNKNOWN');assert.equal(row.progress,null);}
 assert.equal(f.ready,0);
});
test('physical aliases stay fixed and denied original handle only falls back to a read',async()=>{
 const f=fixture(),row=f.watch.begin({...ref,physicalDataset:'physical-sample'});f.watch.settled(row,{...ref,state:'PREPARING',operationId});f.reply({...ref,dataset:'physical-sample',operationId,state:'READY'});await f.watch.poll();assert.equal(row.state,'READY');
 const g=fixture(),other=g.watch.begin(ref);g.watch.settled(other,{...ref,state:'PREPARING',operationId});let count=0;g.reply(()=>{if(!count++)throw Object.assign(Error('shared worker'),{status:403});return {...ref,state:'READY'};});await g.watch.poll();assert.equal(other.state,'READY');assert.deepEqual(g.requests.map(row=>row.args),[{machine:ref.machine,operationId},{machine:ref.machine,dataset:ref.dataset,version:ref.version}]);
});
test('inactive room, revoked machine and changed account cannot read or consume old replies',async()=>{
 const f=fixture();assert.equal((f.allowed(false),f.watch.begin(ref)),null);assert.equal(f.requests.length,0);f.allowed(true);const row=f.watch.begin(ref);f.active(false);await f.watch.poll();assert.equal(f.requests.length,0);assert.equal(f.timer,null);
 f.active(true);let release;f.reply(()=>new Promise(resolve=>release=resolve));const pending=f.watch.poll();f.owner('bob');f.watch.reset();release({...ref,state:'READY'});await pending;assert.equal(f.ready,0);assert.equal(f.watch.get(ref),undefined);assert.notEqual(row.state,'READY');
});
test('temporary reads back off, permission failure pauses, fresh catalog may resume',async()=>{
 const f=fixture(),row=f.watch.begin(ref);f.reply(()=>{throw Error('offline');});await f.watch.poll();assert.equal(row.state,'UNKNOWN');assert.equal(f.timer.delay,3000);
 f.reply(()=>{throw Object.assign(Error('denied'),{status:403});});await f.watch.poll();assert.equal(f.timer,null);const count=f.requests.length;await f.watch.poll();assert.equal(f.requests.length,count);
 f.watch.catalog([{...ref,state:'PREPARING',canUse:true}]);assert(f.timer);f.reply({...ref,state:'READY'});await f.watch.poll();assert.equal(row.state,'READY');
});
test('catalog does not infer a new request; fresh state replaces historical READY overlay',async()=>{
 const f=fixture();f.watch.catalog([{...ref,state:'PREPARING',canUse:true}]);assert.equal(f.timer,undefined);assert.equal(f.watch.get(ref),undefined);
 f.watch.begin(ref);f.reply({...ref,state:'READY'});await f.watch.poll();f.watch.catalog([{...ref,state:'REGISTERED',canUse:true}]);assert.equal(f.watch.get(ref),undefined);
});
test('confirmed catalog failure replaces pending cache state and stops its polling',()=>{
 const f=fixture(),row=f.watch.begin(ref,{dispatching:true});f.watch.settled(row,{...ref,state:'PREPARING',operationId});assert(f.timer);
 f.watch.catalog([{...ref,state:'FAILED',canUse:true,error:'copy failed'}]);
 assert.equal(f.watch.get(ref),undefined);assert.equal(f.timer,null);assert.equal(f.requests.length,0);assert.equal(f.ready,0);
 const retry=f.watch.begin(ref,{dispatching:true});assert(retry);assert.notEqual(retry,row,'Only an explicit retry starts another watch');
});
test('late status reply cannot replace a newer confirmed catalog failure',async()=>{
 const f=fixture(),row=f.watch.begin(ref);f.watch.settled(row,{...ref,state:'PREPARING',operationId});
 let release;f.reply(()=>new Promise(resolve=>release=resolve));const pending=f.watch.poll();
 f.watch.catalog([{...ref,state:'FAILED',canUse:true}]);release({...ref,state:'PREPARING',operationId});await pending;
 assert.equal(f.watch.get(ref),undefined);assert.equal(f.timer,null);assert.equal(f.ready,0);
 assert.deepEqual(f.requests.map(request=>request.operation),['datasets.status']);
});
