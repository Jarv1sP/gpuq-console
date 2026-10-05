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

const temp=await mkdtemp(join(tmpdir(),'r5-work-browser-'));
const shots=process.env.UI_SCREENSHOTS||'/tmp/r5-ui-smoke';
const [targetMachine,sourceMachine]=MACHINES.map(machine=>machine.id);
const password='Starbase-Local-Fixture-Only-2026!',release='a'.repeat(64);
const errors=[],outside=[],assets=[],calls=[],sessions=new Map();
let server,service,browser,releaseCatalog;
const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const origin='http://127.0.0.1:'+port;
const project={project:'vision-baseline',state:'READY',environmentMode:'shared',latestReadyRelease:release,releases:[{release,state:'READY'}]};
const status=()=>({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map((machine,position)=>({id:machine.id,checkedAt:new Date().toISOString(),reachable:position!==2,
  gpus:position===2?[]:Array.from({length:machine.cards},(_,index)=>({index,memoryTotalMiB:32768,memoryUsedMiB:index<2?16384:0,processesAvailable:true,processes:index<2?[{pid:1000+index,memoryUsedMiB:16384}]:[]})),
  gpuq:{connected:position!==2,health:position===2?'unknown':'ok',observeOnly:position===1,schedulableIndices:[0],jobs:[],capabilities:['priority-policy-v1','console-yield-v1','console-elastic-v1','console-placement-v1','console-sharing-v1','console-hami-v1','console-hami-sm-v1']}}))});
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(temp,'bootstrap'),statusPath=join(temp,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});await writeFile(statusPath,JSON.stringify(status()));
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects:[structuredClone(project)]};
    if(operation==='projects.verify')return {project:args.project,release:args.release,state:'READY'};
    if(operation==='projects.status')return structuredClone(project);
    if(operation==='datasets.list')return {datasets:machine===targetMachine?[{dataset:'tiny-local',ownerIds:[args.userId],versions:[{version:release,state:'READY',canPrepare:true,bytes:2048,files:1}]}]:machine===sourceMachine?[{dataset:'scans',ownerIds:[args.userId],versions:[{version:release,state:'READY',canPrepare:true,bytes:7*1024**3,files:120}]}]:[]};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3,guarded:true};
    if(operation==='transfers.capabilities')return {protocol:'lan-transfer-v1',enabled:true,sourceReady:true,sources:[sourceMachine]};
    if(operation==='datasets.status')return {dataset:args.dataset,version:args.version,state:'READY'};
    if(operation==='logs')return {text:'epoch 12/40 loss=0.438 val_acc=0.716\ncheckpoint saved\nTraining continues on the synthetic node.'};
    if(operation==='diagnostics')return {jobId:args.job.id,state:'COMPLETE',schedulerState:'FAILED',attempts:[],captures:[],historyAvailable:true,allocationHistory:[]};
    if(operation==='files.list')return {entries:[{name:'metrics.json',type:'file',size:32}]};
    if(operation==='terminal.open'){const id=args.mode==='reconnect'?args.id:randomUUID(),writerToken=randomUUID();sessions.set(id,{machine,...args,writerToken});return {id,writerToken};}
    if(operation==='terminal.exchange'){assert.ok(sessions.has(args.id));assert.equal(args.writerToken,sessions.get(args.id).writerToken);const data=Buffer.from('Synthetic local terminal · no shell executes.\r\n');return {offset:data.length,data:args.offset?'':data.toString('base64'),exited:false};}
    if(operation==='terminal.detach')return {detached:true};
    if(operation==='terminal.close'){sessions.delete(args.id);return {closed:true};}
    if(operation==='sync'){const job=service.store.jobs.find(row=>row.id===args.job.id);return {state:job.state,nodeJobId:'fixture-'+job.id,assignedIndices:job.assignedIndices||[],...(job.progress?.snapshot?{progress:{reported:true,stale:false,snapshot:{sequence:1,phase:'training',epochs_completed:job.progress.snapshot.epochsCompleted,epochs_total:40,steps_completed:null,steps_total:null,metrics:job.progress.snapshot.metrics,eta_seconds:900,severity:'info',updated_at:Date.now()/1000}}}:{}),...(job.latestAttempt?.startedAt?{latestAttempt:{id:job.latestAttempt.id,started_at:job.latestAttempt.startedAt,finished_at:null,exit_code:null}}:{})};}
    throw Error('Unexpected synthetic operation: '+operation);
  };
  ({server,service}=await createPortalServer({database:join(temp,'portal.db'),bootstrap,statusPath,origin,secure:false,bridge}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'chen-research',name:'陈思远',password})).result;
  const peer=(await service.invoke(admin.token,'users.create',{username:'another-member',password})).result;
  await service.invoke(admin.token,'users.create',{username:'li-research',name:'李明',password});
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:8,limits:Object.fromEntries(MACHINES.slice(0,3).map(machine=>[machine.id,Math.min(8,machine.cards)]))});
  const job=(name,state,cards=2,extra={})=>{const id=randomUUID();return {id,userId:member.id,username:member.username,name,description:'本地验收数据；不启动真实训练。',machine:targetMachine,cards,state,createdAt:Date.now()/1000-3600,project:project.project,release,priority:'normal',schedulerState:state,schedulerCheckedAt:Date.now()/1000,queueReason:state==='PENDING'?'等待合法空卡':'',spec:{id,argv:['python','train.py','--epochs','40']},...extra};};
  const running=job('baseline-lr3e-4','RUNNING',2,{assignedIndices:[0,1],latestAttempt:{id:'attempt-current',startedAt:Date.now()/1000-3255,finishedAt:null},progress:{reported:true,stale:false,snapshot:{epochsCompleted:12,epochsTotal:40,updatedAt:Date.now()/1000,etaSeconds:900,metrics:{loss:.438,val_acc:.716,lr:.0003}}}});
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
  async function capture(page,name,overlay=false){if(!overlay)await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});await page.waitForTimeout(400);await page.screenshot({path:join(shots,name+'.png'),fullPage:!overlay&&page.viewportSize().width>=760});}
  async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow, including during a transition');}

  const desktop=await pageFor(1440);await login(desktop,member.username);
  const requests=[];desktop.on('request',request=>{if(request.url()===origin+'/api/call'){const body=request.postDataJSON();requests.push(body);}});
  await desktop.locator('.wb-focal').waitFor();
  await desktop.locator('[name=workspace-machine]').selectOption(targetMachine);await desktop.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);await desktop.locator('[name=workspace-project]').selectOption(project.project);
  assert.equal(await desktop.locator('.r5-boundary-line').first().evaluate(n=>n.getAnimations().length),0,'no boundary motion on first load');
  assert.equal(await desktop.locator('#context-machine').getAttribute('title'),targetMachine);assert.ok((await desktop.locator('.cs-server').first().getAttribute('title')).startsWith(targetMachine));
  await capture(desktop,'r5-work-member-1440');
  await desktop.locator('.wb-focal [data-job-mission]').click();await desktop.locator('#job-mission').waitFor({state:'visible'});
  assert.equal(await desktop.locator('.r5-mission-percentage').innerText(),'30%');assert.equal(await desktop.locator('.mission-bay').count(),2);assert.match(await desktop.locator('[data-mission-elapsed]').innerText(),/^54:/);
  assert.equal(await desktop.locator('.r5-mission-metrics>div').count(),3);assert.equal(await desktop.locator('#job-mission .wb-trajectory time').count(),2);
  assert.doesNotMatch(await desktop.locator('#job-mission').innerText(),/FORBIDDEN-PEER|自报/);await capture(desktop,'r5-mission-member-1440',true);await desktop.keyboard.press('Escape');
  assert.equal(await desktop.locator('#job-mission').isVisible(),false);assert.equal(await desktop.locator('.wb-focal').getAttribute('data-workbench-job'),running.id);
  const preparing=rows.find(row=>row.state==='PREPARING_DATA');await desktop.locator('[data-workbench-job="'+preparing.id+'"] [data-job-focus]').click();assert.match(await desktop.locator('.wb-stage-hero').innerText(),/准备数据/);assert.equal(await desktop.locator('.wb-progress-number').count(),0);await capture(desktop,'r5-work-preparing-1440');
  await desktop.evaluate(()=>{window.boundaryCalls=[];const original=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(this.classList.contains('r5-boundary-line'))window.boundaryCalls.push({job:this.closest('[data-workbench-job]')?.dataset.workbenchJob,frames,options});return original.call(this,frames,options);};});
  const starting=rows.find(row=>row.state==='STARTING');await desktop.locator('[data-workbench-job="'+starting.id+'"] [data-job-focus]').click();starting.state='RUNNING';service.save();await refreshVisible(desktop);await desktop.waitForFunction(()=>document.querySelector('.wb-focal .st')?.textContent.includes('运行中'));
  const sweeps=await desktop.evaluate(id=>window.boundaryCalls.filter(row=>row.job===id),starting.id);assert.equal(sweeps.length,1,'only an observed STARTING → RUNNING diff sweeps');assert.equal(sweeps[0].options.duration,320);assert.equal(sweeps[0].frames[0].transform,'scaleX(0)');await refreshVisible(desktop);assert.equal(await desktop.evaluate(id=>window.boundaryCalls.filter(row=>row.job===id).length,starting.id),1,'unchanged refresh cannot repeat the sweep');starting.state='STARTING';service.save();await refreshVisible(desktop);await desktop.waitForFunction(()=>document.querySelector('.wb-stage-hero')?.textContent.includes('启动中'));
  await desktop.locator('[data-workbench-job="'+running.id+'"] [data-job-focus]').click();
  await desktop.keyboard.press('Control+k');await desktop.locator('#control-command').fill(targetMachine+' 两张卡 跑 python train.py 用 tiny-local');await desktop.keyboard.press('Enter');
  await desktop.locator('#control-data-version:not([disabled])').waitFor();assert.equal(await desktop.locator('#control-data-version').inputValue(),'');assert.equal(await desktop.locator('[data-natural-use]').isDisabled(),true);
  assert.equal(requests.filter(row=>row.operation==='jobs.submit').length,0,'parsing and lookup cannot submit');
  await desktop.locator('#control-data-version').selectOption(release);assert.equal(await desktop.locator('[data-natural-use]').isDisabled(),true);
  await desktop.locator('#control-confirm-fields').check();assert.equal(await desktop.locator('[data-natural-use]').isEnabled(),true);await capture(desktop,'r5-command-prefill-1440',true);
  await desktop.locator('[data-natural-use]').click();await desktop.locator('#work-submit').waitFor({state:'visible'});
  assert.equal(await desktop.locator('#train-form [name=cards]').inputValue(),'2');assert.equal(await desktop.locator('#train-form [name=command]').inputValue(),'python train.py');assert.equal(await desktop.locator('#train-form [name=datasets]').inputValue(),'tiny-local@'+release);assert.equal(await desktop.locator('[name=release]').inputValue(),release);
  assert.equal(requests.filter(row=>row.operation==='jobs.submit').length,0,'prefill cannot submit');
  await closeSubmit(desktop);await desktop.locator('[name=workspace-project]').selectOption('');await openSubmit(desktop);assert.equal(await desktop.locator('#train-form [type=submit]').isDisabled(),true,'parsed destination does not silently change');await desktop.locator('#clear-training-prefill').click();assert.equal(await desktop.locator('#train-form [type=submit]').isEnabled(),true);await closeSubmit(desktop);
  // Free fixture reservations only by confirmed scheduler states; no real task runs.
  for(const row of rows)if(row.id!==running.id&&!['FAILED','SUCCEEDED'].includes(row.state))row.state='SUCCEEDED';service.save();await refreshVisible(desktop);
  await desktop.locator('[name=workspace-project]').selectOption(project.project);await openSubmit(desktop);await desktop.locator('#train-form [name=name]').fill('receipt-local');
  let lost=true;const submitRequests=[];
  const loseReply=async route=>{const body=route.request().postDataJSON();if(body?.operation==='jobs.submit'){submitRequests.push(structuredClone(body.args));const response=await route.fetch();assert.equal(response.status(),200,await response.text());if(lost){lost=false;await route.abort('failed');}else await route.fulfill({response});}else await route.continue();};
  await desktop.route('**/api/call',loseReply);await desktop.locator('#train-form [type=submit]').click();await desktop.locator('[data-receipt-retry]').waitFor({state:'visible'});await desktop.waitForFunction(()=>!document.querySelector('[data-receipt-retry]').disabled);
  const persisted=service.store.jobs.filter(row=>row.name==='receipt-local');assert.equal(persisted.length,1);assert.match(await desktop.locator('#submit-summary').innerText(),/待确认/);await capture(desktop,'r5-submit-unconfirmed-1440',true);
  await desktop.locator('[data-receipt-retry]').click();await desktop.locator('[data-receipt-new-draft]').waitFor({state:'visible'});
  assert.equal(submitRequests.length,2);assert.deepEqual(submitRequests[1],submitRequests[0]);assert.equal(service.store.jobs.filter(row=>row.name==='receipt-local').length,1,'explicit retry cannot duplicate the accepted task');
  assert.match(await desktop.locator('#submit-summary').innerText(),new RegExp(persisted[0].id.slice(0,8)));assert.equal(await desktop.locator('#train-form [type=submit]').isDisabled(),true);await capture(desktop,'r5-submit-receipt-1440',true);await closeSubmit(desktop);assert.match(await desktop.locator('#submission-receipt').innerText(),/receipt-local/);await desktop.unroute('**/api/call',loseReply);
  await desktop.locator('[data-nav=datasets]').click();await desktop.locator('[name=dataset-machine]').selectOption(targetMachine);await desktop.locator('#datasets-refresh').click();await desktop.locator('[data-route-cell]').first().waitFor();
  const routeCell=desktop.locator('.dataset-card').filter({has:desktop.locator('h3',{hasText:/^scans$/})}).locator('[data-route-cell]').first();
  const prepared=[];const observePrepare=async route=>{const body=route.request().postDataJSON();if(body?.operation==='datasets.prepare'){prepared.push(body.args);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,result:{dataset:body.args.dataset,version:body.args.version,state:'PREPARING'}})});}else await route.continue();};await desktop.route('**/api/call',observePrepare);
  await desktop.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);await desktop.evaluate(()=>scrollTo(0,0));await routeCell.hover();await desktop.locator('.dataset-copy-route').waitFor({state:'visible'});assert.equal(await desktop.locator('.dataset-copy-route').innerText(),sourceMachine+' → '+targetMachine+' · 7.00 GiB');assert.doesNotMatch(await desktop.locator('.dataset-copy-route').innerText(),/实验室内网/);assert.equal(prepared.length,0,'hover is read-only');
  assert.equal(await desktop.locator('.dataset-matrix-heading [data-machine="'+targetMachine+'"]').getAttribute('title'),targetMachine);
  const band=await desktop.locator('[data-machine="'+targetMachine+'"].dataset-target').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().left,w:n.getBoundingClientRect().width,bg:getComputedStyle(n).backgroundColor})));assert.ok(band.length>=3&&band.every(n=>n.x===band[0].x&&n.w===band[0].w&&n.bg===band[0].bg));await capture(desktop,'r5-datasets-route-1440',true);assert.equal(await desktop.locator('.dataset-copy-route').isVisible(),true);
  await routeCell.click();await desktop.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);assert.deepEqual(prepared,[{machine:targetMachine,dataset:'scans',version:release}]);await desktop.unroute('**/api/call',observePrepare);
  const phone=await pageFor(390,true);await login(phone,member.username);await phone.locator('[data-nav=work]').click();await phone.locator('.wb-focal').waitFor();await capture(phone,'r5-work-member-390');await noOverflow(phone);
  await phone.locator('.wb-focal [data-job-mission]').click();await phone.locator('#job-mission').waitFor({state:'visible'});await capture(phone,'r5-mission-member-390',true);assert.ok(await phone.locator('#job-mission').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await phone.keyboard.press('Escape');
  await phone.keyboard.press('Control+k');await phone.locator('#control-command').fill(targetMachine+' 两张卡 跑 python train.py 用 tiny-local');await phone.keyboard.press('Enter');await phone.locator('#control-data-version:not([disabled])').waitFor();await phone.locator('#control-data-version').selectOption(release);await phone.locator('#control-confirm-fields').check();await capture(phone,'r5-command-prefill-390',true);assert.ok(await phone.locator('#mission-control').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await phone.keyboard.press('Escape');
  await phone.locator('[data-nav=datasets]').click();await phone.locator('#datasets-refresh').click();await phone.locator('[data-route-cell]').first().waitFor();await capture(phone,'r5-datasets-member-390');await noOverflow(phone);
  const authAdmin=await pageFor(1440);await login(authAdmin,'admin');await authAdmin.locator('[data-nav=work]').click();await capture(authAdmin,'r5-work-admin-1440');await authAdmin.locator('[data-nav=datasets]').click();await authAdmin.locator('#datasets-refresh').click();await authAdmin.locator('.dataset-matrix').waitFor();await capture(authAdmin,'r5-datasets-admin-1440');await authAdmin.setViewportSize({width:390,height:844});await capture(authAdmin,'r5-datasets-admin-390');await authAdmin.locator('[data-nav=work]').click();await capture(authAdmin,'r5-work-admin-390');await noOverflow(authAdmin);
  await desktop.locator('[data-nav=work]').click();await desktop.locator('.wb-focal [data-job-mission]').click();await desktop.evaluate(()=>document.querySelector('#switch-account').click());await desktop.locator('#job-mission').waitFor({state:'hidden'});assert.equal(await desktop.locator('#job-mission').innerText(),'');assert.equal(await desktop.locator('#submission-receipt').count(),0);
  assert.deepEqual(outside,[]);assert.deepEqual(errors.filter(message=>!message.includes('ERR_FAILED')&&!message.includes('Failed to fetch')),[]);assert.ok(assets.filter(row=>row.path.endsWith('.woff2')).every(row=>row.status===200));
  console.log(JSON.stringify({status:'passed',checks:['mission real attempt/allocated GPU/timeline/Escape/privacy','stage adaptive hero + one real state-boundary sweep','explicit Chinese parse/version/confirmation/target binding','lost submit reply + identical explicit idempotent retry + in-place receipt','operation column and read-only true-source route','1440/390 member/admin + reduced motion + CSP/self-hosted fonts'],screenshots:shots}));
}finally{
  releaseCatalog?.();await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));if(service&&!service.closing){clearInterval(service.executionTimer);await service.close();}await rm(temp,{recursive:true,force:true});
}
