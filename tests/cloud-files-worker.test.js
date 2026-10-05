import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {runCloudFileIO,validateRequest,workerAdapter} from '../cloud-files-worker.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const user='demo-user-1',id=randomUUID();
function file(t,body=Buffer.from('cloud fixture')){
  const root=fs.mkdtempSync(join(tmpdir(),'gpuq-cloud-')),path=join(root,'payload');fs.chmodSync(root,0o700);fs.writeFileSync(path,body,{mode:0o600});
  const fd=fs.openSync(path,'r+');t.after(()=>{fs.closeSync(fd);fs.rmSync(root,{recursive:true,force:true});});return {root,path,fd,body};
}
test('worker upload hashes the exact inherited descriptor and emits bounded stages',async t=>{
  const f=file(t),events=[];let calls=0;
  const adapter={async upload(r,source,options){calls++;assert.equal(r.sha256,hash(f.body));let all=Buffer.alloc(0);for await(const part of source({}))all=Buffer.concat([all,part]);assert.deepEqual(all,f.body);return {id:r.operationId,state:'VERIFYING'};}};
  const result=await runCloudFileIO({action:'upload',ownerId:user,operationId:id,name:'中文.zip',size:f.body.length},{fd:f.fd,adapter,emit:r=>events.push(r)});
  assert.equal(calls,1);assert.equal(result.id,id);assert.equal(events[0].stage,'HASHING');
});
test('source changes during hashing never reach cloud',async t=>{
  const f=file(t);let calls=0;
  await assert.rejects(runCloudFileIO({action:'upload',ownerId:user,operationId:id,name:'a',size:f.body.length},{fd:f.fd,adapter:{upload(){calls++;}},emit(){fs.writeSync(f.fd,Buffer.from('different'));}}),/changed/);
  assert.equal(calls,0);
});
test('source replacement during upload is not reported as success',async t=>{
  const f=file(t);
  await assert.rejects(runCloudFileIO({action:'upload',ownerId:user,operationId:id,name:'a',size:f.body.length},{fd:f.fd,adapter:{async upload(){fs.ftruncateSync(f.fd,0);return {};}}}),/changed/);
});
test('hardlink input rejected, ordinary private-parent 0644 file supported',async t=>{
  const f=file(t);fs.chmodSync(f.path,0o644);
  const r={action:'upload',ownerId:user,operationId:id,name:'a',size:f.body.length},adapter={async upload(){return {id};}};
  await runCloudFileIO(r,{fd:f.fd,adapter});fs.linkSync(f.path,join(f.root,'another'));
  await assert.rejects(runCloudFileIO(r,{fd:f.fd,adapter}),/regular/);
});
test('download validates offset and immutable file ID before success',async t=>{
  const f=file(t,Buffer.from('pre'));
  const request={action:'download',ownerId:user,operationId:randomUUID(),fileId:id,receipt:'sealed',offset:3};
  const adapter={async download(r,sink,o){let prefix=Buffer.alloc(0);for await(const p of o.readPrefix({bytes:3}))prefix=Buffer.concat([prefix,p]);assert.equal(prefix.toString(),'pre');await sink(Buffer.from('fix'),{offset:3});return {id,bytes:6};}};
  await runCloudFileIO(request,{fd:f.fd,adapter});assert.equal(fs.readFileSync(f.path,'utf8'),'prefix');
  await assert.rejects(runCloudFileIO(request,{fd:f.fd,adapter}),/prefix/);
});
test('unexpected fields, unsafe filenames, unsupported key/owner rejected',()=>{
  const r={action:'upload',ownerId:user,operationId:id,name:'ok',size:1};
  for(const change of [{ownerId:'../x'},{name:'../a'},{size:-1},{token:'secret'},{operationId:'bad'},{receipt:'a'},{name:'a\n'}])assert.throws(()=>validateRequest({...r,...change}));
});
test('verification checks file ID and needs no descriptor',async()=>{
  const request={action:'verify',ownerId:user,operationId:randomUUID(),fileId:id,receipt:'sealed'};
  assert.equal((await runCloudFileIO(request,{adapter:{verify:async()=>({id,state:'VERIFIED'})}})).id,id);
  await assert.rejects(runCloudFileIO(request,{adapter:{verify:async()=>({id:randomUUID()})}}),/mismatch/);
});
test('private config rejects symlinks/public permissions and recognizes apiToken schema',t=>{
  const f=file(t),config=join(f.root,'config.json'),token=join(f.root,'token.json'),key=join(f.root,'key');
  fs.writeFileSync(token,JSON.stringify({apiToken:'SYNTHETIC_PRIVATE_TOKEN'}),{mode:0o600});fs.writeFileSync(key,Buffer.alloc(32,1),{mode:0o600});
  fs.writeFileSync(config,JSON.stringify({enabled:true,capabilityVerified:true,scopeId:'test',cloud:{name:'test',userName:'owner'},tokenFile:token,receiptKeyFile:key,endpoint:'http://127.0.0.1:19798',allowInsecureLoopback:true}),{mode:0o600});
  const r={action:'upload',ownerId:user,operationId:id,name:'a',size:1};const a=workerAdapter(config,r);a.close();
  fs.chmodSync(config,0o644);assert.throws(()=>workerAdapter(config,r),/permissions/);
  fs.chmodSync(config,0o600);fs.symlinkSync(config,join(f.root,'link'));assert.throws(()=>workerAdapter(join(f.root,'link'),r));
});
