import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createServer} from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateDirectGrant,pinnedUploadAgent,createDirectDatasetTransport,directUploadRequest,RELAY_LIMIT_BYTES} from '../client-direct-upload.mjs';
import {uploadDatasetSnapshot,putWorkspaceData} from '../client-data-upload.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const id='12345678-1234-4234-8234-123456789012';
const grant=(extra={})=>({available:true,protocol:'dataset-upload-v1',endpoint:'https://192.168.77.100:18444',certificateSha256:'a'.repeat(64),ticket:'test-only-bearer-'.repeat(3),expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576,...extra});

test('direct grants require a bounded, pinned HTTPS origin and short expiration',()=>{
  assert.equal(validateDirectGrant(grant()).protocol,'dataset-upload-v1');
  for(const endpoint of ['http://192.168.77.100:18444','https://user:secret@host','https://host/x','https://host/?ticket=x','https://host/#x','file:///tmp/secret'])assert.throws(()=>validateDirectGrant(grant({endpoint})));
  for(const extra of [{available:false},{certificateSha256:'bad'},{ticket:'token\r\nx: y'},{expiresAt:0},{expiresAt:Math.floor(Date.now()/1000)+3600},{chunkBytes:0}])assert.throws(()=>validateDirectGrant(grant(extra)));
});

test('TLS socket is never exposed before certificate verification',async()=>{
  const certificate=Buffer.from('fixture-certificate');let socket,callback=false;
  const connect=()=>{socket=new EventEmitter();socket.destroy=()=>{socket.destroyed=true;};socket.getPeerCertificate=()=>({raw:certificate});return socket;};
  const agent=pinnedUploadAgent(hash(certificate),{connect});
  assert.equal(agent.createConnection({},(error,result)=>{assert.ifError(error);assert.equal(result,socket);callback=true;}),undefined);
  assert.equal(callback,false);socket.emit('secureConnect');assert.equal(callback,true);agent.destroy();
  const bad=pinnedUploadAgent('0'.repeat(64),{connect});let failure;
  bad.createConnection({},error=>{failure=error;});assert.equal(failure,undefined);socket.emit('secureConnect');assert.match(failure.message,/certificate/);assert.equal(socket.destroyed,true);bad.destroy();
});

test('expiring tickets renew without changing the approved node or revealing the token',async()=>{
  let now=1000,count=0,destroyed=0;const calls=[];
  const transport=await createDirectDatasetTransport(async()=>{count++;return grant({expiresAt:now+300});},{uploadId:id,now:()=>now,agentFactory:()=>({destroy(){destroyed++;}}),send:async(g,a,r)=>{calls.push(r);return {offset:1};}});
  await transport.request('chunk',{offset:0,path:'a',bytes:Buffer.from('x')});assert.equal(count,1);
  now=1295;await transport.request('status',{path:'a'});assert.equal(count,2);assert.equal(calls[1].uploadId,id);
  transport.close();assert.equal(destroyed,1);await assert.rejects(transport.request('status'),/closed/);
  let i=0;const changed=await createDirectDatasetTransport(async()=>grant({expiresAt:now+9,endpoint:i++?'https://other.example':'https://first.example'}),{uploadId:id,now:()=>now,agentFactory:()=>({destroy(){}})});
  await assert.rejects(changed.request('status'),/destination changed/);changed.close();
});

function snapshot(size=1){const content=Buffer.from('x'),manifest=Buffer.from(JSON.stringify({schema:1,directories:[],files:[{path:'a',size,sha256:hash(content)}]}));return {manifest,manifestSha256:hash(manifest),totalBytes:size,entries:1,files:[{path:'a',size,sha256:hash(content)}],openEntry:async()=>({read:async()=>content,verify:async()=>{},close:async()=>{}}),verify:async()=>{}};}
const keyStore={get:()=>undefined,set:async()=>{}};

test('large workspace files require relay consent before opening or sending bytes',async()=>{
  let opened=false,called=false;
  const filesystem={lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:1n,size:BigInt(RELAY_LIMIT_BYTES)+1n}),open:async()=>{opened=true;throw Error('opening permitted');}};
  const call=async()=>{called=true;};
  await assert.rejects(putWorkspaceData(call,'node','archive.zip','archive.zip',false,filesystem),/--via relay/);
  assert.equal(opened,false);assert.equal(called,false);
  await assert.rejects(putWorkspaceData(call,'node','archive.zip','archive.zip',false,{...filesystem,via:'relay'}),/opening permitted/);
  assert.equal(opened,true);assert.equal(called,false);
});

test('large legacy-server uploads require explicit relay consent before any file bytes',async()=>{
  const calls=[];const call=async(op,args)=>{calls.push({op,args});return {result:{uploadId:id,state:'RECEIVING_MANIFEST',manifestOffset:0}};};
  await assert.rejects(uploadDatasetSnapshot(call,{machine:'node',name:'data',userId:'u',scan:snapshot(RELAY_LIMIT_BYTES+1),keyStore,progress:()=>{}}),/--via relay/);
  assert.deepEqual(calls.map(x=>x.op),['datasets.upload.begin']);
});

test('direct upload sends raw file/manifest bytes only to the node, control stays on portal',async()=>{
  const scan=snapshot(),portal=[],raw=[],progress=[];let closed=0;
  const call=async(op,args)=>{portal.push({op,args});const action=op.split('.').at(-1);
    if(action==='begin')return {result:{uploadId:id,state:'RECEIVING_MANIFEST',manifestOffset:0,uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true,relayLimitBytes:RELAY_LIMIT_BYTES}}};
    if(action==='direct-ticket')return {result:grant()};
    if(action==='seal')return {result:{state:'UPLOADING'}};
    if(action==='commit')return {result:{state:'READY',dataset:'dataset',version:'c'.repeat(64)}};
    throw Error('Payload unexpectedly sent through portal');
  };
  const directFactory=async(get,{uploadId})=>{assert.equal(uploadId,id);assert.equal((await get()).available,true);return {request:async(action,args)=>{raw.push({action,args});if(action==='status')return {file:{...scan.files[0],offset:0,complete:false}};assert.ok(Buffer.isBuffer(args.bytes));return {offset:args.offset+args.bytes.length,complete:true};},close(){closed++;}};};
  const result=await uploadDatasetSnapshot(call,{machine:'node',name:'data',userId:'u',scan,keyStore,progress:(phase,value)=>progress.push({phase,value}),directFactory});
  assert.equal(result.route.kind,'campus-direct');assert.equal(closed,1);assert.deepEqual(raw.map(x=>x.action),['manifest','status','chunk']);
  assert.equal(portal.some(x=>x.args.data||x.args.bytes),false);assert.equal(progress.find(x=>x.phase==='ROUTE').value.kind,'campus-direct');
});

test('a failed direct connection never falls back to relay, even for a small file',async()=>{
  const calls=[];let closed=false;
  const call=async(op)=>{calls.push(op);return {result:op.endsWith('begin')?{uploadId:id,state:'RECEIVING_MANIFEST',manifestOffset:0,uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true}}:grant()};};
  await assert.rejects(uploadDatasetSnapshot(call,{machine:'node',name:'data',userId:'u',scan:snapshot(),keyStore,progress:()=>{},directFactory:async()=>({request:async()=>{throw Error('Direct upload connection failed');},close(){closed=true;}})}),/connection failed/);
  assert.equal(calls.includes('datasets.upload.manifest'),false);assert.equal(closed,true);
});
test('failed route discovery/probes and a configured unavailable listener never issue tickets or relay bytes',async()=>{
  for(const mode of ['probe','listener','protocol']){
    const calls=[],description={available:true,protocol:'dataset-upload-v1',machine:'node',revision:'b'.repeat(64),certificateSha256:'a'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:'https://upload.example'}]};
    const call=async(op,args)=>{calls.push({op,args});return {result:op.endsWith('begin')?{uploadId:id,state:'RECEIVING_MANIFEST',manifestOffset:0,uploadTransport:{protocol:mode==='protocol'?'unknown':'dataset-upload-v1',directAvailable:mode!=='listener',routeSelection:true,reason:'listener-unavailable'}}:description};};
    await assert.rejects(uploadDatasetSnapshot(call,{machine:'node',name:'data',userId:'u',scan:snapshot(),keyStore,progress:()=>{},probeRoute:async()=>{throw Error('unreachable');}}),/no (?:automatic )?VPS fallback|no ticket issued/);
    assert.equal(calls.some(x=>x.op.endsWith('direct-ticket')||x.args.data),false);
  }
});

test('explicit relay selection is announced and transmitted in authenticated begin',async()=>{
  const scan=snapshot(),routes=[],calls=[];
  const call=async(op,args)=>{calls.push({op,args});const a=op.split('.').at(-1);return {result:a==='begin'?{uploadId:id,state:'RECEIVING_MANIFEST',manifestOffset:0}:a==='manifest'?{offset:scan.manifest.length}:a==='seal'?{state:'UPLOADING'}:a==='status'?{file:{...scan.files[0],offset:0,complete:false}}:a==='chunk'?{offset:1,complete:true}:{state:'READY',dataset:'data',version:'c'.repeat(64)}};};
  const result=await uploadDatasetSnapshot(call,{machine:'node',name:'data',userId:'u',scan,keyStore,via:'relay',progress:(phase,value)=>{if(phase==='ROUTE')routes.push(value);}});
  assert.equal(calls[0].args.allowRelay,true);assert.equal(calls.some(x=>x.op.endsWith('direct-ticket')),false);assert.equal(result.route.kind,'vps-relay');assert.equal(routes[0].explicit,true);
});

test('real pinned TLS rejects mismatched nodes before sending any HTTP bearer',async t=>{
  // The integration fixture generates its own disposable key, never reads a
  // user's certificate, and contacts only this process's loopback server.
  try{execFileSync('openssl',['version'],{stdio:'ignore'});}catch{t.skip('OpenSSL unavailable; portable pin/handshake tests above still run');return;}
  const dir=await mkdtemp(join(tmpdir(),'gpuq-direct-tls-')),key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  const der=execFileSync('openssl',['x509','-in',cert,'-outform','DER']);let requests=0,received;
  const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{requests++;received=req.headers.authorization;const parts=[];for await(const part of req)parts.push(part);assert.equal(Buffer.concat(parts).toString(),'raw');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:{offset:3,complete:true}}));});
  server.on('tlsClientError',()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const valid=validateDirectGrant(grant({endpoint:`https://127.0.0.1:${server.address().port}`,certificateSha256:hash(der)})),wrong=pinnedUploadAgent('0'.repeat(64));
  await assert.rejects(directUploadRequest(valid,wrong,{uploadId:id,action:'chunk',path:'训练/a',offset:0,bytes:Buffer.from('raw')}),/certificate/);wrong.destroy();assert.equal(requests,0);
  const right=pinnedUploadAgent(valid.certificateSha256);assert.equal((await directUploadRequest(valid,right,{uploadId:id,action:'chunk',path:'训练/a',offset:0,bytes:Buffer.from('raw')})).offset,3);right.destroy();assert.equal(requests,1);assert.equal(received,'Bearer '+valid.ticket);
});
