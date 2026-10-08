import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {routePresentation,transferBytes,uploadPhase,LARGE_RELAY_BYTES} from '../dist/data-route.js';
import {transferCard,transferGroups} from '../dist/transfers-ui.js';
import {uploadRouteHTML,campusDatasetCall} from '../dist/datasets-ui.js';

test('routes require an explicit known transport, never infer a campus path',()=>{
  for(const value of [undefined,null,{},'10.11.1.2',{url:'https://192.168.1.2'},'copy'])assert.equal(routePresentation(value).kind,'unknown');
  assert.equal(routePresentation({kind:'campus-direct'}).label,'校内直传');
  assert.equal(routePresentation('vps-relay').label,'平台中转');
  assert.equal(routePresentation({kind:'cloud-pull'}).label,'服务器直下');
  assert.equal(routePresentation('node-lan').label,'实验室内网');
  assert.equal(routePresentation('tail-upload').label,'Tail 备用上传');
  assert.match(routePresentation('tail-upload').note,/中继可能影响速度/);
  const tail=uploadRouteHTML({kind:'tail-upload'},'node-a');
  assert.match(tail,/仅校内网络可上传/);assert.doesNotMatch(tail,/Tail|中转|node-a/);
  assert.match(uploadRouteHTML({kind:'campus-direct'},'node-a'),/校园网直连.*node-a/);
  const first=routePresentation('campus-direct');first.path.push('wrong');assert.equal(routePresentation('campus-direct').path.length,3);
});
test('transfer sizes distinguish unknown, zero and actual binary units',()=>{
  assert.equal(transferBytes(undefined),'—');assert.equal(transferBytes(null),'—');assert.equal(transferBytes(-1),'—');
  assert.equal(transferBytes(0),'0 B');assert.equal(transferBytes(1048576),'1.0 MiB');assert.equal(transferBytes(2*1024**3),'2.00 GiB');
  assert.equal(LARGE_RELAY_BYTES,256*1024**2);
});
test('upload phases follow actual events and cannot imply success after an unknown state',()=>{
  assert.equal(uploadPhase('HASHING'),0);assert.equal(uploadPhase('UPLOADING'),1);assert.equal(uploadPhase('PUBLISHING'),2);assert.equal(uploadPhase('READY'),3);
  assert.equal(uploadPhase('FAILED'),-1);assert.equal(uploadPhase(undefined),-1);
});
test('transfer card shows real route metadata and never invents zero or progress',()=>{
  const row={id:'T123',kind:'copy',state:'RUNNING',machine:'gpu-1',from:'gpu-2',name:'sample'};
  const unknown=transferCard(row);assert.match(unknown,/通道待确认/);assert.doesNotMatch(unknown,/<progress|0 B|实验室内网/);
  const known=transferCard({...row,route:{kind:'node-lan'},result:{bytes:1024,totalBytes:2048}});
  assert.match(known,/实验室内网/);assert.match(known,/<progress max="2048" value="1024"/);assert.match(known,/传输中/);
  assert.doesNotMatch(transferCard({...row,result:{bytes:3000,totalBytes:2048}}),/<progress/);
  assert.match(transferCard({...row,lastConfirmedRoute:'campus-direct'}),/最近确认 · 校内直传/);
  assert.match(transferCard({...row,lastConfirmedRoute:'vps-relay',route:'campus-direct'}),/最近确认 · 平台中转/);
});
test('transfer cards escape identifiers, status and errors and preserve resume affordance',()=>{
  const html=transferCard({id:'" onclick="bad',name:'<script>',machine:'x',kind:'copy',state:'FAILED',error:'<unsafe>'});
  assert.doesNotMatch(html,/<script>|<unsafe>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/data-transfer-action="resume"/);
  assert.match(html,/需要处理/);assert.match(html,/未完成文件保留/);
  assert.doesNotMatch(transferCard({id:'ok',kind:'copy',state:'CANCELED'}),/data-transfer-action="resume"|data-transfer-action="cancel"/);
});
test('the drawer has no relay consent or alternate route selector',async()=>{
  const source=await readFile(new URL('../dist/datasets-ui.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/dataset-relay-consent|value="relay"|value="automatic"|Tail/);
  assert.match(source,/const via='direct',allowRelay=false/);
  assert.match(source,/已暂停 · 校内网络恢复后继续/);
});
test('campus policy filters only validated routes and never relays browser bytes',async()=>{
  const descriptor={available:true,protocol:'dataset-upload-v1',machine:'node-a',revision:'a'.repeat(64),certificateSha256:'b'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:'https://campus.invalid'},{id:'backup',kind:'tail-upload',endpoint:'https://backup.invalid'}]};
  const calls=[];const call=campusDatasetCall(async(operation,args)=>{calls.push({operation,args});return descriptor;});
  const value=await call('datasets.upload.routes',{machine:'node-a'});
  assert.deepEqual(value.routes,[descriptor.routes[0]]);assert.equal(descriptor.routes.length,2);
  for(const operation of ['datasets.workspace.put','datasets.workspace.get','datasets.upload.manifest','datasets.upload.chunk'])await assert.rejects(call(operation,{}),{code:'CAMPUS_REQUIRED'});
  for(const action of ['manifest','chunk'])await assert.rejects(call('transfers.io',{action}),{code:'CAMPUS_REQUIRED'});
  assert.equal(calls.length,1,'Portal byte operations are rejected before reaching the API');
  await assert.rejects(campusDatasetCall(async()=>({...descriptor,routes:[...descriptor.routes,{id:'bad',kind:'tail-upload',endpoint:'http://bad.invalid'}]}))('datasets.upload.routes',{machine:'node-a'}));
  const denied=campusDatasetCall(async()=>({available:true,kind:'tail-upload'}));
  await assert.rejects(denied('datasets.upload.direct-ticket',{}),{code:'CAMPUS_REQUIRED'});
  await assert.rejects(denied('transfers.io',{action:'direct-ticket'}),{code:'CAMPUS_REQUIRED'});
  const grant={available:true,kind:'campus-direct'};assert.equal(await campusDatasetCall(async()=>grant)('datasets.upload.direct-ticket',{}),grant);
});
test('legacy campus tickets require the current account’s approved campus endpoint and certificate',async()=>{
  const routes={available:true,protocol:'dataset-upload-v1',machine:'node-a',revision:'a'.repeat(64),certificateSha256:'b'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:'https://campus.invalid'}]};
  let account='one',ticket={available:true,endpoint:'https://campus.invalid',certificateSha256:'b'.repeat(64)};
  const call=campusDatasetCall(async operation=>operation.endsWith('.routes')?routes:ticket,()=>account);
  await assert.rejects(call('datasets.upload.direct-ticket',{}),{code:'CAMPUS_REQUIRED'});
  await call('datasets.upload.routes',{machine:'node-a'});assert.equal(await call('datasets.upload.direct-ticket',{}),ticket);
  ticket={...ticket,endpoint:'https://other.invalid'};await assert.rejects(call('datasets.upload.direct-ticket',{}),{code:'CAMPUS_REQUIRED'});
  ticket={...ticket,endpoint:'https://campus.invalid',certificateSha256:'c'.repeat(64)};await assert.rejects(call('datasets.upload.direct-ticket',{}),{code:'CAMPUS_REQUIRED'});
  ticket={...ticket,certificateSha256:'b'.repeat(64)};account='two';await assert.rejects(call('datasets.upload.direct-ticket',{}),{code:'CAMPUS_REQUIRED'});
});
test('the presentation helper is registered in both real and demo static routers',async()=>{
  for(const file of ['portal-server.mjs','server.mjs'])assert.match(await readFile(new URL('../'+file,import.meta.url),'utf8'),/\['\/data-route\.js'\]='data-route\.js'/);
});
test('transfer groups prioritize decisions without dropping unknown, canceled, or paginated records',()=>{
 const states=['SUCCEEDED','RUNNING','PAUSED','CANCELING','UNKNOWN','WAITING_CLIENT','CANCELED','FAILED','FUTURE_STATE'];
 const rows=states.map((state,index)=>({id:String(index),state})),groups=transferGroups(rows);
 assert.deepEqual(groups.map(group=>group.id),['attention','active','done']);
 assert.deepEqual(groups[0].rows.map(row=>row.state),['PAUSED','UNKNOWN','WAITING_CLIENT','FAILED','FUTURE_STATE']);
 assert.deepEqual(groups[1].rows.map(row=>row.state),['RUNNING','CANCELING']);
 assert.deepEqual(groups[2].rows.map(row=>row.state),['SUCCEEDED','CANCELED']);
 assert.equal(groups.flatMap(group=>group.rows).length,rows.length);
 assert.deepEqual(transferGroups([]),[]);
});
