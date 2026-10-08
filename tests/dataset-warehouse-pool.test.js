import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {installDatasetIngress,datasetIngressPolicy} from '../dataset-ingress.mjs';
import {installStorageArchive} from '../storage-archive.mjs';

const first='gpu-1',second='gpu-4',hot='gpu-2';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const spec={name:'training-data',manifestBytes:120,manifestSha256:'a'.repeat(64),totalBytes:1024,entries:3};
const required=spec.totalBytes+spec.manifestBytes*4+spec.entries*8192+65536;
const policy={enabled:true,machine:first,authority:'archive-a',warehouses:[
  {machine:first,authority:'archive-a'},{machine:second,authority:'archive-b'}]};
function fixture(t){
  const db=new DatabaseSync(':memory:'),calls=[],uploads=new Map();
  const user={id:'demo-user-1',username:'reader',enabled:true,role:'member',limits:{[hot]:1}};
  const actor={userId:user.id,username:user.username,role:user.role};
  const f={db,calls,user,actor,available:{[first]:0,[second]:required},inodes:{[first]:1000,[second]:1000}};
  const dataset='u-'+createHash('sha256').update(user.id).digest('hex').slice(0,16)+'-'+spec.name;
  f.dataset=dataset;
  const service=f.service={db,store:{get:id=>id===user.id?structuredClone(user):null},bridge:async(machine,op,args)=>{
    calls.push({machine,op,args});await f.before?.(machine,op,args);
    if(op==='storage.upload.locate'){
      const result={protocol:'dataset-upload-location-v1',machine,userId:args.userId,uploadId:args.uploadId,present:false,
        authority:{enabled:true,machine,authority:args.authority},capacity:{protocol:'dataset-upload-capacity-v1',machine,
          authority:args.authority,specificationSha256:sha(args.specification),requiredBytes:required,
          requiredInodes:spec.entries+16,availableBytes:f.available[machine],availableInodes:f.inodes[machine],writable:true,
          // Display warning is deliberately unrelated to the exact admission.
          warning:{code:'LOW_SPACE',blocking:false}}};
      return f.capacityOverride?.(result)||result;
    }
    if(op==='storage.upload.admit'){
      uploads.set(args.uploadId,machine);
      if(f.lostAdmission){f.lostAdmission=false;throw Error('Lost admission reply');}
      return {uploadId:args.uploadId,...spec,state:'RECEIVING_MANIFEST',manifestOffset:0,chunkBytes:1024*1024,
        admissionProtocol:1,admissionKey:args.intentKey,machine,authority:args.authority,
        uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true}};
    }
    if(op==='datasets.upload.commit'||op==='datasets.upload.status')return {uploadId:args.uploadId,...spec,state:'READY',dataset,version:'b'.repeat(64)};
    if(op==='datasets.upload.chunk')return {offset:1};
    if(op==='storage.archive.original')return {...args,protected:true};
    if(op==='storage.archive.ack')return {id:args.id,acknowledged:true};
    if(op==='storage.archive.events')return {events:[]};
    if(op==='storage.archive.provision')return {opId:args.opId,state:'READY',grant:{id:args.opId,sourceMachine:machine,
      targetMachine:args.targetMachine,...args.source,receipt:{owners:[user.id]}}};
    if(op==='storage.archive.certify')return {opId:args.opId,state:'READY',...args.target,role:'cache',receiptSha256:'c'.repeat(64)};
    throw Error('Unexpected fixture call '+op);
  }};
  f.archive=installStorageArchive(service,{enabled:true,machine:first,authority:'archive-a'},{startTimer:false});
  f.install=input=>f.ingress=installDatasetIngress(service,input);
  f.install(policy);
  f.call=(action,args)=>service.datasetUploadIngress(actor,action,{machine:hot,...args});
  f.create=(key=randomUUID(),extra={})=>f.call('admission.create',{key,...spec,...extra});
  f.begin=id=>f.call('begin',{key:id,...spec});
  f.ready=async()=>{const admission=await f.create();await f.begin(admission.uploadId);
    const ready=await f.call('commit',{uploadId:admission.uploadId});return {admission,ready};};
  t.after(()=>{service.closing=true;db.close();});return f;
}

test('trusted pool rejects duplicate machines/authority aliases and keeps legacy config unchanged',()=>{
  assert.deepEqual(datasetIngressPolicy({enabled:true,machine:first,authority:'archive-a'}),{enabled:true,machine:first,authority:'archive-a'});
  for(const warehouses of [[],[policy.warehouses[1]],[policy.warehouses[0],policy.warehouses[0]],
    [policy.warehouses[0],{machine:second,authority:'archive-a'}],[{machine:first,authority:'archive-a',root:'/any'}]])
    assert.throws(()=>datasetIngressPolicy({...policy,warehouses}),/warehouse pool/);
  const parsed=datasetIngressPolicy(policy);assert(Object.isFrozen(parsed.warehouses));assert(Object.isFrozen(parsed.warehouses[0]));
});

test('first admission picks exact known footprint, ignoring a non-blocking low-space warning',async t=>{
  const f=fixture(t),a=await f.create();
  assert.equal(a.storageMachine,second);assert.equal(f.db.prepare('SELECT count(*) n FROM dataset_upload_admissions').get().n,1);
  const row=f.ingress.load(f.user.id,a.uploadId);
  assert.equal(row.warehousePolicyKey,sha([{enabled:true,machine:second,authority:'archive-b'}]));
  assert.deepEqual(f.calls.map(value=>[value.machine,value.op]),[[first,'storage.upload.locate'],[second,'storage.upload.locate']]);
  assert(f.calls.every(value=>value.args.uploadId===a.uploadId));
  assert.equal(f.user.limits[second],undefined);
  assert.equal(f.calls.some(value=>value.op==='storage.upload.admit'),false);
});

test('first fitting warehouse wins; no balancing, user disk choice or byte fallback',async t=>{
  const f=fixture(t);f.available[first]=required;
  const a=await f.create();assert.equal(a.storageMachine,first);assert.equal(f.calls.length,1);
  f.available[first]=0;f.calls.length=0;
  await f.begin(a.uploadId);assert.equal(f.calls[0].machine,first);
  assert.equal(f.calls.some(value=>value.op==='storage.upload.locate'),false);
});

test('unknown, mismatched, unwritable, inode-short and genuinely full warehouse observations refuse with zero intents',async t=>{
  for(const mode of ['unknown','wrong-hash','wrong-required','unwritable','inodes','full','present']){
    const f=fixture(t);f.available[first]=required;
    f.capacityOverride=value=>{
      if(mode==='unknown')delete value.capacity;
      if(mode==='wrong-hash')value.capacity.specificationSha256='d'.repeat(64);
      if(mode==='wrong-required')value.capacity.requiredBytes=spec.totalBytes;
      if(mode==='unwritable')value.capacity.writable=false;
      if(mode==='inodes')value.capacity.availableInodes=spec.entries+15;
      if(mode==='full')value.capacity.availableBytes=required-1;
      if(mode==='present')value.present=true;
      return value;
    };
    await assert.rejects(f.create(),error=>error.status===503,mode);
    assert.equal(f.db.prepare('SELECT count(*) n FROM dataset_upload_placements').get().n,0,mode);
    assert.equal(f.calls.some(value=>value.op==='storage.upload.admit'),false,mode);
  }
});

test('permission revocation during capacity observation blocks all admission',async t=>{
  const f=fixture(t);f.before=()=>{f.user.limits={};};
  await assert.rejects(f.create(),error=>error.status===403);
  assert.equal(f.calls.length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM dataset_upload_admissions').get().n,0);
});

test('pure absence proof excludes an in-flight pool observation and never creates a second intent',async t=>{
  const f=fixture(t),key=randomUUID();let release,observed;
  const seen=new Promise(resolve=>{observed=resolve;}),held=new Promise(resolve=>{release=resolve;});
  f.before=async()=>{observed();await held;};
  const pending=f.create(key);await seen;
  await assert.rejects(f.call('admission.status',{key}),error=>error.status===503&&error.code===undefined);
  await assert.rejects(f.create(key),error=>error.status===429);
  release();const ready=await pending;
  assert.equal((await f.call('admission.status',{key})).uploadId,ready.uploadId);
  const unused=randomUUID();await assert.rejects(f.call('admission.status',{key:unused}),error=>error.status===404&&error.code==='DATASET_ADMISSION_ABSENT');
});

test('same intent restart, changed pool and lost ACK keep immutable second-warehouse placement',async t=>{
  const f=fixture(t),key=randomUUID(),a=await f.create(key),before=f.calls.length;
  assert.deepEqual(await f.create(key),a);assert.equal(f.calls.length,before);
  f.lostAdmission=true;await assert.rejects(f.begin(a.uploadId),/Lost/);
  f.install({enabled:true,machine:first,authority:'archive-a'});
  await f.begin(a.uploadId);await f.call('chunk',{uploadId:a.uploadId,path:'sample',offset:0,data:'AA=='});
  assert(f.calls.slice(before).every(value=>value.machine===second));
  assert.equal(f.db.prepare('SELECT count(*) n FROM dataset_upload_placements').get().n,1);
  assert.equal(f.calls.filter(value=>value.op==='storage.upload.admit')[0].args.authority,'archive-b');
});

test('removed warehouse cannot dispatch an ISSUED intent or silently allocate another upload',async t=>{
  const f=fixture(t),key=randomUUID(),a=await f.create(key),before=f.calls.length;
  f.install({enabled:true,machine:first,authority:'archive-a'});
  await assert.rejects(f.begin(a.uploadId),/策略已改变/);
  await assert.rejects(f.create(key),/策略已改变/);
  assert.equal(f.calls.length,before);assert.equal(f.ingress.load(f.user.id,a.uploadId).phase,'ISSUED');
});

test('outbox after lost final ACK archives locally at the admitted second warehouse',async t=>{
  const f=fixture(t),a=await f.create();await f.begin(a.uploadId);
  const row=f.archive.enqueueEvent(second,{id:a.uploadId,userId:f.user.id,dataset:f.dataset,version:'b'.repeat(64),state:'READY'});
  assert.equal(row.sourceMachine,second);assert.equal(row.sourceDataset,f.dataset);assert.equal(row.phase,'PROVISIONING');
  assert.equal(row.ingressBinding.uploadId,a.uploadId);
  assert(f.service.datasetIngressSourceAllowed(f.user.id,second,{dataset:f.dataset,version:row.version}));
  await f.archive.advance(row);
  assert.equal(f.archive.load(row.id).phase,'ARCHIVED');
  assert.equal(f.calls.some(value=>value.op==='storage.archive.provision'||value.op.startsWith('transfers.')),false);
  assert(f.calls.filter(value=>value.op.startsWith('storage.archive.')).every(value=>value.machine===second));
});

test('matching but mismatched-source/owner/version outbox cannot become a legacy archive',async t=>{
  const f=fixture(t),{admission:a,ready}=await f.ready();
  const event={id:a.uploadId,userId:f.user.id,...ready,state:'READY'};
  assert.throws(()=>f.archive.enqueueEvent(first,event),/fixed warehouse admission/);
  assert.throws(()=>f.archive.enqueueEvent(second,{...event,dataset:'forged'}),/fixed warehouse admission/);
  assert.throws(()=>f.archive.enqueueEvent(second,{...event,version:'c'.repeat(64)}),/fixed warehouse admission/);
  assert.throws(()=>f.archive.enqueueEvent(second,{...event,userId:'demo-user-99'}),/permission changed/);
  assert.equal(f.archive.rows().length,0);
});

test('cache certification binds the actual transfer source, not the current global warehouse',async t=>{
  const f=fixture(t),{admission:a,ready}=await f.ready();
  const row=f.archive.enqueueEvent(second,{id:a.uploadId,userId:f.user.id,...ready,state:'READY'});
  await f.archive.advance(row);
  const physical={dataset:'replica-data',version:ready.version};
  const before=f.archive.rows().length;
  assert.equal(f.service.enqueueArchiveReplica(f.user.id,hot,ready,physical,{machine:first,dataset:ready.dataset}),null);
  assert.equal(f.archive.rows().length,before);
  f.service.enqueueArchiveReplica(f.user.id,hot,ready,physical,{machine:second,dataset:ready.dataset});
  const replica=f.archive.rows().at(-1);assert.equal(replica.ingressBinding.policyKey,row.policyKey);
  await f.archive.advance(replica);
  const provision=f.calls.find(value=>value.op==='storage.archive.provision');assert.equal(provision.machine,second);
  const certify=f.calls.find(value=>value.op==='storage.archive.certify');assert.equal(certify.machine,hot);
  assert.deepEqual(certify.args.sourcePolicy,{enabled:true,machine:second,authority:'archive-b'});
  assert.equal(f.archive.load(replica.id).phase,'ARCHIVED');
  assert.deepEqual(f.service.archiveOriginalForCopy(f.user.id,hot,physical),{machine:second,dataset:ready.dataset,version:ready.version});
  assert.equal(f.service.archiveOriginalForCopy('demo-user-99',hot,physical),null);
  assert.equal(f.service.archiveOriginalForCopy(f.user.id,first,physical),null);
  assert.equal(f.service.archiveOriginalForCopy(f.user.id,hot,{...physical,version:'d'.repeat(64)}),null);
  // A READY, certified cache may serve bytes too. Preserve its original
  // authority, rather than rejecting it or choosing by logical name alone.
  f.user.limits['gpu-3']=1;
  const next={dataset:'second-cache',version:ready.version};
  f.service.enqueueArchiveReplica(f.user.id,'gpu-3',ready,next,{machine:hot,dataset:physical.dataset});
  const cacheCopy=f.archive.rows().at(-1);assert.equal(cacheCopy.sourceMachine,second);
  assert.equal(cacheCopy.sourceDataset,ready.dataset);assert.deepEqual(cacheCopy.ingressBinding,row.ingressBinding);
  await f.archive.advance(cacheCopy);assert.equal(f.archive.load(cacheCopy.id).phase,'ARCHIVED');
  assert.deepEqual(f.service.archiveOriginalForCopy(f.user.id,'gpu-3',next),{machine:second,dataset:ready.dataset,version:ready.version});
});

test('disabling intake preserves historical source proof and finishes the original BOUND archive only',async t=>{
  const f=fixture(t),{admission:a,ready}=await f.ready();
  f.install({enabled:false});
  const row=f.archive.enqueueEvent(second,{id:a.uploadId,userId:f.user.id,...ready,state:'READY'});
  await f.archive.advance(row);
  assert.equal(f.service.archiveState(f.user.id,second,ready).originalRetained,true);
  assert.equal(f.service.archiveSourceAllowed(f.user.id,second,ready),true);
  assert.equal(f.service.archiveAliases(f.user.id,second).get(ready.dataset+'@'+ready.version),ready.dataset);
  await assert.rejects(f.create(),error=>error.status===503);
  assert(f.calls.filter(value=>value.op.startsWith('storage.archive.')).every(value=>value.machine===second));
  f.install({enabled:true,machine:first,authority:'archive-a'});
  assert.equal(f.service.archiveState(f.user.id,second,ready).originalRetained,true);
});

test('pool enablement does not reinterpret old journals, pins, policy hashes or unmatched events',async t=>{
  const f=fixture(t);f.user.limits[second]=1;
  const old=f.archive.enqueueEvent(second,{id:randomUUID(),userId:f.user.id,dataset:'old-data',version:'e'.repeat(64),state:'READY'});
  assert.equal(old.ingressBinding,undefined);assert.equal(old.sourceMachine,first);
  assert.equal(old.policyKey,sha([{enabled:true,machine:first,authority:'archive-a'}]));
  const saved=JSON.stringify(old);f.install(policy);
  assert.equal(JSON.stringify(f.archive.load(old.id)),saved);
});
