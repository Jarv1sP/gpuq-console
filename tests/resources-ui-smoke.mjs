// Actual Portal static/CSP headers with read-only synthetic browser API data.
// No production account, execution, terminal, SSH, database or network writes.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {accountMenu,refreshVisible} from './starbase-workflows.mjs';
import {resourceCard,resourceDetail,selectResource,closeResource} from './resources-workflows.mjs';

const directory=await mkdtemp(join(tmpdir(),'starbase-resources-'));
const screenshots=process.env.UI_SCREENSHOTS||join(directory,'screenshots');
const errors=[],external=[],violations=[],calls=[],checks=[];
const release='a'.repeat(64),privateProgram='PRIVATE-OS-PROGRAM',privateOwner='PRIVATE-OS-OWNER';
const member={id:'member',name:'陈思远',username:'chen-research',role:'member',enabled:true,approvedAt:'2026-10-04T00:00:00Z',total:8,limits:{'gpu-1':4,'gpu-2':2,'gpu-3':2}};
const admin={id:'admin',name:'实验室管理员',username:'admin',role:'admin',enabled:true,approvedAt:member.approvedAt,total:30,limits:Object.fromEntries(MACHINES.map(machine=>[machine.id,machine.cards]))};
const job={id:'11111111-1111-4111-8111-111111111111',machine:'gpu-1',project:'vision-baseline',release,userId:member.id,username:member.username,name:'baseline-lr3e-4',cards:2,state:'RUNNING',priority:'normal',schedulerPriority:2,assignedIndices:[0,1]};
const ownTask={id:job.id,name:job.name,description:'主训练实验',submitter:{name:member.name,username:member.username},state:'RUNNING',priority:'normal',assignedGpuIndices:[0,1]};
const otherTask={id:'22222222-2222-4222-8222-222222222222',name:'diffusion-ft',description:'对照实验',submitter:{name:'王可',username:'wang-research'},state:'RUNNING',priority:'normal',assignedGpuIndices:[2]};
let actor=member,sampleNumber=0,server,browser;
function snapshot(){
  const checkedAt=new Date(Date.now()+ ++sampleNumber*1000).toISOString();
  return {checkedAt,stale:false,hosts:MACHINES.map(machine=>({id:machine.id,reachable:machine.id!=='gpu-3',checkedAt,
    gpus:machine.id==='gpu-3'?[]:Array.from({length:machine.cards},(_,index)=>({index,model:machine.model,memoryTotalMiB:machine.id==='gpu-1'?32768:24576,memoryUsedMiB:index<2?machine.id==='gpu-1'?28672:22000:index===2?20480:512,utilization:index<2?97:index===2?73:0,temperatureC:index<3?71:33,powerDrawW:index<3?510:20,powerLimitW:575,processesAvailable:true,
      processes:index<3?[{pid:24018+index,name:privateProgram,owner:privateOwner,memoryUsedMiB:index<2?28672:20480,task:machine.id==='gpu-1'&&index<2?ownTask:otherTask,scheduling:{priority:2,jobId:'private-native-job'}}]:[]})),
    tasks:[ownTask,otherTask],gpuq:{connected:machine.id!=='gpu-3',health:machine.id==='gpu-3'?'unknown':'ok',observeOnly:machine.id==='gpu-2',jobs:[]}}))};
}
let monitor=snapshot();
const principal=()=>actor?{userId:actor.id,username:actor.username,role:actor.role}:null;
const state=()=>actor?{machines:MACHINES.filter(machine=>actor.role==='admin'||actor.limits[machine.id]>0),users:actor.role==='admin'?[admin,member]:[member],jobs:[job],executionEnabled:true,execution:{priorityCapabilities:{'gpu-1':true,'gpu-2':true}},taskMetadata:{version:1},gpuq:monitor}:null;
try{
  await mkdir(screenshots,{recursive:true});
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port,origin='http://127.0.0.1:'+port;await new Promise(resolve=>reserve.close(resolve));
  const bootstrap=join(directory,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Isolated-Resource-Browser-2026!'}),{mode:0o600});
  ({server}=await createPortalServer({database:join(directory,'portal.sqlite'),bootstrap,origin,secure:false}));
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1080}});
  await page.addInitScript(()=>{
    globalThis.resourceAnimations=[];globalThis.resourceCSP=[];
    document.addEventListener('securitypolicyviolation',event=>resourceCSP.push({directive:event.violatedDirective,blocked:event.blockedURI}));
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(frames,options){
      if(this.matches('.resource-fill,.resource-gpu-util,.resource-delta,.resource-sample-edge,.resource-chassis,#resource-sheet'))resourceAnimations.push({target:this.className||this.id,frames,options});
      return animate.call(this,frames,options);
    };
  });
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){external.push(url.href);return route.abort();}
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const data=request.postDataJSON();let result=null;
    if(url.pathname==='/api/login')actor=data.username==='admin'?admin:member;
    else{
      const {operation,args}=data;calls.push({operation,args});
      if(operation==='logout')actor=null;
      else if(operation==='state'){}
      else if(operation==='projects.list')result={projects:[{project:'vision-baseline',state:'READY',latestReadyRelease:release,releases:[{release,state:'READY'}]}]};
      else if(operation==='projects.status')result={project:'vision-baseline',state:'READY',latestReadyRelease:release,releases:[{release,state:'READY'}]};
      else if(operation==='datasets.list')result={datasets:[]};
      else if(operation==='datasets.catalog')result={machine:args.machine,machines:[{machine:args.machine,state:'ok'}],datasets:[]};
      else if(operation==='datasets.capacity')result={machine:args.machine,available:false};
      else if(operation==='community.info')result={enabled:true,capabilities:[]};
      else if(operation==='community.posts.list')result={posts:[],nextCursor:null};
      else throw Error('Resource acceptance cannot execute '+operation);
    }
    return route.fulfill({contentType:'application/json',body:JSON.stringify({result,token:'synthetic-local-session',state:state(),principal:principal()})});
  });
  const response=await page.goto(origin+'/#resources');
  async function refreshResources({background=false}={}){
    const [response]=await Promise.all([page.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='state'),background?page.evaluate(()=>document.querySelector('#refresh-state').click()):refreshVisible(page)]);
    assert.equal(response.status(),200);await response.finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    await page.waitForFunction(()=>document.querySelector('#sync-label').textContent.startsWith('已同步'));
  }
  assert.match(response.headers()['content-security-policy'],/default-src 'self'/,'Fonts inherit the existing same-origin CSP');
  await resourceDetail(page,'gpu-1').waitFor();await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('.resource-tower').count(),30);
  for(const machine of MACHINES)assert.equal(await resourceCard(page,machine.id).locator('.resource-tower').count(),machine.cards);
  assert.equal(await page.locator('[data-resource-selected]').count(),1);
  assert.equal(await page.locator('.resource-gpu').count(),1);
  assert.equal(await page.locator('.resource-chassis-bays .resource-tower').count(),8);
  assert.equal(await page.locator('.resource-chassis-linework .chassis-perforation circle').count()>0,true);
  assert.equal(await page.locator('.resource-mini-fleet .resource-card').count(),3);
  assert.equal(await page.locator('.resource-identity').textContent(),'GPU-1');
  assert.equal(await page.locator('#page-description').textContent(),'');
  assert.equal(await page.locator('.resource-process-list').getAttribute('open'),null);
  assert.equal(await page.locator('.resource-previous:not([hidden])').count(),0);
  await page.locator('[data-resource-info=memory]>summary').click();
  assert.match(await page.locator('[data-resource-info=memory]').textContent(),/柱高表示已用显存/);
  await page.locator('[data-resource-info=memory]>summary').click();
  assert.equal(await resourceCard(page,'gpu-1').locator('.resource-tower-bar.mine').count(),2);
  assert.equal(await resourceCard(page,'gpu-4').locator('.resource-tower-bar.locked').count(),8);
  assert.equal(await resourceCard(page,'gpu-4').locator('.resource-tower-bar.locked').first().evaluate(bar=>getComputedStyle(bar).backgroundImage),'none','Unauthorized cards use flat fill rather than the unknown hatch');
  assert.equal(await page.locator('[data-resource-root]').count(),0);
  assert.equal(await page.locator('.node-queue').getAttribute('open'),null);
  assert.equal(await page.locator('.resource-full-metrics').getAttribute('open'),null);
  assert.deepEqual(await page.locator('.resource-process-table th').allTextContents(),['GPU','PID','任务 / 提交者 / 描述','显存 MiB','优先级']);
  for(const hidden of [privateProgram,privateOwner,'private-native-job'])assert.ok(!(await page.locator('#machine-grid').textContent()).includes(hidden),hidden);
  assert.equal((await page.evaluate(()=>resourceAnimations)).length,0,'The first sample must be settled');
  const capture=async name=>{await page.waitForFunction(()=>!document.querySelector('#toast').classList.contains('visible')&&!document.querySelector('.object-transition-layer'));await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:join(screenshots,name+'.png'),animations:'disabled'});await page.screenshot({path:join(screenshots,name+'-full.png'),fullPage:true,animations:'disabled'});};
  const desktop=await page.evaluate(()=>({height:document.documentElement.scrollHeight,heroBottom:document.querySelector('.resource-fleet').getBoundingClientRect().bottom,primaryBottom:document.querySelector('#resource-primary').getBoundingClientRect().bottom,layout:[...document.querySelectorAll('.resource-portrait,.resource-mini-fleet,.resource-mini,.resource-legend,.resource-fleet-actions')].map(element=>({class:element.className,top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,position:getComputedStyle(element).position}))}));
  await capture('resources-member-1440');
  assert.ok(desktop.height<=2200,JSON.stringify(desktop));assert.ok(desktop.heroBottom<=900&&desktop.primaryBottom<=900,JSON.stringify(desktop));
  checks.push({desktop});

  // Motion requires both a real new sample and changed measured values.
  monitor=snapshot();Object.assign(monitor.hosts[0].gpus[0],{utilization:80,memoryUsedMiB:24000});
  await refreshResources();await page.waitForFunction(()=>document.querySelector('[data-resource-gpu="0"] .resource-gpu-util').textContent==='80%');
  let motions=await page.evaluate(()=>resourceAnimations);
  assert.ok(motions.some(item=>item.target==='resource-fill'&&item.options.duration===480));
  assert.ok(motions.some(item=>item.target==='resource-gpu-util'&&item.options.duration===220&&item.frames[0].transform==='translateY(-3px)'));
  assert.ok(motions.some(item=>item.target==='resource-sample-edge'&&item.options.duration===480));
  assert.equal(await page.locator('[data-resource-fill-key="gpu-1:0"]').evaluate(fill=>fill.parentElement.querySelector('.resource-previous').style.bottom),'87.5%');
  await capture('resources-new-sample-1440');
  let previous=motions.length;monitor.hosts[0].gpus[0].utilization=81;await refreshResources();
  assert.equal((await page.evaluate(()=>resourceAnimations)).length,previous,'Same sample is not a confirmed update');
  assert.equal(await page.locator('[data-resource-fill-key="gpu-1:0"]').evaluate(fill=>fill.parentElement.querySelector('.resource-previous').style.bottom),'87.5%','Polling the same sample preserves its previous-sample hairline');
  await page.emulateMedia({reducedMotion:'reduce'});monitor=snapshot();monitor.hosts[0].gpus[0].utilization=82;await refreshResources();
  motions=(await page.evaluate(()=>resourceAnimations)).slice(previous);
  assert.ok(motions.length);assert.ok(motions.every(item=>item.options.duration===150&&item.frames.every(frame=>!frame.transform&&!frame.height)));
  await page.emulateMedia({reducedMotion:'no-preference'});previous=(await page.evaluate(()=>resourceAnimations)).length;
  monitor=snapshot();monitor.hosts[0].gpus[0].processesAvailable=false;monitor.hosts[0].gpus[0].utilization=65;monitor.hosts[0].gpus[0].memoryUsedMiB=18000;await refreshResources();
  assert.equal((await page.evaluate(()=>resourceAnimations)).length,previous,'Unconfirmed readings and hatches stay still');
  assert.equal(await resourceCard(page,'gpu-1').locator('.resource-tower-bar.unknown').count(),1);
  monitor=snapshot();monitor.hosts[0].gpus.pop();await refreshResources();
  assert.equal(await resourceCard(page,'gpu-1').locator('.resource-tower-bar.unknown').count(),8);
  assert.match(await resourceDetail(page,'gpu-1').textContent(),/已采集 7 \/ 8 张/);
  await capture('resources-partial-1440');
  const partialHeight=await page.evaluate(()=>document.documentElement.scrollHeight);
  assert.ok(partialHeight<=2200,'Partial inventory must stay within the desktop height budget: '+partialHeight);
  checks.push({partialHeight});
  monitor=snapshot();monitor.hosts[0].gpus.push({...monitor.hosts[0].gpus[0]});await refreshResources();
  assert.equal(await page.locator('[data-gpu-index]').count(),0);assert.equal(await resourceCard(page,'gpu-1').locator('.resource-fill').count(),0);
  monitor=snapshot();monitor.stale=true;await refreshResources();
  assert.equal(await page.locator('.resource-gpu').count(),0);assert.equal(await page.locator('.resource-fill').count(),0);assert.match(await resourceDetail(page,'gpu-1').textContent(),/状态未知/);
  assert.equal(await page.locator('.resource-previous:not([hidden])').count(),0,'Stale samples cannot retain a trusted freshness hairline');
  assert.equal(await page.locator('.node-queue').count(),1,'Historical platform records stay available with a stale warning');
  await capture('resources-stale-1440');
  previous=(await page.evaluate(()=>resourceAnimations)).length;monitor=snapshot();await refreshResources();
  assert.equal((await page.evaluate(()=>resourceAnimations)).length,previous,'The first recovered sample is settled rather than animating from stale data');
  assert.equal(await page.locator('.resource-previous:not([hidden])').count(),0);
  await selectResource(page,'gpu-4');assert.equal(await page.locator('.resource-process-table').count(),0);assert.equal(await page.locator('.node-queue').count(),0);assert.match(await resourceDetail(page,'gpu-4').textContent(),/未授权/);
  assert.equal(await page.locator('[data-nav=community]').count(),1,'The contact action must not duplicate the room navigation');
  await page.locator('#resource-primary').click();assert.equal(await page.locator('[data-nav][aria-current=page]').count(),1);assert.equal(await page.locator('[data-nav][aria-current=page]').getAttribute('data-nav'),'community');await page.locator('[data-nav=resources]').click();
  await selectResource(page,'gpu-2');assert.match(await resourceCard(page,'gpu-2').textContent(),/仅观察/);
  await resourceCard(page,'gpu-2').locator('[data-resource-card="3"]').click();
  await selectResource(page,'gpu-1');await resourceCard(page,'gpu-1').locator('[data-resource-card="4"]').click();
  await selectResource(page,'gpu-2');assert.equal(await page.locator('[data-resource-card="3"]').getAttribute('aria-pressed'),'true');
  await selectResource(page,'gpu-1');assert.equal(await page.locator('[data-resource-card="4"]').getAttribute('aria-pressed'),'true');
  await resourceCard(page,'gpu-1').locator('[data-resource-card="0"]').click();await selectResource(page,'gpu-2');
  await page.locator('[data-resource-detail="gpu-2:processes"]>summary').click();await refreshResources();
  assert.equal(await page.locator('[data-resource-detail="gpu-2:processes"]').getAttribute('open'),'','Refreshing preserves the process disclosure opened by the user');
  assert.equal(await page.locator('[data-resource-selected]').getAttribute('data-resource-selected'),'gpu-2');

  // A server opened from Mission Control must target that same server in this room.
  await page.locator('[data-nav=work]').click();await page.locator('[name=workspace-machine]').selectOption('gpu-1');
  await page.keyboard.press('Control+k');await page.locator('#mission-control').waitFor();await page.locator('[data-control-machine=gpu-2]').click();
  assert.equal(await page.locator('[data-resource-selected]').getAttribute('data-resource-selected'),'gpu-2');
  const controlLanding=await page.evaluate(()=>({top:document.querySelector('.resource-fleet').getBoundingClientRect().top,heading:document.querySelector('.resource-identity').getBoundingClientRect().bottom,scroll:scrollY,maxScroll:document.documentElement.scrollHeight-innerHeight,height:innerHeight}));
  assert.ok(controlLanding.top>=60&&(controlLanding.top<120||Math.abs(controlLanding.scroll-controlLanding.maxScroll)<2)&&controlLanding.heading<controlLanding.height-60,'Mission Control reveals the selected detail below the navigation, respecting the end of the page: '+JSON.stringify(controlLanding));
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'gpu-1','Inspecting a server does not switch work context');
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('gpuq-terminal-state',{detail:{sessions:[{id:'synthetic-connected-terminal',userId:'member',machine:'gpu-1',project:'',detached:false,connectionState:'connected'}]}})));
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('#resource-primary').click();
  await page.waitForFunction(()=>document.querySelector('[data-nav=work]').getAttribute('aria-current')==='page');
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'gpu-1','Canceling terminal context confirmation must retain the server');
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('gpuq-terminal-state',{detail:{sessions:[]}})));
  await page.locator('[data-nav=resources]').click();await page.locator('#resource-primary').click();
  await page.waitForFunction(()=>document.querySelector('[name=workspace-machine]').value==='gpu-2');
  assert.ok(calls.some(call=>call.operation==='projects.list'&&call.args.machine==='gpu-2'));
  await page.locator('[data-nav=resources]').click();

  await page.setViewportSize({width:390,height:844});await selectResource(page,'gpu-1');await closeResource(page);await capture('resources-member-390');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    for(const id of ['memory','sample','quota']){
      const tip=page.locator(`[data-resource-info="${id}"]`);await tip.locator(':scope > summary').click();
      const box=await tip.locator('.resource-info-content').boundingBox();
      assert.ok(box.x>=0&&box.x+box.width<=width+1,`${id} tip must fit the ${width}px viewport: ${JSON.stringify(box)}`);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Opening an info tip must not widen the page');
      if(id==='quota'){await refreshResources({background:true});assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-resource-info]')?.dataset.resourceInfo),'quota','Background refresh preserves keyboard focus and the open explanation');assert.equal(await page.locator('[data-resource-info="quota"]').getAttribute('open'),'');}
      await page.locator(`[data-resource-info="${id}"]>summary`).click();
    }
  }
  await page.setViewportSize({width:390,height:844});
  previous=(await page.evaluate(()=>resourceAnimations)).length;
  await selectResource(page,'gpu-1');assert.equal(await page.locator('#resource-sheet').evaluate(element=>Math.round(element.getBoundingClientRect().height)),844);
  const bay=await page.locator('[data-resource-card="0"]').boundingBox();assert.ok(bay.width>=44&&bay.height>=44,'The phone hardware bays retain 44px tap targets');
  await page.locator('[data-resource-gpu-picker]').selectOption('1');assert.equal(await page.locator('[data-resource-gpu="1"]').count(),1);await page.locator('[data-resource-gpu-picker]').selectOption('0');
  assert.equal(await page.locator('#resource-sheet .resource-detail [data-use-machine]').count(),0,'The pinned footer owns the phone workspace action');
  assert.ok((await page.evaluate(()=>resourceAnimations)).slice(previous).some(item=>item.options.duration===350));
  await capture('resources-detail-member-390');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#resource-sheet[open]').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.resourceSelect),'gpu-1');
  await page.emulateMedia({reducedMotion:'reduce'});previous=(await page.evaluate(()=>resourceAnimations)).length;await selectResource(page,'gpu-1');
  const reduced=(await page.evaluate(()=>resourceAnimations)).slice(previous);assert.ok(reduced.length&&reduced.every(item=>item.options.duration===150&&item.frames.every(frame=>!frame.transform)));
  await closeResource(page);await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
  const footer=await resourceCard(page,'gpu-4').locator('.resource-fleet-state').boundingBox(),pill=await page.locator('#live-pill').boundingBox();
  if(pill)assert.ok(footer.y+footer.height<=pill.y,'The live pill never covers the last card actions');
  await page.setViewportSize({width:1440,height:1080});await accountMenu(page);await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor();
  assert.equal(await page.locator('[data-resource-root]').count(),0);assert.equal(await page.locator('.resource-process-table').count(),0,'Old principal data is cleared on logout');
  await page.locator('#login-form [name=username]').fill('admin');await page.locator('#login-form [name=password]').fill('Synthetic-Local-Password');await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=resources]').click();
  assert.equal(await page.locator('[data-resource-selected]').getAttribute('data-resource-selected'),'gpu-1','Identity changes discard the prior server selection');
  assert.equal(await page.locator('[data-resource-root]').count(),1);
  for(const visible of [privateProgram,privateOwner,'private-native-job'])assert.ok((await page.locator('.resource-process-table').textContent()).includes(visible),visible);
  assert.deepEqual(await page.locator('.resource-process-table th').allTextContents(),['GPU','PID','任务 / 提交者 / 描述','程序','系统用户','显存 MiB','优先级']);
  await capture('resources-admin-1440');
  await page.locator('[data-resource-root]').click();await page.locator('#host-maintenance').waitFor();
  assert.equal(await page.locator('#host-maintenance').getAttribute('open'),'');
  assert.equal(calls.filter(call=>call.operation.startsWith('terminal.')||call.operation.startsWith('jobs.')).length,0,'ROOT entry only reveals the existing administrator controls');
  await page.locator('[data-nav=resources]').click();await page.setViewportSize({width:390,height:844});await capture('resources-admin-390');await selectResource(page,'gpu-1');await capture('resources-detail-admin-390');
  assert.ok((await page.locator('[data-resource-root]').boundingBox()).height>=44,'Phone administrator actions retain a 44px target');
  violations.push(...await page.evaluate(()=>resourceCSP));
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(violations,[]);
  checks.push('exact physical slots','selected server only','member/admin process columns','confirmed own-task fills','stale/partial/invalid/unauthorized states','sample-gated motion and reduced fallback','Mission Control selection','terminal context cancel/accept','phone push, Escape and reserved live pill','identity reset','ROOT entry makes no execution call','Portal CSP and self-hosted assets');
  await writeFile(join(screenshots,'resources-checks.json'),JSON.stringify({checks,errors,external,violations},null,2));
  console.log(JSON.stringify({status:'passed',checks,screenshots}));
}finally{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(directory,{recursive:true,force:true});
}
