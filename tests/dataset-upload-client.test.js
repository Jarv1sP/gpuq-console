import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {SHA256,hashBlob,uploadKey,datasetPath,manifestBlob,scanBrowserDirectory,uploadBrowserDataset,CHUNK_BYTES} from '../dist/dataset-upload.js';
const digest=data=>createHash('sha256').update(data).digest('hex');
test('incremental browser SHA256 matches native hash at padding boundaries and random chunk boundaries',async()=>{
  for(const length of [0,1,3,55,56,63,64,65,127,128,129,1000000]){
    const input=randomBytes(length),hash=new SHA256();for(let at=0;at<input.length;at+=37)hash.update(input.subarray(at,at+37));
    assert.equal(hash.hex(),digest(input));assert.equal(hash.hex(),digest(input));assert.throws(()=>hash.update(new Uint8Array()));
    assert.equal(await hashBlob(new Blob([input])),digest(input));
  }
  assert.equal(new SHA256().update(new TextEncoder().encode('abc')).hex(),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('hashing reads bounded slices and never reads the entire file',async()=>{
  let largest=0;const content=randomBytes(CHUNK_BYTES*2+123),blob=new Blob([content]);
  const bounded={size:blob.size,slice(start,end){largest=Math.max(largest,end-start);return blob.slice(start,end);},arrayBuffer(){throw Error('unbounded read');}};
  assert.equal(await hashBlob(bounded),digest(content));assert.ok(largest<=CHUNK_BYTES);
  const controller=new AbortController();controller.abort();await assert.rejects(hashBlob(bounded,{signal:controller.signal}),/暂停/);
});
test('manifest supports more than 4096 entries and streams valid UTF-8 JSON with empty directories',async()=>{
  const files=Array.from({length:5000},(_,i)=>({path:`数据-${i}`,size:0,sha256:digest('')})),blob=manifestBlob(['empty'],files);
  const data=JSON.parse(await blob.text());assert.equal(data.files.length,5000);assert.deepEqual(data.directories,['empty']);
  assert.throws(()=>manifestBlob(Array(500001).fill('a'),[]),/500,000/);
  for(const path of ['../x','/absolute','a\\b','a//b','.ssh/key','a/\n'])assert.throws(()=>datasetPath(path));
  assert.equal(datasetPath('训练样本/image.png'),'训练样本/image.png');
});
test('resume key is stable, UUID-shaped and isolated by account, machine and name',()=>{
  const key=uploadKey('a','gpu-1','data','a'.repeat(64));assert.match(key,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(key,uploadKey('a','gpu-1','data','a'.repeat(64)));
  for(const args of [['b','gpu-1','data'],['a','gpu-2','data'],['a','gpu-1','other']])assert.notEqual(key,uploadKey(...args,'a'.repeat(64)));
});
function selectedFile(path,bytes){const file=new Blob([bytes]);Object.defineProperties(file,{webkitRelativePath:{value:'chosen/'+path},name:{value:path.split('/').at(-1)}});return file;}
test('directory manifest strips only the chosen root and rejects duplicate and credential paths',async()=>{
  const scan=await scanBrowserDirectory([selectedFile('a/训练.txt','hello'),selectedFile('zero','')]);
  assert.equal(scan.totalBytes,5);assert.equal(scan.entries,3);assert.deepEqual(JSON.parse(await scan.manifest.text()).directories,['a']);
  await assert.rejects(scanBrowserDirectory([selectedFile('a','x'),selectedFile('a','y')]),/重复/);
  await assert.rejects(scanBrowserDirectory([selectedFile('.env','secret')]),/凭据/);
  const secret=new Blob(['secret']);Object.defineProperty(secret,'webkitRelativePath',{value:'.ssh/id_rsa'});
  await assert.rejects(scanBrowserDirectory([secret]),/凭据/);
});
test('browser protocol resumes only confirmed offsets, handles empty files and waits for verified READY',async()=>{
  const content=randomBytes(CHUNK_BYTES+5),scan=await scanBrowserDirectory([selectedFile('data.bin',content),selectedFile('zero','')]),calls=[],progress=[];
  let state='RECEIVING_MANIFEST',manifest=Buffer.alloc(0),stored=Buffer.from(content.subarray(0,17)),zero=false;
  const call=async(operation,args)=>{
    calls.push({operation,args});const action=operation.split('.').at(-1),common={uploadId:'upload-test',name:'mine',state,manifestOffset:manifest.length};
    if(action==='begin')return common;
    assert.equal(args.uploadId,'upload-test');assert.equal(args.machine,'gpu-1');
    if(action==='manifest'){assert.equal(args.offset,manifest.length);manifest=Buffer.concat([manifest,Buffer.from(args.data,'base64')]);return {...common,offset:manifest.length};}
    if(action==='seal'){state='SEALING';return {...common,state};}
    if(action==='status'&&args.path){const entry=scan.files.find(f=>f.path===args.path);return {...common,file:{...entry,offset:entry.path==='zero'?0:stored.length,complete:entry.path==='zero'?zero:stored.length===content.length}};}
    if(action==='status'){state=state==='SEALING'?'UPLOADING':state==='PUBLISHING'?'READY':state;return {...common,state,dataset:'u-test-mine',version:'a'.repeat(64)};}
    if(action==='chunk'){const data=Buffer.from(args.data,'base64');assert.ok(data.length<=CHUNK_BYTES);if(args.path==='zero'){zero=true;return {offset:0,complete:true};}assert.equal(args.offset,stored.length);stored=Buffer.concat([stored,data]);return {offset:stored.length,complete:stored.length===content.length};}
    if(action==='commit'){assert.deepEqual(stored,content);assert.equal(zero,true);state='PUBLISHING';return {...common,state};}
    throw Error(operation);
  };
  const result=await uploadBrowserDataset({call,userId:'one',machine:'gpu-1',name:'mine',scan,onProgress:x=>progress.push(x),pollMs:0});
  assert.equal(result.state,'READY');assert.equal(digest(manifest),scan.manifestSha256);assert.equal(calls.find(c=>c.operation.endsWith('.chunk')&&c.args.path==='data.bin').args.offset,17);
  assert.ok(progress.some(p=>p.state==='PUBLISHING'));assert.equal(calls.some(c=>'owners' in c.args||'hostAdmin' in c.args),false);
});
test('abort after an in-flight response prevents all subsequent requests and callbacks',async()=>{
  const scan=await scanBrowserDirectory([selectedFile('a','content')]),controller=new AbortController();let calls=0,progress=0;
  const call=async()=>{calls++;controller.abort();return {uploadId:'old-account',state:'RECEIVING_MANIFEST',manifestOffset:0};};
  await assert.rejects(uploadBrowserDataset({call,userId:'old',machine:'gpu-1',name:'mine',scan,signal:controller.signal,onProgress:()=>progress++}),/暂停/);
  assert.equal(calls,1);assert.equal(progress,0);
});
test('large manifests cross the HTTP chunk boundary without a 4096 entry ceiling',async()=>{
  const files=Array.from({length:5000},(_,i)=>({path:String(i).padStart(5,'0')+'x'.repeat(200),size:0,sha256:digest('')})),manifest=manifestBlob([],files);
  assert.ok(manifest.size>CHUNK_BYTES);const scan={manifest,manifestSha256:await hashBlob(manifest),files:[],paths:new Map(),entries:files.length,totalBytes:0};let bytes=Buffer.alloc(0),chunks=0;
  const call=async(operation,args)=>{if(operation.endsWith('.begin')){assert.equal(args.entries,5000);return {uploadId:'large',state:'RECEIVING_MANIFEST',manifestOffset:0};}if(operation.endsWith('.manifest')){const next=Buffer.from(args.data,'base64');assert.ok(next.length<=CHUNK_BYTES);assert.equal(args.offset,bytes.length);bytes=Buffer.concat([bytes,next]);chunks++;return {offset:bytes.length};}if(operation.endsWith('.seal'))return {uploadId:'large',state:'READY',dataset:'u-user-large',version:digest(bytes)};throw Error(operation);};
  assert.equal((await uploadBrowserDataset({call,userId:'one',machine:'gpu-1',name:'large',scan})).state,'READY');assert.ok(chunks>1);assert.equal(digest(bytes),scan.manifestSha256);assert.equal(JSON.parse(bytes).files.length,5000);
});
test('discard restart persists its replacement key before creating the next upload and reuses it',async()=>{
  const scan=await scanBrowserDirectory([selectedFile('a','content')]),keys=new Map(),base=uploadKey('one','gpu-1','mine',scan.manifestSha256),seen=[];
  const keyStore={get:key=>keys.get(key),set:(key,value)=>keys.set(key,value)};
  const call=async(operation,args)=>{assert.ok(operation.endsWith('.begin'));seen.push(args.key);if(args.key===base)return {state:'DISCARDED',uploadId:'old'};assert.equal(keys.get(base),args.key);assert.equal('uploadId' in args,false);return {state:'READY',uploadId:'new',dataset:'u-user-mine',version:'b'.repeat(64)};};
  const first=await uploadBrowserDataset({call,userId:'one',machine:'gpu-1',name:'mine',scan,keyStore});assert.equal(first.uploadId,'new');assert.notEqual(keys.get(base),base);
  await uploadBrowserDataset({call,userId:'one',machine:'gpu-1',name:'mine',scan,keyStore});assert.deepEqual(seen,[base,keys.get(base),keys.get(base)]);
});
test('failed sealing with an already complete manifest retries seal before uploading any files',async()=>{
  const scan=await scanBrowserDirectory([selectedFile('a','content')]),actions=[];let stored;
  const call=async(operation,args)=>{const action=operation.split('.').at(-1);actions.push(action);
    if(action==='begin')return {uploadId:'retry-seal',state:'FAILED',resumeState:'RECEIVING_MANIFEST',manifestOffset:scan.manifest.size};
    if(action==='seal')return {uploadId:'retry-seal',state:'UPLOADING'};
    if(action==='status')return {file:{...scan.files[0],offset:0,complete:false}};
    if(action==='chunk'){stored=Buffer.from(args.data,'base64');return {offset:stored.length,complete:true};}
    if(action==='commit'){assert.equal(digest(stored),scan.files[0].sha256);return {state:'READY',dataset:'u-one-mine',version:'c'.repeat(64)};}
    throw Error('Unexpected action '+action);
  };
  assert.equal((await uploadBrowserDataset({call,userId:'one',machine:'gpu-1',name:'mine',scan,pollMs:0})).state,'READY');
  assert.deepEqual(actions,['begin','seal','status','chunk','commit']);
});
