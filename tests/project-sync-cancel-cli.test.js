import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runManualSync} from '../client-snapshot-sync.mjs';
import {standaloneClient} from '../client-bundle.mjs';
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

test('proof source equality is exact in fields but independent of JSON property order',async()=>{
  const before=initial();
  const result=await runManualSync(async(op)=>({result:op.endsWith('.cancel')?{...before,state:'CANCELED',preservesBytes:true,source:{commit:before.source.commit,kind:before.source.kind}}:before}),context());
  assert.equal(result.state,'CANCELED');assert.deepEqual(result.source,before.source);
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

test('downloadable standalone CLI parses normal status/cancel and reports code cancellation, not data READY',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-sync-cancel-cli-')),client=join(root,'gpuctl.mjs'),session=join(root,'session'),calls=[];
  await writeFile(client,await standaloneClient());let value=initial();
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const {operation,args}=JSON.parse(raw);calls.push({operation,args});res.setHeader('Content-Type','application/json');
    if(operation==='state'){res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[{id:'fixture-node'}],users:[],jobs:[]}}));return;}
    assert.equal(args.key,key);assert.equal(args.machine,'fixture-node');assert.equal(args.project,'draft');
    if(operation==='projects.sync.cancel')value={...value,state:'CANCELED',preservesBytes:true};
    else assert.equal(operation,'projects.sync.status');res.end(JSON.stringify({result:value}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  await writeFile(session,JSON.stringify({url,token:'fixture-only',principal:{userId:'fixture-owner',username:'fixture',role:'member'}}));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const run=(mode,json=false)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[client,'--url',url,'--session-file',session,...(json?['--json']:[]),'sync',mode,key,'--to','fixture-node','--project','draft']);let stdout='',stderr='';
    child.on('error',reject);child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  const status=await run('status',true);assert.equal(status.code,0,status.stderr);assert.equal(JSON.parse(status.stdout).data.state,'COPYING');
  const canceled=await run('cancel');assert.equal(canceled.code,0,canceled.stderr);assert.match(canceled.stdout,/代码同步：CANCELED/);assert.match(canceled.stdout,/已保留部分代码和原回执/);assert.doesNotMatch(canceled.stdout,/数据已就绪|undefined/);
  const again=await run('cancel',true);assert.equal(again.code,0,again.stderr);assert.equal(JSON.parse(again.stdout).data.state,'CANCELED');assert.equal(calls.filter(c=>c.operation==='projects.sync.cancel').length,1);
});
