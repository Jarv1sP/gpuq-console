// Disposable Portal + actual HTTP admission; no production account, node or GPU.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {openSubmit} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
const dir=await mkdtemp(join(tmpdir(),'gpuq-submit-errors-')),password='Submit-Errors-Fixture-Only-2026!',machine=MACHINES[0].id;
const shots=process.env.SUBMIT_ERROR_SHOTS||'/tmp/gpuq-submit-errors-ui';
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
let server,service,browser;const errors=[],outside=[],submissions=[];
try{
  const bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const snapshot=stale=>writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date(Date.now()-(stale?180000:0)).toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,processesAvailable:true,processes:[]})),gpuq:{connected:true,observeOnly:false,jobs:[],schedulableIndices:[0,1],capabilities:[]}}))}));
  await snapshot(false);({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath,origin,secure:false,bridge:async(_,operation)=>{if(operation==='projects.list')return {projects:[]};throw Error('Unexpected fixture '+operation);}}));
  clearInterval(service.executionTimer);service.reconcile=async()=>{};await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'submit-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[machine]:2}});
  await mkdir(shots,{recursive:true});browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const role of ['admin','member']){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();let mode;
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',guardedRoute(async route=>{const request=route.request();if(new URL(request.url()).origin!==origin){outside.push(request.url());return route.abort();}if(request.url()!==origin+'/api/call'||request.postDataJSON()?.operation!=='jobs.submit')return route.fallback();
      submissions.push(structuredClone(request.postDataJSON().args));
      if(typeof mode==='number')return route.fulfill({status:mode,contentType:'text/html',body:'<html>Private proxy error</html>'});
      if(mode==='maintenance')await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:true,revision:service.operationalMaintenance(admin.principal).revision,reason:'维修 <img src=x onerror=alert(1)>'});
      if(mode==='stale')await snapshot(true);
      if(mode==='lost'){await route.fetch();return route.abort('connectionreset');}
      return route.fallback();
    }));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(role==='admin'?'admin':'submit-member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    await page.locator('[name=workspace-machine]').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('#train-form [type=submit]').disabled);await openSubmit(page);
    const command='python retained_draft.py',name='拒绝回执 <img src=x onerror=alert(1)>';await page.locator('[name=command]').fill(command);await page.locator('[name=name]').fill(name);
    const submit=()=>page.locator('#train-form [type=submit]').click(),summary=page.locator('#submit-summary');
    for(const status of [502,503,504]){mode=status;const count=submissions.length;await submit();await page.locator('#submit-receipt-actions').getByText('服务暂时不可用，稍后重试',{exact:true}).waitFor();assert.equal(await summary.innerText(),'提交结果待确认');assert.equal(submissions.length,count+1);assert.equal(await page.locator('[data-receipt-retry]').count(),1);assert.doesNotMatch(await page.locator('#submission-receipt').textContent(),/SyntaxError|Unexpected token|Private proxy/);}
    const gatewayKey=submissions.at(-1).key,count=submissions.length;await page.locator('[data-receipt-retry]').click();await page.waitForFunction(count=>document.querySelector('#train-form [type=submit]').disabled===false,count);assert.equal(submissions.length,count+1);assert.equal(submissions.at(-1).key,gatewayKey);
    for(const refusal of ['maintenance','stale']){await page.locator('[name=name]').fill(name+' '+refusal);mode=refusal;const count=submissions.length,before=service.store.jobs.length;const response=page.waitForResponse(r=>r.request().postDataJSON()?.operation==='jobs.submit');await submit();const result=await response;assert.equal(result.status(),503);const body=await result.json();assert.equal(body.code,refusal==='maintenance'?'MAINTENANCE_ACTIVE':'SUBMISSION_REJECTED');await page.waitForFunction(()=>document.querySelector('#submit-summary').textContent==='未提交');assert.equal(await page.locator('#submission-receipt strong').innerText(),'未提交');assert.equal(await page.locator('[data-receipt-retry],#submission-retry,[data-receipt-refresh],#submission-refresh').count(),0);assert.equal(submissions.length,count+1);assert.equal(service.store.jobs.length,before);assert.equal(await page.locator('[name=command]').inputValue(),command);assert.equal(await page.locator('[name=name]').inputValue(),name+' '+refusal);assert.equal(await page.locator('#submission-receipt img,#submit-receipt-actions img').count(),0);
      if(refusal==='maintenance'){for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,role+'-rejected-'+width+'.png')});}await page.setViewportSize({width:1440,height:1000});await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:false,revision:service.operationalMaintenance(admin.principal).revision});}
      await snapshot(false);
    }
    mode='lost';const before=service.store.jobs.length;await submit();await page.waitForFunction(()=>document.querySelector('#submit-summary').textContent==='提交结果待确认');assert.equal(service.store.jobs.length,before+1);const job=structuredClone(service.store.jobs.at(-1));mode='maintenance';await page.locator('[data-receipt-retry]').click();await page.locator('#submit-receipt-actions').getByText(/维修/).waitFor();assert.equal(await summary.innerText(),'提交结果待确认','refused retry cannot erase an earlier ambiguous submission');assert.equal(service.store.jobs.length,before+1);await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:false,revision:service.operationalMaintenance(admin.principal).revision});mode='accepted';await page.locator('[data-receipt-retry]').click();await page.waitForFunction(()=>document.querySelector('#submission-receipt strong').textContent==='已提交');assert.equal(service.store.jobs.length,before+1);assert.equal(service.store.jobs.at(-1).id,job.id);assert.equal(submissions.at(-1).key,job.key);
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log('SUBMISSION ERRORS PASS: admin/member non-JSON 502/503/504, actual maintenance and stale 503 refusal, retained draft, no automatic replay, lost receipt same-key recovery, 1440/390.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));else service?.close();await rm(dir,{recursive:true,force:true});}
