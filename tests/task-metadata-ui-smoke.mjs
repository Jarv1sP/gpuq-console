// Actual Portal/SQLite/cookies/browser with synthetic GPU/cgroup data and mock
// execution. No production SSH, root commands, CUDA jobs or training logs.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const dir=await mkdtemp(join(tmpdir(),'gpuq-task-metadata-browser-')),password='Metadata-Browser-Fixture-2026!';
let server,service,browser;const errors=[],external=[],calls=[];
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
try{
  const bootstrap=join(dir,'bootstrap'),status=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  let native=[];
  const snapshot=()=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,model:m.model,memoryTotalMiB:32768,memoryUsedMiB:index<2?100:0,utilization:0,processesAvailable:true,
      processes:native.length&&index<2?[{pid:100+index,name:'python',owner:'private-os-user',memoryUsedMiB:100,scheduling:{jobId:native[0].id,priority:2}}]:[]})),gpuq:{connected:true,jobs:m.id==='gpu-1'?native:[]}}))}));
  await snapshot();({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge:async(machine,op,args)=>{
    calls.push({machine,op,args});if(op==='projects.list')return {projects:[]};if(op==='sync')return {state:'RUNNING',nodeJobId:'J'+args.job.id,assignedIndices:[0,1]};throw Error('Unexpected mock operation '+op);
  }}));clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password);
  for(const username of ['metadata-owner','metadata-observer']){const u=(await service.invoke(admin.token,'users.create',{username,password})).result;await service.invoke(admin.token,'policy.save',{userId:u.id,policyVersion:0,total:2,limits:{'gpu-1':2}});}
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const owner=await browser.newPage({viewport:{width:1440,height:1000}}),observer=await browser.newPage({viewport:{width:1440,height:1000}});
  for(const page of [owner,observer]){page.on('pageerror',e=>errors.push(e.message));await page.context().route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});}
  async function login(page,username){await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});}
  await login(owner,'metadata-owner');await owner.locator('#edit-profile').click();await owner.locator('#profile-form [name=profile-name]').fill('张三');await owner.locator('#profile-form [type=submit]').click();await owner.locator('#profile-dialog').waitFor({state:'hidden'});assert.equal(await owner.locator('#profile-name').textContent(),'张三');
  await owner.locator('[name=workspace-machine]').selectOption('gpu-1');await owner.waitForFunction(()=>!document.querySelector('#train-form [type=submit]').disabled);
  await owner.locator('details.execution-panel').filter({has:owner.locator('#train-form')}).locator(':scope > summary').click();
  const name='多卡 baseline <img src=x onerror=alert(1)>',description='验证新数据集\n预计两小时；<script>not executed</script>';
  await owner.locator('#train-form [name=name]').fill(name);await owner.locator('#train-form [name=task-description]').fill(description);await owner.locator('#train-form [name=cards]').fill('2');await owner.locator('#train-form [name=command]').fill('python train.py --token PRIVATE-BROWSER-ARGV');
  const submitted=owner.waitForResponse(r=>r.request().postDataJSON()?.operation==='jobs.submit');await owner.locator('#train-form [type=submit]').click();assert.equal((await submitted).status(),200);
  await new Promise(r=>setImmediate(r));while(service.reconciling)await new Promise(r=>setTimeout(r,5));const job=service.store.jobs[0];assert.equal(job.description,description);assert.equal(job.submitterName,'张三');
  native=[{id:job.nodeJobId,name:'portal-wrapper',owner:'native-wrapper-owner',state:'RUNNING',priority:2,gpu_count:2,assigned_gpu_indices:[0,1]}];await snapshot();
  await login(observer,'metadata-observer');await observer.locator('[data-nav=resources]').click();
  const card=observer.locator('[data-resource-machine="gpu-1"]'),queue=card.locator('.node-queue');await queue.locator('summary').click();
  const text=await queue.textContent();for(const wanted of [name,description.split('\n')[0],'张三','metadata-owner','0, 1'])assert.ok(text.includes(wanted),wanted);
  for(const hidden of ['PRIVATE-BROWSER-ARGV','native-wrapper-owner','private-os-user'])assert.ok(!text.includes(hidden),hidden);
  assert.equal(await queue.locator('[data-job-cancel],[data-job-logs]').count(),0);assert.equal(await queue.locator('img,script').count(),0);
  for(const index of [0,1]){const detail=card.locator(`[data-resource-detail="gpu-1:${index}"]`);await detail.locator('summary').click();assert.ok((await detail.textContent()).includes('张三'));assert.ok((await detail.textContent()).includes(description.split('\n')[0]));}
  // Refresh keeps expanded rows and the submitter's own unsent description.
  await observer.locator('#refresh-state').click();await observer.waitForFunction(()=>document.querySelector('[data-resource-detail="gpu-1:0"]').open);
  await owner.locator('#train-form [name=task-description]').fill('未提交的描述草稿');await owner.locator('#refresh-state').click();assert.equal(await owner.locator('#train-form [name=task-description]').inputValue(),'未提交的描述草稿');
  await observer.setViewportSize({width:390,height:844});assert.ok(await observer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'metadata overview must not overflow mobile viewport');
  await mkdir('/tmp/gpuq-task-metadata-ui',{recursive:true});await observer.screenshot({path:'/tmp/gpuq-task-metadata-ui/observer-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('TASK METADATA UI PASS: profile, two-GPU submission, other-member queue/process metadata, escaped multiline description, private-command exclusion, draft/panel retention and 390px layout.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));else service?.close();await rm(dir,{recursive:true,force:true});}
