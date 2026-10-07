import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {scanLocalDataset,snapshotKey} from '../client-data-upload.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex'),chunk=1024*1024;
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-data-cli-')),session=join(dir,'session.json'),data=join(dir,'data'),calls=[],uploads=new Map(),admissions=new Map();await mkdir(data);let failAfterChunk=false,onBegin=null;
  const state={demo:false,gpuqConnected:true,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[],datasetUploadAdmission:{protocol:1,available:true}};
  const result=u=>({uploadId:u.id,name:u.name,state:u.state,...(u.admitted?{placementProtocol:1,requestedMachine:'gpu-1',storageMachine:'gpu-2',storageTier:'hdd',legacyPlacement:false}:{}),...(u.resumeState?{resumeState:u.resumeState}:{}),manifestOffset:u.manifest.length,manifestBytes:u.spec.manifestBytes,totalBytes:u.spec.totalBytes,entries:u.spec.entries,chunkBytes:chunk,...(u.state==='READY'?{dataset:'u-1b171bf4b4b08285-'+u.name,version:hash(u.manifest)}:{})});
  const server=createServer(async(req,res)=>{try{
    let raw='';for await(const part of req)raw+=part;const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});res.setHeader('Content-Type','application/json');assert.ok(Buffer.byteLength(raw)<=1500000);
    if(operation==='state'){res.end(JSON.stringify({state}));return;}
    if(operation==='datasets.upload.admission.create'||operation==='datasets.upload.admission.status'){
      let receipt=admissions.get(args.key);
      if(operation.endsWith('.create')){const specification=Object.fromEntries(['name','manifestBytes','manifestSha256','totalBytes','entries'].map(key=>[key,args[key]]));if(!receipt){receipt={protocol:'dataset-upload-admission-v1',key:args.key,uploadId:randomUUID(),requestedMachine:args.machine,storageMachine:'gpu-2',storageTier:'hdd',specification,state:'ISSUED'};admissions.set(args.key,receipt);}assert.deepEqual(receipt.specification,specification);}
      assert.ok(receipt,'Original admission must exist');res.end(JSON.stringify({result:receipt}));return;
    }
    const action=operation.split('.').at(-1);let u;
    if(action==='begin'){
      u=uploads.get(args.key);if(!u){u={id:args.key,admitted:[...admissions.values()].some(row=>row.uploadId===args.key),name:args.name,state:'RECEIVING_MANIFEST',spec:args,manifest:Buffer.alloc(0),files:new Map()};uploads.set(args.key,u);}await onBegin?.(u);res.end(JSON.stringify({result:result(u)}));return;
    }
    u=[...uploads.values()].find(v=>v.id===args.uploadId);assert.ok(u,'upload handle must already exist');let output;
    if(action==='manifest'){assert.equal(args.offset,u.manifest.length);const bytes=Buffer.from(args.data,'base64');assert.ok(bytes.length<=chunk);u.manifest=Buffer.concat([u.manifest,bytes]);output={...result(u),offset:u.manifest.length};}
    else if(action==='seal'){assert.equal(hash(u.manifest),u.spec.manifestSha256);u.parsed=JSON.parse(u.manifest);assert.equal(u.parsed.files.length+u.parsed.directories.length,u.spec.entries);u.state='UPLOADING';output=result(u);}
    else if(action==='status'){output=result(u);if(args.path){const entry=u.parsed.files.find(f=>f.path===args.path),bytes=u.files.get(args.path);output.file={...entry,offset:bytes?.length||0,complete:!!bytes&&bytes.length===entry.size};}}
    else if(action==='chunk'){const bytes=Buffer.from(args.data,'base64'),before=u.files.get(args.path)||Buffer.alloc(0);assert.ok(bytes.length<=chunk);assert.equal(args.offset,before.length);u.files.set(args.path,Buffer.concat([before,bytes]));if(failAfterChunk){failAfterChunk=false;throw Error('Simulated response lost after durable write');}output={...result(u),offset:before.length+bytes.length,complete:u.files.get(args.path).length===u.parsed.files.find(f=>f.path===args.path).size};}
    else if(action==='commit'){for(const file of u.parsed.files)assert.equal(hash(u.files.get(file.path)),file.sha256);u.state='READY';output=result(u);}
    else if(action==='discard'){assert.notEqual(u.state,'READY');u.state='DISCARDED';output=result(u);}
    else throw Error('Unexpected operation '+operation);res.end(JSON.stringify({result:output}));
  }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  await writeFile(session,JSON.stringify({url,token:'test-only',principal:{userId:'demo-user-1',username:'tester',role:'member'},machine:'gpu-1'}),{mode:0o600});
  const cli=args=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,'--json',...args]);let stdout='',stderr='';p.stdout.on('data',s=>stdout+=s);p.stderr.on('data',s=>stderr+=s);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr,result:stdout?JSON.parse(stdout).data:null}));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});return {dir,data,session,calls,uploads,cli,failChunk:()=>{failAfterChunk=true;},onBegin:fn=>{onBegin=fn;}};
}
test('standalone CLI uploads a directory with empty files/directories and resumes a lost chunk response',async t=>{
  const f=await fixture(t),contents=randomBytes(chunk*2+31);await writeFile(join(f.data,'samples.bin'),contents);await writeFile(join(f.data,'zero'),'');await mkdir(join(f.data,'empty'));f.failChunk();
  const args=['data','upload',f.data,'--name','mine'],first=await f.cli(args);assert.equal(first.code,1);assert.match(first.stderr,/response lost/);assert.equal(f.uploads.size,1);const u=[...f.uploads.values()][0];assert.equal(u.files.get('samples.bin').length,chunk);
  const before=f.calls.length,second=await f.cli(args);assert.equal(second.code,0,second.stderr);assert.equal(second.result.state,'READY');assert.equal(f.uploads.size,1);assert.deepEqual(u.files.get('samples.bin'),contents);assert.ok(u.parsed.directories.includes('empty'));
  const follow=f.calls.slice(before);assert.equal(follow.find(c=>c.operation==='datasets.upload.chunk').args.offset,chunk);assert.equal(follow.some(c=>c.operation==='datasets.upload.manifest'),false);
  assert.equal(f.calls.some(c=>'hostAdmin' in c.args||'owners' in c.args||'sourceId' in c.args),false);
  const again=await f.cli(args);assert.equal(again.code,0,again.stderr);assert.equal(again.result.version,second.result.version);
});
test('CLI refuses unsupported local links, credentials and unauthorized or privileged arguments',async t=>{
  const f=await fixture(t);await writeFile(join(f.dir,'outside'),'secret');await symlink(join(f.dir,'outside'),join(f.data,'link'));
  assert.equal((await f.cli(['data','upload',f.data,'--name','mine'])).code,1);assert.equal(f.uploads.size,0);await rm(join(f.data,'link'));await writeFile(join(f.data,'.env'),'secret');
  assert.equal((await f.cli(['data','upload',f.data,'--name','mine'])).code,1);assert.equal(f.uploads.size,0);
  for(const extra of [['--root'],['--as','admin'],['--project','alpha'],['--machine','gpu-4'],['--name','../../bad']])assert.equal((await f.cli(['data','upload',f.data,'--name','mine',...extra])).code,1);
  assert.equal(f.uploads.size,0);
});
test('CLI detects local content changes between hashing and upload and does not publish',async t=>{
  const f=await fixture(t),path=join(f.data,'data.bin');await writeFile(path,'before');f.onBegin(async()=>{await writeFile(path,'changed');});
  const result=await f.cli(['data','upload',f.data,'--name','mine']);assert.equal(result.code,1);assert.match(result.stderr,/changed/);assert.equal(f.calls.some(c=>c.operation==='datasets.upload.commit'),false);
});
test('discarded uploads can restart with a persisted fresh key and normal READY data cannot be discarded',async t=>{
  const f=await fixture(t);await writeFile(join(f.data,'data.bin'),'payload');
  // This compatibility case explicitly starts with the original legacy key;
  // admitted uploads never rotate their server-issued UUID after discard.
  const scan=await scanLocalDataset(f.data,()=>{}),key=snapshotKey(['demo-user-1','gpu-1','mine',scan.manifestSha256]),saved=JSON.parse(await readFile(f.session,'utf8'));saved.datasetUploadKeys={[key]:key};await writeFile(f.session,JSON.stringify(saved),{mode:0o600});
  f.failChunk();const args=['data','upload',f.data,'--name','mine'];await f.cli(args);
  const old=[...f.uploads.values()][0];assert.equal((await f.cli(['data','upload-discard',old.id])).result.state,'DISCARDED');
  const restarted=await f.cli(args);assert.equal(restarted.code,0,restarted.stderr);assert.equal(f.uploads.size,2);const cache=JSON.parse(await readFile(f.session,'utf8'));assert.equal(Object.keys(cache.datasetUploadKeys).length,1);
  const repeated=await f.cli(args);assert.equal(repeated.code,0,repeated.stderr);assert.equal(f.uploads.size,2);
  assert.equal((await f.cli(['data','upload-discard',repeated.result.uploadId])).code,1);
});
test('CLI reseals a complete retained manifest after backend reports that reconstruction is needed',async t=>{
  const f=await fixture(t);await writeFile(join(f.data,'data.bin'),'payload');const args=['data','upload',f.data,'--name','mine'];assert.equal((await f.cli(args)).code,0);
  const u=[...f.uploads.values()][0];u.state='FAILED';u.resumeState='RECEIVING_MANIFEST';u.files.clear();const before=f.calls.length;
  const result=await f.cli(args);assert.equal(result.code,0,result.stderr);assert.equal(result.result.state,'READY');const actions=f.calls.slice(before).filter(c=>c.operation!=='state').map(c=>c.operation.split('.').at(-1));
  assert.deepEqual(actions,['status','begin','seal','status','chunk','commit']);assert.equal(f.uploads.size,1);
});
