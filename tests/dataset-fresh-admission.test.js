import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executionCall} from '../execution.mjs';
import {installDatasetIngress} from '../dataset-ingress.mjs';
import {installMaintenance} from '../maintenance.mjs';
import {PortalService} from '../portal-service.mjs';

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
        authority:{enabled:machine===cold,machine,authority:'hdd'},present:sessions.has(key),
        ...(sessions.has(key)?{specification:sessions.get(key).spec}:{})};
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
  assert(f.calls.every(row=>row.machine===cold));assert.equal(f.calls.some(row=>row.operation==='storage.upload.locate'||row.operation==='datasets.upload.begin'),false);
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
  await f.call('manifest',{uploadId:issued.uploadId,offset:0,data:'AA=='});
  await f.call('seal',{uploadId:issued.uploadId});
  await f.call('chunk',{uploadId:issued.uploadId,path:'sample',offset:0,data:'AA=='});
  assert.equal((await f.call('commit',{uploadId:issued.uploadId})).state,'READY');
  assert.deepEqual(checked,['storage.upload.admit','datasets.upload.manifest','datasets.upload.seal','datasets.upload.chunk','datasets.upload.commit']);
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
