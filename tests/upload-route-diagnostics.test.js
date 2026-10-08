import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {pinnedUploadAgent,probeDirectUploadRoute} from '../client-direct-upload.mjs';
import {selectUploadRoute} from '../dist/upload-routes.js';
import {uploadDatasetSnapshot} from '../client-data-upload.mjs';

const descriptor={available:true,protocol:'dataset-upload-v1',machine:'node-a',revision:'a'.repeat(64),certificateSha256:'b'.repeat(64),routes:[
  {id:'primary',kind:'campus-direct',endpoint:'https://campus.example:18441'},
  {id:'tail',kind:'tail-upload',endpoint:'https://tail.example:18441'}]};
const capability={protocol:descriptor.protocol,machine:descriptor.machine,revision:descriptor.revision,listenerReady:true};
const uploadId='12345678-1234-4234-8234-123456789012';

test('TLS connection failures retain bounded transport categories without native error details',async()=>{
  for(const [native,wanted] of [['ECONNREFUSED','CONNECTION_REFUSED'],['ENOTFOUND','DNS_FAILED'],['EAI_AGAIN','DNS_FAILED'],
    ['ENETUNREACH','NETWORK_UNREACHABLE'],['EHOSTUNREACH','NETWORK_UNREACHABLE'],['ETIMEDOUT','TIMEOUT'],['ERR_SSL_UNKNOWN','TLS_FAILED']]){
    let socket;
    const agent=pinnedUploadAgent(descriptor.certificateSha256,{connect:()=>{socket=new EventEmitter();socket.destroy=()=>{};return socket;}});
    try{
      const result=new Promise(resolve=>agent.createConnection({},resolve));
      socket.emit('error',Object.assign(Error('private-address and token must not escape'),{code:native}));
      const error=await result;assert.equal(error.uploadProbeCode,wanted);assert.doesNotMatch(error.message,/private-address|token/);
    }finally{agent.destroy();}
  }
});

test('probe timeout and certificate mismatch stay distinct and never expose an unchecked socket',async()=>{
  let socket,returned;
  const agent=pinnedUploadAgent(descriptor.certificateSha256,{timeoutMs:5,connect:()=>{
    socket=new EventEmitter();socket.destroy=()=>{};socket.getPeerCertificate=()=>({raw:Buffer.from('wrong certificate')});return socket;
  }});
  try{
    const result=new Promise(resolve=>{returned=agent.createConnection({},resolve);});
    socket.emit('secureConnect');assert.equal(returned,undefined);assert.equal((await result).uploadProbeCode,'CERTIFICATE_MISMATCH');
  }finally{agent.destroy();}
  const timeout=pinnedUploadAgent(descriptor.certificateSha256,{timeoutMs:5,connect:()=>{const sock=new EventEmitter();sock.destroy=()=>{};return sock;}});
  try{const [error]=await Promise.all([new Promise(resolve=>timeout.createConnection({},resolve)),delay(20)]);assert.equal(error.uploadProbeCode,'TIMEOUT');}
  finally{timeout.destroy();}
});

test('anonymous Node probe carries safe agent diagnostics and distinguishes its own deadline',async()=>{
  for(const code of ['CONNECTION_REFUSED','CERTIFICATE_MISMATCH','TIMEOUT']){
    const request=()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>req.emit('error',Object.assign(Error('do not echo socket details'),{uploadProbeCode:code})));return req;};
    await assert.rejects(probeDirectUploadRoute({...descriptor.routes[0],certificateSha256:descriptor.certificateSha256},
      {request,agentFactory:()=>({destroy(){}})}),error=>error.uploadProbeCode===code&&!error.message.includes('socket details'));
  }
  const request=()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{};return req;};
  await Promise.all([assert.rejects(probeDirectUploadRoute({...descriptor.routes[0],certificateSha256:descriptor.certificateSha256},
    {request,agentFactory:()=>({destroy(){}}),timeoutMs:5}),error=>error.uploadProbeCode==='TIMEOUT'),delay(20)]);
});

test('probe HTTP and response failures stay bounded and never echo an upstream body',async()=>{
  for(const [status,type,body,code] of [[302,'application/json','private redirect','HTTP_REJECTED'],
    [403,'application/json','private authorization detail','HTTP_REJECTED'],[200,'text/html','private page','INVALID_RESPONSE'],
    [200,'application/json','not-json private detail','INVALID_RESPONSE'],[200,'application/json','x'.repeat(4097),'RESPONSE_TOO_LARGE']]){
    let destroyed=false;
    const request=(_target,_options,callback)=>{
      const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
        const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':type};res.destroy=()=>{destroyed=true;res.emit('aborted');};
        callback(res);res.emit('data',Buffer.from(body));res.emit('end');
      });return req;
    };
    await assert.rejects(probeDirectUploadRoute({...descriptor.routes[0],certificateSha256:descriptor.certificateSha256},
      {request,agentFactory:()=>({destroy(){}})}),error=>error.uploadProbeCode===code&&!error.message.includes('private'));
    assert.equal(destroyed,code==='RESPONSE_TOO_LARGE');
  }
});

test('route errors distinguish transport, wrong node and revision without response bodies or endpoints',async()=>{
  for(const [observed,code] of [[{...capability,machine:'secret-node'},'NODE_MISMATCH'],[{...capability,revision:'c'.repeat(64)},'REVISION_MISMATCH'],
    [{...capability,listenerReady:false},'LISTENER_NOT_READY'],[{...capability,protocol:'private-protocol'},'PROTOCOL_MISMATCH']]){
    await assert.rejects(selectUploadRoute(descriptor,'node-a',async()=>observed),error=>{
      assert.deepEqual(error.routeFailures,[{routeId:'primary',code}]);
      assert.match(error.message,/no ticket issued/);assert.doesNotMatch(error.message,/secret-node|private-protocol|https:|a{64}|c{64}/);return true;
    });
  }
  const calls=[];
  await assert.rejects(selectUploadRoute(descriptor,'node-a',async route=>{
    calls.push(route.id);throw Object.assign(Error('Bearer do-not-print'),{uploadProbeCode:route.id==='primary'?'CONNECTION_REFUSED':'TIMEOUT'});
  }),error=>{
    assert.deepEqual(error.routeFailures,[{routeId:'primary',code:'CONNECTION_REFUSED'}]);
    assert.match(error.message,/primary: connection refused/);assert.doesNotMatch(error.message,/tail:/);
    assert.doesNotMatch(error.message,/Bearer|do-not-print|https:/);return true;
  });
  assert.deepEqual(calls,['primary']);
  await assert.rejects(selectUploadRoute(descriptor,'node-a',async()=>{throw {uploadProbeCode:'constructor',message:'secret'};}),
    error=>error.routeFailures.every(row=>row.code==='PROBE_FAILED')&&!error.message.includes('secret'));
  const controller=new AbortController(),reason=Error('explicit cancellation');controller.abort(reason);
  await assert.rejects(selectUploadRoute(descriptor,'node-a',()=>assert.fail('canceled probe must not run'),{signal:controller.signal}),error=>error===reason);
});

test('classified route failure still sends no ticket or file bytes and preserves the original retry identity',async()=>{
  const calls=[],keys=[];let opens=0;
  const scan={manifest:Buffer.from('fixture'),manifestSha256:'c'.repeat(64),totalBytes:1,entries:1,files:[],openEntry:()=>{opens++;}};
  const call=async(operation,args)=>{calls.push(operation);if(operation==='datasets.upload.begin'){keys.push(args.key);return {result:{uploadId,state:'RECEIVING_MANIFEST',manifestOffset:0,
    uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true,routeSelection:true}}};}
    assert.equal(operation,'datasets.upload.routes');return {result:descriptor};};
  for(let retry=0;retry<2;retry++)await assert.rejects(uploadDatasetSnapshot(call,{machine:'node-a',name:'fixture',userId:'fixture-owner',scan,
    keyStore:{get:()=>uploadId,set:()=>assert.fail('must retain key')},progress:()=>{},probeRoute:async()=>{
      throw Object.assign(Error('private diagnostic'),{uploadProbeCode:'CONNECTION_REFUSED'});
    }}),error=>error.message.includes('connection refused')&&error.message.includes(uploadId)&&!error.message.includes('private diagnostic'));
  assert.deepEqual(calls,['datasets.upload.begin','datasets.upload.routes','datasets.upload.begin','datasets.upload.routes']);
  assert.equal(keys[0],keys[1]);assert.equal(opens,0);
});

test('campus-only mode never probes Tail or issues tickets after campus failure, including original-ID retry',async()=>{
  const calls=[],probes=[],keys=[];
  const scan={manifest:Buffer.from('fixture'),manifestSha256:'c'.repeat(64),totalBytes:1,entries:1,files:[],openEntry:()=>assert.fail('No file may be opened')};
  const call=async(operation,args)=>{calls.push(operation);if(operation==='datasets.upload.begin'){keys.push(args.key);return {result:{uploadId,state:'RECEIVING_MANIFEST',manifestOffset:0,
    uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true,routeSelection:true}}};}
    assert.equal(operation,'datasets.upload.routes');return {result:descriptor};};
  for(let retry=0;retry<2;retry++)await assert.rejects(uploadDatasetSnapshot(call,{machine:'node-a',name:'fixture',userId:'fixture-owner',scan,via:'campus',
    keyStore:{get:()=>uploadId,set:()=>assert.fail('Keep original UUID')},progress:()=>{},probeRoute:async route=>{
      probes.push(route.id);throw Object.assign(Error('private socket and token'),{uploadProbeCode:'CONNECTION_REFUSED'});
    }}),error=>error.message.includes('primary: connection refused')&&error.message.includes(uploadId)&&!error.message.includes('private socket'));
  assert.deepEqual(probes,['primary','primary']);assert.deepEqual(keys,[uploadId,uploadId]);
  assert.deepEqual(calls,['datasets.upload.begin','datasets.upload.routes','datasets.upload.begin','datasets.upload.routes']);
});

test('campus-only success validates the complete descriptor and pins tickets to primary',async()=>{
  for(const invalid of [false,true]){
    const calls=[],probes=[];let closed=0;
    const scan={manifest:Buffer.from('fixture'),manifestSha256:'c'.repeat(64),totalBytes:0,entries:0,files:[],verify:async()=>{}};
    const call=async(operation,args)=>{calls.push({operation,args});const action=operation.split('.').at(-1);
      if(action==='begin')return {result:{uploadId,state:'RECEIVING_MANIFEST',manifestOffset:0,uploadTransport:{protocol:'dataset-upload-v1',directAvailable:true,routeSelection:true}}};
      if(action==='routes')return {result:invalid?{...descriptor,routes:[descriptor.routes[0],{...descriptor.routes[1],endpoint:'http://unchecked.example'}]}:descriptor};
      if(action==='direct-ticket'){assert.equal(args.routeId,'primary');return {result:{available:true,kind:'campus-direct'}};}
      if(action==='seal')return {result:{uploadId,state:'UPLOADING'}};
      if(action==='commit')return {result:{uploadId,state:'READY',dataset:'fixture',version:'c'.repeat(64)}};
      assert.fail('No relay payload');};
    const options={machine:'node-a',name:'fixture',userId:'fixture-owner',scan,via:'campus',keyStore:{get:()=>uploadId},progress:()=>{},
      probeRoute:async route=>{probes.push(route.id);return capability;},
      directFactory:async(get,{route,uploadId:id})=>{assert.equal(route.id,'primary');assert.equal(id,uploadId);await get();await get();return {
        request:async(action,args)=>{assert.equal(action,'manifest');return {offset:args.bytes.length};},close(){closed++;}};}};
    if(invalid){await assert.rejects(uploadDatasetSnapshot(call,options),/invalid or unavailable/);assert.deepEqual(probes,[]);assert.equal(calls.length,2);}
    else {const result=await uploadDatasetSnapshot(call,options);assert.equal(result.route.kind,'campus-direct');assert.deepEqual(probes,['primary']);
      assert.equal(calls.filter(c=>c.operation.endsWith('direct-ticket')).length,2);assert.equal(closed,1);}
  }
});

test('campus-only rejects old or unavailable capability without tickets or payload, and READY recovery needs no route',async()=>{
  for(const transport of [undefined,{protocol:'dataset-upload-v1',directAvailable:true},{protocol:'dataset-upload-v1',directAvailable:false,routeSelection:true}]){
    const calls=[];
    await assert.rejects(uploadDatasetSnapshot(async(operation)=>{calls.push(operation);return {result:{uploadId,state:'RECEIVING_MANIFEST',uploadTransport:transport}};},
      {machine:'node-a',name:'fixture',userId:'fixture-owner',scan:{manifestSha256:'c'.repeat(64),manifest:Buffer.from('fixture'),totalBytes:0,entries:0},via:'campus',
       keyStore:{get:()=>uploadId},progress:()=>{}}),/Campus-only upload requires confirmed/);
    assert.deepEqual(calls,['datasets.upload.begin']);
  }
  const calls=[];const result=await uploadDatasetSnapshot(async(operation)=>{calls.push(operation);return {result:{uploadId,state:'READY',dataset:'fixture',version:'c'.repeat(64)}};},
    {machine:'node-a',name:'fixture',userId:'fixture-owner',scan:{manifestSha256:'c'.repeat(64),manifest:Buffer.from('fixture'),totalBytes:0,entries:0},via:'campus',keyStore:{get:()=>uploadId},progress:()=>{}});
  assert.equal(result.state,'READY');assert.deepEqual(calls,['datasets.upload.begin']);
});
