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
import {guardedRoute} from './browser-route-guard.mjs';
import {freezeR5Clock,readMissionGeometry,assertMissionGeometry} from './r5-fixture-tools.mjs';
import {runR5FixtureRegression} from './r5-fixture-regression.mjs';

const temp=await mkdtemp(join(tmpdir(),'r5-work-browser-'));
const shots=process.env.UI_SCREENSHOTS||'/tmp/r5-ui-smoke';
const [targetMachine,sourceMachine]=MACHINES.map(machine=>machine.id);
const password='Starbase-Local-Fixture-Only-2026!',release='a'.repeat(64);
const errors=[],outside=[],assets=[],calls=[],sessions=new Map();
let server,service,browser,releaseCatalog,releaseInventory,datasetOwners=[];
const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const origin='http://127.0.0.1:'+port;
async function closeRoutedContext(context){
  // The handlers filter only known teardown errors. Drain them before closing;
  // unexpected transport errors and assertions must still fail the test.
  await Promise.all(context.pages().map(page=>page.unrouteAll({behavior:'wait'})));
  await context.unrouteAll({behavior:'wait'});
  await context.close();
}
async function datasetTarget(page,machine){
  // The initial upload view reveals its destination after selecting files.
  // Cache inspection instead follows the visible, shared server context.
  await page.locator('#context-machine').selectOption(machine);
  await page.waitForFunction(machine=>document.querySelector('[name=dataset-machine]').value===machine&&!document.querySelector('#datasets-refresh').disabled,machine);
}
async function datasetDetail(page,dataset){
  const row=page.locator('[data-v3-select="'+dataset+'"]');
  if(!await row.isVisible()&&await page.locator('[data-v3-back]').isVisible())await page.locator('[data-v3-back]').click();
  await row.click();await page.locator('#warehouse-inspector .v3-train').waitFor();
}
const project={project:'vision-baseline',state:'READY',environmentMode:'shared',latestReadyRelease:release,releases:[{release,state:'READY'}]};
const status=()=>({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map((machine,position)=>({id:machine.id,checkedAt:new Date().toISOString(),reachable:position!==2,
  gpus:position===2?[]:Array.from({length:machine.cards},(_,index)=>({index,memoryTotalMiB:(Number.parseFloat(machine.memory)||32)*1024,memoryUsedMiB:index<2?16384:0,processesAvailable:true,processes:index<2?[{pid:1000+index,memoryUsedMiB:16384}]:[]})),
  gpuq:{connected:position!==2,health:position===2?'unknown':'ok',observeOnly:position===1,schedulableIndices:[0],jobs:[],capabilities:['priority-policy-v1','console-yield-v1','console-elastic-v1','console-placement-v1','console-sharing-v1','console-hami-v1','console-hami-sm-v1']}}))});
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(temp,'bootstrap'),statusPath=join(temp,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});await writeFile(statusPath,JSON.stringify(status()));
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects:[structuredClone(project)]};
    if(operation==='projects.verify')return {project:args.project,release:args.release,state:'READY'};
    if(operation==='projects.status')return structuredClone(project);
    if(operation==='datasets.list'){
      assert.deepEqual(args,{userId:'builtin-admin',hostAdmin:true},'catalog discovery has a fixed metadata-only principal');
      assert.equal(datasetOwners.length,2,'fixture data grants belong to actual member and admin accounts');
      return {datasets:machine===targetMachine?[{dataset:'tiny-local',ownerIds:datasetOwners,versions:[{version:release,state:'READY',canPrepare:true,bytes:2048,files:1}]}]:machine===sourceMachine?[{dataset:'scans',ownerIds:datasetOwners,versions:[{version:release,state:'READY',canPrepare:true,bytes:7*1024**3,files:120}]}]:[]};
    }
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3,guarded:true};
    if(operation==='datasets.upload.routes')return {available:false,protocol:'dataset-upload-v1',reason:'not-configured',relayLimitBytes:256*1024**2};
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
  datasetOwners=[member.id,service.store.users.find(user=>user.username==='admin').id];
  const peer=(await service.invoke(admin.token,'users.create',{username:'another-member',password})).result;
  await service.invoke(admin.token,'users.create',{username:'li-research',name:'李明',password});
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:8,limits:Object.fromEntries(MACHINES.map(machine=>[machine.id,Math.min(8,machine.cards)]))});
  const job=(name,state,cards=2,extra={})=>{const id=randomUUID();return {id,userId:member.id,username:member.username,name,description:'本地验收数据；不启动真实训练。',machine:targetMachine,cards,state,createdAt:Date.now()/1000-3600,project:project.project,release,priority:'normal',schedulerState:state,schedulerCheckedAt:Date.now()/1000,queueReason:state==='PENDING'?'等待合法空卡':'',spec:{id,argv:['python','train.py','--epochs','40']},...extra};};
  const fixtureTime=Date.now();
  const running=job('baseline-lr3e-4','RUNNING',2,{assignedIndices:[0,1],latestAttempt:{id:'attempt-current',startedAt:fixtureTime/1000-3255,finishedAt:null},progress:{reported:true,stale:false,snapshot:{epochsCompleted:12,epochsTotal:40,updatedAt:fixtureTime/1000,etaSeconds:900,metrics:{loss:.438,val_acc:.716,lr:.0003}}}});
  const rows=[running,job('augmentation','STARTING'),job('ablation-dropout','PENDING'),job('data-preparation','PREPARING_DATA',1),job('previous-experiment','RUNNING',2,{cancelRequested:true}),job('failed-checkpoint','FAILED',1,{error:'训练进程退出；请查看持久诊断。',latestAttempt:{id:'fixture-attempt',exitCode:1,failureReason:'checkpoint path unavailable'}})];
  const adminRunning={...running,id:randomUUID(),userId:service.store.users.find(user=>user.username==='admin').id,username:'admin',name:'admin-baseline',spec:{id:randomUUID(),argv:['python','train.py']}};adminRunning.spec.id=adminRunning.id;
  service.store.jobs.push(...rows,adminRunning,{...job('FORBIDDEN-PEER-TRAINING','RUNNING'),userId:peer.id,username:peer.username});service.save();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function pageFor(width,reduced=false){
    const context=await browser.newContext({viewport:{width,height:width<760?844:1080},reducedMotion:reduced?'reduce':'no-preference'});const page=await context.newPage();await freezeR5Clock(page,fixtureTime);
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('401'))errors.push(message.text());});
    page.on('response',response=>{if(response.url().startsWith(origin)&&!new URL(response.url()).pathname.startsWith('/api/'))assets.push({path:new URL(response.url()).pathname,status:response.status()});});
    await context.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol)){await route.continue();return;}outside.push(url.href);await route.abort();}));
    return page;
  }
  async function login(page,username){await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.evaluate(()=>document.fonts.ready);}
  async function capture(page,name,overlay=false,fullPage=false){
    if(!overlay)await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});
    const viewport=page.viewportSize(),expand=fullPage&&!overlay&&viewport.width<760;
    if(expand)await page.setViewportSize({width:viewport.width,height:Math.ceil(await page.evaluate(()=>document.documentElement.scrollHeight))});
    try{await page.waitForTimeout(400);await page.screenshot({path:join(shots,name+'.png'),fullPage:!overlay&&(fullPage||viewport.width>=760)});}finally{if(expand)await page.setViewportSize(viewport);}
  }
  async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow, including during a transition');}

  // Production imports start with no inventory. Keep the member directory
  // pending to verify that constructors and mirrors tolerate that empty phase.
  const inventoryProbe=await pageFor(390),inventoryRequests=[];
  inventoryProbe.on('request',request=>{const path=new URL(request.url()).pathname;if(['/machines.js','/model.js'].includes(path))inventoryRequests.push(path);});
  const inventoryGate=new Promise(resolve=>{releaseInventory=resolve;});
  await inventoryProbe.route(/\/machines\.js\?login=/,guardedRoute(async route=>{await inventoryGate;await route.fallback();}));
  await inventoryProbe.goto(origin);await inventoryProbe.locator('#login-dialog').waitFor({state:'visible'});
  assert.deepEqual(inventoryRequests,[],'public R5 entry does not import the capacity directory or demo model');
  assert.equal(await inventoryProbe.locator('.resource-card').count(),0);
  const inventoryStarted=inventoryProbe.waitForRequest(request=>new URL(request.url()).pathname==='/machines.js');
  await inventoryProbe.locator('#login-form [name=username]').fill(member.username);await inventoryProbe.locator('#login-form [name=password]').fill(password);await inventoryProbe.locator('#login-form [type=submit]').click();
  await inventoryStarted;
  assert.equal(await inventoryProbe.locator('#login-dialog').isVisible(),true,'login waits for its protected directory');
  assert.equal(await inventoryProbe.locator('#context-machine option').count(),0,'empty inventory cannot retain a context ID');
  assert.equal(await inventoryProbe.locator('.resource-card').count(),0);
  releaseInventory();await inventoryProbe.locator('#login-dialog').waitFor({state:'hidden'});
  assert.deepEqual(inventoryRequests,['/machines.js'],'member directory is fetched only after authentication');
  assert.equal(await inventoryProbe.locator('.resource-card').count(),MACHINES.length,'the existing array reference receives the logged-in inventory');
  await inventoryProbe.locator('[data-nav=datasets]').click();assert.equal(await inventoryProbe.locator('[name=dataset-machine] option').count(),MACHINES.length);
  await inventoryProbe.evaluate(()=>document.querySelector('#switch-account').click());await inventoryProbe.locator('#login-dialog').waitFor({state:'visible'});
  assert.equal(await inventoryProbe.locator('#context-machine option').count(),0);
  assert.equal(await inventoryProbe.locator('.resource-card').count(),0);
  assert.equal(await inventoryProbe.locator('#dataset-catalog').textContent(),'');
  const loggedOutLabels=await inventoryProbe.evaluate(()=>[...document.querySelectorAll('.server-select-label')].map(node=>node.textContent));
  for(const machine of MACHINES)assert.ok(!loggedOutLabels.some(label=>label.includes(machine.id)),'logout clears mirrored server IDs: '+machine.id);
  await login(inventoryProbe,'admin');
  assert.deepEqual(inventoryRequests,['/machines.js'],'administrator uses state rather than importing the directory');
  await inventoryProbe.setViewportSize({width:1440,height:1080});await inventoryProbe.locator('[data-nav=users]').click();await inventoryProbe.locator('#filter-all').click();await inventoryProbe.locator('[data-user="'+member.id+'"]').click();
  assert.equal(await inventoryProbe.locator('[data-quota=total]').getAttribute('max'),String(MACHINES.reduce((sum,machine)=>sum+machine.cards,0)),'account capacity is recomputed after the empty login phase');
  assert.equal(await inventoryProbe.locator('[data-permission-meter]').count(),MACHINES.length);
  await closeRoutedContext(inventoryProbe.context());

  const desktop=await pageFor(1440);await login(desktop,member.username);
  const requests=[];desktop.on('request',request=>{if(request.url()===origin+'/api/call'){const body=request.postDataJSON();requests.push(body);}});
  await desktop.locator('.wb-focal').waitFor();
  await desktop.locator('[name=workspace-machine]').selectOption(targetMachine);await desktop.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);await desktop.locator('[name=workspace-project]').selectOption(project.project);
  assert.equal(await desktop.locator('.r5-boundary-line').first().evaluate(n=>n.getAnimations().length),0,'no boundary motion on first load');
  assert.equal(await desktop.locator('#context-machine').getAttribute('title'),targetMachine);assert.ok((await desktop.locator('.cs-server').first().getAttribute('title')).startsWith(targetMachine));
  await capture(desktop,'r5-work-member-1440');
  await desktop.locator('.wb-focal [data-job-mission]').click();await desktop.locator('#job-mission').waitFor({state:'visible'});
  assert.equal(await desktop.locator('.r5-mission-percentage').innerText(),'30%');assert.equal(await desktop.locator('.mission-bay').count(),2);assert.equal(await desktop.locator('[data-mission-elapsed]').innerText(),'54:15');
  assert.equal(await desktop.locator('.r5-mission-metrics>div').count(),3);assert.equal(await desktop.locator('#job-mission .wb-trajectory time').count(),2);
  assert.doesNotMatch(await desktop.locator('#job-mission').innerText(),/FORBIDDEN-PEER|自报/);
  assert.equal(await desktop.locator('#job-mission').innerText().then(text=>(text.match(/更新于/g)||[]).length),1);
  for(const hook of ['data-job-logs','data-job-output','data-job-cancel'])assert.equal(await desktop.locator('#job-mission ['+hook+']').count(),1);
  await desktop.locator('#job-mission [data-job-logs]').click();await desktop.locator('.job-log-dialog #job-main-log').filter({hasText:'epoch 12/40'}).waitFor();await desktop.keyboard.press('Escape');await desktop.locator('.job-log-dialog').waitFor({state:'hidden'});assert.equal(await desktop.locator('#job-mission').isVisible(),true);
  await desktop.locator('#job-mission [data-job-output]').click();await desktop.locator('.job-log-dialog #workspace-files').waitFor();await desktop.locator('.job-log-dialog #workspace-result').filter({hasText:'metrics.json'}).waitFor();await desktop.keyboard.press('Escape');await desktop.locator('.job-log-dialog').waitFor({state:'hidden'});
  let cancelPrompt='';desktop.once('dialog',async dialog=>{cancelPrompt=dialog.message();await dialog.dismiss();});await desktop.locator('#job-mission [data-job-cancel]').click();assert.match(cancelPrompt,/释放 2 张卡的额度/);assert.equal(requests.filter(row=>row.operation==='jobs.cancel').length,0,'dismissed mission cancellation cannot mutate');await capture(desktop,'r5-mission-member-1440',true);await desktop.keyboard.press('Escape');
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
  const loseReply=guardedRoute(async route=>{const body=route.request().postDataJSON();if(body?.operation==='jobs.submit'){submitRequests.push(structuredClone(body.args));const response=await route.fetch();assert.equal(response.status(),200,await response.text());if(lost){lost=false;await route.abort('failed');}else await route.fulfill({response});}else await route.fallback();});
  await desktop.route('**/api/call',loseReply);await desktop.locator('#train-form [type=submit]').click();await desktop.locator('[data-receipt-retry]').waitFor({state:'visible'});await desktop.waitForFunction(()=>!document.querySelector('[data-receipt-retry]').disabled);
  const persisted=service.store.jobs.filter(row=>row.name==='receipt-local');assert.equal(persisted.length,1);assert.match(await desktop.locator('#submit-summary').innerText(),/待确认/);await capture(desktop,'r5-submit-unconfirmed-1440',true);
  const maintenanceState=(await service.invoke(admin.token,'maintenance.status',{})).result;
  const paused=(await service.invoke(admin.token,'maintenance.set',{scope:targetMachine,enabled:true,reason:'本地验收：暂停提交',revision:maintenanceState.revision})).result;
  await refreshVisible(desktop);await desktop.waitForFunction(()=>document.querySelector('#submit-summary')?.textContent.includes('维护中'));assert.equal(await desktop.locator('[data-receipt-retry]').isDisabled(),true);assert.equal(submitRequests.length,1,'maintenance cannot retry an unresolved submission');
  await service.invoke(admin.token,'maintenance.set',{scope:targetMachine,enabled:false,revision:paused.revision});await refreshVisible(desktop);await desktop.waitForFunction(()=>document.querySelector('[data-receipt-retry]')&&!document.querySelector('[data-receipt-retry]').disabled);
  await desktop.locator('[data-receipt-retry]').click();await desktop.locator('[data-receipt-new-draft]').waitFor({state:'visible'});
  assert.equal(submitRequests.length,2);assert.deepEqual(submitRequests[1],submitRequests[0]);assert.equal(service.store.jobs.filter(row=>row.name==='receipt-local').length,1,'explicit retry cannot duplicate the accepted task');
  assert.match(await desktop.locator('#submit-summary').innerText(),new RegExp(persisted[0].id.slice(0,8)));assert.equal(await desktop.locator('#train-form [type=submit]').isDisabled(),true);await capture(desktop,'r5-submit-receipt-1440',true);await closeSubmit(desktop);assert.match(await desktop.locator('#submission-receipt').innerText(),/receipt-local/);await desktop.unroute('**/api/call',loseReply);
  await desktop.locator('[data-nav=datasets]').click();await datasetTarget(desktop,targetMachine);await datasetDetail(desktop,'scans');
  const prepared=[];const observePrepare=guardedRoute(async route=>{const body=route.request().postDataJSON();if(body?.operation==='datasets.prepare'){prepared.push(body.args);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,result:{dataset:body.args.dataset,version:body.args.version,state:'PREPARING'}})});}else await route.fallback();});await desktop.route('**/api/call',observePrepare);
  const inspector=desktop.locator('#warehouse-inspector'),sourceRow=inspector.locator('.v3-server').filter({has:desktop.locator('.v3-server-text>b[title="'+sourceMachine+'"]')}),targetRow=inspector.locator('.v3-server.cur');
  await sourceRow.hover();assert.equal(prepared.length,0,'inspecting the true READY source is read-only');
  assert.equal(await sourceRow.locator('.v3-server-text>b').getAttribute('title'),sourceMachine);
  assert.equal(await sourceRow.locator('.v3-server-text>span').textContent(),'已缓存');
  assert.equal(await sourceRow.locator('[data-v3-cache]').count(),0,'a READY source has no redundant cache operation');
  assert.equal(await targetRow.locator('.v3-server-text>b').getAttribute('title'),targetMachine);
  assert.equal(await targetRow.locator('[data-v3-cache]').isEnabled(),true,'a real permitted source unlocks preparation at the selected destination');
  assert.deepEqual(await inspector.locator('.v3-code code').allTextContents(),['--data scans@'+release,'/data2/scans']);
  assert.equal(await inspector.locator('.v3-lock').textContent(),'只读');
  assert.equal(await desktop.locator('.v3-server-chip:not(.v3-all)').count(),MACHINES.length);
  const serverCenters=await inspector.locator('.v3-server').evaluateAll(nodes=>nodes.map(node=>{const name=node.querySelector('.v3-server-text'),glyph=node.querySelector('.v3-g'),r=name.getBoundingClientRect(),g=glyph.getBoundingClientRect();return Math.abs(r.y+r.height/2-g.y-g.height/2);}));assert.ok(serverCenters.every(value=>value<=1),'server glyphs and names share one row centre');
  assert.equal(await inspector.locator('.v3-train [data-use-dataset]').isVisible(),true);
  assert.equal(await inspector.locator('.v3-train .v3-code').count(),2);
  assert.equal(await inspector.locator('.v3-server.cur').count(),1,'the selected destination is identified exactly once');
  assert.equal(await inspector.locator('.v3-server.cur [data-v3-cache]').getAttribute('data-v3-cache'),targetMachine);
  assert.equal(await desktop.locator('.workspace-context-heading .ui-info').count(),1);assert.equal(await desktop.locator('.wb-publish-control>.ui-info').count(),0);
  assert.match(await desktop.locator('.workspace-context-heading .ui-info-content').textContent(),/先完成上传并结束开发终端，再保存代码与环境版本。/);
  await capture(desktop,'r5-datasets-route-1440',true);
  await Promise.all([desktop.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='datasets.prepare'),targetRow.locator('[data-v3-cache]').click()]);await desktop.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);assert.deepEqual(prepared,[{machine:targetMachine,dataset:'scans',version:release}]);await desktop.unroute('**/api/call',observePrepare);
  const phone=await pageFor(390,true);await login(phone,member.username);await phone.locator('[data-nav=work]').click();await phone.locator('.wb-focal').waitFor();await capture(phone,'r5-work-member-390');await noOverflow(phone);
  await phone.locator('.wb-focal [data-job-mission]').click();await phone.locator('#job-mission').waitFor({state:'visible'});await capture(phone,'r5-mission-member-390',true);assert.ok(await phone.locator('#job-mission').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await phone.keyboard.press('Escape');
  await phone.keyboard.press('Control+k');await phone.locator('#control-command').fill(targetMachine+' 两张卡 跑 python train.py 用 tiny-local');await phone.keyboard.press('Enter');await phone.locator('#control-data-version:not([disabled])').waitFor();await phone.locator('#control-data-version').selectOption(release);await phone.locator('#control-confirm-fields').check();await capture(phone,'r5-command-prefill-390',true);assert.ok(await phone.locator('#mission-control').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await phone.keyboard.press('Escape');
  await phone.locator('[data-nav=datasets]').click();await phone.locator('#datasets-refresh').click();await phone.locator('[data-v3-select]').first().waitFor();await capture(phone,'r5-datasets-member-390');await noOverflow(phone);
  const authAdmin=await pageFor(1440);await login(authAdmin,'admin');await authAdmin.locator('[data-nav=work]').click();await capture(authAdmin,'r5-work-admin-1440');await authAdmin.locator('[data-nav=datasets]').click();await authAdmin.locator('#datasets-refresh').click();await authAdmin.locator('[data-v3-select]').first().waitFor();await capture(authAdmin,'r5-datasets-admin-1440');await authAdmin.setViewportSize({width:390,height:844});await capture(authAdmin,'r5-datasets-admin-390');await authAdmin.locator('[data-nav=work]').click();await capture(authAdmin,'r5-work-admin-390');await noOverflow(authAdmin);
  const reviewChecks=[];
  for(const [page,role,fixtureJob] of [[phone,'member',running],[authAdmin,'admin',adminRunning]])for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:width<760?844:1080});await page.locator('[data-nav=work]').click();await refreshVisible(page);await noOverflow(page);
    if(width===1440){const labels=await page.evaluate(()=>[...document.querySelectorAll('.cs-server-id .server-id-head')].map(n=>({text:n.textContent,available:n.clientWidth,required:n.scrollWidth})));assert.ok(labels.length===MACHINES.length&&labels.every(n=>n.required<=n.available+1),'desktop strip shows complete inventory names when room is available');}
    if(width<760){const fields=await page.locator('.wb-focal .wb-progress-meta>span').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,height:n.getBoundingClientRect().height,line:parseFloat(getComputedStyle(n).lineHeight)||parseFloat(getComputedStyle(n).fontSize)*1.8})));assert.ok(fields.length>=2&&fields.every(n=>n.height<=n.line+1),'phone progress facts remain on readable lines: '+JSON.stringify({role,width,fields}));}
    await capture(page,'r5-review-work-'+role+'-'+width);
    const hasFooter=await page.locator('#mobile-control').isVisible(),hasHeading=await page.locator('.heading-actions [data-shell-action=control]').isVisible();assert.equal(hasHeading,width<760?!hasFooter:true,'one consistent control entry on work');
    await page.keyboard.press('Control+k');await page.locator('#mission-control').waitFor();await capture(page,'r5-review-control-'+role+'-'+width,true);await page.keyboard.press('Escape');
    for(const inventory of MACHINES){
      fixtureJob.machine=inventory.id;service.save();await refreshVisible(page);await page.locator('[name=workspace-machine]').selectOption(inventory.id);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
      // A refresh can replace the label between lookup and boundingBox(). Read
      // the live nodes, text, styles and both rectangles in one browser task.
      const selection=await page.evaluate(()=>{
        const select=document.querySelector('#context-machine'),label=select.parentElement.querySelector('.server-select-label'),suffix=label.querySelector('.server-id-tail');
        const rect=node=>{if(!node.getClientRects().length)return null;const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};};
        return {name:label.textContent,color:getComputedStyle(select).color,suffix:suffix.textContent,box:rect(suffix),clip:rect(label)};
      });
      assert.equal(selection.name,inventory.id);assert.equal(selection.color,'rgba(0, 0, 0, 0)','native selected text does not overlap the middle-ellipsis label');if(selection.suffix){const {box,clip}=selection;assert.ok(box.width>0&&box.x>=clip.x-1&&box.x+box.width<=clip.x+clip.width+1,'compact selector retains the ID suffix');}
      await capture(page,'r5-review-context-'+role+'-'+width+'-'+inventory.id);
      const row=page.locator('[data-workbench-job="'+fixtureJob.id+'"]');await row.locator('[data-job-mission]').click();await page.locator('#job-mission').waitFor();await noOverflow(page);assert.ok(await page.locator('#job-mission').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
      const names=await page.evaluate(()=>[...document.querySelectorAll('#job-mission .server-id')].map(node=>node.textContent));assert.ok(names.includes(inventory.id));for(const hook of ['data-job-logs','data-job-output','data-job-cancel'])assert.ok(await page.locator('#job-mission ['+hook+']').isVisible());
      const geometry=await readMissionGeometry(page);assertMissionGeometry(geometry);const {timeline,body,lastDot}=geometry;assert.ok(Math.abs(timeline.x+timeline.width-(body.x+body.width))<=1);assert.ok(Math.abs(lastDot.x+lastDot.width-(body.x+body.width))<=1,'timeline reaches content edge');
      await capture(page,'r5-review-mission-'+role+'-'+width+'-'+inventory.id,true);await page.keyboard.press('Escape');
    }
    fixtureJob.machine=targetMachine;service.save();await refreshVisible(page);await page.locator('[name=workspace-machine]').selectOption(targetMachine);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
    await page.locator('[data-nav=datasets]').click();await datasetTarget(page,targetMachine);await page.locator('[data-v3-select]').first().waitFor();await noOverflow(page);assert.equal(await page.locator('.heading-actions [data-shell-action=control]').isVisible(),false,'dataset upload and transfer actions occupy the heading; control remains in the shared bottom layer');
    assert.equal(await page.locator('.dataset-matrix,.datasets-ledger-strip').count(),0,'one warehouse replaces the matrix and quota ledger');
    assert.equal(await page.locator('.v3-server-chip:not(.v3-all)').count(),MACHINES.length);
    assert.deepEqual(await page.locator('.v3-server-chip:not(.v3-all)').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.v3Filter,label:node.querySelector('.v3-server-name>span').textContent,title:node.title.split(' · ')[0]}))),MACHINES.map(row=>({id:row.id,label:row.id,title:row.id})));
    assert.equal(await page.locator('#datasets-capacity>div>strong').innerText(),'502 GiB');assert.equal(await page.locator('#datasets-capacity>div>small').innerText(),'共 1024 GiB');assert.equal(await page.locator('.dataset-library .hero-label').count(),0);
    assert.equal(await page.locator('[data-v3-select]').count(),2,'remote and local versions remain separate logical datasets');
    assert.equal(await page.locator('#page-datasets .dataset-cache-admin,#page-datasets [data-cache-pin-slot],#page-datasets [data-remove-more]').count(),0,'main components are identical for members and administrators');
    if(width<760){
      assert.equal(await page.locator('.help-links').isVisible(),false,'phone datasets have no detached footer information mark');
      assert.deepEqual(await page.locator('#warehouse-search').evaluate(node=>({height:node.getBoundingClientRect().height,font:getComputedStyle(node).fontSize})),{height:40,font:'14px'});
    }
    for(const dataset of ['scans','tiny-local']){
      await datasetDetail(page,dataset);const panel=page.locator('#warehouse-inspector');
      assert.deepEqual(await panel.locator('.v3-server-text>b').evaluateAll(nodes=>nodes.map(node=>node.title)),MACHINES.map(row=>row.id));
      assert.equal(await panel.locator('.v3-train [data-use-dataset]').count(),1);
      assert.equal(await panel.locator('.v3-train [data-use-dataset]').isEnabled(),true,'owned local READY or a real permitted source grants training with preparation');
      assert.deepEqual(await panel.locator('.v3-code code').allTextContents(),['--data '+dataset+'@'+release,'/data2/'+dataset]);
      assert.equal(await panel.locator('.v3-lock').textContent(),'只读');
      assert.equal(await panel.locator('.v3-server.cur').count(),1);
      if(dataset==='tiny-local')assert.equal(await panel.locator('.v3-server.cur [data-v3-cache]').count(),0,'local READY hides redundant preparation');
      else assert.equal(await panel.locator('[data-v3-cache="'+targetMachine+'"]').isEnabled(),true);
      const facts=await panel.locator('.v3-server').evaluateAll(nodes=>nodes.map(node=>{const name=node.querySelector('.v3-server-text'),glyph=node.querySelector('.v3-g'),r=name.getBoundingClientRect(),g=glyph.getBoundingClientRect(),text=node.querySelector('.v3-server-text>span');return {centred:Math.abs(r.y+r.height/2-g.y-g.height/2)<=1,stateHeight:text.getBoundingClientRect().height,line:parseFloat(getComputedStyle(text).lineHeight),nowrap:getComputedStyle(text).whiteSpace==='nowrap'};}));assert.ok(facts.every(row=>row.centred&&row.nowrap&&row.stateHeight<=row.line+1),'server facts remain aligned and readable');
      assert.ok(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'detail has no horizontal overflow');
      if(width<760){for(const action of await panel.locator('button:visible').all())assert.ok(await action.evaluate(node=>node.getBoundingClientRect().height>=44),'mobile detail actions retain distinct 44px targets');}
    }
    await datasetDetail(page,'scans');
    if(width===390){
      await page.locator('.v3-train [data-use-dataset]').evaluate(node=>globalThis.savedDatasetAction=node);
      await page.setViewportSize({width:1440,height:1080});await page.locator('.v3-list').waitFor({state:'visible'});
      assert.equal(await page.locator('.v3-train [data-use-dataset]').evaluate(node=>node===globalThis.savedDatasetAction),true,'resizing retains the same fixed-version training action');
      assert.equal(await page.locator('.v3-code code').first().textContent(),'--data scans@'+release);
      await page.setViewportSize({width,height:844});assert.equal(await page.locator('.v3-train [data-use-dataset]').evaluate(node=>node===globalThis.savedDatasetAction),true);
      assert.equal(await page.locator('.v3-inspector').isVisible(),true);assert.equal(await page.locator('.v3-list').isVisible(),false);
    }
    await capture(page,'r5-review-datasets-'+role+'-'+width,false,true);reviewChecks.push({role,width,inventory:MACHINES.map(row=>row.id)});
  }
  await writeFile(join(shots,'review-checks.json'),JSON.stringify(reviewChecks,null,2));
  await phone.route('**/api/call',observePrepare);await datasetDetail(phone,'scans');await Promise.all([phone.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='datasets.prepare'),phone.locator('[data-v3-cache="'+targetMachine+'"][data-dataset="scans"]').click()]);await phone.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);assert.equal(prepared.length,2);assert.deepEqual(prepared[1],{machine:targetMachine,dataset:'scans',version:release});await phone.unroute('**/api/call',observePrepare);
  await desktop.locator('[data-nav=work]').click();await desktop.locator('.wb-focal [data-job-mission]').click();desktop.once('dialog',async dialog=>{assert.match(dialog.message(),/释放 2 张卡的额度/);await dialog.accept();});await desktop.locator('#job-mission [data-job-cancel]').click();await desktop.waitForFunction(()=>document.querySelector('#job-mission .st')?.textContent.includes('正在取消'));assert.equal(requests.filter(row=>row.operation==='jobs.cancel').length,1);assert.equal(await desktop.locator('#job-mission [data-job-cancel]').isDisabled(),true);
  await desktop.evaluate(()=>document.querySelector('#switch-account').click());await desktop.locator('#login-dialog').waitFor({state:'visible'});await desktop.locator('#job-mission').waitFor({state:'hidden'});assert.equal(await desktop.locator('#job-mission').innerText(),'');assert.equal(await desktop.locator('#submission-receipt').count(),0);
  assert.deepEqual(outside,[]);assert.deepEqual(errors.filter(message=>!message.includes('ERR_FAILED')&&!message.includes('Failed to fetch')),[]);assert.ok(assets.filter(row=>row.path.endsWith('.woff2')).every(row=>row.status===200));
  console.log(JSON.stringify({status:'passed',checks:['empty pre-login inventory + delayed member directory + admin state + logout mirrors/capacity','mission real attempt/allocated GPU/timeline/Escape/privacy','stage adaptive hero + one real state-boundary sweep','explicit Chinese parse/version/confirmation/target binding','lost submit reply + identical explicit idempotent retry + in-place receipt','operation column and read-only true-source route','1440/390/320 member/admin + all inventory names + reduced motion + CSP/self-hosted fonts'],screenshots:shots}));
}finally{
  releaseInventory?.();releaseCatalog?.();if(browser)await Promise.all(browser.contexts().map(closeRoutedContext));await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));if(service&&!service.closing){clearInterval(service.executionTimer);await service.close();}await rm(temp,{recursive:true,force:true});
}
await runR5FixtureRegression(shots);
