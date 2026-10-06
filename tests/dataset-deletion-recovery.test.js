import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {fixture,hosts,version,principal,admin,request,writes} from './dataset-deletion-fixture.mjs';

async function setup(t,options={}){
  const f=fixture(t,{options});
  if(process.env.DATASET_DELETE_CODE_ROOT){
    const {installDatasetDeletion}=await import(pathToFileURL(process.env.DATASET_DELETE_CODE_ROOT+'/dataset-deletion.mjs'));
    installDatasetDeletion(f.service,{pollMs:1,waitMs:30000,...options});
    // Old protocol fixtures were missing the new node alias attestation.
    const bridge=f.service.bridge;f.service.bridge=async(...args)=>{
      const value=await bridge(...args);
      if(value?.authorityAliases)delete value.authorityAliases;
      if(value?.result?.authorityAliases)delete value.result.authorityAliases;
      for(const phase of Object.values(value?.phases||{}))if(phase.result?.authorityAliases)delete phase.result.authorityAliases;
      return value;
    };
  }
  return f;
}

test('slow RUNNING isolate beyond thirty seconds advances confirmed phases to DELETED without replay',async t=>{
  let now=Date.now(),reads=0,held;
  const f=await setup(t,{clock:()=>now});
  f.after=(host,op,args,result)=>{
    if(host!==hosts[1])return;
    const node=f.nodes.get(args.operationId);
    if(op.endsWith('.isolate')){held=node.phases.isolate;delete node.phases.isolate;f.pending=true;}
    if(op.endsWith('.status')&&held){
      now+=40000;reads++;
      if(reads<4){delete result.phases.isolate;result.result=null;}
      else{node.phases.isolate=held;result.phases.isolate=held;result.result=held.result;result.pendingPhases=[];held=null;f.pending=false;}
    }
  };
  const r=await f.start();assert.equal(r.result.state,'DELETED',JSON.stringify(r.result));
  assert.ok(reads>=4&&now-Date.parse(r.first.createdAt)>30000);
  assert.equal(writes(f).filter(c=>c.op.endsWith('.isolate')).length,hosts.length);
});

test('admin continue queries original dispatched UUID and advances only undispatched phases',async t=>{
  const f=fixture(t);let lost=true;
  f.after=(host,op)=>{if(lost&&op.endsWith('.fence')){lost=false;throw Error('lost fence reply');}};
  const r=await f.start();assert.equal(r.result.state,'UNKNOWN');const before=writes(f).length;
  await assert.rejects(f.call('datasets.delete.continue',{operationId:r.first.operationId}),e=>e.status===403);
  await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  const result=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);
  assert.equal(result.state,'DELETED');
  assert.equal(writes(f).filter(c=>c.op.endsWith('.fence')&&c.host===hosts[0]).length,1);
  assert.ok(writes(f).slice(before).every(c=>c.args.userId===admin.userId&&c.args.hostAdmin===true));
  assert.ok(f.audits.some(a=>a[0]===admin.username&&a[1]==='datasets.delete.continue'));
});

test('admin cancel restores isolated steps and releases unisolated fences without unregister',async t=>{
  const f=fixture(t);let lost=true;
  f.after=(host,op)=>{if(lost&&host===hosts[1]&&op.endsWith('.isolate')){lost=false;throw Error('lost target reply');}};
  const r=await f.start();assert.equal(r.result.state,'UNKNOWN');
  await assert.rejects(f.call('datasets.delete.cancel',{operationId:r.first.operationId}),e=>e.status===403);
  const accepted=await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);assert.equal(accepted.state,'CANCELING');
  await f.service.waitDatasetDeletions();const result=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);
  assert.equal(result.state,'CANCELED',JSON.stringify(result));
  assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
  assert.ok(!f.calls.some(c=>c.op==='datasets.unregister'));
  for(const host of hosts)assert.equal((await f.service.bridge(host,'datasets.prepare',{dataset:'personal',version,userId:principal.userId,hostAdmin:false})).state,'READY');
  assert.ok(f.audits.some(a=>a[1]==='datasets.delete.cancel'));
  const count=writes(f).length;assert.equal((await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin)).state,'CANCELED');assert.equal(writes(f).length,count);
});

test('cancel during RUNNING waits for original worker and never advances original isolation',async t=>{
  const f=fixture(t);let signal,finish;const entered=new Promise(r=>signal=r),released=new Promise(r=>finish=r);
  f.before=async(host,op)=>{if(host===hosts[1]&&op.endsWith('.isolate')){signal();await released;}};
  const first=await f.call('datasets.delete',request());await entered;
  await f.call('datasets.delete.cancel',{operationId:first.operationId},admin);finish();await f.service.waitDatasetDeletions();
  const result=await f.call('datasets.delete.status',{operationId:first.operationId},admin);assert.equal(result.state,'CANCELED',JSON.stringify(result));
  assert.equal(writes(f).filter(c=>c.host===hosts[0]&&c.op.endsWith('.isolate')).length,0);
  assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
});

test('unauthorized shared delete leaves no fences and another user can prepare normally',async t=>{
  const f=fixture(t);f.personal=false;assert.equal((await f.start()).result.state,'BLOCKED');
  assert.equal(writes(f).length,0);assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
  const result=await f.service.bridge(hosts[0],'datasets.prepare',{dataset:'personal',version,userId:admin.userId,hostAdmin:true});assert.equal(result.state,'READY');
});

test('source restore releases both absent and registered evicted incomplete namespaces',async t=>{
  const f=fixture(t);
  f.after=(host,op,args,result)=>{if(host===hosts[1]&&op.endsWith('.plan'))result.absent=false;};
  const r=await f.start();assert.equal(r.result.state,'DELETED');
  assert.equal((await f.call('datasets.delete.restore',{operationId:r.first.operationId,machine:hosts[0]},admin)).state,'RESTORED');
  assert.ok(writes(f).some(c=>c.host===hosts[1]&&c.op.endsWith('.restore')));
  assert.equal(writes(f).filter(c=>c.op.endsWith('.release-absence')).length,hosts.length-2);
  assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
});

test('capabilities run concurrently; short timeout produces UI cap0 with zero plans or fences',async t=>{
  const f=fixture(t,{options:{capabilityTimeoutMs:10}});let entered=0,release;
  const all=new Promise(r=>release=r);
  f.before=async(host,op)=>{if(op.endsWith('.capabilities')){entered++;if(entered===hosts.length)release();await all;}};
  assert.deepEqual(await f.service.datasetDeleteCapabilities(principal),{datasetDelete:1});assert.equal(entered,hosts.length);
  const count=f.calls.length;assert.deepEqual(await f.service.datasetDeleteCapabilities(principal),{datasetDelete:1});assert.equal(f.calls.length,count,'UI success has short TTL');
  const g=fixture(t,{options:{capabilityTimeoutMs:10}});g.before=async(host,op)=>{if(op.endsWith('.capabilities'))await new Promise(()=>{});};
  assert.deepEqual(await g.service.datasetDeleteCapabilities(principal),{datasetDelete:0});
  await assert.rejects(g.call('datasets.delete',request()),e=>e.status===409&&e.code==='DATASET_DELETE_UNSUPPORTED');
  assert.ok(g.calls.every(c=>c.op.endsWith('.capabilities')));assert.equal(writes(g).length,0);assert.deepEqual(g.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
});

test('node deadline skew within five minutes confirms while larger skew is pending and cancelable',async t=>{
  for(const skew of [-299,299,-301]){
    const f=fixture(t);f.after=(host,op,args,result)=>{
      if(host===hosts[1]&&op.endsWith('.isolate')){const node=f.nodes.get(args.operationId);node.result.retainUntil+=skew;}
    };
    const r=await f.start();assert.equal(r.result.state,skew===-301?'UNKNOWN':'DELETED');
    if(skew===-301){await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();assert.equal((await f.call('datasets.delete.status',{operationId:r.first.operationId},admin)).state,'CANCELED');}
    else assert.equal(r.result.copyNotice,'其他名称下的副本不受影响');
  }
});

test('dependency projection changes do not prevent safe cancellation of original fixed scopes',async t=>{
  const f=fixture(t);let lost=true;f.after=(host,op)=>{if(lost&&op.endsWith('.fence')){lost=false;throw Error('lost original response');}};
  const r=await f.start();assert.equal(r.result.state,'UNKNOWN');
  f.service.db.exec('CREATE TABLE storage_archives(data TEXT)');
  f.service.db.prepare('INSERT INTO storage_archives VALUES(?)').run(JSON.stringify({id:'changed',machine:hosts[0],sourceMachine:hosts[1],dataset:'personal',version,failureStage:'authority-retired',phase:'BLOCKED'}));
  await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  assert.equal((await f.call('datasets.delete.status',{operationId:r.first.operationId},admin)).state,'CANCELED');
  assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
});

test('unknown status continue cancel and restore never expose private node error details',async t=>{
  for(const operation of ['status','continue','cancel','restore']){
    const f=fixture(t);let lost=operation!=='restore';
    f.after=(host,op)=>{if(lost&&op.endsWith('.fence')){lost=false;throw Error('lost original reply');}};
    const r=await f.start();assert.equal(r.result.state,operation==='restore'?'DELETED':'UNKNOWN');
    f.before=(host,op)=>{if(op.endsWith('.status'))throw Error('opaque-secret node path /private/storage/private-owner/grant.json');};
    const args={operationId:r.first.operationId,...(operation==='restore'?{machine:hosts[0]}:{})};
    const value=await f.call('datasets.delete.'+operation,args,admin);
    await f.service.waitDatasetDeletions();
    const status=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);
    assert.doesNotMatch(JSON.stringify([value,status]),/opaque-secret|\/private\/storage|private-owner|grant\.json/);
    assert.notEqual(status.state,'DELETED');
    assert.ok(status.error||status.steps.some(step=>step.error));
  }
});

test('historical cancel receipt cannot release portal fences without the matching current node outcome',async t=>{
  for(const change of ['missing','changed','state','extra']){
    const f=fixture(t);let lost=true;
    f.after=(host,op)=>{if(lost&&op.endsWith('.fence')){lost=false;throw Error('lost original reply');}};
    const r=await f.start();assert.equal(r.result.state,'UNKNOWN');
    f.after=(host,op,args,result)=>{
      if(!op.endsWith('.status')||!result.phases.cancel)return;
      if(change==='missing')result.result=null;
      if(change==='changed')result.result={...result.result,snapshotSha256:'f'.repeat(64)};
      if(change==='state')result.state='FENCED';
      if(change==='extra')result.phases.cancel.result={...result.phases.cancel.result,untrusted:true};
    };
    await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
    assert.notEqual((await f.call('datasets.delete.status',{operationId:r.first.operationId},admin)).state,'CANCELED');
    assert.ok(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all().length);
    f.after=null;
    await f.call('datasets.delete.cancel',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
    assert.equal((await f.call('datasets.delete.status',{operationId:r.first.operationId},admin)).state,'CANCELED');
    assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
    assert.equal(writes(f).filter(call=>call.op.endsWith('.cancel')&&call.host===hosts[0]).length,1);
  }
});
