// Real browser/HTTP/SQLite admission; node/copy/GPU are isolated fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {advanceDataPreparation} from '../dataset-preparation.mjs';
import {usage} from '../execution.mjs';
import {openSubmit} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';

const dir=await mkdtemp(join(tmpdir(),'gpuq-auto-browser-')),password='Auto-Browser-Fixture-Only-2026!';
const source=MACHINES[0].id,target=MACHINES[1].id,release='a'.repeat(64),image='sha256:'+'b'.repeat(64);
const projects=[{project:'vision',environmentMode:'oci',state:'READY',releases:[{release,state:'READY'}],latestReadyRelease:release},
  {project:'legacy',environmentMode:'shared',state:'READY',releases:[{release,state:'READY'}],latestReadyRelease:release}];
const calls=[],requests=[],errors=[],outside=[];let server,service,browser,member;
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port;
try{
  const bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,processes:[],processesAvailable:true})),
    gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:m.id===target?[0,1]:[],jobs:[],capabilities:[]}}))}));
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects};
    if(operation==='projects.status')return projects.find(p=>p.project===args.project);
    if(operation==='projects.verify')return {project:args.project,release:args.release,state:'READY'};
    throw Error('Unexpected fixture operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath,bridge,secure:false,origin}));
  clearInterval(service.executionTimer);service.reconcile=async()=>{};service.ociProjectAdmission=async()=>{};
  service.projectCopyProbe=async(owner,machine,ref)=>{
    assert.equal(owner,member.id);
    if(ref.release&&machine!==source)throw Error('fixture release absent');
    return {protocol:'portable-project-v1',enabled:true,environmentMode:'oci',architecture:'amd64',project:ref.project,
      releaseReady:!!ref.release,...(ref.release?{release:ref.release,image}:{}),sources:[source]};
  };
  let copied=0;
  service.prepareProject=async(owner,machine,ref)=>{
    assert.ok(service.store.jobs.some(j=>j.userId===owner&&j.machine===machine&&j.release===ref.release&&j.state==='PREPARING_DATA'));
    copied++;return {...ref,machine,state:'READY'};
  };
  await new Promise(r=>server.listen(port,'127.0.0.1',r));const admin=await service.login('admin',password);
  member=(await service.invoke(admin.token,'users.create',{username:'auto-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[source]:2,[target]:2}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url()===origin+'/api/call')requests.push(r.postDataJSON());});
  await page.route('**/*',guardedRoute(async route=>{if(new URL(route.request().url()).origin!==origin){outside.push(route.request().url());return route.abort();}return route.fallback();}));
  await page.goto(origin);await page.locator('#login-form [name=username]').fill('auto-member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
  await page.locator('[name=workspace-machine]').selectOption(source);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await page.locator('[name=workspace-project]').selectOption('vision');await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await openSubmit(page);await page.locator('[name=training-target]').selectOption('auto');await page.locator('[name=training-candidates]').fill(source+','+target);
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),source);
  assert.equal(await page.locator('[name=workspace-project]').inputValue(),'vision');
  assert.match(await page.locator('#submit-command').textContent(),/--machine auto/);
  assert.match(await page.locator('#submit-command').textContent(),new RegExp('--release.*'+release));
  const submitResponse=page.waitForResponse(r=>r.url()===origin+'/api/call'&&r.request().postDataJSON()?.operation==='jobs.submit');
  await page.locator('#train-form [type=submit]').click();assert.equal((await submitResponse).status(),200);
  await page.waitForFunction(target=>document.querySelector('#submission-receipt').textContent.includes(target)&&document.querySelector('#submission-receipt').textContent.includes('已提交'),target);
  const job=service.store.jobs[0];assert.equal(job.machine,target);assert.equal(job.state,'PREPARING_DATA');assert.equal(job.project,'vision');assert.equal(job.release,release);
  assert.equal(usage(service.store.jobs,member.id),0);assert.equal(copied,0);
  assert.equal(requests.filter(r=>r.operation==='jobs.submit').length,1);
  await advanceDataPreparation(service,job,usage);assert.equal(job.state,'SUBMITTING');assert.equal(usage(service.store.jobs,member.id),1);assert.equal(copied,1);
  // Deliberately lose the second POST reply. Explicit retry must keep the key
  // and chosen machine even after the live free pool changes completely.
  await page.locator('[data-receipt-new-draft]').click();await page.locator('[name=name]').fill('second');
  let drop=true;const lost=guardedRoute(async route=>{if(route.request().postDataJSON()?.operation==='jobs.submit'&&drop){drop=false;await route.fetch();return route.abort('connectionreset');}return route.fallback();});
  await page.route(origin+'/api/call',lost);await page.locator('#train-form [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#submission-receipt').textContent.includes('提交结果待确认'));
  const second=structuredClone(service.store.jobs[1]);assert.equal(second.machine,target);assert.equal(service.store.jobs.length,2);
  service.projectCopyProbe=async()=>{throw Error('must not reselect an existing submission');};
  await page.unroute(origin+'/api/call',lost);await page.locator('[data-receipt-retry]').click();
  await page.waitForFunction(()=>document.querySelector('#submission-receipt').textContent.includes('已提交'));
  assert.equal(service.store.jobs.length,2);assert.equal(service.store.jobs[1].id,second.id);assert.equal(service.store.jobs[1].machine,second.machine);
  assert.equal(requests.filter(r=>r.operation==='jobs.submit').at(-1).args.key,second.key);
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),source);
  assert.equal(calls.some(c=>c.operation==='terminal.open'||c.operation==='sync'),false);
  await page.locator('#close-submit').click();await page.locator('[name=workspace-project]').selectOption('legacy');await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await openSubmit(page);assert.equal(await page.locator('[name=training-target] option[value=auto]').evaluate(el=>el.disabled),true,JSON.stringify(await page.evaluate(()=>({context:document.querySelector('[name=workspace-project]').value,environment:document.querySelector('#project-environment').textContent,note:document.querySelector('#training-target-note').textContent}))));
  await page.locator('[name=training-target]').selectOption('current');assert.equal(await page.locator('[name=machine]').inputValue(),source);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log(JSON.stringify({passed:true,automaticTarget:target,developmentContext:source,persistentSubmissions:2,duplicateSubmissions:0,realGpuJobs:0}));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));if(service&&!service.closing)service.close();await rm(dir,{recursive:true,force:true});}
