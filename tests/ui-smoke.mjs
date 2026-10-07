import {openMembers} from './admin-members-workflows.mjs';
import {openSubmit} from './starbase-workflows.mjs';
import {resourceCard as card,resourceDetail,selectResource} from './resources-workflows.mjs';
import {verifyAuthentication,verifyPublicLoginInventoryPrivacy} from './auth-copy-acceptance.mjs';
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
 const blockedRequests=[],inventoryRequests=[];
 for(const p of [admin,member]){
  p.context().on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
  p.on('pageerror',e=>errors.push(e.message));
  p.on('request',request=>{if(new URL(request.url()).pathname==='/machines.js')inventoryRequests.push(p===admin?'admin':'member');});
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
 // Public login and registration must initialise without a private module
 // request or an expected-401 console error, including narrow phones.
 const publicRequests=[],publicConsole=[];
 const onPublicRequest=request=>publicRequests.push(new URL(request.url()).pathname);
 const onPublicConsole=message=>{if(message.type()==='error')publicConsole.push(message.text());};
 admin.on('request',onPublicRequest);admin.on('console',onPublicConsole);
 await admin.goto(origin);await admin.locator('#login-dialog').waitFor({state:'visible'});
 for(const width of [1440,390,320]){
  await admin.setViewportSize({width,height:width===1440?1000:844});
  await capture(admin,`login-public-${width}.png`);
  assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 await admin.locator('#open-register').click();await admin.locator('#register-dialog').waitFor({state:'visible'});
 await admin.locator('#back-to-login').click();await admin.locator('#login-dialog').waitFor({state:'visible'});
 assert.equal(publicRequests.includes('/machines.js'),false);assert.equal(publicRequests.includes('/model.js'),false);
 assert.equal(publicRequests.includes('/api/call'),false,'Public login should not probe authenticated state');
 assert.deepEqual(publicConsole,[]);
 admin.off('request',onPublicRequest);admin.off('console',onPublicConsole);
 await admin.setViewportSize({width:1440,height:1050});
 await login(admin,'admin');assert.deepEqual(inventoryRequests,[],'Admin uses the complete authenticated state catalogue');await capture(admin,'workbench-admin-desktop.png');
 const headerUser=portal.service.store.users.find(user=>user.username==='admin'),originalName=headerUser.name;
 const longName='超长账户名'.repeat(6)+'验证';headerUser.name=longName;portal.service.save();await refreshPage(admin);
 await admin.waitForFunction(name=>document.querySelector('#profile-name').textContent===name,longName);
 for(const width of [1440,390,320]){
  await admin.setViewportSize({width,height:width===1440?1050:844});await admin.evaluate(()=>document.fonts.ready);
  if(width<=360)await admin.waitForFunction(()=>document.querySelector('#app-topbar .wordmark').classList.contains('sm'));
  const header=await admin.evaluate(()=>{
   const selectors=['#app-topbar .brand','#app-topbar .guide-link','#refresh-state','#account-menu-toggle'];if(innerWidth>=760)selectors.push('#room-nav');
   const boxes=selectors.map(selector=>({selector,...document.querySelector(selector).getBoundingClientRect().toJSON()}));
   const name=document.querySelector('#profile-name'),style=getComputedStyle(name);
   return{width:innerWidth,pageWidth:document.documentElement.scrollWidth,boxes,nameWidth:name.clientWidth,nameFullWidth:name.scrollWidth,nameFont:parseFloat(style.fontSize),ellipsis:style.textOverflow,title:name.title};
  });
  assert.ok(header.pageWidth<=header.width+1,'long account name must not cause horizontal scrolling at '+width+': '+JSON.stringify(header));
  for(const box of header.boxes)assert.ok(box.x>=-1&&box.x+box.width<=width+1,'header target stays inside '+width+': '+box.selector);
  for(const [index,box] of header.boxes.entries())for(const other of header.boxes.slice(index+1))assert.ok(box.x+box.width<=other.x+1||other.x+other.width<=box.x+1||box.y+box.height<=other.y+1||other.y+other.height<=box.y+1,'header targets do not overlap at '+width+': '+box.selector+' / '+other.selector);
  assert.equal(header.title,longName,'the truncated account name keeps its full title');
  if(width===1440){assert.equal(header.ellipsis,'ellipsis');assert.ok(header.nameWidth<=12*header.nameFont+1&&header.nameFullWidth>header.nameWidth,'desktop account name is bounded and truncated');}
  if(process.env.UI_SCREENSHOTS){await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});await admin.screenshot({path:join(process.env.UI_SCREENSHOTS,'topbar-long-account-'+width+'.png'),fullPage:false});}
 }
 headerUser.name=originalName;portal.service.save();await refreshPage(admin);await admin.setViewportSize({width:1440,height:1050});
 assert.equal(await admin.locator('#profile-name').getAttribute('title'),originalName,'rerendering updates the full account-name title');
 await admin.locator('[data-nav=resources]').click();
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
 assert.ok(!processText.includes(processName));assert.ok(!processText.includes(processOwner),'Main compute uses the same process columns for every role');
 await capture(admin,'resources-admin-desktop.png');
 await admin.evaluate(()=>location.hash='#admin/tasks');await admin.locator('#admin-content .resource-full-metrics').waitFor();
 await admin.locator('#admin-content .resource-full-metrics>summary').click();
 const managedDetail=admin.locator('#admin-content details[data-resource-detail="gpu-1:0"]');
 await managedDetail.locator(':scope > summary').click();
 const managedProcessText=await managedDetail.locator('.process-table').textContent();
 assert.match(managedProcessText,new RegExp(String(processPid)));assert.match(managedProcessText,/8192/);
 assert.ok(managedProcessText.includes(processName));assert.ok(managedProcessText.includes(processOwner));
 await capture(admin,'admin-processes-desktop.png');await admin.locator('[data-nav=resources]').click();
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
 await openMembers(admin);assert.equal(await admin.locator('#add-user').count(),0);
 await admin.locator('.management-toolbar [data-action=invites]').click();
 const rotateInvite=admin.locator('#invites-dialog [data-action=rotate-invite].primary:visible');
 await rotateInvite.waitFor({state:'visible'});assert.equal(await rotateInvite.count(),1);
 assert.equal(await admin.locator('#invites-dialog .invite-actions .primary:visible').count(),1,'the invitation panel has one explicit generate/rotate operation');
 assert.equal(await rotateInvite.isEnabled(),true);await rotateInvite.click();await capture(admin,'members-invite-confirm-1440.png');await admin.locator('#confirm-action').click();const code=await admin.locator('#current-invite').inputValue();assert.ok(code.startsWith('GPUQ-U-'));
 await capture(admin,'members-invites-1440.png');await admin.setViewportSize({width:390,height:844});await capture(admin,'members-invites-390.png');await admin.setViewportSize({width:1440,height:1050});
 await admin.locator('[data-close=invites-dialog]').click();await admin.reload();await admin.locator('.management-toolbar [data-action=invites]').click();assert.equal(await admin.locator('#current-invite').inputValue(),code);await admin.locator('[data-close=invites-dialog]').click();
 await verifyAuthentication(member,origin,capture);
 await verifyPublicLoginInventoryPrivacy(browser,origin,capture);
 await member.goto(origin);await member.locator('#login-dialog .guide-link').waitFor();assert.equal(await member.locator('.guide-link').count(),1);
 await capture(member,'login-1440.png');await member.setViewportSize({width:390,height:844});await capture(member,'login-390.png');
 assert.deepEqual(await member.locator('#login-dialog').boundingBox(),{x:0,y:0,width:390,height:844});
 await member.locator('#open-register').click();await member.locator('#register-dialog .guide-link').waitFor();assert.equal(await member.locator('.guide-link').count(),1);
 await capture(member,'register-390.png');await member.setViewportSize({width:320,height:844});assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 for(const [name,value] of Object.entries({username:'验收同学',password,confirm:password,invite:code}))await member.locator(`#register-form [name=${name}]`).fill(value);
 assert.equal(await member.locator('#register-form [name=username]').evaluate(node=>parseFloat(getComputedStyle(node).fontSize)>=16),true);
 await member.setViewportSize({width:1440,height:1050});await capture(member,'register-1440.png');await member.locator('#register-form [type=submit]').click();await member.locator('#register-dialog').waitFor({state:'hidden'});
 assert.equal(await member.locator('#app-topbar .guide-link').count(),1,'the one public guide entry returns to the authenticated shell');
 assert.deepEqual(inventoryRequests,['member'],'Partial member state loads the protected directory only after successful registration and login');
 assert.equal(await member.locator('[data-nav=users]').count(),0);assert.equal(await member.locator('#page-resources').isVisible(),true);assert.match(await member.locator('#resource-summary').textContent(),/额度 0 张/);assert.equal(await member.locator('[data-use-machine]:enabled').count(),0);
 assert.equal(await member.locator('.resource-card').count(),MACHINES.length);
 assert.equal(await member.locator('[data-gpu-index]').count(),0);
 assert.equal(await member.locator('details[data-resource-detail]').count(),0);
 assert.ok(!(await member.locator('#machine-grid').textContent()).includes(processOwner));
 await capture(member,'resources-zero-quota-desktop.png');
 await checkGuide(member,'/guide');assert.equal(await member.locator('a[href="/guide/admin"]:visible').count(),0);
 // Verify automatic registration discovery, without pressing refresh.
 await admin.locator('[data-user]').filter({hasText:'验收同学'}).waitFor({timeout:22000});await admin.locator('[data-user]').filter({hasText:'验收同学'}).click();await admin.locator('[data-machine=gpu-1]').check();await admin.locator('[data-quota=gpu-1]').fill('2');await admin.locator('[data-quota=total]').fill('2');
 await admin.evaluate(()=>scrollTo(0,0));assert.equal(await admin.locator('#page-users [data-action=save-policy].primary:visible').count(),1);
 assert.equal(await admin.locator('#editor .editor-save .primary:visible').count(),1,'the quota editor has exactly one save/approve primary operation');
 assert.equal(await admin.locator('#editor [data-action=save-policy]').isEnabled(),true,'the valid quota draft is ready for approval');
 assert.equal(await admin.locator('#page-users [data-member-create].primary:visible').count(),1);assert.equal(await admin.locator('[data-member-create]').isDisabled(),true,'new accounts cannot discard an unsaved quota draft');
 const approval=await admin.locator('[data-action=save-policy]').boundingBox(),strip=await admin.locator('#control-strip').boundingBox();assert.ok(approval.y>=0&&approval.y+approval.height<strip.y,'approval is visible before scrolling to the per-server fields');
 assert.equal(await admin.locator('[data-permission-meter=gpu-1] .is-on').count(),2);
 await admin.locator('[data-quota=total]').fill('');assert.match(await admin.locator('#policy-summary').textContent(),/待校正/);assert.equal(await admin.locator('[data-permission-meter=gpu-1] .is-on').count(),2,'an invalid total does not erase the confirmed per-server draft');await admin.locator('[data-quota=total]').fill('2');
 for(const machine of MACHINES)assert.equal(await admin.locator('[data-permission-meter='+machine.id+'] i').count(),machine.cards);
 await capture(admin,'members-draft-1440.png');await admin.setViewportSize({width:390,height:844});assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await admin.waitForFunction(()=>document.querySelector('[data-nav=me]').getAttribute('aria-current')==='page');
 assert.equal(await admin.locator('[data-nav=me]').getAttribute('aria-current'),'page');assert.equal(await admin.locator('#page-users').isVisible(),true);
 await admin.locator('[data-quota=gpu-1]').focus();assert.equal(await admin.locator('[data-quota=gpu-1]').inputValue(),'2');
 await capture(admin,'members-draft-390.png');
 await admin.setViewportSize({width:320,height:844});await admin.evaluate(()=>scrollTo(0,0));
 await admin.waitForFunction(()=>document.querySelector('#app-topbar .wordmark').classList.contains('sm'));
 const brandBox=await admin.locator('#app-topbar .brand').boundingBox(),guideBox=await admin.locator('#app-topbar .guide-link').boundingBox();
 assert.ok(brandBox.x+brandBox.width<=guideBox.x,'320px brand and guide targets do not overlap');
 assert.equal(await admin.locator('#app-topbar .guide-link').getAttribute('aria-label'),'使用指南');
 assert.equal(await admin.locator('#app-topbar .guide-link').evaluate(node=>getComputedStyle(node).fontSize),'0px');
 assert.ok(guideBox.width>=44&&guideBox.height>=44,'the icon-only guide keeps a phone touch target');
 assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const footerControl=await admin.locator('#mobile-control #live-pill').isVisible();
 assert.equal(await admin.locator('.page-heading [data-shell-action=control]').isVisible(),!footerControl,'the member header has a fallback only when the footer control is absent');
 if(!footerControl){const title=await admin.locator('#page-title').boundingBox(),control=await admin.locator('.page-heading [data-shell-action=control]').boundingBox();assert.ok(control.x>=title.x+title.width&&Math.abs(control.y+control.height/2-title.y-title.height/2)<3,'fallback control shares the title row');}
 await admin.locator('[data-quota=gpu-1]').focus();await capture(admin,'members-draft-320.png');
 await admin.setViewportSize({width:1440,height:1050});
 await admin.waitForTimeout(16000);assert.equal(await admin.locator('[data-quota=gpu-1]').inputValue(),'2');assert.equal(await admin.evaluate(()=>document.activeElement.dataset.quota),'gpu-1','automatic refresh preserves the dirty editor and its focused field');await admin.locator('[data-action=save-policy]').click();
 await member.waitForFunction(()=>document.querySelector('#resource-summary').textContent.includes('额度 2 张'),{},{timeout:22000});
 await admin.setViewportSize({width:320,height:844});await admin.evaluate(()=>scrollTo(0,0));
 await admin.waitForFunction(()=>document.querySelector('#live-pill').hidden);
 const fallbackControl=admin.locator('.page-heading [data-shell-action=control]');
 assert.equal(await fallbackControl.isVisible(),true,'the member page keeps control access when the footer has no activity');
 const fallbackTitle=await admin.locator('#page-title').boundingBox(),fallbackBox=await fallbackControl.boundingBox();
 assert.ok(fallbackBox.x>=fallbackTitle.x+fallbackTitle.width&&Math.abs(fallbackBox.y+fallbackBox.height/2-fallbackTitle.y-fallbackTitle.height/2)<3,'the fallback control stays on the title row');
 await capture(admin,'members-saved-320.png');await admin.setViewportSize({width:1440,height:1050});
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
 await mobileTable.evaluate(async element=>{
  // Geometry must describe the opened sheet, not separate frames of its entrance.
  await Promise.all((element.closest('dialog')?.getAnimations()||[]).map(animation=>animation.finished.catch(()=>{})));
  element.scrollLeft=element.scrollWidth;
 });
 const {tableBounds,processBounds}=await anonymousDetail.evaluate(element=>({
  tableBounds:element.closest('.gpu-table-scroll').getBoundingClientRect().toJSON(),
  processBounds:element.querySelector('.process-table').getBoundingClientRect().toJSON(),
 }));
 assert.ok(processBounds.x>=tableBounds.x-1&&processBounds.x+processBounds.width<=tableBounds.x+tableBounds.width+1,`Mobile users must be able to scroll to the process columns: ${JSON.stringify({tableBounds,processBounds})}`);
 await capture(member,'resources-member-mobile-processes.png');
 await member.setViewportSize({width:1440,height:1050});
 await member.locator('#resource-primary').click();await member.waitForFunction(()=>document.querySelector('[name=workspace-machine]').value==='gpu-1');await openSubmit(member);await member.locator('[name=command]').fill('python unchanged_draft.py');await member.waitForTimeout(16000);assert.equal(await member.locator('[name=command]').inputValue(),'python unchanged_draft.py');
 await admin.locator('#filter-all').click();await admin.locator('[data-user]').filter({hasText:'验收同学'}).click();await admin.locator('summary').filter({hasText:'账号权限与状态'}).click();await admin.locator('[data-action=role]').click();await admin.locator('#confirm-action').click();
 await member.reload();await member.locator('#login-dialog').waitFor();await member.locator('#login-form [name=username]').fill('验收同学');await member.locator('#login-form [name=password]').fill(password);await member.locator('#login-form [type=submit]').click();await openMembers(member);await member.locator('#filter-all').click();await member.locator('[data-user]').filter({hasText:'管理员'}).filter({hasNotText:'验收同学'}).click();await member.locator('summary').filter({hasText:'账号权限与状态'}).click();await member.locator('[data-action=enabled]').click();await member.locator('#confirm-action').click();await member.locator('summary').filter({hasText:'账号权限与状态'}).click();await member.locator('[data-action=delete]').click();await member.locator('#confirm-action').click();
 await member.locator('#confirm-dialog').waitFor({state:'hidden'});assert.equal(portal.service.store.users.some(u=>u.username==='admin'),false);
 if(process.env.UI_SCREENSHOTS){await capture(member,'users-desktop.png');await member.setViewportSize({width:390,height:844});await member.locator('[data-nav=resources]').click();await capture(member,'resources-mobile.png');}
 assert.deepEqual(errors,[]);assert.deepEqual(blockedRequests,[]);console.log('UI PASS: local-only monitor fixtures, per-card metrics, process disclosure by role, preserved process panels, unknown/stale states, accessible guides, register, zero-quota resource directory, auto pending, grant, auto permissions, preserved drafts, readable invite, named admin, bootstrap retirement, mobile layout.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
