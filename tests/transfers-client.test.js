import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,symlink,link,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {downloadTransfer,transferText} from '../client-transfers.mjs';
import {transferUploadCall} from '../dist/transfer-upload.js';
const CHUNK=1024**2,hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-transfer-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const contents=new Map([['empty',Buffer.alloc(0)],['sub/中文.bin',Buffer.alloc(CHUNK*2+31,7)],['\ue000.bin',Buffer.from('BMP')],['😀.bin',Buffer.from('non-BMP')]]),manifest={directories:['sub'],files:[...contents].map(([path,bytes])=>({path,sha256:hash(bytes),size:bytes.length})),schema:1},raw=Buffer.from(JSON.stringify(manifest)),info={state:'READY',manifestBytes:raw.length,manifestSha256:hash(raw),totalBytes:[...contents.values()].reduce((n,b)=>n+b.length,0),entries:5};
  const row={id:randomUUID(),state:'WAITING_CLIENT',kind:'download',machine:'gpu-1',snapshot:info},gets=[];let interrupt=false,loseComplete=false;
  const call=async(op,args)=>{
    if(op==='transfers.create')return {result:structuredClone(row)};
    if(op==='transfers.progress'){if(args.complete){if(loseComplete){loseComplete=false;throw Error('lost completion');}row.state='SUCCEEDED';}return {result:row};}
    if(op==='transfers.io'){
      if(args.action==='info')return {result:info};
      const data=args.action==='manifest'?raw:contents.get(args.path);if(args.action==='get'){gets.push(args.offset);if(interrupt&&args.offset===CHUNK){interrupt=false;throw Error('network disconnected');}}
      const bytes=data.subarray(args.offset,args.offset+CHUNK);return {result:{data:bytes.toString('base64'),offset:args.offset+bytes.length,size:data.length,eof:args.offset+bytes.length===data.length}};
    }throw Error('unexpected operation');
  };
  return {dir,row,contents,gets,call,options:{machine:'gpu-1',dataset:'shared',version:'a'.repeat(64),destination:join(dir,'download')},interrupt:()=>{interrupt=true;},loseComplete:()=>{loseComplete=true;}};
}
test('real local files resume from persisted offsets with SHA256 and final-directory promotion',async t=>{
  const f=await fixture(t);f.interrupt();await assert.rejects(downloadTransfer(f.call,f.options),/network disconnected/);const partial=f.options.destination+'.gpuq-partial-'+f.row.id;assert.equal((await stat(join(partial,'sub/中文.bin'))).size,CHUNK);
  f.gets.length=0;const ready=await downloadTransfer(f.call,f.options);assert.equal(ready.state,'SUCCEEDED');assert.deepEqual(f.gets.slice(0,2),[CHUNK,CHUNK*2]);assert.deepEqual(await readFile(join(f.options.destination,'sub/中文.bin')),f.contents.get('sub/中文.bin'));assert.equal(f.row.state,'SUCCEEDED');
  await downloadTransfer(f.call,f.options);await writeFile(join(f.options.destination,'sub/中文.bin'),'changed');await assert.rejects(downloadTransfer(f.call,f.options),/changed/);
});
test('a lost completion reply recovers the promoted local directory using the exact receipt',async t=>{
  const f=await fixture(t);f.loseComplete();await assert.rejects(downloadTransfer(f.call,f.options),/lost completion/);const result=await downloadTransfer(f.call,f.options);assert.equal(result.state,'SUCCEEDED');assert.equal(f.row.state,'SUCCEEDED');
});
test('corrupted partial files never produce success and existing destinations are not overwritten',async t=>{
  const f=await fixture(t);f.interrupt();await assert.rejects(downloadTransfer(f.call,f.options));const path=join(f.options.destination+'.gpuq-partial-'+f.row.id,'sub/中文.bin');await writeFile(path,Buffer.alloc(CHUNK,9));await assert.rejects(downloadTransfer(f.call,f.options),/SHA256 differs/);assert.equal(f.row.state,'WAITING_CLIENT');
  await writeFile(f.options.destination,'user data');await assert.rejects(downloadTransfer(f.call,f.options),/already exists/);assert.equal(await readFile(f.options.destination,'utf8'),'user data');
});
test('shared browser/CLI upload adapter registers one task and scopes every chunk to its ID',async()=>{
  const id=randomUUID(),calls=[],call=transferUploadCall(async(op,args)=>{calls.push({op,args});return op==='transfers.create'?{id,uploadId:randomUUID(),state:'WAITING_CLIENT',result:{state:'UPLOADING',uploadId:id}}:{offset:1};});
  await call('datasets.upload.begin',{machine:'gpu-1',name:'mine',key:randomUUID(),manifestBytes:100,manifestSha256:'a'.repeat(64),totalBytes:1,entries:1});await call('datasets.upload.chunk',{machine:'gpu-1',uploadId:id,path:'x',offset:0,data:'YQ=='});assert.equal(calls[1].op,'transfers.io');assert.equal(calls[1].args.id,id);assert.equal(calls[1].args.machine,undefined);
  const canceled=transferUploadCall(async()=>({id,state:'CANCELED'}));await assert.rejects(canceled('datasets.upload.begin',{}),/终止/);assert.doesNotMatch(transferText({id:'id',kind:'copy',machine:'x\x1b[31m',state:'UNKNOWN'}),/\x1b/);
});
test('download receipts never overwrite unrelated regular files, including stale pending files',async t=>{
  const f=await fixture(t),receipt=f.options.destination+'.gpuq-receipt.json';
  await writeFile(receipt,JSON.stringify({id:randomUUID(),manifestSha256:'f'.repeat(64)}));const original=await readFile(receipt);
  await assert.rejects(downloadTransfer(f.call,f.options),/different content/);assert.deepEqual(await readFile(receipt),original);
  await rm(receipt);await writeFile(receipt+'.pending','unrelated pending file');
  await downloadTransfer(f.call,f.options);assert.equal(await readFile(receipt+'.pending','utf8'),'unrelated pending file');
  assert.equal((await readdir(f.dir)).some(name=>name.includes('.pending-')),false);assert.equal((await stat(receipt)).nlink,1);
});
test('symlink and hard-link receipt targets are refused without modifying their referents',async t=>{
  const f=await fixture(t),receipt=f.options.destination+'.gpuq-receipt.json',victim=join(f.dir,'keep.json');await writeFile(victim,'keep');
  try{await symlink(victim,receipt);}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.diagnostic('Windows lacks symlink privilege; hard-link protection is still tested');}else throw error;}
  if(await stat(receipt).catch(()=>null)){await assert.rejects(downloadTransfer(f.call,f.options));assert.equal(await readFile(victim,'utf8'),'keep');await rm(receipt);}
  await link(victim,receipt);await assert.rejects(downloadTransfer(f.call,f.options),/Unsafe/);assert.equal(await readFile(victim,'utf8'),'keep');
});
test('receipt appearing during download is not clobbered, and complete is never reported',async t=>{
  const f=await fixture(t),receipt=f.options.destination+'.gpuq-receipt.json';let planted=false;
  const call=async(op,args)=>{if(op==='transfers.io'&&args.action==='get'&&!planted){planted=true;await writeFile(receipt,JSON.stringify({id:'other',manifestSha256:'other'}));}return f.call(op,args);};
  await assert.rejects(downloadTransfer(call,f.options),/different content/);assert.equal(JSON.parse(await readFile(receipt,'utf8')).id,'other');assert.equal(f.row.state,'WAITING_CLIENT');
});
