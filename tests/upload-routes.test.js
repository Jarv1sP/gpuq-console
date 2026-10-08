import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {validateUploadRoutes,selectUploadRoute,assertUploadRouteGrant} from '../dist/upload-routes.js';
import {probeDirectUploadRoute,createDirectDatasetTransport} from '../client-direct-upload.mjs';
import {probeBrowserUploadRoute,browserDatasetTransport} from '../dist/dataset-upload.js';
import {transferUploadCall} from '../dist/transfer-upload.js';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';

const descriptor={available:true,protocol:'dataset-upload-v1',machine:'node-a',revision:'a'.repeat(64),certificateSha256:'b'.repeat(64),routes:[
  {id:'primary',kind:'campus-direct',endpoint:'https://campus.example:18441'},
  {id:'tail',kind:'tail-upload',endpoint:'https://tail-upload.example:18441'},
  {id:'campus-alt',kind:'campus-direct',endpoint:'https://campus-alt.example:18441'}]};
const capabilities={protocol:descriptor.protocol,machine:descriptor.machine,revision:descriptor.revision,listenerReady:true};
const route=validateUploadRoutes(descriptor,'node-a')[2];
const grant={...route,available:true,routeId:route.id,expiresAt:1300,chunkBytes:1048576,ticket:'private-fixture-ticket-value'};
test('only complete fixed HTTPS descriptors are probed; identity and revision both required',async()=>{
  const calls=[];
  assert.equal((await selectUploadRoute(descriptor,'node-a',async r=>{calls.push(r.id);return r.id==='primary'?{...capabilities,machine:'wrong'}:capabilities;})).id,'campus-alt');
  assert.deepEqual(calls,['primary','campus-alt']);
  await assert.rejects(selectUploadRoute(descriptor,'node-a',async()=>({...capabilities,revision:'c'.repeat(64)})),/no ticket issued/);
  const invalid=[{...descriptor,machine:'node-b'},{...descriptor,routes:[]},{...descriptor,routes:[...descriptor.routes,...descriptor.routes]},
    {...descriptor,routes:[{...descriptor.routes[0],endpoint:'https://user:pass@evil'}]},
    {...descriptor,routes:[{...descriptor.routes[0],endpoint:'https://evil/path'}]},
    {...descriptor,routes:[{...descriptor.routes[0],kind:'vps-relay'}]}];
  let probed=0;for(const value of invalid)await assert.rejects(selectUploadRoute(value,'node-a',async()=>{probed++;}));assert.equal(probed,0);
});
test('Node anonymous probe has no authorization/cookie, follows no redirect and limits its response',async()=>{
  let closed=0,mode='ok';const sent=[];
  const request=(url,options,callback)=>{
    sent.push({url,options});const req=new EventEmitter();req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.destroy=()=>{};response.statusCode=mode==='redirect'?302:200;response.headers={'content-type':'application/json'};callback(response);
      response.emit('data',Buffer.from(mode==='large'?'x'.repeat(4097):JSON.stringify(capabilities)));response.emit('end');});return req;
  };
  const options={request,agentFactory:()=>({destroy(){closed++;}})};
  assert.deepEqual(await probeDirectUploadRoute(route,options),capabilities);
  assert.equal(sent[0].url.pathname,'/capabilities');assert.deepEqual(sent[0].options.headers,{Accept:'application/json'});
  for(mode of ['redirect','large'])await assert.rejects(probeDirectUploadRoute(route,options));assert.equal(sent.length,3);assert.equal(closed,3);
});
test('browser anonymous probe omits credentials and redirects; response is bounded',async()=>{
  const seen=[];
  const fetch=async(url,options)=>{seen.push({url,options});return Response.json(capabilities);};
  assert.deepEqual(await probeBrowserUploadRoute(route,{fetch}),capabilities);
  const options=seen[0].options;assert.equal(options.credentials,'omit');assert.equal(options.mode,'cors');assert.equal(options.redirect,'error');
  assert.deepEqual(options.headers,{Accept:'application/json'});
  await assert.rejects(probeBrowserUploadRoute(route,{fetch:async()=>new Response('x'.repeat(4097),{headers:{'Content-Type':'application/json'}})}),/limit/);
  await assert.rejects(probeBrowserUploadRoute(route,{fetch:async()=>new Response('',{status:302})}),/rejected/);
});
test('selected route binding survives renewals on both clients; changed identity rejects before bytes',async()=>{
  for(const key of ['machine','revision','certificateSha256','endpoint','kind','routeId'])assert.throws(()=>assertUploadRouteGrant({...grant,[key]:'changed'},route),/destination changed/);
  let now=1000,requests=0,issued=0;
  const transport=await createDirectDatasetTransport(async()=>({...grant,revision:issued++?'c'.repeat(64):grant.revision,expiresAt:now+300}),{
    uploadId:'12345678-1234-4234-8234-123456789012',route,now:()=>now,agentFactory:()=>({destroy(){}}),send:async()=>{requests++;return {};}});
  now=1295;await assert.rejects(transport.request('status'),/destination changed/);assert.equal(requests,0);transport.close();
  const controls=[];now=1000;
  const browser=await browserDatasetTransport({route,grant,uploadId:'fixture',now:()=>now,control:async(action,args)=>{
    controls.push({action,args});return action==='status'?{uploadId:'fixture',state:'UPLOADING'}:{...grant,routeId:'primary',expiresAt:now+300};},fetch:async()=>{throw Error('must not send');}});
  now=1295;await assert.rejects(browser.request('status'),/destination changed/);
  assert.deepEqual(controls[1],{action:'direct-ticket',args:{routeId:'campus-alt'}});
});
test('read-only route discovery bypasses transfer mutation; both static servers ship the shared validator',async()=>{
  const seen=[];const adapter=transferUploadCall(async(op,args)=>{seen.push([op,args]);return descriptor;});
  assert.deepEqual(await adapter('datasets.upload.routes',{machine:'node-a'}),descriptor);
  assert.deepEqual(seen,[['datasets.upload.routes',{machine:'node-a'}]]);
  assert.equal(STARBASE_ASSETS['/upload-routes.js'],'upload-routes.js');
  for(const file of ['portal-server.mjs','server.mjs'])assert.match(await readFile(new URL('../'+file,import.meta.url),'utf8'),/STARBASE_ASSETS/);
});
