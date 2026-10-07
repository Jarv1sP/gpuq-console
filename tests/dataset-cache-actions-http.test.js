import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id,version='a'.repeat(64),ref={machine,dataset:'sample',version};
const password='Cache-Fixture-Password-2026!';
function deferred(){let resolve;const promise=new Promise(value=>resolve=value);return {promise,resolve};}
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('fixture did not reach bounded wait point');}

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-cache-http-')),bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(value=>({id:value.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin=`http://127.0.0.1:${port}`,f={calls:[],native:new Map(),intercept:null,memberId:null};
  const bridge=async(target,operation,args)=>{
    f.calls.push({machine:target,operation,args:structuredClone(args)});
    if(f.intercept){const result=await f.intercept(target,operation,args);if(result!==undefined)return result;}
    if(operation==='datasets.list')return {datasets:target===machine?[{dataset:'sample',ownerIds:[f.memberId],versions:[{version,state:'REGISTERED',warehouseReady:true,warehouseCanPrepare:true}]}]:[]};
    if(operation==='datasets.status')return {dataset:args.dataset,version:args.version,state:'REGISTERED',warehouseReady:true,warehouseCanPrepare:true};
    if(operation==='storage.cache-action.capabilities')return {protocol:1,prepare:true,release:true,prepareCancel:false,releaseCancel:true};
    if(['storage.cache-action.prepare','storage.cache-action.release'].includes(operation)){
      const result={key:args.key,dataset:args.dataset,version:args.version,state:'RUNNING',phase:'RUNNING'};
      f.native.set(args.key,result);return structuredClone(result);
    }
    if(operation==='storage.cache-action.status')return structuredClone(f.native.get(args.key));
    if(operation==='storage.cache-action.cancel'){
      const result=f.native.get(args.key);result.state=result.phase='CANCELED';return structuredClone(result);
    }
    throw Error('Unexpected isolated bridge operation '+operation);
  };
  const {server,service}=await createPortalServer({database:join(dir,'database'),bootstrap,statusPath,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);clearInterval(service.archiveTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const post=async(path,body,token,extra={})=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  const admin=(await post('/api/login',{username:'admin',password})).data;
  const call=(operation,args={},token=admin.token,headers={})=>post('/api/call',{operation,args},token,headers);
  const created=await call('users.create',{username:'cache-member',password});assert.equal(created.status,200);
  const user=created.data.result;f.memberId=user.id;
  assert.equal((await call('policy.full',{userId:user.id,policyVersion:0})).status,200);
  const member=(await post('/api/login',{username:'cache-member',password})).data;
  Object.assign(f,{service,admin,member,call,post,origin});
  f.cache=(operation,args={},token=member.token,headers={})=>call('datasets.cache.'+operation,args,token,headers);
  f.start=(action='release',key=randomUUID())=>f.cache(action,{...ref,key});
  f.row=id=>JSON.parse(service.db.prepare('SELECT data FROM dataset_cache_actions WHERE id=?').get(id).data);
  return f;
}

test('actual Portal routes all five cache methods with server identity and no job dispatch',async t=>{
  const f=await fixture(t),jobs=f.service.store.jobs.length;
  const caps=await f.cache('capabilities',ref);assert.equal(caps.status,200);assert.equal(caps.data.result.protocol,1);
  const prepared=await f.start('prepare');assert.equal(prepared.status,200);assert.equal(prepared.data.result.canCancel,false);
  const preparedCancel=await f.cache('cancel',{operationId:prepared.data.result.operationId});
  assert.equal(preparedCancel.status,200);assert.equal(preparedCancel.data.result.errorCode,'CACHE_SHARED_WORKER');
  const release=await f.start();assert.equal(release.status,200);assert.equal(release.data.result.state,'RUNNING');
  assert.equal((await f.cache('status',{operationId:release.data.result.operationId})).status,200);
  const canceled=await f.cache('cancel',{operationId:release.data.result.operationId});assert.equal(canceled.status,200);assert.equal(canceled.data.result.state,'CANCELED');
  assert.equal(canceled.data.result.receiptOnly,true);
  assert.ok(f.calls.filter(value=>value.operation.startsWith('storage.cache-action.')).every(value=>value.args.userId===f.memberId&&value.args.hostAdmin===false));
  assert.equal(f.service.store.jobs.length,jobs);
});

test('actual HTTP rejects missing/revoked token, zero grants and injected identity before node writes',async t=>{
  const f=await fixture(t),baseline=f.calls.length;
  assert.equal((await f.cache('prepare',{...ref,key:randomUUID()},'0'.repeat(64))).status,401);
  for(const [key,value] of Object.entries({owner:'other',userId:'other',hostAdmin:true,path:'/unsafe',source:'node',disk:'hdd',proof:{}}))
    assert.equal((await f.cache('release',{...ref,key:randomUUID(),[key]:value})).status,400,key);
  assert.equal(f.calls.length,baseline);
  f.service.revokeSession(f.member.token);
  assert.equal((await f.cache('capabilities',ref)).status,401);
  const member=(await f.post('/api/login',{username:'cache-member',password})).data;
  const current=f.service.store.users.find(value=>value.id===f.memberId);current.limits[machine]=0;f.service.save();
  assert.equal((await f.cache('release',{...ref,key:randomUUID()},member.token)).status,403);
  assert.equal(f.calls.length,baseline);
});

test('actual cookie route requires same-origin CSRF protection before cache dispatch',async t=>{
  const f=await fixture(t),login=await f.post('/api/login',{username:'cache-member',password,client:'browser'},null,{Origin:f.origin});
  const cookie=login.headers.get('set-cookie').split(';')[0],body={operation:'datasets.cache.capabilities',args:ref};
  assert.equal((await f.post('/api/call',body,null,{Cookie:cookie})).status,403);
  assert.equal((await f.post('/api/call',body,null,{Cookie:cookie,Origin:'http://untrusted.invalid'})).status,403);
  assert.equal(f.calls.length,0);
  assert.equal((await f.post('/api/call',body,null,{Cookie:cookie,Origin:f.origin})).status,200);
});

test('token revocation during native status rejects delayed receipt without overwriting durable state',async t=>{
  const f=await fixture(t),start=await f.start(),row=start.data.result,waiting=deferred(),arrived=deferred();
  f.intercept=async(_target,operation,args)=>{
    if(operation==='storage.cache-action.status'){arrived.resolve();await waiting.promise;return {...f.native.get(args.key),state:'RELEASED'};}
  };
  const request=f.cache('status',{operationId:row.operationId});await arrived.promise;
  f.service.revokeSession(f.member.token);waiting.resolve();
  assert.equal((await request).status,401);
  assert.equal(f.row(row.operationId).state,'RUNNING');
});

test('maintenance blocks new prepare/release but keeps capability/status/cancel available',async t=>{
  const f=await fixture(t),start=await f.start(),row=start.data.result;
  const maintenance=await f.call('maintenance.set',{scope:'all',enabled:true,reason:'isolated cache fixture maintenance',revision:0});assert.equal(maintenance.status,200);
  const before=f.calls.length;
  for(const action of ['prepare','release'])assert.equal((await f.start(action)).status,503);
  assert.equal(f.calls.length,before);
  const caps=await f.cache('capabilities',ref);assert.equal(caps.status,200);assert.equal(caps.data.result.protocol,1);
  const observed=await f.cache('status',{operationId:row.operationId});assert.equal(observed.status,200);assert.equal(observed.data.result.state,'RUNNING');
  assert.equal((await f.cache('cancel',{operationId:row.operationId})).data.result.state,'CANCELED');
});

test('actual dataset lane admits four reads, rejects fifth without I/O and does not block account state',async t=>{
  const f=await fixture(t),start=await f.start(),row=start.data.result,waiting=deferred();let held=0;
  f.intercept=async(_target,operation,args)=>{
    if(operation==='storage.cache-action.status'){held++;await waiting.promise;return structuredClone(f.native.get(args.key));}
  };
  const pending=Array.from({length:4},()=>f.cache('status',{operationId:row.operationId}));
  try{
    await until(()=>held===4);assert.equal(f.service.datasetReadPending,4);
    const before=f.calls.length;
    assert.equal((await f.cache('capabilities',ref)).status,429);assert.equal(f.calls.length,before);
    assert.equal((await f.call('state',{},f.member.token)).status,200);
  }finally{waiting.resolve();}
  assert.ok((await Promise.all(pending)).every(value=>value.status===200));
  assert.equal(f.service.datasetReadPending,0);
});

test('a delayed status cannot overwrite a durably confirmed canceled release',async t=>{
  const f=await fixture(t),start=await f.start(),row=start.data.result,waiting=deferred(),arrived=deferred();
  f.intercept=async(_target,operation,args)=>{
    if(operation==='storage.cache-action.status'){const stale=structuredClone(f.native.get(args.key));arrived.resolve();await waiting.promise;return stale;}
  };
  const request=f.cache('status',{operationId:row.operationId});await arrived.promise;
  try{
    const canceled=await f.cache('cancel',{operationId:row.operationId});assert.equal(canceled.status,200);assert.equal(canceled.data.result.state,'CANCELED');
  }finally{waiting.resolve();}
  const observed=await request;assert.equal(observed.status,200);assert.equal(observed.data.result.state,'CANCELED');
  assert.equal(f.row(row.operationId).state,'CANCELED');assert.equal(f.row(row.operationId).canCancel,false);
});

test('a delayed first dispatch ACK cannot leak old state after same-key confirmed cancel',async t=>{
  const f=await fixture(t),key=randomUUID(),waiting=deferred(),arrived=deferred();
  f.intercept=async(_target,operation,args)=>{
    if(operation==='storage.cache-action.release'){
      const stale={key:args.key,dataset:args.dataset,version:args.version,state:'RUNNING',phase:'RUNNING'};
      f.native.set(args.key,structuredClone(stale));arrived.resolve();await waiting.promise;return stale;
    }
  };
  const start=f.start('release',key);await arrived.promise;
  try{
    const canceled=await f.cache('cancel',{key});assert.equal(canceled.status,200);assert.equal(canceled.data.result.state,'CANCELED');
  }finally{waiting.resolve();}
  const result=await start;assert.equal(result.status,200);assert.equal(result.data.result.state,'CANCELED');
  assert.equal(result.data.result.canCancel,false);assert.equal(f.row(result.data.result.operationId).state,'CANCELED');
});
