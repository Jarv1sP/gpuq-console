import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const VERSION='a'.repeat(64),password='Storage-Fixture-Password-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-storage-http-')),bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin=`http://127.0.0.1:${port}`,calls=[];let failure=null;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(failure)throw failure;
    if(operation.endsWith('.status'))return {enabled:false,scope:'datasets-only',automaticCollectionExposed:false};
    if(operation.endsWith('.plan'))return {enabled:false,dryRun:true,candidates:[],reservedBytes:args.neededBytes||0};
    if(operation.endsWith('.pin'))return {pinned:true,pinId:args.pinId};
    if(operation.endsWith('.unpin'))return {unpinned:true};
    throw Error('Unexpected storage operation');
  };
  const {server,service}=await createPortalServer({database:join(dir,'database'),bootstrap,statusPath,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const post=async(path,body,token,extra={})=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  const admin=(await post('/api/login',{username:'admin',password})).data;
  const call=(operation,args={},token=admin.token,headers={})=>post('/api/call',{operation,args},token,headers);
  const user=(await call('users.create',{username:'storage-member',password})).data.result;
  await call('policy.full',{userId:user.id,policyVersion:0});
  const member=(await post('/api/login',{username:'storage-member',password})).data;
  return {service,admin,member,calls,call,post,origin,fail:value=>failure=value};
}

test('real HTTP storage requires current admin even for a fully granted member',async t=>{
  const f=await fixture(t);
  for(const action of ['status','plan','pin','unpin']){
    const args={machine:'gpu-1',...(['pin','unpin'].includes(action)?{dataset:'sample',version:VERSION,pinId:'manual-job'}:{})};
    assert.equal((await f.call('datasets.storage.'+action,args,f.member.token)).status,403);
    assert.equal((await f.call('datasets.storage.'+action,args,'0'.repeat(64))).status,401);
  }
  assert.equal(f.calls.length,0);
});

test('real HTTP status and dry-run plan only forward trusted server identity and never deletion',async t=>{
  const f=await fixture(t),beforeJobs=f.service.store.jobs.length;
  for(const args of [{machine:'gpu-1'},{machine:'gpu-2',dataset:'sample',version:VERSION},{machine:'gpu-2',dataset:'sample',version:VERSION,pinId:'manual-own'}]){
    const out=await f.call('datasets.storage.status',args);assert.equal(out.status,200);
    assert.equal(out.data.result.enabled,false);
    const {machine,...request}=args;
    assert.deepEqual(f.calls.at(-1),{machine,operation:'datasets.storage.status',args:{...request,userId:'builtin-admin',hostAdmin:true}});
  }
  const result=await f.call('datasets.storage.plan',{machine:'gpu-1',neededBytes:123});
  assert.equal(result.status,200);assert.equal(result.data.result.dryRun,true);assert.equal(result.data.result.reservedBytes,123);
  assert.ok(f.calls.every(c=>['datasets.storage.status','datasets.storage.plan'].includes(c.operation)));
  assert.equal(f.service.store.jobs.length,beforeJobs);
});

test('real HTTP pin and unpin are audited and cannot touch authority retention',async t=>{
  const f=await fixture(t),base={machine:'gpu-1',dataset:'sample',version:VERSION,pinId:'manual-job'};
  for(const action of ['pin','unpin','status']){
    const out=await f.call('datasets.storage.'+action,base);assert.equal(out.status,200);
    assert.deepEqual(f.calls.at(-1),{machine:'gpu-1',operation:'datasets.storage.'+action,args:{dataset:'sample',version:VERSION,pinId:'manual-job',userId:'builtin-admin',hostAdmin:true}});
    const count=f.calls.length;
    for(const pinId of ['authority-retained','../bad','a/b','a:b','','x'.repeat(65),null,{}])assert.equal((await f.call('datasets.storage.'+action,{...base,pinId})).status,400);
    assert.equal(f.calls.length,count);
  }
  const audit=f.service.db.prepare("SELECT operation FROM audit WHERE operation LIKE 'datasets.storage.%'").all();
  assert.deepEqual(audit.map(a=>a.operation),['datasets.storage.pin','datasets.storage.unpin']);
});

test('real HTTP refuses identity role path proof source and collection injection before bridge',async t=>{
  const f=await fixture(t);
  for(const [key,value] of Object.entries({userId:'demo-user-1',hostAdmin:true,role:'admin',actor:{is_admin:true},owners:['other'],path:'/private/data',root:'/data1',sourceId:'source',proof:{verified:true},authorityId:'hdd',op:'collect',dryRun:false,enabled:true,force:true})){
    const out=await f.call('datasets.storage.status',{machine:'gpu-1',[key]:value});assert.equal(out.status,400,key);
  }
  for(const action of ['collect','recover','enable','verify','constructor','toString','__proto__']){
    assert.equal((await f.call('datasets.storage.'+action,{machine:'gpu-1'})).status,400,action);
  }
  assert.equal(f.calls.length,0);
});

test('real HTTP validates references machine grants and reservation types',async t=>{
  const f=await fixture(t);
  for(const args of [{machine:'auto'},{machine:'missing'},{},{machine:'gpu-1',dataset:'sample'},
    {machine:'gpu-1',version:VERSION},{machine:'gpu-1',dataset:'../sample',version:VERSION},
    {machine:'gpu-1',dataset:'sample',version:'latest'},{machine:'gpu-1',dataset:'sample',version:VERSION.toUpperCase()}]){
    assert.ok((await f.call('datasets.storage.status',args)).status>=400);
  }
  for(const neededBytes of [-1,1.2,'12',true,null,Number.MAX_SAFE_INTEGER+1])assert.equal((await f.call('datasets.storage.plan',{machine:'gpu-1',neededBytes})).status,400);
  assert.equal(f.calls.length,0);
});

test('browser cookie requests require same-origin and public storage calls accept no request identity',async t=>{
  const f=await fixture(t);
  const login=await f.post('/api/login',{username:'admin',password,client:'browser'},null,{Origin:f.origin});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const body={operation:'datasets.storage.status',args:{machine:'gpu-1'}};
  assert.equal((await f.post('/api/call',body,null,{Cookie:cookie})).status,403);
  assert.equal((await f.post('/api/call',body,null,{Cookie:cookie,Origin:'http://untrusted.invalid'})).status,403);
  assert.equal((await f.post('/api/call',body,null,{Cookie:cookie,Origin:f.origin})).status,200);
  assert.equal(f.calls.length,1);
});

test('pin requires durable audit before bridge and ambiguous bridge errors never trigger fallback deletion',async t=>{
  const f=await fixture(t),base={machine:'gpu-1',dataset:'sample',version:VERSION,pinId:'manual-job'},audit=f.service.audit;
  f.service.audit=()=>{throw Error('fixture audit unavailable');};
  assert.equal((await f.call('datasets.storage.pin',base)).status,400);assert.equal(f.calls.length,0);
  f.service.audit=audit;f.fail(Error('fixture bridge timeout'));
  assert.equal((await f.call('datasets.storage.pin',base)).status,400);
  assert.deepEqual(f.calls.map(c=>c.operation),['datasets.storage.pin']);
});
