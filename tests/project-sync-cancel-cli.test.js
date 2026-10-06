import test from 'node:test';
import assert from 'node:assert/strict';
import {runManualSync} from '../client-snapshot-sync.mjs';
const key='12345678-1234-4234-8234-123456789012',snapshotId='22345678-1234-4234-8234-123456789012';
const initial=()=>({cancelProtocol:1,state:'COPYING',project:'draft',key,snapshotId,source:{kind:'git',commit:'a'.repeat(40)},manifestSha256:'b'.repeat(64),revision:'c'.repeat(64)});
const context=(mode='cancel',extra={})=>({options:{machines:[],datasets:[],to:'fixture-node',project:'draft',...extra},positionals:['sync',mode,key],training:[],machines:[{id:'fixture-node'}],userId:'fixture-owner'});

test('cancel pins same original status proof, emits one exact mutation and never scans local Git',async()=>{
  const before=initial(),calls=[];
  const result=await runManualSync(async(op,args)=>{calls.push({op,args});return {result:op.endsWith('.cancel')?{...before,state:'CANCELED',preservesBytes:true}:before};},context());
  assert.equal(result.state,'CANCELED');assert.deepEqual(calls,[{op:'projects.sync.status',args:{machine:'fixture-node',project:'draft',key}},{op:'projects.sync.cancel',args:{machine:'fixture-node',project:'draft',key,...Object.fromEntries(['snapshotId','source','manifestSha256','revision'].map(k=>[k,before[k]]))}}]);
});

test('status is only an original-ID observation and confirmed canceled retry is read-only',async()=>{
  for(const mode of ['status','cancel']){const calls=[],before={...initial(),state:'CANCELED',preservesBytes:true};const result=await runManualSync(async(op,args)=>{calls.push({op,args});return {result:before};},context(mode));assert.equal(result.state,'CANCELED');assert.deepEqual(calls.map(c=>c.op),['projects.sync.status']);}
});

test('lost cancel acknowledgement observes only original UUID; no second mutation or replacement key',async()=>{
  const calls=[],before=initial();
  const result=await runManualSync(async(op,args)=>{calls.push({op,args});if(op.endsWith('.cancel'))throw Error('lost acknowledgement');return {result:calls.length>2?{...before,state:'CANCELED',preservesBytes:true}:before};},context());
  assert.equal(result.state,'CANCELED');assert.deepEqual(calls.map(c=>c.op),['projects.sync.status','projects.sync.cancel','projects.sync.status']);assert.equal(calls.every(c=>c.args.key===key),true);
});

test('unknown or differently bound acknowledgement keeps failure and does not resend',async()=>{
  for(const observation of [{...initial(),state:'UNKNOWN'},{...initial(),state:'CANCELED',preservesBytes:true,snapshotId:key}]){
    const calls=[];await assert.rejects(runManualSync(async(op)=>{calls.push(op);if(op.endsWith('.cancel'))throw Error('lost acknowledgement');return {result:calls.length>2?observation:initial()};},context()),/lost acknowledgement/);
    assert.deepEqual(calls,['projects.sync.status','projects.sync.cancel','projects.sync.status']);
  }
});

test('old node, complete sync, zero grant and unwanted fields never dispatch cancellation',async()=>{
  for(const before of [{...initial(),cancelProtocol:undefined},{...initial(),state:'CODE_READY'},{...initial(),revision:'invalid'}]){const calls=[];await assert.rejects(runManualSync(async(op)=>{calls.push(op);return {result:before};},context()));assert.deepEqual(calls,['projects.sync.status']);}
  for(const extra of [{from:'source'},{key},{'dry-run':true},{root:true},{to:'auto'},{to:'ungranted-node'}])await assert.rejects(runManualSync(()=>{throw Error('must not call');},context('cancel',extra)));
});
