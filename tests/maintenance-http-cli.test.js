import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {fixture,seedLegacy,password} from './maintenance-fixture.mjs';
import {buildClient} from '../scripts/build-client.mjs';

test('legacy HTTP clients receive 410 and immutable historical records remain readable',async t=>{
  const f=await fixture(t),r=seedLegacy(f.service,f.owner);
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,{server,service}=await createPortalServer({database:f.database,bootstrap:f.bootstrap,statusPath:f.status,origin,secure:false,bridge:f.bridge});
  clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  f.cleanupWith(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const post=async(path,body,headers={})=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,data:await response.json(),headers:response.headers};};
  const login=await post('/api/login',{username:'admin',password,client:'browser'},{Origin:origin}),cookie=login.headers.get('set-cookie').split(';')[0];
  for(const op of ['create','preview','approve','return','withdraw','cancel','execute']){
    const result=await post('/api/call',{operation:'maintenance.'+op,args:{id:r.id,revision:1,previewToken:'previously-issued-token'}},{Cookie:cookie,Origin:origin});
    assert.equal(result.status,410);assert.match(JSON.stringify(result.data),/已停用/);
  }
  assert.equal((await post('/api/call',{operation:'maintenance.get',args:{id:r.id}},{Cookie:cookie,Origin:origin})).data.result.state,'PENDING');assert.deepEqual(f.calls,[]);
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM maintenance_requests').get().n,1);
  for(const path of ['/maintenance-ui.js','/maintenance.css'])assert.equal((await fetch(origin+path)).status,200);
  for(const path of ['/maintenance.mjs','/portal.sqlite'])assert.equal((await fetch(origin+path)).status,404);
});

test('new bundled CLI keeps history readable, rejects retired commands and escapes control characters',async t=>{
  const f=await fixture(t),r=seedLegacy(f.service,f.owner,{title:'title\u202e\rMASK',script:'printf "old" #\r\u202e\u0085'});
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,{server,service}=await createPortalServer({database:f.database,bootstrap:f.bootstrap,statusPath:f.status,origin,secure:false,bridge:f.bridge});clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  f.cleanupWith(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const login=await service.login(f.owner.username,password),session=join(f.dir,'member-session'),client=join(f.dir,'gpuctl.mjs');
  await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal,machine:'gpu-1'}));await buildClient({outfile:client});
  const cli=args=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[client,'--session-file',session,...args]);let out='',err='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);p.on('error',reject);p.on('close',code=>resolve({out,err,code}));p.stdin.end();});
  for(const op of ['list','show']){const result=await cli(['maintenance',op,...(op==='show'?[r.id]:[])]);assert.equal(result.code,0,result.err);assert.ok(result.out.includes('\\u{202e}'));assert.doesNotMatch(result.out,/[\r\u202e\u0085]/u);}
  for(const op of ['request','preview','approve','return','withdraw','cancel']){const result=await cli(['maintenance',op,r.id]);assert.equal(result.code,1);assert.match(result.err,/已停用|不再支持|仅支持/);}
  assert.deepEqual(f.calls,[]);assert.equal(service.db.prepare('SELECT state FROM maintenance_requests WHERE id=?').get(r.id).state,'PENDING');
});

test('retired module and compatibility assets stay in packaged runtime',async()=>{
  const docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');assert.match(docker,/COPY[^\n]*maintenance\.mjs/);
  const ui=await readFile(new URL('../dist/maintenance-ui.js',import.meta.url),'utf8');assert.doesNotMatch(ui,/maintenance\.(create|preview|approve|return|withdraw|cancel)/);assert.match(ui,/maintenance\.list/);assert.match(ui,/maintenance\.get/);
  const module=await readFile(new URL('../maintenance.mjs',import.meta.url),'utf8');assert.doesNotMatch(module,/service\.bridge\([^;]*['"]host\.(exec|cancel)['"]/);assert.match(module,/MAINTENANCE_RETIRED_MESSAGE,410/);
});

test('operational maintenance uses the same authenticated HTTP/CLI path with explicit CAS restore',async t=>{
  const f=await fixture(t),reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,{server,service}=await createPortalServer({database:f.database,bootstrap:f.bootstrap,statusPath:f.status,origin,secure:false,bridge:f.bridge});
  clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  f.cleanupWith(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const client=join(f.dir,'operational-gpuctl.mjs'),session=join(f.dir,'operational-session');await buildClient({outfile:client});
  const login=await service.login('admin',password);await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal,machine:'gpu-1'}));
  const cli=args=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[client,'--session-file',session,...args]);let out='',err='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);p.on('error',reject);p.on('close',code=>resolve({out,err,code}));p.stdin.end();});
  let result=await cli(['maintenance','on','all','--reason','存储维修','--revision','0']);assert.equal(result.code,0,result.err);assert.match(result.out,/存储维修/);
  result=await cli(['maintenance','off','all','--revision','0']);assert.equal(result.code,1);assert.match(result.err,/刷新/);
  const member=await service.login(f.owner.username,password),response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+member.token},body:JSON.stringify({operation:'datasets.workspace.put',args:{machine:'gpu-1',path:'fixture',data:'eA==',offset:0}})});
  assert.equal(response.status,503);assert.match((await response.json()).error,/全平台维护中：存储维修/);assert.deepEqual(f.calls,[]);
  result=await cli(['maintenance','status']);assert.equal(result.code,0);assert.match(result.out,/revision 1/);
  result=await cli(['maintenance','off','all','--revision','1']);assert.equal(result.code,0,result.err);assert.equal(service.maintenanceFor('gpu-1'),null);
});
