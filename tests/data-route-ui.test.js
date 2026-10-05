import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {routePresentation,transferBytes,uploadPhase,LARGE_RELAY_BYTES} from '../dist/data-route.js';
import {transferCard,transferGroups} from '../dist/transfers-ui.js';
import {uploadRouteHTML} from '../dist/datasets-ui.js';

test('routes require an explicit known transport, never infer a campus path',()=>{
  for(const value of [undefined,null,{},'10.11.1.2',{url:'https://192.168.1.2'},'copy'])assert.equal(routePresentation(value).kind,'unknown');
  assert.equal(routePresentation({kind:'campus-direct'}).label,'校内直传');
  assert.equal(routePresentation('vps-relay').label,'VPS 中转');
  assert.equal(routePresentation({kind:'cloud-pull'}).label,'服务器直下');
  assert.equal(routePresentation('node-lan').label,'实验室内网');
  assert.equal(routePresentation('tail-upload').label,'Tail 备用上传');
  assert.match(routePresentation('tail-upload').note,/中继可能影响速度/);
  const tail=uploadRouteHTML({kind:'tail-upload'},'node-a');
  assert.match(tail,/Tail 备用上传/);assert.doesNotMatch(tail,/经门户中转|不经.*VPS|千兆/);
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
  assert.match(transferCard({...row,lastConfirmedRoute:'vps-relay',route:'campus-direct'}),/最近确认 · VPS 中转/);
});
test('transfer cards escape identifiers, status and errors and preserve resume affordance',()=>{
  const html=transferCard({id:'" onclick="bad',name:'<script>',machine:'x',kind:'copy',state:'FAILED',error:'<unsafe>'});
  assert.doesNotMatch(html,/<script>|<unsafe>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/data-transfer-action="resume"/);
  assert.match(html,/需要处理/);assert.match(html,/未完成文件保留/);
  assert.doesNotMatch(transferCard({id:'ok',kind:'copy',state:'CANCELED'}),/data-transfer-action="resume"|data-transfer-action="cancel"/);
});
test('browser relay requires a real consent checkbox before hashing large selections',async()=>{
  const source=await readFile(new URL('../dist/datasets-ui.js',import.meta.url),'utf8');
  assert.match(source,/total<=LARGE_RELAY_BYTES/);assert.match(source,/dataset-relay-consent/);
  assert.ok(source.indexOf('>LARGE_RELAY_BYTES')<source.indexOf('const scan=await scanBrowserDirectory'));
  assert.match(source,/当前网页上传通道/);assert.match(source,/此确认不会开启直传/);
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
