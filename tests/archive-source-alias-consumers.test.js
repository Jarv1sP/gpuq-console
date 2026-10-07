import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {installStorageArchive} from '../storage-archive.mjs';
import {createDatasetRemovalGuard,datasetCatalogCall} from '../dataset-catalog.mjs';
import {fixture as deletionFixture,hosts,version,principal,admin} from './dataset-deletion-fixture.mjs';

const [training,oldSource,newSource]=hosts;
const physical='archive-copy',oldLogical='old-logical',newLogical='new-logical';
const record=(dataset,ownerIds=[principal.userId],state='READY',hash=version)=>({dataset,ownerIds,
  versions:[{version:hash,state,canPrepare:false,bytes:42,files:1}]});
const selected=(result,dataset,hash=version)=>result.datasets.find(item=>item.dataset===dataset)?.versions.find(value=>value.version===hash);

// Reuse the isolated SQLite/users/cleanup fixture. Only literal metadata reads
// enter its replacement bridge; no transfer, worker or dataset mutation runs.
function fixture(t){
  const f=deletionFixture(t),{service}=f;
  f.records=new Map();f.personal=new Map();f.unavailable=new Set();f.intercept=null;
  service.bridge=async(machine,operation,args)=>{
    assert.equal(operation,'datasets.list');
    f.calls.push({host:machine,op:operation,args:structuredClone(args)});
    await f.intercept?.(machine,args);
    if(f.unavailable.has(machine))throw Error('isolated node unavailable');
    const records=f.records.get(machine)||[];
    if(args.hostAdmin)return {datasets:structuredClone(records)};
    if(f.personal.has(machine)){
      const proof=f.personal.get(machine);
      if(proof===null)throw Object.assign(Error('member proof denied'),{status:403});
      return structuredClone(proof);
    }
    return {datasets:structuredClone(records.filter(item=>Array.isArray(item.ownerIds)&&item.ownerIds.includes(args.userId)))};
  };
  service.datasetReadPending=0;
  service.datasetLabelView=(owner,dataset)=>({displayName:'Label '+dataset});
  service.principal=token=>{
    const who=token===principal.userId?principal:token===admin.userId?admin:null;
    if(!who||!service.store.get(who.userId)?.enabled)throw Object.assign(Error('unauthenticated fixture'),{status:401});
    return structuredClone(who);
  };
  f.read=(operation,args,who=principal)=>PortalService.prototype.datasetRead.call(service,who.userId,operation,args);
  f.catalog=(args={machine:training},who=principal)=>datasetCatalogCall(service,who,'datasets.catalog',args);
  f.install=machine=>f.archive=installStorageArchive(service,{enabled:true,machine,authority:'hdd'},{startTimer:false});
  f.seed=(source,logical,owner=principal.userId,hash=version)=>{
    f.install(source);
    const row=f.archive.enqueueEvent(training,{id:randomUUID(),userId:owner,dataset:logical,version:hash,state:'READY'});
    Object.assign(row,{phase:'ARCHIVED',sourceDataset:physical,grantId:randomUUID(),certifyId:randomUUID(),
      receiptSha256:'c'.repeat(64),eventAcknowledged:true});
    service.db.prepare('UPDATE storage_archives SET data=? WHERE id=?').run(JSON.stringify(row),row.id);
    return row;
  };
  f.seed(oldSource,oldLogical);f.install(newSource);
  return f;
}

test('certified old-source alias survives policy cutover in real catalog and datasetRead list',async t=>{
  const f=fixture(t);f.records.set(oldSource,[record(physical)]);
  assert.equal(f.service.storageArchivePolicy.machine,newSource);
  const catalog=await f.catalog({machine:oldSource}),value=selected(catalog,oldLogical);
  assert.ok(value);assert.equal(value.state,'READY');assert.equal(value.canUse,true);
  assert.deepEqual(value.locations.map(({machine,dataset})=>({machine,dataset})),[{machine:oldSource,dataset:physical}]);
  const listed=await f.read('datasets.list',{machine:oldSource});
  assert.equal(listed.principal.userId,principal.userId);
  assert.deepEqual(listed.result.datasets.map(item=>item.dataset),[physical]);
  assert.equal(listed.result.datasets[0].displayName,'Label '+oldLogical);
  assert.equal(listed.result.datasets[0].versions[0].state,'READY');
  assert.ok(f.calls.every(call=>call.op==='datasets.list'));
  assert.doesNotMatch(JSON.stringify(catalog)+JSON.stringify(listed.result),/ownerIds|demo-user-|grantId|sourceDataset|policyKey/);
});

test('identical physical name and version keep old/new source aliases isolated in both read consumers',async t=>{
  const f=fixture(t);f.seed(newSource,newLogical);f.install(newSource);
  for(const machine of [oldSource,newSource])f.records.set(machine,[record(physical)]);
  const catalog=await f.catalog();
  assert.deepEqual(catalog.datasets.map(item=>item.dataset),[newLogical,oldLogical]);
  assert.deepEqual(selected(catalog,oldLogical).locations.map(value=>value.machine),[oldSource]);
  assert.deepEqual(selected(catalog,newLogical).locations.map(value=>value.machine),[newSource]);
  for(const [machine,logical] of [[oldSource,oldLogical],[newSource,newLogical]]){
    const {result}=await f.read('datasets.list',{machine});
    assert.deepEqual(result.datasets.map(item=>item.dataset),[physical]);
    assert.equal(result.datasets[0].displayName,'Label '+logical);
  }
});

test('last-copy guard resolves historical aliases on their recorded source, not current policy source',async t=>{
  const f=fixture(t);f.seed(newSource,newLogical);f.install(newSource);
  f.records.set(training,[record(oldLogical)]);
  f.records.set(oldSource,[record(physical)]);f.records.set(newSource,[record(physical)]);
  const proof=await createDatasetRemovalGuard(f.service,admin).assertAnotherCompleteCopy(training,oldLogical,version);
  assert.equal(proof.length,1);
  assert.deepEqual(proof[0].copies,[{machine:oldSource,dataset:physical,version}]);
  assert.ok(f.calls.every(call=>call.op==='datasets.list'&&call.args.hostAdmin===true&&call.args.userId===admin.userId));
});

test('catalog never applies current viewer archive alias to a foreign registration after cutover',async t=>{
  const f=fixture(t);f.records.set(oldSource,[record(physical,[admin.userId])]);
  const aliases=f.service.archiveAliases;
  f.service.archiveAliases=(...args)=>{assert.fail('foreign ownership must not query viewer aliases');return aliases(...args);};
  const result=await f.catalog({machine:oldSource}),value=selected(result,physical);
  assert.deepEqual(result.datasets.map(item=>item.dataset),[physical]);
  assert.equal(value.canUse,false);assert.equal(value.canPrepare,false);
  assert.equal(value.locations[0].ownerLabel,'所属用户：admin');
  assert.equal(value.locations[0].deletionPermissions.memberAllowed,false);
});

test('privileged datasetRead list must not rename another owner with administrators personal historical alias',async t=>{
  const f=fixture(t);f.seed(oldSource,'admin-logical',admin.userId);f.install(newSource);
  f.records.set(oldSource,[record(physical,[principal.userId])]);
  const {result}=await f.read('datasets.list',{machine:oldSource},admin);
  assert.deepEqual(result.datasets.map(item=>item.dataset),[physical]);
  assert.equal(result.datasets[0].displayName,'Label '+physical);
  assert.equal(result.datasets[0].ownerLabel,'所属用户：alice');
  assert.equal(result.datasets[0].versions[0].canPrepare,false);
  assert.equal(f.calls.at(-1).args.hostAdmin,true);
  assert.equal(f.calls.at(-1).args.userId,admin.userId);
});

test('unknown legacy owner needs exact member proof before historical alias applies',async t=>{
  const unproven='d'.repeat(64);
  for(const proof of [null,{datasets:[]},{datasets:[record(physical,[admin.userId])]},
    {datasets:[{...record(physical),ownerIds:undefined}]}]){
    const f=fixture(t);f.records.set(oldSource,[{dataset:physical,ownerIds:null,versions:[
      {version,state:'READY',canPrepare:true},{version:unproven,state:'READY',canPrepare:true}]}]);
    f.personal.set(oldSource,proof);
    const result=await f.catalog({machine:oldSource}),confirmed=proof?.datasets?.length===1&&proof.datasets[0].ownerIds===undefined;
    assert.equal(!!selected(result,oldLogical),confirmed);
    const unknown=selected(result,physical,unproven);
    assert.ok(unknown);assert.equal(unknown.canUse,false);assert.equal(unknown.canPrepare,false);
    assert.equal(unknown.locations[0].deletionPermissions.memberAllowed,false);
    if(!confirmed){const value=selected(result,physical);assert.equal(value.canUse,false);assert.equal(value.canPrepare,false);}
  }
});

test('historical data grant does not become machine/capacity/prepare permission when compute quota is zero',async t=>{
  const f=fixture(t);f.records.set(oldSource,[record(physical)]);
  f.users.find(user=>user.id===principal.userId).limits={};
  const catalog=(await f.read('datasets.catalog',{machine:training})).result,value=selected(catalog,oldLogical);
  assert.equal(value.canUse,true,'fixed historical archive remains a personal data grant');
  assert.equal(value.canPrepare,false);assert.equal(value.sourceMachine,undefined);
  assert.equal(value.locations[0].deletionPermissions.memberAllowed,false);
  const before=f.calls.length;
  for(const operation of ['datasets.list','datasets.capacity','datasets.prepare'])
    await assert.rejects(f.read(operation,{machine:oldSource,...(operation==='datasets.prepare'?{dataset:oldLogical,version}:{})}),error=>error.status===403);
  assert.equal(f.calls.length,before);assert.equal(f.service.datasetReadPending,0);
});

test('old journal alias cannot prove a complete current copy when node state or read is unknown',async t=>{
  for(const offline of [false,true]){
    const f=fixture(t);f.records.set(training,[record(oldLogical,[principal.userId],'REGISTERED')]);
    f.records.set(oldSource,[record(physical,[principal.userId],'UNKNOWN')]);
    if(offline)f.unavailable.add(oldSource);
    const result=await f.catalog(),value=selected(result,oldLogical);
    assert.equal(value.state,'REGISTERED');assert.equal(value.canPrepare,false);
    assert.equal(result.partial,offline);
    await assert.rejects(createDatasetRemovalGuard(f.service,admin).assertAnotherCompleteCopy(training,oldLogical,version),
      error=>error.status===409&&error.code==='LAST_COPY_UNPROVEN');
  }
});

test('datasetRead revalidates account policy before releasing aliased results',async t=>{
  for(const operation of ['datasets.list','datasets.catalog']){
    const f=fixture(t);f.records.set(oldSource,[record(physical)]);
    f.intercept=async machine=>{if(machine===oldSource)f.users.find(user=>user.id===principal.userId).limits[oldSource]=0;};
    await assert.rejects(f.read(operation,{machine:oldSource}),error=>error.status===403);
    assert.equal(f.service.datasetReadPending,0);
  }
});
