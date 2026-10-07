// Read-only personal quota in the real portal; all node data stays in fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';

const root=await mkdtemp(join(tmpdir(),'project-quota-ui-')),shots=join(process.env.UI_SCREENSHOTS||'/tmp/project-quota-ui','disk-quota');
const password='Quota-Browser-Fixture-2026!',source=MACHINES[1].id,other=MACHINES[0].id,release='a'.repeat(64),calls=[],errors=[],outside=[];
let server,service,browser,mode='enabled',releaseQuota,quotaStarted;
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
const info=project=>({project,state:'READY',environmentMode:'oci',releases:[{release,state:'READY'}],latestReadyRelease:release});
const quota=owner=>({owner,enabled:true,enforcement:'kernel-project-quota',projectId:10001,volumes:[{volume:'personal-ssd',bytes:1024**3,inodes:10000,usedBytes:512*1024**2,usedInodes:20,remainingBytes:512*1024**2,remainingInodes:9980}]});
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(root,'bootstrap'),statusPath=join(root,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {environmentModes:['shared','isolated','oci'],projects:machine===source?[info('quota-project')]:machine===other?[info('other-project')]:[]};
    if(operation==='projects.status')return info(args.project);
    if(operation==='files.list')return {entries:[]};
    if(operation==='projects.quota'){
      assert.deepEqual(Object.keys(args),['userId'],'No project or foreign owner is supplied to node quota');
      if(mode==='disabled')return {owner:args.userId,enabled:false,enforcement:null,volumes:null};
      if(mode==='unknown')return {owner:args.userId,enabled:true,enforcement:'estimate'};
      const result=quota(args.userId);if(mode==='held')await new Promise(r=>{releaseQuota=r;quotaStarted?.();});return result;
    }
    throw Error('Unexpected quota fixture operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(root,'db'),bootstrap,statusPath,origin,secure:false,bridge}));clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'quota-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[source]:1,[other]:1}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const role of ['member','admin']){
    mode='enabled';const before=calls.filter(row=>row.operation==='projects.quota').length,context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/content security policy|refused to|uncaught|syntaxerror/i.test(message.text()))errors.push(message.text());});await context.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol)){await route.continue();return;}outside.push(url.href);await route.abort();}));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(role==='admin'?'admin':'quota-member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    await page.locator('[name=workspace-project] option[data-project="quota-project"]').waitFor({state:'attached'});await page.locator('[name=workspace-project]').selectOption('quota-project');await page.waitForFunction(()=>!document.querySelector('#project-publish').disabled);
    assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'','Personal project does not require topbar selection');assert.equal(calls.filter(row=>row.operation==='projects.quota').length,before,'Collapsed quota performs no background reads');
    await page.locator('#project-disk-quota>summary').click();await page.waitForFunction(()=>document.querySelector('#disk-quota-state').textContent.includes('已启用'));
    assert.equal(await page.locator('#disk-quota-machine').getAttribute('title'),source);assert.match(await page.locator('#disk-quota-result').textContent(),/512 MiB \/ 1 GiB/);assert.match(await page.locator('#disk-quota-result').textContent(),/20 \/ 10,000/);
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:width<760?844:1080});await page.evaluate(()=>document.fonts.ready);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#project-disk-quota').evaluate(node=>node.scrollIntoView({block:'center'}));assert.ok(await page.locator('.disk-quota-volumes').evaluate(node=>{const r=node.getBoundingClientRect();return r.top>=96&&r.bottom<innerHeight-156;}),'Quota readings are visible above fixed controls');
      if(width<760){
        const summary=page.locator('#project-disk-quota>summary'),box=await summary.boundingBox();
        assert.ok(box&&box.height>=44,'Personal disk quota disclosure keeps its 44px phone touch target: '+JSON.stringify({role,width,box}));
        await summary.focus();await summary.press('Enter');await page.waitForFunction(()=>!document.querySelector('#project-disk-quota').open);assert.equal(await summary.evaluate(node=>document.activeElement===node),true,'Closing quota by keyboard preserves focus');
        await summary.press('Enter');await page.waitForFunction(()=>document.querySelector('#disk-quota-state').textContent.includes('已启用'));assert.equal(await summary.evaluate(node=>document.activeElement===node),true,'Reopening quota by keyboard preserves focus');
      }
      if(width!==320)await page.screenshot({path:join(shots,role+'-enabled-'+width+'.png'),animations:'disabled'});
    }
    mode='disabled';await page.locator('#disk-quota-refresh').click();await page.waitForFunction(()=>document.querySelector('#disk-quota-state').textContent.includes('未启用'));assert.equal(await page.locator('#disk-quota-result').textContent(),'未启用');assert.equal(await page.locator('#disk-quota-result progress').count(),0);
    await page.locator('#project-disk-quota .ui-info>summary').click();assert.match(await page.locator('#project-disk-quota .ui-info-content').textContent(),/未启用不代表零用量或无限容量/);await page.locator('#project-disk-quota .ui-info>summary').click();
    mode='unknown';await page.locator('#disk-quota-refresh').click();await page.waitForFunction(()=>document.querySelector('#disk-quota-state').textContent.includes('待确认'));assert.equal(await page.locator('#disk-quota-result progress').count(),0);assert.match(await page.locator('#disk-quota-result').textContent(),/未确认/);
    mode='held';const started=new Promise(r=>{quotaStarted=r;});await page.locator('#disk-quota-refresh').click();await started;await page.waitForFunction(()=>document.querySelector('#disk-quota-state').textContent.includes('查询中'));await page.locator('#project-disk-quota>summary').click();await page.evaluate(()=>location.hash='#resources');await page.locator('#page-resources').waitFor({state:'visible'});const count=calls.filter(row=>row.operation==='projects.quota').length;releaseQuota();releaseQuota=null;quotaStarted=null;
    mode='enabled';await page.evaluate(()=>location.hash='#work');await page.locator('#page-work').waitFor({state:'visible'});assert.equal(await page.locator('#project-disk-quota').evaluate(node=>node.open),false);assert.equal(await page.locator('#disk-quota-result progress').count(),0,'Late receipt cannot refill a closed quota');assert.equal(calls.filter(row=>row.operation==='projects.quota').length,count,'No retry or polling after closing and leaving');
    await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:true,reason:'Quota fixture maintenance',revision:service.operationalMaintenance(admin.principal).revision});
    await page.locator('#project-disk-quota>summary').click();await page.waitForFunction(()=>document.querySelector('#disk-quota-state').textContent.includes('已启用'));await page.waitForFunction(()=>document.querySelector('#terminal-open').disabled);assert.equal(await page.locator('#terminal-open').isDisabled(),true,'Maintenance still blocks new sessions');assert.match(await page.locator('#disk-quota-result').textContent(),/512 MiB/,'Quota remains readable in maintenance');
    await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:false,revision:service.operationalMaintenance(admin.principal).revision});await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);assert.ok(calls.every(row=>['projects.list','projects.status','files.list','projects.quota'].includes(row.operation)),'Quota view performs only readonly calls');
  console.log('PERSONAL DISK QUOTA PASS: member/admin, fixed development machine, lazy reads, actual counters, disabled != zero, unknown != zero, aborted late receipt, readable during maintenance, 1440/390/320, 44px phone disclosure and keyboard focus, no writes or outside calls.');
}finally{releaseQuota?.();await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));if(service&&!service.closing){clearInterval(service.executionTimer);await service.close();}await rm(root,{recursive:true,force:true});}
