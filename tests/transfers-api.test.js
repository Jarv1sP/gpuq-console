import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {transferCall} from '../transfers.mjs';
const hash='a'.repeat(64),info={state:'READY',manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-transfer-api-')),bootstrap=join(dir,'bootstrap'),password='Fixture-Transfer-API-2026!';await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[],nodes=new Map(),grants=new Map();let lost=false;
  const bridge=async(machine,op,args)=>{calls.push({machine,op,args});
    if(op==='transfers.source.prepare'){grants.set(args.id,{...args,sourceMachine:machine});return {id:args.id,token:'x'.repeat(43),...info};}
    if(op==='transfers.start'){nodes.set(args.id,{id:args.id,state:'RUNNING',bytes:0,totalBytes:30});if(lost){lost=false;throw Error('lost accepted response');}return nodes.get(args.id);}
    if(op==='transfers.status')return nodes.get(args.id)||{id:args.id,state:'UNKNOWN'};
    if(op==='transfers.cancel'){nodes.set(args.id,{id:args.id,state:'CANCELED'});return nodes.get(args.id);}
    if(op==='transfers.confirm-source-release'){
      const grant=grants.get(args.id),result=nodes.get(args.id);
      if(!grant||!['SUCCEEDED','CANCELED'].includes(result?.state))throw Error('Target not confirmed stopped');
      return {schema:1,id:args.id,userId:args.userId,sourceMachine:grant.sourceMachine,targetMachine:machine,
        reference:grant.reference,manifestSha256:hash,attempt:1,state:result.state,confirmedStopped:true};
    }
    if(op==='transfers.release-source')return {id:args.id,released:true};
    if(op==='transfers.confirm-unprepared-cancel'){
      if(nodes.get(args.id)?.state!=='CANCELED')throw Error('Target not confirmed stopped');
      return {schema:1,mode:'unprepared-cancel-v1',id:args.id,userId:args.userId,sourceMachine:args.sourceMachine,
        targetMachine:machine,reference:args.reference,attempt:0,state:'CANCELED',confirmedStopped:true};
    }
    if(op==='transfers.release-unprepared-source'){
      if(grants.has(args.id))throw Error('Issued source ticket requires regular release');
      return {id:args.id,released:true};
    }
    if(op==='transfers.resume'){nodes.set(args.id,{id:args.id,state:'RUNNING',attempt:2});return nodes.get(args.id);}
    if(op==='datasets.upload.begin')return {uploadId:args.key,state:'RECEIVING_MANIFEST',manifestOffset:0,totalBytes:30};
    if(op==='datasets.upload.status')return {uploadId:args.uploadId,state:'UPLOADING',totalBytes:30,remainingBytes:10};
    if(op==='datasets.upload.pause')return {uploadId:args.uploadId,state:'FAILED'};
    if(op==='datasets.snapshot.info')return info;
    return {offset:args.offset??0,data:''};
  };
  let service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[MACHINES[0].id]:1,[MACHINES[1].id]:1}});let login=await service.login('alice',password);
  return {calls,nodes,member,admin,get service(){return service;},call:async(op,args)=>(await service.invoke(login.token,op,args)).result,lose:()=>{lost=true;},restart:async()=>{service.close();service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);login=await service.login('alice',password);}};
}
function copy(){return {key:randomUUID(),kind:'copy',from:MACHINES[0].id,machine:MACHINES[1].id,dataset:'shared',version:hash,name:'copied'};}
test('administrator prepare receipts use effective permissions for same-owner transfer status and list',async t=>{
  const f=await fixture(t),from=MACHINES[0].id,machine=MACHINES[1].id;
  // Promotion retains an old member quota record. The administrator's
  // effective grant is deliberately not written into that persisted record.
  const raw=f.service.store.users.find(u=>u.id==='builtin-admin');
  raw.limits={[machine]:2};raw.total=2;
  assert.equal(f.service.store.get(raw.id).limits[from],MACHINES[0].cards);
  const bridge=f.service.bridge;
  f.service.bridge=async(host,operation,args)=>{
    if(operation==='transfers.capabilities')return {protocol:'lan-transfer-v1',enabled:true,sourceReady:true,sources:[from]};
    if(operation==='datasets.list')return {datasets:host===from?[{dataset:'logical-data',ownerIds:[raw.id],versions:[{version:hash,state:'READY',canPrepare:true,bytes:30,files:2}]}]:[]};
    if(operation==='datasets.status')return {dataset:args.dataset,version:args.version,state:args.dataset==='physical-replica'&&[...f.nodes.values()].some(v=>v.state==='SUCCEEDED')?'READY':'REGISTERED'};
    return bridge(host,operation,args);
  };
  const prepared=(await f.service.invoke(f.admin.token,'datasets.prepare',{machine,dataset:'logical-data',version:hash})).result;
  assert.equal(prepared.state,'PREPARING');assert.match(prepared.transferId,/^[a-f0-9-]{36}$/);
  const status=async()=>(await f.service.invoke(f.admin.token,'transfers.status',{id:prepared.transferId})).result;
  assert.equal((await status()).state,'RUNNING');
  const node=f.nodes.get(prepared.transferId);Object.assign(node,{state:'SUCCEEDED',dataset:'physical-replica',version:hash});
  const complete=await status();assert.equal(complete.state,'SUCCEEDED');assert.equal(complete.result.dataset,'physical-replica');
  const listed=(await f.service.invoke(f.admin.token,'transfers.list',{})).result.transfers;
  assert.equal(listed.find(row=>row.id===prepared.transferId).state,'SUCCEEDED');
  assert.equal((await f.service.invoke(f.admin.token,'datasets.status',{machine,dataset:'logical-data',version:hash})).result.state,'READY');
  assert.equal(f.calls.filter(c=>c.op==='transfers.start').length,1);
  assert.equal(f.calls.filter(c=>c.op==='transfers.source.prepare').length,1);
  assert.deepEqual(raw.limits,{[machine]:2});assert.equal(raw.total,2);
  await assert.rejects(f.call('transfers.status',{id:prepared.transferId}),e=>e.status===404);
  await assert.rejects(f.call('transfers.cancel',{id:prepared.transferId}),e=>e.status===404);
});
test('effective transfer authorization still rejects source revocation, demotion and disabled owners',async t=>{
  const f=await fixture(t),args=copy(),row=await f.call('transfers.create',args);
  f.service.store.users.find(u=>u.id===f.member.id).limits[args.from]=0;
  await assert.rejects(f.call('transfers.status',{id:row.id}),e=>e.status===403);
  await assert.rejects(f.call('transfers.cancel',{id:row.id}),e=>e.status===403);
  const raw=f.service.store.users.find(u=>u.id==='builtin-admin');raw.limits={[args.machine]:1};
  const own=(await f.service.invoke(f.admin.token,'transfers.create',copy())).result;
  raw.role='member';
  await assert.rejects(transferCall(f.service,{userId:raw.id,username:raw.username,role:'member'},'transfers.status',{id:own.id}),e=>e.status===403);
  raw.role='admin';raw.enabled=false;
  await assert.rejects(transferCall(f.service,{userId:raw.id,username:raw.username,role:'admin'},'transfers.status',{id:own.id}),e=>e.status===403);
});
test('member transfer status retains the exact owner source archive grant without compute permission',async t=>{
  const f=await fixture(t),args=copy(),row=await f.call('transfers.create',args);
  f.service.store.users.find(u=>u.id===f.member.id).limits[args.from]=0;
  let version=hash,allowed=true;
  f.service.archiveSourceAllowed=(owner,machine,reference)=>allowed&&owner===f.member.id&&machine===args.from&&reference.dataset===args.dataset&&reference.version===version;
  assert.equal((await f.call('transfers.status',{id:row.id})).state,'RUNNING');
  await assert.rejects(f.service.invoke(f.admin.token,'transfers.status',{id:row.id}),e=>e.status===404);
  version='b'.repeat(64);
  await assert.rejects(f.call('transfers.status',{id:row.id}),e=>e.status===403);
  version=hash;allowed=false;
  await assert.rejects(f.call('transfers.status',{id:row.id}),e=>e.status===403);
  assert.equal(f.calls.filter(c=>c.op==='transfers.start').length,1);
});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Global control queue was blocked by transfer I/O')),1000);})]);}finally{clearTimeout(timer);}}
test('cache download refusal is a fixed FAILED reason retained by status list and restart',async t=>{
  const f=await fixture(t),refused='可回收缓存不支持无租约的旧下载或 sync data；请从受保护原件读取，或使用节点间 transfer copy。';
  const source=await readFile(new URL('../deploy/snapshot-sync.py',import.meta.url),'utf8');
  assert.ok(source.includes("raise ValueError('"+refused+"')"),'node and portal must use the exact reviewed message');
  const bridge=f.service.bridge,reads=[];
  f.service.bridge=async(machine,op,args)=>{reads.push(op);if(op==='datasets.snapshot.info')throw Error(refused);return bridge(machine,op,args);};
  const request={key:randomUUID(),kind:'download',machine:MACHINES[0].id,dataset:'shared',version:hash};
  const row=await f.call('transfers.create',request);
  assert.equal(row.state,'FAILED');assert.equal(row.error,refused);assert.equal(row.snapshot,undefined);
  assert.deepEqual(reads,['datasets.snapshot.info']);
  const status=await f.call('transfers.status',{id:row.id});assert.equal(status.state,'FAILED');assert.equal(status.error,refused);
  assert.equal((await f.call('transfers.list',{})).transfers.find(r=>r.id===row.id).error,refused);
  await f.restart();
  const restored=await f.call('transfers.status',{id:row.id});assert.equal(restored.state,'FAILED');assert.equal(restored.error,refused);
  assert.equal(f.service.store.jobs.length,0);
});
test('arbitrary or near-matching node errors remain sanitized UNKNOWN and never become confirmed refusal',async t=>{
  const f=await fixture(t),refused='可回收缓存不支持无租约的旧下载或 sync data；请从受保护原件读取，或使用节点间 transfer copy。';
  for(const message of ['private fixture diagnostic /source/path',refused+' extra detail','request timed out']){
    f.service.bridge=async()=>{throw Error(message);};
    const row=await f.call('transfers.create',{key:randomUUID(),kind:'download',machine:MACHINES[0].id,dataset:'shared',version:hash});
    assert.equal(row.state,'UNKNOWN');assert.equal(row.error,'节点传输初始化未确认，请核对原任务。');
    assert.equal(JSON.stringify(row).includes(message),false);
  }
  f.service.bridge=async()=>{throw Error(refused);};
  const copied=await f.call('transfers.create',copy());assert.equal(copied.state,'UNKNOWN');
  assert.equal(copied.error,'节点传输初始化未确认，请核对原任务。');
});
test('persistent LAN reservation survives lost reply and Portal restart, never starts from status/reconcile',async t=>{
  const f=await fixture(t),args=copy();f.lose();const unknown=await f.call('transfers.create',args);assert.equal(unknown.state,'UNKNOWN');assert.equal(JSON.stringify(unknown).includes('x'.repeat(43)),false);assert.equal(f.service.store.jobs.length,0);
  await f.restart();assert.equal((await f.call('transfers.list',{})).transfers[0].id,unknown.id);
  assert.equal(f.service.transferSnapshotByKey(f.member.id,args.key).id,unknown.id);
  assert.equal(f.service.transferSnapshotByKey('another-owner',args.key),null);
  assert.equal(f.service.transferSnapshotByKey(f.member.id,'invalid'),null);
  assert.equal(f.service.transferSnapshotByKey(f.member.id,randomUUID()),null);
  assert.equal(JSON.stringify(f.service.transferSnapshotByKey(f.member.id,args.key)).includes('x'.repeat(43)),false);
  const calls=f.calls.filter(c=>c.op==='transfers.start').length;await f.service.reconcileTransfers();const result=await f.call('transfers.status',{id:unknown.id});assert.equal(result.state,'RUNNING');assert.equal(f.calls.filter(c=>c.op==='transfers.start').length,calls);
  const retry=await f.call('transfers.create',args);assert.equal(retry.id,unknown.id);assert.equal(f.nodes.size,1);assert.equal(f.calls.filter(c=>c.op==='transfers.source.prepare').length,1);
  await assert.rejects(f.call('transfers.create',{...args,name:'other'}),e=>e.status===409);assert.ok(f.calls.every(c=>c.args.userId===f.member.id));
});
test('owner and BOTH machine permissions, immutable references and typed operations are authoritative',async t=>{
  const f=await fixture(t),args=copy();for(const extra of [{from:MACHINES[2].id},{machine:MACHINES[2].id},{version:'latest'},{userId:'builtin-admin'},{hostAdmin:true},{argv:['bash']},{timeoutSec:0}])await assert.rejects(f.call('transfers.create',{...args,...extra}));assert.equal(f.calls.length,0);
  const row=await f.call('transfers.create',args);await assert.rejects(f.service.invoke(f.admin.token,'transfers.status',{id:row.id}),e=>e.status===404);
  await assert.rejects(f.call('transfers.io',{id:row.id,action:'get',path:'/etc/passwd',offset:0}));
  await f.call('transfers.cancel',{id:row.id});assert.equal((await f.call('transfers.create',args)).state,'CANCELED');await assert.rejects(f.call('transfers.resume',{id:row.id}));
});
test('client upload uses existing verified chunks and cancel preserves partial without discard/restart',async t=>{
  const f=await fixture(t),args={key:randomUUID(),kind:'upload',machine:MACHINES[0].id,name:'mine',manifest:{manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2}};
  const row=await f.call('transfers.create',args);assert.equal(row.state,'WAITING_CLIENT');assert.ok(row.uploadId);await f.call('transfers.io',{id:row.id,action:'chunk',path:'train.bin',offset:0,data:'YQ=='});
  const last=f.calls.at(-1);assert.equal(last.op,'datasets.upload.chunk');assert.equal(last.args.uploadId,row.uploadId);assert.equal(last.args.hostAdmin,false);
  await f.call('transfers.cancel',{id:row.id});await assert.rejects(f.call('transfers.io',{id:row.id,action:'chunk',path:'train.bin',offset:1,data:'YQ=='}));assert.equal(f.calls.some(c=>c.op==='datasets.upload.discard'),false);assert.equal((await f.call('transfers.status',{id:row.id})).state,'CANCELED');
});
test('upload relay consent is explicit, type checked, owner scoped and unavailable to other transfer kinds',async t=>{
  const f=await fixture(t),base={kind:'upload',machine:MACHINES[0].id,name:'large',manifest:{manifestBytes:100,manifestSha256:hash,totalBytes:300*1024**2,entries:2}};
  for(const allowRelay of [undefined,false,true]){
    await f.call('transfers.create',{...base,key:randomUUID(),...(allowRelay===undefined?{}:{allowRelay})});
    assert.equal(f.calls.at(-1).args.allowRelay,allowRelay===true?true:undefined);
  }
  for(const allowRelay of [1,'true',null])await assert.rejects(f.call('transfers.create',{...base,key:randomUUID(),allowRelay}));
  await assert.rejects(f.call('transfers.create',{...copy(),allowRelay:true}));
  await assert.rejects(f.call('transfers.create',{key:randomUUID(),kind:'download',machine:MACHINES[0].id,dataset:'shared',version:hash,allowRelay:false}));
  const retry={...base,key:randomUUID()},first=await f.call('transfers.create',retry);
  const consent=await f.call('transfers.create',{...retry,allowRelay:true});
  assert.equal(consent.id,first.id);assert.equal(consent.uploadId,first.uploadId);assert.equal(f.calls.at(-1).args.allowRelay,true);
  const automatic=await f.call('transfers.create',retry);
  assert.equal(automatic.id,first.id);assert.equal(automatic.uploadId,first.uploadId);assert.equal(automatic.allowRelay,true);
  assert.equal((await f.call('transfers.create',{...retry,allowRelay:false})).id,first.id);
  await assert.rejects(f.call('transfers.create',{...retry,manifest:{...retry.manifest,totalBytes:retry.manifest.totalBytes+1}}));
  await assert.rejects(f.call('transfers.create',{...retry,allowRelay:true,name:'changed'}));
});
test('direct upload tickets are fresh on resume, returned only to owner and never persisted in transfer progress',async t=>{
  const f=await fixture(t),bridge=f.service.bridge,transport={protocol:'dataset-upload-v1',directAvailable:true,reason:'ready',relayLimitBytes:268435456,relayAllowed:false};
  let begins=0;const ticketRoutes=[];
  f.service.bridge=async(machine,operation,args)=>{
    if(operation==='datasets.upload.begin'){begins++;return {...await bridge(machine,operation,args),uploadTransport:transport};}
    if(operation==='datasets.upload.direct-ticket'){ticketRoutes.push(args.routeId);return {available:true,protocol:'dataset-upload-v1',endpoint:'https://example.test:18444',certificateSha256:hash,ticket:'PRIVATE-TICKET',expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576};}
    if(operation==='datasets.upload.direct-revoke')return {uploadId:args.uploadId,revoked:true};
    return bridge(machine,operation,args);
  };
  const args={key:randomUUID(),kind:'upload',machine:MACHINES[0].id,name:'direct',manifest:{manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2}},row=await f.call('transfers.create',args);
  assert.deepEqual(row.result.uploadTransport,transport);
  await f.call('transfers.io',{id:row.id,action:'chunk',path:'x',offset:0,data:'YQ=='});
  await f.call('transfers.status',{id:row.id});
  const resumed=await f.call('transfers.create',args);
  assert.equal(resumed.id,row.id);assert.equal(begins,2);assert.deepEqual(resumed.result.uploadTransport,transport);
  const ticket=await f.call('transfers.io',{id:row.id,action:'direct-ticket'});assert.equal(ticket.ticket,'PRIVATE-TICKET');
  await f.call('transfers.io',{id:row.id,action:'direct-ticket',routeId:'tail'});
  assert.deepEqual(ticketRoutes,[undefined,'tail']);
  await assert.rejects(f.call('transfers.io',{id:row.id,action:'status',routeId:'tail'}));
  assert.equal(JSON.stringify(f.service.db.prepare('SELECT * FROM transfers').all()).includes('PRIVATE-TICKET'),false);
  assert.equal(JSON.stringify((await f.call('transfers.list',{}))).includes('PRIVATE-TICKET'),false);
  await assert.rejects(f.service.invoke(f.admin.token,'transfers.io',{id:row.id,action:'direct-ticket'}),e=>e.status===404);
  await assert.rejects(f.call('transfers.io',{id:row.id,action:'direct-ticket',path:'x'}));
  assert.equal((await f.call('transfers.io',{id:row.id,action:'direct-revoke'})).revoked,true);
  await f.call('transfers.cancel',{id:row.id});
  await assert.rejects(f.call('transfers.io',{id:row.id,action:'direct-ticket'}));
});
test('download reads only its pinned snapshot; completion is explicitly client-reported',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',{key:randomUUID(),kind:'download',machine:MACHINES[0].id,dataset:'shared',version:hash});
  await assert.rejects(f.call('transfers.io',{id:row.id,action:'get',path:'../other',offset:0}));await assert.rejects(f.call('transfers.io',{id:row.id,action:'get',path:'train.bin',offset:0,dataset:'other'}));
  await f.call('transfers.io',{id:row.id,action:'get',path:'train.bin',offset:0});assert.equal(f.calls.at(-1).args.version,hash);
  await assert.rejects(f.call('transfers.progress',{id:row.id,bytes:29,complete:true}));const completed=await f.call('transfers.progress',{id:row.id,bytes:30,complete:true});assert.equal(completed.state,'SUCCEEDED');assert.equal(completed.result.clientReported,true);
});
test('an initially uncertain cancel is reconciled to terminal without enabling I/O or starting again',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',copy()),original=f.service.bridge;let first=true;
  f.service.bridge=async(machine,op,args)=>{if(op==='transfers.cancel'&&first){first=false;throw Error('cancel reply lost');}return original(machine,op,args);};
  assert.equal((await f.call('transfers.cancel',{id:row.id})).state,'UNKNOWN');const starts=f.calls.filter(c=>c.op==='transfers.start').length;
  await assert.rejects(f.call('transfers.io',{id:row.id,action:'get',path:'x',offset:0}));
  assert.equal((await f.call('transfers.status',{id:row.id})).state,'CANCELED');assert.equal(f.calls.filter(c=>c.op==='transfers.start').length,starts);
});
test('new tasks remain visible after history grows; descending pagination has no duplicates',async t=>{
  const f=await fixture(t),ids=[];
  for(let i=0;i<8;i++){const row=await f.call('transfers.create',{key:randomUUID(),kind:'download',machine:MACHINES[0].id,dataset:'shared',version:hash});ids.push(row.id);await f.call('transfers.progress',{id:row.id,bytes:30,complete:true});}
  const first=await f.call('transfers.list',{limit:5}),second=await f.call('transfers.list',{limit:5,cursor:first.nextCursor});
  assert.equal(first.transfers[0].id,ids.at(-1));assert.deepEqual([...first.transfers,...second.transfers].map(r=>r.id),ids.reverse());assert.equal(second.nextCursor,null);
});
test('new transfer runtime is included in deployment, client and demo/Portal assets',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../deploy/node-runtime.json',import.meta.url))),docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');for(const name of ['transfer-jobs.py','transfer-peer.py','direct-upload.py'])assert.ok(manifest.dependencies.includes(name));assert.ok(manifest.units.includes('gpuq-transfer-peer.service'));assert.ok(manifest.units.includes('gpuq-direct-upload.service'));assert.match(docker,/COPY[^\n]*transfers\.mjs/);
  for(const file of ['portal-server.mjs','server.mjs'])assert.match(await readFile(new URL('../'+file,import.meta.url),'utf8'),/transfer-upload\.js/);
  const ui=await readFile(new URL('../dist/transfers-ui.js',import.meta.url),'utf8');assert.ok(ui.includes('name="transfer-machine"'));assert.ok(!ui.includes('name="machine"'),'new page must not collide with existing training controls');
});
test('slow source preparation never blocks account control; revoked policy fences target dispatch',async t=>{
  const f=await fixture(t),started=deferred(),gate=deferred(),bridge=f.service.bridge;
  f.service.bridge=async(...args)=>{if(args[1]==='transfers.source.prepare'){started.resolve();await gate.promise;}return bridge(...args);};
  const pending=f.call('transfers.create',copy()),rejected=assert.rejects(pending,e=>e.status===403);await started.promise;
  try{await promptly(f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:1,total:0,limits:{}}));}finally{gate.resolve();}
  await rejected;assert.equal(f.calls.some(c=>c.op==='transfers.start'),false);
});
test('maintenance during source preparation fences target start and preserves the original transfer identity',async t=>{
  const f=await fixture(t),started=deferred(),gate=deferred(),bridge=f.service.bridge,args=copy();
  f.service.bridge=async(...request)=>{const result=await bridge(...request);if(request[1]==='transfers.source.prepare'){started.resolve();await gate.promise;}return result;};
  const pending=f.call('transfers.create',args),rejected=assert.rejects(pending,e=>e.status===503&&e.code==='MAINTENANCE_ACTIVE');await started.promise;
  await promptly(f.service.invoke(f.admin.token,'maintenance.set',{scope:args.from,enabled:true,revision:0,reason:'source repair'}));gate.resolve();await rejected;
  assert.equal(f.calls.some(c=>c.op==='transfers.start'),false);
  const before=f.service.transferSnapshotByKey(f.member.id,args.key);assert.ok(before.id);assert.notEqual(before.state,'CANCELED');
  await f.service.reconcileTransfers();assert.equal(f.calls.some(c=>c.op==='transfers.start'),false);
  await f.service.invoke(f.admin.token,'maintenance.set',{scope:args.from,enabled:false,revision:1});
  const resumed=await f.call('transfers.create',args);assert.equal(resumed.id,before.id);assert.equal(resumed.state,'RUNNING');assert.equal(f.nodes.size,1);
});
test('cancel intent fences a delayed source result and survives restart without launching',async t=>{
  const f=await fixture(t),started=deferred(),gate=deferred(),bridge=f.service.bridge;
  f.service.bridge=async(...args)=>{if(args[1]==='transfers.source.prepare'){started.resolve();await gate.promise;}return bridge(...args);};
  const args=copy(),pending=f.call('transfers.create',args),rejected=assert.rejects(pending,e=>e.status===409);await started.promise;
  const id=f.service.db.prepare('SELECT id FROM transfers WHERE client_key=?').get(args.key).id;
  const cancel=f.call('transfers.cancel',{id});assert.equal(f.service.transferSnapshot(f.member.id,id).cancelRequested,true);
  await promptly(f.service.invoke(f.admin.token,'state'));gate.resolve();await rejected;assert.equal((await cancel).state,'CANCELED');
  await f.restart();assert.equal((await f.call('transfers.create',args)).state,'CANCELED');assert.equal(f.calls.some(c=>c.op==='transfers.start'),false);
});
test('internal exported callers share row serialization, bounded admission and safe owner snapshots',async t=>{
  const f=await fixture(t),started=deferred(),gate=deferred(),bridge=f.service.bridge,args=copy(),principal={userId:f.member.id,username:f.member.username,role:'member'};
  let active=0,maxActive=0;
  f.service.bridge=async(...request)=>{active++;maxActive=Math.max(maxActive,active);try{if(request[1]==='transfers.source.prepare'){started.resolve();await gate.promise;}return await bridge(...request);}finally{active--;}};
  const first=transferCall(f.service,principal,'transfers.create',args);await started.promise;
  const second=f.service.transferCall(principal,'transfers.create',args);
  await assert.rejects(f.service.transferCall(principal,'transfers.create',copy()),e=>e.status===429);
  gate.resolve();const [a,b]=await Promise.all([first,second]);assert.equal(a.id,b.id);assert.equal(maxActive,1);assert.equal(f.nodes.size,1);
  const safe=f.service.transferSnapshot(f.member.id,a.id);assert.equal(safe.id,a.id);assert.equal(JSON.stringify(safe).includes('x'.repeat(43)),false);assert.equal(f.service.transferSnapshot('another-owner',a.id),null);
});
test('reconciliation waits outside global control queue and serializes with same-row cancellation',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',copy()),started=deferred(),gate=deferred(),bridge=f.service.bridge;
  f.service.bridge=async(...args)=>{if(args[1]==='transfers.status'){started.resolve();await gate.promise;}return bridge(...args);};
  const reconcile=f.service.reconcileTransfers();await started.promise;const cancel=f.call('transfers.cancel',{id:row.id});
  try{await promptly(f.service.invoke(f.admin.token,'state'));}finally{gate.resolve();}await reconcile;
  assert.equal((await cancel).state,'CANCELED');assert.equal(f.service.transferSnapshot(f.member.id,row.id).state,'CANCELED');
});
test('capability projection exposes only live enabled protocol and authorized machine IDs',async t=>{
  const f=await fixture(t);f.service.bridge=async()=>({enabled:true,sourceReady:true,protocol:'lan-transfer-v1',sources:[MACHINES[0].id,MACHINES[0].id,MACHINES[1].id,MACHINES[2].id,'unknown'],address:'private-ip',token:'private-token'});
  const value=await f.call('transfers.capabilities',{machine:MACHINES[1].id});assert.deepEqual(value,{machine:MACHINES[1].id,enabled:true,sourceReady:true,sources:[MACHINES[0].id],protocol:'lan-transfer-v1'});
  await assert.rejects(f.call('transfers.capabilities',{machine:MACHINES[2].id}),e=>e.status===403);
  f.service.bridge=async()=>{throw Error('old node private error');};assert.deepEqual(await f.call('transfers.capabilities',{machine:MACHINES[1].id}),{machine:MACHINES[1].id,enabled:false,sourceReady:false,sources:[],protocol:'lan-transfer-v1'});
});
test('policy change during capability query rejects delayed data instead of reporting an empty capability',async t=>{
  const f=await fixture(t),started=deferred(),gate=deferred();f.service.bridge=async()=>{started.resolve();await gate.promise;return {enabled:true,sourceReady:true,sources:[],protocol:'lan-transfer-v1'};};
  const pending=f.call('transfers.capabilities',{machine:MACHINES[0].id}),rejected=assert.rejects(pending,e=>e.status===401);await started.promise;
  try{await promptly(f.service.invoke(f.admin.token,'users.enabled',{userId:f.member.id,enabled:false}));}finally{gate.resolve();}await rejected;
});
test('copy and download map logical names through the owner-scoped local receipt before fixing identity',async t=>{
  const f=await fixture(t),seen=[];f.service.datasetPhysicalReference=(owner,machine,ref)=>{seen.push({owner,machine,ref});return {...ref,dataset:'actual-replica'};};
  const args=copy(),row=await f.call('transfers.create',args);assert.equal(row.reference.dataset,'actual-replica');assert.equal(f.calls.find(c=>c.op==='transfers.source.prepare').args.reference.dataset,'actual-replica');
  const download=await f.call('transfers.create',{key:randomUUID(),kind:'download',machine:MACHINES[1].id,dataset:'logical',version:hash});assert.equal(f.calls.at(-1).args.dataset,'actual-replica');assert.deepEqual(seen.map(r=>r.machine),[args.from,MACHINES[1].id]);assert.ok(seen.every(r=>r.owner===f.member.id));
  f.service.datasetPhysicalReference=()=>{throw Error('a pinned download must never remap');};
  await f.call('transfers.io',{id:download.id,action:'get',path:'train.bin',offset:0});assert.equal(f.calls.at(-1).args.dataset,'actual-replica');
  f.service.datasetPhysicalReference=(_owner,_machine,ref)=>({...ref,dataset:'different-replica'});await assert.rejects(f.call('transfers.create',args),e=>e.status===409);
  f.service.datasetPhysicalReference=(_owner,_machine,ref)=>({...ref,version:'b'.repeat(64)});await assert.rejects(f.call('transfers.create',copy()),e=>e.status===409);
});
test('new copy binds its target and success performs trusted target fence before source release',async t=>{
  const f=await fixture(t),args=copy(),row=await f.call('transfers.create',args);
  assert.equal(f.calls.find(c=>c.op==='transfers.source.prepare').args.targetMachine,args.machine);
  assert.deepEqual(row.sourceRelease,{state:'HELD'});
  f.nodes.set(row.id,{id:row.id,state:'SUCCEEDED',dataset:'copy',version:hash});
  const result=await f.call('transfers.status',{id:row.id});
  assert.equal(result.state,'SUCCEEDED');assert.deepEqual(result.sourceRelease,{state:'RELEASED'});
  const confirm=f.calls.find(c=>c.op==='transfers.confirm-source-release'),release=f.calls.find(c=>c.op==='transfers.release-source');
  assert.equal(confirm.machine,args.machine);assert.equal(release.machine,args.from);
  assert.deepEqual(confirm.args,{id:row.id,userId:f.member.id,sourceMachine:args.from,reference:{kind:'datasets',dataset:args.dataset,version:args.version},manifestSha256:hash});
  assert.equal(release.args.confirmation.confirmedStopped,true);assert.equal(release.args.confirmation.state,'SUCCEEDED');
  assert.ok(f.calls.indexOf(confirm)<f.calls.indexOf(release));
  for(const projection of [result,(await f.call('transfers.list',{})),f.service.transferSnapshot(f.member.id,row.id),f.service.transferSnapshotByKey(f.member.id,args.key)]){
    const text=JSON.stringify(projection);assert.ok(!text.includes('confirmation'));assert.ok(!text.includes('confirmedStopped'));assert.ok(!text.includes('x'.repeat(43)));
  }
  const count=f.calls.length;await f.service.reconcileTransfers();await f.call('transfers.status',{id:row.id});assert.equal(f.calls.length,count);
});
test('lost source release acknowledgement stays terminal-pending and retries after restart without refencing',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',copy()),bridge=f.service.bridge;
  f.nodes.set(row.id,{id:row.id,state:'SUCCEEDED'});
  f.service.bridge=async(...request)=>{const value=await bridge(...request);if(request[1]==='transfers.release-source')throw Error('secret-internal-release-failure');return value;};
  const pending=await f.call('transfers.status',{id:row.id});assert.equal(pending.state,'SUCCEEDED');assert.equal(pending.sourceRelease.state,'PENDING');
  const stored=JSON.parse(f.service.db.prepare('SELECT data FROM transfers WHERE id=?').get(row.id).data);
  assert.equal(stored.sourceRelease.confirmation.confirmedStopped,true);
  assert.ok(!JSON.stringify(pending).includes('secret-internal'));
  const confirms=f.calls.filter(c=>c.op==='transfers.confirm-source-release').length;
  await f.restart();await f.service.reconcileTransfers();
  assert.equal(f.service.transferSnapshot(f.member.id,row.id).sourceRelease.state,'RELEASED');
  assert.equal(f.calls.filter(c=>c.op==='transfers.confirm-source-release').length,confirms);
  assert.equal(f.calls.filter(c=>c.op==='transfers.release-source').length,2);
});
test('failed target confirmation is retried for a terminal row, never treated as released',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',copy()),bridge=f.service.bridge;
  f.nodes.set(row.id,{id:row.id,state:'SUCCEEDED'});
  f.service.bridge=async(...request)=>{if(request[1]==='transfers.confirm-source-release')throw Error('manager still active');return bridge(...request);};
  const pending=await f.call('transfers.status',{id:row.id});assert.equal(pending.state,'SUCCEEDED');assert.equal(pending.sourceRelease.state,'PENDING');
  assert.equal(f.calls.some(c=>c.op==='transfers.release-source'),false);
  f.service.bridge=bridge;await f.service.reconcileTransfers();assert.equal(f.service.transferSnapshot(f.member.id,row.id).sourceRelease.state,'RELEASED');
});
test('mismatched or non-stopped confirmations cannot authorize source cleanup',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',copy()),bridge=f.service.bridge;
  f.nodes.set(row.id,{id:row.id,state:'SUCCEEDED'});
  for(const change of [{id:randomUUID()},{userId:'another-owner'},{sourceMachine:MACHINES[2].id},{targetMachine:MACHINES[2].id},
    {reference:{kind:'datasets',dataset:'different',version:hash}},{manifestSha256:'b'.repeat(64)},{confirmedStopped:false},{state:'FAILED'},{attempt:0},{extra:'untrusted'}]){
    f.service.bridge=async(...request)=>{const value=await bridge(...request);return request[1]==='transfers.confirm-source-release'?{...value,...change}:value;};
    const pending=await f.call('transfers.status',{id:row.id});assert.equal(pending.sourceRelease.state,'PENDING');
    assert.equal(f.calls.some(c=>c.op==='transfers.release-source'),false);
  }
  f.service.bridge=bridge;assert.equal((await f.call('transfers.status',{id:row.id})).sourceRelease.state,'RELEASED');
});
test('FAILED PAUSED and UNKNOWN retain source protection; explicit resume binds the same target',async t=>{
  const f=await fixture(t),args=copy(),row=await f.call('transfers.create',args);
  for(const state of ['FAILED','PAUSED','UNKNOWN']){
    f.nodes.set(row.id,{id:row.id,state});const result=await f.call('transfers.status',{id:row.id});assert.equal(result.state,state);assert.equal(result.sourceRelease.state,'HELD');
    await f.service.reconcileTransfers();assert.equal(f.calls.some(c=>c.op==='transfers.confirm-source-release'),false);
  }
  f.nodes.set(row.id,{id:row.id,state:'FAILED'});
  const resumed=await f.call('transfers.resume',{id:row.id});assert.equal(resumed.state,'RUNNING');
  const renewal=f.calls.filter(c=>c.op==='transfers.source.prepare').at(-1);assert.equal(renewal.args.renew,true);assert.equal(renewal.args.targetMachine,args.machine);
  assert.equal(f.calls.some(c=>c.op==='transfers.release-source'),false);
});
test('confirmed cancellation releases, while uncertain cancellation retains until target reconciliation',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',copy()),bridge=f.service.bridge;
  f.service.bridge=async(...request)=>request[1]==='transfers.cancel'?{id:row.id,state:'CANCELING'}:bridge(...request);
  const canceling=await f.call('transfers.cancel',{id:row.id});assert.equal(canceling.state,'CANCELING');assert.equal(canceling.sourceRelease.state,'HELD');
  assert.equal(f.calls.some(c=>c.op==='transfers.release-source'),false);
  f.service.bridge=bridge;await f.service.reconcileTransfers();const result=f.service.transferSnapshot(f.member.id,row.id);
  assert.equal(result.state,'CANCELED');assert.equal(result.sourceRelease.state,'RELEASED');
});
test('legacy terminal rows without a lease protocol are never inferred to need release',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',copy());
  const data=JSON.parse(f.service.db.prepare('SELECT data FROM transfers WHERE id=?').get(row.id).data);delete data.sourceRelease;
  f.service.db.prepare('UPDATE transfers SET state=?,data=? WHERE id=?').run('SUCCEEDED',JSON.stringify(data),row.id);
  const count=f.calls.length;await f.service.reconcileTransfers();const result=await f.call('transfers.status',{id:row.id});
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.sourceRelease,undefined);assert.equal(f.calls.length,count);
});
test('unconfirmed preparation retains a pending reconciliation marker without minting a cleanup ticket',async t=>{
  const f=await fixture(t),bridge=f.service.bridge,args=copy();
  f.service.bridge=async(...request)=>{const result=await bridge(...request);if(request[1]==='transfers.source.prepare')throw Error('prepared but response lost');return result;};
  const row=await f.call('transfers.create',args);assert.equal(row.state,'UNKNOWN');
  f.service.bridge=bridge;const canceled=await f.call('transfers.cancel',{id:row.id});assert.equal(canceled.state,'CANCELED');assert.equal(canceled.sourceRelease.state,'PENDING');
  assert.equal((await f.call('transfers.create',args)).state,'CANCELED');
  await f.restart();await f.service.reconcileTransfers();assert.equal(f.service.transferSnapshot(f.member.id,row.id).sourceRelease.state,'PENDING');
  assert.equal(f.calls.filter(c=>c.op==='transfers.source.prepare').length,1);assert.equal(f.calls.some(c=>c.op==='transfers.release-source'),false);
});
test('release-source and confirmation are never public caller supplied operations or fields',async t=>{
  const f=await fixture(t),row=await f.call('transfers.create',copy()),count=f.calls.length;
  for(const operation of ['transfers.confirm-source-release','transfers.release-source','transfers.confirm-unprepared-cancel','transfers.release-unprepared-source'])await assert.rejects(f.call(operation,{id:row.id}));
  await assert.rejects(f.call('transfers.status',{id:row.id,confirmation:{confirmedStopped:true}}));
  await assert.rejects(f.call('transfers.create',{...copy(),sourceRelease:{protocol:1,state:'RELEASED'}}));
  assert.equal(f.calls.length,count);
  const bridge=await readFile(new URL('../deploy/execution-worker.py',import.meta.url),'utf8');
  for(const name of ['transfers.confirm-source-release','transfers.release-source','transfers.confirm-unprepared-cancel','transfers.release-unprepared-source','datasets.upload.direct-ticket','datasets.upload.direct-revoke'])assert.ok(bridge.includes("'"+name+"'"));
});

test('unprepared copy cancellation releases without a new ticket or target dispatch',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(...request)=>{if(request[1]==='transfers.source.prepare')throw Error('preparing failed');return bridge(...request);};
  const row=await f.call('transfers.create',copy());assert.equal(row.state,'UNKNOWN');
  const canceled=await f.call('transfers.cancel',{id:row.id});
  assert.equal(canceled.state,'CANCELED');assert.equal(canceled.sourceRelease.state,'RELEASED');
  assert.deepEqual(f.calls.map(x=>x.op),['transfers.cancel','transfers.confirm-unprepared-cancel','transfers.release-unprepared-source']);
  await f.restart();await f.service.reconcileTransfers();
  assert.equal(f.service.transferSnapshot(f.member.id,row.id).sourceRelease.state,'RELEASED');
});

test('unprepared source reply loss retries the same durable target proof',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(...request)=>{if(request[1]==='transfers.source.prepare')throw Error('preparing failed');
    const result=await bridge(...request);if(request[1]==='transfers.release-unprepared-source')throw Error('reply lost');return result;};
  const row=await f.call('transfers.create',copy()),canceled=await f.call('transfers.cancel',{id:row.id});
  assert.equal(canceled.state,'CANCELED');assert.equal(canceled.sourceRelease.state,'PENDING');
  assert.equal(canceled.sourceRelease.unpreparedConfirmation,undefined);
  await f.restart();await f.service.reconcileTransfers();
  assert.equal(f.service.transferSnapshot(f.member.id,row.id).sourceRelease.state,'RELEASED');
  assert.equal(f.calls.filter(x=>x.op==='transfers.confirm-unprepared-cancel').length,1);
  assert.equal(f.calls.filter(x=>x.op==='transfers.release-unprepared-source').length,2);
});

test('unprepared cancellation rejects mismatched proofs and old nodes fail closed',async t=>{
  for(const change of [{userId:'demo-user-999'},{attempt:1},{reference:{kind:'datasets',dataset:'other',version:hash}},{confirmedStopped:false},{mode:'other'},{extra:1},null]){
    const f=await fixture(t),bridge=f.service.bridge;
    f.service.bridge=async(...request)=>{
      if(request[1]==='transfers.source.prepare')throw Error('preparing failed');
      if(request[1]==='transfers.confirm-unprepared-cancel'&&change===null)throw Error('Unknown transfer operation');
      const value=await bridge(...request);return request[1]==='transfers.confirm-unprepared-cancel'?{...value,...change}:value;
    };
    const row=await f.call('transfers.create',copy()),canceled=await f.call('transfers.cancel',{id:row.id});
    assert.equal(canceled.sourceRelease.state,'PENDING');
    assert.equal(f.calls.some(x=>x.op==='transfers.release-unprepared-source'),false);
  }
});

test('no-ticket reconciliation never creates a cancellation intent',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(...request)=>{if(request[1]==='transfers.source.prepare')throw Error('preparing failed');return bridge(...request);};
  const row=await f.call('transfers.create',copy());
  await f.service.reconcileTransfers();
  assert.equal(f.calls.some(x=>x.op.includes('cancel')||x.op.includes('release')),false);
  // Even a historical terminal row without the durable intent is not enough.
  f.service.db.prepare('UPDATE transfers SET state=? WHERE id=?').run('CANCELED',row.id);
  await f.service.reconcileTransfers();
  assert.equal(f.calls.some(x=>x.op.includes('cancel')||x.op.includes('release')),false);
});
