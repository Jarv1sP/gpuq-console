import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createHash} from 'node:crypto';
import {readFile,lstat,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonalFileTransport,downloadCampusFile} from '../client-personal-file-campus.mjs';
import {uploadCodeFiles} from '../cli.mjs';
import {campusDatasetTransportDefaults} from '../client-data-upload.mjs';
import {extractCampusNative,createCampusNativeAgent,campusNativePersonalFileRequest,campusNativeTransportOptions} from '../client-campus-native.mjs';
import {createCampusNativeDatasetTransport,campusNativeDatasetRequest} from '../client-campus-native-dataset.mjs';
import {uploadDatasetSnapshot,DATA_CHUNK} from '../client-data-upload.mjs';

const pin='c'.repeat(64),grant={certificateSha256:pin,file:{protocol:2,path:'fixed',size:3,fingerprint:'f'.repeat(64)}};
function fixture(handler){
  const calls=[],children=[];let cleaned=0;
  const spawnProcess=(path,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();children.push(child);calls.push({path,args,options});
    child.kill=()=>{queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});return true;};
    child.stdin=new Writable({write(bytes,_encoding,done){
      const n=bytes.readUInt32BE(0),header=JSON.parse(bytes.subarray(4,4+n)),raw=bytes.subarray(4+n);calls.push({header,raw});
      const reply=handler(header,raw);if(reply){const json=Buffer.from(JSON.stringify({schema:1,seq:header.seq,ok:true,bodyBytes:0,...reply.value})),length=Buffer.alloc(4);length.writeUInt32BE(json.length);child.stdout.write(Buffer.concat([length,json,reply.raw||Buffer.alloc(0)]));}done();
    }});return child;
  };
  const extract=async()=>({path:'/isolated-fixture/helper',cleanup:async()=>{cleaned++;}});
  return {spawnProcess,extract,calls,children,cleaned:()=>cleaned};
}
test('native process is reused; ticket and bytes are only bounded stdin frames',async()=>{
  const f=fixture(()=>({value:{result:{receivedBytes:3}}})),agent=createCampusNativeAgent(pin,f);
  try{
    for(let i=0;i<2;i++)assert.deepEqual(await campusNativePersonalFileRequest({...grant,ticket:'opaque-secret'},agent,'put',{offset:i*3,final:i===1,bytes:Buffer.from('raw')}),{receivedBytes:3});
    assert.equal(f.children.length,1);assert.deepEqual(f.calls[0].args,[]);assert.deepEqual(f.calls[0].options.env,{});
    assert.equal(JSON.stringify(f.calls[0]).includes('opaque-secret'),false);
    assert.equal(f.calls[1].header.grant.ticket,'opaque-secret');assert.equal(f.calls[1].raw.toString(),'raw');
    assert.deepEqual(f.calls[1].header.grant.file,{path:'fixed'});
  }finally{await agent.destroy();}assert.equal(f.cleaned(),1);
});
test('raw download frame retains exact fingerprint without base64 on the native pipe',async()=>{
  const f=fixture(()=>({value:{metadata:{...grant.file,offset:0,eof:true},bodyBytes:3},raw:Buffer.from('abc')})),agent=createCampusNativeAgent(pin,f);
  try{const result=await campusNativePersonalFileRequest(grant,agent,'get',{offset:0});assert.deepEqual(result,{...grant.file,offset:0,eof:true,data:'YWJj'});}finally{await agent.destroy();}
});
test('lost ACK stops one original frame; later same UUID is not implicitly replayed',async()=>{
  const f=fixture(()=>({value:{ok:false,code:'ACK_UNCONFIRMED',writeMayHaveReachedPeer:true}})),agent=createCampusNativeAgent(pin,f);
  try{
    const fixed={...grant,grantId:'same-original-uuid'};
    await assert.rejects(campusNativePersonalFileRequest(fixed,agent,'put',{offset:0,final:true,bytes:Buffer.from('raw')}),error=>error.code==='ACK_UNCONFIRMED'&&error.writeMayHaveReachedPeer===true);
    await assert.rejects(campusNativePersonalFileRequest(fixed,agent,'put',{offset:0,final:true,bytes:Buffer.from('raw')}),/SESSION_STOPPED/);
    assert.equal(f.calls.filter(x=>x.header).length,1);assert.equal(f.calls[1].header.grant.grantId,'same-original-uuid');
  }finally{await agent.destroy();}
});
test('bad native length/sequence is rejected rather than consumed as file bytes',async()=>{
  for(const value of [{seq:999},{bodyBytes:1048577}]){
    const f=fixture(()=>({value})),agent=createCampusNativeAgent(pin,f);
    try{await assert.rejects(agent.request({op:'get',grant,offset:0}),/NATIVE_FRAME_INVALID/);}finally{await agent.destroy();}
  }
});
test('missing platform/artifact and changed embedded SHA reject before executing',async()=>{
  await assert.rejects(extractCampusNative(null,{platform:'darwin',arch:'arm64'}),/PLATFORM_UNSUPPORTED/);
  await assert.rejects(extractCampusNative(null,{platform:'linux',arch:'x64'}),/NATIVE_NOT_BUNDLED/);
  const bytes=Buffer.from('isolated helper fixture'),manifest={schema:1,protocol:'campus-native-https-v1',artifacts:{'linux-x64':{bytes:bytes.length,sha256:'0'.repeat(64),base64:bytes.toString('base64')}}};
  await assert.rejects(extractCampusNative(manifest,{platform:'linux',arch:'x64'}),/NATIVE_ARTIFACT_INVALID/);
  manifest.artifacts['linux-x64'].sha256=createHash('sha256').update(bytes).digest('hex');
  const binary=await extractCampusNative(manifest,{platform:'linux',arch:'x64'});
  try{assert.deepEqual(await readFile(binary.path),bytes);const info=await lstat(binary.path);assert.equal(info.mode&0o7777,0o700);assert.equal(info.nlink,1);}finally{await binary.cleanup();}
});
test('adapter refuses oversized chunks and wrong pin before native startup',async()=>{
  const f=fixture(()=>({value:{}})),agent=createCampusNativeAgent(pin,f);
  try{
    await assert.rejects(campusNativePersonalFileRequest({...grant,certificateSha256:'d'.repeat(64)},agent,'put',{offset:0,final:true,bytes:Buffer.alloc(0)}),/INVALID_REQUEST/);
    await assert.rejects(campusNativePersonalFileRequest(grant,agent,'put',{offset:0,final:true,bytes:Buffer.alloc(1048577)}),/INVALID_CHUNK/);
    assert.equal(f.children.length,0);const options=campusNativeTransportOptions(f);assert.equal(options.send,campusNativePersonalFileRequest);await options.agentFactory(pin).destroy();
  }finally{await agent.destroy();}
});
test('destroy escalates only its own child and awaits exact folder cleanup',async()=>{
  const f=fixture(()=>({value:{result:{receivedBytes:3}}}));let releaseCleanup,cleaned=false;
  f.extract=async()=>({path:'/isolated-fixture/helper',cleanup:()=>new Promise(resolve=>{releaseCleanup=()=>{cleaned=true;resolve();};})});
  const spawn=f.spawnProcess,signals=[];f.spawnProcess=(...args)=>{const child=spawn(...args);child.kill=signal=>{signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});return true;};return child;};
  const agent=createCampusNativeAgent(pin,{...f,shutdownTimeoutMs:100});
  await agent.request({op:'put',grant,offset:0,final:true},Buffer.from('raw'));
  let finished=false;const closing=agent.destroy().then(()=>{finished=true;});
  while(!releaseCleanup)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(finished,false);assert.deepEqual(signals,['SIGTERM','SIGKILL']);releaseCleanup();await closing;assert.equal(cleaned,true);
  await agent.destroy();assert.equal(signals.length,2);
});
test('unconfirmed child exit is bounded and does not remove a running child folder',async()=>{
  const f=fixture(()=>({value:{result:{receivedBytes:3}}})),spawn=f.spawnProcess,signals=[];
  f.spawnProcess=(...args)=>{const child=spawn(...args);child.kill=signal=>{signals.push(signal);return true;};return child;};
  const agent=createCampusNativeAgent(pin,{...f,shutdownTimeoutMs:30});
  await agent.request({op:'put',grant,offset:0,final:true},Buffer.from('raw'));
  await assert.rejects(agent.destroy(),/NATIVE_EXIT_UNCONFIRMED/);assert.equal(f.cleaned(),0);assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  f.children[0].emit('close',0);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.cleaned(),1);
});
test('spawn failure still cleans only its extracted binary',async()=>{
  const f=fixture(()=>null),agent=createCampusNativeAgent(pin,{...f,spawnProcess(){throw Error('fixture start failed');}});
  await assert.rejects(agent.request({op:'get',grant,offset:0}),/fixture start failed/);await agent.destroy();assert.equal(f.cleaned(),1);
});
const uploadId='12345678-1234-4234-8234-123456789012';
const datasetGrant=(now=Date.now()/1000)=>({available:true,protocol:'dataset-upload-v1',kind:'campus-direct',routeId:'primary',endpoint:'https://campus.invalid',certificateSha256:pin,revision:'c'.repeat(64),machine:'node',ticket:'fixture-only-upload-ticket',expiresAt:Math.floor(now)+300,chunkBytes:DATA_CHUNK,maxChunkBytes:16*DATA_CHUNK});
test('existing dataset snapshot contract stays at legal 1 MiB with original UUID and SHA',async()=>{
  const content=Buffer.alloc(2*DATA_CHUNK+37,0x5a),sha256=createHash('sha256').update(content).digest('hex'),reads=[],writes=[];let offset=3;
  const entry={path:'fixed.bin',size:content.length,sha256},scan={manifest:Buffer.from('{}'),manifestSha256:'f'.repeat(64),files:[entry],totalBytes:content.length,entries:1,verify:async()=>{},openEntry:async()=>({read:async(at,max)=>{reads.push(max);return content.subarray(at,Math.min(content.length,at+max));},verify:async()=>{},close:async()=>{}})};
  const f=fixture((header,raw)=>{
    assert.equal(header.uploadId,uploadId);assert.equal(header.grant.maxChunkBytes,16*DATA_CHUNK);
    if(header.op==='status')return {value:{result:{file:{...entry,offset,complete:false}}}};
    assert.equal(header.op,'chunk');assert.equal(header.offset,offset);assert.ok(raw.length<=DATA_CHUNK);assert.deepEqual(raw,content.subarray(offset,offset+raw.length));writes.push(raw);offset+=raw.length;return {value:{result:{offset,complete:offset===content.length}}};
  });
  let transport,closed=false;
  const ready=await uploadDatasetSnapshot(async(op,args)=>{
    if(op.endsWith('.begin'))return {result:{state:'UPLOADING',uploadId,uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true}}};
    if(op.endsWith('.direct-ticket'))return {result:datasetGrant()};
    if(op.endsWith('.commit'))return {result:{state:'READY',dataset:'fixture',version:sha256}};
    throw Error('unexpected control operation '+op);
  },{machine:'node',name:'fixture',userId:'fixture-user',scan,progress(){},keyStore:{get:()=>uploadId,setHandle:async()=>{}},directFactory:async(requestGrant,options)=>{
    transport=await createCampusNativeDatasetTransport(requestGrant,{...options,agentFactory:p=>createCampusNativeAgent(p,f)});
    const close=transport.close;transport.close=async()=>{await close();closed=true;};return transport;
  }});
  assert.equal(closed,true);assert.equal(f.cleaned(),1);assert.equal(offset,content.length);assert.deepEqual(reads,[DATA_CHUNK,DATA_CHUNK,DATA_CHUNK]);
  assert.equal(createHash('sha256').update(Buffer.concat([content.subarray(0,3),...writes])).digest('hex'),sha256);assert.equal(ready.version,sha256);
});
test('dataset native send rejects oversized buffers, Tail routes and changed renewal',async()=>{
  const f=fixture(()=>({value:{result:{offset:1}}})),agent=createCampusNativeAgent(pin,f);
  await assert.rejects(campusNativeDatasetRequest(datasetGrant(),agent,{uploadId,action:'chunk',path:'fixed',offset:0,bytes:Buffer.alloc(DATA_CHUNK+1)}),/INVALID_CHUNK/);assert.equal(f.children.length,0);await agent.destroy();
  await assert.rejects(createCampusNativeDatasetTransport(async()=>({...datasetGrant(),kind:'tailnet',routeId:'tail'}),{uploadId}),/INVALID_CAMPUS_GRANT/);
  let now=1000,count=0,sent=0;
  const t=await createCampusNativeDatasetTransport(async()=>({...datasetGrant(now),revision:++count===1?'c'.repeat(64):'d'.repeat(64)}),{uploadId,now:()=>now,agentFactory:()=>({destroy:async()=>{}}),send:async()=>{sent++;}});
  now=1295;try{await assert.rejects(t.request('chunk',{path:'fixed',offset:0,bytes:Buffer.from('x')}),/GRANT_IDENTITY_CHANGED/);assert.equal(sent,0);}finally{await t.close();}
});
test('Linux personal default dispatch and CLI terminal result await native folder cleanup',async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-cli-default-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const content=Buffer.from('original SHA and UUID'),source=join(root,'fixed');await writeFile(source,content);
  const sha256=createHash('sha256').update(content).digest('hex');let identity,release,done=false;
  const f=fixture((header,raw)=>{assert.equal(header.op,'put');assert.equal(header.grant.grantId,uploadId);assert.deepEqual(raw,content);return {value:{result:{complete:true,size:content.length,sha256}}};});
  f.extract=async()=>({path:'/isolated-fixture/helper',cleanup:()=>new Promise(resolve=>{release=resolve;})});
  const calls=[],call=async(op,args)=>{calls.push({op,args});assert.equal('data' in args||'bytes' in args,false);
    if(op==='files.upload.status')return {result:{protocol:2,state:'ABSENT',path:'fixed',receivedBytes:0}};
    assert.equal(op,'files.direct-ticket');identity=args.uploadId;return {result:{...datasetGrant(),protocol:'personal-file-campus-v1',grantId:uploadId,file:{protocol:2,state:'ABSENT',path:'fixed',receivedBytes:0}}};};
  const upload=uploadCodeFiles(call,{machine:'node',context:{project:'project'},local:source,remote:'fixed',progress(){},transportFactory:(call,options)=>createPersonalFileTransport(call,{...options,platform:'linux',nativeOptions:f})}).then(value=>{done=true;return value;});
  while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);release();assert.equal((await upload).uploaded,1);
  assert.match(identity,/^[a-f0-9-]{36}$/);assert.equal(f.calls.filter(x=>x.header).length,1);assert.equal(calls.length,2);
});
test('Linux default dataset transport uses raw 1 MiB frame despite 16 MiB authorization',async()=>{
  const f=fixture((header,raw)=>({value:{result:{offset:header.offset+raw.length}}})),options=campusDatasetTransportDefaults({platform:'linux',nativeOptions:f});
  const transport=await options.directFactory(async()=>datasetGrant(),{uploadId});
  try{assert.equal(transport.chunkBytes,DATA_CHUNK);assert.deepEqual(await transport.request('chunk',{path:'fixed',offset:3,bytes:Buffer.alloc(DATA_CHUNK)}),{offset:DATA_CHUNK+3});assert.equal(f.calls[1].header.uploadId,uploadId);assert.equal(f.calls[1].header.grant.maxChunkBytes,16*DATA_CHUNK);}finally{await transport.close();}
  assert.equal(f.cleaned(),1);
});
test('Linux CLI unknown ACK keeps original upload identity with zero additional raw writes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-cli-ack-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'fixed'),content=Buffer.from('fixed');await writeFile(source,content);
  let identity;const f=fixture(()=>({value:{ok:false,code:'ACK_UNCONFIRMED',writeMayHaveReachedPeer:true}})),calls=[];
  const call=async(op,args)=>{calls.push({op,args});if(op==='files.direct-ticket'){identity=args;return {result:{...datasetGrant(),protocol:'personal-file-campus-v1',grantId:uploadId,file:{path:'fixed'}}};}
    assert.equal(op,'files.upload.status');return {result:identity?{protocol:2,state:'UPLOADING',path:'fixed',resumable:true,uploadId:identity.uploadId,totalSize:identity.totalSize,sha256:identity.sha256,receivedBytes:content.length}:{protocol:2,state:'ABSENT',path:'fixed',receivedBytes:0}};};
  await assert.rejects(uploadCodeFiles(call,{machine:'node',context:{project:'project'},local:source,remote:'fixed',progress(){},recoverySleep:async()=>{},transportFactory:(call,o)=>createPersonalFileTransport(call,{...o,platform:'linux',nativeOptions:f})}),/SESSION_STOPPED/);
  assert.equal(f.calls.filter(x=>x.header).length,1);assert.equal(calls.filter(x=>x.op==='files.direct-ticket').length,1);assert.ok(calls.filter(x=>x.op==='files.upload.status'&&x.args.uploadId).every(x=>x.args.uploadId===identity.uploadId));assert.equal(f.cleaned(),1);
});
test('source client loads build-generated artifacts without NATIVE_NOT_BUNDLED',async()=>{
  const binary=await extractCampusNative(undefined,{platform:'linux',arch:'x64'});try{assert.ok((await lstat(binary.path)).size>1000000);}finally{await binary.cleanup();}
});
test('Linux personal download default preserves full bytes and awaits native cleanup',async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-cli-pull-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const content=Buffer.from('fixed original download'),destination=join(root,'download'),fingerprint='f'.repeat(64);let release,done=false;
  const metadata={protocol:2,path:'fixed',size:content.length,fingerprint};
  const f=fixture(header=>{assert.equal(header.op,'get');assert.deepEqual(header.grant.file,metadata);assert.equal(header.offset,0);return {value:{metadata:{...metadata,offset:0,eof:true},bodyBytes:content.length},raw:content};});
  f.extract=async()=>({path:'/isolated-fixture/helper',cleanup:()=>new Promise(resolve=>{release=resolve;})});
  const calls=[],call=async(op,args)=>{calls.push({op,args});assert.equal(op,'files.direct-ticket');assert.equal(args.action,'get');return {result:{...datasetGrant(),protocol:'personal-file-campus-v1',grantId:uploadId,file:metadata}};};
  const pulling=downloadCampusFile(call,{machine:'node',context:{project:'fixed'},path:'fixed',destination,origin:'https://portal.invalid',userId:'fixture-user',platform:'linux',nativeOptions:f}).then(result=>{done=true;return result;});
  while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);release();
  const result=await pulling;assert.equal(result.sha256,createHash('sha256').update(content).digest('hex'));assert.deepEqual(await readFile(destination),content);assert.equal(calls.length,1);assert.equal(f.calls.filter(x=>x.header).length,1);
});
