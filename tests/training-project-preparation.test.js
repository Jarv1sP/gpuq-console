import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installProjectReplication,projectReplicationCall} from '../project-replication.mjs';
import {cancelTrainingPreparations} from '../training-preparation.mjs';
import {trainingPlan} from './training-storage-fixture.mjs';
import {MACHINES} from '../dist/model.js';
const [from,machine]=MACHINES.map(value=>value.id),project='project-fixture',release='a'.repeat(64);
function fixture(t){
  const db=new DatabaseSync(':memory:'),calls=[],writes=new Map(),user={id:'demo-user-1',username:'alice',role:'member',enabled:true,limits:{[from]:1,[machine]:1}};
  const spec={id:randomUUID(),userId:user.id,username:user.username,cards:1,argv:['python','train.py'],name:'fixture',minVramGiB:0,project,release};
  const request={userId:user.id,hostAdmin:false,project,release,datasetReadMode:'cache',datasets:[],datasetFootprints:[],
    projectFootprint:{sourceMachine:from,image:'sha256:'+release,architecture:'amd64',codeBytes:1,codeEntries:1,imageUnpackedBytes:1024,imageEntries:4}};
  const job={id:spec.id,userId:user.id,machine,project,release,state:'PREPARING_DATA',spec,projectPreparation:{from,project,release},
    trainingStorageRequest:request,trainingStoragePlan:trainingPlan(machine,request)};
  let tail=Promise.resolve(),saves=0;
  const service={db,store:{jobs:[job],get:id=>{assert.equal(id,user.id);return user;}},audit(){},maintenanceFor:()=>false,
    enqueue(fn){const pending=tail.then(fn);tail=pending.catch(()=>{});return pending;},save(){saves++;if(service.diskFailure)throw Error('disk');},
    bridge:async(host,operation,args)=>{
      calls.push({host,operation,args:structuredClone(args),saves});
      if(operation==='projects.verify')throw Error('missing fixed version');
      if(operation==='projects.copy.probe')return {protocol:'portable-project-v1',enabled:true,environmentMode:'oci',architecture:'amd64',project,
        sources:[from],releaseReady:!!args.release,...(args.release?{release,image:'sha256:'+release,codeBytes:1,codeEntries:1,imageUnpackedBytes:1024,imageEntries:4}:{})};
      assert.equal(operation,'storage.training.project.prepare','marked copy must not send an old write RPC');
      const value=Object.fromEntries(['job','planRequest','preparation'].map(key=>[key,args[key]]));
      assert.ok(job.trainingPreparations.some(saved=>JSON.stringify(saved)===JSON.stringify(value)));
      const row=db.prepare('SELECT data FROM project_copies WHERE id=?').get(args.preparation.id);
      if(row)assert.deepEqual(JSON.parse(row.data).trainingPreparation,value);
      assert.equal(args.args.userId,user.id);assert.equal(args.args.id,args.preparation.id);
      if(args.operation==='projects.copy.prepare')return {id:args.args.id,project,release,state:'READY',source:{id:args.args.id,token:'x'.repeat(43),protocol:'portable-project-v1',state:'READY',project,release,manifestBytes:100,manifestSha256:release,totalBytes:1024,entries:8}};
      if(args.operation==='projects.copy.start'){
        if(service.capacityChanged)throw Error('capacity changed; no reclaim');
        if(!writes.has(args.args.id))writes.set(args.args.id,{id:args.args.id,project,release,state:'RUNNING'});
        if(service.lose){service.lose=false;throw Error('ACK lost');}return writes.get(args.args.id);
      }
      if(args.operation==='projects.copy.revoke')return {id:args.args.id,fenced:true,sourceRevoked:true};
      if(args.operation==='projects.copy.cancel')return {id:args.args.id,state:service.unknownStop?'UNKNOWN':'CANCELED',cleaned:!service.unknownStop};
      throw Error('unexpected private operation');
    }};
  installProjectReplication(service);t.after(()=>{clearInterval(service.projectCopyTimer);db.close();});
  return {service,job,user,db,calls,writes,prepare:()=>service.prepareProject(user.id,machine,{from,project,release},{trainingJobId:job.id})};
}
test('new training project copy binds durable full spec and original UUID before both nodes',async t=>{
  const f=fixture(t),first=await f.prepare(),context=structuredClone(f.job.trainingPreparations[0]);
  assert.equal(first.state,'PREPARING');assert.equal(first.operationId,context.preparation.id);assert.equal(f.writes.size,1);
  const again=await f.prepare();assert.equal(again.operationId,first.operationId);assert.deepEqual(f.job.trainingPreparations,[context]);
  assert.ok(f.calls.filter(value=>value.operation==='storage.training.project.prepare').every(value=>value.saves>0));
  const row=await projectReplicationCall(f.service,{userId:f.user.id},'projects.replication.status',{id:first.operationId});
  assert.equal(Object.hasOwn(row,'trainingPreparation'),false);assert.equal(Object.hasOwn(row,'sourceTicket'),false);
});
test('lost target ACK, restart and capacity change never allocate another copy or use old worker',async t=>{
  const f=fixture(t);f.service.lose=true;const first=await f.prepare();
  const row=f.db.prepare('SELECT * FROM project_copies').get();assert.equal(row.state,'UNKNOWN');
  clearInterval(f.service.projectCopyTimer);installProjectReplication(f.service);
  const again=await f.prepare();assert.equal(again.operationId,first.operationId);assert.equal(f.writes.size,1);
  f.service.capacityChanged=true;await f.prepare();assert.equal(f.writes.size,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM project_copies').get().n,1);
  assert.equal(f.calls.some(value=>['projects.copy.start','projects.copy.prepare'].includes(value.operation)),false);
});
test('cancel and missing-row crash fence both original nodes and require real stopped proof',async t=>{
  for(const missing of [false,true]){
    const f=fixture(t);await f.prepare();const id=f.job.trainingPreparations[0].preparation.id;
    if(missing)f.db.prepare('DELETE FROM project_copies').run();
    f.job.state='CANCELED';f.job.cancelRequested=true;f.service.unknownStop=true;
    await assert.rejects(cancelTrainingPreparations(f.service,f.job));
    f.service.unknownStop=false;await cancelTrainingPreparations(f.service,f.job);
    assert.ok(f.calls.filter(value=>value.operation==='storage.training.project.prepare').every(value=>value.args.preparation.id===id));
    assert.deepEqual(new Set(f.calls.filter(value=>value.args.operation==='projects.copy.cancel').map(value=>value.host)),new Set([from,machine]));
    assert.equal(f.writes.size,1);
  }
});
test('save failure, wrong job identity, public injection and lost/null context do zero write RPC',async t=>{
  const f=fixture(t);f.service.diskFailure=true;await assert.rejects(f.prepare());
  assert.equal(f.job.trainingPreparations,undefined);assert.equal(f.calls.some(value=>value.operation==='storage.training.project.prepare'),false);
  f.service.diskFailure=false;
  await assert.rejects(projectReplicationCall(f.service,{userId:f.user.id},'projects.replicate',{from,machine,project,release,key:randomUUID(),trainingJobId:f.job.id}));
  await f.prepare();const row=f.db.prepare('SELECT * FROM project_copies').get();
  for(const marker of ['missing','null']){
    const data=JSON.parse(row.data);if(marker==='missing')delete data.trainingPreparation;else data.trainingPreparation=null;
    f.db.prepare('UPDATE project_copies SET data=?').run(JSON.stringify(data));f.calls.length=0;
    await f.service.reconcileProjectCopies();assert.equal(f.calls.length,0);
  }
});
test('an old copy cannot be upgraded by a new marked job',async t=>{
  const f=fixture(t),id=randomUUID(),now=Date.now(),legacy={from,machine,project,release,cancelRequested:false};
  f.db.prepare('INSERT INTO project_copies VALUES(?,?,?,?,?,?,?,?)').run(id,f.user.id,id,'old','UNKNOWN',JSON.stringify(legacy),now,now);
  await f.prepare();
  assert.notEqual(f.job.trainingPreparations[0].preparation.id,id);
  assert.equal(f.db.prepare('SELECT data FROM project_copies WHERE id=?').get(id).data,JSON.stringify(legacy));
  assert.equal(f.calls.some(value=>value.args.preparation?.id===id),false);
});
test('ordinary retry cannot replace a bound training copy or call an old worker',async t=>{
  const f=fixture(t);await f.prepare();const row=f.db.prepare('SELECT * FROM project_copies').get();
  f.db.prepare("UPDATE project_copies SET state='FAILED' WHERE id=?").run(row.id);f.calls.length=0;
  await assert.rejects(projectReplicationCall(f.service,{userId:f.user.id},'projects.replication.retry',
    {id:row.id,key:randomUUID()}),error=>error.status===409);
  assert.equal(f.calls.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM project_copies').get().n,1);
  const data=JSON.parse(row.data);delete data.trainingPreparation;
  f.db.prepare('UPDATE project_copies SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
  await assert.rejects(projectReplicationCall(f.service,{userId:f.user.id},'projects.replication.retry',
    {id:row.id,key:randomUUID()}),error=>error.status===409);
  assert.equal(f.calls.length,0);
});
test('changed current full spec or capacity request cannot continue a saved preparation',async t=>{
  const f=fixture(t);await f.prepare();const original=structuredClone(f.job.spec),request=structuredClone(f.job.trainingStorageRequest);
  for(const change of [()=>{f.job.spec.argv=['different'];},()=>{f.job.trainingStorageRequest.projectFootprint.codeBytes++;}]){
    f.job.spec=structuredClone(original);f.job.trainingStorageRequest=structuredClone(request);change();f.calls.length=0;
    await assert.rejects(f.prepare(),error=>error.status===409);
    assert.equal(f.calls.filter(value=>value.operation==='storage.training.project.prepare').length,0);
  }
});
