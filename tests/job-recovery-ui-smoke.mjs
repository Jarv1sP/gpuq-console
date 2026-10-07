// Real disposable Portal/API and UI; only the node observation is synthetic.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
const dir=await mkdtemp(join(tmpdir(),'gpuq-job-recovery-')),password='Recovery-Browser-Fixture-Only-2026!',machine=MACHINES[0].id,shots=process.env.JOB_RECOVERY_SHOTS||'/tmp/gpuq-job-recovery-ui';
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
let server,service,browser,gate,releaseGate,unknown=false,running=false,lose=false;const released=new Set(),calls=[],errors=[],outside=[];
try{
  const bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  const observation=job=>({protocol:'native-observation-v1',status:unknown?'UNKNOWN':'CONFIRMED',jobId:job.id,userId:job.userId,nodeJobId:'J0123456789ab',submitKey:job.id,specVerified:true,state:running?'RUNNING':'SUCCEEDED',nativeVersion:9,observedAt:400,latestRetry:{eventId:12,createdAt:200},latestAttempt:{id:'A'+'a'.repeat(32),ordinal:2,state:running?'RUNNING':'EXITED_SUCCESS',exit_code:running?null:0,failure_reason:null,started_at:250,finished_at:running?null:300},progress:null});
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath,origin,secure:false,bridge:async(_,operation,args)=>{
    calls.push({operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects:[]};if(operation==='logs')return {text:'Local fixture: old failure and later native retry.'};
    if(operation==='watch'){if(gate){const pending=gate;gate=null;await pending;}return {nodeJobId:'J0123456789ab',state:released.has(args.job.id)&&!running?'SUCCEEDED':'UNKNOWN',assignedIndices:[],nativeObservation:observation(args.job)};}
    if(operation==='storage.lease.cancel'){released.add(args.job.id);return {released:true,jobId:args.job.id,state:'CANCELED',reconciledNative:args.expectedNative};}
    throw Error('Unexpected node operation '+operation);
  }}));clearInterval(service.executionTimer);service.reconcile=async()=>{};await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'recovery-member',password})).result;await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[machine]:1}});
  const jobs=[admin.principal.userId,member.id].map(userId=>{const id=randomUUID();return {id,userId,machine,nodeJobId:'J0123456789ab',name:'历史失败 · 服务器重试',cards:1,state:'FAILED',key:id,cancelRequested:false,createdAt:new Date().toISOString(),assignedIndices:[],spec:{id,userId,machine,cards:1,argv:['python','train.py']},latestAttempt:{id:'Aold',ordinal:1,state:'EXITED_FAILURE',exitCode:125,startedAt:50,finishedAt:100}};});service.store.jobs.push(...jobs);service.save();const original=structuredClone(jobs);
  await mkdir(shots,{recursive:true});browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const [index,role] of ['admin','member'].entries()){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),job=jobs[index];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',guardedRoute(async route=>{if(new URL(route.request().url()).origin!==origin){outside.push(route.request().url());return route.abort();}if(lose&&route.request().url()===origin+'/api/call'&&route.request().postDataJSON()?.operation==='jobs.reconcile-resources'){lose=false;await route.fetch();return route.abort('connectionreset');}return route.fallback();}));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(role==='admin'?'admin':'recovery-member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    const open=async id=>{await page.evaluate(id=>document.dispatchEvent(new CustomEvent('gpuq-open-job',{detail:{id}})),id);await page.locator('#job-recovery').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-job-observe]').disabled);};
    await open(job.id);assert.match(await page.locator('[data-native-observation]').innerText(),/已观察到服务器重试 · 成功/);assert.match(await page.locator('#job-overview-view').innerText(),/失败/);assert.equal(jobs[index].state,'FAILED');
    await page.locator('[data-job-completion-check]').click();await page.locator('[data-job-completion]').filter({hasText:'完成待确认'}).waitFor();assert.equal(released.size,index);
    const cancel=async dialog=>dialog.dismiss();page.on('dialog',cancel);const before=calls.filter(c=>c.operation==='storage.lease.cancel').length;await page.locator('[data-job-release-resources]').click();page.off('dialog',cancel);assert.equal(calls.filter(c=>c.operation==='storage.lease.cancel').length,before,'dismissed confirmation never sends release');
    page.once('dialog',dialog=>dialog.accept());lose=true;await page.locator('[data-job-release-resources]').click();await page.locator('#job-recovery .form-error').filter({hasText:'释放结果待确认'}).waitFor();assert.equal(calls.filter(c=>c.operation==='storage.lease.cancel').length,before+1);assert.equal(await page.locator('[data-resources-released]').count(),0,'lost reply never declares release');
    await page.locator('[data-job-completion-check]').click();await page.locator('[data-job-completion]').filter({hasText:'已核验完成'}).waitFor();assert.equal(calls.filter(c=>c.operation==='storage.lease.cancel').length,before+1,'recovery only queries completion, no automatic mutation');
    page.once('dialog',dialog=>dialog.accept());await page.locator('[data-job-release-resources]').click();await page.locator('[data-resources-released]').waitFor();assert.match(await page.locator('[data-job-completion]').innerText(),/已核验完成/);
    for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#job-recovery').evaluate(el=>el.closest('.sheet-scroll').scrollTop=0);await page.screenshot({path:join(shots,role+'-'+width+'.png')});}
    running=true;await page.locator('[data-job-observe]').click();await page.locator('[data-native-observation]').filter({hasText:'运行中'}).waitFor();assert.equal(await page.locator('[data-job-release-resources]').isDisabled(),true);running=false;unknown=true;await page.locator('[data-job-observe]').click();await page.locator('[data-native-observation]').filter({hasText:'待确认'}).waitFor();assert.equal(await page.locator('[data-job-release-resources]').isDisabled(),true);unknown=false;
    gate=new Promise(r=>releaseGate=r);const watch=page.waitForRequest(r=>r.postDataJSON()?.operation==='jobs.watch');await page.locator('[data-job-observe]').click();await watch;await page.locator('#close-job-log').click();releaseGate();releaseGate=null;await page.locator('.job-log-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#job-overview-view').textContent(),'','late observation stays retired');
    if(role==='member'){const foreign=await page.evaluate(async jobId=>(await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'jobs.completion',args:{jobId}})})).status,jobs[0].id);assert.equal(foreign,403);}
    await context.close();
  }
  assert.deepEqual(jobs,original,'observations and lease reconciliation preserve history and quotas');assert.equal(calls.some(c=>['submit','cancel','sync'].includes(c.operation)),false);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log('JOB RECOVERY PASS: native retry separate from failed history, unconfirmed/completed proof, confirmed explicit lease release, lost reply query-only, running/unknown refusal, owner boundary and retired responses, admin/member 1440/390.');
}finally{releaseGate?.();await browser?.close();if(server)await new Promise(r=>server.close(r));else service?.close();await rm(dir,{recursive:true,force:true});}
