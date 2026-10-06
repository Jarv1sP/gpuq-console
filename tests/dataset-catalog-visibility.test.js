import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetCatalogCall} from '../dataset-catalog.mjs';
import {MACHINES} from '../dist/model.js';

const [local,remote,cold]=MACHINES.map(m=>m.id),hash='a'.repeat(64),otherHash='b'.repeat(64);
const principal={userId:'demo-user-1',role:'member'};
const record=(dataset,ownerIds,versions=[{version:hash,state:'READY',bytes:42,files:1}])=>({dataset,ownerIds,versions});
function fixture(records={},limits={[local]:1,[remote]:1}){
  const user={id:principal.userId,role:'member',enabled:true,limits},calls=[];
  const service={store:{users:[{id:user.id,username:'alice'},{id:'demo-user-2',username:'bob'}],get:id=>id===user.id?structuredClone(user):undefined},
    bridge:async(machine,operation,args)=>{calls.push({machine,operation,args});assert.equal(operation,'datasets.list');return {datasets:records[machine]||[]};}};
  return {service,user,calls,call:(args={machine:local},who=principal)=>datasetCatalogCall(service,who,'datasets.catalog',args)};
}
const selected=(result,name,version=hash)=>result.datasets.find(item=>item.dataset===name)?.versions.find(item=>item.version===version);

test('all enabled members discover every inventory node, without receiving another owner actions or internals',async()=>{
  const privateVersion={version:hash,state:'READY',bytes:42,files:1,canPrepare:true,deletionPermissions:{memberAllowed:true},error:'secret-stack /home/bob/token',operationId:'c'.repeat(64),manifest:{path:'secret.jpg'},grants:['token'],sourceId:'/private'};
  const f=fixture({[local]:[record('public-name',['demo-user-2'],[privateVersion])],[cold]:[record('cold-private',['demo-user-2'])]});
  f.service.archiveState=()=>assert.fail('other owner storage must not be queried');
  f.service.datasetReplicaState=()=>assert.fail('other owner transfer must not be queried');
  f.service.transferCall=async(who,op,args)=>{assert.equal(who.role,'member');assert.equal(op,'transfers.capabilities');assert.equal(args.machine,local);return {enabled:true,sources:[cold]};};
  const result=await f.call(),version=selected(result,'public-name');
  assert.deepEqual(result.machines.map(row=>row.machine),MACHINES.map(m=>m.id));
  assert.deepEqual(result.datasets.map(row=>row.dataset),['cold-private','public-name']);
  assert.equal(version.state,'READY');assert.equal(version.canUse,false);assert.equal(version.canPrepare,false);
  assert.equal(version.locations[0].canUse,false);assert.equal(version.locations[0].canPrepare,false);
  assert.equal(version.locations[0].deletionPermissions.memberAllowed,false);
  assert.equal(version.ownerLabel,'所属用户：bob');assert.equal(version.sourceMachine,undefined);
  assert.ok(f.calls.every(call=>call.operation==='datasets.list'&&call.args.hostAdmin===true&&call.args.userId==='builtin-admin'));
  assert.doesNotMatch(JSON.stringify(result),/ownerIds|demo-user-|token|secret|\/private|operationId|manifest|grants|sourceId/);
});

test('zero-quota member can browse absent/null or a known machine but cannot query capacity or prepare',async()=>{
  const f=fixture({[local]:[record('mine',[principal.userId])],[remote]:[record('theirs',['demo-user-2'])]},{});
  f.service.transferCall=()=>assert.fail('no quota must not request transfer capabilities');
  for(const args of [{},{machine:null},{machine:local}]){
    const result=await f.call(args);assert.equal(result.machine,args.machine??null);assert.equal(result.datasets.length,2);
    for(const dataset of result.datasets)for(const version of dataset.versions){assert.equal(version.canUse,false);assert.equal(version.canPrepare,false);assert.equal(version.sourceMachine,undefined);}
  }
  const before=f.calls.length;
  for(const machine of [null,local])await assert.rejects(datasetCatalogCall(f.service,principal,'datasets.capacity',{machine}),e=>e.status===403);
  assert.equal(f.calls.length,before);
});

test('disabled, unknown and deleted accounts, unknown machines and injected fields never reach discovery',async()=>{
  const f=fixture();
  for(const args of [{machine:'not-an-inventory-machine'},{machine:7}])await assert.rejects(f.call(args),e=>e.status===403);
  for(const args of [{machine:local,hostAdmin:true},{machine:local,userId:'demo-user-2'},{machine:local,path:'/data2'}])await assert.rejects(f.call(args),e=>e.status===400);
  await assert.rejects(f.call({}, {userId:'missing',role:'admin'}),e=>e.status===403);
  await assert.rejects(f.call({},null),e=>e.status===403);
  f.user.enabled=false;await assert.rejects(f.call(),e=>e.status===403);
  f.service.store.get=()=>{throw Error('account deleted');};await assert.rejects(f.call(),e=>e.status===403);
  assert.equal(f.calls.length,0);
});

test('private local READY never masks authorized remote READY or supplies the copy source',async()=>{
  const f=fixture({[local]:[record('same',['demo-user-2'])],[remote]:[record('same',[principal.userId])],[cold]:[record('same',['demo-user-2'])]});
  f.service.transferCall=async()=>({enabled:true,sources:[cold,remote]});
  const version=selected(await f.call(),'same');
  assert.equal(version.state,'NOT_LOCAL');assert.equal(version.canUse,true);assert.equal(version.canPrepare,true);
  assert.equal(version.sourceMachine,remote);assert.equal(version.sourceDataset,'same');
  assert.deepEqual(version.locations.map(value=>value.canUse),[false,true,false]);
  assert.equal(version.ownerLabel,'各机授权不同（见副本位置）');
});

test('same dataset name with separate versions never inherits another version ACL or usable location',async()=>{
  const f=fixture({[local]:[record('same',['demo-user-2'])],[remote]:[record('same',[principal.userId],[{version:otherHash,state:'READY'}])]});
  f.service.transferCall=async()=>({enabled:true,sources:[remote]});
  const result=await f.call(),privateVersion=selected(result,'same'),mine=selected(result,'same',otherHash);
  assert.equal(privateVersion.canUse,false);assert.equal(privateVersion.canPrepare,false);assert.equal(privateVersion.sourceMachine,undefined);
  assert.equal(mine.canUse,true);assert.equal(mine.sourceMachine,remote);assert.equal(mine.state,'NOT_LOCAL');
});

test('foreign historical aliases are never queried/applied, own aliases still join authorized replicas',async()=>{
  const f=fixture({[local]:[record('logical',[principal.userId])],[remote]:[record('own-replica',[principal.userId])],[cold]:[record('foreign-replica',['demo-user-2'])]});
  f.service.datasetAliases=(owner,machine)=>{assert.equal(owner,principal.userId);assert.notEqual(machine,cold);return new Map([['own-replica@'+hash,'logical'],['foreign-replica@'+hash,'logical']]);};
  const result=await f.call();assert.equal(result.datasets.length,2);
  assert.equal(selected(result,'logical').locations.length,2);assert.equal(selected(result,'foreign-replica').canUse,false);
});

test('unknown legacy ACL requires a separate exact member listing; one proven tuple grants no siblings',async()=>{
  const f=fixture({[remote]:[record('old',undefined,[{version:hash,state:'READY'},{version:otherHash,state:'READY'}]),record('hidden',null)]});
  const discovery=f.service.bridge;
  f.service.bridge=(machine,op,args)=>{if(args.hostAdmin)return discovery(machine,op,args);assert.equal(args.userId,principal.userId);assert.equal(op,'datasets.list');return Promise.resolve({datasets:[record('old',undefined)]});};
  f.service.transferCall=async()=>({enabled:true,sources:[remote]});
  const result=await f.call();
  assert.equal(selected(result,'old').canUse,true);assert.equal(selected(result,'old').canPrepare,true);
  assert.equal(selected(result,'old',otherHash).canUse,false);assert.equal(selected(result,'hidden').canUse,false);
  assert.match(selected(result,'old').ownerLabel,/未知/);
});

test('zero-quota legacy directory never provisions a member workspace just to browse unknown ACLs',async()=>{
  const f=fixture({[local]:[record('old',undefined)],[cold]:[record('old-archive',null)]},{});
  const result=await f.call({});
  assert.equal(result.datasets.length,2);assert.ok(result.datasets.every(row=>row.versions.every(version=>version.canUse===false)));
  assert.equal(f.calls.length,MACHINES.length);
  assert.ok(f.calls.every(call=>call.operation==='datasets.list'&&call.args.userId==='builtin-admin'&&call.args.hostAdmin===true));
  // A verified personal archive is a data grant, not implicit compute access.
  f.calls.length=0;f.service.archiveSourceAllowed=(owner,machine,ref)=>owner===principal.userId&&machine===cold&&ref.dataset==='old-archive'&&ref.version===hash;
  const own=await f.call({});assert.equal(selected(own,'old-archive').canUse,true);assert.equal(selected(own,'old-archive').canPrepare,false);
  assert.equal(f.calls.filter(call=>call.args.hostAdmin===false).length,1);
  assert.equal(f.calls.find(call=>call.args.hostAdmin===false).machine,cold);
});

test('missing, malformed or denied member proofs do not turn unknown or oversized ACL into access',async()=>{
  const invalid=[[],['bad/id'],Array(65).fill(principal.userId)];
  for(const proof of [null,{datasets:[]},{datasets:[record('legacy',['demo-user-2'])]}]){
    const f=fixture({[local]:[record('legacy',null),...invalid.map((acl,i)=>record('invalid'+i,acl))]});
    const discovery=f.service.bridge;
    f.service.bridge=(machine,op,args)=>args.hostAdmin?discovery(machine,op,args):proof===null?Promise.reject(Error('private ACL error')):Promise.resolve(proof);
    const result=await f.call();for(const data of result.datasets)assert.equal(data.versions[0].canUse,false);
    assert.doesNotMatch(JSON.stringify(result),/private ACL error/);
  }
});

test('HDD archive exception needs both the precise viewer ACL and the precise authorized version',async()=>{
  const f=fixture({[cold]:[record('original',[principal.userId],[{version:hash,state:'READY'},{version:otherHash,state:'READY'}]),record('not-mine',['demo-user-2'])]}, {[local]:1});
  f.service.archiveSourceAllowed=(owner,machine,ref)=>owner===principal.userId&&machine===cold&&ref.dataset==='original'&&ref.version===hash;
  f.service.archiveMachineVisible=()=>true; // This broad discovery hint must never become read permission.
  f.service.transferCall=async()=>({enabled:true,sources:[cold]});
  const result=await f.call();
  assert.equal(selected(result,'original').canUse,true);assert.equal(selected(result,'original').sourceMachine,cold);
  assert.equal(selected(result,'original',otherHash).canUse,false);assert.equal(selected(result,'not-mine').canUse,false);
});

test('only owner-readable locations expose that owners existing archive view and errors',async()=>{
  const f=fixture({[local]:[record('mine',[principal.userId],[{version:hash,state:'FAILED',error:'my failure'}]),record('theirs',['demo-user-2'],[{version:hash,state:'FAILED',error:'private failure'}])]});
  const calls=[];f.service.archiveState=(owner,machine,ref)=>{calls.push({owner,machine,ref});return {phase:'COPYING',localState:'protected'};};
  const result=await f.call();assert.equal(calls.length,1);assert.equal(calls[0].ref.dataset,'mine');
  assert.equal(selected(result,'mine').locations[0].storage.phase,'COPYING');assert.equal(selected(result,'mine').error,'my failure');
  assert.equal(selected(result,'theirs').locations[0].storage,undefined);assert.doesNotMatch(JSON.stringify(result),/private failure/);
});

test('malicious node metadata remains a narrow metadata projection, even for a known valid name',async()=>{
  const f=fixture({[local]:[null,record('../escape',[principal.userId]),record('safe',['demo-user-2'],[null,{version:'invalid',state:'READY'},{version:hash,state:'FORGED',bytes:-1,files:2.5,canUse:true,path:'/private',operationId:'e'.repeat(64),error:'LEAK'}])]});
  const result=await f.call();assert.equal(result.datasets.length,1);
  const version=selected(result,'safe');assert.equal(version.state,'UNKNOWN');assert.equal(version.canUse,false);
  assert.equal(version.bytes,undefined);assert.equal(version.files,undefined);assert.doesNotMatch(JSON.stringify(result),/LEAK|FORGED|operationId|\/private|escape/);
});

test('partial inventory stays partial and cannot promote remote data when selected node is unknown',async()=>{
  const f=fixture({[remote]:[record('mine',[principal.userId])]});const discovery=f.service.bridge;
  f.service.bridge=(machine,...args)=>machine===local?Promise.reject(Error('credential-stack')):discovery(machine,...args);
  f.service.transferCall=async()=>({enabled:true,sources:[remote]});
  const result=await f.call(),version=selected(result,'mine');
  assert.equal(result.partial,true);assert.equal(result.machines.find(row=>row.machine===local).state,'unavailable');
  assert.equal(version.state,'UNKNOWN');assert.equal(version.canUse,true);assert.equal(version.canPrepare,false);assert.equal(version.sourceMachine,undefined);
  assert.doesNotMatch(JSON.stringify(result),/credential-stack/);
});

test('account revocation during elevated discovery or legacy proof discards the entire directory',async()=>{
  for(const when of [true,false]){
    const f=fixture({[local]:[record('mine',null)]}),bridge=f.service.bridge;
    f.service.bridge=async(machine,op,args)=>{const result=await bridge(machine,op,args);if(args.hostAdmin===when)f.user.enabled=false;return result;};
    await assert.rejects(f.call(),e=>e.status===403);
  }
});

test('administrator discovery has no implicit dataset-use bypass',async()=>{
  const f=fixture({[local]:[record('theirs',['demo-user-2'])]});f.user.role='admin';
  const version=selected(await f.call({machine:local},{...principal,role:'admin'}),'theirs');
  assert.equal(version.state,'READY');assert.equal(version.canUse,false);assert.equal(version.canPrepare,false);
});

test('new-node deletion hints use the exact member read, never the discovery administrator or another version',async()=>{
  const versions=[{version:hash,state:'READY',deletionPermissions:{memberAllowed:false}},
    {version:otherHash,state:'READY',deletionPermissions:{memberAllowed:true}}];
  const f=fixture({[local]:[record('mine',[principal.userId],versions),record('theirs',['demo-user-2'],versions)]});
  const discovery=f.service.bridge,personalCalls=[];
  f.service.bridge=async(machine,op,args)=>{
    if(args.hostAdmin)return {...await discovery(machine,op,args),datasetDelete:1};
    personalCalls.push({machine,op,args});
    return {datasetDelete:1,datasets:[record('mine',[principal.userId],[{version:hash,state:'READY',deletionPermissions:{memberAllowed:true,reason:'private-proof'}}])]};
  };
  let checked=0;f.service.datasetDeleteCapabilities=async who=>{assert.deepEqual(who,principal);checked++;return {datasetDelete:1};};
  const result=await f.call();assert.equal(result.datasetDelete,1);assert.equal(checked,1);
  assert.deepEqual(personalCalls,[{machine:local,op:'datasets.list',args:{userId:principal.userId,hostAdmin:false}}]);
  assert.deepEqual(selected(result,'mine').locations[0].deletionPermissions,{memberAllowed:true,reason:null});
  assert.equal(selected(result,'mine',otherHash).locations[0].deletionPermissions.memberAllowed,false);
  assert.equal(selected(result,'theirs',otherHash).locations[0].deletionPermissions.memberAllowed,false);
  assert.doesNotMatch(JSON.stringify(result),/private-proof/);
});

test('unconfirmed or foreign member deletion proof fails closed without hiding readable metadata',async()=>{
  for(const proof of [null,{datasetDelete:0,datasets:[record('mine',[principal.userId],[{version:hash,state:'READY',deletionPermissions:{memberAllowed:true}}])]},
    {datasetDelete:1,datasets:[record('mine',['demo-user-2'],[{version:hash,state:'READY',deletionPermissions:{memberAllowed:true}}])]}]){
    const f=fixture({[local]:[record('mine',[principal.userId],[{version:hash,state:'READY',deletionPermissions:{memberAllowed:true}}])]});
    const discovery=f.service.bridge;
    f.service.bridge=async(machine,op,args)=>args.hostAdmin?{...await discovery(machine,op,args),datasetDelete:1}:proof||Promise.reject(Error('private deletion proof'));
    const version=selected(await f.call(),'mine');assert.equal(version.canUse,true);
    assert.equal(version.locations[0].deletionPermissions.memberAllowed,false);
    assert.doesNotMatch(JSON.stringify(version),/private deletion proof/);
  }
});

test('zero-quota catalog remains browseable after every node advertises deletion support',async()=>{
  const f=fixture({[local]:[record('mine',[principal.userId])]},{}),discovery=f.service.bridge;
  f.service.bridge=async(...args)=>({...await discovery(...args),datasetDelete:1});
  f.service.datasetDeleteCapabilities=()=>assert.fail('zero-quota browsing cannot invoke the deletion authorization gate');
  const result=await f.call({});assert.equal(result.datasetDelete,0);
  assert.equal(selected(result,'mine').canUse,false);assert.equal(selected(result,'mine').locations[0].deletionPermissions.memberAllowed,false);
  assert.equal(f.calls.length,MACHINES.length);assert.ok(f.calls.every(call=>call.args.hostAdmin===true));
});

test('deletion capability still requires every catalog node and final account revalidation',async()=>{
  for(const capability of [0,undefined]){
    const f=fixture(),discovery=f.service.bridge;
    f.service.bridge=async(machine,...args)=>({...await discovery(machine,...args),datasetDelete:machine===cold?capability:1});
    f.service.datasetDeleteCapabilities=()=>assert.fail('a legacy or unsupported node blocks the aggregate deletion capability');
    assert.equal((await f.call()).datasetDelete,0);
  }
  const f=fixture(),discovery=f.service.bridge;
  f.service.bridge=async(...args)=>({...await discovery(...args),datasetDelete:1});
  f.service.datasetDeleteCapabilities=async()=>{f.user.enabled=false;return {datasetDelete:1};};
  await assert.rejects(f.call(),e=>e.status===403);
});
