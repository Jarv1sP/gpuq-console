import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const hash='a'.repeat(64),info={state:'READY',manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-transfer-api-')),bootstrap=join(dir,'bootstrap'),password='Fixture-Transfer-API-2026!';await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[],nodes=new Map();let lost=false;
  const bridge=async(machine,op,args)=>{calls.push({machine,op,args});
    if(op==='transfers.source.prepare')return {id:args.id,token:'x'.repeat(43),...info};
    if(op==='transfers.start'){nodes.set(args.id,{id:args.id,state:'RUNNING',bytes:0,totalBytes:30});if(lost){lost=false;throw Error('lost accepted response');}return nodes.get(args.id);}
    if(op==='transfers.status')return nodes.get(args.id)||{id:args.id,state:'UNKNOWN'};
    if(op==='transfers.cancel'){nodes.set(args.id,{id:args.id,state:'CANCELED'});return nodes.get(args.id);}
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
test('persistent LAN reservation survives lost reply and Portal restart, never starts from status/reconcile',async t=>{
  const f=await fixture(t),args=copy();f.lose();const unknown=await f.call('transfers.create',args);assert.equal(unknown.state,'UNKNOWN');assert.equal(JSON.stringify(unknown).includes('x'.repeat(43)),false);assert.equal(f.service.store.jobs.length,0);
  await f.restart();assert.equal((await f.call('transfers.list',{})).transfers[0].id,unknown.id);
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
test('new transfer runtime is included in deployment, client and demo/Portal assets',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../deploy/node-runtime.json',import.meta.url))),docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');for(const name of ['transfer-jobs.py','transfer-peer.py'])assert.ok(manifest.dependencies.includes(name));assert.ok(manifest.units.includes('gpuq-transfer-peer.service'));assert.match(docker,/COPY[^\n]*transfers\.mjs/);
  for(const file of ['portal-server.mjs','server.mjs'])assert.match(await readFile(new URL('../'+file,import.meta.url),'utf8'),/transfer-upload\.js/);
});
