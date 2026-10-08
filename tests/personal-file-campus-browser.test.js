import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {personalFileGrant,createPersonalFileTransport,downloadPersonalFile} from '../dist/personal-file-campus.js';
const machine='gpu-1',path='训练.bin',context={project:'test',area:'code'},fingerprint='a'.repeat(64),now=1000;
const grant=()=>({available:true,protocol:'personal-file-campus-v1',machine,kind:'campus-direct',routeId:'primary',grantId:randomUUID(),certificateSha256:'b'.repeat(64),revision:'c'.repeat(64),chunkBytes:1024**2,expiresAt:now+300,ticket:'test-only-opaque-ticket',endpoint:'https://campus.example',file:{protocol:2,path,size:3,fingerprint}});
const metadata=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const options={machine,context,path,action:'get',now:()=>now};
function response(data=Buffer.from('abc'),overrides={}){return new Response(data,{headers:{'content-type':'application/octet-stream','x-gpuq-file-metadata':metadata({protocol:2,path,size:3,offset:0,eof:true,fingerprint,...overrides})}});}
test('browser campus grant refuses old/Tail/foreign/unbounded identities before raw fetch',async()=>{
 for(const change of [{available:false},{protocol:'old'},{machine:'other'},{kind:'tail-upload'},{routeId:'tail'},{endpoint:'http://campus.example'},{endpoint:'https://campus.example/a'},{expiresAt:Infinity},{expiresAt:now+302},{ticket:'bad'},{file:{protocol:2,path,size:Number.MAX_SAFE_INTEGER+1,fingerprint}}]){
  let bytes=0;await assert.rejects(createPersonalFileTransport(async()=>({...grant(),...change}),{...options,fetcher:async()=>{bytes++;}}));assert.equal(bytes,0);
 }
});
test('browser raw fetch sends only exact HTTPS grant and bounded body, with no Portal bytes or redirect/cookies',async()=>{
 const calls=[],fetches=[],identity={uploadId:randomUUID(),totalSize:3,sha256:'d'.repeat(64)};
 const transport=await createPersonalFileTransport(async(op,args)=>{calls.push({op,args});return grant();},{...options,action:'put',identity,fetcher:async(url,args)=>{fetches.push({url:String(url),args});return Response.json({ok:true,result:{complete:true,size:3}});}});
 await transport.request({offset:0,final:true,bytes:new Uint8Array([1,2,3])});
 assert.equal(calls[0].op,'files.direct-ticket');assert.equal('data' in calls[0].args||'bytes' in calls[0].args,false);assert.equal(calls[0].args.uploadId,identity.uploadId);
 assert.equal(fetches[0].args.mode,'cors');assert.equal(fetches[0].args.credentials,'omit');assert.equal(fetches[0].args.redirect,'error');assert.equal(fetches[0].args.body.length,3);
 await assert.rejects(transport.request({offset:0,final:true,bytes:new Uint8Array(1024**2+1)}));transport.close();await assert.rejects(transport.request({offset:0,final:true,bytes:new Uint8Array()}));assert.equal(fetches.length,1);
});
test('browser download enforces exact metadata, UTF8 path, size, fingerprint, offset, EOF and raw body bounds',async()=>{
 const valid=await createPersonalFileTransport(async()=>grant(),{...options,fetcher:async()=>response()});assert.equal(Buffer.from((await valid.request({offset:0})).bytes).toString(),'abc');valid.close();
 for(const result of [response(undefined,{path:'other'}),response(undefined,{fingerprint:'e'.repeat(64)}),response(undefined,{offset:1}),response(undefined,{size:4}),response(undefined,{eof:false}),response(undefined,{data:'secret'}),response(Buffer.from('ab')),response(Buffer.alloc(1024**2+1)),new Response('bad',{status:503}),new Response('bad')]){
  const transport=await createPersonalFileTransport(async()=>grant(),{...options,fetcher:async()=>result});await assert.rejects(transport.request({offset:0}));transport.close();
 }
});
test('lease renewal keeps original identity and refuses changed route, policy, or source before bytes',async()=>{
 for(const change of [{endpoint:'https://other.example'},{certificateSha256:'e'.repeat(64)},{revision:'e'.repeat(64)},{machine:'other'},{file:{protocol:2,path,size:4,fingerprint}},{file:{protocol:2,path,size:3,fingerprint:'e'.repeat(64)}}]){
  let calls=0,writes=0,time=now;const requests=[];
  const transport=await createPersonalFileTransport(async(op,args)=>{requests.push({...args});return {...grant(),expiresAt:time+300,...(calls++?change:{})};},{...options,now:()=>time,fetcher:async()=>{writes++;return response();}});time+=291;
  await assert.rejects(transport.request({offset:0}));transport.close();assert.equal(writes,0);assert.equal(requests[1].fingerprint,fingerprint);
 }
});
test('actor change during ticket or body never consumes/writes old account response',async()=>{
 for(const stage of ['ticket','body']){let current=true,writes=0;const transport=()=>createPersonalFileTransport(async()=>{if(stage==='ticket')current=false;return grant();},{...options,current:()=>current,fetcher:async()=>{current=false;return response();}});
  await assert.rejects(downloadPersonalFile(()=>{},{...options,actor:'one',state:{},current:()=>current,write:async()=>writes++,transportFactory:transport}),error=>error.name==='AbortError');assert.equal(writes,0);
 }
});
test('download preserves prefix/hash/fingerprint and resumes only matching account and exact offset',async()=>{
 const state={},written=[],requests=[],bytes=Buffer.from('abcd');let fail=true;
 const factory=async(call,args)=>{requests.push(args);return {file:{size:4,fingerprint},request:async({offset})=>{requests.push(offset);if(offset===2&&fail){fail=false;throw TypeError('body interrupted');}return {bytes:new Uint8Array(bytes.subarray(offset,offset+2)),eof:offset===2};},close(){}};};
 const opts={machine,context,path,actor:'one',state,write:async(value,offset)=>written.push({offset,value:Buffer.from(value)}),transportFactory:factory};
 await assert.rejects(downloadPersonalFile(()=>{},opts),/interrupted/);assert.equal(state.offset,2);assert.equal(state.prefixSha256,createHash('sha256').update('ab').digest('hex'));
 const count=requests.length;await assert.rejects(downloadPersonalFile(()=>{},{...opts,actor:'two'}),/原账号/);assert.equal(requests.length,count);
 await assert.rejects(downloadPersonalFile(()=>{},{...opts,transportFactory:async()=>({file:{size:4,fingerprint:'e'.repeat(64)},close(){}})}),/来源已改变/);assert.equal(state.offset,2);
 const result=await downloadPersonalFile(()=>{},opts);assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(written.map(row=>row.offset),[0,2]);assert.equal(requests.at(-2).identity.fingerprint,fingerprint);
});
test('browser metadata beyond 100GiB remains allowed; unsafe sizes stay rejected without giant IO',()=>{
 const large={...grant(),file:{protocol:2,path,size:100*1024**3+1,fingerprint}};assert.equal(personalFileGrant(large,{machine,path,action:'get'},now).file.size,large.file.size);
 for(const size of [-1,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>personalFileGrant({...large,file:{...large.file,size}},{machine,path,action:'get'},now));
});
