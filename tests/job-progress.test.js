import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProgress,progressText,progressPercent,feedbackKey} from '../dist/job-progress.js';
import {jobProgressHTML} from '../dist/job-progress-ui.js';
import {watchJob} from '../job-watch.mjs';
import {executionCall,schedulerResult} from '../execution.mjs';
import {standaloneClient} from '../client-bundle.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';

const JOB='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const report=(extra={})=>({reported:true,stale:false,heartbeat_age_seconds:1,progress_age_seconds:2,snapshot:{sequence:1,phase:'train',epochs_completed:1,epochs_total:10,steps_completed:null,steps_total:null,metrics:{loss:0.1},eta_seconds:65,severity:'info',message:null,updated_at:1,...extra}});
const fixture=()=>{
  const users=[{id:'demo-user-1',enabled:true,limits:{'gpu-1':1}},{id:'demo-user-2',enabled:true,limits:{'gpu-1':1}}];
  const spec={id:JOB,argv:['python','train.py']},job={id:JOB,userId:users[0].id,machine:'gpu-1',state:'RUNNING',name:'progress',spec};
  const calls=[],service={store:{get:id=>users.find(u=>u.id===id),jobs:[job]},save(){},bridge:async(...args)=>{calls.push(args);return {state:'RUNNING',nodeJobId:'Jabc',progress:report()};}};
  return {users,job,spec,calls,service,principal:{userId:users[0].id,role:'member'}};
};

test('bounded progress projection discards identity/unknown fields and validates metrics and counters',()=>{
  const normalized=normalizeProgress({...report(),hostPath:'/private',snapshot:{...report().snapshot,job_id:'private',attempt_id:'private'}});
  assert.equal(progressPercent(normalized),10);assert.match(progressText(normalized),/轮次 1\/10.*10%.*2 分钟/);
  assert.doesNotMatch(JSON.stringify(normalized),/private|job_id|attempt_id|hostPath/);
  for(const extra of [{epochs_completed:11},{steps_completed:1},{epochs_total:0},{metrics:{loss:Infinity}},{metrics:Object.fromEntries(Array.from({length:33},(_,i)=>['m'+i,0]))},{metrics:{'<script>':1}},{sequence:Number.MAX_SAFE_INTEGER+1},{severity:'done'}])assert.equal(normalizeProgress(report(extra)).reported,false);
  assert.equal(progressPercent(null),null);assert.equal(normalizeProgress(null),null);
});

test('training progress error and 100 percent never promote RUNNING to FAILED or SUCCEEDED',()=>{
  const f=fixture();schedulerResult(f.job,{state:'RUNNING',progress:report({epochs_completed:10,severity:'error',message:'CUDA error'})});
  assert.equal(f.job.state,'RUNNING');assert.equal(progressPercent(f.job.progress),100);assert.match(progressText(f.job.progress),/异常.*CUDA error/);
  const key=feedbackKey(f.job);f.job.checkedAt='later';f.job.progress.heartbeatAgeSeconds=25;assert.equal(feedbackKey(f.job),key);
  schedulerResult(f.job,{state:'LOST'});assert.equal(f.job.state,'UNKNOWN');assert.equal(f.job.progress,null);
});

test('watch authorization uses immutable spec and cannot inspect another owner or inject paths',async()=>{
  const f=fixture();const out=await executionCall(f.service,f.principal,'jobs.watch',{jobId:JOB});assert.equal(out.progress.snapshot.epochsCompleted,1);
  assert.deepEqual(f.calls,[['gpu-1','watch',{job:f.spec}]]);
  await assert.rejects(executionCall(f.service,{userId:f.users[1].id,role:'member'},'jobs.watch',{jobId:JOB}),e=>e.status===403);
  await assert.rejects(executionCall(f.service,f.principal,'jobs.watch',{jobId:JOB,machine:'gpu-2'}));
  f.users[0].enabled=false;await assert.rejects(executionCall(f.service,f.principal,'jobs.watch',{jobId:JOB}),e=>e.status===403);
  assert.equal(f.calls.length,1);
});

test('watch before fleet admission and after bridge loss never admits or cancels a task',async()=>{
  const f=fixture();f.job.machine=null;f.job.state='WAITING_POOL';
  assert.equal((await executionCall(f.service,f.principal,'jobs.watch',{jobId:JOB})).state,'WAITING_POOL');assert.deepEqual(f.calls,[]);
  f.job.machine='gpu-1';f.job.state='RUNNING';f.service.bridge=async()=>{throw Error('offline /secret');};
  const out=await executionCall(f.service,f.principal,'jobs.watch',{jobId:JOB});assert.equal(out.state,'UNKNOWN');assert.equal(f.job.state,'RUNNING');assert.doesNotMatch(out.error,/secret/);
});

test('read-only missing node receipt preserves pending reservation and terminal read uses durable result',async()=>{
  const f=fixture();f.job.state='PENDING';f.service.bridge=async()=>({state:'PENDING',nodeJobId:null});
  assert.equal((await executionCall(f.service,f.principal,'jobs.watch',{jobId:JOB})).state,'PENDING');assert.equal(f.job.nodeJobId,undefined);
  f.job.state='SUCCEEDED';assert.equal((await executionCall(f.service,f.principal,'jobs.watch',{jobId:JOB})).state,'SUCCEEDED');assert.equal(f.calls.length,0);
});

test('watch stops at confirmed terminal or UNKNOWN; JSON stream reports changes without control calls',async()=>{
  for(const [state,exit] of [['SUCCEEDED',0],['FAILED',1],['CANCELED',130],['UNKNOWN',3]]){
    const calls=[],chunks=[];const job={id:JOB,state};
    assert.equal(await watchJob(async(operation,args)=>{calls.push({operation,args});return {result:job};},JOB,{json:true,write:c=>chunks.push(c)}),exit);
    assert.deepEqual(calls,[{operation:'jobs.watch',args:{jobId:JOB}}]);assert.equal(JSON.parse(chunks[0]).state,state);
  }
  await assert.rejects(watchJob(async()=>{throw Error('offline');},JOB),/重新连接/);
  const controller=new AbortController();controller.abort();assert.equal(await watchJob(()=>assert.fail(),JOB,{signal:controller.signal}),130);
});

test('watch suppresses unchanged snapshots and Ctrl+C only detaches the viewer',async()=>{
  const controller=new AbortController(),chunks=[];let calls=0;
  const exit=await watchJob(async(operation)=>{assert.equal(operation,'jobs.watch');calls++;if(calls===2)controller.abort();return {result:{id:JOB,state:'RUNNING',progress:normalizeProgress(report()),checkedAt:calls}};},JOB,{interval:1,signal:controller.signal,write:c=>chunks.push(c)});
  assert.equal(exit,130);assert.equal(calls,2);assert.equal(chunks.length,1);
});

test('progress table escapes report text, shows stale warning and preserves advisory label',()=>{
  const f=fixture();f.job.progress=normalizeProgress({...report({phase:'<script>',severity:'error',message:'<img onerror=x>'}),stale:true});
  const html=jobProgressHTML(f.job);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/停滞/);assert.match(html,/服务器确认/);assert.match(html,/value="10"/);
});

test('downloaded client is one file, isolated module namespaces, and supports installed symlink entry',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-progress-client-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=await standaloneClient('https://gpu.example.com');assert.doesNotMatch(source,/^import .*from '\.\//m);
  const file=join(dir,'gpuctl.mjs');await writeFile(file,source);
  const out=spawnSync(process.execPath,[file,'--help'],{encoding:'utf8'});assert.equal(out.status,0,out.stderr);assert.match(out.stdout,/watch JOB/);
});

test('installed CLI shows training error before final failure, with no submission or cancellation calls',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-progress-cli-')),calls=[];let polls=0;
  const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const request=JSON.parse(raw);calls.push(request);res.setHeader('Content-Type','application/json');
    if(request.operation==='state')return res.end(JSON.stringify({state:{machines:[],jobs:[],users:[]}}));
    polls++;res.end(JSON.stringify({result:{id:JOB,name:'test',username:'alice',state:polls===1?'RUNNING':'FAILED',progress:normalizeProgress(report({severity:'error',message:'synthetic train failure'})),latestAttempt:{exitCode:polls===1?null:1}}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const session=join(dir,'session'),file=join(dir,'gpuctl.mjs');
  await writeFile(file,await standaloneClient());await writeFile(session,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'synthetic',principal:{role:'member',userId:'alice'}}));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const run=args=>new Promise(resolve=>{const p=spawn(process.execPath,[file,'--session-file',session,...args]);let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('close',code=>resolve({code,out,err}));});
  const result=await run(['watch',JOB,'--interval','1']);assert.equal(result.code,1,result.err);assert.match(result.out,/RUNNING/);assert.match(result.out,/异常.*synthetic train failure/);assert.match(result.out,/FAILED.*退出码 1/s);
  assert.deepEqual(calls.filter(c=>c.operation!=='state'),[{operation:'jobs.watch',args:{jobId:JOB}},{operation:'jobs.watch',args:{jobId:JOB}}]);
  const before=calls.length;for(const args of [['watch',JOB,'--interval','0'],['watch',JOB,'--key',JOB],['watch',JOB,'--','cancel']])assert.equal((await run(args)).code,1);
  assert.equal(calls.length,before);
});
