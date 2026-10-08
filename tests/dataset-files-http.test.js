import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id,version='a'.repeat(64),password='Directory-Read-Local-Fixture-2026!';
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'dataset-files-http-')),bootstrap=join(directory,'bootstrap.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port,calls=[],f={owners:[],capability:1};
  const bridge=async(node,operation,args)=>{
    calls.push({machine:node,operation,args});
    if(operation==='datasets.list')return {datasets:node===machine?[{dataset:'sample',ownerIds:f.owners,versions:[{version,state:'READY',bytes:3,files:1}]}]:[]};
    if(operation==='datasets.capacity')return {datasetFileList:f.capability};
    assert.equal(operation,'datasets.files.list');assert.equal(node,machine);
    assert.equal(args.hostAdmin,false);assert.equal(args.userId,f.member.principal.userId);
    return {protocol:'dataset-files-list-v1',available:true,machine:node,dataset:'sample',version,path:args.path,entries:[{name:'a.txt',path:'a.txt',type:'file',bytes:3}],nextCursor:null};
  };
  const {server,service}=await createPortalServer({database:join(directory,'database'),bootstrap,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const post=async(path,body,token,extra={})=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const admin=(await post('/api/login',{username:'admin',password})).data;
  const call=(operation,args={},token=admin.token,extra={})=>post('/api/call',{operation,args},token,extra);
  await call('users.create',{username:'directory-member',password});
  const member=(await post('/api/login',{username:'directory-member',password})).data;
  assert.equal((await call('policy.save',{userId:member.principal.userId,policyVersion:0,total:1,limits:{[machine]:1}})).status,200);
  f.member=member;f.owners=[member.principal.userId];Object.assign(f,{service,admin,calls,call,post,origin});
  return f;
}

test('HTTP directory metadata is compact, maintenance-readable and bypasses the mutation tail',async t=>{
  const f=await fixture(t);assert.equal((await f.call('maintenance.set',{scope:'all',revision:0,enabled:true,reason:'local read fixture'})).status,200);
  let release;const original=f.service.tail;f.service.tail=new Promise(resolve=>release=resolve);
  try{
    const response=await Promise.race([f.call('datasets.files.list',{dataset:'sample',version},f.member.token),new Promise((_,reject)=>setTimeout(()=>reject(Error('directory read blocked by mutation tail')),1000))]);
    assert.equal(response.status,200);assert.equal(response.data.result.available,true);assert.equal(response.data.state,undefined);
    assert.deepEqual(response.data.result.entries,[{name:'a.txt',path:'a.txt',type:'file',bytes:3}]);
  }finally{release();f.service.tail=original;}
  f.service.datasetReadPending=4;
  assert.equal((await f.call('datasets.files.list',{dataset:'sample',version},f.member.token)).status,429);
  f.service.datasetReadPending=0;
});

test('HTTP foreign, injected and unauthenticated requests cannot become directory reads',async t=>{
  const f=await fixture(t),args={dataset:'sample',version};
  const before=f.calls.length;
  assert.equal((await f.call('datasets.files.list',args,'0'.repeat(64))).status,401);
  for(const extra of [{machine},{userId:'builtin-admin'},{hostAdmin:true},{path:'../private'}])
    assert.equal((await f.call('datasets.files.list',{...args,...extra},f.member.token)).status,400);
  assert.equal(f.calls.length,before);
  f.owners=['demo-user-foreign'];
  assert.equal((await f.call('datasets.files.list',args,f.member.token)).status,403);
  assert.ok(f.calls.slice(before).every(row=>row.operation==='datasets.list'));
  f.owners=[f.member.principal.userId];f.capability=0;
  const old=await f.call('datasets.files.list',args,f.member.token);assert.equal(old.status,200);assert.equal(old.data.result.available,false);assert.equal(old.data.result.entries,undefined);
});
