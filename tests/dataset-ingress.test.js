import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {executionCall} from '../execution.mjs';
import {datasetIngressPolicy,installDatasetIngress} from '../dataset-ingress.mjs';
import {installStorageArchive} from '../storage-archive.mjs';
import {uploadStorageMachine} from '../dist/upload-routes.js';
import {installTransfers,transferCall} from '../transfers.mjs';
import {installDatasetReplication} from '../dataset-replication.mjs';
import {datasetCatalogCall} from '../dataset-catalog.mjs';

const hot='gpu-1',cold='gpu-4',other='gpu-2';
const spec={name:'my-data',manifestBytes:100,manifestSha256:'a'.repeat(64),totalBytes:12,entries:2};
function fixture(t,{enabled=true}={}){
  const db=new DatabaseSync(':memory:'),calls=[],sessions=new Map();
  const user={id:'demo-user-1',username:'member',enabled:true,role:'member',limits:{[hot]:1}};
  const principal={userId:user.id,username:user.username,role:user.role};
  const f={db,calls,sessions,user,principal};
  const dataset='u-'+createHash('sha256').update(user.id).digest('hex').slice(0,16)+'-'+spec.name;
  const service={db,store:{get:id=>id===user.id?structuredClone(user):null},audit:()=>{},storageArchivePolicy:{enabled:true,machine:cold,authority:'hdd'},bridge:async(machine,operation,args)=>{
    calls.push({machine,operation,args});await f.before?.(machine,operation,args);
    const id=args.uploadId||args.key,key=machine+'/'+args.userId+'/'+id;
    if(operation==='storage.upload.locate')return {protocol:'dataset-upload-location-v1',machine,userId:args.userId,uploadId:args.uploadId,
      uploadAdmissionProtocol:1,initializationProtocol:1,nodePresent:sessions.has(key),
      authority:{enabled:machine===cold,machine,authority:'hdd'},present:sessions.has(key),
      ...(sessions.has(key)?{specification:sessions.get(key).spec,
        ...(sessions.get(key).marker?{admissionProtocol:1,admissionKey:sessions.get(key).marker.intentKey,
          requestedMachine:sessions.get(key).marker.requestedMachine,storageMachine:machine,admissionAuthority:'hdd'}:{})}:{state:'NOT_INITIALIZED'})};
    if(operation==='datasets.upload.routes')return {available:true,protocol:'dataset-upload-v1',machine,revision:'b'.repeat(64),certificateSha256:'c'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:'https://warehouse.example'}]};
    if(operation==='datasets.upload.begin'){
      if(!sessions.has(key))sessions.set(key,{spec:structuredClone(spec),state:'RECEIVING_MANIFEST'});
      return {uploadId:args.key,...spec,state:sessions.get(key).state,manifestOffset:0,uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true,routeSelection:true}};
    }
    if(operation==='storage.upload.admit'){
      assert.equal(machine,cold);assert.equal(args.protocol,'dataset-upload-admission-v1');assert.equal(args.requestedMachine,hot);assert.equal(args.storageMachine,cold);assert.equal(args.authority,'hdd');
      assert.deepEqual(args.specification,spec);assert.equal(args.specificationSha256,createHash('sha256').update(JSON.stringify(spec)).digest('hex'));
      const row=JSON.parse(db.prepare('SELECT data FROM dataset_upload_placements WHERE owner=? AND upload_id=?').get(args.userId,id).data);assert.equal(row.phase,'BOUND');assert.equal(row.admissionKey,args.intentKey);
      if(!sessions.has(key))sessions.set(key,{spec:structuredClone(args.specification),state:'RECEIVING_MANIFEST'});
      sessions.get(key).marker=structuredClone(args);
      return {uploadId:id,...spec,state:sessions.get(key).state,manifestOffset:0,chunkBytes:1024*1024,admissionProtocol:1,admissionKey:args.intentKey,machine,authority:'hdd',uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true,routeSelection:true}};
    }
    if(operation==='datasets.upload.chunk')return {offset:args.offset+Buffer.from(args.data,'base64').length};
    if(operation==='datasets.upload.direct-ticket')return {available:true,machine,uploadId:args.uploadId};
    const session=sessions.get(key);if(!session)throw Error('Unknown fixture upload');
    if(operation==='datasets.upload.commit')session.state='READY';
    if(operation==='datasets.upload.discard')session.state='DISCARDED';
    return {uploadId:args.uploadId,...spec,state:session.state,...(session.state==='READY'?{dataset,version:'d'.repeat(64)}:{})};
  }};
  f.service=service;f.ingress=installDatasetIngress(service,enabled?{enabled:true,machine:cold,authority:'hdd'}:undefined);
  f.call=(action,args)=>executionCall(service,principal,'datasets.upload.'+action,{machine:hot,...args});
  f.begin=key=>f.call('begin',{key,...spec});
  f.create=()=>f.call('admission.create',{key:randomUUID(),...spec});
  f.fresh=async()=>{const issued=await f.create();await f.begin(issued.uploadId);return issued.uploadId;};
  t.after(()=>db.close());return f;
}

test('new standard upload writes directly to fixed HDD and never admits the selected SSD',async t=>{
  const f=fixture(t),issued=await f.create(),id=issued.uploadId,begin=await f.begin(id);
  assert.equal(begin.requestedMachine,hot);assert.equal(begin.storageMachine,cold);assert.equal(begin.storageTier,'hdd');
  assert.equal(begin.legacyPlacement,false);assert.equal(f.user.limits[cold],undefined);
  assert.equal(f.calls.filter(call=>call.operation==='storage.upload.admit').length,1);
  assert.equal(f.calls.find(call=>call.operation==='storage.upload.admit').machine,cold);
  assert.equal(f.calls.some(call=>call.operation==='datasets.upload.begin'||call.operation==='storage.upload.locate'),false);
  await f.call('chunk',{uploadId:id,path:'data.bin',offset:0,data:Buffer.from('hello').toString('base64')});
  const routes=await f.call('routes',{uploadId:id});assert.equal(routes.machine,cold);
  assert.equal('uploadId' in f.calls.at(-1).args,false,'node route wire contract is unchanged');
  await f.call('direct-ticket',{uploadId:id});assert.equal(f.calls.at(-1).machine,cold);
  const ready=await f.call('commit',{uploadId:id});
  assert.equal(f.service.datasetIngressSourceAllowed(f.user.id,cold,ready),true);
  assert.equal(f.service.datasetIngressSourceAllowed(f.user.id,cold,{...ready,version:'e'.repeat(64)}),false);
  assert.equal(f.service.datasetIngressSourceAllowed(f.user.id,hot,ready),false);
  assert.equal(f.user.limits[cold],undefined,'data source rights do not grant warehouse GPU or terminal rights');
});

test('durable placement survives lost admission ACK and policy disable without a second node admission',async t=>{
  const f=fixture(t),issued=await f.create(),id=issued.uploadId;let lost=true;
  const bridge=f.service.bridge;
  f.service.bridge=async(...args)=>{const result=await bridge(...args);if(args[1]==='storage.upload.admit'&&lost){lost=false;throw Error('Lost acknowledgement');}return result;};
  await assert.rejects(f.begin(id),/Lost/);
  assert.equal(f.ingress.load(f.user.id,id).storageMachine,cold);
  f.ingress=installDatasetIngress(f.service,undefined);
  const resumed=await f.begin(id);assert.equal(resumed.storageMachine,cold);
  await f.call('status',{uploadId:id});
  assert.equal(f.sessions.size,1);assert(f.calls.filter(call=>call.operation.startsWith('datasets.upload.')).every(call=>call.machine===cold));
});

test('old SSD session remains on its exact original node; unknown lookup never means absent',async t=>{
  const f=fixture(t),id=randomUUID();
  f.sessions.set(hot+'/'+f.user.id+'/'+id,{spec,state:'UPLOADING'});
  const old=await f.begin(id);assert.equal(old.storageMachine,hot);assert.equal(old.storageTier,'existing');
  await f.call('chunk',{uploadId:id,path:'data.bin',offset:0,data:'AA=='});
  assert.equal(f.calls.at(-1).machine,hot);assert.equal(f.sessions.size,1);
  const fresh=randomUUID();f.before=(machine,operation)=>{if(machine===other&&operation==='storage.upload.locate')throw Error('Node timeout');};
  await assert.rejects(f.begin(fresh),/Node timeout/);
  assert.equal(f.ingress.load(f.user.id,fresh).phase,'LOCATING');
  assert.equal(f.calls.filter(call=>call.operation==='datasets.upload.begin'&&call.args.key===fresh).length,0);
  f.before=undefined;await assert.rejects(f.begin(fresh),error=>error.status===409&&/所有节点均不存在/.test(error.message));
  assert.equal(f.ingress.load(f.user.id,fresh).phase,'LOCATING');assert.equal(f.sessions.size,1);
  assert.equal(f.calls.some(call=>call.operation==='datasets.upload.begin'&&call.args.key===fresh),false);
});

test('ambiguous old key, changed manifest, selected machine and client placement injection fail closed',async t=>{
  const f=fixture(t),id=await f.fresh();
  const count=f.calls.length;
  await assert.rejects(f.call('begin',{key:id,...spec,totalBytes:99}),/另一份清单/);
  f.user.limits[other]=1;
  await assert.rejects(f.call('status',{machine:other,uploadId:id}),/原先选择/);
  await assert.rejects(f.call('status',{uploadId:id,storageMachine:hot}),/参数/);
  assert.equal(f.calls.length,count);
  const duplicate=randomUUID();
  for(const machine of [hot,cold])f.sessions.set(machine+'/'+f.user.id+'/'+duplicate,{spec,state:'UPLOADING'});
  await assert.rejects(f.begin(duplicate),/多台/);
  assert.equal(f.calls.some(call=>call.operation==='datasets.upload.begin'&&call.args.key===duplicate),false);
});

test('revocation during location and after READY removes source permission without rerouting',async t=>{
  const f=fixture(t),legacy=randomUUID();
  f.before=(_machine,operation)=>{if(operation==='storage.upload.locate')f.user.limits={};};
  await assert.rejects(f.begin(legacy),/授权/);
  assert.equal(f.sessions.size,0);
  f.user.limits[hot]=1;f.before=undefined;const id=await f.fresh();
  const ready=await f.call('commit',{uploadId:id});assert(f.service.datasetIngressSourceAllowed(f.user.id,cold,ready));
  f.user.limits={};assert.equal(f.service.datasetIngressSourceAllowed(f.user.id,cold,ready),false);
  await assert.rejects(f.call('direct-ticket',{uploadId:id}),/未授权/);
});

test('read-only unknown status creates no durable placement or node upload; disabled policy keeps old wire contract',async t=>{
  const f=fixture(t);await assert.rejects(f.call('status',{uploadId:randomUUID()}),/不存在/);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM dataset_upload_placements').get().count,0);
  assert.equal(f.sessions.size,0);
  const off=fixture(t,{enabled:false}),id=randomUUID();
  const result=await off.begin(id);assert.equal(result.placementProtocol,undefined);
  assert.deepEqual(off.calls.map(call=>call.operation),['datasets.upload.begin']);assert.equal(off.calls[0].machine,hot);
  await off.call('routes',{uploadId:id});assert.equal(off.calls.at(-1).args.uploadId,undefined);
});

test('warehouse admission requires its independently configured authority and does not reinterpret archive policy hashes',async t=>{
  const f=fixture(t);
  const archive=installStorageArchive(f.service,{enabled:true,machine:cold,authority:'hdd'},{startTimer:false});
  const id=await f.fresh(),ready=await f.call('commit',{uploadId:id});
  const row=archive.enqueueEvent(cold,{id:randomUUID(),userId:f.user.id,state:'READY',dataset:ready.dataset,version:ready.version});
  const expected=createHash('sha256').update(JSON.stringify([{enabled:true,machine:cold,authority:'hdd'}])).digest('hex');
  assert.equal(row.policyKey,expected);assert.equal(row.phase,'PROVISIONING');
  assert.throws(()=>installDatasetIngress(f.service,{enabled:true,machine:other,authority:'hdd'}),/existing fixed/);
  assert.throws(()=>datasetIngressPolicy({enabled:true,machine:cold,authority:'hdd',root:'/tmp'}),/Invalid/);
  const unavailable=fixture(t),bridge=unavailable.service.bridge;
  unavailable.service.bridge=async(...args)=>{if(args[0]===cold&&args[1]==='storage.upload.admit')throw Error('机械仓库 authority 未确认');return bridge(...args);};
  await assert.rejects(unavailable.fresh(),/机械仓库/);assert.equal(unavailable.sessions.size,0);
});

test('transient original-protection failure does not revoke an exact warehouse upload source',async t=>{
  const f=fixture(t),id=await f.fresh(),ready=await f.call('commit',{uploadId:id});
  const archive=installStorageArchive(f.service,{enabled:true,machine:cold,authority:'hdd'},{startTimer:false});
  const row=archive.enqueueEvent(cold,{id:randomUUID(),userId:f.user.id,state:'READY',dataset:ready.dataset,version:ready.version});
  const bridge=f.service.bridge;
  f.service.bridge=(machine,operation,args)=>{
    if(operation==='storage.archive.events')return Promise.resolve({events:[]});
    if(operation==='storage.archive.original')throw Error('Temporary warehouse timeout');
    return bridge(machine,operation,args);
  };
  await f.service.reconcileStorageArchive();
  const retry=archive.load(row.id);assert.equal(retry.phase,'PROVISIONING');assert.equal(retry.failures,1);
  assert.equal(f.service.datasetIngressSourceAllowed(f.user.id,cold,ready),true);
  assert.doesNotThrow(()=>f.service.retryStorageArchive(f.user.id,cold,ready));
  assert.equal(f.user.limits[cold],undefined);
});

test('placement-aware clients bind actual direct writer while retaining training selection',()=>{
  const reply={placementProtocol:1,requestedMachine:hot,storageMachine:cold,storageTier:'hdd',legacyPlacement:false};
  assert.equal(uploadStorageMachine(reply,hot),cold);
  assert.equal(uploadStorageMachine(reply,hot,cold),cold);
  assert.equal(uploadStorageMachine({},hot),hot);
  assert.throws(()=>uploadStorageMachine({...reply,storageMachine:other},hot,cold),/changed/);
  assert.throws(()=>uploadStorageMachine({...reply,requestedMachine:other},hot),/unconfirmed/);
  assert.throws(()=>uploadStorageMachine({...reply,legacyPlacement:true},hot),/unconfirmed/);
});

test('unresolved legacy LOCATING cannot create a fresh session after its policy is disabled',async t=>{
  const f=fixture(t),id=randomUUID();
  f.before=(machine,operation)=>{if(machine===other&&operation==='storage.upload.locate')throw Error('Node unavailable');};
  await assert.rejects(f.begin(id),/unavailable/);f.before=undefined;
  installDatasetIngress(f.service,undefined);
  await assert.rejects(f.begin(id),error=>error.status===409&&/所有节点均不存在/.test(error.message));assert.equal(f.sessions.size,0);
  assert.equal(f.ingress.load(f.user.id,id).phase,'LOCATING');assert.ok(f.calls.every(call=>call.operation==='storage.upload.locate'));
});

test('cancellation and ticket revocation stay on the durable writer rather than the training selector',async t=>{
  const f=fixture(t),id=await f.fresh();
  await f.call('direct-revoke',{uploadId:id});assert.equal(f.calls.at(-1).machine,cold);
  const discarded=await f.call('discard',{uploadId:id});assert.equal(discarded.storageMachine,cold);
  assert.equal(discarded.state,'DISCARDED');assert.equal(f.service.datasetIngressMachineVisible(f.user.id,cold),false);
  f.calls.length=0;await f.call('status',{uploadId:id});
  assert.deepEqual(f.calls.map(call=>call.machine),[cold,cold]);assert.deepEqual(f.calls.map(call=>call.operation),['storage.upload.locate','datasets.upload.status']);
});

test('READY warehouse is an exact usable copy source without granting compute; preparation selects that source',async t=>{
  const f=fixture(t),id=await f.fresh(),ready=await f.call('commit',{uploadId:id});
  const bridge=f.service.bridge;f.service.store.users=[f.user];
  f.service.bridge=(machine,operation,args)=>{
    if(operation==='transfers.capabilities')return Promise.resolve({protocol:'lan-transfer-v1',enabled:true,sourceReady:true,sources:[cold,other]});
    if(operation==='datasets.list')return Promise.resolve({datasets:machine===cold?[{dataset:ready.dataset,ownerIds:[f.user.id],versions:[{version:ready.version,state:'READY',canPrepare:true}]}]:[]});
    if(operation==='datasets.status')return Promise.resolve({dataset:args.dataset,version:args.version,state:'REGISTERED'});
    return bridge(machine,operation,args);
  };
  installTransfers(f.service);t.after(()=>clearInterval(f.service.transferTimer));
  const capabilities=await transferCall(f.service,f.principal,'transfers.capabilities',{machine:hot});
  assert.deepEqual(capabilities.sources,[cold]);assert.equal(f.user.limits[cold],undefined);
  let copy;
  f.service.transferCall=(principal,operation,args)=>operation==='transfers.capabilities'?transferCall(f.service,principal,operation,args):
    (copy=args,Promise.resolve({id:randomUUID(),state:'RUNNING'}));
  const catalog=await datasetCatalogCall(f.service,f.principal,'datasets.catalog',{machine:hot});
  const version=catalog.datasets[0].versions[0];assert.equal(version.canUse,true);assert.equal(version.canPrepare,true);
  assert.equal(version.sourceMachine,cold);assert.equal(version.locations[0].canPrepare,false);
  installDatasetReplication(f.service);
  assert.equal((await f.service.prepareDataset(f.user.id,hot,{dataset:ready.dataset,version:ready.version})).state,'PREPARING');
  assert.equal(copy.from,cold);assert.equal(copy.machine,hot);assert.equal(copy.dataset,ready.dataset);assert.equal(copy.version,ready.version);
});
