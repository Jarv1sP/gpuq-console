import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

async function fixture(t){
  const folder=await mkdtemp(join(tmpdir(),'storage-usage-http-')),bootstrap=join(folder,'bootstrap.json');
  const password='Storage-Usage-Readonly-Fixture-2026!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const f={calls:[]};
  const bridge=async(machine,operation,args)=>{
    f.calls.push({machine,operation,args});
    assert.equal(operation,'datasets.capacity');assert.deepEqual(args,{userId:'builtin-admin',hostAdmin:true});
    await f.gate;
    const owner=createHash('sha256').update(f.member.principal.userId).digest('hex');
    return {storageOverview:{protocol:'dataset-storage-node-v1',cache:{projectCollectedAt:new Date().toISOString(),
      projectUsage:{protocol:1,complete:true,owners:[{owner,complete:true,projectBytes:8192}],
        projects:[{owner,project:'first',name:'first',bytes:4096}]}}}};
  };
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const {server,service}=await createPortalServer({database:join(folder,'database'),bootstrap,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});});
  const post=async(path,body,token)=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const admin=(await post('/api/login',{username:'admin',password})).data;
  const call=(operation,args={},token=admin.token)=>post('/api/call',{operation,args},token);
  assert.equal((await call('users.create',{username:'usage-member',password})).status,200);
  const member=(await post('/api/login',{username:'usage-member',password})).data;
  Object.assign(f,{service,call,admin,member});return f;
}

test('storage usage HTTP is read-only, maintenance-readable, and does not wait behind writes',async t=>{
  const f=await fixture(t);
  const maintenance=await f.call('maintenance.status');
  assert.equal((await f.call('maintenance.set',{scope:'all',enabled:true,reason:'local read fixture',revision:maintenance.data.result.revision})).status,200);
  const schemas=f.service.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const audits=f.service.db.prepare('SELECT count(*) n FROM audit').get().n;
  let release;const tail=f.service.tail;f.service.tail=new Promise(resolve=>release=resolve);
  try{
    const read=await f.call('storage.usage.mine',{},f.member.token);
    assert.equal(read.status,200);assert.equal(read.data.result.machines[0].projectBytes,8192);
    assert.deepEqual(read.data.result.machines[0].projects,[{project:'first',name:'first',bytes:4096}]);
    assert.equal(read.data.state,undefined);
    const all=await f.call('storage.usage.users');assert.equal(all.status,200);assert.equal(all.data.result.users.length,2);
  }finally{release();f.service.tail=tail;}
  assert.equal(f.calls.length,MACHINES.length);
  assert.deepEqual(f.service.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),schemas);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM audit').get().n,audits);
  f.service.datasetReadPending=4;
  assert.equal((await f.call('storage.usage.mine',{},f.member.token)).status,429);
  f.service.datasetReadPending=0;
});

test('HTTP denies unauthorized users, injected owners and revoked sessions without returning foreign usage',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('storage.usage.users',{},f.member.token)).status,403);
  assert.equal((await f.call('storage.usage.mine',{userId:'builtin-admin'},f.member.token)).status,400);
  assert.equal((await f.call('storage.usage.mine',{},'0'.repeat(64))).status,401);
  assert.equal(f.calls.length,0);
  let release,started;
  f.gate=new Promise(resolve=>release=resolve);
  const first=new Promise(resolve=>started=resolve),bridge=f.service.bridge;
  f.service.bridge=(...args)=>{started();return bridge(...args);};
  const pending=f.call('storage.usage.mine',{},f.member.token);
  await first;f.service.revokeSession(f.member.token);release();
  const response=await pending;
  assert.equal(response.status,401);assert.equal(response.data.result,undefined);
});
