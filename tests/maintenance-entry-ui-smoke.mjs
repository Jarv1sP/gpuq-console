// Disposable Portal and simulated node snapshots only; no production login or writes.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {openSubmit,closeSubmit,refreshVisible} from './starbase-workflows.mjs';
import {openMaintenance} from './admin-maintenance-workflows.mjs';
const root=await mkdtemp(join(tmpdir(),'maintenance-entry-')),shots=join(process.env.UI_SCREENSHOTS||'/tmp/maintenance-entry','maintenance-entry');
const password='Maintenance-Entry-Simulated-2026!',machine=MACHINES[0].id,locked=MACHINES[1].id,release='a'.repeat(64),calls=[],requests=[],errors=[],outside=[];
const project={project:'maintenance-project',environmentMode:'oci',state:'READY',releases:[{release,state:'READY'}],latestReadyRelease:release};
let service,server,browser;const status=join(root,'status');
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
const snapshot=observeOnly=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:m.id===machine?observeOnly:false,health:'ok',jobs:[]}}))}));
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(root,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});await snapshot(true);
  const bridge=async(node,operation,args)=>{calls.push({machine:node,operation,args});if(operation==='projects.list')return {environmentModes:['oci'],projects:node===machine?[project]:[]};if(operation==='projects.status')return project;if(operation==='files.list')return {entries:[]};throw Error('Unexpected maintenance fixture node operation '+operation);};
  ({server,service}=await createPortalServer({database:join(root,'db'),bootstrap,statusPath:status,origin,secure:false,bridge}));clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'maintenance-member',password})).result;await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  const set=(scope,enabled,reason='模拟磁盘维修')=>service.invoke(admin.token,'maintenance.set',{scope,enabled,revision:service.operationalMaintenance(admin.principal).revision,...(enabled?{reason}:{})});
  for(const m of MACHINES.slice(1))await set(m.id,true);
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const [role,username] of [['member',member.username],['admin','admin']]){
    await snapshot(true);const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);await route.abort();return;}if(url.pathname==='/api/call')requests.push(route.request().postDataJSON());await route.continue();}));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    await page.locator('[name=workspace-project] option[data-project="maintenance-project"]').waitFor({state:'attached'});await page.locator('[name=workspace-project]').selectOption('maintenance-project');await page.waitForFunction(()=>!document.querySelector('#project-publish').disabled);
    assert.equal(await page.locator('#operational-maintenance .maintenance-banner').count(),0,'Another machine maintenance never locks this project');
    assert.doesNotMatch(await page.locator('.wb-empty').innerText(),/维护|暂停/,'Unrelated machine maintenance never adds a misleading empty-task restriction');
    assert.equal(await page.locator('#main-content [data-maintenance-settings],#main-content [data-maintenance-start],#main-content [data-recovery-apply]').count(),0,'Both roles have identical public maintenance entries');assert.equal(await page.locator('#maintenance-experience').isHidden(),true);
    const refresh=async()=>{const read=page.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='state');await refreshVisible(page);await (await read).finished();await page.waitForFunction(()=>document.querySelector('#sync-label').textContent!=='正在同步');};
    const shot=async name=>{for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1080});await page.evaluate(()=>document.fonts.ready);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,role+'-'+name+'-'+width+'.png'),animations:'disabled'});}};
    await shot('work');await page.setViewportSize({width:1440,height:1080});await openSubmit(page);assert.equal(await page.locator('#submit-summary').innerText(),'训练暂未开放');assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);await shot('observing');await closeSubmit(page);
    await snapshot(false);await refresh();await openSubmit(page);assert.doesNotMatch(await page.locator('#submit-summary').innerText(),/训练暂未开放/);assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),false,'Live active snapshot reopens scheduling without altering portal maintenance');await closeSubmit(page);
    await page.locator('#context-machine').selectOption(locked);await page.locator('#operational-maintenance .maintenance-banner').filter({hasText:locked+'维护中'}).waitFor();assert.doesNotMatch(await page.locator('#operational-maintenance').innerText(),new RegExp(MACHINES[2].id));assert.equal(await page.locator('#operational-maintenance [data-maintenance-resume]').count(),0);await shot('selected-maintenance');
    await page.setViewportSize({width:1440,height:1080});await page.locator('#context-machine').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('#operational-maintenance .maintenance-banner'));
    await set('all',true,'<模拟全平台维护>');await refresh();assert.match(await page.locator('#operational-maintenance').innerText(),/全平台维护中/);assert.equal(await page.locator('#operational-maintenance img').count(),0);await set('all',false);await refresh();
    const failState=guardedRoute(async route=>{if(route.request().postDataJSON()?.operation==='state'){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'simulated read unavailable'})});return;}await route.fallback();});await page.route(origin+'/api/call',failState);await refresh();await page.locator('#operational-maintenance').filter({hasText:'维护状态未确认'}).waitFor();assert.equal(await page.locator('#operational-maintenance [data-maintenance-resume]').count(),0);await page.unroute(origin+'/api/call',failState);await refresh();await page.waitForFunction(()=>!document.querySelector('#operational-maintenance .maintenance-banner'));
    if(role==='admin'){
      await openMaintenance(page);assert.equal(await page.locator('[data-maintenance-server]').count(),MACHINES.length);await shot('console');
      await page.locator('[data-maintenance-settings]').click();const form=page.locator('#maintenance-settings-dialog form');assert.equal(await form.locator('[name=scope] option[value=all]').count(),1);assert.equal(await form.locator('[name=scope] option').count(),MACHINES.length+1);await form.locator('[name=scope]').selectOption(machine);await form.locator('[name=reason]').fill('模拟新增原因');
      const old=Number(await form.getAttribute('data-revision'));await set(locked,true,'模拟另一窗口');const before=requests.filter(r=>r.operation==='maintenance.set').length;await form.locator('[type=submit]').click();await form.locator('[data-maintenance-error]').filter({hasText:'维护状态已由其他窗口修改，请刷新后确认'}).waitFor();const changes=requests.filter(r=>r.operation==='maintenance.set').slice(before);assert.deepEqual(changes.map(r=>r.args),[{scope:machine,enabled:true,reason:'模拟新增原因',revision:old}]);
      await page.locator('[data-maintenance-settings-close]').click();await page.evaluate(()=>location.hash='#work');await page.locator('#page-work').waitFor({state:'visible'});assert.equal(await page.locator('#main-content [data-maintenance-settings],#main-content [data-maintenance-start]').count(),0);
    }
    await context.close();
  }
  assert.ok(requests.every(r=>!['jobs.submit','terminal.open','files.put'].includes(r.operation)),'Viewing scheduling and maintenance issues no node writes');assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log('MAINTENANCE ENTRY PASS: simulated scope isolation, public parity, admin-only controls/CAS, read failure, live observe-to-active training, member/admin 1440/390; no node writes.');
}finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));if(service&&!service.closing){clearInterval(service.executionTimer);await service.close();}await rm(root,{recursive:true,force:true});}
