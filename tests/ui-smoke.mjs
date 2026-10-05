import {openSubmit} from './starbase-workflows.mjs';
import {resourceCard as card,resourceDetail,selectResource} from './resources-workflows.mjs';
// Browser acceptance: npm ci --ignore-scripts && npx playwright install chromium
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=await mkdtemp(join(tmpdir(),'gpuq-ui-')),password='UI-Test-Only-Password-2026';let server,browser;
const statusPath=join(dir,'status.json');
const processName='private-training.py',processOwner='private-research-owner',processPid=654321;
function snapshot(checkedAt=new Date().toISOString()){
 return {version:1,checkedAt,hosts:MACHINES.map(machine=>({
  id:machine.id,reachable:true,checkedAt,
  gpus:Array.from({length:machine.cards},(_,index)=>({
   index,model:machine.model,uuid:`GPU-${machine.id}-${index}`,
   memoryTotalMiB:machine.id==='gpu-1'?32768:24576,memoryUsedMiB:index===0?8192:0,
   utilization:index===0?73:0,temperatureC:index===0?61:32,
   powerDrawW:index===0?220.5:18,powerLimitW:machine.id==='gpu-1'?575:450,
   processesAvailable:true,processes:index===0?[{pid:processPid,name:`/private/project/${processName}`,owner:processOwner,memoryUsedMiB:8192,type:'compute'}]:[],
  })),gpuq:{connected:true,jobs:[]},
 }))};
}
async function saveSnapshot(value=snapshot()){await writeFile(statusPath,JSON.stringify(value));return value;}
try{
 await saveSnapshot();
 const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin=`http://127.0.0.1:${port}`;
 const portal=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,statusPath,bridge:async(machine,operation)=>{if(operation==='projects.list')return {projects:[]};throw Error('Resource acceptance permits project metadata only, never an execution operation.');}});server=portal.server;await new Promise(r=>server.listen(port,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const admin=await browser.newPage({viewport:{width:1440,height:1050}}),member=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
 const blockedRequests=[];
 for(const p of [admin,member]){
  p.context().on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
  p.on('pageerror',e=>errors.push(e.message));
  await p.context().route('**/*',route=>{
   const url=route.request().url();
   if(new URL(url).origin===origin)return route.continue();
   blockedRequests.push(url);return route.abort('blockedbyclient');
  });
 }
 async function login(p,name){await p.goto(origin);await p.locator('#login-form [name=username]').fill(name);await p.locator('#login-form [name=password]').fill(password);await p.locator('#login-form [type=submit]').click();await p.locator('#login-dialog').waitFor({state:'hidden'});}
 async function refreshPage(p){
  await Promise.all([
   p.waitForResponse(response=>response.url()===`${origin}/api/call`&&response.request().postDataJSON()?.operation==='state'),
   p.locator('#refresh-state').click(),
  ]);
 }
 async function checkGuide(p,path){
  const link=p.locator(`a[href="${path}"]:visible`).first();
  assert.equal(await link.isVisible(),true,`${path} should have a visible entry point`);
  const [guide]=await Promise.all([p.waitForEvent('popup'),link.click()]);
  try{
   await guide.waitForLoadState('domcontentloaded');
   assert.equal(new URL(guide.url()).pathname,path);
   assert.match(await guide.locator('body').textContent(),/STARGATE/);
  }finally{await guide.close();}
 }
 async function capture(p,name){
  if(!process.env.UI_SCREENSHOTS)return;
  await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});
  await p.evaluate(()=>scrollTo(0,0));
  await p.screenshot({path:join(process.env.UI_SCREENSHOTS,name),fullPage:await p.locator('dialog[open]').count()===0});
 }
 await login(admin,'admin');await admin.locator('[data-nav=resources]').click();
 assert.equal(await admin.locator('.resource-card').count(),MACHINES.length);
 assert.equal(await admin.locator('.resource-tower').count(),MACHINES.reduce((total,machine)=>total+machine.cards,0));
 assert.equal(await admin.locator('[data-resource-selected]').count(),1);
 for(const machine of MACHINES){
  const machineCard=card(admin,machine.id);
  const selected=await selectResource(admin,machine.id,{metrics:true});
  assert.equal(await selected.locator('[data-gpu-index]').count(),machine.cards);
  assert.equal(await admin.locator('[data-gpu-index]').count(),machine.cards,'Only one server detail is present');
  assert.match(await machineCard.locator('.resource-spec').textContent(),new RegExp(machine.model));
 }
 await selectResource(admin,'gpu-1',{metrics:true});
 const gpu0=resourceDetail(admin,'gpu-1').locator('[data-gpu-index="0"]');
 const gpuText=await gpu0.textContent();
 for(const expected of [/#0/,/RTX 5090/,/73%/,/8\.0\s*\/\s*32\.0/,/61\s*°C/,/221\s*W\s*\/\s*575\s*W/])assert.match(gpuText,expected);
 const gpu1=resourceDetail(admin,'gpu-1').locator('[data-gpu-index="1"]');
 assert.match(await gpu1.textContent(),/0%/);assert.match(await gpu1.textContent(),/0\.0\s*\/\s*32\.0/);
 assert.match(await admin.locator('#monitor-status').textContent(),/更新于/);
 assert.match(await admin.locator('#monitor-status').getAttribute('title'),/\d{4}/);
 const detail=admin.locator('details[data-resource-detail="gpu-1:0"]');
 await detail.locator(':scope > summary').click();
 const processText=await detail.locator('.process-table').textContent();
 assert.match(processText,new RegExp(String(processPid)));assert.match(processText,/8192/);
 assert.ok(processText.includes(processName));assert.ok(processText.includes(processOwner));
 await capture(admin,'resources-admin-desktop.png');
 await checkGuide(admin,'/guide');assert.equal(await admin.locator('a[href="/guide/admin"]').count(),0);
 // A real state refresh changes metrics without closing the per-card process panel.
 const updated=snapshot();updated.hosts[0].gpus[0].utilization=44;await saveSnapshot(updated);await refreshPage(admin);
 await admin.waitForFunction(()=>document.querySelector('[data-resource-selected="gpu-1"] [data-gpu-index="0"]').textContent.includes('44%'));
 assert.equal(await detail.evaluate(element=>element.open),true);
 assert.equal(await detail.locator('.process-table').isVisible(),true);
 // Unknown metrics and failed process collection must not be shown as idle zeroes.
 const incomplete=snapshot();Object.assign(incomplete.hosts[0].gpus[2],{utilization:null,memoryUsedMiB:null,temperatureC:null,powerDrawW:null,processesAvailable:false,processesError:'Simulated process collection failure'});
 incomplete.hosts[3]={id:'gpu-4',reachable:false,checkedAt:incomplete.checkedAt,gpus:[],error:'Simulated unreachable node',gpuq:{connected:false,jobs:[]}};
 await saveSnapshot(incomplete);await refreshPage(admin);
 await admin.locator('[data-resource-detail="gpu-1:2"] summary').filter({hasText:'采集不可用'}).waitFor();
 const unavailable=resourceDetail(admin,'gpu-1').locator('[data-gpu-index="2"]');
 assert.match(await unavailable.textContent(),/—/);assert.doesNotMatch(await unavailable.textContent(),/0%/);
 assert.equal(await unavailable.locator('progress').count(),0);
 await selectResource(admin,'gpu-4');
 assert.equal(await resourceDetail(admin,'gpu-4').locator('[data-gpu-index]').count(),0);
 assert.match(await resourceDetail(admin,'gpu-4').textContent(),/状态未知/);
 await selectResource(admin,'gpu-1',{metrics:true});
 await saveSnapshot(snapshot(new Date(Date.now()-10*60*1000).toISOString()));await refreshPage(admin);
 await admin.locator('#monitor-status').filter({hasText:'已过期'}).waitFor();
 assert.equal(await admin.locator('[data-gpu-index]').count(),0);
 assert.match(await resourceDetail(admin,'gpu-1').textContent(),/状态未知/);
 await saveSnapshot();await refreshPage(admin);await gpu0.waitFor();
 await admin.locator('[data-nav=users]').click();assert.equal(await admin.locator('#add-user').count(),0);
 await admin.locator('.management-toolbar [data-action=invites]').click();await admin.locator('[data-action=rotate-invite]').click();await capture(admin,'members-invite-confirm-1440.png');await admin.locator('#confirm-action').click();const code=await admin.locator('#current-invite').inputValue();assert.ok(code.startsWith('GPUQ-U-'));
 await capture(admin,'members-invites-1440.png');await admin.setViewportSize({width:390,height:844});await capture(admin,'members-invites-390.png');await admin.setViewportSize({width:1440,height:1050});
 await admin.locator('[data-close=invites-dialog]').click();await admin.reload();await admin.locator('.management-toolbar [data-action=invites]').click();assert.equal(await admin.locator('#current-invite').inputValue(),code);await admin.locator('[data-close=invites-dialog]').click();
 await member.goto(origin);await member.locator('#login-dialog .guide-link').waitFor();assert.equal(await member.locator('a[href^="/guide"]').count(),1);
 await capture(member,'login-1440.png');await member.setViewportSize({width:390,height:844});await capture(member,'login-390.png');
 assert.deepEqual(await member.locator('#login-dialog').boundingBox(),{x:0,y:0,width:390,height:844});
 await member.locator('#open-register').click();await member.locator('#register-dialog .guide-link').waitFor();assert.equal(await member.locator('a[href^="/guide"]').count(),1);
 await capture(member,'register-390.png');await member.setViewportSize({width:320,height:844});assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 for(const [name,value] of Object.entries({username:'验收同学',password,confirm:password,invite:code}))await member.locator(`#register-form [name=${name}]`).fill(value);
 assert.equal(await member.locator('#register-form [name=username]').evaluate(node=>parseFloat(getComputedStyle(node).fontSize)>=16),true);
 await member.setViewportSize({width:1440,height:1050});await capture(member,'register-1440.png');await member.locator('#register-form [type=submit]').click();await member.locator('#register-dialog').waitFor({state:'hidden'});
 assert.equal(await member.locator('#app-topbar .guide-link').count(),1,'the one public guide entry returns to the authenticated shell');
 assert.equal(await member.locator('[data-nav=users]').isVisible(),false);assert.equal(await member.locator('#page-resources').isVisible(),true);assert.match(await member.locator('#resource-summary').textContent(),/额度 0 张/);assert.equal(await member.locator('[data-use-machine]:enabled').count(),0);
 assert.equal(await member.locator('.resource-card').count(),MACHINES.length);
 assert.equal(await member.locator('[data-gpu-index]').count(),0);
 assert.equal(await member.locator('details[data-resource-detail]').count(),0);
 assert.ok(!(await member.locator('#machine-grid').textContent()).includes(processOwner));
 await capture(member,'resources-zero-quota-desktop.png');
 await checkGuide(member,'/guide');assert.equal(await member.locator('a[href="/guide/admin"]:visible').count(),0);
 // Verify automatic registration discovery, without pressing refresh.
 await admin.locator('[data-user]').filter({hasText:'验收同学'}).waitFor({timeout:22000});await admin.locator('[data-user]').filter({hasText:'验收同学'}).click();await admin.locator('[data-machine=gpu-1]').check();await admin.locator('[data-quota=gpu-1]').fill('2');await admin.locator('[data-quota=total]').fill('2');
 await admin.evaluate(()=>scrollTo(0,0));assert.equal(await admin.locator('#page-users .primary:visible').count(),1);
 const approval=await admin.locator('[data-action=save-policy]').boundingBox(),strip=await admin.locator('#control-strip').boundingBox();assert.ok(approval.y>=0&&approval.y+approval.height<strip.y,'approval is visible before scrolling to the per-server fields');
 assert.equal(await admin.locator('[data-permission-meter=gpu-1] .is-on').count(),2);
 await admin.locator('[data-quota=total]').fill('');assert.match(await admin.locator('#policy-summary').textContent(),/待校正/);assert.equal(await admin.locator('[data-permission-meter=gpu-1] .is-on').count(),2,'an invalid total does not erase the confirmed per-server draft');await admin.locator('[data-quota=total]').fill('2');
 for(const machine of MACHINES)assert.equal(await admin.locator('[data-permission-meter='+machine.id+'] i').count(),machine.cards);
 await capture(admin,'members-draft-1440.png');await admin.setViewportSize({width:390,height:844});assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await admin.waitForFunction(()=>document.querySelector('[data-nav=me]').getAttribute('aria-current')==='page');
 assert.equal(await admin.locator('[data-nav=me]').getAttribute('aria-current'),'page');assert.equal(await admin.locator('#page-users').isVisible(),true);
 await admin.locator('[data-quota=gpu-1]').focus();assert.equal(await admin.locator('[data-quota=gpu-1]').inputValue(),'2');
 await capture(admin,'members-draft-390.png');await admin.setViewportSize({width:1440,height:1050});
 await admin.waitForTimeout(16000);assert.equal(await admin.locator('[data-quota=gpu-1]').inputValue(),'2');assert.equal(await admin.evaluate(()=>document.activeElement.dataset.quota),'gpu-1','automatic refresh preserves the dirty editor and its focused field');await admin.locator('[data-action=save-policy]').click();
 await member.waitForFunction(()=>document.querySelector('#resource-summary').textContent.includes('额度 2 张'),{},{timeout:22000});
 await selectResource(member,'gpu-1',{metrics:true});
 assert.equal(await resourceDetail(member,'gpu-1').locator('[data-gpu-index]').count(),MACHINES[0].cards);
 for(const machine of MACHINES.slice(1)){
  assert.equal(await card(member,machine.id).locator('[data-gpu-index]').count(),0);
  assert.equal(await card(member,machine.id).locator('details[data-resource-detail]').count(),0);
 }
 const anonymousDetail=member.locator('details[data-resource-detail="gpu-1:0"]');await anonymousDetail.locator(':scope > summary').click();
 const anonymousProcessText=await anonymousDetail.locator('.process-table').textContent();
 assert.match(anonymousProcessText,new RegExp(String(processPid)));assert.match(anonymousProcessText,/8192/);
 assert.deepEqual(await anonymousDetail.locator('.process-table th').allTextContents(),['PID','任务 / 提交者 / 描述','显存 MiB','优先级']);
 assert.match(anonymousProcessText,/外部进程／未确认归属/);
 const memberResourceText=await member.locator('#machine-grid').textContent();
 assert.ok(!memberResourceText.includes(processOwner));assert.ok(!memberResourceText.includes(processName));
 assert.equal(await member.locator('.node-queue').count(),1);
 assert.match(await member.locator('.node-queue').textContent(),/0 条/);
 assert.equal(await member.locator('.node-queue [data-job-logs],.node-queue [data-job-cancel]').count(),0);
 const memberState=await member.evaluate(async()=>{
  const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'state',args:{}})});
  if(!response.ok)throw Error(`State fetch failed: ${response.status}`);return (await response.json()).state;
 });
 assert.deepEqual(memberState.gpuq.hosts.map(host=>host.id),['gpu-1']);
 assert.ok(!JSON.stringify(memberState.gpuq).includes(processOwner));assert.ok(!JSON.stringify(memberState.gpuq).includes(processName));
 await capture(member,'resources-member-desktop.png');
 await member.setViewportSize({width:390,height:844});
 await capture(member,'resources-member-mobile.png');
 const mobileLayout=await member.evaluate(()=>({width:innerWidth,pageWidth:document.documentElement.scrollWidth,
  overflow:[...document.querySelectorAll('body *')].filter(element=>{
   const bounds=element.getBoundingClientRect();return bounds.width>0&&(bounds.left<0||bounds.right>innerWidth+1);
  }).slice(0,12).map(element=>({tag:element.tagName,id:element.id,className:element.className,right:Math.round(element.getBoundingClientRect().right)})),
 }));
 assert.ok(mobileLayout.pageWidth<=mobileLayout.width+1,`Mobile resource layout must not overflow the page: ${JSON.stringify(mobileLayout)}`);
 await selectResource(member,'gpu-1',{metrics:true});
 assert.equal(await anonymousDetail.evaluate(element=>element.open),true);
 const mobileTable=resourceDetail(member,'gpu-1').locator('.gpu-table-scroll').first();
 await mobileTable.evaluate(element=>{element.scrollLeft=element.scrollWidth;});
 const tableBounds=await mobileTable.boundingBox(),processBounds=await anonymousDetail.locator('.process-table').boundingBox();
 assert.ok(processBounds.x>=tableBounds.x-1&&processBounds.x+processBounds.width<=tableBounds.x+tableBounds.width+1,'Mobile users must be able to scroll to the process columns');
 await capture(member,'resources-member-mobile-processes.png');
 await member.setViewportSize({width:1440,height:1050});
 await member.locator('#resource-primary').click();await member.waitForFunction(()=>document.querySelector('[name=workspace-machine]').value==='gpu-1');await openSubmit(member);await member.locator('[name=command]').fill('python unchanged_draft.py');await member.waitForTimeout(16000);assert.equal(await member.locator('[name=command]').inputValue(),'python unchanged_draft.py');
 await admin.locator('#filter-all').click();await admin.locator('[data-user]').filter({hasText:'验收同学'}).click();await admin.locator('summary').filter({hasText:'账号权限与状态'}).click();await admin.locator('[data-action=role]').click();await admin.locator('#confirm-action').click();
 await member.reload();await member.locator('#login-dialog').waitFor();await member.locator('#login-form [name=username]').fill('验收同学');await member.locator('#login-form [name=password]').fill(password);await member.locator('#login-form [type=submit]').click();await member.locator('[data-nav=users]').click();await member.locator('#filter-all').click();await member.locator('[data-user]').filter({hasText:'管理员'}).filter({hasNotText:'验收同学'}).click();await member.locator('summary').filter({hasText:'账号权限与状态'}).click();await member.locator('[data-action=enabled]').click();await member.locator('#confirm-action').click();await member.locator('summary').filter({hasText:'账号权限与状态'}).click();await member.locator('[data-action=delete]').click();await member.locator('#confirm-action').click();
 await member.locator('#confirm-dialog').waitFor({state:'hidden'});assert.equal(portal.service.store.users.some(u=>u.username==='admin'),false);
 if(process.env.UI_SCREENSHOTS){await capture(member,'users-desktop.png');await member.setViewportSize({width:390,height:844});await member.locator('[data-nav=resources]').click();await capture(member,'resources-mobile.png');}
 assert.deepEqual(errors,[]);assert.deepEqual(blockedRequests,[]);console.log('UI PASS: local-only monitor fixtures, per-card metrics, process disclosure by role, preserved process panels, unknown/stale states, accessible guides, register, zero-quota resource directory, auto pending, grant, auto permissions, preserved drafts, readable invite, named admin, bootstrap retirement, mobile layout.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
