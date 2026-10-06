import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';
import {DemoClient} from '../dist/client.js';
import {executionCall} from '../execution.mjs';
import {createDatasetRemovalGuard,datasetCatalogCall,LAST_COPY_MESSAGE} from '../dataset-catalog.mjs';
import {MACHINES} from '../dist/model.js';

const [A,B,C]=MACHINES.map(machine=>machine.id),V='a'.repeat(64),V2='b'.repeat(64),OP='c'.repeat(64);
const actor={userId:'builtin-admin',username:'admin',role:'admin'};
const blocked=error=>error.status===409&&error.code==='LAST_COPY_UNPROVEN'&&error.message===LAST_COPY_MESSAGE;
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'dataset-last-copy-')),database=join(dir,'portal.sqlite'),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Last-Copy-Isolated-Password-2026!'}),{mode:0o600});
  const calls=[],data=new Map(MACHINES.map(machine=>[machine.id,[]]));
  let failure=null,writeFailure=null,held=null,status={operationId:OP,dataset:'sample',version:V,state:'UNREGISTERING'};
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(failure?.(machine,operation))throw Object.assign(Error('private node error'),{status:504});
    if(operation==='datasets.list')return {datasets:structuredClone(data.get(machine))};
    if(operation==='datasets.status')return structuredClone(status);
    assert.equal(operation,'datasets.unregister');
    if(writeFailure)throw writeFailure;
    if(held)await held;
    return {operationId:OP,dataset:args.dataset,version:args.version??null,state:'UNREGISTERING'};
  };
  let service=await PortalService.open(database,bootstrap,undefined,bridge);clearInterval(service.executionTimer);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const put=(machine,versions=[V],extra={})=>data.set(machine,[{dataset:'sample',ownerIds:[actor.userId],versions:versions.map(version=>({version,state:'READY'})),...extra}]);
  put(A);put(B);
  return {dir,bootstrap,calls,data,put,bridge,get service(){return service;},fail:value=>failure=value,writeFail:value=>writeFailure=value,hold:value=>held=value,status:value=>status=value,
    remove:(machine=A,...references)=>{const version=references.length?references[0]:V;return executionCall(service,actor,'datasets.unregister',{machine,dataset:'sample',...(version!==undefined?{version}:{})});},
    journal:()=>service.db.prepare('SELECT * FROM dataset_removal_exclusions').all(),
    async restart(){service.close();service=await PortalService.open(database,undefined,undefined,bridge);clearInterval(service.executionTimer);}};
}
test('fresh other READY permits exactly the unchanged main unregister request',async t=>{
  const f=await fixture(t),out=await f.remove();assert.equal(out.state,'UNREGISTERING');
  assert.deepEqual(f.calls.filter(call=>call.operation==='datasets.unregister'),[{machine:A,operation:'datasets.unregister',args:{dataset:'sample',version:V,userId:actor.userId,hostAdmin:true}}]);
  assert.deepEqual(f.calls.filter(call=>call.operation==='datasets.list').map(call=>call.machine),MACHINES.map(machine=>machine.id));
  assert(f.calls.filter(call=>call.operation==='datasets.list').every(call=>call.args.userId===actor.userId&&call.args.hostAdmin===true));
  const [row]=f.journal();assert.equal(row.machine,A);assert.equal(row.dataset,'sample');assert.equal(row.version,V);assert.equal(row.operation_id,OP);assert(Number.isFinite(Date.parse(row.started_at)));
});
test('archived physical alias must have a fresh complete authority, not just a historical journal',async t=>{
  const f=await fixture(t);f.put(B,[V],{dataset:'archive-copy'});
  f.service.storageArchivePolicy={machine:B};f.service.archiveAliases=()=>new Map([['archive-copy@'+V,'sample']]);
  f.service.archiveState=()=>({phase:'ARCHIVED',originalRetained:true,archiveMachine:B});
  await f.remove();assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);
  f.status({operationId:OP,dataset:'sample',version:V,state:'FAILED'});f.data.set(B,[]);
  await assert.rejects(f.remove(),blocked);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);
});
test('single copy, another version, partial copy and unlinked dataset cannot prove retention',async t=>{
  for(const remote of [[],[{dataset:'sample',versions:[{version:V2,state:'READY'}]}],[{dataset:'sample',versions:[{version:V,state:'STAGING'}]}],[{dataset:'other',versions:[{version:V,state:'READY'}]}]]){
    const f=await fixture(t);f.data.set(B,remote);await assert.rejects(f.remove(),blocked);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,0);assert.equal(f.journal().length,0);
  }
});
test('any failed, timed-out or malformed node read blocks even with another READY',async t=>{
  for(const mode of ['failure','malformed','timeout']){
    const f=await fixture(t);
    if(mode==='failure')f.fail(machine=>machine===C);
    if(mode==='malformed')f.data.set(C,[{dataset:'bad',versions:null}]);
    const service=mode==='timeout'?{...f.service,store:f.service.store,db:f.service.db,bridge:(machine,...rest)=>machine===C?new Promise(()=>{}):f.bridge(machine,...rest)}:f.service;
    await assert.rejects(createDatasetRemovalGuard(service,actor,{readTimeoutMs:10}).withProtectedRemoval(A,'sample',V,()=>{throw Error('write must never run');}),blocked);
    assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,0);assert.equal(f.journal().length,0);
  }
});
test('whole removal checks every version and preserves undefined/null request shape',async t=>{
  for(const version of [undefined,null]){
    const f=await fixture(t);f.put(A,[V,V2]);await assert.rejects(f.remove(A,version),blocked);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,0);
    f.put(B,[V,V2]);await executionCall(f.service,actor,'datasets.unregister',{machine:A,dataset:'sample',...(version===null?{version:null}:{})});
    assert.deepEqual(f.calls.filter(call=>call.operation==='datasets.unregister'),[{machine:A,operation:'datasets.unregister',args:{dataset:'sample',...(version===null?{version:null}:{}),userId:actor.userId,hostAdmin:true}}]);
    assert.deepEqual(f.journal().map(row=>row.version).sort(),[V,V2]);
  }
});
test('concurrent deletion of the last two copies has one winner even before worker removes READY',async t=>{
  const f=await fixture(t);let release;f.hold(new Promise(resolve=>release=resolve));
  const one=f.remove(A),two=f.remove(B);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);release();
  const results=await Promise.allSettled([one,two]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results[1].reason.code,'LAST_COPY_UNPROVEN');assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);
});
test('durable exclusion survives Portal restart and another admin cannot delete the last other copy',async t=>{
  const f=await fixture(t);await f.remove(A);await f.restart();
  assert.equal(f.journal()[0].operation_id,OP);await assert.rejects(f.remove(B),blocked);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);
  const catalog=await datasetCatalogCall(f.service,actor,'datasets.catalog',{machine:A});assert.equal(catalog.datasets[0].versions[0].locations.find(location=>location.machine===A).removalPending,true);
});
test('a lost dispatch receipt keeps null-ID exclusion through restart; READY is not release proof',async t=>{
  const f=await fixture(t);f.writeFail(Error('write receipt lost'));await assert.rejects(f.remove(A),/receipt lost/);assert.equal(f.journal()[0].operation_id,null);
  f.writeFail(null);await f.restart();await assert.rejects(f.remove(B),blocked);assert.equal(f.journal().length,1);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);
  await assert.rejects(f.remove(A),error=>error.code==='DATASET_REMOVAL_PENDING'&&error.message==='这台服务器上的删除结果待确认');
});
test('authoritative absent releases null-ID exclusion; unknown and failed reads do not',async t=>{
  const f=await fixture(t);f.writeFail(Error('lost'));await assert.rejects(f.remove(A));f.writeFail(null);
  f.data.set(A,[{dataset:'sample',versions:[{version:V,state:'UNKNOWN'}]}]);await assert.rejects(f.remove(B),blocked);assert.equal(f.journal().length,1);
  f.fail(machine=>machine===A);await assert.rejects(f.remove(B),blocked);assert.equal(f.journal().length,1);
  f.fail(null);f.data.set(A,[]);f.put(C);await f.remove(B);assert(!f.journal().some(row=>row.machine===A));assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,2);
});
test('a machine omitted from the current inventory is not a trusted absence',async t=>{
  const f=await fixture(t);f.writeFail(Error('lost'));await assert.rejects(f.remove(A));f.writeFail(null);
  const retired=A+'-removed-from-inventory';f.service.db.prepare('UPDATE dataset_removal_exclusions SET machine=?').run(retired);
  await datasetCatalogCall(f.service,actor,'datasets.catalog',{machine:B});
  assert.equal(f.journal().length,1);assert.equal(f.journal()[0].machine,retired);assert.equal(f.journal()[0].operation_id,null);
  assert(!f.calls.some(call=>call.machine===retired));
});
test('proven absence releases a null-ID record without trusting another unreadable receipt',async t=>{
  const f=await fixture(t);f.put(C);f.writeFail(Error('lost'));await assert.rejects(f.remove(A));f.writeFail(null);
  await f.remove(B);assert.equal(f.journal().length,2);f.data.set(A,[]);
  f.fail((machine,operation)=>machine===B&&operation==='datasets.status');
  await datasetCatalogCall(f.service,actor,'datasets.catalog',{machine:C});
  assert(!f.journal().some(row=>row.machine===A));assert.equal(f.journal().length,1);assert.equal(f.journal()[0].machine,B);
  await assert.rejects(f.remove(C),blocked);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,2);
});
test('original terminal receipt plus a new read is required to release a known exclusion',async t=>{
  for(const state of ['UNREGISTERED','FAILED']){
    const f=await fixture(t);await f.remove(A);
    f.status({operationId:OP,dataset:'sample',version:V,state,...(state==='UNREGISTERED'?{unregistered:true}:{})});
    await f.remove(B);assert(!f.journal().some(row=>row.machine===A));
    const query=f.calls.findIndex(call=>call.operation==='datasets.status');assert(f.calls.slice(query+1).some(call=>call.operation==='datasets.list'));
    assert(f.calls.filter(call=>call.operation==='datasets.status').every(call=>call.args.operationId===OP));
  }
});
test('FAILED without READY and missing or mismatched original receipt keep exclusion',async t=>{
  for(const mode of ['failed-incomplete','missing','mismatch']){
    const f=await fixture(t);await f.remove(A);
    if(mode==='failed-incomplete'){f.status({operationId:OP,dataset:'sample',version:V,state:'FAILED'});f.data.set(A,[{dataset:'sample',versions:[{version:V,state:'STAGING'}]}]);}
    if(mode==='missing')f.fail((_machine,operation)=>operation==='datasets.status');
    if(mode==='mismatch')f.status({operationId:'d'.repeat(64),dataset:'sample',version:V,state:'UNREGISTERED',unregistered:true});
    await assert.rejects(f.remove(B),blocked);assert.equal(f.journal().length,1);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,1);
  }
});
test('database exclusion must persist before dispatch, with failure closed and no mutation',async t=>{
  const f=await fixture(t);createDatasetRemovalGuard(f.service,actor);
  f.service.db.exec("CREATE TRIGGER deny_removal BEFORE INSERT ON dataset_removal_exclusions BEGIN SELECT RAISE(ABORT,'disk full'); END;");
  await assert.rejects(f.remove(),/disk full/);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,0);assert.equal(f.journal().length,0);
});
test('member and forged retention arguments still fail before any node call',async t=>{
  const f=await fixture(t);const user=(await f.service.invoke((await f.service.login('admin','Last-Copy-Isolated-Password-2026!')).token,'users.create',{username:'member',password:'Last-Copy-Member-Password-2026!'})).result;
  user.limits={[A]:1};
  await assert.rejects(executionCall(f.service,{userId:user.id,role:'member'},'datasets.unregister',{machine:A,dataset:'sample',version:V}),error=>error.status===403);
  for(const field of ['locations','storage','complete'])await assert.rejects(executionCall(f.service,actor,'datasets.unregister',{machine:A,dataset:'sample',version:V,[field]:true}));
  assert.equal(f.calls.length,0);
});
test('HTTP and browser transport keep the authoritative 409 code and original message',async t=>{
  const f=await fixture(t);f.data.set(B,[]);
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port,origin='http://127.0.0.1:'+port;await new Promise(resolve=>reserve.close(resolve));
  const portal=await createPortalServer({database:join(f.dir,'http.sqlite'),bootstrap:f.bootstrap,secure:false,origin});
  portal.service.bridge=f.bridge;
  await new Promise(resolve=>portal.server.listen(port,'127.0.0.1',resolve));
  const token=(await portal.service.login('admin','Last-Copy-Isolated-Password-2026!')).token;
  const originalFetch=globalThis.fetch;globalThis.fetch=(url,options)=>originalFetch(origin+url,options);
  try{
    const client=new DemoClient();
    await assert.rejects(client.transport('call',{operation:'datasets.unregister',args:{machine:A,dataset:'sample',version:V}},token),blocked);
    assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,0);
  }finally{globalThis.fetch=originalFetch;portal.server.closeAllConnections();await new Promise(resolve=>portal.server.close(resolve));}
});
test('explicit admin catalog refresh reconciles only proven receipts or authoritative absence',async t=>{
  const f=await fixture(t);await f.remove(A);await f.restart();
  let catalog=await datasetCatalogCall(f.service,actor,'datasets.catalog',{machine:A});
  assert.equal(catalog.datasets[0].versions[0].locations.find(location=>location.machine===A).removalPending,true);
  f.status({operationId:OP,dataset:'sample',version:V,state:'FAILED'});
  catalog=await datasetCatalogCall(f.service,actor,'datasets.catalog',{machine:A});
  assert.equal(catalog.datasets[0].versions[0].locations.find(location=>location.machine===A).removalPending,undefined);assert.equal(f.journal().length,0);
  f.writeFail(Error('receipt lost'));await assert.rejects(f.remove(A));f.writeFail(null);f.data.set(A,[]);
  await datasetCatalogCall(f.service,actor,'datasets.catalog',{machine:B});assert.equal(f.journal().length,0);assert.equal(f.calls.filter(call=>call.operation==='datasets.unregister').length,2);
});
