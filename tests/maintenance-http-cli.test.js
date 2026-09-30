import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,mkdir,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
import {pathToFileURL} from 'node:url';

const password='Maintenance-HTTP-Fixture-2026!';
test('real cookie API and downloaded standalone CLI share requests/decisions, never root before approval',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-http-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),scriptFile=join(dir,'request.sh');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));await writeFile(scriptFile,'printf "fixture only\\n"');
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,calls=[],receipts=new Map();
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args});const id=args.key||args.id;
    if(operation==='host.exec')receipts.set(id,{id,state:'SUCCEEDED',stdout:'fixture only\n',stderr:'',exitCode:0});
    if(!receipts.has(id))throw Error('No receipt');return receipts.get(id);
  };
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const post=async(path,body,headers={})=>{const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,data:await r.json(),headers:r.headers};};
  const admin=await service.login('admin',password),owner=(await service.invoke(admin.token,'users.create',{username:'cli-requester',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:owner.id,policyVersion:0});
  const member=await service.login(owner.username,password),session=join(dir,'member-session.json'),adminSession=join(dir,'admin-session.json');
  await writeFile(session,JSON.stringify({url:origin,token:member.token,principal:member.principal,machine:'gpu-1'}));await writeFile(adminSession,JSON.stringify({url:origin,token:admin.token,principal:admin.principal,machine:'gpu-1'}));
  const cliFile=join(dir,'gpuctl.mjs');await writeFile(cliFile,await(await fetch(origin+'/gpuctl.mjs')).text());
  const cli=(args,file=session)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[cliFile,'--url',origin,'--session-file',file,'--json',...args]);let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>resolve({code,err,data:out?JSON.parse(out).data:null}));p.stdin.end();});
  const key=randomUUID(),args=['maintenance','request','--name','检查测试依赖','--reason','需要管理员检查','--script-file',scriptFile,'--key',key];
  const submitted=await cli(args);assert.equal(submitted.code,0,submitted.err);assert.equal(submitted.data.state,'PENDING');assert.equal(calls.length,0);
  assert.equal((await cli(args)).data.id,submitted.data.id);assert.equal((await cli(['maintenance','list'])).data.items.length,1);
  assert.equal((await cli(['maintenance','approve',submitted.data.id])).code,1);assert.equal(calls.length,0);
  const cookieLogin=await post('/api/login',{username:'admin',password,client:'browser'},{Origin:origin});const cookie=cookieLogin.headers.get('set-cookie').split(';')[0];
  const call=(operation,args,headers={Cookie:cookie,Origin:origin})=>post('/api/call',{operation,args},headers);
  assert.equal((await call('maintenance.preview',{id:submitted.data.id},{Cookie:cookie})).status,403);
  const preview=await call('maintenance.preview',{id:submitted.data.id});assert.equal(preview.status,200);assert.equal(preview.data.result.request.script,await readFile(scriptFile,'utf8'));
  const returned=await call('maintenance.return',{id:submitted.data.id,revision:1,reason:'请补充说明'});assert.equal(returned.status,200);
  assert.equal((await cli(['maintenance','show',submitted.data.id])).data.decision.reason,'请补充说明');assert.equal(calls.length,0);
  const next=await cli([...args.slice(0,-2),'--parent',submitted.data.id]);assert.equal(next.code,0,next.err);
  const p=await cli(['maintenance','preview',next.data.id],adminSession);assert.equal(p.code,0,p.err);
  const approved=await cli(['maintenance','approve',next.data.id,'--revision',String(p.data.request.revision),'--preview-token',p.data.previewToken],adminSession);
  assert.equal(approved.code,0,approved.err);assert.equal(approved.data.state,'SUCCEEDED');assert.equal((await cli(['maintenance','show',next.data.id])).data.result.stdout,'fixture only\n');
  assert.equal(calls.filter(c=>c.operation==='host.exec').length,1);assert.equal(calls[0].args.userId,'builtin-admin');
  assert.equal((await cli(['maintenance','approve',next.data.id,'--revision','1','--preview-token',p.data.previewToken],adminSession)).code,0);
  assert.equal(calls.filter(c=>c.operation==='host.exec').length,1);
  for(const path of ['/maintenance-ui.js','/maintenance.css'])assert.equal((await fetch(origin+path)).status,200);
  for(const path of ['/maintenance.mjs','/docs/PRIVILEGED_REQUESTS_DESIGN.md','/portal.sqlite'])assert.equal((await fetch(origin+path)).status,404);
  const docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');assert.match(docker,/COPY[^\n]*maintenance\.mjs/);
});
test('approval snapshot round-trips through existing Python Commands receipt/owner protocol (not real ROOT)',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-native-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  const calls=[];
  const {PortalService}=await import('../portal-service.mjs');
  const bridge=(machine,operation,args)=>new Promise((resolve,reject)=>{
    calls.push({machine,operation,args});const p=spawn('python3',[new URL('./maintenance-native-fixture.py',import.meta.url).pathname,dir]);let out='',err='';
    p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>{if(code)reject(Error(err));else try{resolve(JSON.parse(out));}catch(e){reject(e);}});p.stdin.end(JSON.stringify({operation,args}));
  });
  const s=await PortalService.open(join(dir,'db'),bootstrap,status,bridge);clearInterval(s.executionTimer);clearInterval(s.maintenanceTimer);
  t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true});});
  const a=await s.login('admin',password),owner=(await s.invoke(a.token,'users.create',{username:'native-requester',password})).result;
  await s.invoke(a.token,'policy.full',{userId:owner.id,policyVersion:0});const member=await s.login(owner.username,password);
  const r=(await s.invoke(member.token,'maintenance.create',{key:randomUUID(),machine:'gpu-1',title:'协议验收',reason:'本地临时适配器，仅执行固定 printf',cwd:dir,script:'printf "native fixture\\n"'})).result;
  const p=(await s.invoke(a.token,'maintenance.preview',{id:r.id})).result;
  const approved=(await s.invoke(a.token,'maintenance.approve',{id:r.id,revision:r.revision,previewToken:p.previewToken})).result;
  assert.equal(approved.state,'SUCCEEDED');assert.equal(approved.result.stdout,'native fixture\n');assert.equal(approved.result.exitCode,0);
  assert.equal((await s.invoke(member.token,'maintenance.get',{id:r.id})).result.state,'SUCCEEDED');
  await s.invoke(a.token,'maintenance.approve',{id:r.id,revision:r.revision,previewToken:p.previewToken});assert.equal(calls.filter(c=>c.operation==='host.exec').length,1);
});
test('Docker COPY-only runtime starts and serves maintenance assets without source tree or node_modules',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-runtime-'));let server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');
  for(const line of docker.split('\n').filter(s=>s.startsWith('COPY '))){
    const parts=line.split(/\s+/).slice(1).filter(s=>!s.startsWith('--'));
    const destination=parts.pop(),directory=join(dir,destination);await mkdir(directory,{recursive:true});
    for(const source of parts){const input=new URL('../'+source,import.meta.url),target=destination.endsWith('/')?join(directory,source.split('/').at(-1)):directory;await cp(input,target,{recursive:true});}
  }
  const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,runtime=await import(pathToFileURL(join(dir,'portal-server.mjs')));
  const created=await runtime.createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false});server=created.server;await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const login=await created.service.login('admin',password);assert.equal(login.state.maintenance.version,1);assert.equal((await created.service.invoke(login.token,'maintenance.list',{})).result.items.length,0);
  for(const path of ['/','/maintenance-ui.js','/maintenance.css','/community-ui.js','/gpuctl.mjs','/guide/queue'])assert.equal((await fetch(origin+path)).status,200,path);
  assert.ok((await(await fetch(origin+'/guide/queue')).text()).includes('申请系统维修'));
});
