import {accountMenu,refreshVisible} from './starbase-workflows.mjs';
// Real local Portal/SQLite/cookie/browser; no host, GPU or network mutations.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
import {seedLegacy,password} from './maintenance-fixture.mjs';

const dir=await mkdtemp(join(tmpdir(),'gpuq-retired-maintenance-browser-')),calls=[],errors=[],external=[],nodeSessions=new Map(),commandId=randomUUID();let server,service,browser;
const screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-maintenance-ui';
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
try{
  const bootstrap=join(dir,'bootstrap'),status=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge:async(machine,operation,args)=>{
    calls.push({machine,operation,args});
    if(operation==='projects.list')return {projects:[]};
    if(operation==='datasets.list')return {datasets:[]};
    if(operation==='datasets.upload.routes'){assert.deepEqual(args,{userId:args.userId,hostAdmin:false});assert.ok(['builtin-admin','demo-user-1'].includes(args.userId));return {available:false,protocol:'dataset-upload-v1',reason:'not-configured',relayLimitBytes:256*1024**2};}
    if(operation==='transfers.capabilities')return {protocol:'lan-transfer-v1',enabled:true,sourceReady:true,sources:MACHINES.map(machine=>machine.id).filter(id=>id!==machine)};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:0,usableBytes:512*1024**3,totalInodes:100000,availableInodes:50000,inodeUsageKnown:true,guarded:true};
    if(operation==='terminal.open'){const result={id:args.id||randomUUID(),writerToken:randomUUID(),hostAdmin:args.hostAdmin};nodeSessions.set(result.id,result);return result;}
    if(operation==='terminal.exchange')return {offset:args.offset||0,data:'',exited:false};
    if(operation==='terminal.detach')return {id:args.id,detached:true};
    if(operation==='terminal.close'){nodeSessions.delete(args.id);return {closed:true};}
    if(operation==='host.status'){assert.equal(args.id,commandId);return {id:args.id,state:'SUCCEEDED',exitCode:0,stdout:'local fixture: repair check complete',stderr:''};}
    throw Error('Unexpected fixture host call: '+operation);
  }}));
  clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'browser-member',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  const legacy=seedLegacy(service,member,{title:'<img src=x onerror=alert(1)> 旧记录\u202e',script:'printf "history" #\r\u202e\u0085'});
  await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:true,revision:0,reason:'<img src=x onerror=alert(1)> 存储维修'});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
  const publicRequests=[],publicConsole=[];
  const onPublicRequest=request=>publicRequests.push(new URL(request.url()).pathname);
  const onPublicConsole=message=>{if(message.type()==='error')publicConsole.push(message.text());};
  page.on('request',onPublicRequest);page.on('console',onPublicConsole);
  await page.goto(origin);await page.locator('#login-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#login-form [data-public-maintenance]').textContent(),'<img src=x onerror=alert(1)> 存储维修');
  assert.equal(await page.locator('#login-form img').count(),0);
  for(const machine of MACHINES)assert.ok(!(await page.locator('body').textContent()).includes(machine.id));
  await page.locator('#open-register').click();await page.locator('#register-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#register-form [data-public-maintenance]').textContent(),'<img src=x onerror=alert(1)> 存储维修');
  assert.equal(await page.locator('#register-form img').count(),0);
  await page.goto(origin+'/guide');assert.match(await page.locator('body').textContent(),/STARGATE/);
  assert.equal(publicRequests.includes('/machines.js'),false);assert.equal(publicRequests.includes('/api/call'),false);
  assert.deepEqual(publicConsole,[]);page.off('request',onPublicRequest);page.off('console',onPublicConsole);
  async function login(username){
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('[data-nav=maintenance]').count(),0);
    await page.goto(origin+'/#maintenance');await page.locator('#maintenance-list [data-id="'+legacy.id+'"]').waitFor();
  }
  async function publicReasonHint(form){
    const text='全平台维护原因会公开显示在登录页，请勿写服务器名或内部信息。';
    const hint=form.getByRole('button',{name:'全平台维护原因说明',exact:true});
    assert.equal(await form.locator('[name=reason]').getAttribute('placeholder'),'例如：存储维护，预计今晚恢复');
    assert.equal(await hint.isVisible(),true);
    await hint.click();assert.equal(await form.getByText(text,{exact:true}).isVisible(),true,'global reason warning is available on demand');
    await form.locator('[name=scope]').selectOption(MACHINES[0].id);
    assert.equal(await hint.count(),0,'single-server reason must not show a public-login warning');
    await form.locator('[name=scope]').selectOption('all');
    await hint.click();assert.equal(await form.getByText(text,{exact:true}).isVisible(),true,'switching back restores the global warning');
    await hint.click();
  }
  for(const username of [member.username,'admin']){
    await login(username);await page.locator('[data-id="'+legacy.id+'"]').click();await page.locator('#maintenance-detail pre').waitFor();
    assert.equal(await page.locator('.page-heading .maintenance-copy-info').count(),0,'archive header must not expose an empty explanation control during maintenance');
    assert.match(await page.locator('.maintenance-banner').textContent(),/存储维修/);
    assert.match(await page.locator('.maintenance-banner').textContent(),/不会自动结束已有任务/);
    assert.equal(await page.locator('#operational-maintenance img').count(),0);
    assert.equal(await page.locator('.maintenance-settings').count(),username==='admin'?1:0);
    assert.equal(await page.locator('#maintenance-create,[data-maintenance=approve],[data-maintenance=cancel]').count(),0);
    assert.equal(await page.locator('#maintenance-detail img').count(),0);
    const detail=await page.locator('#maintenance-detail').textContent();assert.ok(detail.includes('\\u{000d}'));assert.ok(detail.includes('\\u{202e}'));assert.ok(detail.includes('\\u{0085}'));assert.doesNotMatch(detail,/[\r\u202e\u0085]/u);
    assert.match(await page.locator('#page-maintenance').textContent(),/未执行（流程已停用）/);
    await mkdir(screenshots,{recursive:true});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(screenshots,'history-'+username+'-1440.png'),fullPage:true});
    const rejected=await page.evaluate(async id=>{const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'maintenance.approve',args:{id,revision:1,previewToken:'legacy-token'}})});return response.status;},legacy.id);assert.equal(rejected,410);
    await page.setViewportSize({width:390,height:844});
    // The responsive shell clears transition layers from its resize handler;
    // assert the settled archive rather than racing that queued browser event.
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile archive must not overflow');
    await page.screenshot({path:join(screenshots,'history-'+username+'-390.png'),fullPage:true});
    if(username==='admin'){
      await page.locator('.maintenance-settings summary').click();
      await publicReasonHint(page.locator('.maintenance-settings form'));
      await page.locator('.maintenance-settings [name=reason]').fill('明确维修');await page.locator('.maintenance-settings [type=submit]').click();
      await page.waitForFunction(()=>document.querySelector('.maintenance-banner')?.textContent.includes('明确维修'));
      await service.invoke(admin.token,'maintenance.set',{scope:'gpu-1',enabled:true,revision:2,reason:'单机继续维护'});
      page.on('dialog',async dialog=>{assert.equal(dialog.type(),'confirm');if(dialog.message().includes('恢复新操作')){assert.match(dialog.message(),/未取消的等待任务会继续/);assert.match(dialog.message(),/终态任务不会自动重跑/);}else assert.match(dialog.message(),/ROOT|结束这个终端/);await dialog.accept();});
      await page.locator('[data-maintenance-resume]').click();await page.locator('[data-maintenance-error]').filter({hasText:'刷新'}).waitFor();
      assert.ok(service.maintenanceFor('gpu-2'),'stale form must not clear newer decision');
      await page.locator('[data-maintenance-refresh]').click();await page.waitForFunction(()=>document.querySelector('.maintenance-settings form')?.dataset.revision==='3');
      await page.locator('[data-maintenance-resume]').click();await page.waitForFunction(()=>!document.querySelector('.maintenance-banner')?.textContent.includes('全平台：'));
      assert.equal(service.maintenanceFor('gpu-2'),null);assert.ok(service.maintenanceFor('gpu-1'));
    }
    await accountMenu(page);await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor({state:'visible'});await page.setViewportSize({width:1440,height:1000});
  }
  assert.equal(service.db.prepare('SELECT state FROM maintenance_requests WHERE id=?').get(legacy.id).state,'PENDING');assert.deepEqual(calls,[]);
  const shots=process.env.PR5_SCREENSHOTS||'/tmp/gpuq-maintenance-ui';await mkdir(shots,{recursive:true});
  const writes=[],requests=[];page.on('request',request=>{if(request.url()!==origin+'/api/call')return;const body=request.postDataJSON();if(!body)return;requests.push(body.operation);if(body.operation==='maintenance.set')writes.push(body.args);});
  const set=async(scope,enabled,reason='存储诊断 · 明确恢复前检查')=>service.invoke(admin.token,'maintenance.set',{scope,enabled,revision:service.operationalMaintenance(admin.principal).revision,...(enabled?{reason}:{})});
  const fresh=async()=>{await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:m.id+'-GPU-'+index,utilization:index===0?37:0,memoryUsedMiB:index===0?8192:0,memoryTotalMiB:24576,temperatureC:46,powerDrawW:85,powerLimitW:350,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));await service.refreshGPUQ();};
  const job=state=>{const id=randomUUID();return {id,userId:member.id,username:member.username,name:'维护测试 · '+state,machine:'gpu-1',cards:1,state,createdAt:new Date().toISOString(),spec:{id,userId:member.id,machine:'gpu-1',argv:['python','train.py']}};};
  service.store.jobs.push(job('RUNNING'),job('PENDING'));service.save();
  async function workLogin(username){await login(username);await page.goto(origin+'/#work');await page.locator('#my-job-table').waitFor();}
  async function logout(){await accountMenu(page);await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor({state:'visible'});}
  async function shot(name,width=1440){await page.setViewportSize({width,height:width===390?844:1000});await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);await page.screenshot({path:join(shots,name+'.png'),fullPage:width>=760});}
  await fresh();await set('all',true,'<img src=x onerror=window.XSS=1> 全平台存储诊断');await workLogin(member.username);
  await page.locator('#maintenance-member-title').waitFor();assert.equal(await page.locator('#maintenance-experience img').count(),0);assert.equal(await page.evaluate(()=>window.XSS),undefined);
  assert.match(await page.locator('#maintenance-experience').innerText(),/维护中|运行任务继续/);assert.match(await page.locator('#my-job-table').innerText(),/维护期间暂不派发/);
  assert.equal(await page.locator('[data-maintenance-root]').count(),0);
  await page.locator('[name=workspace-machine]').selectOption('gpu-1');await page.waitForFunction(()=>document.querySelector('#terminal-open')?.disabled);
  await page.locator('#open-submit').click();await page.locator('#work-submit').waitFor({state:'visible'});assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);assert.equal(await page.locator('#submit-maintenance-switch').count(),0);
  await page.evaluate(()=>document.querySelector('#train-form').requestSubmit());assert.equal(requests.includes('jobs.submit'),false,'member submit must be intercepted before API');await page.locator('#close-submit').click();
  await set('all',true,'存储诊断与节点维修；新操作暂停，运行任务继续');await refreshVisible(page);await page.waitForTimeout(3600);
  await shot('member-global-desktop');await shot('member-global-mobile',390);
  await page.locator('[data-nav=datasets]').click();await page.locator('#datasets-refresh').click();await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);assert.equal(await page.locator('#datasets-status').textContent(),'','confirmed empty catalog does not invent an update timestamp');await page.locator('#warehouse-page-actions [data-v3-upload]').click();await page.locator('#dataset-add-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#dataset-upload-start').isDisabled(),true);assert.equal(await page.locator('#datasets-refresh').isDisabled(),false);await page.locator('[data-v3-source=workspace]').click();assert.equal(await page.locator('#terminal-data-open').isDisabled(),true);assert.equal(await page.locator('#data-workspace-publish').isDisabled(),true);assert.equal(await page.locator('#data-workspace-refresh').isDisabled(),false);await shot('member-data-write-paused-desktop');await shot('member-data-write-paused-mobile',390);await page.locator('[data-dataset-add-close]').click();await shot('member-datasets-desktop');await shot('member-datasets-mobile',390);
  await page.locator('#warehouse-page-actions a[href="#datasets/transfers"]').click();await page.locator('#transfer-copy summary').click();assert.equal(await page.locator('#transfer-copy-form [type=submit]').isDisabled(),true);assert.equal(await page.locator('#transfer-refresh').isDisabled(),false);await shot('member-transfers-desktop');await shot('member-transfers-mobile',390);await page.locator('[data-nav=work]').click();
  const guide=page.waitForEvent('popup');await page.locator('#maintenance-experience a[href="/guide"]').click();const guidePage=await guide;await guidePage.waitForLoadState();assert.match(await guidePage.title(),/GPUQ|指南/);await guidePage.close();
  const forbidden=await page.evaluate(async()=>{const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'jobs.submit',args:{machine:'gpu-1'}})});return response.status;});assert.equal(forbidden,503);
  await set('all',false);await refreshVisible(page);await page.waitForFunction(()=>document.querySelector('#maintenance-experience')?.hidden);
  await page.locator('[data-nav=resources]').click();await page.locator('[data-resource-machine="gpu-1"] .maintenance-lock-band').waitFor();assert.equal(await page.locator('[data-resource-machine="gpu-2"] .maintenance-lock-band').count(),0);
  await shot('member-server-desktop');await shot('member-server-mobile',390);
  await page.locator('[data-nav=work]').click();await page.locator('#open-submit').click();await page.locator('#submit-maintenance-switch').waitFor();assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  await shot('member-preflight-desktop');await shot('member-preflight-mobile',390);
  await page.locator('#submit-maintenance-machine').selectOption('gpu-2');await page.locator('#submit-maintenance-switch').click();await page.waitForFunction(()=>document.querySelector('[name=workspace-machine]')?.value==='gpu-2');assert.equal(await page.locator('#submit-maintenance').isVisible(),false);await page.locator('#close-submit').click();
  // An already attached personal terminal remains readable and stoppable,
  // but no typed bytes or Ctrl+C are sent after maintenance begins.
  await set('gpu-1',false);await refreshVisible(page);await page.locator('[name=workspace-machine]').selectOption('gpu-1');await page.waitForFunction(()=>document.querySelector('#terminal-open')&&!document.querySelector('#terminal-open').disabled);await page.locator('#terminal-open').click();await page.locator('.terminal-dialog').waitFor({state:'visible'});
  await set('gpu-1',true);await page.evaluate(()=>document.querySelector('#refresh-state').click());await page.locator('#terminal-maintenance-note').waitFor({state:'visible'});const pausedCalls=calls.length;await page.locator('#terminal-screen textarea').focus();await page.keyboard.type('echo forbidden\r');await page.waitForTimeout(900);assert.equal(await page.locator('#terminal-interrupt').isDisabled(),true);assert.ok(calls.slice(pausedCalls).filter(call=>call.operation==='terminal.exchange').every(call=>!call.args.input));
  await shot('member-terminal-desktop');await shot('member-terminal-mobile',390);await page.locator('#terminal-stop').click();await page.locator('.terminal-dialog').waitFor({state:'hidden'});assert.equal(calls.at(-1).operation,'terminal.close');await logout();
  await fresh();await set('all',true);await page.setViewportSize({width:1440,height:1000});await workLogin('admin');await page.locator('.maintenance-console-heading').waitFor();assert.equal(await page.locator('[data-maintenance-server]').count(),MACHINES.length);
  await shot('admin-console-desktop');await shot('admin-console-mobile',390);
  await page.locator('[data-maintenance-start="all"]').click();await publicReasonHint(page.locator('#maintenance-start-form'));await page.locator('[data-maintenance-dialog-close]').click();
  await page.locator('[data-maintenance-root="gpu-3"]').click();await page.locator('.host-terminal-dialog').waitFor({state:'visible'});assert.match(await page.locator('#terminal-title').innerText(),/gpu-3.*ROOT/);const root=calls.filter(call=>call.operation==='terminal.open').at(-1);assert.equal(root.machine,'gpu-3');assert.equal(root.args.hostAdmin,true);assert.equal(root.args.project,undefined);assert.equal(await page.locator('#terminal-interrupt').isDisabled(),false);await shot('admin-root-desktop');await shot('admin-root-mobile',390);await page.locator('#terminal-stop').click();await page.locator('.terminal-dialog').waitFor({state:'hidden'});
  await page.locator('[data-maintenance-host="gpu-3"]').click();await page.locator('#maintenance-host-form [name=commandId]').fill(commandId);await page.locator('#maintenance-host-form [type=submit]').click();await page.locator('[data-host-receipt]').filter({hasText:'SUCCEEDED'}).waitFor();assert.equal(calls.at(-1).operation,'host.status');assert.equal(calls.at(-1).args.hostAdmin,true);await shot('admin-host-desktop');await shot('admin-host-mobile',390);await page.locator('[data-maintenance-dialog-close]').click();
  await page.locator('[data-maintenance-check="gpu-1"]').click();assert.match(await page.locator('.maintenance-checks').innerText(),/任务状态核对|整机无其他 ROOT/);await shot('admin-check-desktop');await shot('admin-check-mobile',390);await page.locator('[data-select-checked="gpu-1"]').click();
  const first=writes.length;await page.locator('[data-maintenance-stage]').click();await page.locator('[data-recovery-ack]').check();await shot('admin-recovery-desktop');await shot('admin-recovery-mobile',390);await page.locator('[data-recovery-apply]').click();await page.waitForFunction(()=>!document.querySelector('#maintenance-console-dialog').open);
  assert.deepEqual(writes.slice(first).map(args=>[args.scope,args.enabled]),[['gpu-2',true],['gpu-3',true],['gpu-4',true],['gpu-1',false],['all',false]]);assert.ok(writes.slice(first).every((args,index,values)=>index===0||args.revision===values[index-1].revision+1));assert.equal(service.maintenanceFor('gpu-1'),null);for(const id of ['gpu-2','gpu-3','gpu-4'])assert.equal(service.maintenanceFor(id).reason,'存储诊断 · 明确恢复前检查');
  // A concurrent window changes the revision after one applied protection.
  // No later step may clear global maintenance or automatically retry.
  await set('all',true);for(const id of ['gpu-2','gpu-3','gpu-4'])await set(id,false);await fresh();await refreshVisible(page);await page.locator('[data-recovery-select="gpu-1"]').check();await page.locator('[data-maintenance-stage]').click();await page.locator('[data-recovery-ack]').check();let stageRequests=0;
  await page.route(origin+'/api/call',async route=>{const body=route.request().postDataJSON();if(body.operation==='maintenance.set'&&++stageRequests===2)await set('gpu-1',true,'另一窗口维修决定');await route.continue();});
  const conflicting=writes.length;await page.locator('[data-recovery-apply]').click();await page.locator('[data-console-error]').filter({hasText:'维护状态已由其他窗口修改，请刷新后确认'}).waitFor();assert.match(await page.locator('[data-recovery-applied]').innerText(),/gpu-2.*已启用维护.*revision/);assert.equal(await page.locator('[data-recovery-apply]').isDisabled(),true);await page.waitForTimeout(500);assert.equal(writes.length-conflicting,2);assert.ok(service.globalMaintenanceActive());assert.ok(service.maintenanceFor('gpu-4'));await shot('admin-conflict-desktop');await shot('admin-conflict-mobile',390);await page.unroute(origin+'/api/call');await page.locator('[data-recovery-refresh]').click();await page.locator('#maintenance-console-dialog').waitFor({state:'hidden'});
  await page.locator('[data-maintenance-start="gpu-4"]').click();await page.locator('#maintenance-start-form [name=reason]').fill('明确单台维护');await shot('admin-start-desktop');await shot('admin-start-mobile',390);await page.locator('#maintenance-start-form [type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#maintenance-console-dialog').open);assert.equal(service.operationalMaintenance(admin.principal).machines['gpu-4'].reason,'明确单台维护');
  const savedQuota=service.store.get(member.id).total;await page.setViewportSize({width:1440,height:1000});await page.locator('[data-nav=users]').click();await page.locator(`[data-user="${member.id}"]`).click();await page.locator('[data-quota=total]').fill('3');assert.match(await page.locator('#save-state').innerText(),/未保存/);await page.setViewportSize({width:390,height:844});
  await logout();assert.equal(service.store.get(member.id).total,savedQuota,'logout never saves an authorization draft');assert.equal(await page.locator('#maintenance-experience [data-maintenance-root]').count(),0);assert.equal(await page.locator('#maintenance-console-dialog').textContent(),'');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.ok(calls.every(call=>['projects.list','datasets.list','datasets.capacity','datasets.upload.routes','transfers.capabilities','terminal.open','terminal.exchange','terminal.detach','terminal.close','host.status'].includes(call.operation)),JSON.stringify([...new Set(calls.map(call=>call.operation))]));
  console.log('Maintenance browser passed: retired archive/CAS, escaped member global page, scoped lock bands and preflight choice, readable personal terminal with input blocked, guide/logout reachable, administrator ROOT/host status, staged call order and partial conflict stop, desktop/mobile layout.');
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}else service?.close();await rm(dir,{recursive:true,force:true});}
