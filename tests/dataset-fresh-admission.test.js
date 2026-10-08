import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executionCall} from '../execution.mjs';
import {installDatasetIngress} from '../dataset-ingress.mjs';
import {installMaintenance} from '../maintenance.mjs';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';

const hot='gpu-1',cold='gpu-4',offline='gpu-2';
const spec={name:'fresh-data',manifestBytes:100,manifestSha256:'a'.repeat(64),totalBytes:12,entries:2};
const policy={enabled:true,machine:cold,authority:'hdd'};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(t,{persistent=false}={}){
  const directory=persistent?mkdtempSync(join(tmpdir(),'stargate-fresh-admission-')):null;
  const database=directory?join(directory,'portal.sqlite'):':memory:';
  const user={id:'demo-user-1',username:'member',enabled:true,role:'member',limits:{[hot]:1}};
  const second={...user,id:'demo-user-2',username:'second'},users=[user,second];
  const principal={userId:user.id,username:user.username,role:user.role};
  const calls=[],sessions=new Map();
  const f={user,second,principal,calls,sessions};
  const service={db:new DatabaseSync(database),store:{users,get:id=>structuredClone(users.find(user=>user.id===id))},
    audit:()=>{},storageArchivePolicy:{...policy},bridge:async(machine,operation,args)=>{
      calls.push({machine,operation,args:structuredClone(args)});
      if(operation==='storage.upload.admit'){
        const stored=JSON.parse(service.db.prepare('SELECT data FROM dataset_upload_placements WHERE owner=? AND upload_id=?').get(args.userId,args.uploadId).data);
        assert.equal(stored.phase,'BOUND','fixed intent must be durable before node admission');
        assert.equal(service.db.prepare('SELECT upload_id FROM dataset_upload_admissions WHERE owner=? AND intent_key=?').get(args.userId,args.intentKey).upload_id,args.uploadId);
        assert.equal(machine,cold);assert.equal(args.hostAdmin,false);assert.equal(args.protocol,'dataset-upload-admission-v1');
        assert.equal(args.requestedMachine,hot);assert.equal(args.storageMachine,cold);assert.equal(args.authority,'hdd');
        assert.deepEqual(args.specification,spec);assert.equal(args.specificationSha256,digest(spec));
      }
      await f.before?.(machine,operation,args);
      const id=args.uploadId||args.key,key=machine+'/'+args.userId+'/'+id;
      if(operation==='storage.upload.locate')return {protocol:'dataset-upload-location-v1',machine,userId:args.userId,uploadId:id,
        uploadAdmissionProtocol:1,authority:{enabled:machine===cold,machine,authority:'hdd'},present:sessions.has(key),
        ...(sessions.has(key)?{specification:sessions.get(key).spec,...(sessions.get(key).marker?{
          initializationProtocol:1,nodePresent:true,admissionProtocol:1,admissionKey:sessions.get(key).marker.intentKey,
          requestedMachine:hot,storageMachine:cold,admissionAuthority:'hdd'}:{})}:
          machine===cold?{state:'NOT_INITIALIZED',initializationProtocol:1,nodePresent:false}:{})};
      if(operation==='storage.upload.admit'){
        const marker={...args};delete marker.allowRelay;
        const prior=sessions.get(key);
        if(prior&&!prior.marker)throw Error('Legacy session cannot become fresh');
        if(prior)assert.deepEqual(prior.marker,marker);
        else sessions.set(key,{spec:structuredClone(args.specification),marker,state:'RECEIVING_MANIFEST'});
      }else if(operation==='datasets.upload.begin'){
        if(!sessions.has(key))sessions.set(key,{spec:structuredClone(spec),state:'RECEIVING_MANIFEST'});
      }
      const session=sessions.get(key);
      if(!session)throw Object.assign(Error('Unknown node upload'),{status:404});
      if(operation==='datasets.upload.commit')session.state='READY';
      if(operation==='datasets.upload.discard')session.state='DISCARDED';
      const result={uploadId:id,...session.spec,state:session.state,manifestOffset:0,chunkBytes:1024*1024,
        ...(session.state==='READY'?{dataset:'u-'+createHash('sha256').update(args.userId).digest('hex').slice(0,16)+'-'+spec.name,version:'b'.repeat(64)}:{}),
        ...(operation==='storage.upload.admit'?{admissionProtocol:1,admissionKey:args.intentKey,machine,authority:'hdd',
          uploadTransport:{protocol:'dataset-upload-v1',directAvailable:false,reason:'disabled'}}:{})};
      await f.after?.(machine,operation,args,result);
      return result;
    }};
  f.service=service;f.ingress=installDatasetIngress(service,policy);
  f.call=(action,args,actor=principal)=>executionCall(service,actor,'datasets.upload.'+action,{machine:hot,...args});
  f.create=(key=randomUUID())=>f.call('admission.create',{key,...spec});
  f.begin=id=>f.call('begin',{key:id,...spec});
  f.rows=()=>service.db.prepare('SELECT * FROM dataset_upload_placements').all();
  f.mappings=()=>service.db.prepare('SELECT * FROM dataset_upload_admissions').all();
  f.reopen=(...args)=>{assert(directory);service.db.close();service.db=new DatabaseSync(database);f.ingress=installDatasetIngress(service,args.length?args[0]:policy);};
  t.after(()=>{service.db.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  return f;
}

test('fresh issuance atomically binds a distinct server UUID before any node RPC; intent reads are pure',async t=>{
  const f=fixture(t),key=randomUUID(),issued=await f.create(key);
  assert.notEqual(issued.uploadId,key);assert.match(issued.uploadId,/^[a-f0-9-]{36}$/);
  assert.deepEqual(issued,{protocol:'dataset-upload-admission-v1',key,uploadId:issued.uploadId,requestedMachine:hot,storageMachine:cold,storageTier:'hdd',specification:spec,state:'ISSUED'});
  assert.equal(f.calls.length,0);assert.equal(f.rows().length,1);assert.equal(f.mappings().length,1);
  const before=f.rows();assert.deepEqual(await f.call('admission.status',{key}),issued);
  assert.deepEqual(await f.create(key),issued);assert.deepEqual(f.rows(),before);assert.equal(f.calls.length,0);
  await assert.rejects(f.call('admission.status',{key:randomUUID()}),error=>error.status===404);
  assert.deepEqual(f.rows(),before);assert.equal(f.mappings().length,1);assert.equal(f.calls.length,0);
});

test('issuance and intent recovery do not require a configured execution bridge',async t=>{
  const f=fixture(t);f.service.bridge=null;
  const issued=await f.create();assert.deepEqual(await f.call('admission.status',{key:issued.key}),issued);
  await assert.rejects(f.begin(issued.uploadId),error=>error.status===503);
  assert.equal(f.ingress.load(f.user.id,issued.uploadId).phase,'ISSUED');
});

test('fresh admission ignores an unrelated offline node; legacy original IDs still fail all-node lookup',async t=>{
  const f=fixture(t);f.before=(machine)=>{if(machine===offline)throw Error('Offline node is unknown, not absent');};
  const issued=await f.create();const begun=await f.begin(issued.uploadId);
  assert.equal(begun.uploadId,issued.uploadId);assert.equal(begun.storageMachine,cold);
  assert.deepEqual(f.calls.map(row=>[row.machine,row.operation]),[[cold,'storage.upload.admit']]);
  const old=randomUUID();await assert.rejects(f.begin(old),/Offline node/);
  assert.equal(f.ingress.load(f.user.id,old).phase,'LOCATING');
  assert.equal(f.calls.some(row=>row.operation==='datasets.upload.begin'&&row.args.key===old),false);
});

test('caller-forged fresh UUID with all nodes ABSENT never creates a bare session or relabels LOCATING',async t=>{
  const f=fixture(t),forged=randomUUID();
  for(let attempt=0;attempt<2;attempt++){
    await assert.rejects(f.begin(forged),error=>error.status===409&&/所有节点均不存在/.test(error.message));
    assert.equal(f.ingress.load(f.user.id,forged).phase,'LOCATING');
    assert.equal(f.sessions.size,0);assert.equal(f.mappings().length,0);assert.equal(f.rows().length,1);
    assert.ok(f.calls.length>1);assert.ok(f.calls.every(row=>row.operation==='storage.upload.locate'&&row.args.uploadId===forged));
  }
});

test('fixed HDD outage or unsupported private protocol never falls back to bare begin or another ID',async t=>{
  for(const failure of ['HDD unavailable','Unsupported private operation']){
    const f=fixture(t),issued=await f.create();f.before=()=>{throw Error(failure);};
    await assert.rejects(f.begin(issued.uploadId),new RegExp(failure));
    assert.equal(f.sessions.size,0);assert.equal(f.mappings().length,1);
    assert.equal((await f.call('admission.status',{key:issued.key})).uploadId,issued.uploadId);
    assert.deepEqual(f.calls.map(row=>[row.machine,row.operation]),[[cold,'storage.upload.admit']]);
  }
});

test('lost issuance acknowledgement survives database reopen and resolves only the original intent',async t=>{
  const f=fixture(t,{persistent:true}),issued=await f.create();
  f.reopen();const recovered=await f.call('admission.status',{key:issued.key});
  assert.deepEqual(recovered,issued);assert.equal(f.calls.length,0);
  await f.begin(recovered.uploadId);assert.equal(f.sessions.size,1);assert.equal(f.mappings().length,1);
});

test('lost node admission ACK survives restart and policy disable with the same marker and writer',async t=>{
  const f=fixture(t,{persistent:true}),issued=await f.create();let lost=true;
  f.after=(_machine,operation)=>{if(operation==='storage.upload.admit'&&lost){lost=false;throw Error('Lost node ACK');}};
  await assert.rejects(f.begin(issued.uploadId),/Lost node ACK/);assert.equal(f.sessions.size,1);
  f.reopen(undefined);
  const recovered=await f.call('admission.status',{key:issued.key});assert.equal(recovered.state,'BOUND');
  assert.equal((await f.begin(issued.uploadId)).uploadId,issued.uploadId);
  await f.call('status',{uploadId:issued.uploadId});await f.call('discard',{uploadId:issued.uploadId});
  assert.equal(f.sessions.size,1);assert.equal(f.mappings().length,1);
  assert(f.calls.every(row=>row.machine===cold));assert.equal(f.calls.some(row=>row.operation==='datasets.upload.begin'),false);
  assert.equal(f.calls.filter(row=>row.operation==='storage.upload.locate').length,1,'status separately confirms the exact node admission');
});

test('changed policy or authority before first dispatch leaves ISSUED intent untouched and performs zero RPC',async t=>{
  for(const change of ['disabled','machine','authority','archive']){
    const f=fixture(t),issued=await f.create(),before=f.rows();
    if(change==='archive')f.service.storageArchivePolicy={...policy,authority:'another'};
    else{
      const next=change==='disabled'?undefined:change==='machine'?{...policy,machine:offline}:{...policy,authority:'another'};
      if(next)f.service.storageArchivePolicy={...next};
      f.ingress=installDatasetIngress(f.service,next);
    }
    await assert.rejects(f.begin(issued.uploadId),/策略已改变/);
    await assert.rejects(f.create(issued.key),/策略已改变/);
    assert.deepEqual(f.rows(),before);assert.equal(f.calls.length,0);
    assert.equal((await f.call('admission.status',{key:issued.key})).uploadId,issued.uploadId);
  }
});

test('same intent cannot change the manifest, training selection or public identity fields',async t=>{
  const f=fixture(t),issued=await f.create(),before=f.rows();f.user.limits[offline]=1;
  await assert.rejects(f.call('admission.create',{key:issued.key,...spec,totalBytes:13}),/另一份清单/);
  await assert.rejects(f.call('admission.status',{key:issued.key,machine:offline}),/原先选择/);
  await assert.rejects(f.call('admission.create',{key:issued.key,machine:offline,...spec}),/原先选择/);
  await assert.rejects(f.begin(issued.uploadId+'x'),/完整 UUID/);
  for(const injection of [{fresh:true},{uploadId:randomUUID()},{ownerId:f.second.id},{storageMachine:hot},{authority:'other'},{hostAdmin:true},{protocol:'dataset-upload-admission-v1'}])
    await assert.rejects(f.call('admission.create',{key:randomUUID(),...spec,...injection}),/参数/);
  await assert.rejects(f.call('admission.status',{key:issued.key,uploadId:issued.uploadId}),/参数/);
  await assert.rejects(f.call('begin',{key:issued.uploadId,...spec,entries:3}),/另一份清单/);
  assert.deepEqual(f.rows(),before);assert.equal(f.calls.length,0);
});

test('unsafe specifications cannot issue an identity and caller ownership cannot read another mapping',async t=>{
  const f=fixture(t),issued=await f.create();
  for(const changes of [{name:'中'},{manifestBytes:0},{manifestBytes:Number.MAX_SAFE_INTEGER+1},{manifestSha256:'x'.repeat(64)},
    {totalBytes:-1},{totalBytes:Number.MAX_SAFE_INTEGER+1},{entries:500001},{entries:true},{name:null}])
    await assert.rejects(f.call('admission.create',{key:randomUUID(),...spec,...changes}));
  const second={userId:f.second.id,username:f.second.username,role:'member'};
  await assert.rejects(f.call('admission.status',{key:issued.key},second),error=>error.status===404);
  const theirs=await f.call('admission.create',{key:issued.key,...spec},second);
  assert.notEqual(theirs.uploadId,issued.uploadId);assert.equal(f.mappings().length,2);assert.equal(f.calls.length,0);
  f.user.limits={};await assert.rejects(f.call('admission.status',{key:issued.key}),error=>error.status===403);
  await assert.rejects(f.create(randomUUID()),error=>error.status===403);
  f.user.limits={[hot]:1};f.user.enabled=false;await assert.rejects(f.begin(issued.uploadId),error=>error.status===403);
});

test('mapping insert failure rolls back the paired placement, and dispatch persistence failure performs zero RPC',async t=>{
  const f=fixture(t);f.service.db.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON dataset_upload_admissions BEGIN SELECT RAISE(ABORT,'mapping persistence failed'); END");
  await assert.rejects(f.create(),/mapping persistence failed/);assert.equal(f.rows().length,0);assert.equal(f.mappings().length,0);assert.equal(f.calls.length,0);
  f.service.db.exec('DROP TRIGGER reject_admission');const issued=await f.create();
  f.service.db.exec("CREATE TRIGGER reject_bound BEFORE UPDATE ON dataset_upload_placements BEGIN SELECT RAISE(ABORT,'dispatch persistence failed'); END");
  await assert.rejects(f.begin(issued.uploadId),/dispatch persistence failed/);
  assert.equal(f.ingress.load(f.user.id,issued.uploadId).phase,'ISSUED');assert.equal(f.calls.length,0);
});

test('concurrent identical intents issue one upload and concurrent node begins do not duplicate admission',async t=>{
  const f=fixture(t),key=randomUUID(),issued=await Promise.all(Array.from({length:8},()=>f.create(key)));
  assert.equal(new Set(issued.map(row=>row.uploadId)).size,1);assert.equal(f.mappings().length,1);
  let unblock;f.before=()=>new Promise(resolve=>{unblock=resolve;});
  const pending=f.begin(issued[0].uploadId);await Promise.resolve();
  try{await assert.rejects(f.begin(issued[0].uploadId),error=>error.status===429);
    assert.equal((await f.call('admission.status',{key})).uploadId,issued[0].uploadId);
  }finally{unblock();}
  await pending;assert.equal(f.calls.length,1);assert.equal(f.sessions.size,1);
});

test('Node rejection of an existing legacy session cannot relabel or replace it',async t=>{
  const f=fixture(t),issued=await f.create(),key=cold+'/'+f.user.id+'/'+issued.uploadId;
  f.sessions.set(key,{spec,state:'UPLOADING'});const before=structuredClone([...f.sessions]);
  await assert.rejects(f.begin(issued.uploadId),/Legacy session/);
  assert.deepEqual([...f.sessions],before);assert.equal(f.mappings().length,1);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'storage.upload.admit');
});

test('malformed or cross-bound private admission receipts are unconfirmed, never a reroute or READY source',async t=>{
  for(const changes of [{admissionProtocol:0},{admissionKey:randomUUID()},{uploadId:randomUUID()},{machine:hot},{authority:'other'},
    {name:'other'},{manifestBytes:101},{totalBytes:13},{entries:3},{state:'UNKNOWN'},{manifestOffset:-1},{chunkBytes:16*1024*1024},{uploadTransport:{protocol:'other',directAvailable:false}}]){
    const f=fixture(t),issued=await f.create();f.after=(_machine,_operation,_args,result)=>Object.assign(result,changes);
    await assert.rejects(f.begin(issued.uploadId),error=>error.status===502);
    assert.equal(f.calls.length,1);assert.equal(f.mappings().length,1);assert.equal(f.ingress.load(f.user.id,issued.uploadId).ready,undefined);
  }
});

test('revocation while the fixed HDD reply is pending rejects the reply without inventing completion',async t=>{
  const f=fixture(t),issued=await f.create();f.after=()=>{f.user.limits={};};
  await assert.rejects(f.begin(issued.uploadId),error=>error.status===403);
  assert.equal(f.sessions.size,1);assert.equal(f.ingress.load(f.user.id,issued.uploadId).ready,undefined);
  assert.equal(f.calls.length,1);
});

test('maintenance permits pure intent recovery but blocks issuance and first node admission',async t=>{
  const f=fixture(t),issued=await f.create();installMaintenance(f.service);
  f.service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify({version:1,revision:1,global:{reason:'fixture maintenance',since:'2026-10-08T00:00:00Z'},machines:{}}));
  assert.equal((await f.call('admission.status',{key:issued.key})).uploadId,issued.uploadId);
  await assert.rejects(f.create(),error=>error.code==='MAINTENANCE_ACTIVE');
  await assert.rejects(f.begin(issued.uploadId),error=>error.code==='MAINTENANCE_ACTIVE');
  assert.equal(f.calls.length,0);assert.equal(f.ingress.load(f.user.id,issued.uploadId).phase,'ISSUED');
});

test('protected maintenance opt-in admits only the owner-bound modern HDD upload and keeps unrelated writes closed',async t=>{
  const f=fixture(t);f.ingress=installDatasetIngress(f.service,{...policy,allowDuringMaintenance:true});installMaintenance(f.service);
  f.service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify({version:1,revision:47,global:{reason:'fixture maintenance',since:'2026-10-08T00:00:00Z'},machines:{}}));
  const checked=[];f.before=(machine,operation,args)=>{
    f.service.assertMaintenanceAllowed(operation,{...args,machine},f.principal);
    checked.push(operation);
    if(operation==='storage.upload.admit')assert.equal(f.service.warehouseMaintenanceUploadAllowed(operation,{...args,machine},f.principal),true);
  };
  const issued=await f.create();assert.equal(f.calls.length,0);
  assert.equal((await f.begin(issued.uploadId)).uploadId,issued.uploadId);
  const beforeBytes=f.calls.length;
  await assert.rejects(f.call('manifest',{uploadId:issued.uploadId,offset:0,data:'AA=='}),error=>error.status===409&&error.code==='CAMPUS_DATA_PLANE_REQUIRED');
  await assert.rejects(f.call('chunk',{uploadId:issued.uploadId,path:'sample',offset:0,data:'AA=='}),error=>error.status===409&&error.code==='CAMPUS_DATA_PLANE_REQUIRED');
  assert.equal(f.calls.length,beforeBytes,'Protected maintenance does not authorize control-plane file bytes');
  await f.call('seal',{uploadId:issued.uploadId});
  assert.equal((await f.call('commit',{uploadId:issued.uploadId})).state,'READY');
  assert.deepEqual(checked,['storage.upload.admit','datasets.upload.seal','datasets.upload.commit']);
  const count=f.calls.length;
  for(const operation of ['jobs.submit','terminal.open','projects.create','transfers.create']){
    assert.throws(()=>f.service.assertMaintenanceAllowed(operation,{machine:hot,key:issued.uploadId},f.principal),error=>error.status===503&&error.code==='MAINTENANCE_ACTIVE');
  }
  await assert.rejects(f.begin(randomUUID()),error=>error.status===503&&error.code==='MAINTENANCE_ACTIVE');
  assert.throws(()=>f.service.assertMaintenanceAllowed('storage.upload.admit',{...f.calls[0].args,machine:cold,intentKey:randomUUID()},f.principal),error=>error.status===503&&error.code==='MAINTENANCE_ACTIVE');
  assert.equal(f.calls.length,count);assert.equal(f.sessions.size,1);
  f.service.storageArchivePolicy={...policy,authority:'changed'};
  await assert.rejects(f.begin(issued.uploadId),error=>error.status===503&&error.code==='MAINTENANCE_ACTIVE');assert.equal(f.calls.length,count);
  f.service.storageArchivePolicy={...policy};f.user.limits={};
  await assert.rejects(f.begin(issued.uploadId),error=>[403,503].includes(error.status));assert.equal(f.calls.length,count);
});

test('Portal pure intent status bypasses the mutation queue and rechecks the current login',async t=>{
  const f=fixture(t),issued=await f.create();let valid=true;
  f.service.principal=()=>{if(!valid)throw Object.assign(Error('Login revoked'),{status:401});return {...f.principal};};
  f.service.enqueue=()=>assert.fail('intent status cannot wait for the node/mutation queue');
  const result=await PortalService.prototype.invoke.call(f.service,'synthetic-token','datasets.upload.admission.status',{machine:hot,key:issued.key});
  assert.equal(result.result.uploadId,issued.uploadId);assert.equal(f.calls.length,0);
  const pending=PortalService.prototype.invoke.call(f.service,'synthetic-token','datasets.upload.admission.status',{machine:hot,key:issued.key});
  valid=false;await assert.rejects(pending,error=>error.status===401);
});

test('missing or corrupt fresh identity mappings fail closed without creating or probing a replacement',async t=>{
  for(const mutation of ['missing','spec','marker']){
    const f=fixture(t),issued=await f.create();
    if(mutation==='missing')f.service.db.prepare('DELETE FROM dataset_upload_admissions WHERE owner=?').run(f.user.id);
    else{
      const row=f.ingress.load(f.user.id,issued.uploadId);
      if(mutation==='spec')row.specification.entries=3;else row.admissionKey=randomUUID();
      f.service.db.prepare('UPDATE dataset_upload_placements SET data=? WHERE owner=? AND upload_id=?').run(JSON.stringify(row),f.user.id,issued.uploadId);
    }
    await assert.rejects(f.begin(issued.uploadId),/corrupt/);
    if(mutation==='missing'){
      await assert.rejects(f.create(issued.key),/corrupt/);
      await assert.rejects(f.call('admission.status',{key:issued.key}),/corrupt/);
      assert.equal(f.rows().length,1);
    }
    assert.equal(f.calls.length,0);
  }
});

test('pure intent recovery remains available while all eight node control slots are occupied',async t=>{
  const f=fixture(t),issued=[];for(let i=0;i<8;i++)issued.push(await f.create());
  const releases=[];f.before=()=>new Promise(resolve=>{releases.push(resolve);});
  const pending=issued.map(row=>f.begin(row.uploadId));await Promise.resolve();
  try{
    assert.equal(releases.length,8);
    assert.equal((await f.call('admission.status',{key:issued[0].key})).uploadId,issued[0].uploadId);
    await assert.rejects(f.create(),error=>error.status===429);
  }finally{for(const release of releases)release();}
  await Promise.all(pending);assert.equal(f.sessions.size,8);
});

test('ISSUED and lost first dispatch return exact node NOT_INITIALIZED proof without writing or reissuing',async t=>{
  for(const attempted of [false,true]){
    const f=fixture(t,{persistent:true}),issued=await f.create();
    if(attempted){
      f.before=()=>{throw Object.assign(Error('First dispatch never reached node'),{status:503});};
      await assert.rejects(f.begin(issued.uploadId),error=>error.status===503);
      f.before=undefined;f.reopen();
    }
    const before=f.rows(),mappings=f.mappings();f.calls.length=0;
    const result=await f.call('status',{uploadId:issued.uploadId});
    assert.deepEqual(result,{...spec,uploadId:issued.uploadId,userId:f.user.id,state:'NOT_INITIALIZED',
      initializationProtocol:1,nodePresent:false,manifestOffset:0,admissionProtocol:1,admissionKey:issued.key,
      placementProtocol:1,requestedMachine:hot,storageMachine:cold,storageTier:'hdd',legacyPlacement:false});
    assert.deepEqual(f.calls,[{machine:cold,operation:'storage.upload.locate',args:{userId:f.user.id,uploadId:issued.uploadId}}]);
    assert.deepEqual(f.rows(),before);assert.deepEqual(f.mappings(),mappings);assert.equal(f.sessions.size,0);
    assert.equal((await f.begin(issued.uploadId)).uploadId,issued.uploadId);
    assert.equal(f.sessions.size,1);assert.deepEqual(f.mappings(),mappings);
    assert.equal((await f.call('status',{uploadId:issued.uploadId})).nodePresent,true);
    assert.equal(f.calls.filter(row=>row.operation==='storage.upload.admit').length,1);
    assert.equal(f.calls.some(row=>row.operation==='datasets.upload.begin'),false);
  }
});

for(const change of ['disabled-before','authority-before','disabled-during','archive-during']){
  test('BOUND absence rejects '+(change.endsWith('before')?'persisted restart policy: ':'in-process policy fault injection: ')+change,async t=>{
    const f=fixture(t,{persistent:change.endsWith('before')}),issued=await f.create();
    f.before=()=>{throw Object.assign(Error('First dispatch never reached node'),{status:503});};
    await assert.rejects(f.begin(issued.uploadId),error=>error.status===503);
    f.before=undefined;f.calls.length=0;
    const mutate=()=>{
      if(change==='authority-before'){
        f.service.storageArchivePolicy={...policy,authority:'different'};
        f.ingress=installDatasetIngress(f.service,{...policy,authority:'different'});
      }else if(change==='archive-during')f.service.storageArchivePolicy={...policy,authority:'different'};
      else f.ingress=installDatasetIngress(f.service,undefined);
    };
    if(change==='disabled-before')f.reopen(undefined);
    else if(change==='authority-before'){
      f.service.storageArchivePolicy={...policy,authority:'different'};
      f.reopen({...policy,authority:'different'});
    }
    else f.before=(_machine,operation)=>{if(operation==='storage.upload.locate')mutate();};
    const rows=f.rows(),mappings=f.mappings();
    await assert.rejects(f.call('status',{uploadId:issued.uploadId}),error=>error.status===409);
    assert.equal(f.sessions.size,0);assert.deepEqual(f.rows(),rows);assert.deepEqual(f.mappings(),mappings);
    assert(f.calls.every(row=>row.machine===cold&&row.operation==='storage.upload.locate'));
  });
}

for(const change of ['stale-role','journal']){
  test('absence proof rejects private binding fault injection: '+change,async t=>{
    const f=fixture(t),issued=await f.create(),rows=f.rows(),mappings=f.mappings();
    if(change==='stale-role')f.user.role='admin';
    else f.before=(_machine,operation)=>{
      if(operation==='storage.upload.locate'){
        const row=f.ingress.load(f.user.id,issued.uploadId);
        row.specification={...spec,entries:3};row.specificationSha256=digest(row.specification);
        f.service.db.prepare('UPDATE dataset_upload_placements SET data=? WHERE owner=? AND upload_id=?')
          .run(JSON.stringify(row),f.user.id,issued.uploadId);
      }
    };
    await assert.rejects(f.call('status',{uploadId:issued.uploadId}),error=>error.status===(change==='stale-role'?403:502));
    assert.equal(f.sessions.size,0);assert.deepEqual(f.mappings(),mappings);
    if(change==='stale-role'){assert.equal(f.calls.length,0);assert.deepEqual(f.rows(),rows);}
    else assert.deepEqual(f.calls.map(row=>row.operation),['storage.upload.locate']);
  });
}

test('missing capability, malformed proof or changed authority is never NOT_INITIALIZED',async t=>{
  for(const changes of [{uploadAdmissionProtocol:undefined},{uploadAdmissionProtocol:0},{initializationProtocol:undefined},
    {initializationProtocol:true},{nodePresent:undefined},{nodePresent:true},{state:'ABSENT'},
    {userId:'demo-user-2'},{uploadId:randomUUID()},{machine:hot},{protocol:'old-location'},
    {authority:{enabled:false,machine:cold,authority:'hdd'}},{authority:{enabled:true,machine:hot,authority:'hdd'}},
    {authority:{enabled:true,machine:cold,authority:'other'}}]){
    const f=fixture(t),issued=await f.create(),before=f.rows(),bridge=f.service.bridge;
    f.service.bridge=async(...args)=>({...await bridge(...args),...changes});
    await assert.rejects(f.call('status',{uploadId:issued.uploadId}),error=>error.status===502);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'storage.upload.locate');
    assert.equal(f.sessions.size,0);assert.deepEqual(f.rows(),before);assert.equal(f.mappings().length,1);
  }
});

test('location and subsequent status 400/404/503/ENOENT errors remain errors with the original UUID',async t=>{
  for(const operation of ['storage.upload.locate','datasets.upload.status']){
    for(const failure of [400,404,503,'ENOENT']){
      const f=fixture(t),issued=await f.create();await f.begin(issued.uploadId);const before=f.rows();f.calls.length=0;
      const error=Object.assign(Error('Unconfirmed node response'),typeof failure==='number'?{status:failure}:{code:failure});
      f.before=(_machine,op)=>{if(op===operation)throw error;};
      await assert.rejects(f.call('status',{uploadId:issued.uploadId}),value=>value===error);
      assert(f.calls.every(row=>row.machine===cold&&row.args.uploadId===issued.uploadId));
      assert.deepEqual(f.rows(),before);assert.equal(f.mappings().length,1);assert.equal(f.sessions.size,1);
      assert.equal(f.calls.some(row=>row.operation==='storage.upload.admit'||row.operation==='datasets.upload.begin'),false);
    }
  }
});

test('a present legacy, mismatched admission or mismatched ordinary status cannot impersonate initialized upload',async t=>{
  for(const changes of [{admissionProtocol:undefined},{admissionProtocol:0},{admissionKey:randomUUID()},
    {requestedMachine:offline},{storageMachine:hot},{admissionAuthority:'other'},
    {specification:{...spec,manifestSha256:'f'.repeat(64)}},{specification:{...spec,entries:true}}]){
    const f=fixture(t),issued=await f.create();await f.begin(issued.uploadId);f.calls.length=0;const bridge=f.service.bridge;
    f.service.bridge=async(...args)=>({...await bridge(...args),...changes});
    await assert.rejects(f.call('status',{uploadId:issued.uploadId}),error=>error.status===502);
    assert.deepEqual(f.calls.map(row=>row.operation),['storage.upload.locate']);assert.equal(f.sessions.size,1);
  }
  for(const changes of [{uploadId:randomUUID()},{name:'other'},{manifestBytes:99},{totalBytes:0},{entries:1},{state:'NOT_INITIALIZED'}]){
    const f=fixture(t),issued=await f.create();await f.begin(issued.uploadId);f.calls.length=0;
    f.after=(_machine,operation,_args,result)=>{if(operation==='datasets.upload.status')Object.assign(result,changes);};
    await assert.rejects(f.call('status',{uploadId:issued.uploadId}),error=>error.status===502);
    assert.deepEqual(f.calls.map(row=>row.operation),['storage.upload.locate','datasets.upload.status']);
  }
});

test('initialization proof rechecks owner authorization, original selection and maintenance without allowing begin',async t=>{
  const f=fixture(t),issued=await f.create(),before=f.rows();
  f.before=()=>{f.user.limits={};};
  await assert.rejects(f.call('status',{uploadId:issued.uploadId}),error=>error.status===403);
  assert.deepEqual(f.rows(),before);assert.equal(f.sessions.size,0);
  f.before=undefined;f.user.limits={[hot]:1};installMaintenance(f.service);
  f.service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify({version:1,revision:51,
    global:{reason:'fixture maintenance',since:'2026-10-08T00:00:00Z'},machines:{}}));
  const maintenance=f.service.db.prepare('SELECT data FROM operational_maintenance WHERE id=1').get().data;
  assert.equal((await f.call('status',{uploadId:issued.uploadId})).state,'NOT_INITIALIZED');
  await assert.rejects(f.begin(issued.uploadId),error=>error.code==='MAINTENANCE_ACTIVE');
  assert.equal(f.service.db.prepare('SELECT data FROM operational_maintenance WHERE id=1').get().data,maintenance);
  const second={userId:f.second.id,username:f.second.username,role:'member'},count=f.calls.length;
  f.before=()=>{throw Error('Unrelated old node is offline; no fresh proof');};
  await assert.rejects(f.call('status',{uploadId:issued.uploadId},second),/offline/);
  assert.equal(f.calls.slice(count).some(row=>row.operation!=='storage.upload.locate'),false);
  assert.equal(f.sessions.size,0);assert.deepEqual(f.rows(),before);
});

test('previous READY proof is not replaced by NOT_INITIALIZED when node control metadata disappears',async t=>{
  const f=fixture(t),issued=await f.create();await f.begin(issued.uploadId);
  await f.call('commit',{uploadId:issued.uploadId});const before=f.rows();
  f.sessions.clear();f.calls.length=0;
  await assert.rejects(f.call('status',{uploadId:issued.uploadId}),error=>error.status===502);
  assert.deepEqual(f.rows(),before);assert.equal(f.mappings().length,1);
  assert.deepEqual(f.calls.map(row=>row.operation),['storage.upload.locate']);
});

async function restartedHttpFixture(t){
  const directory=mkdtempSync(join(tmpdir(),'stargate-initialization-restart-')),password='Initialization-Local-Fixture-2026!';
  const bootstrap=join(directory,'bootstrap.json'),archive=join(directory,'archive.json'),ingress=join(directory,'ingress.json');
  writeFileSync(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port,f={calls:[]};
  const post=async(path,body,token)=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',
      ...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  f.stop=async()=>{if(f.server){const server=f.server;f.server=null;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
  t.after(async()=>{try{await f.stop();}finally{rmSync(directory,{recursive:true,force:true});}});
  f.start=async(nextPolicy=policy)=>{
    writeFileSync(archive,JSON.stringify(nextPolicy.enabled?nextPolicy:policy),{mode:0o600});
    writeFileSync(ingress,JSON.stringify(nextPolicy),{mode:0o600});
    const {server,service}=await createPortalServer({database:join(directory,'portal.sqlite'),bootstrap,origin,secure:false,
      storageArchiveConfigPath:archive,datasetIngressConfigPath:ingress,bridge:async(machine,operation,args)=>{
        f.calls.push({machine,operation,args:structuredClone(args)});assert.equal(machine,cold);
        if(operation==='storage.upload.admit')throw Object.assign(Error('First dispatch never reached node'),{status:503});
        assert.equal(operation,'storage.upload.locate');await f.locateHook?.();
        return {protocol:'dataset-upload-location-v1',uploadAdmissionProtocol:1,machine,userId:args.userId,uploadId:args.uploadId,
          authority:{enabled:true,machine,authority:'hdd'},present:false,state:'NOT_INITIALIZED',initializationProtocol:1,nodePresent:false};
      }});
    f.server=server;f.service=service;
    for(const key of ['executionTimer','transferTimer','maintenanceTimer','storageArchiveTimer','projectCopyTimer','notificationTimer'])clearInterval(service[key]);
    await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
    const admin=await post('/api/login',{username:'admin',password});assert.equal(admin.status,200);f.admin=admin.data;
  };
  f.call=(operation,args,token=f.member.token)=>post('/api/call',{operation,args},token);
  f.login=async()=>{const member=await post('/api/login',{username:'restart-member',password});assert.equal(member.status,200);f.member=member.data;};
  await f.start();
  assert.equal((await f.call('users.create',{username:'restart-member',password},f.admin.token)).status,200);
  await f.login();
  assert.equal((await f.call('policy.save',{userId:f.member.principal.userId,policyVersion:0,total:1,limits:{[hot]:1}},f.admin.token)).status,200);
  return f;
}

for(const nextPolicy of [{enabled:false},{...policy,authority:'different'}]){
  test('normal HTTP persisted BOUND rejects absence after trusted configuration restart: '+JSON.stringify(nextPolicy),async t=>{
    const f=await restartedHttpFixture(t);
    const issued=(await f.call('datasets.upload.admission.create',{machine:hot,key:randomUUID(),...spec})).data.result;
    assert(issued);const args={machine:hot,uploadId:issued.uploadId};
    assert.equal((await f.call('datasets.upload.begin',{machine:hot,key:issued.uploadId,...spec})).status,503);
    const before=f.service.db.prepare('SELECT * FROM dataset_upload_placements').all();
    const mappings=f.service.db.prepare('SELECT * FROM dataset_upload_admissions').all();
    assert.equal(JSON.parse(before[0].data).phase,'BOUND');
    assert.equal((await f.call('datasets.upload.status',args)).data.result.state,'NOT_INITIALIZED');
    await f.stop();await f.start(nextPolicy);await f.login();f.calls.length=0;
    const result=await f.call('datasets.upload.status',args);
    if(process.env.DATASET_INITIALIZATION_REVIEW==='1')t.diagnostic(JSON.stringify({case:nextPolicy.enabled?'authority-restart':'disabled-restart',
      principal:f.member.principal,configuredPolicy:f.service.datasetIngressPolicy,originalIssued:issued,firstBeginStatus:503,
      locateCalls:f.calls,response:{status:result.status,result:result.data.result,error:result.data.error}}));
    assert.equal(result.status,409);assert.equal(result.data.result,undefined);assert.doesNotMatch(JSON.stringify(result.data),/NOT_INITIALIZED/);
    assert.deepEqual(f.calls,[{machine:cold,operation:'storage.upload.locate',args:{userId:f.member.principal.userId,uploadId:issued.uploadId}}]);
    assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_upload_placements').all(),before);
    assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_upload_admissions').all(),mappings);
  });
}

test('normal service grant and role mutations serialize with HTTP status and reject subsequent stale access',async t=>{
  const f=await restartedHttpFixture(t);
  const issued=(await f.call('datasets.upload.admission.create',{machine:hot,key:randomUUID(),...spec})).data.result;
  const args={machine:hot,uploadId:issued.uploadId},owner=f.member.principal.userId;
  for(const [operation,mutation] of [['policy.save',{userId:owner,policyVersion:1,total:0,limits:{}}],['users.role',{userId:owner,role:'admin'}]]){
    let enter,release;const entered=new Promise(resolve=>enter=resolve),released=new Promise(resolve=>release=resolve);
    f.locateHook=()=>{enter();return released;};
    const reading=f.call('datasets.upload.status',args);await entered;
    const changing=f.service.invoke(f.admin.token,operation,mutation);
    assert.equal(f.service.pending,2);assert.equal(f.service.store.get(owner).role,'member');assert.equal(f.service.store.get(owner).limits[hot],1);
    release();assert.equal((await reading).data.result.state,'NOT_INITIALIZED');await changing;f.locateHook=undefined;
    const count=f.calls.length,result=await f.call('datasets.upload.status',args);
    assert.ok([401,403].includes(result.status));assert.equal(result.data.result,undefined);assert.equal(f.calls.length,count);
    if(operation==='policy.save')assert.equal((await f.call('policy.save',{userId:owner,policyVersion:2,total:1,limits:{[hot]:1}},f.admin.token)).status,200);
  }
});

test('real authenticated HTTP projects exact missing-node proof, never an error, foreign principal or maintenance write',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'stargate-initialization-http-')),password='Initialization-Local-Fixture-2026!';
  let running;
  t.after(async()=>{
    try{if(running){running.closeAllConnections();await new Promise(resolve=>running.close(resolve));}}
    finally{rmSync(directory,{recursive:true,force:true});}
  });
  const bootstrap=join(directory,'bootstrap.json'),archive=join(directory,'archive.json'),ingress=join(directory,'ingress.json');
  for(const [path,value] of [[bootstrap,{username:'admin',password}],[archive,policy],[ingress,policy]])
    writeFileSync(path,JSON.stringify(value),{mode:0o600});
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port,calls=[];let failure;
  const {server,service}=await createPortalServer({database:join(directory,'portal.sqlite'),bootstrap,origin,secure:false,
    storageArchiveConfigPath:archive,datasetIngressConfigPath:ingress,bridge:async(machine,operation,args)=>{
      calls.push({machine,operation,args});assert.equal(machine,cold);assert.equal(operation,'storage.upload.locate');
      if(failure)throw failure;
      return {protocol:'dataset-upload-location-v1',uploadAdmissionProtocol:1,machine,userId:args.userId,uploadId:args.uploadId,
        authority:{enabled:true,machine,authority:'hdd'},present:false,state:'NOT_INITIALIZED',initializationProtocol:1,nodePresent:false};
    }});
  running=server;
  for(const key of ['executionTimer','transferTimer','maintenanceTimer','storageArchiveTimer','projectCopyTimer','notificationTimer'])clearInterval(service[key]);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const post=async(path,body,token)=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',
      ...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const admin=(await post('/api/login',{username:'admin',password})).data;
  const call=(operation,args,token=admin.token)=>post('/api/call',{operation,args},token);
  assert.equal((await call('users.create',{username:'initialization-member',password})).status,200);
  const member=(await post('/api/login',{username:'initialization-member',password})).data;
  assert.equal((await call('policy.save',{userId:member.principal.userId,policyVersion:0,total:1,limits:{[hot]:1}})).status,200);
  const issued=(await call('datasets.upload.admission.create',{machine:hot,key:randomUUID(),...spec},member.token)).data.result;
  assert(issued);assert.equal(calls.length,0);
  const args={machine:hot,uploadId:issued.uploadId},before=service.db.prepare('SELECT * FROM dataset_upload_placements').all();
  assert.equal((await call('datasets.upload.status',args,'0'.repeat(64))).status,401);assert.equal(calls.length,0);
  assert.equal((await call('datasets.upload.status',{...args,userId:'builtin-admin'},member.token)).status,400);assert.equal(calls.length,0);
  const maintenance=await call('maintenance.set',{scope:'all',revision:0,enabled:true,reason:'local proof-only test'});
  assert.equal(maintenance.status,200);const raw=service.db.prepare('SELECT data FROM operational_maintenance WHERE id=1').get().data;
  const response=await call('datasets.upload.status',args,member.token);
  assert.equal(response.status,200);assert.deepEqual(response.data.result,{...spec,uploadId:issued.uploadId,
    userId:member.principal.userId,state:'NOT_INITIALIZED',initializationProtocol:1,nodePresent:false,manifestOffset:0,
    admissionProtocol:1,admissionKey:issued.key,placementProtocol:1,requestedMachine:hot,storageMachine:cold,storageTier:'hdd',legacyPlacement:false});
  assert.deepEqual(calls,[{machine:cold,operation:'storage.upload.locate',args:{userId:member.principal.userId,uploadId:issued.uploadId}}]);
  for(const status of [400,404,503]){
    failure=Object.assign(Error('Node response remains unconfirmed'),{status});
    const result=await call('datasets.upload.status',args,member.token);
    assert.equal(result.status,status);assert.equal(result.data.result,undefined);assert.doesNotMatch(JSON.stringify(result.data),/NOT_INITIALIZED/);
  }
  const count=calls.length;
  assert.equal((await call('datasets.upload.begin',{machine:hot,key:issued.uploadId,...spec},member.token)).status,503);
  assert.equal(calls.length,count);assert.deepEqual(service.db.prepare('SELECT * FROM dataset_upload_placements').all(),before);
  assert.equal(service.db.prepare('SELECT data FROM operational_maintenance WHERE id=1').get().data,raw);
});
