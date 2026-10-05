import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {scanBrowserDirectory,uploadBrowserDataset,confirmedDatasetUpload,validateBrowserUploadGrant,CHUNK_BYTES,LARGE_RELAY_BYTES} from '../dist/dataset-upload.js';
import {transferUploadCall} from '../dist/transfer-upload.js';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const id='12345678-1234-4234-8234-123456789012',endpoint='https://upload.example.test';
function file(path,bytes){const blob=new Blob([bytes]);Object.defineProperties(blob,{name:{value:path},webkitRelativePath:{value:'selected/'+path}});return blob;}
async function fixture({size=CHUNK_BYTES+13,directAvailable=true,chunkBytes=CHUNK_BYTES,fixedRoutes=false}={}){
  const content=Buffer.alloc(size,7),scan=await scanBrowserDirectory([file('训练/样本.bin',content),file('empty','')]),portal=[],raw=[],routes=[],progress=[],handles=new Map();
  let clock=1000,state='RECEIVING_MANIFEST',manifest=Buffer.alloc(0),published=false,ticketNumber=0,loseChunk=false,revoke=false,failDirect=false,loseCommit=false,mismatch=false;
  const stored=new Map(),transport={protocol:'dataset-upload-v1',directAvailable,relayLimitBytes:LARGE_RELAY_BYTES,relayAllowed:false,...(fixedRoutes?{routeSelection:true}:{})};
  const alternate='https://tail.example.test',revision='c'.repeat(64),probes=[];
  const descriptor={available:true,protocol:'dataset-upload-v1',machine:'node-a',revision,certificateSha256:'a'.repeat(64),routes:[
    {id:'primary',kind:'campus-direct',endpoint},{id:'tail',kind:'tail-upload',endpoint:alternate}]};
  const describe=()=>({uploadId:id,state,name:'mine',manifestOffset:manifest.length,totalBytes:scan.totalBytes,entries:scan.entries,chunkBytes,...(published?{dataset:'u-test-mine',version:digest(manifest)}:{})});
  const grant=(routeId='primary')=>({available:true,protocol:'dataset-upload-v1',endpoint:routeId==='tail'?alternate:endpoint,ticket:'fixture-only-ticket-'+(++ticketNumber),expiresAt:clock+300,certificateSha256:'a'.repeat(64),chunkBytes,
    ...(fixedRoutes?{routeId,machine:'node-a',revision,kind:routeId==='tail'?'tail-upload':'campus-direct'}:{})});
  const call=async(operation,args)=>{
    portal.push({operation,args:structuredClone(args)});assert.equal(args.machine,'node-a');
    assert.equal('userId' in args||'hostAdmin' in args,false);
    const action=operation.split('.').at(-1);
    if(action==='begin'){if(args.allowRelay===true)transport.relayAllowed=true;return {...describe(),uploadTransport:{...transport}};}
    if(action==='routes'){assert.deepEqual(args,{machine:'node-a'});return descriptor;}
    assert.equal(args.uploadId,id);
    if(action==='direct-ticket')return grant(args.routeId);
    if(action==='seal'){assert.equal(digest(manifest),scan.manifestSha256);state='UPLOADING';return describe();}
    if(action==='commit'){
      for(const entry of scan.files){assert.equal(digest(stored.get(entry.path)),entry.sha256);assert.equal(stored.get(entry.path).length,entry.size);}
      published=true;state='READY';if(loseCommit){loseCommit=false;throw Error('lost response');}return describe();
    }
    if(action==='status')return {...describe(),...(mismatch?{entries:scan.entries+1}:{})};
    throw Error('Bytes must not use the portal: '+action);
  };
  const send=async(url,options)=>{
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.equal(Object.keys(options.headers).some(name=>name.toLowerCase()==='cookie'),false);
    const target=new URL(url);
    if(target.pathname==='/capabilities'){
      probes.push(target.origin);assert.deepEqual(options.headers,{Accept:'application/json'});
      if(target.origin===endpoint||failDirect)throw Error('unreachable');
      assert.equal(target.origin,alternate);return Response.json({protocol:'dataset-upload-v1',machine:'node-a',revision,listenerReady:true});
    }
    assert.equal(target.origin,fixedRoutes?alternate:endpoint);assert.ok(options.headers.Authorization.startsWith('Bearer fixture-only-ticket-'));
    const action=target.pathname.split('/').at(-1),path=target.searchParams.get('path');
    raw.push({action,path,offset:Number(target.searchParams.get('offset')),method:options.method,ticket:options.headers.Authorization,bytes:options.body?.byteLength});
    assert.ok(target.pathname.includes('/'+id+'/'));
    if(failDirect)throw Error('TLS/network failure');
    if(revoke&&action==='chunk'){revoke=false;return new Response('',{status:401});}
    let result=describe();
    if(action==='status'&&path){const entry=scan.files.find(row=>row.path===path),bytes=stored.get(path);result={...result,file:{...entry,offset:bytes?.length||0,complete:!!bytes&&bytes.length===entry.size}};}
    if(action==='manifest'||action==='chunk'){
      assert.equal(options.method,'POST');assert.equal(options.headers['Content-Type'],'application/octet-stream');assert.ok(options.body instanceof Uint8Array);assert.ok(options.body.byteLength<=chunkBytes);
      const bytes=Buffer.from(options.body),previous=action==='manifest'?manifest:stored.get(path)||Buffer.alloc(0);
      assert.equal(Number(target.searchParams.get('offset')),previous.length);
      const next=Buffer.concat([previous,bytes]);if(action==='manifest')manifest=next;else stored.set(path,next);
      result={...describe(),offset:next.length,complete:action==='chunk'&&next.length===scan.files.find(row=>row.path===path).size};
      if(action==='chunk'&&loseChunk&&bytes.length){loseChunk=false;throw Error('response lost after durable write');}
    }
    return Response.json({ok:true,result});
  };
  const options={call,scan,userId:'member',machine:'node-a',name:'mine',pollMs:0,fetch:send,now:()=>clock,onRoute:route=>routes.push(route),onProgress:value=>progress.push(value),keyStore:{getHandle:key=>handles.get(key),setHandle:(key,value)=>handles.set(key,value)}};
  return {options,portal,raw,routes,probes,progress,content,stored,transport,handles,advance:()=>{clock+=295;},loseChunk:()=>{loseChunk=true;},revoke:()=>{revoke=true;},failDirect:()=>{failDirect=true;},loseCommit:()=>{loseCommit=true;},mismatch:()=>{mismatch=true;}};
}
test('browser chooses a fixed alternate anonymously before ticketing and retains it on renewal',async()=>{
  const f=await fixture({fixedRoutes:true});f.revoke();
  const result=await uploadBrowserDataset(f.options);
  assert.equal(result.state,'READY');assert.equal(result.route.kind,'tail-upload');
  assert.deepEqual(f.probes,[endpoint,'https://tail.example.test']);
  const tickets=f.portal.filter(x=>x.operation.endsWith('.direct-ticket'));
  assert.equal(tickets.length,2);assert.ok(tickets.every(x=>x.args.routeId==='tail'));
  assert.equal(f.portal.some(x=>x.args.data||x.args.bytes),false);
});
test('browser failed approved probes never issue a ticket or silently use relay',async()=>{
  const f=await fixture({fixedRoutes:true});f.failDirect();f.options.allowRelay=true;
  await assert.rejects(uploadBrowserDataset(f.options),/no ticket issued/);
  assert.deepEqual(f.portal.map(x=>x.operation),['datasets.upload.begin','datasets.upload.routes']);
  assert.equal(f.raw.length,0);
});
test('a configured unavailable listener cannot quietly become a small VPS upload',async()=>{
  const f=await fixture({fixedRoutes:true,directAvailable:false});f.transport.reason='listener-unavailable';
  await assert.rejects(uploadBrowserDataset(f.options),/未自动改走 VPS/);assert.equal(f.raw.length,0);
  assert.deepEqual(f.portal.map(x=>x.operation),['datasets.upload.begin']);
});
test('browser uses raw bounded node bytes without cookies; only final portal status confirms READY',async()=>{
  const f=await fixture({chunkBytes:64*1024}),result=await uploadBrowserDataset(f.options);
  assert.equal(result.state,'READY');assert.equal(result.route.kind,'campus-direct');assert.deepEqual(f.stored.get('训练/样本.bin'),f.content);
  assert.equal(f.raw.filter(row=>row.action==='chunk'&&row.path==='训练/样本.bin').length,17);
  assert.equal(f.portal.some(row=>'data' in row.args||'bytes' in row.args),false);
  assert.equal(f.portal.at(-1).operation,'datasets.upload.status');
  assert.deepEqual(f.routes,[{kind:'campus-direct',machine:'node-a'}]);assert.equal(f.progress.filter(row=>row.state==='READY').length,1);
  assert.equal(JSON.stringify([...f.handles.values()]).includes('ticket'),false);
});
test('lost node ACK stops, and an explicit retry queries the same upload and resumes at node offset',async()=>{
  const f=await fixture();f.loseChunk();await assert.rejects(uploadBrowserDataset(f.options),error=>error.code==='DIRECT'&&error.uploadId===id);
  assert.equal(f.portal.some(row=>row.operation.endsWith('.commit')||row.operation.endsWith('.chunk')),false);
  const rawAt=f.raw.length,portalAt=f.portal.length;await uploadBrowserDataset(f.options);
  assert.equal(f.portal[portalAt].operation,'datasets.upload.status');
  const resumed=f.raw.slice(rawAt);assert.equal(resumed.find(row=>row.action==='chunk'&&row.path==='训练/样本.bin').offset,CHUNK_BYTES);
  assert.equal(resumed.some(row=>row.action==='manifest'),false);assert.equal(f.stored.get('训练/样本.bin').length,f.content.length);
});
test('five-minute grants renew via portal status and same upload ID before continuing',async()=>{
  const f=await fixture();let advanced=false;const send=f.options.fetch;
  f.options.fetch=async(...args)=>{const response=await send(...args);if(!advanced&&new URL(args[0]).pathname.endsWith('/manifest')){advanced=true;f.advance();}return response;};
  await uploadBrowserDataset(f.options);const tickets=f.portal.filter(row=>row.operation.endsWith('.direct-ticket'));
  assert.equal(tickets.length,2);assert.ok(tickets.every(row=>row.args.uploadId===id));
  const renewal=f.portal.findIndex((row,index)=>index>1&&row.operation.endsWith('.direct-ticket'));
  assert.equal(f.portal[renewal-1].operation,'datasets.upload.status');
  assert.notEqual(f.raw[0].ticket,f.raw.at(-1).ticket);
});
test('revoked grants query node status before retrying an explicitly rejected write',async()=>{
  const f=await fixture();f.revoke();await uploadBrowserDataset(f.options);
  const first=f.raw.findIndex(row=>row.action==='chunk');assert.equal(f.raw[first+1].action,'status');assert.equal(f.raw[first+2].action,'chunk');
  assert.equal(f.raw[first+2].offset,0);assert.equal(f.portal.filter(row=>row.operation.endsWith('.direct-ticket')).length,2);
});
test('a failed direct path never sends relay bytes, even with a preexisting relay consent',async()=>{
  const f=await fixture();f.failDirect();await assert.rejects(uploadBrowserDataset({...f.options,allowRelay:true}),error=>error.code==='DIRECT'&&error.canRelay);
  assert.equal(f.portal.some(row=>row.operation.endsWith('.manifest')||row.operation.endsWith('.chunk')),false);assert.equal(f.progress.some(row=>row.state==='READY'),false);
  const direct=await fixture({directAvailable:false});await assert.rejects(uploadBrowserDataset({...direct.options,via:'direct',allowRelay:true}),/未提供直传入口/);
  assert.equal(direct.raw.length,0);assert.equal(direct.portal.length,1);
});
test('auto can authorize a large direct upload; a missing endpoint rejects it before any bytes',async()=>{
  const f=await fixture({directAvailable:false});f.options.scan={...f.options.scan,totalBytes:LARGE_RELAY_BYTES+1};
  await assert.rejects(uploadBrowserDataset(f.options),error=>error.code==='RELAY_CONSENT'&&error.canRelay);
  assert.equal(f.portal.length,1);assert.equal(f.raw.length,0);
  const direct=await fixture();direct.options.scan.totalBytes=LARGE_RELAY_BYTES+1;
  const result=await uploadBrowserDataset(direct.options);assert.equal(result.state,'READY');assert.equal(direct.portal[0].args.allowRelay,undefined);
});
test('lost commit receipt is queried without resubmitting commit or changing upload identity',async()=>{
  const f=await fixture();f.loseCommit();assert.equal((await uploadBrowserDataset(f.options)).state,'READY');
  const commit=f.portal.findIndex(row=>row.operation.endsWith('.commit'));
  assert.equal(f.portal[commit+1].operation,'datasets.upload.status');assert.equal(f.portal.filter(row=>row.operation.endsWith('.commit')).length,1);
});
test('mismatched final manifest counts never emit READY',async()=>{
  const f=await fixture();f.mismatch();await assert.rejects(uploadBrowserDataset(f.options),/上传结果与本地清单不符/);
  assert.equal(f.progress.some(row=>row.state==='READY'),false);
  const expected={uploadId:id,totalBytes:5,entries:2},ready={...expected,state:'READY',dataset:'mine',version:'a'.repeat(64)};
  for(const patch of [{uploadId:'other'},{state:'UNKNOWN'},{dataset:'../other'},{version:'bad'},{totalBytes:6},{entries:3},{entries:undefined}])assert.throws(()=>confirmedDatasetUpload({...ready,...patch},expected));
});
test('malformed, redirected or changed direct grants never expose the bearer to another endpoint',async()=>{
  const good={available:true,protocol:'dataset-upload-v1',endpoint,certificateSha256:'a'.repeat(64),ticket:'fixture-only-ticket-test',expiresAt:1300,chunkBytes:CHUNK_BYTES};
  for(const patch of [{endpoint:'http://node.test'},{endpoint:'https://node.test/path'},{endpoint:'https://user:pass@node.test'},{protocol:'other'},{ticket:'bad\r\nCookie: steal'},{expiresAt:999},{chunkBytes:CHUNK_BYTES+1}])assert.throws(()=>validateBrowserUploadGrant({...good,...patch},1000));
  const f=await fixture();const call=f.options.call;let tickets=0;
  f.options.call=async(...args)=>{const result=await call(...args);if(args[0].endsWith('.direct-ticket')&&++tickets===2)return {...result,endpoint:'https://other.test'};return result;};
  const send=f.options.fetch;f.options.fetch=async(...args)=>{const result=await send(...args);f.advance();return result;};
  await assert.rejects(uploadBrowserDataset(f.options),/入口已改变/);assert.equal(f.portal.some(row=>row.operation.endsWith('.chunk')),false);
});
test('zero grants deny before raw requests; abort after a late node reply stops account-crossing writes',async()=>{
  const f=await fixture();f.options.call=async()=>{throw Object.assign(Error('这台服务器未授权'),{status:403});};
  await assert.rejects(uploadBrowserDataset(f.options),/未授权/);assert.equal(f.raw.length,0);assert.equal(f.progress.length,0);
  const old=await fixture(),abort=new AbortController(),send=old.options.fetch;old.options.signal=abort.signal;
  old.options.fetch=async(...args)=>{const response=await send(...args);if(new URL(args[0]).pathname.endsWith('/chunk'))abort.abort();return response;};
  await assert.rejects(uploadBrowserDataset(old.options),/暂停/);assert.equal(old.portal.some(row=>row.operation.endsWith('.commit')),false);
});
test('transfer-backed final status bypasses completed IO but preserves upload and machine scope',async()=>{
  const calls=[],call=transferUploadCall(async(operation,args)=>{calls.push({operation,args});if(operation==='transfers.create')return {id:'transfer-id',uploadId:id,state:'SUCCEEDED',result:{uploadId:id,state:'READY'}};return {uploadId:id,state:'READY'};});
  await call('datasets.upload.begin',{machine:'node-a',name:'mine',key:id});await call('datasets.upload.status',{machine:'node-a',uploadId:id});
  assert.deepEqual(calls.at(-1),{operation:'datasets.upload.status',args:{machine:'node-a',uploadId:id}});
});

test('a lost begin receipt queries its original UUID before any explicit retry',async()=>{
  const scan=await scanBrowserDirectory([file('a','content')]),calls=[],handles=new Map();let uploadId,attempt=0,state='RECEIVING_MANIFEST';
  const status=()=>({uploadId,state,totalBytes:scan.totalBytes,entries:scan.entries,manifestOffset:0,...(state==='READY'?{dataset:'u-test-mine',version:'a'.repeat(64)}:{})});
  const call=async(operation,args)=>{calls.push({operation,args});if(operation.endsWith('.begin')){uploadId=args.key;if(++attempt===1)throw Error('begin response lost');state='READY';return status();}assert.equal(operation,'datasets.upload.status');assert.equal(args.uploadId,uploadId);return status();};
  const options={call,userId:'member',machine:'node-a',name:'mine',scan,keyStore:{getHandle:key=>handles.get(key),setHandle:(key,value)=>handles.set(key,value)}};
  await assert.rejects(uploadBrowserDataset(options),error=>error.code==='UNCONFIRMED'&&error.uploadId===uploadId);
  assert.deepEqual(calls.map(row=>row.operation),['datasets.upload.begin','datasets.upload.status']);
  const key=calls[0].args.key;assert.equal((await uploadBrowserDataset(options)).state,'READY');assert.equal(calls[2].operation,'datasets.upload.status');assert.equal(calls[3].args.key,key);
});
