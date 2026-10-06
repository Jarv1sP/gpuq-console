import test from 'node:test';
import assert from 'node:assert/strict';
import {installDatasetDeletion} from '../dataset-deletion.mjs';
import {fixture,hosts,version,admin,writes} from './dataset-deletion-fixture.mjs';

test('explicit continue completes interrupted authority inspection using every original child UUID',async t=>{
  for(const onlySource of [true,false]){
    const f=fixture(t,{onlySource});let blocked=true;
    f.after=(host,op,args,result)=>{
      if(host===hosts[0]&&op.endsWith('.plan'))result.authority={protocol:'dataset-authority-dependencies-v1',
        sourceMachine:host,dataset:args.dataset,version:args.version,grants:[]};
      if(blocked&&op.endsWith('.locations'))throw Error('fixed ordinary-removal alias needs reconciliation');
    };
    const r=await f.start();assert.equal(r.result.state,'UNKNOWN');assert.equal(writes(f).length,0);
    let row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
    assert.ok(row.source,'source was selected before locations failed');assert.equal(row.inspectionComplete,false);
    const originalChildren=row.steps.map(s=>({machine:s.machine,dataset:s.dataset,operationId:s.operationId}));
    const planCount=f.calls.filter(c=>c.op.endsWith('.plan')).length;
    await f.call('datasets.delete.status',{key:r.args.key});
    assert.equal(f.calls.filter(c=>c.op.endsWith('.plan')).length,planCount,'status cannot complete inspection or dispatch');
    blocked=false;
    await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
    const result=await f.call('datasets.delete.status',{key:r.args.key},admin);assert.equal(result.state,'DELETED',JSON.stringify(result));
    row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
    assert.equal(row.inspectionComplete,true);assert.deepEqual(row.steps.map(s=>({machine:s.machine,dataset:s.dataset,operationId:s.operationId})),originalChildren);
    assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,1);
    assert.equal(writes(f).filter(c=>c.op.endsWith('.isolate')).length,hosts.length,'each fixed phase is dispatched once');
  }
});

test('a restarted pre-dispatch legacy source selection does not skip unfinished inspection',async t=>{
  const f=fixture(t);let lost=true;
  f.after=(host,op,args,result)=>{
    if(host===hosts[0]&&op.endsWith('.plan'))result.authority={protocol:'dataset-authority-dependencies-v1',sourceMachine:host,dataset:args.dataset,version:args.version,grants:[]};
    if(lost&&op.endsWith('.locations'))throw Error('legacy inspection interrupted');
  };
  const r=await f.start();const row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  delete row.inspectionComplete;f.service.db.prepare('UPDATE dataset_deletions SET data=?').run(JSON.stringify(row));
  installDatasetDeletion(f.service,{pollMs:1,capabilityTimeoutMs:30});lost=false;
  await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  assert.equal((await f.call('datasets.delete.status',{key:r.args.key},admin)).state,'DELETED');
});

test('already authorized legacy phases never re-plan after an isolation result is lost',async t=>{
  const f=fixture(t);let lost=true;
  f.after=(host,op,args,result)=>{
    if(op.endsWith('.status'))result.stoppedPhases=Object.keys(result.phases);
    if(lost&&op.endsWith('.isolate')){lost=false;throw Error('fixed isolate reply lost');}
  };
  const r=await f.start();let row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  assert.equal(row.authorized,true);assert.ok(row.steps.some(s=>s.dispatched.length));
  delete row.inspectionComplete;f.service.db.prepare('UPDATE dataset_deletions SET data=?').run(JSON.stringify(row));
  const count=f.calls.filter(c=>c.op.endsWith('.plan')||c.op.endsWith('.locations')).length;
  await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  assert.equal((await f.call('datasets.delete.status',{key:r.args.key},admin)).state,'DELETED');
  assert.equal(f.calls.filter(c=>c.op.endsWith('.plan')||c.op.endsWith('.locations')).length,count,'old authorized generation keeps its original proofs');
});

test('failed negative plans keep source selection incomplete until explicit same-key continuation',async t=>{
  const f=fixture(t);let interrupted=true;
  f.after=(host,op)=>{if(interrupted&&host===hosts[1]&&op.endsWith('.plan'))throw Error('negative plan reply interrupted');};
  const r=await f.start();let row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  const originalSource=row.source,originalChildren=row.steps.map(s=>s.operationId);
  assert.equal(r.result.state,'UNKNOWN');assert.ok(originalSource);assert.equal(row.inspectionComplete,false);assert.equal(writes(f).length,0);
  interrupted=false;await f.call('datasets.delete.status',{key:r.args.key});assert.equal(writes(f).length,0);
  await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  assert.equal(row.state,'DELETED');assert.equal(row.source,originalSource);assert.equal(row.inspectionComplete,true);
  assert.deepEqual(row.steps.slice(0,originalChildren.length).map(s=>s.operationId),originalChildren);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,1);
});

test('graph changes during inspection block every write and retain the original child IDs',async t=>{
  const f=fixture(t);f.service.db.exec('CREATE TABLE storage_archives(data TEXT)');let changed=false;
  f.after=(host,op)=>{
    if(!changed&&host===hosts.at(-1)&&op.endsWith('.plan')){
      changed=true;f.service.db.prepare('INSERT INTO storage_archives VALUES(?)').run(JSON.stringify({id:'late-external',
        machine:hosts[0],sourceMachine:hosts[1],dataset:'personal',version,failureStage:'authority-retired',phase:'BLOCKED'}));
    }
  };
  const r=await f.start();let row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  const originalChildren=row.steps.map(s=>s.operationId);
  assert.equal(row.state,'BLOCKED');assert.equal(row.inspectionComplete,false);assert.equal(writes(f).length,0);
  await f.call('datasets.delete.status',{key:r.args.key});assert.equal(writes(f).length,0);
  await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  assert.equal(row.state,'DELETED');assert.deepEqual(row.steps.map(s=>s.operationId),originalChildren);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,1);
});

test('a second authority discovered during original inspection recovery cannot replace the saved source',async t=>{
  const f=fixture(t,{onlySource:false});let recovering=false;
  f.after=(host,op,args,result)=>{
    if(op.endsWith('.plan')&&(host===hosts[0]||recovering&&host===hosts[1]))result.authority={protocol:'dataset-authority-dependencies-v1',
      sourceMachine:host,dataset:args.dataset,version:args.version,grants:[]};
    if(!recovering&&op.endsWith('.locations'))throw Error('original dependency reply interrupted');
  };
  const r=await f.start();let row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  const originalSource=row.source,originalChildren=row.steps.map(s=>s.operationId);
  recovering=true;await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  assert.equal(row.state,'BLOCKED');assert.equal(row.source,originalSource);assert.equal(row.inspectionComplete,false);
  assert.deepEqual(row.steps.map(s=>s.operationId),originalChildren);assert.equal(writes(f).length,0);
});
