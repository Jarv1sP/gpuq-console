// Real Portal/CSP, disposable accounts and synthetic node receipts only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {inspectGeometry} from './layout-geometry.mjs';
import {openMaintenance} from './admin-maintenance-workflows.mjs';

const temporary=await mkdtemp(join(tmpdir(),'admin-maintenance-')),output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-admin-maintenance','admin-maintenance');
const password='Local-Maintenance-Admin-2026!',calls=[],errors=[],outside=[],geometry=[],commands=new Map(),status=join(temporary,'status.json');
const inventory=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):null;
if(inventory)assert.ok(inventory.length===MACHINES.length&&inventory.every((row,index)=>row.id===MACHINES[index].id),'private Node fixture loader and browser inventory must agree');
let server,service,browser,commandMode='SUCCEEDED',lost=false,forbidden=false;
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const snapshot=()=>({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(machine=>({id:machine.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:machine.cards},(_,index)=>({index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))});
const settle=page=>page.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
try{
  await mkdir(output,{recursive:true});const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});await writeFile(status,JSON.stringify(snapshot()));
  ({server,service}=await createPortalServer({database:join(temporary,'db'),bootstrap,statusPath:status,origin,secure:false,bridge:async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects:[]};
    if(operation==='datasets.list')return {datasets:[]};
    if(operation==='datasets.capacity'||operation==='transfers.capabilities'||operation==='datasets.upload.routes')return {available:false,enabled:false};
    if(operation==='host.exec'){
      assert.equal(args.hostAdmin,true);assert(args.userId);assert.equal(args.cwd,'/root');assert.equal(args.timeoutSec,60);
      assert([['nvidia-smi'],['df','-h','/data2']].some(argv=>JSON.stringify(argv)===JSON.stringify(args.argv)));
      const result={id:args.key,key:args.key,state:commandMode,exitCode:commandMode==='SUCCEEDED'?0:null,stdout:'GPU fixture\n<not HTML>',stderr:'',cancelRequested:false};commands.set(args.key,result);return result;
    }
    if(operation==='host.status'){assert.equal(args.hostAdmin,true);const result=commands.get(args.id);assert(result,'status must use a saved, original command handle');return result;}
    if(operation==='host.cancel'){assert.equal(args.hostAdmin,true);const result=commands.get(args.id);assert(result);result.state='CANCELED';result.cancelRequested=true;return result;}
    if(operation==='terminal.open')return {id:args.key,mode:'new',clientId:args.clientId,writerToken:randomUUID(),attachmentUntil:new Date(Date.now()+30000).toISOString(),hostAdmin:true};
    if(operation==='terminal.exchange'){
      const data=Buffer.from(forbidden&&args.offset===0?'FORBIDDEN: peer uid is not allowed; run native GPUQ as its service account':'');
      return {offset:args.offset+data.length,data:data.toString('base64'),exited:false};
    }
    if(operation==='terminal.detach'||operation==='terminal.close')return {closed:true};
    throw Error('Unexpected maintenance fixture operation '+operation);
  }}));
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);await service.refreshGPUQ();await new Promise(resolve=>server.listen(new URL(origin).port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'maintenance-member',name:'维护验收成员',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:true,revision:0,reason:'存储维护'});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function open(username){
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']}),page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{globalThis.maintenanceCSP=[];document.addEventListener('securitypolicyviolation',event=>maintenanceCSP.push(event.violatedDirective));});
    await context.route('**/*',guardedRoute(async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);return route.abort();}
      if(inventory&&url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(MACHINES)+';'});
      if(url.pathname==='/api/call'&&route.request().postDataJSON()?.operation==='host.exec'&&lost){lost=false;await route.fetch();return route.abort('failed');}
      await route.continue();
    }));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    return {context,page};
  }
  const {context,page}=await open('admin');
  assert.equal(await page.locator('#main-content .maintenance-settings,#page-work #host-maintenance,#maintenance-experience [data-maintenance-root]').count(),0);
  assert.equal(await page.locator('#maintenance-member-title').innerText(),'维护中');
  await openMaintenance(page);assert.equal(await page.locator('[data-maintenance-server]').count(),MACHINES.length);
  assert.equal(await page.locator('.maintenance-banner').count(),1,'the primary readonly banner is not duplicated inside admin settings');
  assert.equal(await page.locator('#admin-content #host-maintenance').count(),1);
  const target=MACHINES[0].id;await page.locator('[data-maintenance-host="'+target+'"]').click();
  assert.equal(await page.locator('[data-host-machine]').inputValue(),target);
  assert.equal(await page.locator('#maintenance-host-form input').isVisible(),false,'manual lookup is secondary');
  await page.locator('[data-host-preset=gpu]').click();assert.equal(calls.filter(row=>row.operation==='host.exec').length,0);
  assert.equal(await page.locator('#host-command-confirm pre').innerText(),'nvidia-smi');assert.equal(await page.locator('[data-host-confirm-machine] .server-id').getAttribute('title'),target);
  await page.setViewportSize({width:390,height:844});await settle(page);
  const confirmBounds=await page.locator('#host-command-confirm').boundingBox();assert(confirmBounds&&confirmBounds.x>=0&&confirmBounds.x+confirmBounds.width<=391,'literal command confirmation fits the phone');
  for(const button of await page.locator('#host-command-confirm button').all())assert.ok((await button.boundingBox()).height>=44,'confirmation actions keep a 44px phone target');
  await page.screenshot({path:join(output,'maintenance-diagnostic-confirm-390.png'),animations:'disabled'});await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-host-confirm-close]').click();assert.equal(calls.filter(row=>row.operation==='host.exec').length,0);
  await page.locator('[data-host-preset=gpu]').click();await page.locator('[data-host-confirm-apply]').click();await page.locator('[data-host-state]').filter({hasText:'已完成'}).waitFor();
  const first=calls.find(row=>row.operation==='host.exec');assert.equal(first.machine,target);
  const saved=await page.evaluate(({actor,target})=>JSON.parse(localStorage.getItem('stargate.host-commands.v1:'+actor+':'+target)),{actor:admin.principal.userId,target});assert.equal(saved[0].id,first.args.key);
  assert.equal(await page.locator('[data-host-receipt] img').count(),0);assert.equal(await page.locator('[data-host-receipt]').innerText(),'GPU fixture\n<not HTML>');
  await page.locator('[data-host-copy-output]').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'GPU fixture\n<not HTML>');
  await page.locator('[data-host-copy-id]').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),first.args.key);
  await page.waitForFunction(()=>{const toast=document.querySelector('#toast');return !toast||(!toast.classList.contains('visible')&&Number(getComputedStyle(toast).opacity)===0);});
  for(const width of [1440,1024,390,320]){
    await page.setViewportSize({width,height:width<760?844:1000});await settle(page);
    const result=await inspectGeometry(page,{roots:['#admin-content'],controls:'.button,input:not([type=checkbox]),select,summary',containment:'.button,input,select,.server-id,.host-command-result',buttonRows:[{parent:'.host-diagnostic-presets'},{parent:'.host-command-actions'}],helpContexts:['.host-diagnostics-heading .copy-caption']});
    geometry.push({width,...result});assert.deepEqual(result.failures,[],JSON.stringify({width,...result}));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});await settle(page);
    assert.equal(await page.locator('.skip-link').evaluate(el=>el.getBoundingClientRect().bottom<=0),true,'skip link is hidden without keyboard focus');
    await page.screenshot({path:join(output,'maintenance-admin-'+width+'.png'),fullPage:true,animations:'disabled'});
  }
  await page.setViewportSize({width:1440,height:1000});lost=true;await page.locator('[data-host-preset=disk]').click();assert.equal(await page.locator('#host-command-confirm pre').innerText(),'df -h /data2');await page.locator('[data-host-confirm-apply]').click();await page.locator('[data-host-state]').filter({hasText:'已完成'}).waitFor();
  const second=calls.filter(row=>row.operation==='host.exec').at(-1);assert.deepEqual(calls.filter(row=>row.operation==='host.status').at(-1).args.id,second.args.key);
  await page.reload();await page.locator('#admin-host-diagnostics').waitFor();await page.locator('[data-host-state]').filter({hasText:'已完成'}).waitFor();
  assert.equal(calls.filter(row=>row.operation==='host.exec').length,2,'reload and lost receipt do not replay exec');assert.equal(calls.filter(row=>row.operation==='host.status').at(-1).args.id,second.args.key);
  await page.locator('.host-recent summary').click();await page.locator('[data-host-recent="'+first.args.key+'"]').click();await page.locator('[data-host-state]').filter({hasText:'已完成'}).waitFor();assert.equal(calls.filter(row=>row.operation==='host.status').at(-1).args.id,first.args.key);
  commandMode='RUNNING';await page.locator('[data-host-preset=gpu]').click();await page.locator('[data-host-confirm-apply]').click();await page.locator('[data-host-state]').filter({hasText:'进行中'}).waitFor();
  const running=calls.filter(row=>row.operation==='host.exec').at(-1);await page.waitForFunction(()=>document.querySelectorAll('[data-host-recent]').length===3);await page.waitForTimeout(1700);
  assert(calls.some(row=>row.operation==='host.status'&&row.args.id===running.args.key),'running diagnostic is automatically polled');
  await page.locator('[data-host-cancel]').click();await page.locator('[data-host-confirm-apply]').click();await page.locator('[data-host-state]').filter({hasText:'已停止'}).waitFor();assert.equal(calls.filter(row=>row.operation==='host.cancel').length,1);assert.equal(calls.filter(row=>row.operation==='host.cancel')[0].args.id,running.args.key);
  await page.locator('.host-lookup summary').click();await page.locator('#maintenance-host-form input').fill(first.args.key);await page.locator('#maintenance-host-form [type=submit]').click();await page.locator('[data-host-state]').filter({hasText:'已完成'}).waitFor();assert.equal(calls.filter(row=>row.operation==='host.status').at(-1).args.id,first.args.key);
  const value=snapshot();value.hosts[0].hostCommand.available=false;await writeFile(status,JSON.stringify(value));await service.refreshGPUQ();await page.locator('[data-console-refresh]').click();await page.locator('[data-host-unavailable]').filter({hasText:'未开启'}).waitFor();
  for(const button of await page.locator('[data-host-preset]').all())assert.equal(await button.isDisabled(),true);
  assert.equal(await page.locator('#maintenance-host-form [type=submit]').isDisabled(),true);
  await writeFile(status,JSON.stringify(snapshot()));await service.refreshGPUQ();await page.locator('[data-console-refresh]').click();
  forbidden=true;page.on('dialog',dialog=>dialog.accept());await page.locator('[data-maintenance-root="'+target+'"]').click();await page.locator('#terminal-root-identity-note').filter({hasText:'ROOT 不能直接查询调度队列，请用平台任务视图'}).waitFor();
  assert.equal(await page.locator('#terminal-retry').isVisible(),false,'native RPC refusal does not mark a working ROOT terminal disconnected');
  await page.setViewportSize({width:390,height:844});await settle(page);assert.ok(await page.locator('#terminal-root-identity-note').isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(output,'maintenance-root-identity-390.png'),animations:'disabled'});await page.setViewportSize({width:1440,height:1000});await page.locator('#terminal-collapse').click();
  await page.locator('[data-host-preset=gpu]').click();const mutations=calls.filter(row=>row.operation==='host.exec').length;
  await page.evaluate(()=>{globalThis.retiredHostConfirm=document.querySelector('[data-host-confirm-apply]');location.hash='#work';});await page.locator('#page-work').waitFor();
  await page.evaluate(()=>retiredHostConfirm.click());await settle(page);assert.equal(calls.filter(row=>row.operation==='host.exec').length,mutations);
  assert.equal(await page.locator('#admin-host-diagnostics,#admin-maintenance-console,.host-terminal-dialog[open]').count(),0);assert.equal(await page.locator('#maintenance-root-parking #host-maintenance').count(),1);
  assert.deepEqual(await page.evaluate(()=>maintenanceCSP),[]);await context.close();
  const regular=await open(member.username),before=calls.length;
  assert.equal(await regular.page.locator('#maintenance-member-title').innerText(),'维护中');assert.equal(await regular.page.locator('.maintenance-settings,#host-maintenance').isVisible(),false);
  await regular.page.setViewportSize({width:390,height:844});await settle(regular.page);await regular.page.screenshot({path:join(output,'maintenance-member-primary-390.png'),fullPage:true});
  await regular.page.evaluate(()=>location.hash='#admin/maintenance');await regular.page.locator('#admin-denied').waitFor();
  assert.equal(await regular.page.locator('[data-host-preset],#admin-content #host-maintenance,.maintenance-settings').count(),0);
  assert.equal(calls.slice(before).filter(row=>/^host\.|^terminal\./.test(row.operation)).length,0);
  await regular.page.setViewportSize({width:390,height:844});await settle(regular.page);await regular.page.screenshot({path:join(output,'maintenance-member-390.png'),fullPage:true});
  assert.deepEqual(await regular.page.evaluate(()=>maintenanceCSP),[]);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  const secondAdmin=(await service.invoke(admin.token,'users.create',{username:'maintenance-second-admin',password})).result;
  await service.invoke(admin.token,'users.role',{userId:secondAdmin.id,role:'admin'});
  const isolated=await open(secondAdmin.username),beforeOther=calls.length;await openMaintenance(isolated.page);await isolated.page.locator('.host-recent summary').click();
  assert.equal(await isolated.page.locator('[data-host-recent]').count(),0,'another administrator never inherits the first account history');
  assert.equal(calls.slice(beforeOther).filter(row=>row.operation==='host.status'||row.operation==='host.exec').length,0);
  await writeFile(join(output,'checks.json'),JSON.stringify({status:'PASS',geometry,errors,outside,checks:['main readonly, backend order40','confirmed literal argv and machine','persist before dispatch, original key after lost receipt/reload','automatic status, one cancel','recent operations and manual fold','unavailable controls','native ROOT FORBIDDEN identity hint','retired context no writes','member hidden and zero privileged calls']},null,2));
  console.log('ADMIN MAINTENANCE PASS: readonly primary, complete backend/ROOT, fixed diagnostic confirmations, lost receipt/reload/key, polling/cancel/history, unavailable, identity hint, retired/member boundaries, four widths/CSP.');
}finally{
  if(browser)for(const context of browser.contexts())await context.unrouteAll({behavior:'ignoreErrors'});await browser?.close();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else service?.close();await rm(temporary,{recursive:true,force:true});
}
