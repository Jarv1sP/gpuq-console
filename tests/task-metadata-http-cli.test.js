import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {buildClient} from '../scripts/build-client.mjs';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const password='Task-Metadata-HTTP-Fixture-2026!';
test('downloaded standalone CLI, bearer/cookie API and public resource metadata share one persisted contract',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-task-metadata-http-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));let native=[];
  const snapshot=()=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,memoryTotalMiB:32768,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:m.id==='gpu-1'?native:[]}}))}));
  await snapshot();const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,calls=[];
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge:async(machine,op,args)=>{calls.push({machine,op,args});return {state:'RUNNING',nodeJobId:'J'+args.job.id,assignedIndices:[0]};}});
  clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{while(service.reconciling)await new Promise(r=>setTimeout(r,5));await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'cli-member',password})).result,observer=(await service.invoke(admin.token,'users.create',{username:'browser-observer',password})).result;
  for(const u of [member,observer])await service.invoke(admin.token,'policy.save',{userId:u.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const owner=await service.login(member.username,password),session=join(dir,'session'),client=join(dir,'gpuctl.mjs');
  await writeFile(session,JSON.stringify({url:origin,token:owner.token,principal:owner.principal,machine:'gpu-1'}));await writeFile(client,await(await fetch(origin+'/gpuctl.mjs')).text());
  const cli=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[client,'--url',origin,'--session-file',session,'--json',...args]);let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>resolve({code,err,data:out?JSON.parse(out).data:null}));child.stdin.end();});
  const profile=await cli(['profile','--display-name','张三']);assert.equal(profile.code,0,profile.err);assert.equal(profile.data.name,'张三');
  const run=await cli(['run','--legacy','-g','1','--name','CLI 正常任务名','--description','第一行\n验证新数据集','--','python','train.py','--token','PRIVATE-ARGV']);assert.equal(run.code,0,run.err);assert.equal(run.data.description,'第一行\n验证新数据集');assert.equal(run.data.submitter.name,'张三');
  await new Promise(r=>setImmediate(r));while(service.reconciling)await new Promise(r=>setTimeout(r,5));
  const job=service.store.jobs[0];native=[{id:job.nodeJobId,name:'portal-wrapper',owner:'internal-owner',state:'RUNNING',priority:2,gpu_count:1,assigned_gpu_indices:[0]}];await snapshot();
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:observer.username,password,client:'browser'})});const cookie=login.headers.get('set-cookie').split(';')[0];
  const post=async(operation,args={})=>{const response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:origin},body:JSON.stringify({operation,args})});return {status:response.status,data:await response.json()};};
  const state=await post('state');assert.equal(state.status,200);assert.equal(state.data.state.jobs.length,0);const task=state.data.state.gpuq.hosts[0].tasks[0];assert.equal(task.submitter.name,'张三');assert.equal(task.name,'CLI 正常任务名');assert.equal(task.description,'第一行\n验证新数据集');assert.ok(!JSON.stringify(state.data).includes('PRIVATE-ARGV'));
  assert.equal((await post('jobs.logs',{jobId:job.id})).status,403);assert.equal((await post('jobs.cancel',{jobId:job.id})).status,403);
  const queue=await cli(['queue','--machine','gpu-1']);assert.equal(queue.code,0,queue.err);assert.equal(queue.data.hosts[0].tasks[0].name,'CLI 正常任务名');assert.equal((await cli(['queue','--machine','gpu-2'])).code,1);
  for(const path of ['/task-metadata.js','/resources-ui.js','/execution-ui.js'])assert.equal((await fetch(origin+path)).status,200,path);
  assert.equal((await fetch(origin+'/task-catalog.mjs')).status,404);assert.equal(calls[0].args.job.description,undefined);assert.equal(calls[0].args.job.submitterName,undefined);
});

test('standalone CLI renders all legacy member metadata safely, including C1 CSI and OSC',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-metadata-controls-')),client=join(dir,'gpuctl.mjs'),session=join(dir,'session');
  await buildClient({outfile:client});
  const payload='旧记录\u009b2J\u009d52;c;c2VjcmV0\u009c\x1b[31m\u202e';
  const member={id:'member',username:payload,name:payload,role:'member',enabled:true,total:1,limits:{'gpu-1':1}};
  const task={id:'old-job',state:'RUNNING',machine:'gpu-1',name:payload,description:'第一行\n'+payload,
    submitter:{name:payload,username:'login-'+payload},assignedGpuIndices:[0],cards:1};
  const state={machines:[{id:'gpu-1'}],users:[member],jobs:[task],demo:false,taskMetadata:{version:1},
    gpuq:{stale:false,checkedAt:'2026-10-03',hosts:[{id:'gpu-1',reachable:true,tasks:[task]}]}};
  let failState=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);
    res.setHeader('Content-Type','application/json');
    if(failState){res.statusCode=403;res.end(JSON.stringify({error:payload}));return;}
    res.end(JSON.stringify(body.operation==='state'?{state}:{result:{notes:[{id:'note',author:{username:payload},body:'首行\n'+payload}]}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(session,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'fixture-only',machine:'gpu-1',principal:{userId:'member',role:'member'}}));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const run=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[client,'--session-file',session,...args]);let out='',err='';
    child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.end();
  });
  for(const command of ['queue','jobs','users','profile','notes','state']){
    const result=await run([command]);assert.equal(result.code,0,result.err);
    assert.doesNotMatch(result.out,/[\u009b\u009c\u009d\x1b\u202e]/u,command);
    assert.match(result.out,/旧记录/,command);assert.match(result.out,/\\+u\{009b\}/,command);
    if(command==='queue')assert.ok(result.out.includes('描述：第一行\n旧记录'));
  }
  const json=await run(['queue','--json']);assert.equal(json.code,0,json.err);
  assert.doesNotMatch(json.out,/[\u009b\u009c\u009d\x1b\u202e]/u);
  assert.equal(JSON.parse(json.out).data.hosts[0].tasks[0].name,payload,'JSON remains lossless, not display-escaped data');
  failState=true;const failure=await run(['queue']);assert.equal(failure.code,1);
  // Structured metadata remains visibly escaped (above); HTTP error details
  // are already control-sanitized by apiPost before the terminal formatter.
  // Both representations must be inert; errors need not preserve escape codes.
  assert.doesNotMatch(failure.err.replace(/\n$/,''),/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.equal(failure.err,'Error: state：HTTP 403 — 旧记录 2J 52;c;c2VjcmV0  [31m \n');
});
