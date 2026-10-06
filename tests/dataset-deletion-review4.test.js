import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {installDatasetDeletion} from '../dataset-deletion.mjs';
import {fixture,hosts,principal,admin,writes,version} from './dataset-deletion-fixture.mjs';

test('R4-2 definite refusal reasons are mapped exactly once in execute and observe',async t=>{
  const cases=[['maintenance active','服务器正在维护，请等待管理员恢复。'],
    ['服务器维护中：磁盘检查。新任务、终端输入和数据写入已暂停，请等待管理员明确恢复；仍可查看历史、日志或取消任务。','服务器正在维护，请等待管理员恢复。'],
    ['archive dependency unconfirmed','归档或副本依赖未确认，请联系管理员核对。'],
    ['归档或副本依赖未确认，请联系管理员核对。','归档或副本依赖未确认，请联系管理员核对。'],
    ['would overwrite existing registration','已有同名数据，恢复不会覆盖。'],
    ['active leases prevent deletion','仍有训练或传输正在使用这份数据。'],
    ['persistent pins prevent deletion','这份数据仍有固定保留。'],
    ['personal provenance unconfirmed','账号或来源权限未确认，请联系管理员。']];
  for(const [reason,expected] of cases){
    const f=fixture(t);f.after=(host,op,args)=>{
      if(host===hosts[0]&&op.endsWith('.isolate')){
        const node=f.nodes.get(args.operationId);node.phases.isolate={ok:false,error:reason};node.state='FENCED';node.result=null;
      }
    };
    const r=await f.start();assert.equal(r.result.state,'BLOCKED');assert.equal(r.result.error,expected,reason);
    assert.equal((await f.call('datasets.delete.status',{key:r.args.key})).error,expected,reason+' after status');
  }
});

test('R4-3 terminal deletion tombstones do not block whole-dataset removal while live tasks still do',async t=>{
  const f=fixture(t),r=await f.start();assert.equal(r.result.state,'DELETED');
  assert.equal(f.service.datasetDeletionBlocked(hosts[0],{dataset:'personal',version:null}),false);
  assert.equal(f.service.datasetDeletionBlocked(hosts[0],{dataset:'personal',version}),true,'exact-version background recreation stays fenced');
  const row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  for(const state of ['PLANNED','RUNNING','BLOCKED','UNKNOWN','CANCELING','WAITING_CONTINUE']){
    row.state=state;f.service.db.prepare('UPDATE dataset_deletions SET data=?').run(JSON.stringify(row));
    assert.equal(f.service.datasetDeletionBlocked(hosts[0],{dataset:'personal',version:null}),true,state);
  }
});

async function active(f){
  let lost=true;f.after=(host,op,args)=>{if(lost&&host===hosts[0]&&op.endsWith('.isolate')){lost=false;throw Error('lost outcome');}};
  const r=await f.start();
  f.after=(host,op,args,result)=>{if(op.endsWith('.status')){
    result.stoppedPhases=Object.keys(result.phases);
    if(host===hosts[0]){result.phases.isolate={ok:false,error:'prior temporary failure'};result.pendingPhases=['isolate'];result.unconfirmedPhases=[];result.stoppedPhases=[];}
  }};
  installDatasetDeletion(f.service,{pollMs:1,capabilityTimeoutMs:30});
  return r;
}

test('R4-4 active original workers keep continue and restore waiting without new writes or failure',async t=>{
  for(const op of ['datasets.delete.continue','datasets.delete.restore']){
    const f=fixture(t),r=await active(f),count=writes(f).length;
    const result=await f.call(op,{operationId:r.first.operationId,...(op.endsWith('.restore')?{machine:hosts[0]}:{})},admin);
    await f.service.waitDatasetDeletions();
    const status=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);
    assert.equal(status.state,'WAITING_CONTINUE',op);assert.match(status.error,/仍在进行/);
    assert.equal(status.canContinue,false);assert.equal(writes(f).length,count);
    assert.notEqual(result.state,'BLOCKED');assert.notEqual(result.state,'UNKNOWN');
  }
});

test('R4-4 restarted cancellation remains CANCELING and never advertises continue',async t=>{
  const f=fixture(t),r=await active(f),row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  row.cancelRequested={userId:admin.userId,time:Date.now()};row.state='CANCELING';
  f.service.db.prepare('UPDATE dataset_deletions SET data=?').run(JSON.stringify(row));
  const before=writes(f).length,status=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);
  assert.equal(status.state,'CANCELING');assert.notEqual(status.canContinue,true);assert.equal(writes(f).length,before);
});

test('R4-4 a completed phase receipt cannot hide its still-running worker from continue or restore',async t=>{
  for(const operation of ['datasets.delete.continue','datasets.delete.restore']){
    const f=fixture(t);let lost=true;
    f.after=(host,op)=>{if(lost&&host===hosts[0]&&op.endsWith('.isolate')){lost=false;throw Error('receipt lost');}};
    const r=await f.start(),before=writes(f).length;
    f.after=(host,op,args,result)=>{if(op.endsWith('.status')){
      result.runningPhases=host===hosts[0]?['isolate']:[];result.pendingPhases=[];result.unconfirmedPhases=[];
      result.stoppedPhases=Object.keys(result.phases).filter(phase=>!result.runningPhases.includes(phase));
    }};
    installDatasetDeletion(f.service,{pollMs:1,capabilityTimeoutMs:30});
    const value=await f.call(operation,{operationId:r.first.operationId,...(operation.endsWith('.restore')?{machine:hosts[0]}:{})},admin);
    assert.equal(value.state,'WAITING_CONTINUE');assert.equal(value.canContinue,false);assert.match(value.error,/仍在进行/);
    const status=await f.call('datasets.delete.status',{operationId:r.first.operationId},admin);
    assert.equal(status.state,'WAITING_CONTINUE');assert.equal(status.canContinue,false);assert.equal(writes(f).length,before);
  }
});

test('NB-B admin discard persists its key and audit before RPC and resumes only that same binding',async t=>{
  const f=fixture(t),r=await f.start(),key=randomUUID(),args={operationId:r.first.operationId,machine:hosts[0],key};
  let lost=true;
  f.after=(host,op,request)=>{if(op.endsWith('.registration-discard')){
    const row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
    assert.equal(row.registrationDiscards[0].key,key);assert.equal(row.registrationDiscards[0].requestedBy,admin.userId);
    assert.ok(f.audits.some(value=>value[3]?.includes('丢弃未安装登记意图')));
    assert.deepEqual(request,{operationId:row.steps[0].operationId,requestKey:key,userId:admin.userId,hostAdmin:true});
    if(lost){lost=false;throw Error('reply lost');}
  }};
  assert.equal((await f.call('datasets.delete.registration.discard',args,admin)).state,'UNKNOWN');
  const result=await f.call('datasets.delete.registration.discard',args,admin);assert.equal(result.state,'DISCARDED');
  const count=writes(f).length;
  assert.deepEqual(await f.call('datasets.delete.registration.discard',args,admin),result);assert.equal(writes(f).length,count);
  await assert.rejects(f.call('datasets.delete.registration.discard',{...args,machine:hosts[1]},admin),/另一个固定/);
  assert.equal(writes(f).length,count);
});

test('NB-B discard rejects member, old capabilities, bad identity overrides and audit failure without node writes',async t=>{
  const f=fixture(t),r=await f.start(),args={operationId:r.first.operationId,machine:hosts[0],key:randomUUID()};
  let count=writes(f).length;
  await assert.rejects(f.call('datasets.delete.registration.discard',args,principal),e=>e.status===403);
  for(const field of ['hostAdmin','userId','path','force','generation']){
    await assert.rejects(f.call('datasets.delete.registration.discard',{...args,[field]:true},admin),e=>e.status===400);
  }
  f.cap=0;await assert.rejects(f.call('datasets.delete.registration.discard',args,admin),e=>e.code==='DATASET_DELETE_UNSUPPORTED');
  assert.equal(writes(f).length,count);
  f.cap=1;f.auditFailure=true;await assert.rejects(f.call('datasets.delete.registration.discard',args,admin),/audit full/);
  assert.equal(writes(f).length,count);
});

test('NB-B malformed or changed discard receipts stay unconfirmed and cannot free deletion fences',async t=>{
  for(const change of [{generation:'e'.repeat(64)},{operationId:randomUUID()},{state:'DISCARDED',extra:true}]){
    const f=fixture(t),r=await f.start(),args={operationId:r.first.operationId,machine:hosts[0],key:randomUUID()};
    const before=f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all();
    f.after=(host,op,request,result)=>{if(op.endsWith('.registration-discard'))Object.assign(result,change);};
    assert.equal((await f.call('datasets.delete.registration.discard',args,admin)).state,'UNKNOWN');
    assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),before);
  }
});
