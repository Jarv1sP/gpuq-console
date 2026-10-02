// Real disposable Portal HTTP/asset graph, synthetic node only; no SSH/GPU jobs.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';

const dir=await mkdtemp(join(tmpdir(),'gpuq-elastic-browser-')),bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');
const machine=MACHINES[0].id,password='Elastic-Browser-Fixture-Only-2026!',calls=[],errors=[],httpErrors=[],outside=[];
let browser,server,service,capable=true,authenticated=false;
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const origin='http://127.0.0.1:'+port;
const snapshot=()=>writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,memoryUsedMiB:0,utilization:0,processes:[]})),gpuq:{connected:true,observeOnly:false,jobs:[],capabilities:['priority-policy-v1','preempt-idle-only-v1','console-yield-v1',...(capable?['console-elastic-v1']:[])]}}))}));
try{
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));await snapshot();
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args:structuredClone(args)});if(operation==='projects.list')return {projects:[]};if(operation==='sync')return {state:'RUNNING',nodeJobId:'Jsynthetic',assignedIndices:[0,1]};throw Error('Unexpected synthetic bridge operation: '+operation);};
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,statusPath,bridge}));clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'elastic-user',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:8,limits:{[machine]:8}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage({viewport:{width:1280,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{const path=new URL(r.url()).pathname;if(r.status()===401&&!authenticated&&path==='/api/call'&&r.request().postDataJSON()?.operation==='state')return;if(r.status()>=400)httpErrors.push({status:r.status(),path});});
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){outside.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(origin);await page.locator('#login-form [name=username]').fill('elastic-user');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});authenticated=true;
  await page.locator('[name=workspace-machine]').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await page.locator('#train-form').evaluate(form=>{form.closest('details').open=true;for(const el of form.querySelectorAll('details'))el.open=true;});
  await page.locator('[name=custom-policy]').check();await page.locator('[name=queue-rank]').selectOption('P1');await page.locator('[name=yield-policy]').selectOption('save');await page.locator('[name=restart-policy]').selectOption('on-preempt');await page.locator('[name=checkpointable]').check();
  await page.locator('[name=elastic]').check();await page.locator('[name=cards]').fill('8');await page.locator('[name=min-cards]').fill('1');await page.locator('[name=global-batch]').fill('256');await page.locator('[name=micro-batch]').fill('8');await page.locator('[name=auto-expand]').check();
  const submitted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/call'&&r.request().postDataJSON()?.operation==='jobs.submit');await page.locator('#train-form [type=submit]').click();assert.equal((await submitted).status(),200);
  await new Promise(resolve=>setImmediate(resolve));await service.reconcile();await page.locator('#refresh-state').click();await page.waitForFunction(()=>document.querySelector('#my-job-table').textContent.includes('当前 2 张'));
  const job=service.store.jobs[0];assert.deepEqual(job.elastic,{minCards:1,globalBatch:256,microBatch:8,autoExpand:true});assert.deepEqual(job.allowedGpuCounts,[1,2,4,8]);assert.equal(job.cards,8);assert.equal(job.actualCards,2);
  assert.deepEqual(calls.find(x=>x.operation==='sync').args.job.elastic,job.elastic);
  capable=false;await snapshot();await page.locator('#refresh-state').click();await page.waitForFunction(()=>document.querySelector('#elastic-note').textContent.includes('尚未确认'));
  assert.equal(await page.locator('[name=elastic]').isChecked(),true);assert.equal(await page.locator('[name=cards]').inputValue(),'8');assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);assert.deepEqual(outside,[]);
  console.log(JSON.stringify({status:'passed',checks:['real Portal served module graph','real cookie login/API submit','canonical elastic contract','max quota vs actual cards','capability loss retains draft','390px layout','no outside traffic']}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));else service?.close();await rm(dir,{recursive:true,force:true});}
