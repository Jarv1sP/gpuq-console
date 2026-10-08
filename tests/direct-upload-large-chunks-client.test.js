import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {scanLocalDataset,uploadDatasetSnapshot,DATA_CHUNK} from '../client-data-upload.mjs';
import {createDirectDatasetTransport,directUploadRequest,validateDirectGrant} from '../client-direct-upload.mjs';

const BIG=16*DATA_CHUNK,id='12345678-1234-4234-8234-123456789012';
const grant=extra=>({available:true,kind:'campus-direct',protocol:'dataset-upload-v1',endpoint:'https://node.example',certificateSha256:'a'.repeat(64),ticket:'fixture-bearer-'.repeat(3),expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:DATA_CHUNK,...extra});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('large direct-file capability is optional and strictly bounded',async()=>{
  for(const cap of [undefined,DATA_CHUNK,BIG]){
    const value=validateDirectGrant(grant(cap===undefined?{}:{maxChunkBytes:cap}));
    const transport=await createDirectDatasetTransport(async()=>value,{uploadId:id,agentFactory:()=>({destroy(){}})});
    assert.equal(transport.chunkBytes,cap??DATA_CHUNK);transport.close();
  }
  for(const maxChunkBytes of [null,0,-1,2*DATA_CHUNK,BIG+1,Infinity,'16777216',true])assert.throws(()=>validateDirectGrant(grant({maxChunkBytes})),/chunk limit/);
});

test('large files cannot expand manifest, legacy or relay block size',()=>{
  let sent=false;const request=()=>{sent=true;throw Error('unexpected request');};
  const args={uploadId:id,path:'large.bin',offset:0,bytes:Buffer.alloc(DATA_CHUNK+1)};
  assert.throws(()=>directUploadRequest(grant({maxChunkBytes:BIG}),{}, {...args,action:'manifest'},{request}),/chunk/);
  assert.throws(()=>directUploadRequest(grant({}),{}, {...args,action:'chunk'},{request}),/chunk/);
  assert.throws(()=>directUploadRequest(grant({maxChunkBytes:BIG}),{}, {...args,action:'chunk',bytes:Buffer.alloc(BIG+1)},{request}),/chunk/);
  assert.equal(sent,false);
});

test('real local snapshot uses negotiated file blocks and resumes an unaligned offset',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-large-direct-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const content=Buffer.alloc(BIG+37,0x5a);await writeFile(join(root,'sample.bin'),content);
  for(const cap of [undefined,BIG]){
    const scan=await scanLocalDataset(root,()=>{}),sizes=[],reads=[],calls=[];let offset=3;
    const original=scan.openEntry;
    scan.openEntry=async entry=>{const file=await original(entry);return {...file,read:async(at,max)=>{reads.push(max);return file.read(at,max);}};};
    const call=async(operation,args)=>{
      calls.push({operation,args});
      if(operation.endsWith('.begin'))return {result:{state:'UPLOADING',uploadId:id,uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true}}};
      if(operation.endsWith('.direct-ticket'))return {result:grant(cap===undefined?{}:{maxChunkBytes:cap})};
      if(operation.endsWith('.commit'))return {result:{state:'READY',dataset:'fixture',version:hash(content)}};
      throw Error('unexpected portal payload');
    };
    const directFactory=async get=>{
      const g=validateDirectGrant(await get());
      return {chunkBytes:g.maxChunkBytes??DATA_CHUNK,close(){},request:async(action,args)=>{
        if(action==='status')return {file:{...scan.files[0],offset,complete:false}};
        assert.equal(action,'chunk');assert.equal(args.offset,offset);assert.deepEqual(args.bytes,content.subarray(offset,offset+args.bytes.length));
        sizes.push(args.bytes.length);offset+=args.bytes.length;return {offset,complete:offset===content.length};
      }};
    };
    const ready=await uploadDatasetSnapshot(call,{machine:'node',name:'sample',userId:'u',scan,keyStore:{get:()=>id,set(){}},progress(){},directFactory});
    assert.equal(ready.route.kind,'campus-direct');assert.equal(offset,content.length);
    assert.equal(sizes[0],DATA_CHUNK);assert.equal(reads[0],DATA_CHUNK);assert.ok(reads.slice(1).every(n=>n===(cap??DATA_CHUNK)));
    assert.equal(sizes.length,cap?2:17);assert.equal(calls.some(c=>'bytes' in c.args||'data' in c.args),false);
    const file=await original(scan.files[0]);try{await assert.rejects(file.read(0,BIG+1),/chunk size/);}finally{await file.close();}
  }
});

test('a renewed smaller capability does not send a previously read large buffer',async()=>{
  let now=1000,count=0,sent=0;
  const transport=await createDirectDatasetTransport(async()=>grant({expiresAt:now+300,...(++count===1?{maxChunkBytes:BIG}:{})}),{
    uploadId:id,now:()=>now,agentFactory:()=>({destroy(){}}),
    send:(g,a,args)=>directUploadRequest(g,a,args,{request:()=>{sent++;throw Error('must not send');}})
  });
  assert.equal(transport.chunkBytes,BIG);now=1295;
  await assert.rejects(transport.request('chunk',{path:'x',offset:0,bytes:Buffer.alloc(BIG)}),/chunk/);
  assert.equal(sent,0);assert.equal(count,2);assert.equal(transport.chunkBytes,DATA_CHUNK);transport.close();
});
