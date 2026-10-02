import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
import {installCloudImports,cloudImportCall,importPath} from '../cloud-import.mjs';
import {shareReference,AliyunShare} from '../aliyun-share.mjs';
import {importRows,cloudImportHTML} from '../dist/cloud-import-ui.js';
import {runCloudImport} from '../client-cloud-import.mjs';
import {CloudDriveShare} from '../clouddrive-provider.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const admin={userId:'a',username:'owner',role:'admin'},member={userId:'m',username:'member',role:'member'};
function setup(override,{db=new DatabaseSync(':memory:'),inviteKey=randomBytes(32)}={}){const calls=[],audit=[],provider=override||{connected:()=>true,clear(){},begin:async()=>({secret:{ck:'secret-ck'},image:'data:image/png;base64,AA==',expiresAt:Date.now()+60000}),poll:async()=>({state:'CONFIRMED'}),list:async()=>[{id:'file1',name:'test.zip',size:10,driveId:'secret-drive',sha1:'1'.repeat(40)}],resolve:async()=> 'https://cdn.example.test/file?credential=signed-secret'};
  const service={db,inviteKey,store:{get:id=>({id,enabled:true,limits:{'gpu-1':1}})},audit:(...a)=>audit.push(a),bridge:async(machine,op,args)=>{calls.push({machine,op,args});return {operationId:args.key,state:'QUEUED'};}};installCloudImports(service,{provider});return {service,calls,audit,provider};}
test('only official share references and safe relative target paths are accepted',()=>{assert.equal(shareReference('https://www.alipan.com/s/abcd1234').shareId,'abcd1234');for(const url of ['http://www.alipan.com/s/abcd','https://www.alipan.com.evil.test/s/abcd','https://www.alipan.com/drive/abc','https://name:pass@www.alipan.com/s/abcd'])assert.throws(()=>shareReference(url));for(const path of ['../a','/data2/a','x//a','a\\b','a\n'])assert.throws(()=>importPath(path));assert.equal(importPath('incoming/测试.zip'),'incoming/测试.zip');});
test('sharing credentials are sealed; nodes receive only temporary links, never account token',async()=>{const {service,calls,audit}=setup();try{const scan=await cloudImportCall(service,member,'cloud.inspect',{machine:'gpu-1',url:'https://www.alipan.com/s/abcd1234',password:'1234'});assert.deepEqual(Object.keys(scan.files[0]).sort(),['id','name','size']);const key=randomUUID();const result=await cloudImportCall(service,member,'cloud.import.start',{machine:'gpu-1',key,path:'incoming/test.zip',inspectionId:scan.inspectionId,fileId:'file1'});assert.equal(result.state,'QUEUED');assert.equal(calls[0].args.expectedSha1,'1'.repeat(40));assert.equal(calls[0].args.hostAdmin,false);assert.equal(calls[0].args.sourceKind,'aliyun');assert.doesNotMatch(JSON.stringify(result)+JSON.stringify(audit),/signed-secret|1234|refreshToken/);const saved=service.db.prepare('SELECT * FROM cloud_imports').get();assert.doesNotMatch(saved.cipher,/abcd1234|1234/);assert.throws(()=>service.cloudOpen('wrong-owner',saved.cipher));await cloudImportCall(service,member,'cloud.import.resume',{machine:'gpu-1',operationId:key});assert.equal(calls.length,2);}finally{service.db.close();}});
test('one user cannot use another inspection or receipt; account auth is admin-only',async()=>{const {service}=setup();try{for(const op of ['cloud.auth.begin','cloud.auth.poll','cloud.auth.disconnect'])await assert.rejects(cloudImportCall(service,member,op,{}),e=>e.status===403);const scan=await cloudImportCall(service,admin,'cloud.inspect',{machine:'gpu-1',url:'https://www.alipan.com/s/abcd1234'});await assert.rejects(cloudImportCall(service,member,'cloud.import.start',{machine:'gpu-1',key:randomUUID(),path:'a',inspectionId:scan.inspectionId,fileId:'file1'}),/过期/);const key=randomUUID();await cloudImportCall(service,admin,'cloud.import.start',{machine:'gpu-1',key,url:'https://example.test/file',path:'a'});await assert.rejects(cloudImportCall(service,member,'cloud.import.resume',{machine:'gpu-1',operationId:key}),/不存在/);await assert.rejects(cloudImportCall(service,member,'cloud.import.list',{machine:'gpu-2'}),e=>e.status===403);}finally{service.db.close();}});
test('start idempotency forbids changed identity; resume URL replacement keeps fixed expected digest',async()=>{const {service,calls}=setup();try{const args={machine:'gpu-1',key:randomUUID(),url:'https://example.test/f?token=one',path:'incoming/a',sha256:'a'.repeat(64)};await cloudImportCall(service,member,'cloud.import.start',args);await assert.rejects(cloudImportCall(service,member,'cloud.import.start',{...args,path:'b'}),e=>e.status===409);await cloudImportCall(service,member,'cloud.import.resume',{machine:'gpu-1',operationId:args.key,url:'https://example.test/f?token=two'});assert.equal(calls.at(-1).args.sha256,'a'.repeat(64));for(const url of ['http://example.test','https://user:pass@example.test','https://example.test:22/a'])await assert.rejects(cloudImportCall(service,member,'cloud.import.start',{...args,key:randomUUID(),url}));}finally{service.db.close();}});
test('QR secret only stays server-side and login sessions are bound to initiating administrator',async()=>{const {service}=setup();try{const qr=await cloudImportCall(service,admin,'cloud.auth.begin',{});assert.doesNotMatch(JSON.stringify(qr),/secret-ck/);await assert.rejects(cloudImportCall(service,{...admin,userId:'other'},'cloud.auth.poll',{id:qr.id}),e=>e.status===404);assert.equal((await cloudImportCall(service,admin,'cloud.auth.poll',{id:qr.id})).state,'CONFIRMED');await assert.rejects(cloudImportCall(service,admin,'cloud.auth.poll',{id:qr.id}),/过期/);}finally{service.db.close();}});
test('QR session survives the old three-minute cutoff but is swept after ten minutes',async t=>{
  let now=1700000000000,polls=0;
  t.mock.method(Date,'now',()=>now);
  const {service}=setup();
  installCloudImports(service,{request:async url=>new Response(JSON.stringify({content:{data:url.includes('generate.do')
    ?{codeContent:'https://www.alipan.com/login?request=example',ck:'private-ck',t:'1'}
    :(polls++,{qrCodeStatus:'NEW'})}}))});
  try{
    const qr=await cloudImportCall(service,admin,'cloud.auth.begin',{});
    assert.equal(qr.expiresAt,now+10*60*1000);
    now+=4*60*1000;
    assert.equal((await cloudImportCall(service,admin,'cloud.auth.poll',{id:qr.id})).state,'NEW');
    assert.equal(service.cloudQR.has(qr.id),true);
    now=qr.expiresAt+1;
    await assert.rejects(cloudImportCall(service,admin,'cloud.auth.poll',{id:qr.id}),e=>e.status===404);
    assert.equal(service.cloudQR.has(qr.id),false);assert.equal(polls,1);
  }finally{service.db.close();}
});
test('provider EXPIRED and CANCELED immediately remove QR sessions before the local deadline',async()=>{
  for(const state of ['EXPIRED','CANCELED']){
    const {service}=setup();let polls=0;
    installCloudImports(service,{request:async url=>new Response(JSON.stringify({content:{data:url.includes('generate.do')
      ?{codeContent:'https://www.alipan.com/login?request=example',ck:'private-ck',t:'1'}
      :(polls++,{qrCodeStatus:state})}}))});
    try{
      const qr=await cloudImportCall(service,admin,'cloud.auth.begin',{});
      assert.ok(qr.expiresAt>Date.now());
      assert.equal((await cloudImportCall(service,admin,'cloud.auth.poll',{id:qr.id})).state,state);
      assert.equal(service.cloudQR.has(qr.id),false);
      await assert.rejects(cloudImportCall(service,admin,'cloud.auth.poll',{id:qr.id}),e=>e.status===404);
      assert.equal(polls,1);assert.equal(service.cloudProvider.connected(),false);
    }finally{service.db.close();}
  }
});
test('provider token rotation persists before use and provider errors never expose credentials',async()=>{let saved={refreshToken:'private-refresh-token'},calls=0;const provider=new AliyunShare({load:()=>saved,save:v=>{saved=v;},request:async(url,options)=>{calls++;assert.equal(options.redirect,'error');return new Response(JSON.stringify({access_token:'private-access',refresh_token:'rotated',expires_in:3600}));}});assert.equal(await provider.token(),'private-access');assert.equal(saved.refreshToken,'rotated');assert.equal(await provider.token(),'private-access');assert.equal(calls,1);provider.request=async()=>{throw Error('https://example?token=private');};await assert.rejects(provider.list({shareId:'a'}),e=>!e.message.includes('private'));});
test('cloud UI escapes filenames and exposes account connection only to admins',()=>{assert.doesNotMatch(cloudImportHTML(false),/cloud-auth-begin/);assert.match(cloudImportHTML(true),/cloud-auth-begin/);assert.doesNotMatch(importRows([{path:'<script>x</script>',operationId:'"onclick="x',state:'PAUSED',canResume:true}]),/<script>|"onclick="/);});
test('CLI cloud import resolves on backend, prints only id and can list multi-file choices',async()=>{const calls=[];const call=async(op,args)=>{calls.push({op,args});return {result:op==='cloud.inspect'?{inspectionId:'s',files:[{id:'f',name:'data.zip'}]}:{state:'QUEUED'}};};const result=await runCloudImport({action:'import',positionals:['data','import','https://www.alipan.com/s/abcd1234'],options:{machines:[],datasets:[]},machine:'gpu-1',call,stderr:{write:()=>{}}});assert.equal(result.state,'QUEUED');assert.equal(calls[1].args.path,'incoming/data.zip');assert.equal(calls[1].op,'cloud.import.start');});

function cd2({enabled=true,capabilityVerified=true,key=Buffer.alloc(32,9),direct,token='PRIVATE_ACCOUNT_TOKEN'}={}){
  const rpcCalls=[],root='/AliyunOpen/gpuq-intake',cloud={name:'AliyunOpen',userName:'PRIVATE_ACCOUNT_NAME',path:'/AliyunOpen'};
  const directory=path=>({name:path.split('/').at(-1),fullPathName:path,isDirectory:true,isCloudDirectory:true,canAddShareLink:true,CloudAPI:cloud});
  const file=path=>({id:'PRIVATE_CLOUD_FILE_ID',name:'archive.tar',fullPathName:path,size:'5',isCloudFile:true,fileType:'File',CloudAPI:cloud,fileHashes:{2:'1'.repeat(40)}});
  const transport={hostname:'127.0.0.1',async rpc(method,body,options){
    rpcCalls.push({method,body,options});
    if(method==='FindFileByPath')return body.path===root?directory(root):file(body.path);
    if(method==='CreateFolder')return {result:{success:true},folderCreated:directory(root+'/'+body.folderName)};
    if(method==='AddSharedLink')return {};
    if(method==='GetSubFiles')return {subFiles:body.path===root?[]:[file(body.path+'/archive.tar')]};
    if(method==='GetDownloadUrlPath')return direct||{directUrl:'https://cdn.aliyundrive.net/archive?signature=SIGNED_CAPABILITY',userAgent:'CloudDrive/1.1.1',additionalHeaders:{Referer:'https://www.alipan.com/',Origin:'https://www.alipan.com'}};
    throw Error('unexpected RPC');
  }};
  return {provider:new CloudDriveShare({enabled,capabilityVerified,receiptKey:key,intakeRoot:root,cloud,getToken:async()=>token,transport}),rpcCalls};
}
async function inspectShare(service){return cloudImportCall(service,member,'cloud.inspect',{machine:'gpu-1',url:'https://www.alipan.com/s/abcd1234',password:'1234'});}

test('CD2 integration keeps account/receipt private and forwards only URL plus public headers',async()=>{
  const {provider,rpcCalls}=cd2(),{service,calls,audit}=setup(provider);
  try{
    const inspection=await inspectShare(service),key=randomUUID();
    assert.deepEqual(Object.keys(inspection.files[0]).sort(),['id','name','size']);
    assert.doesNotMatch(JSON.stringify(inspection),/PRIVATE|Receipt|AliyunOpen/);
    const result=await cloudImportCall(service,member,'cloud.import.start',{machine:'gpu-1',key,path:'incoming/archive.tar',inspectionId:inspection.inspectionId,fileId:inspection.files[0].id});
    assert.deepEqual(calls[0].args.downloadHeaders,{'User-Agent':'CloudDrive/1.1.1',Referer:'https://www.alipan.com/',Origin:'https://www.alipan.com'});
    assert.equal(calls[0].args.url,'https://cdn.aliyundrive.net/archive?signature=SIGNED_CAPABILITY');
    assert.doesNotMatch(JSON.stringify(calls),/PRIVATE_ACCOUNT|PRIVATE_CLOUD|cloudDriveReceipt|AliyunOpen/);
    assert.doesNotMatch(JSON.stringify(result)+JSON.stringify(audit),/SIGNED_CAPABILITY|PRIVATE|downloadHeaders/);
    const row=service.db.prepare('SELECT * FROM cloud_imports').get();
    assert.doesNotMatch(row.cipher,/PRIVATE|AliyunOpen|cloudDriveReceipt|SIGNED_CAPABILITY/);
    const saved=service.cloudOpen(JSON.stringify([member.userId,'gpu-1',key]),row.cipher);
    assert.equal(saved.backend,'clouddrive');assert.equal(typeof saved.file.cloudDriveReceipt,'string');
    const restarted=cd2();installCloudImports(service,{provider:restarted.provider});
    await cloudImportCall(service,member,'cloud.import.resume',{machine:'gpu-1',operationId:key});
    assert.equal(calls.length,2);assert.equal(restarted.rpcCalls[0].method,'FindFileByPath');
    assert.ok(rpcCalls.every(call=>call.options.token==='PRIVATE_ACCOUNT_TOKEN'));
  }finally{service.db.close();}
});

test('VPS descriptor boundary rejects malformed, secret-bearing or unapproved fields before bridge',async()=>{
  const invalid=[{url:'https://cdn.example/x',token:'PRIVATE_ACCOUNT_TOKEN'},{url:'https://cdn.example/x',additionalHeaders:{Authorization:'Bearer PRIVATE_ACCOUNT_TOKEN'}},{url:'https://cdn.example/x',additionalHeaders:{Cookie:'PRIVATE_COOKIE'}},{url:'https://cdn.example/x',additionalHeaders:{'User-Agent':'override'}},{url:'https://cdn.example/x',additionalHeaders:[]},{url:'https://cdn.example/x',additionalHeaders:true},{url:'https://cdn.example/x',userAgent:'x\r\nAuthorization:PRIVATE_TOKEN'},{url:'https://cdn.example/x',userAgent:512},{url:'https://cdn.example/x',userAgent:'x'.repeat(513)},{url:'https://cdn.example/x',additionalHeaders:{Origin:'https://www.alipan.com/?PRIVATE=1'}},{url:'https://cdn.example/x',additionalHeaders:{Referer:'https://private.example/'}},{url:'http://cdn.example/x'},'http://cdn.example/x'];
  for(const descriptor of invalid){
    const {service,provider,calls}=setup();provider.resolve=async()=>descriptor;
    try{const inspection=await inspectShare(service);await assert.rejects(cloudImportCall(service,member,'cloud.import.start',{machine:'gpu-1',key:randomUUID(),path:'a',inspectionId:inspection.inspectionId,fileId:'file1'}),error=>error.status===502&&!error.message.includes('PRIVATE'));assert.equal(calls.length,0);}finally{service.db.close();}
  }
});

test('CD2 API bearer cannot be smuggled in otherwise accepted download URL or User-Agent',async()=>{
  for(const direct of [{directUrl:'https://cdn.aliyundrive.net/x?token=PRIVATE_ACCOUNT_TOKEN'},{directUrl:'https://cdn.aliyundrive.net/x',userAgent:'CloudDrive PRIVATE_ACCOUNT_TOKEN'}]){
    const {provider}=cd2({direct}),{service,calls}=setup(provider);
    try{const inspection=await inspectShare(service);await assert.rejects(cloudImportCall(service,member,'cloud.import.start',{machine:'gpu-1',key:randomUUID(),path:'a',inspectionId:inspection.inspectionId,fileId:inspection.files[0].id}),error=>error.status===403&&!error.message.includes('PRIVATE'));assert.equal(calls.length,0);}finally{service.db.close();}
  }
});

test('CD2 disconnect survives SQLite close/reopen without deleting old Aliyun credentials; reconnect is admin-only',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'gpuq-cd2-restart-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const path=join(folder,'portal.db'),inviteKey=randomBytes(32);
  let fixture=setup(cd2().provider,{db:new DatabaseSync(path),inviteKey});
  fixture.service.db.prepare("INSERT INTO cloud_secrets VALUES('aliyun',?)").run(fixture.service.cloudSeal('aliyun',{refreshToken:'OLD_PRIVATE_ALIYUN_TOKEN'}));
  const old=fixture.service.db.prepare("SELECT cipher FROM cloud_secrets WHERE id='aliyun'").get().cipher;
  assert.deepEqual(await cloudImportCall(fixture.service,admin,'cloud.auth.disconnect',{}),{disconnected:true,backend:'clouddrive',persistent:true});
  fixture.service.db.close();
  const restarted=cd2();fixture=setup(restarted.provider,{db:new DatabaseSync(path),inviteKey});
  try{
    const info=await cloudImportCall(fixture.service,member,'cloud.info',{});
    assert.equal(info.backend,'clouddrive');assert.equal(info.managedExternally,true);assert.equal(info.status,'disabled');assert.equal(info.disabled,true);assert.equal(info.aliyunConnected,false);
    assert.equal(restarted.rpcCalls.length,0);
    await assert.rejects(inspectShare(fixture.service),error=>error.status===409);
    await assert.rejects(cloudImportCall(fixture.service,member,'cloud.auth.reconnect',{}),error=>error.status===403);
    assert.equal(fixture.service.db.prepare("SELECT cipher FROM cloud_secrets WHERE id='aliyun'").get().cipher,old);
    for(const op of ['cloud.auth.begin','cloud.auth.poll'])await assert.rejects(cloudImportCall(fixture.service,admin,op,{}),/专用后台/);
    assert.deepEqual(await cloudImportCall(fixture.service,admin,'cloud.auth.reconnect',{}),{reconnected:true,backend:'clouddrive',managedExternally:true});
    assert.equal(restarted.rpcCalls.length,0);
    const active=await cloudImportCall(fixture.service,member,'cloud.info',{});assert.equal(active.status,'configured');assert.equal(active.aliyunConnected,true);
    assert.doesNotMatch(JSON.stringify(active),/PRIVATE|token|AliyunOpen|19798/);
    const next=cd2();installCloudImports(fixture.service,{provider:next.provider});assert.equal(next.provider.connected(),true);assert.equal(next.rpcCalls.length,0);
  }finally{fixture.service.db.close();}
});

test('disabled/unverified CD2 is never probed by info, QR or reconnect and remains persistently disabled',async()=>{
  for(const config of [{enabled:false},{capabilityVerified:false}]){
    const {provider,rpcCalls}=cd2(config),{service}=setup(provider);
    try{
      const info=await cloudImportCall(service,member,'cloud.info',{});assert.equal(info.aliyunConnected,false);assert.equal(info.managedExternally,true);assert.match(info.status,/configuration_disabled|capability_unverified/);
      await cloudImportCall(service,admin,'cloud.auth.disconnect',{});
      await assert.rejects(cloudImportCall(service,admin,'cloud.auth.reconnect',{}),error=>error.status===409);
      assert.equal(service.cloudDisabled(),true);assert.equal(rpcCalls.length,0);
    }finally{service.db.close();}
  }
});

test('native Aliyun disconnect remains independent and native reconnect is not supported',async()=>{
  const {service}=setup();try{
    service.db.prepare("INSERT INTO cloud_secrets VALUES('aliyun',?)").run('old-secret');
    service.db.prepare("INSERT INTO cloud_provider_settings VALUES('clouddrive',1)").run();
    await cloudImportCall(service,admin,'cloud.auth.disconnect',{});
    assert.equal(service.db.prepare("SELECT cipher FROM cloud_secrets WHERE id='aliyun'").get(),undefined);
    assert.equal(service.db.prepare("SELECT disabled FROM cloud_provider_settings WHERE backend='clouddrive'").get().disabled,1);
    await assert.rejects(cloudImportCall(service,admin,'cloud.auth.reconnect',{}),error=>error.status===409);
  }finally{service.db.close();}
});

test('saved CD2 imports never fall back to native Aliyun after backend changes',async()=>{
  const {service,calls}=setup(cd2().provider);try{
    const inspection=await inspectShare(service),key=randomUUID();
    await cloudImportCall(service,member,'cloud.import.start',{machine:'gpu-1',key,path:'a',inspectionId:inspection.inspectionId,fileId:inspection.files[0].id});
    let resolved=false;
    installCloudImports(service,{provider:{connected:()=>true,clear(){},resolve(){resolved=true;throw Error('must not resolve');}}});
    await assert.rejects(cloudImportCall(service,member,'cloud.import.resume',{machine:'gpu-1',operationId:key}),error=>error.status===409);
    assert.equal(resolved,false);assert.equal(calls.length,1);
  }finally{service.db.close();}
});

test('disconnect fences an in-flight resolve before its descriptor reaches the node',async()=>{
  const {service,provider,calls}=setup();try{
    let release,entered;const started=new Promise(resolve=>{entered=resolve;});
    provider.resolve=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
    const inspection=await inspectShare(service);
    const importing=cloudImportCall(service,member,'cloud.import.start',{machine:'gpu-1',key:randomUUID(),path:'a',inspectionId:inspection.inspectionId,fileId:'file1'});
    await started;await cloudImportCall(service,admin,'cloud.auth.disconnect',{});release('https://cdn.example/file');
    await assert.rejects(importing,error=>error.status===409);assert.equal(calls.length,0);
  }finally{service.db.close();}
});

test('reconnect rereads updated private config without contacting CD2 and missing config stays disabled',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'gpuq-cd2-reload-')),path=join(folder,'cd2.json');t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const previous=process.env.GPUQ_CLOUDDRIVE_CONFIG;
  const config={enabled:true,capabilityVerified:false,endpoint:'http://127.0.0.1:19798',allowInsecureLoopback:true,intakeRoot:'/AliyunOpen/intake',cloud:{name:'AliyunOpen',userName:'PRIVATE_ACCOUNT',path:'/AliyunOpen'},apiToken:'PRIVATE_ACCOUNT_TOKEN'};
  const {service}=setup();
  try{
    writeFileSync(path,JSON.stringify(config),{mode:0o600});process.env.GPUQ_CLOUDDRIVE_CONFIG=path;installCloudImports(service);
    await cloudImportCall(service,admin,'cloud.auth.disconnect',{});
    await assert.rejects(cloudImportCall(service,admin,'cloud.auth.reconnect',{}),error=>error.status===409);assert.equal(service.cloudDisabled(),true);
    writeFileSync(path,JSON.stringify({...config,capabilityVerified:true}));
    await cloudImportCall(service,admin,'cloud.auth.reconnect',{});
    assert.equal((await cloudImportCall(service,member,'cloud.info',{})).status,'configured');
    await cloudImportCall(service,admin,'cloud.auth.disconnect',{});delete process.env.GPUQ_CLOUDDRIVE_CONFIG;
    await assert.rejects(cloudImportCall(service,admin,'cloud.auth.reconnect',{}),error=>error.status===409);assert.equal(service.cloudDisabled(),true);
  }finally{service.cloudProvider.close?.();service.db.close();if(previous===undefined)delete process.env.GPUQ_CLOUDDRIVE_CONFIG;else process.env.GPUQ_CLOUDDRIVE_CONFIG=previous;}
});

test('ordinary HTTPS imports stay available while CD2 is persistently disabled',async()=>{
  const {provider,rpcCalls}=cd2(),{service,calls}=setup(provider);
  try{
    await cloudImportCall(service,admin,'cloud.auth.disconnect',{});
    await cloudImportCall(service,member,'cloud.import.start',{machine:'gpu-1',key:randomUUID(),url:'https://public.example/data.tar',path:'a'});
    assert.equal(calls.length,1);assert.equal(calls[0].args.sourceKind,'https');assert.equal(calls[0].args.downloadHeaders,undefined);assert.equal(rpcCalls.length,0);
  }finally{service.db.close();}
});

test('disconnect fences late inspection and does not restore its private file selection',async()=>{
  const {service,provider}=setup();try{
    let release,entered;const started=new Promise(resolve=>{entered=resolve;});
    provider.list=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
    const inspection=inspectShare(service);await started;
    await cloudImportCall(service,admin,'cloud.auth.disconnect',{});release([{id:'private-file',name:'file',size:0}]);
    await assert.rejects(inspection,error=>error.status===409);assert.equal(service.cloudInspections.size,0);
  }finally{service.db.close();}
});
