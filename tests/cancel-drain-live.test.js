// No progress, fleet or sharing dependency: actual native -> node -> Portal/HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {createPortalServer} from '../portal-server.mjs';
import {usage} from '../execution.mjs';

async function native(t){
  const child=spawn('python3',[fileURLToPath(new URL('./fixtures/native-cancel-rpc.py',import.meta.url))]);
  const readers=createInterface({input:child.stdout}),pending=new Map();let count=0,stderr='',readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  child.stderr.on('data',part=>stderr+=part);
  readers.on('line',line=>{const message=JSON.parse(line);if(message.ready){readyResolve(message);return;}const request=pending.get(message.id);if(!request)return;pending.delete(message.id);message.ok?request.resolve(message.result):request.reject(Error(message.error));});
  child.once('exit',code=>{const error=Error('native fixture exited '+code+': '+stderr);readyReject(error);for(const request of pending.values())request.reject(error);pending.clear();});
  t.after(async()=>{child.stdin.end();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));readers.close();});
  return {...await ready,call:(operation,args={},extra={})=>new Promise((resolve,reject)=>{const id=++count;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,operation,args,...extra})+'\n');})};
}

async function fixture(t){
  const node=await native(t),dir=await mkdtemp(join(tmpdir(),'gpuq-cancel-drain-live-')),bootstrap=join(dir,'bootstrap'),password=randomUUID()+randomUUID(),calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));const origin='http://127.0.0.1:'+port;
  let sqlError=false;
  const bridge=async(machine,operation,args)=>{const reply=await node.call(operation,args,{sqlError});calls.push({machine,operation,nativeCalls:reply.calls});return reply.node;};
  const {server,service}=await createPortalServer({database:join(dir,'portal.db'),bootstrap,origin,secure:false,bridge});clearInterval(service.executionTimer);service.reconciling=true;
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));const admin=await service.login('admin',password);
  const member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const login=await service.login('alice',password);assert.equal(login.principal.userId,node.job.userId);
  const job={id:node.job.id,userId:login.principal.userId,username:'alice',name:node.job.name,machine:'gpu-1',cards:1,state:'RUNNING',spec:node.job};service.store.jobs.push(job);service.save();
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const step=async()=>{service.reconciling=false;try{await service.reconcile();}finally{service.reconciling=true;}};
  const cancel=async()=>{const response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token,Origin:origin},body:JSON.stringify({operation:'jobs.cancel',args:{jobId:job.id}})});assert.equal(response.status,200);return response.json();};
  return {node,calls,service,job,step,cancel,setSqlError:value=>sqlError=value,quota:()=>usage(service.store.jobs,job.userId)};
}

test('HTTP Portal cancel retains quota after real native cancel and releases only after native drain',async t=>{
  const f=await fixture(t);await f.cancel();assert.equal(f.job.cancelRequested,true);assert.equal(f.job.state,'RUNNING');assert.equal(f.quota(),1);
  await f.step();assert.equal(f.job.state,'UNKNOWN');assert.equal(f.quota(),1);assert.deepEqual(await f.node.call('state'),{jobState:'CANCELED',attemptState:'TERM_REQUESTED',leases:1});
  assert.deepEqual(f.calls[0].nativeCalls.map(call=>call[0]),['show','cancel','show']);
  const saved=JSON.parse(f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data).jobs[0];assert.equal(saved.state,'UNKNOWN');
  await f.node.call('drain-native');await f.step();assert.equal(f.job.state,'CANCELED');assert.equal(f.quota(),0);assert.deepEqual(f.calls[1].nativeCalls.map(call=>call[0]),['show']);
});

test('read-only node SQL failure during Portal cancellation does not release the running reservation',async t=>{
  const f=await fixture(t);await f.cancel();f.setSqlError(true);await f.step();assert.equal(f.job.state,'RUNNING');assert.equal(f.quota(),1);assert.deepEqual(await f.node.call('state'),{jobState:'RUNNING',attemptState:'RUNNING',leases:1});
  f.setSqlError(false);await f.step();assert.equal(f.job.state,'UNKNOWN');assert.equal(f.quota(),1);await f.node.call('drain-native');await f.step();assert.equal(f.job.state,'CANCELED');assert.equal(f.quota(),0);
});
