import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const password='Read-Overview-Local-Fixture-2026!';
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'dataset-overview-http-')),bootstrap=join(directory,'bootstrap.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port,calls=[];
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args});
    if(operation==='datasets.list')return {datasets:[]};
    assert.equal(operation,'datasets.capacity');
    const volume={filesystemBytes:1000,usedBytes:300,availableBytes:650,reserveBytes:50,usableBytes:600,volumeDeviceId:'a'.repeat(64),checkedAt:'2026-01-01T00:00:00Z',readOnly:false,guarded:true};
    return {...volume,storageOverview:{protocol:'dataset-storage-node-v1',cache:{volume,budgetBytes:400},warehouse:null}};
  };
  const {server,service}=await createPortalServer({database:join(directory,'database'),bootstrap,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const post=async(path,body,token,extra={})=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  const admin=(await post('/api/login',{username:'admin',password})).data;
  const call=(operation,args={},token=admin.token,extra={})=>post('/api/call',{operation,args},token,extra);
  await call('users.create',{username:'overview-member',password});
  const member=(await post('/api/login',{username:'overview-member',password})).data;
  return {service,admin,member,calls,call,post,origin};
}

test('authenticated HTTP overview routes compact metadata for zero-quota member, preserves capacity/file permissions',async t=>{
  const f=await fixture(t),beforeJobs=f.service.store.jobs.length;
  const result=await f.call('datasets.overview',{},f.member.token);
  assert.equal(result.status,200);assert.equal(result.data.result.protocol,'dataset-storage-overview-v1');
  assert.equal(result.data.result.warehouse.state,'NOT_CONFIGURED');
  assert.equal(result.data.state,undefined);assert.equal(result.data.result.filePreviewAvailable,false);
  assert.equal(result.data.result.caches.length,MACHINES.length);
  assert.equal(f.calls.length,MACHINES.length*2);
  assert.ok(f.calls.every(call=>['datasets.list','datasets.capacity'].includes(call.operation)&&call.args.hostAdmin===true&&call.args.userId==='builtin-admin'));
  assert.equal((await f.call('datasets.capacity',{machine:MACHINES[0].id},f.member.token)).status,403);
  assert.equal((await f.call('datasets.snapshot.manifest',{machine:MACHINES[0].id,dataset:'private',version:'a'.repeat(64)},f.member.token)).status,403);
  assert.equal(f.service.store.jobs.length,beforeJobs);
});

test('overview remains readable in maintenance and bypasses mutation queue; concurrent lane budget still applies',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('maintenance.set',{scope:'all',revision:0,enabled:true,reason:'local read-only fixture'})).status,200);
  assert.equal(f.service.maintenanceFor(MACHINES[0].id).reason,'local read-only fixture');
  let release;const original=f.service.tail;f.service.tail=new Promise(resolve=>release=resolve);
  try{
    const response=await Promise.race([f.call('datasets.overview',{},f.member.token),new Promise((_,reject)=>setTimeout(()=>reject(Error('read blocked by mutation tail')),1000))]);
    assert.equal(response.status,200);assert.equal(response.data.state,undefined);
  }finally{release();f.service.tail=original;}
  f.service.datasetReadPending=4;
  assert.equal((await f.call('datasets.overview',{},f.member.token)).status,429);
  f.service.datasetReadPending=0;
});

test('HTTP overview rejects unauthenticated, injected and cross-origin browser calls before node read',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('datasets.overview',{},'0'.repeat(64))).status,401);
  for(const args of [{machine:MACHINES[0].id},{hostAdmin:true},{userId:'builtin-admin'},{path:'/'}])assert.equal((await f.call('datasets.overview',args,f.member.token)).status,400);
  const login=await f.post('/api/login',{username:'overview-member',password,client:'browser'},null,{Origin:f.origin});
  const cookie=login.headers.get('set-cookie').split(';')[0],body={operation:'datasets.overview',args:{}};
  assert.equal((await f.post('/api/call',body,null,{Cookie:cookie,Origin:'http://not-trusted.invalid'})).status,403);
  assert.equal(f.calls.length,0);
  assert.equal((await f.post('/api/call',body,null,{Cookie:cookie,Origin:f.origin})).status,200);
});

test('HTTP overview responds within five seconds when a node catalog and capacity both hang',async t=>{
  const f=await fixture(t),bridge=f.service.bridge,offline=MACHINES.at(-1).id;
  f.service.bridge=(machine,operation,args)=>machine===offline?new Promise(()=>{}):bridge(machine,operation,args);
  const started=performance.now(),response=await f.call('datasets.overview',{},f.member.token);
  const elapsed=performance.now()-started;
  assert.equal(response.status,200);assert.ok(elapsed<5000,`overview took ${elapsed}ms`);
  const value=response.data.result;
  assert.equal(value.partial,true);
  assert.equal(value.caches.find(row=>row.machine===offline).state,'UNKNOWN');
  assert.equal(value.caches.find(row=>row.machine===offline).reason,'timeout');
  assert.ok(value.caches.filter(row=>row.machine!==offline).every(row=>row.state==='READY'&&row.volume.totalBytes===1000));
});
