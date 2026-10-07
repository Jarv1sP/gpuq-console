// Disposable portal and simulated node facts only; no real storage or writes.
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

const root=await mkdtemp(join(tmpdir(),'member-surface-ui-')),shots=join(process.env.UI_SCREENSHOTS||'/tmp/member-surface-ui','member-surfaces');
const password='Member-Surface-Simulated-2026!',machine=MACHINES[0].id,release='a'.repeat(64),calls=[],errors=[],outside=[];
const project={project:'surface-project',environmentMode:'oci',state:'READY',releases:[{release,state:'READY'}],latestReadyRelease:release};
let server,service,browser,verified=false;
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(root,'bootstrap'),statusPath=join(root,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const snapshot=()=>writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[],capabilities:verified?['console-placement-v1','console-sharing-v1','console-hami-v1','console-hami-sm-v1']:[]}}))}));await snapshot();
  const bridge=async(node,operation,args)=>{
    calls.push({machine:node,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {environmentModes:['oci'],projects:node===machine?[project]:[]};
    if(operation==='projects.status')return project;
    if(operation==='files.list')return {entries:[]};
    if(operation==='datasets.list')return {datasets:[{dataset:'surface-data',owners:[args.userId],versions:[{version:release,state:'READY',bytes:4,files:1}]}]};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:20*1024**3,usableBytes:492*1024**3,guarded:true};
    if(operation==='cloud.import.list')return {imports:[]};
    throw Error('Unexpected simulated surface operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(root,'db'),bootstrap,statusPath,origin,secure:false,bridge}));clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'surface-member',password})).result;await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[machine]:1}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);await route.abort();return;}await route.continue();}));
  await page.goto(origin);await page.locator('#login-form [name=username]').fill('surface-member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
  await page.locator('[name=workspace-project] option[data-project="surface-project"]').waitFor({state:'attached'});await page.locator('[name=workspace-project]').selectOption('surface-project');await page.waitForFunction(()=>!document.querySelector('#project-publish').disabled);
  await page.locator('#workspace-files>summary').click();const help=page.locator('#workspace-upload-route');assert.match(await help.textContent(),/普通文件和个人数据空间经过平台中转/);assert.equal(await help.locator('.ui-info').count(),1);assert.equal(await help.locator('.ui-info').evaluate(node=>node.open),false,'Transmission explanation is collapsed into a single information hint');
  await help.locator('.ui-info>summary').click();assert.equal(await help.locator('.ui-info-content').isVisible(),true);assert.equal(await page.locator('#workspace-files').evaluate(node=>node.open),true,'Information hint does not close the file controls');await help.locator('.ui-info>summary').click();
  for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1080});await help.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,'files-'+width+'.png'),animations:'disabled'});}
  await page.setViewportSize({width:1440,height:1080});await openSubmit(page);await page.locator('#train-form').evaluate(form=>{for(const detail of form.querySelectorAll('details'))detail.open=true;});
  assert.equal(await page.locator('[name=sm-percent]').isVisible(),false,'Unverified SM capability offers no member control');
  verified=true;await snapshot();await refreshVisible(page);await page.waitForFunction(()=>!document.querySelector('[name=sm-percent]').closest('label').hidden);assert.equal(await page.locator('[name=sm-percent]').isVisible(),true,'Explicit complete node capability retains the verified control');
  verified=false;await snapshot();await refreshVisible(page);await page.waitForFunction(()=>document.querySelector('[name=sm-percent]').closest('label').hidden);await closeSubmit(page);
  await page.locator('[data-nav=datasets]').click();await page.locator('[data-v3-upload]').first().click();
  // The upload button opens <details>; its queued toggle opens the dialog.
  // Check retained/hidden sources only after that native UI transition ends.
  await page.locator('#dataset-add-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-v3-source=aliyun]').isVisible(),false);
  assert.deepEqual(await page.locator('[name=cloud-source] option[value=aliyun]').evaluate(node=>({hidden:node.hidden,disabled:node.disabled})),{hidden:true,disabled:true},'The native source option is hidden and unavailable');
  assert.equal(await page.locator('#cloud-files').isHidden(),true);
  assert.equal(await page.locator('[data-v3-source=link]').isVisible(),true);assert.equal(await page.locator('[data-v3-source=workspace]').isVisible(),true,'Useful HTTPS and personal-workspace paths are retained');
  for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1080});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,'sources-'+width+'.png'),animations:'disabled'});}
  assert.ok(calls.every(row=>!/^cloud\.(?:auth|files)|^cloud\.inspect$|^jobs\.submit$|^files\.put$/.test(row.operation)),'Browsing hidden entries issues no cloud operations or writes');assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log('MEMBER SURFACE PASS: simulated facts, one collapsed transmission hint, verified-only SM, hidden cloud experiments, retained HTTPS/workspace routes, 1440/390, no writes or outside requests.');
}finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));if(service&&!service.closing){clearInterval(service.executionTimer);await service.close();}await rm(root,{recursive:true,force:true});}
