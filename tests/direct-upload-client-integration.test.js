import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {uploadDatasetSnapshot} from '../client-data-upload.mjs';
import {createDirectDatasetTransport,directUploadRequest,pinnedUploadAgent} from '../client-direct-upload.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const child=spawn(process.env.PYTHON||'python3',[new URL('./direct-upload-fixture.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
  const pending=new Map();let sequence=0,stderr='',readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const lines=createInterface({input:child.stdout});
  child.stderr.on('data',part=>stderr+=part);
  lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return readyReject(Error('Invalid Python fixture output'));}
    if(value.ready)return readyResolve(value);
    const operation=pending.get(value.id);if(!operation)return;pending.delete(value.id);
    value.ok?operation.resolve(value.result):operation.reject(Error(value.error));
  });
  child.on('error',readyReject);
  child.on('exit',code=>{if(code!==0){const error=Error(`Python fixture failed (${code}): ${stderr}`);readyReject(error);for(const item of pending.values())item.reject(error);pending.clear();}});
  const deadline=setTimeout(()=>{readyReject(Error('Python TLS fixture startup timed out'));child.kill();},10000);deadline.unref();
  const metadata=await ready;clearTimeout(deadline);
  const control=(action,args={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,action,args})+'\n');});
  t.after(async()=>{const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end(JSON.stringify({action:'shutdown'})+'\n');const timer=setTimeout(()=>child.kill(),5000);timer.unref();await exited;clearTimeout(timer);lines.close();assert.equal(stderr,'');});
  return {metadata,control};
}
function snapshot(files){
  const entries=Object.entries(files).map(([path,bytes])=>({path,size:bytes.length,sha256:sha(bytes)}));
  const manifest=Buffer.from(JSON.stringify({schema:1,directories:[],files:entries}));
  return {files:entries,entries:entries.length,totalBytes:entries.reduce((sum,x)=>sum+x.size,0),manifest,manifestSha256:sha(manifest),
    openEntry:async entry=>({read:async offset=>files[entry.path].subarray(offset,offset+1048576),verify:async()=>{},close:async()=>{}}),verify:async()=>{}};
}
function options(scan,progress=[]){return {machine:'gpu-4',name:'integration',userId:'demo-user-1',scan,progress:(state,value)=>progress.push({state,value}),keyStore:{get:()=>undefined,set:async()=>{}}};}

test('real Node pinned client uploads raw bytes to real Python HTTPS endpoint, publishes SHA-verified version',{timeout:20000},async t=>{
  const f=await fixture(t),scan=snapshot({'训练.bin':Buffer.alloc(1048576+17,73),empty:Buffer.alloc(0)}),calls=[],progress=[];
  const call=async(operation,args)=>{const action=operation.slice('datasets.upload.'.length);calls.push(action);return {result:await f.control(action,args)};};
  const result=await uploadDatasetSnapshot(call,options(scan,progress));
  assert.equal(result.state,'READY');assert.equal(result.lastConfirmedRoute,'campus-direct');
  assert.match(result.version,/^[a-f0-9]{64}$/);assert.ok(progress.some(x=>x.state==='ROUTE'&&x.value.kind==='campus-direct'));
  assert.equal(calls.includes('manifest'),false);assert.equal(calls.includes('chunk'),false);
  assert.ok(calls.includes('direct-ticket'));assert.ok(calls.includes('seal'));assert.ok(calls.includes('commit'));
});

test('lost real raw response never falls back through portal; same upload resumes confirmed offset',{timeout:20000},async t=>{
  const f=await fixture(t),scan=snapshot({'sample.bin':Buffer.alloc(1048576+113,51)}),calls=[];
  const call=async(operation,args)=>{const action=operation.slice('datasets.upload.'.length);calls.push(action);return {result:await f.control(action,args)};};
  await f.control('fault');
  await assert.rejects(uploadDatasetSnapshot(call,options(scan)),/Direct upload.*(?:failed|interrupted)|Direct upload connection/i);
  assert.equal(calls.includes('chunk'),false);assert.equal(calls.includes('manifest'),false);assert.equal(calls.includes('commit'),false);
  const second=await uploadDatasetSnapshot(call,options(scan));
  assert.equal(second.state,'READY');assert.equal(second.lastConfirmedRoute,'campus-direct');
  assert.equal(calls.filter(x=>x==='begin').length,2);assert.equal(calls.includes('chunk'),false);
});

test('actual TLS wrong pin is rejected before writes and revoked scoped ticket cannot continue',{timeout:20000},async t=>{
  const f=await fixture(t),scan=snapshot({x:Buffer.from('hello')}),uploadId=randomUUID();
  await f.control('begin',{key:uploadId,name:'security',manifestBytes:scan.manifest.length,manifestSha256:scan.manifestSha256,totalBytes:scan.totalBytes,entries:scan.entries});
  const grant=await f.control('direct-ticket',{uploadId});
  const wrong=pinnedUploadAgent('0'.repeat(64));
  try{await assert.rejects(directUploadRequest(grant,wrong,{uploadId,action:'manifest',offset:0,bytes:scan.manifest}),/certificate does not match/);}finally{wrong.destroy();}
  assert.equal((await f.control('status',{uploadId})).manifestOffset,0);
  const transport=await createDirectDatasetTransport(async()=>grant,{uploadId});
  try{
    assert.equal((await transport.request('manifest',{offset:0,bytes:scan.manifest})).offset,scan.manifest.length);
    await f.control('direct-revoke',{uploadId});
    await assert.rejects(transport.request('status'),/HTTP 403/);
  }finally{transport.close();}
});
