import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat,symlink,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {downloadFile} from '../client-file-download.mjs';
const fingerprint='a'.repeat(64);
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'personal-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const destination=join(dir,'result.bin'),options={origin:'https://portal.example',userId:'demo-user-1',machine:'node-a',context:{project:'paper',area:'output',runId:'11111111-1111-4111-8111-111111111111'},path:'result.bin',destination},calls=[];
 const f={dir,destination,options,calls,bytes:Buffer.from('abcd'),fingerprint,failed:false};
 f.call=async(operation,args)=>{
  calls.push({operation,args});assert.equal(operation,'files.get');
  if(f.failAt===args.offset&&!f.failed){f.failed=true;throw Object.assign(Error('synthetic disconnection'),{status:503});}
  if(f.beforeRead)await f.beforeRead(args);
  if(args.fingerprint&&args.fingerprint!==f.fingerprint)throw Error('Download source changed');
  const bytes=f.bytes.subarray(args.offset,args.offset+2);
  return {result:{protocol:2,fingerprint:f.fingerprint,path:args.path,size:f.bytes.length,offset:args.offset,data:bytes.toString('base64'),eof:args.offset+bytes.length===f.bytes.length,...f.override}};
 };
 return f;
}
test('complete download uses one file identity and clears its private receipt',async t=>{
 const f=await fixture(t),result=await downloadFile(f.call,f.options);
 assert.equal(result.sha256,hash(f.bytes));assert.equal(result.bytes,4);assert.equal(result.resumed,false);
 assert.deepEqual(await readFile(f.destination),f.bytes);
 assert.equal(f.calls[0].args.fingerprint,undefined);assert.equal(f.calls[1].args.fingerprint,fingerprint);
 await assert.rejects(lstat(f.destination+'.gpuctl-download.json'),error=>error.code==='ENOENT');
});
test('disconnect preserves confirmed bytes and a second invocation resumes the same identity',async t=>{
 const f=await fixture(t);f.failAt=2;
 await assert.rejects(downloadFile(f.call,f.options),/disconnection/);
 assert.equal((await readFile(f.destination)).toString(),'ab');
 const receipt=JSON.parse(await readFile(f.destination+'.gpuctl-download.json','utf8'));
 assert.equal(receipt.offset,2);assert.equal(receipt.fingerprint,fingerprint);assert.equal(receipt.sha256,hash('ab'));
 const before=f.calls.length,result=await downloadFile(f.call,f.options);
 assert.equal(result.resumed,true);assert.equal(f.calls[before].args.offset,2);assert.equal(f.calls[before].args.fingerprint,fingerprint);
 assert.deepEqual(await readFile(f.destination),f.bytes);
});
test('changed source refuses to append and retains both partial and receipt',async t=>{
 const f=await fixture(t);f.failAt=2;
 await assert.rejects(downloadFile(f.call,f.options));f.fingerprint='b'.repeat(64);
 const before=await readFile(f.destination+'.gpuctl-download.json');
 await assert.rejects(downloadFile(f.call,f.options),/source changed/);
 assert.equal((await readFile(f.destination)).toString(),'ab');assert.deepEqual(await readFile(f.destination+'.gpuctl-download.json'),before);
});
test('a different account, server, project, job or origin cannot adopt a partial',async t=>{
 const f=await fixture(t);f.failAt=2;await assert.rejects(downloadFile(f.call,f.options));
 const count=f.calls.length;
 for(const change of [{userId:'demo-user-2'},{machine:'node-b'},{origin:'https://other.example'},{path:'other.bin'},{context:{...f.options.context,project:'other'}},{context:{...f.options.context,runId:'22222222-2222-4222-8222-222222222222'}}])
  await assert.rejects(downloadFile(f.call,{...f.options,...change}),/identity.*changed/);
 assert.equal(f.calls.length,count);assert.equal((await readFile(f.destination)).toString(),'ab');
});
test('edited local partial is rejected before contacting the node',async t=>{
 const f=await fixture(t);f.failAt=2;await assert.rejects(downloadFile(f.call,f.options));
 await writeFile(f.destination,'xx');const count=f.calls.length;
 await assert.rejects(downloadFile(f.call,f.options),/partial changed/);assert.equal(f.calls.length,count);
});
test('unrelated existing destination and receipt symlinks are preserved',async t=>{
 const f=await fixture(t);await writeFile(f.destination,'keep');
 await assert.rejects(downloadFile(f.call,f.options),/Destination exists/);assert.equal(f.calls.length,0);
 const other=join(f.dir,'other');await writeFile(other,'{}');await symlink(other,f.destination+'.gpuctl-download.json');
 await assert.rejects(downloadFile(f.call,f.options),/Unsafe/);assert.equal((await readFile(f.destination)).toString(),'keep');
});
test('first request failure creates no destination or resume marker',async t=>{
 const f=await fixture(t);f.failAt=0;await assert.rejects(downloadFile(f.call,f.options));
 await assert.rejects(lstat(f.destination),error=>error.code==='ENOENT');await assert.rejects(lstat(f.destination+'.gpuctl-download.json'),error=>error.code==='ENOENT');
});
test('malformed offset, size, encoding and EOF are refused before writing',async t=>{
 for(const override of [{offset:1},{size:1},{data:'@@@@'},{eof:true},{data:'',eof:false},{fingerprint:'bad'}]){
  const f=await fixture(t);f.override=override;await assert.rejects(downloadFile(f.call,f.options));
  await assert.rejects(lstat(f.destination),error=>error.code==='ENOENT');
 }
});
test('old node supports a new download but cannot advertise resumable identity',async t=>{
 const f=await fixture(t);f.override={protocol:undefined,fingerprint:undefined};
 const result=await downloadFile(f.call,f.options);assert.equal(result.sha256,hash(f.bytes));
 assert.ok(f.calls.every(call=>call.args.fingerprint===undefined));
 await assert.rejects(lstat(f.destination+'.gpuctl-download.json'),error=>error.code==='ENOENT');
});
test('local edits while a read is pending are caught before appending',async t=>{
 const f=await fixture(t);f.beforeRead=async args=>{if(args.offset===2)await writeFile(f.destination,'xx');};
 await assert.rejects(downloadFile(f.call,f.options),/Local download file changed/);
 assert.equal((await readFile(f.destination)).toString(),'xx');
});

test('an external edit during the final disk write cannot produce success or clear the receipt',async t=>{
 const f=await fixture(t),probe=await open(join(f.dir,'probe'),'w'),prototype=Object.getPrototypeOf(probe),original=prototype.write;
 await probe.close();
 prototype.write=async function(...args){
  const result=await original.apply(this,args);
  if(args[3]===2&&args[0].toString()==='cd')await writeFile(f.destination,'ZZcd');
  return result;
 };
 try{
  await assert.rejects(downloadFile(f.call,f.options),/Local download checksum changed/);
  assert.equal((await readFile(f.destination)).toString(),'ZZcd');
  assert.equal(JSON.parse(await readFile(f.destination+'.gpuctl-download.json','utf8')).offset,4);
 }finally{prototype.write=original;}
});


test('>100GiB safe file metadata and private resume receipt are allowed with warning and bounded bytes',async t=>{
 const f=await fixture(t),size=100*1024**3+1,warnings=[],before=Buffer.from('ab');let count=0;
 const call=async(operation,args)=>{count++;if(count===2||count===3)throw Error('stop after bounded prefix');return {result:{protocol:2,fingerprint,path:args.path,size,offset:args.offset,data:before.toString('base64'),eof:false}};};
 await assert.rejects(downloadFile(call,{...f.options,onWarning:value=>warnings.push(value)}),/stop after/);assert.deepEqual(warnings,[size]);assert.deepEqual(await readFile(f.destination),before);
 const receipt=JSON.parse(await readFile(f.destination+'.gpuctl-download.json','utf8'));assert.equal(receipt.size,size);assert.equal(receipt.offset,2);
 await assert.rejects(downloadFile(call,{...f.options,onWarning:()=>{}}),/stop after/);assert.equal(count,3,'large private receipt passed validation and requested only its saved prefix offset');assert.deepEqual(await readFile(f.destination),before);
});
test('total safe integer and raw chunk boundaries stay strict after removal of the total-byte cap',async t=>{
 for(const override of [{size:Number.MAX_SAFE_INTEGER+1},{size:-1},{size:Infinity},{size:1024**2+2,data:Buffer.alloc(1024**2+2).toString('base64'),eof:true}]){
  const f=await fixture(t);f.override=override;await assert.rejects(downloadFile(f.call,f.options),/Invalid|size/);await assert.rejects(lstat(f.destination),error=>error.code==='ENOENT');
 }
});
