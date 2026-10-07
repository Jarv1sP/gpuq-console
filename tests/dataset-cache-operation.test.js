// Simulated future responses only; these tests do not assert production availability.
import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptCacheCapability,canCacheAction,cacheOperationStorageKey,cacheOperationReceipt,createCacheOperation} from '../dist/dataset-cache-operation.js';
const scope={action:'prepare',machine:'node-b',dataset:'sample',version:'a'.repeat(64)},operationId='10000000-0000-4000-8000-000000000001';
function fixture(options={}){
 const values=new Map(),requests=[],store={production:true,principal:{userId:'alice',enabled:true},authGeneration:0};
 let sequence=0,timer=null;
 const f={values,requests,store,cap:{protocol:1,prepare:true,release:true},reply:null,failSave:false,active:true};
 const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>{if(f.failSave)throw Error('storage unavailable');values.set(key,value);}};
 f.receipt=(overrides={})=>({...scope,...options,key:f.api.snapshot().request.key,operationId,state:'RUNNING',phase:'COPYING',canCancel:true,...overrides});
 store.call=async(operation,args)=>{
  requests.push({operation,args:structuredClone(args),account:store.principal.userId});
  if(operation==='datasets.cache.capabilities')return typeof f.cap==='function'?f.cap():f.cap;
  return typeof f.reply==='function'?f.reply(operation,args):f.reply||f.receipt();
 };
 f.mount=()=>createCacheOperation({...scope,...options,store,storage,capabilities:{protocol:1,prepare:true,release:true},active:()=>f.active,newKey:()=>'00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'),schedule:(fn,delay)=>{timer={fn,delay};return timer;},clear:value=>{if(value===timer)timer=null;}});
 f.api=f.mount();Object.defineProperty(f,'timer',{get:()=>timer});return f;
}
test('published protocol 1 requires an explicit boolean for the requested action',()=>{
 for(const raw of [undefined,null,{},true,{enabled:true},{protocol:1},{allowed:'true'},{allowed:true},{actions:['prepare','release']},{allowed:false},{protocol:1,prepare:false,release:true},{protocol:0,prepare:true,allowed:true},{protocol:'1',prepare:true},{protocol:2,prepare:true},{protocol:1,prepare:'true'}])assert.equal(canCacheAction(raw,'prepare'),false);
 assert.deepEqual(adaptCacheCapability({protocol:1,prepare:false,release:true,reason:'server text'},'release'),{allowed:true,reason:'server text',protocol:1});
 assert.equal(canCacheAction({protocol:1,prepare:true,release:false},'release'),false);
 assert.equal(canCacheAction({protocol:1,prepare:true},'cancel'),false);
 assert.equal(canCacheAction({protocol:1,prepare:true,release:true},'prepare'),true);
});
test('BLOCKED is a confirmed terminal receipt; retry is explicit and rechecks action permission',async()=>{
 const f=fixture();f.cap={protocol:1,prepare:true,release:false};
 f.reply=()=>f.receipt({state:'BLOCKED',phase:'BLOCKED',canCancel:false,error:'读取租约尚未结束'});
 await f.api.start();const key=f.api.snapshot().request.key;
 assert.equal(f.timer,null);assert.equal(f.api.snapshot().confirmed,true);assert.equal(f.api.snapshot().error,'读取租约尚未结束');
 assert.equal(f.api.snapshot().canCancel,false);assert.equal(f.requests.filter(r=>r.operation==='datasets.cache.prepare').length,1);
 f.cap={protocol:1,prepare:false,release:true,reason:'服务器拒绝准备'};await f.api.start();
 assert.equal(f.api.snapshot().request.key,key);assert.equal(f.requests.filter(r=>r.operation==='datasets.cache.prepare').length,1);
 f.cap={protocol:1,prepare:true,release:false};await f.api.check();await f.api.start();
 assert.notEqual(f.api.snapshot().request.key,key);assert.equal(f.requests.filter(r=>r.operation==='datasets.cache.prepare').length,2);assert.equal(f.timer,null);
 f.api.destroy();
});
test('dispatch saves one frozen account key before write; progress requires paired actual bytes',async()=>{
 const f=fixture();f.reply=()=>{assert.equal(JSON.parse(f.values.get(cacheOperationStorageKey('alice')))[0].request.key,f.api.snapshot().request.key);return f.receipt({bytes:1,totalBytes:4});};
 await f.api.start();assert.deepEqual(f.api.snapshot().progress,{bytes:1,totalBytes:4});
 const request=f.api.snapshot().request;await f.api.start();assert.equal(f.requests.filter(r=>r.operation==='datasets.cache.prepare').length,1);
 f.reply=f.receipt({bytes:1});await f.api.query();assert.equal(f.api.snapshot().progress,null);
 assert.deepEqual(f.requests.at(-1).args,{operationId});assert.equal(f.api.snapshot().request.key,request.key);
 f.reply=f.receipt({bytes:8,totalBytes:4});await f.api.query();assert.equal(f.api.snapshot().progress,null);
});
test('initial lost receipt and restart cannot create another operation or derive an ID from key',async()=>{
 const f=fixture();f.reply=()=>{throw Error('lost receipt');};await f.api.start();const request=f.api.snapshot().request;
 assert.equal(f.api.snapshot().state,'UNKNOWN');assert.equal(f.api.snapshot().operationId,null);await f.api.query();await f.api.start();
 assert.equal(f.requests.length,2);f.api.destroy();f.api=f.mount();assert.deepEqual(f.api.snapshot().request,request);
 await f.api.start();assert.equal(f.requests.length,2);
 f.reply=()=>f.receipt({state:'READY',phase:'READY',canCancel:false});await f.api.query(operationId);
 assert.deepEqual(f.requests.at(-1).args,{operationId});assert.equal(f.api.snapshot().state,'READY');assert.equal(f.timer,null);
});
test('partial first response preserves original operation ID; lost status only re-queries that ID',async()=>{
 const f=fixture();f.reply={operationId};await f.api.start();assert.equal(f.api.snapshot().state,'UNKNOWN');assert.equal(f.api.snapshot().operationId,operationId);
 f.reply=()=>{throw Error('read failed');};await f.api.query();assert.equal(f.api.snapshot().canCancel,false);
 f.reply=()=>f.receipt({state:'READY',phase:'READY',canCancel:false});await f.api.query();
 assert.equal(f.requests.filter(r=>r.operation==='datasets.cache.prepare').length,1);
 assert(f.requests.filter(r=>r.operation==='datasets.cache.status').every(r=>Object.keys(r.args).join()==='operationId'&&r.args.operationId===operationId));
});
test('phase is not completion; wrong target/key/action cannot report READY or RELEASED',async()=>{
 const f=fixture();f.reply=()=>f.receipt({phase:'READY'});await f.api.start();assert.equal(f.api.snapshot().state,'RUNNING');
 for(const change of [{machine:'other'},{dataset:'other'},{version:'b'.repeat(64)},{key:'20000000-0000-4000-8000-000000000001'},{action:'release',state:'RELEASED'}]){
  f.reply=()=>f.receipt({state:'READY',phase:'READY',...change});await f.api.query();assert.equal(f.api.snapshot().state,'UNKNOWN');assert.equal(f.api.snapshot().confirmed,false);
 }
 assert.throws(()=>cacheOperationReceipt({...scope,key:'00000000-0000-4000-8000-000000000001'},{}));
});
test('blocked release displays exact server reason and never calls unregister, evict or release',async()=>{
 const f=fixture({action:'release'});f.cap={protocol:1,prepare:false,release:false,reason:'读取租约尚未结束 · 迁移保护'};await f.api.start();
 assert.equal(f.api.snapshot().error,f.cap.reason);assert.equal(f.api.snapshot().allowed,false);
 assert.deepEqual(f.requests.map(r=>r.operation),['datasets.cache.capabilities']);
});
test('old operation or missing capability fails closed before any write',async()=>{
 const f=fixture();f.cap=()=>{throw Object.assign(Error('unknown operation'),{status:404});};await f.api.start();assert.equal(f.api.snapshot().visible,false);assert.equal(f.values.size,0);
 const g=fixture();g.cap={protocol:'simulated-contract'};await g.api.start();assert.equal(g.api.snapshot().visible,false);assert.equal(g.requests.length,1);assert.equal(g.values.size,0);
});
test('failed persistence is zero dispatch; account change and abort ignore delayed responses',async()=>{
 const f=fixture();f.failSave=true;await f.api.start();assert.equal(f.requests.filter(r=>r.operation==='datasets.cache.prepare').length,0);
 const g=fixture();let resolve;g.reply=()=>new Promise(done=>resolve=done);const pending=g.api.start();await new Promise(done=>setImmediate(done));
 g.store.principal.userId='bob';g.store.authGeneration++;resolve({...scope,key:'00000000-0000-4000-8000-000000000001',operationId,state:'READY',phase:'READY',canCancel:false});await pending;
 assert.equal(g.api.snapshot().visible,false);assert.equal(g.values.has(cacheOperationStorageKey('bob')),false);g.api.destroy();assert.equal(g.timer,null);
});
test('cancel uses original ID and remains in progress until authoritative terminal reply',async()=>{
 const f=fixture({action:'release'});await f.api.start();f.reply=()=>f.receipt({state:'CANCELING',phase:'STOPPING',canCancel:false});await f.api.cancel();
 assert.equal(f.api.snapshot().state,'CANCELING');assert.equal(f.api.snapshot().canCancel,false);assert.deepEqual(f.requests.at(-1),{operation:'datasets.cache.cancel',args:{operationId},account:'alice'});
 await f.api.cancel();assert.equal(f.requests.filter(r=>r.operation==='datasets.cache.cancel').length,1);
 f.reply=()=>f.receipt({state:'CANCELED',phase:'STOPPED',canCancel:false});await f.api.query();assert.equal(f.api.snapshot().state,'CANCELED');assert.equal(f.timer,null);
});
test('prepare never offers cancellation of a shared worker, even with an inconsistent receipt',async()=>{
 const f=fixture();await f.api.start();assert.equal(f.api.snapshot().canCancel,false);await f.api.cancel();
 assert.equal(f.requests.filter(row=>row.operation==='datasets.cache.cancel').length,0);f.api.destroy();
});
test('concurrent same-target views reuse pending intent; UNKNOWN never enables retry',async()=>{
 const f=fixture(),other=f.mount();await Promise.all([f.api.start(),other.start()]);assert.equal(f.requests.filter(r=>r.operation==='datasets.cache.prepare').length,1);
 assert.equal(other.snapshot().request.key,f.api.snapshot().request.key);assert.equal(other.snapshot().state,'UNKNOWN');other.destroy();f.api.destroy();
});
test('permission denial and hidden room stop polling without fallback or replay',async()=>{
 const f=fixture();await f.api.start();f.active=false;f.api.sync();assert.equal(f.timer,null);
 f.active=true;f.reply=()=>{throw Object.assign(Error('权限已撤销'),{status:403});};await f.api.query();assert.equal(f.timer,null);
 assert.equal(f.api.snapshot().error,'权限已撤销');assert.deepEqual(f.requests.at(-1).args,{operationId});assert.equal(f.requests.length,3);
});
test('blocked capability can be rechecked without a write; canceled host ignores late reply',async()=>{
 const f=fixture({action:'release'});f.cap={protocol:1,prepare:false,release:false,reason:'读取租约'};await f.api.start();f.cap={protocol:1,prepare:true,release:true};assert.equal(await f.api.check(),true);
 assert(f.requests.every(row=>row.operation==='datasets.cache.capabilities'));
 const g=fixture();let complete;g.reply=()=>new Promise(resolve=>complete=resolve);const pending=g.api.start();await new Promise(resolve=>setImmediate(resolve));g.api.destroy();
 complete({...scope,key:'00000000-0000-4000-8000-000000000001',operationId,state:'READY',phase:'READY',canCancel:false});await pending;
 assert.equal(g.api.snapshot().visible,false);assert.equal(g.timer,null);
});
test('release is not complete until a matching RELEASED receipt, never a prepare READY',async()=>{
 const f=fixture({action:'release'});f.reply=()=>f.receipt({state:'RELEASING',phase:'RELEASING'});await f.api.start();
 assert.equal(f.api.snapshot().state,'RELEASING');f.reply=()=>f.receipt({state:'READY',phase:'READY'});await f.api.query();assert.equal(f.api.snapshot().state,'UNKNOWN');
 f.reply=()=>f.receipt({state:'RELEASED',phase:'RELEASED',canCancel:false});await f.api.query();assert.equal(f.api.snapshot().state,'RELEASED');assert.equal(f.api.snapshot().confirmed,true);assert.equal(f.timer,null);
});
test('only confirmed failure permits explicit new key, preserving both operation records',async()=>{
 const f=fixture();f.reply=()=>f.receipt({state:'FAILED',phase:'STOPPED',canCancel:false,error:'server failure'});await f.api.start();const key=f.api.snapshot().request.key;
 assert.equal(f.api.snapshot().canStart,true);await f.api.start();assert.notEqual(f.api.snapshot().request.key,key);assert.equal(f.requests.filter(row=>row.operation==='datasets.cache.prepare').length,2);
 const rows=JSON.parse(f.values.get(cacheOperationStorageKey('alice')));assert.equal(rows.length,2);assert.equal(rows[0].request.key,key);
});
test('missing inventory or dataset cannot become a string-coerced target or initiate a request',()=>{
 const f=fixture();for(const change of [{machine:undefined},{dataset:undefined},{machine:1},{dataset:null},{version:undefined}])assert.throws(()=>createCacheOperation({...scope,...change,store:f.store,capabilities:{protocol:1,prepare:true,release:true}}));
 assert.equal(f.requests.length,0);
});
