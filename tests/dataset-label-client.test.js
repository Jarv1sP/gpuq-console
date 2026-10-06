import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetLabelClient,normalizeDatasetDisplayName} from '../dist/dataset-label-client.js';
const target={machine:'training-node',dataset:'logical-data'};
const response=(extra={})=>({dataset:'logical-data',ownerId:'demo-user-1',scope:'personal',name:'中文训练集',displayName:'中文训练集',revision:3,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(implementation){
  let actor={userId:'demo-user-1',role:'member',authGeneration:1};const calls=[];
  const client=datasetLabelClient({identity:()=>actor,call:async(operation,args)=>{calls.push({operation,args});return implementation(operation,args,calls);}});
  return {client,calls,actor:value=>{actor=value;}};
}

test('GET binds personal owner/revision; explicit SET uses canonical ID and exact CAS then requires a fresh GET for another edit',async()=>{
  const f=fixture((op,args)=>op.endsWith('.get')?response():response({displayName:args.displayName,name:args.displayName,revision:4}));
  const label=await f.client.get(target);assert.equal(label.revision,3);assert.equal(Object.isFrozen(label),true);
  const result=await f.client.set(label,'  新名称  ');assert.equal(result.status,'SAVED');assert.equal(result.label.name,'新名称');
  assert.deepEqual(f.calls,[{operation:'datasets.label.get',args:target},{operation:'datasets.label.set',args:{...target,displayName:'新名称',revision:3}}]);
  await assert.rejects(f.client.set(label,'重复'),{code:'LABEL_READ_REQUIRED'});
  await assert.rejects(f.client.set(result.label,'继续修改'),{code:'LABEL_READ_REQUIRED'});assert.equal(f.calls.length,2);
});

test('server-returned logical alias becomes SET target, never a guessed ID prefix or mount name',async()=>{
  const f=fixture((op,args)=>op.endsWith('.get')?response():response({name:args.displayName,displayName:args.displayName,revision:4}));
  const label=await f.client.get({...target,dataset:'physical-copy'});await f.client.set(label,'副本显示名');
  assert.equal(f.calls[0].args.dataset,'physical-copy');assert.equal(f.calls[1].args.dataset,'logical-data');
});

test('409 performs exactly one GET and returns a conflict; no automatic overwrite, user may explicitly save the new snapshot',async()=>{
  let read=0,write=0;const f=fixture((op,args)=>{
    if(op.endsWith('.get'))return ++read===1?response():response({revision:4,name:'别处的新名称',displayName:'别处的新名称'});
    if(++write===1)throw Object.assign(Error('changed'),{status:409});
    return response({revision:5,name:args.displayName,displayName:args.displayName});
  });
  const label=await f.client.get(target),conflict=await f.client.set(label,'我的草稿');
  assert.equal(conflict.status,'CONFLICT');assert.equal(conflict.label.name,'别处的新名称');assert.equal(conflict.label.revision,4);assert.equal(conflict.attemptedName,'我的草稿');
  assert.deepEqual(f.calls.map(row=>row.operation),['datasets.label.get','datasets.label.set','datasets.label.get']);
  await assert.rejects(f.client.set(label,'旧快照'),{code:'LABEL_READ_REQUIRED'});
  assert.equal((await f.client.set(conflict.label,'重新确认的名称')).status,'SAVED');assert.equal(f.calls[3].args.revision,4);
});

test('failed conflict refresh leaves no usable revision or success and never performs another SET',async()=>{
  let reads=0;const unavailable=Object.assign(Error('unavailable'),{status:503});
  const f=fixture(op=>{if(op.endsWith('.get')){if(++reads>1)throw unavailable;return response();}throw Object.assign(Error('conflict'),{status:409});});
  const label=await f.client.get(target),result=await f.client.set(label,'保留草稿');
  assert.equal(result.status,'CONFLICT');assert.equal(result.label,null);assert.equal(result.refreshError,unavailable);assert.equal(result.attemptedName,'保留草稿');
  await assert.rejects(f.client.set(label,'不能覆盖'),{code:'LABEL_READ_REQUIRED'});assert.equal(f.calls.length,3);
});

test('lost ACK, failure or 409-like text without HTTP 409 does not auto-read or retry; old revision is consumed',async()=>{
  for(const error of [Error('network disconnected'),Object.assign(Error('unavailable'),{status:503}),Object.assign(Error('forbidden'),{status:403}),Error('409 conflict text only')]){
    const f=fixture(op=>{if(op.endsWith('.get'))return response();throw error;});
    const label=await f.client.get(target);await assert.rejects(f.client.set(label,'草稿'),value=>value===error);
    assert.equal(f.calls.length,2);await assert.rejects(f.client.set(label,'再次发送'),{code:'LABEL_READ_REQUIRED'});assert.equal(f.calls.length,2);
  }
});

test('malformed GET/SET replies, wrong owner, non-personal scope and unexpected revision never grant a writable snapshot or saved result',async()=>{
  for(const change of [{ownerId:'demo-user-2'},{scope:'shared'},{revision:-1},{revision:1.5},{revision:Number.MAX_SAFE_INTEGER},{dataset:'../data'},{name:'wrong'},{displayName:undefined}]){
    const f=fixture(()=>response(change));await assert.rejects(f.client.get(target),{code:'LABEL_UNCONFIRMED'});assert.equal(f.calls.length,1);
  }
  for(const change of [{revision:3},{revision:5},{dataset:'another-data'},{ownerId:'demo-user-2'},{name:'unconfirmed',displayName:'unconfirmed'}]){
    const f=fixture(op=>op.endsWith('.get')?response():response({revision:4,name:'已填写',displayName:'已填写',...change}));
    const label=await f.client.get(target);await assert.rejects(f.client.set(label,'已填写'),{code:'LABEL_UNCONFIRMED'});
    await assert.rejects(f.client.set(label,'重发'),{code:'LABEL_READ_REQUIRED'});
  }
});

test('revision zero with no personal label is valid, fabricated or cloned snapshots are not',async()=>{
  const f=fixture(op=>op.endsWith('.get')?response({displayName:null,name:'logical-data',revision:0}):response({name:'首个名称',displayName:'首个名称',revision:1}));
  const label=await f.client.get(target);assert.equal(label.displayName,null);
  await assert.rejects(f.client.set({...label},'伪造读取'),{code:'LABEL_READ_REQUIRED'});
  await assert.rejects(f.client.set({...target,revision:0},'猜测版本'),{code:'LABEL_READ_REQUIRED'});
  const result=await f.client.set(label,'首个名称');assert.equal(result.status,'SAVED');assert.equal(f.calls[1].args.revision,0);
});

test('account change during GET drops the reply; switching back with a new generation cannot reuse old snapshots',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.client.get(target);
  f.actor({userId:'demo-user-2',role:'member',authGeneration:2});wait.resolve(response());await assert.rejects(pending,{code:'LABEL_IDENTITY_CHANGED'});
  const g=fixture(()=>response()),label=await g.client.get(target);
  g.actor({userId:'demo-user-2',role:'member',authGeneration:2});await assert.rejects(g.client.set(label,'越界'),{code:'LABEL_IDENTITY_CHANGED'});
  g.actor({userId:'demo-user-1',role:'member',authGeneration:3});await assert.rejects(g.client.set(label,'旧登录'),{code:'LABEL_IDENTITY_CHANGED'});assert.equal(g.calls.length,1);
});

test('account change during SET or conflict refresh cannot surface another account name or a saved result',async()=>{
  for(const conflict of [false,true]){
    const wait=deferred();let reads=0;const f=fixture(op=>{
      if(op.endsWith('.get'))return ++reads===1?response():wait.promise;
      if(conflict)throw Object.assign(Error('changed'),{status:409});return wait.promise;
    });
    const label=await f.client.get(target),pending=f.client.set(label,'旧账号草稿');
    if(conflict){while(f.calls.length<3)await new Promise(resolve=>setImmediate(resolve));}
    f.actor({userId:'demo-user-2',role:'member',authGeneration:2});wait.resolve(response({revision:4,name:'旧账号草稿',displayName:'旧账号草稿'}));
    await assert.rejects(pending,{code:'LABEL_IDENTITY_CHANGED'});assert.equal(f.calls.length,conflict?3:2);
  }
});

test('parallel reads reject late stale snapshots; parallel writes send only the first explicit intent',async()=>{
  const waits=[deferred(),deferred()];let read=0;const f=fixture(()=>waits[read++].promise);
  const first=f.client.get(target),second=f.client.get(target);waits[1].resolve(response({revision:4}));const latest=await second;
  waits[0].resolve(response());await assert.rejects(first,{code:'LABEL_STALE_READ'});assert.equal(latest.revision,4);
  const write=deferred(),g=fixture(op=>op.endsWith('.get')?response():write.promise),label=await g.client.get(target),pending=g.client.set(label,'一次保存');
  await assert.rejects(g.client.set(label,'第二次保存'),{code:'LABEL_BUSY'});assert.equal(g.calls.length,2);
  write.resolve(response({revision:4,name:'一次保存',displayName:'一次保存'}));assert.equal((await pending).status,'SAVED');
});

test('explicit admin delegation preserves ownerId; members cannot specify another owner, no user/role/path is sent',async()=>{
  const f=fixture(()=>response());await assert.rejects(f.client.get({...target,ownerId:'demo-user-2'}),{code:'LABEL_OWNER_MISMATCH'});assert.equal(f.calls.length,0);
  const g=fixture((op,args)=>op.endsWith('.get')?response({ownerId:'demo-user-2'}):response({ownerId:'demo-user-2',revision:4,name:args.displayName,displayName:args.displayName}));
  g.actor({userId:'builtin-admin',role:'admin',authGeneration:1});const label=await g.client.get({...target,ownerId:'demo-user-2'});await g.client.set(label,'代管名称');
  assert.deepEqual(g.calls[1].args,{...target,ownerId:'demo-user-2',displayName:'代管名称',revision:3});
});

test('reset invalidates snapshots and in-flight queries without writes or persistence',async()=>{
  const f=fixture(()=>response()),label=await f.client.get(target);f.client.reset();await assert.rejects(f.client.set(label,'旧状态'),{code:'LABEL_IDENTITY_CHANGED'});assert.equal(f.calls.length,1);
  const wait=deferred(),g=fixture(()=>wait.promise),pending=g.client.get(target);g.client.reset();wait.resolve(response());await assert.rejects(pending,{code:'LABEL_IDENTITY_CHANGED'});assert.equal(g.calls.length,1);
});

test('names use the backend visible-code-point and NFC rules; invalid input never sends SET',async()=>{
  assert.equal(normalizeDatasetDisplayName('  e\u0301 中文  '),'é 中文');assert.equal([...normalizeDatasetDisplayName('💡'.repeat(80))].length,80);
  for(const value of ['',null,'a'.repeat(81),'a\nb','a\u0000b','a\u200bb'])assert.throws(()=>normalizeDatasetDisplayName(value),{code:'LABEL_NAME_INVALID'});
  const f=fixture(()=>response()),label=await f.client.get(target);await assert.rejects(f.client.set(label,'\n'),{code:'LABEL_NAME_INVALID'});assert.equal(f.calls.length,1);
});
