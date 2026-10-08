import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {displayReadService,executionCall,bridgeClient} from '../execution.mjs';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const operations=['datasets.overview','datasets.catalog','datasets.capacity','datasets.list','datasets.files.list','files.list','storage.usage.mine','storage.usage.users'];
const nodeOperations=['datasets.list','datasets.capacity','datasets.files.list','files.list'];
const machineId=MACHINES[0].id;

test('unset display bridge preserves the exact original service for every operation',async()=>{
  const calls=[],service={bridge:async(...args)=>{calls.push(args);return 'formal';}};
  for(const operation of [...operations,'jobs.submit','datasets.prepare','terminal.open'])assert.equal(displayReadService(service,operation),service);
  const args={userId:'test-owner',hostAdmin:false};
  assert.equal(await displayReadService(service,'datasets.catalog').bridge(machineId,'datasets.list',args),'formal');
  assert.deepEqual(calls,[[machineId,'datasets.list',args]]);
});

test('display operation and node operation must both be allowlisted; identity and args are unchanged',async()=>{
  const formal=[],display=[],service={bridge:async(...args)=>{formal.push(args);return 'formal';},displayBridge:async(...args)=>{display.push(args);return 'display';}};
  const args={userId:'test-owner',hostAdmin:false,project:'sample',path:'code'};
  for(const operation of operations){
    const view=displayReadService(service,operation);
    for(const nodeOperation of nodeOperations)assert.equal(await view.bridge(machineId,nodeOperation,args),'display');
    assert.equal(await view.bridge(machineId,'transfers.capabilities',args),'formal');
  }
  for(const operation of ['jobs.submit','datasets.prepare','datasets.unregister','datasets.delete','datasets.cache.prepare','datasets.cache.release',
    'datasets.status','terminal.open','terminal.exchange','files.put','files.get','files.upload.status','files.upload.cancel','transfers.copy']){
    assert.equal(displayReadService(service,operation),service);
    assert.equal(await displayReadService(service,operation).bridge(machineId,'datasets.capacity',args),'formal');
  }
  assert.equal(display.length,operations.length*nodeOperations.length);
  assert.ok(display.every(row=>row[0]===machineId&&row[2]===args));
  assert.ok(formal.length>0);assert.deepEqual(args,{userId:'test-owner',hostAdmin:false,project:'sample',path:'code'});
});

test('display view is stable for observation caches and reads live authorization state',()=>{
  const service={bridge:()=>{},displayBridge:()=>{},store:{revision:1},closing:false};
  const first=displayReadService(service,'datasets.overview');
  assert.equal(displayReadService(service,'datasets.catalog'),first);
  assert.equal(displayReadService(service,'storage.usage.mine'),first);
  service.store={revision:2};service.closing=true;
  assert.equal(first.store,service.store);assert.equal(first.closing,true);
  service.displayBridge=()=>{};
  assert.notEqual(displayReadService(service,'datasets.overview'),first);
});

test('display failure is returned without fallback or an extra request to the formal bridge',async()=>{
  let formal=0,display=0;
  const failure=Object.assign(Error('display unavailable'),{status:503,code:'EXECUTOR_UNAVAILABLE'});
  const service={bridge:async()=>{formal++;return {};},displayBridge:async()=>{display++;throw failure;}};
  await assert.rejects(displayReadService(service,'datasets.catalog').bridge(machineId,'datasets.list',{}),error=>error===failure);
  assert.equal(display,1);assert.equal(formal,0);
});

test('existing authorization rejects cross-machine and forged arguments before either bridge',async()=>{
  const machine=MACHINES[0].id,user={id:'member',enabled:true,limits:{}},principal={userId:user.id,role:'member'};
  let calls=0;const service={store:{users:[user],get:()=>user},bridge:async()=>{calls++;},displayBridge:async()=>{calls++;}};
  await assert.rejects(executionCall(service,principal,'datasets.capacity',{machine}),error=>error.status===403);
  await assert.rejects(executionCall(service,principal,'datasets.catalog',{userId:'builtin-admin'}),error=>error.status===400);
  await assert.rejects(executionCall(service,principal,'files.list',{machine,path:''}),error=>error.status===403);
  assert.equal(calls,0);
});

async function fixture(t,configured=true){
  const directory=await mkdtemp(join(tmpdir(),'display-read-route-')),calls=[];
  const password='Display-Read-Local-Fixture-2026!',bootstrap=join(directory,'bootstrap.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const bridges=[];
  for(const route of ['formal','display']){
    const path=join(directory,route+'.sock');
    const server=net.createServer(socket=>{let raw='';socket.on('data',part=>raw+=part);socket.on('end',()=>{
      const request=JSON.parse(raw);calls.push({route,...request});
      let result={route};
      if(request.operation==='datasets.list')result={datasets:[]};
      if(request.operation==='files.list')result={files:[]};
      if(request.operation==='datasets.capacity'){
        const usedBytes=route==='display'?200:300;
        const volume={filesystemBytes:1000,usedBytes,availableBytes:650,reserveBytes:50,usableBytes:600,checkedAt:'2026-01-01T00:00:00Z',volumeDeviceId:'a'.repeat(64)};
        result={...volume,storageOverview:{protocol:'dataset-storage-node-v1',cache:{volume,budgetBytes:400},warehouse:null}};
      }
      socket.end(JSON.stringify({ok:true,result}));
    });});
    await new Promise(resolve=>server.listen(path,resolve));bridges.push(server);
  }
  const host=process.env.STARGATE_TEST_HOST||Object.values(networkInterfaces()).flat().find(address=>address?.internal&&address.family==='IPv4')?.address;
  assert.ok(host,'local test interface is available');
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,host,resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://'+host+':'+port;
  const {server,service}=await createPortalServer({database:join(directory,'database'),bootstrap,origin,secure:false,
    bridgeSocket:join(directory,'formal.sock'),...(configured?{displayBridgeSocket:join(directory,'display.sock')}:{})});
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(port,host,resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    for(const bridge of bridges)await new Promise(resolve=>bridge.close(resolve));await rm(directory,{recursive:true,force:true});});
  const post=async(path,body,token)=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const admin=(await post('/api/login',{username:'admin',password})).data;
  return {service,calls,call:(operation,args={})=>post('/api/call',{operation,args},admin.token)};
}

test('real Unix sockets: only display requests use the configured socket; normal bridge remains formal',async t=>{
  const f=await fixture(t),machine=MACHINES[0].id;
  for(const operation of ['datasets.catalog','datasets.overview','datasets.capacity','files.list']){
    const response=await f.call(operation,operation==='datasets.capacity'?{machine}:operation==='files.list'?{machine,path:''}:{});
    assert.equal(response.status,200,JSON.stringify(response.data));
    if(operation==='datasets.overview')assert.ok(response.data.result.caches.every(row=>row.volume.usedBytes===200));
  }
  assert.ok(f.calls.length>0);assert.ok(f.calls.every(row=>row.route==='display'));
  const result=await f.service.bridge(machine,'files.upload.status',{userId:'builtin-admin'});
  assert.equal(result.route,'formal');assert.equal(f.calls.at(-1).route,'formal');
});

test('real Unix sockets: missing optional configuration preserves the original socket for display reads',async t=>{
  const f=await fixture(t,false),response=await f.call('datasets.overview');
  assert.equal(response.status,200);assert.ok(response.data.result.caches.every(row=>row.volume.usedBytes===300));
  assert.ok(f.calls.every(row=>row.route==='formal'));assert.equal(f.service.displayBridge,undefined);
});

test('real Unix sockets: unavailable display socket reports failure and never falls back to formal',async t=>{
  const f=await fixture(t),machine=MACHINES[0].id;
  f.service.displayBridge=bridgeClient(join(tmpdir(),'display-read-socket-does-not-exist-'+process.pid));
  const response=await f.call('datasets.capacity',{machine});
  assert.equal(response.status,503);assert.equal(f.calls.length,0);
});
