// Actual Portal/SQLite/cookies/CSP/assets in Chromium. Node observations and
// terminal output are synthetic; no shell, GPU, SSH or production mutation.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {accountMenu,closeSubmit,openSubmit,refreshVisible} from './starbase-workflows.mjs';

const temp=await mkdtemp(join(tmpdir(),'starbase-shell-browser-'));
const shots=process.env.UI_SCREENSHOTS||'/tmp/starbase-ui-smoke';
const password='Starbase-Local-Fixture-Only-2026!',release='a'.repeat(64);
const errors=[],outside=[],assets=[],calls=[],sessions=new Map();
let server,service,browser;
const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const origin='http://127.0.0.1:'+port;
const project={project:'vision-baseline',state:'READY',environmentMode:'shared',latestReadyRelease:release,releases:[{release,state:'READY'}]};
const status=()=>({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map((machine,position)=>({id:machine.id,checkedAt:new Date().toISOString(),reachable:position!==2,
  gpus:position===2?[]:Array.from({length:machine.cards},(_,index)=>({index,memoryTotalMiB:32768,memoryUsedMiB:index<2?16384:0,processesAvailable:true,processes:index<2?[{pid:1000+index,memoryUsedMiB:16384}]:[]})),
  gpuq:{connected:position!==2,observeOnly:position===1,schedulableIndices:[0],jobs:[],capabilities:['priority-policy-v1','console-yield-v1','console-elastic-v1','console-placement-v1','console-sharing-v1','console-hami-v1','console-hami-sm-v1']}}))});
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(temp,'bootstrap'),statusPath=join(temp,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});await writeFile(statusPath,JSON.stringify(status()));
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects:[structuredClone(project)]};
    if(operation==='projects.status')return structuredClone(project);
    if(operation==='logs')return {text:'epoch 12/40 loss=0.438 val_acc=0.716\ncheckpoint saved\nTraining continues on the synthetic node.'};
    if(operation==='diagnostics')return {jobId:args.job.id,state:'COMPLETE',schedulerState:'FAILED',attempts:[],captures:[],historyAvailable:true,allocationHistory:[]};
    if(operation==='files.list')return {entries:[{name:'metrics.json',type:'file',size:32}]};
    if(operation==='terminal.open'){const id=args.mode==='reconnect'?args.id:randomUUID(),writerToken=randomUUID();sessions.set(id,{machine,...args,writerToken});return {id,writerToken};}
    if(operation==='terminal.exchange'){assert.ok(sessions.has(args.id));assert.equal(args.writerToken,sessions.get(args.id).writerToken);const data=Buffer.from('Synthetic local terminal · no shell executes.\r\n');return {offset:data.length,data:args.offset?'':data.toString('base64'),exited:false};}
    if(operation==='terminal.detach')return {detached:true};
    if(operation==='terminal.close'){sessions.delete(args.id);return {closed:true};}
    if(operation==='sync'){const job=service.store.jobs.find(row=>row.id===args.job.id);return {state:job.state,nodeJobId:'fixture-'+job.id,assignedIndices:job.assignedIndices||[]};}
    throw Error('Unexpected synthetic operation: '+operation);
  };
  ({server,service}=await createPortalServer({database:join(temp,'portal.db'),bootstrap,statusPath,origin,secure:false,bridge}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'chen-research',name:'陈思远',password})).result;
  const peer=(await service.invoke(admin.token,'users.create',{username:'another-member',password})).result;
  await service.invoke(admin.token,'users.create',{username:'li-research',name:'李明',password});
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:8,limits:Object.fromEntries(MACHINES.slice(0,3).map(machine=>[machine.id,Math.min(8,machine.cards)]))});
  const job=(name,state,cards=2,extra={})=>{const id=randomUUID();return {id,userId:member.id,username:member.username,name,description:'本地验收数据；不启动真实训练。',machine:'gpu-1',cards,state,createdAt:Date.now()/1000-3600,project:project.project,release,priority:'normal',schedulerState:state,schedulerCheckedAt:Date.now()/1000,queueReason:state==='PENDING'?'等待合法空卡':'',spec:{id,argv:['python','train.py','--epochs','40']},...extra};};
  const running=job('baseline-lr3e-4','RUNNING',2,{assignedIndices:[0,1],progress:{reported:true,stale:false,snapshot:{epochsCompleted:12,epochsTotal:40,updatedAt:Date.now()/1000,etaSeconds:900,metrics:{loss:.438,val_acc:.716,lr:.0003}}}});
  const rows=[running,job('augmentation','STARTING'),job('ablation-dropout','PENDING'),job('data-preparation','PREPARING_DATA',1),job('previous-experiment','RUNNING',2,{cancelRequested:true}),job('failed-checkpoint','FAILED',1,{error:'训练进程退出；请查看持久诊断。',latestAttempt:{id:'fixture-attempt',exitCode:1,failureReason:'checkpoint path unavailable'}})];
  service.store.jobs.push(...rows,{...job('FORBIDDEN-PEER-TRAINING','RUNNING'),userId:peer.id,username:peer.username});service.save();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function pageFor(width,reduced=false){
    const context=await browser.newContext({viewport:{width,height:width<760?844:1080},reducedMotion:reduced?'reduce':'no-preference'});const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('401'))errors.push(message.text());});
    page.on('response',response=>{if(response.url().startsWith(origin)&&!new URL(response.url()).pathname.startsWith('/api/'))assets.push({path:new URL(response.url()).pathname,status:response.status()});});
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();outside.push(url.href);return route.abort();});
    return page;
  }
  async function login(page,username){await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.evaluate(()=>document.fonts.ready);}
  async function capture(page,name,overlay=false){await page.waitForTimeout(400);await page.screenshot({path:join(shots,name+'.png'),fullPage:!overlay&&page.viewportSize().width>=760});}
  async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow, including during a transition');}
  const desktop=await pageFor(1440);await login(desktop,member.username);
  await desktop.locator('.wb-focal').waitFor();assert.equal(await desktop.locator('.hero-frame:visible').count(),1);assert.equal(await desktop.locator('.wb-progress-number').innerText(),'30%');
  assert.equal(await desktop.locator('.wb-metrics>div').count(),3);assert.match(await desktop.locator('#self-summary').innerText(),/8 \/ 8/);assert.match(await desktop.locator('#self-summary').innerText(),/5/);
  assert.doesNotMatch(await desktop.locator('#my-job-table').innerText(),/FORBIDDEN-PEER/);
  assert.equal(await desktop.locator('#control-strip .cs-value').innerText(),'30%');
  const runColor=await desktop.evaluate(()=>{const probe=document.createElement('span');probe.style.color='var(--run)';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color;});assert.equal(await desktop.locator('#control-strip .st-run').first().evaluate(n=>getComputedStyle(n).color),runColor);
  assert.equal(await desktop.locator('#control-strip [aria-label="1 项运行中"]').count(),1);assert.equal(await desktop.locator('#control-strip [aria-label="1 项排队中"]').count(),1);assert.equal(await desktop.locator('#control-strip .is-open').count(),0);
  assert.ok(await desktop.evaluate(()=>document.fonts.check('96px Archivo')&&document.fonts.check('14px Geist')&&document.fonts.check('12px "Geist Mono"')));
  assert.equal(await desktop.locator('#control-strip').evaluate(n=>n.getBoundingClientRect().height),60);assert.ok(await desktop.evaluate(()=>document.documentElement.scrollHeight<=2200),'desktop workbench stays within its focus budget');await noOverflow(desktop);await capture(desktop,'work-member-1440');
  const stripBefore=await desktop.locator('#control-strip').boundingBox();
  await desktop.locator('#control-strip [data-control-section=jobs]').click();await desktop.locator('#mission-control').waitFor({state:'visible'});
  assert.equal(await desktop.locator('#control-suggestions .mc-recent-action').count(),3);assert.equal(await desktop.locator('#control-attention .mc-attention-item').count(),1);assert.doesNotMatch(await desktop.locator('#mission-control').innerText(),/FORBIDDEN-PEER|待审批/);
  await capture(desktop,'control-segment-member-1440',true);await desktop.keyboard.press('Escape');await desktop.locator('#mission-control').waitFor({state:'hidden'});
  await desktop.keyboard.press('Control+k');await desktop.locator('#control-command').fill('算力');await desktop.keyboard.press('Enter');assert.equal(await desktop.locator('#page-resources').isVisible(),true);
  assert.deepEqual(await desktop.locator('#control-strip').boundingBox(),stripBefore,'the control layer never travels with rooms');
  await desktop.locator('body').click({position:{x:10,y:200}});await desktop.keyboard.press('g');await desktop.keyboard.press('w');await desktop.locator('#page-work').waitFor({state:'visible'});
  await desktop.evaluate(()=>{window.savedContext=document.querySelector('[name=workspace-machine]');scrollTo(0,240);});const scroll=await desktop.evaluate(()=>scrollY);
  await desktop.locator('[data-nav=resources]').click();await desktop.locator('[data-nav=work]').click();assert.equal(await desktop.evaluate(()=>scrollY),scroll);assert.equal(await desktop.evaluate(()=>window.savedContext===document.querySelector('[name=workspace-machine]')),true);
  await desktop.evaluate(()=>scrollTo(0,0));await desktop.locator('[name=workspace-machine]').selectOption('gpu-1');await desktop.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);await desktop.locator('[name=workspace-project]').selectOption(project.project);
  await openSubmit(desktop);await desktop.locator('[name=release]').waitFor({state:'visible'});assert.equal(await desktop.locator('[name=release]').inputValue(),release);assert.equal(await desktop.locator('#work-submit').evaluate(n=>n.getBoundingClientRect().height),1080);
  const submitFooter=await desktop.locator('#train-form .sheet-footer').boundingBox();assert.ok(submitFooter.y+submitFooter.height<=1081&&submitFooter.y>900,'the primary action remains pinned inside the viewport');assert.ok(await desktop.locator('#train-form .sheet-scroll').evaluate(n=>n.scrollHeight>n.clientHeight));await capture(desktop,'submit-member-1440',true);
  for(const [selector,name] of [['#custom-scheduling>summary','scheduling'],['.training-advanced>details:nth-child(2)>summary','elastic'],['.training-advanced>details:nth-child(3)>summary','placement']]){
    await desktop.locator(selector).click();await desktop.locator('#work-submit-panel').waitFor({state:'visible'});assert.equal(await desktop.locator('#work-submit-panel .sheet-scroll input').first().getAttribute('form'),'train-form');await capture(desktop,'submit-'+name+'-1440',true);await desktop.locator('#close-submit-panel').click();assert.equal(await desktop.locator('#work-submit-panel').isVisible(),false);
  }
  await desktop.locator('#train-form .sheet-scroll').evaluate(n=>n.scrollTop=n.scrollHeight);await desktop.locator('.submit-cli summary').click();assert.match(await desktop.locator('#submit-command').innerText(),new RegExp(release));await capture(desktop,'submit-checks-cli-1440',true);await closeSubmit(desktop);
  await desktop.locator('.wb-focal .wb-job-name').click();await desktop.locator('.job-sheet').waitFor({state:'visible'});await desktop.locator('#job-log-preview').filter({hasText:'checkpoint saved'}).waitFor();assert.ok(new URL(desktop.url()).searchParams.get('job')===running.id);assert.equal(await desktop.locator('[data-job-tab][aria-selected=true]').getAttribute('data-job-tab'),'overview');assert.match(await desktop.locator('#job-overview-view').innerText(),new RegExp(running.id));
  await capture(desktop,'job-overview-member-1440',true);
  await desktop.locator('[data-job-tab=overview]').focus();await desktop.keyboard.press('ArrowRight');assert.equal(await desktop.locator('[data-job-tab=logs]').getAttribute('aria-selected'),'true');await capture(desktop,'job-logs-member-1440',true);
  await desktop.locator('[data-job-tab=diagnostics]').click();await desktop.locator('#job-diagnostic-view').filter({hasText:'本轮快照已保存'}).waitFor();await capture(desktop,'job-diagnostics-member-1440',true);
  await desktop.locator('[data-job-tab=output]').click();await desktop.locator('#workspace-result').filter({hasText:'metrics.json'}).waitFor();await capture(desktop,'job-output-member-1440',true);
  await desktop.locator('[data-job-tab=notes]').click();await desktop.locator('#drawer-task-note-form').waitFor();await capture(desktop,'job-notes-member-1440',true);await desktop.keyboard.press('Escape');await desktop.locator('.job-sheet').waitFor({state:'hidden'});assert.equal(new URL(desktop.url()).searchParams.has('job'),false);
  await desktop.locator('#terminal-open').click();await desktop.locator('.terminal-dialog').waitFor({state:'visible'});await capture(desktop,'terminal-member-1440',true);await desktop.locator('#terminal-collapse').click();const opens=calls.filter(row=>row.operation==='terminal.open').length;
  await desktop.locator('[data-nav=datasets]').click();await desktop.locator('#control-strip [data-control-session]').click();await desktop.locator('.terminal-dialog').waitFor({state:'visible'});assert.equal(calls.filter(row=>row.operation==='terminal.open').length,opens,'collapse keeps the same live terminal across rooms');await desktop.locator('#terminal-disconnect').click();
  await desktop.keyboard.press('Control+k');await capture(desktop,'control-command-member-1440',true);await desktop.keyboard.press('Escape');await desktop.locator('#mission-control').waitFor({state:'hidden'});
  // A real progress diff enables the live glyph. First render stays still.
  await desktop.locator('[data-nav=work]').click();const others=desktop.locator('.wb-scroll-list[aria-label="其他进行中的训练"]');await others.evaluate(n=>n.scrollTop=180);const listPosition=await others.evaluate(n=>n.scrollTop);running.progress.snapshot.epochsCompleted=13;service.save();await refreshVisible(desktop);await desktop.waitForFunction(()=>document.querySelector('.wb-progress-number').textContent==='32%');assert.equal(await desktop.locator('.wb-focal .st-run.is-live').count(),1);assert.equal(await others.evaluate(n=>n.scrollTop),listPosition,'polling preserves the compact list position');
  await accountMenu(desktop);await capture(desktop,'account-menu-member-1440',true);await desktop.locator('#edit-profile').click();await capture(desktop,'profile-member-1440',true);await desktop.getByRole('button',{name:'关闭姓名设置'}).click();
  await accountMenu(desktop);await desktop.locator('#switch-account').click();await desktop.locator('#login-dialog').waitFor({state:'visible'});assert.equal(await desktop.locator('#control-strip').isVisible(),false);assert.equal(await desktop.locator('.object-transition-layer').count(),0);assert.equal(await desktop.locator('#job-overview-view').textContent(),'');assert.equal(await desktop.locator('#mission-control-content').textContent(),'');
  const phone=await pageFor(390);await login(phone,member.username);await noOverflow(phone);assert.equal(await phone.locator('#live-pill').isVisible(),false);assert.equal(await phone.locator('#mobile-control #open-submit').count(),1);await capture(phone,'work-member-390');
  await openSubmit(phone);await capture(phone,'submit-member-390',true);await phone.keyboard.press('Escape');await phone.locator('#work-submit').waitFor({state:'hidden'});await phone.locator('.wb-focal .wb-job-name').click();await capture(phone,'job-overview-member-390',true);await phone.keyboard.press('Escape');await phone.locator('.job-sheet').waitFor({state:'hidden'});
  await phone.locator('[data-nav=me]').click();assert.equal(await phone.locator('#live-pill').isVisible(),true);await capture(phone,'me-member-390');
  const nav=await phone.locator('#room-nav').boundingBox(),pill=await phone.locator('#live-pill').boundingBox();assert.ok(pill.y+pill.height<=nav.y,'the live pill stays above the tab bar');
  await phone.locator('#live-pill').click();await phone.locator('#mission-control').waitFor({state:'visible'});assert.deepEqual(await phone.locator('#mission-control').boundingBox(),{x:0,y:0,width:390,height:844});await capture(phone,'control-member-390',true);await noOverflow(phone);await phone.keyboard.press('Escape');await phone.locator('#mission-control').waitFor({state:'hidden'});
  const adminPage=await pageFor(1440);await login(adminPage,'admin');await adminPage.keyboard.press('Control+k');await adminPage.locator('#control-attention').filter({hasText:'李明'}).waitFor();await capture(adminPage,'control-admin-1440',true);await adminPage.keyboard.press('Escape');await adminPage.locator('#mission-control').waitFor({state:'hidden'});
  await service.invoke(admin.token,'maintenance.set',{scope:'all',enabled:true,revision:0,reason:'本地验收维护横幅：暂停新任务，运行中任务继续。'});await refreshVisible(adminPage);await adminPage.locator('.maintenance-banner').waitFor();assert.equal(await adminPage.locator('.maintenance-settings').count(),1);await capture(adminPage,'maintenance-admin-1440');await adminPage.locator('.maintenance-settings summary').click();await capture(adminPage,'maintenance-settings-admin-1440');
  await refreshVisible(phone);assert.equal(await phone.locator('.maintenance-settings').count(),0);await phone.locator('[data-nav=work]').click();await capture(phone,'maintenance-member-390');
  await adminPage.setViewportSize({width:390,height:844});await noOverflow(adminPage);await capture(adminPage,'maintenance-admin-390');
  const reduced=await pageFor(390,true);await login(reduced,member.username);await reduced.locator('[data-nav=me]').click();assert.ok(await reduced.evaluate(()=>document.getAnimations().every(animation=>animation.effect.getKeyframes().every(frame=>!frame.transform||frame.transform==='none'))),'reduced motion never slides');await reduced.keyboard.press('Control+k');await reduced.locator('#mission-control').waitFor({state:'visible'});await capture(reduced,'control-reduced-motion-390',true);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);assert.ok(assets.every(asset=>asset.status<400));for(const font of ['Archivo','Geist','GeistMono'])assert.ok(assets.some(asset=>asset.path.includes(font)&&asset.path.endsWith('.woff2')));
  assert.ok(calls.every(row=>!['projects.publish','terminal.host-command','files.put','cancel'].includes(row.operation)),'acceptance uses read-only/synthetic node operations');
  console.log(JSON.stringify({status:'passed',checks:['real Portal/CSP/cookies/assets/fonts','owner-only control and drawers','persistent control/context/room scroll','command keyboard and tab navigation','submit and three second-level panels','logs/diagnostics/output/notes','terminal collapse preserves session across rooms','maintenance admin/member hook preservation','390px tabs/live pill/full-screen control','reduced motion and no outside requests'],screenshots:shots}));
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else service?.close();await rm(temp,{recursive:true,force:true});}
