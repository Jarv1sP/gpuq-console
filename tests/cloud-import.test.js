import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
import {installCloudImports,cloudImportCall,importPath} from '../cloud-import.mjs';
import {shareReference,AliyunShare} from '../aliyun-share.mjs';
import {importRows,cloudImportHTML} from '../dist/cloud-import-ui.js';
import {runCloudImport} from '../client-cloud-import.mjs';
const admin={userId:'a',username:'owner',role:'admin'},member={userId:'m',username:'member',role:'member'};
function setup(){const calls=[],audit=[],provider={connected:()=>true,clear(){},begin:async()=>({secret:{ck:'secret-ck'},image:'data:image/png;base64,AA==',expiresAt:Date.now()+60000}),poll:async()=>({state:'CONFIRMED'}),list:async()=>[{id:'file1',name:'test.zip',size:10,driveId:'secret-drive',sha1:'1'.repeat(40)}],resolve:async()=> 'https://cdn.example.test/file?credential=signed-secret'};
  const service={db:new DatabaseSync(':memory:'),inviteKey:randomBytes(32),store:{get:id=>({id,enabled:true,limits:{'gpu-1':1}})},audit:(...a)=>audit.push(a),bridge:async(machine,op,args)=>{calls.push({machine,op,args});return {operationId:args.key,state:'QUEUED'};}};installCloudImports(service,{provider});return {service,calls,audit,provider};}
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
