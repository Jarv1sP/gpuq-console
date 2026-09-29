import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {executionCall} from '../execution.mjs';
import {createPortalServer} from '../portal-server.mjs';

const JOB='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function fixture(){
  const owner={id:'demo-user-1',enabled:true,limits:{'gpu-1':2}},other={id:'demo-user-2',enabled:true,limits:{'gpu-1':2}},admin={id:'builtin-admin',enabled:true,limits:{'gpu-1':8}};
  const spec={id:JOB,userId:owner.id,argv:['python','train.py']};
  const job={id:JOB,userId:owner.id,machine:'gpu-1',state:'RUNNING',spec};
  const calls=[],result={jobId:JOB,schedulerState:'RUNNING',state:'PARTIAL',workerErrorEvidence:true};
  const users=[owner,other,admin];
  const service={store:{get:id=>users.find(u=>u.id===id),jobs:[job]},bridge:async(...args)=>{calls.push(args);return result;}};
  return {owner,other,admin,job,spec,service,calls,result};
}

test('diagnostics allows owner/admin, uses immutable server spec, and does not rewrite RUNNING from error evidence',async()=>{
  const f=fixture();
  for(const user of [f.owner,f.admin]){
    const out=await executionCall(f.service,{userId:user.id,role:user===f.admin?'admin':'member'},'jobs.diagnostics',{jobId:JOB});
    assert.deepEqual(out,f.result);assert.deepEqual(f.calls.at(-1),['gpu-1','diagnostics',{job:f.spec}]);assert.equal(f.job.state,'RUNNING');
  }
});

test('diagnostics rejects other owners, disabled/revoked users, raw paths and identity injections before bridge',async()=>{
  const f=fixture(),principal={userId:f.owner.id,role:'member'};
  await assert.rejects(executionCall(f.service,{userId:f.other.id,role:'member'},'jobs.diagnostics',{jobId:JOB}),e=>e.status===403);
  for(const extra of [{path:'/tmp'},{machine:'gpu-2'},{userId:f.other.id},{hostAdmin:true},{job:f.spec},{captureId:'b'.repeat(32)}])
    await assert.rejects(executionCall(f.service,principal,'jobs.diagnostics',{jobId:JOB,...extra}));
  f.owner.enabled=false;await assert.rejects(executionCall(f.service,principal,'jobs.diagnostics',{jobId:JOB}),e=>e.status===403);
  f.owner.enabled=true;f.owner.limits={};await assert.rejects(executionCall(f.service,principal,'jobs.diagnostics',{jobId:JOB}),e=>e.status===403);
  assert.equal(f.calls.length,0);
});

test('diagnostics preserves unavailable/partial results and bridge failure without launching or canceling',async()=>{
  const f=fixture(),principal={userId:f.owner.id,role:'member'};
  for(const state of ['UNAVAILABLE','PARTIAL','CAPTURING','COMPLETE']){
    f.result.state=state;assert.equal((await executionCall(f.service,principal,'jobs.diagnostics',{jobId:JOB})).state,state);
  }
  f.service.bridge=async()=>{throw Error('offline');};await assert.rejects(executionCall(f.service,principal,'jobs.diagnostics',{jobId:JOB}),/offline/);
  assert.equal(f.job.state,'RUNNING');assert.ok(f.calls.every(c=>c[1]==='diagnostics'));
});

async function cliFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-diagnostics-cli-')),session=join(dir,'session'),calls=[];
  const result={jobId:JOB,schedulerState:'RUNNING',state:'PARTIAL',workerErrorEvidence:true,captures:[]};
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);calls.push(data);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data.operation==='state'?{state:{demo:false,gpuqConnected:true,machines:[{id:'gpu-1'}],users:[],jobs:[]}}:{result}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  await writeFile(session,JSON.stringify({url,token:'fixture',machine:'gpu-1',principal:{userId:'demo-user-1',role:'member'}}),{mode:0o600});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {calls,result,cli:(args)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',session,'--json',...args]);
    let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();
  })};
}

test('CLI diagnostics returns a structured persistent bundle without polling or resubmission',async t=>{
  const f=await cliFixture(t),out=await f.cli(['diagnostics',JOB]);
  assert.equal(out.code,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout).data,f.result);
  assert.deepEqual(f.calls.filter(c=>c.operation!=='state'),[{operation:'jobs.diagnostics',args:{jobId:JOB}}]);
});

test('CLI diagnostics help and invalid/path/execution options are strict',async t=>{
  const f=await cliFixture(t);assert.match((await f.cli(['--help'])).stdout,/diagnostics JOB/);
  for(const args of [['diagnostics'],['diagnostics',JOB,'extra'],['diagnostics',JOB,'--machine','gpu-1'],['diagnostics',JOB,'--root'],['diagnostics',JOB,'--','id'],['diagnostics',JOB,'--project','fixture'],['diagnostics',JOB,'--key',JOB]]){
    const out=await f.cli(args);assert.equal(out.code,1,JSON.stringify(args));
  }
  assert.equal(f.calls.filter(c=>c.operation==='jobs.diagnostics').length,0);
});

test('portal serves diagnostic module and stylesheet through the explicit static allowlist',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-diagnostic-assets-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Diagnostic-Fixture-Password-2026!'}));
  const reservation=createServer();
  await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
  const port=reservation.address().port,origin='http://127.0.0.1:'+port;
  await new Promise(resolve=>reservation.close(resolve));
  const {server}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  for(const [path,pattern] of [['/job-diagnostics-ui.js',/createJobDiagnostics/],['/job-diagnostics.css',/diagnostic-history/]]){
    const response=await fetch(origin+path);assert.equal(response.status,200);assert.match(await response.text(),pattern);
  }
});
