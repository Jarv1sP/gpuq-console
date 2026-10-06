import test from 'node:test';
import assert from 'node:assert/strict';
import {installDatasetDeletion} from '../dataset-deletion.mjs';
import {fixture,hosts,principal,admin,writes,version} from './dataset-deletion-fixture.mjs';

function stopped(f){
  f.after=(host,op,args,result)=>{
    if(op.endsWith('.status'))result.stoppedPhases=Object.keys(result.phases);
  };
}

test('NB1 explicit admin continue retries a stopped failed isolate with its original phase and audits each attempt',async t=>{
  const f=fixture(t);let reject=true;
  f.after=(host,op,args,result)=>{
    if(reject&&host===hosts[0]&&op.endsWith('.isolate')){
      const node=f.nodes.get(args.operationId);node.phases.isolate={ok:false,error:'active lease temporarily blocks isolation'};
      node.state='FENCED';node.result=null;
    }
    if(op.endsWith('.status'))result.stoppedPhases=Object.keys(result.phases);
  };
  const r=await f.start();assert.notEqual(r.result.state,'DELETED');
  reject=false;
  await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);
  await f.service.waitDatasetDeletions();
  const result=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);
  assert.equal(result.state,'DELETED',JSON.stringify(result));
  const attempts=writes(f).filter(c=>c.host===hosts[0]&&c.op.endsWith('.isolate'));
  assert.equal(attempts.length,2);assert.equal(attempts[0].args.operationId,attempts[1].args.operationId);
  assert.match(attempts[1].args.retryKey,/^[a-f0-9-]{36}$/);
  assert.ok(f.audits.some(a=>a[1]==='datasets.delete.step'&&a[3].includes('阶段重试')));
});

test('NB1 repeating admin cancel can retry only its stopped failed rollback and finally releases all fences',async t=>{
  const f=fixture(t);let lost=true,reject=true;
  f.after=(host,op,args,result)=>{
    if(lost&&op.endsWith('.fence')){lost=false;throw Error('response lost');}
    if(reject&&op.endsWith('.cancel')){
      const node=f.nodes.get(args.operationId);node.phases.cancel={ok:false,error:'temporary rollback I/O refusal'};
      node.state='FENCED';node.result=null;
    }
    if(op.endsWith('.status'))result.stoppedPhases=Object.keys(result.phases);
  };
  const r=await f.start();
  await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  assert.notEqual((await f.call('datasets.delete.status',{operationId:r.first.operationId},admin)).state,'CANCELED');
  reject=false;
  await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  assert.equal((await f.call('datasets.delete.status',{operationId:r.first.operationId},admin)).state,'CANCELED');
  assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
  assert.equal(writes(f).filter(c=>c.host===hosts[0]&&c.op.endsWith('.cancel')).length,2);
});

test('NB2 source restore restores every complete peer and releases every namespace for preparation',async t=>{
  const f=fixture(t,{onlySource:false});const r=await f.start();assert.equal(r.result.state,'DELETED');
  assert.equal((await f.call('datasets.delete.restore',{operationId:r.first.operationId,machine:hosts[0]},admin)).state,'RESTORED');
  assert.deepEqual(writes(f).filter(c=>c.op.endsWith('.restore')).map(c=>c.host).sort(),[...hosts].sort());
  assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
  for(const host of hosts)assert.equal((await f.service.bridge(host,'datasets.prepare',{dataset:'personal',version,userId:principal.userId,hostAdmin:false})).state,'READY');
});

test('SF7 only exact explicit new-registration proof releases the old portal namespace; failures never do',async t=>{
  const f=fixture(t),r=await f.start(),row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  const step=row.steps.find(s=>s.machine===hosts[0]);
  const identity={dataset:'personal',version,userId:principal.userId,hostAdmin:false};
  const valid={protocol:'dataset-new-registration-proof-v1',machine:step.machine,dataset:step.dataset,version,
    operationId:step.operationId,generation:step.fence.generation,snapshotSha256:step.plan.snapshotSha256,
    registrationSha256:'e'.repeat(64),state:'REGISTERED'};
  for(const change of [null,{operationId:r.first.operationId},{generation:'f'.repeat(64)},
    {machine:hosts[1]},{snapshotSha256:'f'.repeat(64)},{state:'READY'},{force:true}]){
    f.registration=change&&{...valid,...change};
    await assert.rejects(f.service.bridge(hosts[0],'datasets.prepare',identity),e=>e.code==='DATASET_DELETION_FENCED');
    assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletion_fences').get().n,hosts.length);
  }
  f.registration=valid;
  assert.equal((await f.service.bridge(hosts[0],'datasets.prepare',identity)).state,'READY');
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletion_fences').get().n,hosts.length-1);
  await assert.rejects(f.service.bridge(hosts[1],'datasets.prepare',identity),e=>e.code==='DATASET_DELETION_FENCED');
  await assert.rejects(f.call('datasets.delete.continue',{operationId:r.first.operationId},admin),/重新登记/);
  assert.ok(f.audits.some(a=>a[1]==='datasets.delete.step'&&a[3].includes('显式新登记代次')));
});

test('SF1 status and repeated cancel repair portal fences left after final node cancellation receipt',async t=>{
  for(const terminal of [false,true]){
    const f=fixture(t);let lost=true;
    f.after=(host,op)=>{if(lost&&op.endsWith('.fence')){lost=false;throw Error('lost fence reply');}};
    const r=await f.start();
    await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
    const row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
    row.state=terminal?'CANCELED':'CANCELING';
    f.service.db.prepare('UPDATE dataset_deletions SET data=?').run(JSON.stringify(row));
    for(const step of row.steps)f.service.db.prepare('INSERT OR REPLACE INTO dataset_deletion_fences VALUES(?,?,?,?)').run(step.machine,step.dataset,row.version,row.id);
    const before=writes(f).length;
    assert.equal((await f.call(terminal?'datasets.delete.cancel':'datasets.delete.status',{operationId:row.id},admin)).state,'CANCELED');
    assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
    assert.equal(writes(f).length,before,'repairing the portal journal never starts a node write');
  }
});

test('SF2 administrator continue never upgrades an originally unauthorized member task',async t=>{
  const f=fixture(t);f.personal=false;const r=await f.start();assert.equal(r.result.state,'BLOCKED');
  const before=writes(f).length;
  await assert.rejects(f.call('datasets.delete.continue',{operationId:r.first.operationId},admin),e=>e.status===403);
  await f.service.waitDatasetDeletions();
  assert.equal(writes(f).length,before);assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
});

test('SF5 restarted portal reports waiting for explicit continue rather than unattended RUNNING',async t=>{
  const f=fixture(t);let lost=true;
  f.after=(host,op)=>{if(lost&&host===hosts[0]&&op.endsWith('.isolate')){lost=false;throw Error('final isolation reply lost');}};
  const r=await f.start();assert.notEqual(r.result.state,'DELETED');
  installDatasetDeletion(f.service,{pollMs:1,capabilityTimeoutMs:30});stopped(f);
  const before=writes(f).length,result=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);
  assert.equal(result.state,'WAITING_CONTINUE',JSON.stringify(result));
  assert.match(result.error,/等待继续.*门户已重启/);assert.equal(result.canContinue,true);
  assert.equal(writes(f).length,before);
});

test('SF6 definite isolate refusal stays BLOCKED with the actionable reason across status reads',async t=>{
  const f=fixture(t);
  f.after=(host,op,args,result)=>{
    if(host===hosts[0]&&op.endsWith('.isolate')){
      const node=f.nodes.get(args.operationId);node.phases.isolate={ok:false,error:'active lease in use'};node.result=null;node.state='FENCED';
    }
    if(op.endsWith('.status'))result.stoppedPhases=Object.keys(result.phases);
  };
  const r=await f.start();assert.equal(r.result.state,'BLOCKED');assert.match(r.result.error,/正在使用/);
  assert.equal((await f.call('datasets.delete.status',{key:r.args.key})).state,'BLOCKED');
});
