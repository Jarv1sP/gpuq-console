import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,hosts,admin,writes,request} from './dataset-deletion-fixture.mjs';

test('N2b idle portal observes confirmed isolation as WAITING_CONTINUE without restart and explicitly finishes the original phases',async t=>{
  const f=fixture(t,{onlySource:false});let lost=true;
  f.after=(host,op)=>{if(lost&&host===hosts[0]&&op.endsWith('.isolate')){lost=false;throw Error('fixed source receipt lost');}};
  const r=await f.start();
  assert.equal(r.result.state,'WAITING_CONTINUE');assert.equal(r.result.canContinue,true);
  assert.match(r.result.error,/等待继续/);assert.doesNotMatch(r.result.error,/门户已重启/);
  assert.ok(r.result.steps.every(step=>step.state==='ISOLATED'));
  const before=writes(f).length,isolates=f.calls.filter(c=>c.op.endsWith('.isolate')).length;
  const status=await f.call('datasets.delete.status',{key:r.args.key},admin);
  assert.equal(status.state,'WAITING_CONTINUE');assert.equal(status.canContinue,true);assert.equal(writes(f).length,before,'status never starts a worker');
  f.after=null;await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  assert.equal((await f.call('datasets.delete.status',{key:r.args.key},admin)).state,'DELETED');
  assert.equal(f.calls.filter(c=>c.op.endsWith('.isolate')).length,isolates,'continue commits verified original isolation without replay');
});

test('N2b actual portal progression retains its active phase and is not offered continue',async t=>{
  const f=fixture(t);let entered,release;
  const gate=new Promise(resolve=>{release=resolve;}),inside=new Promise(resolve=>{entered=resolve;});
  f.before=async(_host,op)=>{if(op.endsWith('.isolate')){entered();await gate;}};
  const args=request(),first=await f.call('datasets.delete',args);await inside;
  try{
    const status=await f.call('datasets.delete.status',{operationId:first.operationId},admin);
    assert.equal(status.state,'REMOVING_CACHES');assert.equal(Object.hasOwn(status,'canContinue'),false);
  }finally{release();await f.service.waitDatasetDeletions();}
  assert.equal((await f.call('datasets.delete.status',{key:args.key},admin)).state,'DELETED');
});
