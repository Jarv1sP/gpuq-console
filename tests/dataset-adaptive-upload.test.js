import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {adaptiveUploadChunk,MAX_DIRECT_CHUNK_BYTES as BIG,CHUNK_BYTES as SMALL,scanBrowserDirectory,uploadBrowserDataset,validateBrowserUploadGrant,browserDatasetTransport} from '../dist/dataset-upload.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uploadId='12345678-1234-4234-8234-123456789012',endpoint='https://upload.example.test';
const grant=maximum=>({available:true,protocol:'dataset-upload-v1',endpoint,certificateSha256:'a'.repeat(64),ticket:'fixture-only-upload-ticket',expiresAt:1300,chunkBytes:SMALL,...(maximum===undefined?{}:{maxChunkBytes:maximum})});

test('adaptive policy has exact ACK thresholds and accepts only 1/16 MiB authorization',()=>{
  assert.equal(adaptiveUploadChunk(SMALL,499,BIG),BIG);
  assert.equal(adaptiveUploadChunk(SMALL,500,BIG),SMALL);
  assert.equal(adaptiveUploadChunk(BIG,8000,BIG),BIG);
  assert.equal(adaptiveUploadChunk(BIG,8001,BIG),SMALL);
  assert.equal(adaptiveUploadChunk(BIG,600,SMALL),SMALL);
  for(const value of [0,2*SMALL,17*SMALL,'16777216',Infinity]){
    assert.throws(()=>adaptiveUploadChunk(SMALL,1,value));
    assert.throws(()=>validateBrowserUploadGrant(grant(value),1000));
  }
  for(const elapsed of [-1,NaN,Infinity])assert.throws(()=>adaptiveUploadChunk(SMALL,elapsed,BIG));
  assert.equal(validateBrowserUploadGrant(grant(),1000).maxChunkBytes,undefined);
});

async function fixture({maximum=BIG,sizes=[20*SMALL,20*SMALL],delays=[]}={}){
  const originals=sizes.map((size,index)=>Buffer.alloc(size,index+7));
  const files=originals.map((data,index)=>{const blob=new Blob([data]);Object.defineProperty(blob,'name',{value:`file-${index}.bin`});return blob;});
  const scan=await scanBrowserDirectory(files),portal=[],raw=[],stored=new Map(),handles=new Map();
  let state='RECEIVING_MANIFEST',manifest=Buffer.alloc(0),ms=0,seconds=1000,tickets=0,currentMaximum=maximum,shrink=false,expire=false,revoke=false,lose=false;
  const status=()=>({uploadId,state,manifestOffset:manifest.length,chunkBytes:SMALL,totalBytes:scan.totalBytes,entries:scan.entries,...(state==='READY'?{dataset:'u-fixture-data',version:scan.manifestSha256}:{})});
  const call=async(operation,args)=>{
    portal.push({operation,args});assert.equal(args.machine,'training-node');
    const action=operation.split('.').at(-1);
    if(action==='begin')return {...status(),uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true}};
    assert.equal(args.uploadId,uploadId);
    if(action==='direct-ticket'){
      tickets++;if(shrink&&tickets>1)currentMaximum=SMALL;
      return {...grant(currentMaximum),expiresAt:seconds+300};
    }
    if(action==='status')return status();
    if(action==='seal'){assert.equal(hash(manifest),scan.manifestSha256);state='UPLOADING';return status();}
    if(action==='commit'){
      scan.files.forEach((entry,index)=>assert.deepEqual(stored.get(entry.path),originals[index]));state='READY';return status();
    }
    throw Error('File bytes used control plane: '+action);
  };
  const send=async(url,options)=>{
    const target=new URL(url),action=target.pathname.split('/').at(-1),path=target.searchParams.get('path');
    assert.equal(target.origin,endpoint);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.equal(options.headers.Authorization,'Bearer fixture-only-upload-ticket');
    if(action==='status')return Response.json({ok:true,result:{...status(),...(path?{file:{...scan.files.find(entry=>entry.path===path),offset:stored.get(path)?.length||0}}:{})}});
    assert(options.body instanceof Uint8Array);assert.equal(options.headers['Content-Type'],'application/octet-stream');
    const offset=Number(target.searchParams.get('offset')),length=options.body.length;
    raw.push({action,path,offset,length,maximum:currentMaximum??SMALL});
    if(revoke&&action==='chunk'&&length>SMALL){revoke=false;return new Response('',{status:401});}
    assert(length<=(action==='manifest'?SMALL:currentMaximum??SMALL));
    const previous=action==='manifest'?manifest:stored.get(path)||Buffer.alloc(0);assert.equal(offset,previous.length);
    const next=Buffer.concat([previous,Buffer.from(options.body)]);
    if(action==='manifest')manifest=next;else stored.set(path,next);
    if(action==='chunk'){
      ms+=delays.shift()??100;
      if(expire&&tickets===1)seconds+=295;
      if(lose&&length>SMALL){lose=false;throw Error('ACK lost after durable big block');}
    }
    return Response.json({ok:true,result:{offset:next.length,complete:action==='chunk'&&next.length===scan.files.find(entry=>entry.path===path).size}});
  };
  return {raw,portal,stored,scan,setShrink:()=>{shrink=true;expire=true;},setRevoke:()=>{shrink=true;revoke=true;},setLose:()=>{lose=true;},options:{call,fetch:send,scan,userId:'fixture-user',machine:'training-node',name:'data',pollMs:0,now:()=>seconds,chunkClock:()=>ms,keyStore:{get:()=>uploadId,getHandle:key=>handles.get(key),setHandle:(key,value)=>handles.set(key,value)}}};
}

test('each file starts at 1 MiB then grows to the ticket limit, preserving full SHA and manifest bounds',async()=>{
  const f=await fixture();assert.equal((await uploadBrowserDataset(f.options)).state,'READY');
  for(const path of f.scan.files.map(row=>row.path))assert.deepEqual(f.raw.filter(row=>row.action==='chunk'&&row.path===path).map(row=>row.length),[SMALL,BIG,3*SMALL]);
  assert(f.raw.filter(row=>row.action==='manifest').every(row=>row.length<=SMALL));
  assert.equal(f.portal.at(-1).operation,'datasets.upload.status');
  assert.equal(f.portal.some(row=>'data' in row.args||'bytes' in row.args),false);
});

test('a slow confirmed big ACK drops back to 1 MiB; a later fast ACK can raise it again',async()=>{
  const f=await fixture({sizes:[20*SMALL],delays:[100,9001,700,100,100]});await uploadBrowserDataset(f.options);
  assert.deepEqual(f.raw.filter(row=>row.action==='chunk').map(row=>row.length),[SMALL,BIG,SMALL,SMALL,SMALL]);
});

test('missing optional authorization and an explicit 1 MiB grant never send bigger blocks',async()=>{
  for(const maximum of [undefined,SMALL]){
    const f=await fixture({maximum,sizes:[3*SMALL]});
    // Keep undefined distinct from the fixture default.
    if(maximum===undefined){const call=f.options.call;f.options.call=async(...args)=>{const result=await call(...args);if(args[0].endsWith('.direct-ticket'))delete result.maxChunkBytes;return result;};}
    await uploadBrowserDataset(f.options);assert(f.raw.every(row=>row.length<=SMALL));
  }
});

test('renewal rechecks portal status, preserves the upload and clamps a reduced authorization before sending',async()=>{
  const f=await fixture({sizes:[4*SMALL]});f.setShrink();await uploadBrowserDataset(f.options);
  const renewal=f.portal.findIndex((row,index)=>index>1&&row.operation.endsWith('.direct-ticket'));
  assert.equal(f.portal[renewal-1].operation,'datasets.upload.status');
  assert(f.portal.filter(row=>row.operation.endsWith('.direct-ticket')).every(row=>row.args.uploadId===uploadId));
  assert(f.raw.filter(row=>row.action==='chunk').every(row=>row.length<=SMALL));
});

test('revocation followed by a narrower grant never replays an unconfirmed big write',async()=>{
  const f=await fixture({sizes:[20*SMALL]});
  // Reduce authorization only when the rejected request causes a second ticket.
  f.setRevoke();await uploadBrowserDataset(f.options);
  const big=f.raw.findIndex(row=>row.action==='chunk'&&row.length===BIG);
  assert(big>=0);assert(f.raw.slice(big+1).filter(row=>row.action==='chunk').every(row=>row.length<=SMALL));
});

test('lost expanded ACK stops; an explicit retry starts at the node-confirmed offset of the same upload',async()=>{
  const f=await fixture({sizes:[20*SMALL]});f.setLose();
  await assert.rejects(uploadBrowserDataset(f.options),error=>error.code==='DIRECT'&&error.uploadId===uploadId);
  assert.equal(f.portal.some(row=>row.operation.endsWith('.commit')),false);
  const raw=f.raw.length,portal=f.portal.length;await uploadBrowserDataset(f.options);
  assert.equal(f.portal[portal].operation,'datasets.upload.status');
  const resumed=f.raw.slice(raw).find(row=>row.action==='chunk');assert.equal(resumed.offset,SMALL+BIG);assert.equal(resumed.length,SMALL);
});

test('16 MiB file authorization never expands a manifest or accepts an oversized caller block',async()=>{
  let writes=0;const transport=await browserDatasetTransport({grant:grant(BIG),uploadId,now:()=>1000,control:()=>{throw Error('no renewal');},fetch:()=>{writes++;throw Error('no write expected');}});
  await assert.rejects(transport.request('manifest',{offset:0,bytes:new Uint8Array(SMALL+1)}),/分块无效/);
  await assert.rejects(transport.request('chunk',{path:'a',offset:0,bytes:new Uint8Array(BIG+1)}),/分块无效/);
  assert.equal(writes,0);
});
