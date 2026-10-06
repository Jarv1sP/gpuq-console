// Render the real Portal/CSP/fonts with disposable account and node replies.
// Geometry covers operational rooms; no production, shell, or GPU is used.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {layoutZooms,layoutWidths,layoutHeights} from './layout-geometry.mjs';
import {inspectOperationalGeometry,scanOperationalGeometry,revealOperationalTarget} from './operational-geometry.mjs';

const full=process.argv.includes('--full-scan'),before=process.argv.includes('--before');
const selected=process.env.POLISH_CASES?.split(',');
const output=process.env.UI_SCREENSHOTS||'/tmp/stargate-polish-operational';
const reportPath=process.env.POLISH_GEOMETRY_REPORT||join(output,before?'geometry-before.json':'geometry-after.json');
const inventory=process.env.POLISH_INVENTORY?JSON.parse(await readFile(process.env.POLISH_INVENTORY,'utf8')):
  MACHINES.map((row,index)=>({...row,id:'training-layout-'+(index+1)+'-long-id'}));
assert.equal(inventory.length,MACHINES.length);
const machine=inventory[0].id,release='a'.repeat(64),project='container-layout';
const temporary=await mkdtemp(join(tmpdir(),'operational-layout-'));
const password='Local-Operational-Layout-2026!',errors=[],outside=[],results=[];
let server,service,browser;
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));

const controls='button,input:not([type=checkbox]):not([type=radio]),textarea,select,summary,a[href]';
const roomSpec={
  controls,largeTargets:'[data-control-section],.cstrip .cs-seg',
  bottomReserve:[{content:'#main-content',controls:'#control-strip,#mobile-control,#room-nav'}],
};
const workSpec={...roomSpec,roots:['#page-work','#control-strip'],
  wideRows:[{minimumWidth:1100,parent:'#self-summary',children:':scope>div'}],
  leftEdges:[['.wb-focal .job-top','.wb-focal .subline','.wb-focal .wb-progress-hero','.wb-focal .wb-progress-line'],
    ['.workspace-context-heading','#project-create']],
  centers:[{parent:'.terminal-heading',children:'h3,.ui-info',wrap:true},
    {parent:'.wb-publish-control',children:':scope>*'},
    {parent:'.wb-ledger-head',children:':scope>*',wrap:true}],
  buttonRows:[{parent:'.terminal-controls'},{parent:'.wb-job-quick'},{parent:'.job-acts',wrap:true}],
  baselines:[{parent:'.wb-job-heading',children:'.st,.wb-job-name',wrap:true}],
  textContainment:['.project-environment-segments label>span','.cs-count-link>.st',
    '.wb-progress-number','.wb-progress-meta>span','.wb-metrics strong','#self-summary>div'],
  repeatedPadding:['.wb-job-compact'],repeatedGaps:['.terminal-controls'],
};
const computeSpec={...roomSpec,roots:['#page-resources','#control-strip'],
  largeTargets:roomSpec.largeTargets+',.resource-portrait .resource-select,.resource-tower',
  centers:[{parent:'.resource-hardware-caption',children:':scope>*',wrap:true},
    {parent:'.resource-mini .resource-select',children:':scope>*'}],
  tableColumns:[{rows:'.resource-process-table tr',cells:'th,td'}],
  numericCells:['.resource-process-table :is(th,td):is(:nth-child(1),:nth-child(2),:nth-last-child(2))'],
  textContainment:['.resource-bay-label','.resource-portrait-utils b'],
  buttonRows:[{parent:'.resource-detail-head'}],
};
const controlSpec={...roomSpec,roots:['#mission-control'],
  scrollGroups:['#mission-control .mc-body'],
  centers:[{parent:'.mc-footer-command',children:':scope>span,:scope>.ui-info'},
    {parent:'.mc-attention-heading',children:':scope>*',wrap:true}],
  buttonRows:[{parent:'.mc-row-actions'}],repeatedPadding:['.mc-attention-item'],
  scrollPanels:['#mission-control','.mc-body'],
};
const dialogSpec=(selector,scroll)=>({controls,roots:[selector],scrollPanels:selector==='#job-mission'?[selector]:[selector,scroll],scrollGroups:[scroll],
  nativeHelpRows:[selector+' #train-form label:has(.ui-info)'],
  textContainment:selector==='#job-mission'?['.r5-mission-percentage','.r5-mission-time strong','.r5-mission-metrics strong']:[],
  centers:[{parent:selector+' .sheet-header',children:':scope>*',wrap:true},
    {parent:selector+' #train-form .field-caption',children:':scope>span,:scope>.ui-info>summary'}],
  buttonRows:[{parent:selector+' .sheet-footer',children:'button'}],
});
const scenes=[
  ...['member','admin'].flatMap(role=>[
    ...['work','compute','control'].flatMap(room=>['normal','empty','loading','error','unknown','maintenance'].map(state=>({role,room,state,name:role+'-'+room+'-'+state,
      spec:room==='work'?workSpec:room==='compute'?computeSpec:controlSpec}))),
    ...['work','control'].map(room=>({role,room,state:'counts',name:role+'-'+room+'-all-counts',spec:room==='work'?workSpec:controlSpec})),
    ...['work','fullscreen'].map(room=>({role,room,state:'complete-report',name:role+'-'+room+'-complete-report',
      spec:room==='work'?workSpec:dialogSpec('#job-mission','.r5-mission-body')})),
    {role,room:'compute',state:'normal',expanded:true,name:role+'-compute-processes',spec:computeSpec},
    ...['normal','error','unknown'].map(state=>({role,room:'fullscreen',state,name:role+'-fullscreen-'+state,spec:dialogSpec('#job-mission','.r5-mission-body')})),
    {role,room:'submit',state:'normal',name:role+'-submit',spec:dialogSpec('#work-submit','#work-submit .sheet-scroll')},
    {role,room:'project',state:'normal',name:role+'-project',spec:workSpec},
    ...[['project-environment','#project-create .project-environment-choice'],['project-action','#project-create-form [type=submit]']].map(([name,selector])=>({role,room:'project',state:'normal',name:role+'-'+name,
      spec:{...workSpec,focusedTargets:[selector]}})),
    {role,room:'submit',state:'normal',name:role+'-submit-bottom',spec:{...dialogSpec('#work-submit','#work-submit .sheet-scroll'),focusedTargets:['#train-form [name=command]']}},
    ...['normal','error','ended'].map(state=>({role,room:'terminal',state,name:role+'-terminal-'+state,
      spec:{controls,roots:['.terminal-dialog'],scrollPanels:['.terminal-dialog','#terminal-screen .xterm-viewport'],
        nonvisualInputs:['#terminal-screen .xterm .xterm-helper-textarea'],
        viewportContainment:[{parent:'#terminal-screen',child:'#terminal-screen .xterm-screen,#terminal-screen .xterm-viewport'}],
        centers:[{parent:'.terminal-footer',children:':scope>*',wrap:true}],buttonRows:[{parent:'.terminal-dialog .modal-head>div'}]}})),
    ...[1.25,1.5].map(zoom=>({role,room:'work',state:'normal',zoom,toast:true,
      name:role+'-toast-'+zoom,spec:{...workSpec,textContainment:[...workSpec.textContainment,'#toast']}})),
    ...[['work','.wb-report-label .ui-info>summary'],['control','.mc-footer-command .ui-info>summary'],
      ['project','.ui-info:has(#environment-mode-note)>summary']].map(([room,help])=>({role,room,help,state:'normal',
        name:role+'-'+room+'-help',spec:{...(room==='control'?controlSpec:workSpec),
          viewportPanels:['.ui-info[open] .ui-info-content'],textContainment:['.ui-info[open] .ui-info-content']}})),
  ]),
  ...['work','control','compute'].map(room=>({role:'member',room,state:'normal',name:'member-'+room+'-reduced',reduced:true,
    spec:room==='work'?workSpec:room==='compute'?computeSpec:controlSpec})),
];

async function checkGeometryRegressions(){
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
  const markup=(footerTop,fontSize=13)=>`<style>body{margin:0;font-family:sans-serif}main{position:relative;width:300px}button{width:100px;height:40px;font-size:${fontSize}px}.scroll{height:100px;overflow:auto;position:relative}.scroll button{position:absolute;top:120px;left:0}footer{position:absolute;top:${footerTop}px}</style><main><div class="scroll"><button>Scrolled action</button></div><footer><button>Fixed action</button></footer></main>`;
  const spec={roots:['main'],controls:'button',scrollGroups:['.scroll']};
  try{
    await page.setContent(markup(120));
    assert.equal((await inspectOperationalGeometry(page,spec)).pass,true,'a fully scroll-clipped action does not overlap the visible footer');
    await page.locator('.scroll').evaluate(node=>node.scrollTop=60);
    await page.locator('footer').evaluate(node=>node.style.top='70px');
    assert.ok((await inspectOperationalGeometry(page,spec)).failures.some(row=>row.rule==='visible-overlap'),'partly visible scrolling actions cannot be covered by footer controls');
    await page.setContent(markup(120,10));
    assert.ok((await inspectOperationalGeometry(page,spec)).failures.some(row=>row.rule==='minimum-type'),'readable text below 11px still fails');
    await page.setViewportSize({width:320,height:700});await page.setContent(markup(120));
    assert.ok((await inspectOperationalGeometry(page,spec)).failures.some(row=>row.rule==='touch-height'),'40px controls still fail the phone touch-height rule');
    const terminalSpec={roots:['#terminal-screen'],scrollPanels:['.xterm-viewport'],
      viewportContainment:[{parent:'#terminal-screen',child:'.xterm-screen,.xterm-viewport'}]};
    await page.setContent('<style>#terminal-screen{position:relative;width:200px;height:100px;overflow:hidden}.xterm-viewport{position:absolute;inset:0;overflow:auto}.xterm-scroll-area{height:300px}.xterm-screen{position:absolute;inset:0;height:100px;pointer-events:none}</style><div id="terminal-screen"><div class="xterm-viewport"><div class="xterm-scroll-area"></div></div><div class="xterm-screen"></div></div>');
    assert.equal((await inspectOperationalGeometry(page,terminalSpec)).pass,true,'terminal scrollback is reachable in the actual scrolling viewport');
    await page.locator('.xterm-viewport').evaluate(node=>node.style.overflow='hidden');
    assert.ok((await inspectOperationalGeometry(page,terminalSpec)).failures.some(row=>row.rule==='unreachable-panel-content'),'hiding terminal scrollback still fails');
    await page.locator('.xterm-viewport').evaluate(node=>node.style.overflow='auto');
    await page.locator('.xterm-screen').evaluate(node=>node.style.height='140px');
    assert.ok((await inspectOperationalGeometry(page,terminalSpec)).failures.some(row=>row.rule==='viewport-content-clipping'),'visible terminal rows outside the viewport still fail');
    await page.setContent('<style>#terminal-screen{height:100px}.xterm-helper-textarea{position:absolute;opacity:0;height:20px}</style><div id="terminal-screen"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>');
    const engineSpec={roots:['#terminal-screen'],nonvisualInputs:['#terminal-screen .xterm .xterm-helper-textarea']};
    assert.equal((await inspectOperationalGeometry(page,engineSpec)).pass,true,'a transparent keyboard bridge is not a visible touch target');
    await page.locator('.xterm-helper-textarea').evaluate(node=>node.style.opacity='1');
    assert.ok((await inspectOperationalGeometry(page,engineSpec)).failures.some(row=>row.rule==='visible-engine-input'),'an engine input exposed as a visible control still fails');
    await page.setContent('<style>.caption{display:flex;align-items:center}.label{font:15px/24px sans-serif}.ui-info>summary{display:flex;width:44px;height:44px;margin-bottom:14px}</style><div class="caption"><span class="label">Training version</span><details class="ui-info"><summary>Info</summary></details></div>');
    const captionSpec={roots:['.caption'],nativeHelpRows:['.caption'],centers:[{parent:'.caption',children:':scope>span,:scope>.ui-info>summary'}]};
    assert.ok((await inspectOperationalGeometry(page,captionSpec)).failures.some(row=>row.rule==='inline-center'),'a disclosure margin that displaces the icon from its label is detected');
    await page.locator('.ui-info>summary').evaluate(node=>node.style.margin='0');
    assert.equal((await inspectOperationalGeometry(page,captionSpec)).pass,true,'the icon shares its label center without inherited disclosure margins');
    await page.locator('.ui-info').evaluate(node=>node.style.marginLeft='30px');
    assert.ok((await inspectOperationalGeometry(page,captionSpec)).failures.some(row=>row.rule==='help-label-gap'),'an explanation detached from its label still fails');
    await page.setViewportSize({width:1440,height:900});
    await page.setContent('<div class="readings" style="display:grid;grid-template-columns:1fr;width:300px"><div>Quota</div><div>Training</div><div>Servers</div></div>');
    const readingsSpec={roots:['.readings'],wideRows:[{minimumWidth:1100,parent:'.readings',children:':scope>div'}]};
    assert.ok((await inspectOperationalGeometry(page,readingsSpec)).failures.some(row=>row.rule==='wide-row-wrap'),'desktop summary readings cannot unexpectedly become a tall single column');
    await page.locator('.readings').evaluate(node=>node.style.gridTemplateColumns='repeat(3,1fr)');
    assert.equal((await inspectOperationalGeometry(page,readingsSpec)).pass,true,'desktop summary readings share one row');
    await page.setViewportSize({width:320,height:700});
    await page.setContent('<div class="popup" style="position:fixed;left:280px;top:680px;width:100px;height:100px">Full explanation</div>');
    const popupSpec={roots:['body'],controls:'button',viewportPanels:['.popup']};
    assert.ok((await inspectOperationalGeometry(page,popupSpec)).failures.some(row=>row.rule==='popup-clipping'),'a popup outside the viewport still fails');
    await page.locator('.popup').evaluate(node=>{node.style.left='16px';node.style.top='16px';});
    assert.equal((await inspectOperationalGeometry(page,popupSpec)).pass,true,'a fully reachable popup passes');
    await page.setContent('<button id="action" style="position:absolute;left:20px;top:20px;width:100px;height:44px">Create project</button><div id="cover" style="position:fixed;left:20px;top:20px;width:100px;height:44px"></div>');
    const targetSpec={roots:['body'],controls:'button',focusedTargets:['#action']};
    assert.ok((await inspectOperationalGeometry(page,targetSpec)).failures.some(row=>row.rule==='focused-target-covered'),'a focused action covered by another element still fails');
    await page.locator('#cover').evaluate(node=>node.remove());
    assert.equal((await inspectOperationalGeometry(page,targetSpec)).pass,true,'a reachable focused action passes');
  }finally{await context.close();}
}

try{
  await mkdir(output,{recursive:true});
  const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  ({server,service}=await createPortalServer({database:join(temporary,'db'),bootstrap,origin,secure:false,
    bridge:async()=>{throw Error('A layout fixture must not execute a node operation');}}));
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(new URL(origin).port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'operations-layout',name:'几何检查的很长成员姓名',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  const principals={admin:admin.principal,member:{userId:member.id,username:member.username,role:'member'}};
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  await checkGeometryRegressions();
  for(const scene of scenes.filter(row=>!selected||selected.includes(row.name)||selected.includes(row.room))){
    for(const zoom of scene.zoom?[scene.zoom]:full?layoutZooms:[1]){
      const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:zoom,reducedMotion:scene.reduced?'reduce':'no-preference'});
      const page=await context.newPage(),principal=principals[scene.role],state=structuredClone(service.state(principal));
      state.machines=structuredClone(inventory);state.executionEnabled=true;
      for(const user of state.users){user.limits=Object.fromEntries(inventory.map(row=>[row.id,row.cards]));user.total=30;}
      const checkedAt=new Date().toISOString();
      state.gpuq={checkedAt,stale:scene.state==='unknown',hosts:inventory.map((row,index)=>({id:row.id,checkedAt,reachable:scene.state==='error'&&index===0?false:true,
        gpus:Array.from({length:row.cards},(_,gpu)=>({index:gpu,model:row.model,memoryTotalMiB:32768,memoryUsedMiB:gpu<2?16384:0,utilization:gpu<2?93:0,temperatureC:45,
          processesAvailable:true,processes:gpu===0?[{pid:1234,memoryUsedMiB:16384,task:{id:'fixture-running',name:'长任务名称用于检查行高与表格边缘',state:'RUNNING',submitter:{name:member.name}}}]:[]})),
        gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[0],jobs:[],capabilities:['console-placement-v1','console-sharing-v1','console-hami-v1']}}))};
      const job=(id,status)=>({id,userId:principal.userId,username:principal.username,machine,project,release,name:'训练任务名称 · '+id,cards:2,state:status,priority:'normal',createdAt:Date.now()/1000-3600,
        spec:{id,argv:['python','train.py']},latestAttempt:{id:'attempt-'+id,...(status==='FAILED'?{finishedAt:Date.now()/1000-60,exitCode:1}:{})},
        ...(status==='RUNNING'?{startedAt:Date.now()/1000-3600,assignedIndices:[0,1],progress:{reported:true,stale:false,snapshot:{epochsCompleted:scene.state==='complete-report'?40:12,epochsTotal:40,updatedAt:Date.now()/1000,etaSeconds:900,metrics:{loss:.438,val_acc:.716,lr:.0003}}}}:{}),
        ...(status==='FAILED'?{error:'保存训练结果时出现错误，请查看日志与诊断。'}:{})});
      state.jobs=scene.state==='empty'?[]:scene.state==='error'?[job('fixture-failed','FAILED')]:scene.state==='unknown'?[job('fixture-unknown','UNKNOWN')]:
        [job('fixture-running','RUNNING'),job('fixture-queued','PENDING'),job('fixture-failed','FAILED')];
      if(scene.state==='counts')state.jobs.push(job('fixture-start','STARTING'),job('fixture-data','PREPARING_DATA'),
        {...job('fixture-cancel','RUNNING'),cancelRequested:true},job('fixture-unknown','UNKNOWN'));
      state.operationalMaintenance={version:1,revision:1,global:scene.state==='maintenance'?{reason:'存储检查；已有训练继续运行',since:checkedAt}:null,machines:{}};
      let logged=false,terminalCalls=0;const gates=[];
      page.on('pageerror',error=>errors.push({scene:scene.name,message:error.message}));
      await page.addInitScript(()=>{globalThis.operationalCSP=[];document.addEventListener('securitypolicyviolation',event=>operationalCSP.push(event.violatedDirective));});
      const reply=(route,result,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
      await context.route('**/*',guardedRoute(async route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);await route.abort();return;}
        if(url.pathname==='/machines.js'){await route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(inventory)+';'});return;}
        if(url.pathname==='/api/login'){logged=true;await reply(route,{principal,state});return;}
        if(url.pathname==='/api/call'){
          const {operation,args}=route.request().postDataJSON();let result;
          if(operation==='state'){if(logged&&scene.state==='loading')await new Promise(resolve=>gates.push(resolve));await reply(route,{state});return;}
          if(operation==='projects.list')result={projects:scene.state==='empty'?[]:[{project,state:'READY',environmentMode:'oci',latestReadyRelease:release,releases:[{release,state:'READY'}]}]};
          else if(operation==='projects.status')result={project,state:'READY',environmentMode:'oci',latestReadyRelease:release,releases:[{release,state:'READY'}]};
          else if(operation==='projects.quota')result={usedBytes:0,quotaBytes:1024**3};
          else if(operation==='maintenance.status')result=state.operationalMaintenance;
          else if(['datasets.list','datasets.catalog'].includes(operation))result={datasets:[],machines:inventory.map(row=>({machine:row.id,state:'ok'}))};
          else if(operation==='datasets.capacity')result={available:false};
          else if(['notifications.list','transfers.list'].includes(operation))result={items:[]};
          else if(operation==='transfers.capabilities')result={enabled:false};
          else if(operation==='terminal.open')result={id:args.key,clientId:args.clientId,writerToken:randomUUID(),mode:args.mode};
          else if(operation==='terminal.exchange'){
            if(++terminalCalls>1&&scene.state==='error'){await reply(route,{error:'输入结果未确认，请重连。'},503);return;}
            result={offset:12,data:terminalCalls===1?Buffer.from('Local xterm.\r\n').toString('base64'):'',exited:scene.state==='ended',exitCode:scene.state==='ended'?17:null};
          }else if(operation==='terminal.detach')result={detached:true};
          else throw Error('Unexpected layout fixture API: '+operation);
          await reply(route,{result,state});return;
        }
        await route.continue();
      }));
      try{
        await page.goto(origin);await page.locator('#login-form [name=username]').fill(principal.username);await page.locator('#login-form [name=password]').fill(password);
        await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
        await page.locator('[name=workspace-machine]').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
        if(scene.state!=='empty'){await page.locator('[name=workspace-project]').selectOption(project);await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled);}
        if(scene.state==='loading')await page.locator('#refresh-state').click();
        if(scene.room==='compute'){await page.locator('[data-nav=resources]').click();await page.locator('.resource-fleet').waitFor();}
        if(scene.expanded)await page.locator('#machine-grid .resource-process-list>summary').click();
        if(scene.state==='counts')await page.evaluate(({userId,machine,project})=>{
          document.dispatchEvent(new CustomEvent('gpuq-terminal-state',{detail:{sessions:[{id:'layout-known-session',userId,machine,project,connectionState:'connected',environmentMode:'oci'}]}}));
          document.dispatchEvent(new CustomEvent('gpuq-data-activities',{detail:{userId,complete:true,items:[{id:'layout-known-upload',userId,machine,kind:'upload',name:'几何检查数据任务',state:'UPLOADING'}]}}));
          const root=document.querySelector('#control-strip');
          for(const type of ['st-run','st-start','st-queue','st-prep','st-cancel','st-unk']){
            const count=root.querySelector('.cs-count-link>.'+type);if(!count||!count.getAttribute('aria-label'))throw Error('A confirmed activity count disappeared: '+type);
          }
        },{userId:principal.userId,machine,project});
        if(scene.room==='control'){await page.keyboard.press('Control+k');await page.locator('#mission-control').waitFor({state:'visible'});}
        if(scene.room==='fullscreen'){await page.locator('.wb-focal [data-job-mission]').click();await page.locator('#job-mission').waitFor({state:'visible'});}
        if(scene.room==='submit'){
          await page.locator('#open-submit').click();await page.locator('#work-submit').waitFor({state:'visible'});
          if(!before){
            assert.equal(await page.locator('#train-form label>.ui-info').count(),0,'field explanations belong to their label row, including training-version help');
            for(const name of ['task-description','priority','release','command','datasets']){
              const label=page.locator('#train-form label').filter({has:page.locator('[name='+name+']')});
              assert.equal(await label.locator(':scope>.field-caption .ui-info>summary').count(),1,'labelled '+name+' explanation is retained');
            }
          }
        }
        if(scene.room==='project'){await page.locator('#project-create>summary').click();await page.locator('[name=new-project]').fill('container-layout');await page.locator('[name=environment-choice][value=oci]').check();}
        if(scene.room==='terminal'){await page.locator('#terminal-open').click();await page.locator('.terminal-dialog').waitFor({state:'visible'});if(scene.state==='error')await page.locator('#terminal-connection-note').filter({hasText:'未确认'}).waitFor();if(scene.state==='ended')await page.locator('#terminal-connection-note').filter({hasText:'终端已结束'}).waitFor();}
        if(scene.help)await page.locator(scene.help).click();
        await page.evaluate(()=>document.fonts.ready);
        const toastMessage='服务器暂时没有确认这次操作；请保留原任务编号，重新查询后再决定下一步。错误详情：'+
          'unconfirmed-'.repeat(8)+'<完整错误信息保留到这一句>';
        if(scene.toast)await page.locator('#toast').evaluate((node,message)=>{node.textContent=message;node.classList.add('visible');},toastMessage);
        const caseRows=[];
        for(const width of [1440,390,320]){
          await page.setViewportSize({width:Math.floor(width/zoom),height:Math.floor((width<760?844:900)/zoom)});
          await page.evaluate(async()=>{for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
          if(scene.spec.focusedTargets?.length)await revealOperationalTarget(page,scene.spec.focusedTargets[0]);
          const measurement=await inspectOperationalGeometry(page,scene.spec);caseRows.push({physicalWidth:width,physicalHeight:width<760?844:900,zoom,...measurement});
          if(process.env.POLISH_DOM_REPORT){
            const geometry=await page.evaluate(selector=>{
              const rect=node=>{const box=node.getBoundingClientRect();return Object.fromEntries(['left','top','right','bottom','width','height'].map(key=>[key,box[key]]));};
              return [...document.querySelectorAll(selector)].filter(node=>node.getClientRects().length&&!node.closest('[hidden],details:not([open]) .ui-info-content')).map(node=>{
                const box=rect(node),x=(box.left+box.right)/2,y=(box.top+box.bottom)/2,hit=document.elementFromPoint(x,y);
                return {element:node.id||node.tagName+'.'+node.className,name:node.getAttribute('name'),rect:box,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,
                  padding:getComputedStyle(node).padding,overflow:getComputedStyle(node).overflow,font:getComputedStyle(node).fontSize,
                  clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,minWidth:getComputedStyle(node).minWidth,maxWidth:getComputedStyle(node).maxWidth,
                  margin:getComputedStyle(node).margin,width:getComputedStyle(node).width,
                  hit:hit?.id||hit?.tagName+'.'+hit?.className,hitSelf:!!hit&&(node===hit||node.contains(hit)),parent:node.parentElement?.id||node.parentElement?.className};
              });
            },'html,body,#toast,#work-submit .sheet-scroll,#work-submit .sheet-footer,#work-submit input,#work-submit select,#work-submit textarea,#work-submit button,#mission-control .mc-body,#mission-control .mc-footer,#mission-control .mc-row-name,#mission-control .mc-footer .ui-info>summary,#terminal-screen,#terminal-screen .xterm,#terminal-screen .xterm-viewport,#terminal-screen .xterm-screen,.terminal-dialog .modal-head,.terminal-footer');
            await writeFile(join(output,scene.name+'-'+width+'-dom.json'),JSON.stringify(geometry,null,2));
            if(scene.toast)await writeFile(join(output,scene.name+'-'+width+'-overflow.json'),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(node=>{
              const box=node.getBoundingClientRect();return box.width&&box.right>innerWidth+1||node.clientWidth&&node.scrollWidth>node.clientWidth+1;
            }).map(node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return {tag:node.tagName,id:node.id,class:String(node.className),left:box.left,right:box.right,top:box.top,width:box.width,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,overflow:style.overflow,clip:style.clip,clipPath:style.clipPath,visibility:style.visibility,closedAncestor:node.closest('details:not([open])')?.className};})),null,2));
          }
          if(zoom===1||scene.toast)await page.screenshot({path:join(output,scene.name+'-'+width+'.png'),animations:'disabled'});
        }
        if(scene.toast)for(let cssWidth=213;cssWidth<=256;cssWidth++){
          await page.setViewportSize({width:cssWidth,height:Math.floor(700/zoom)});
          const measurement=await inspectOperationalGeometry(page,scene.spec);
          const text=await page.locator('#toast').evaluate(node=>({text:node.textContent,
            fontSize:parseFloat(getComputedStyle(node).fontSize),height:node.clientHeight,scrollHeight:node.scrollHeight,
            lines:(()=>{const range=document.createRange();range.selectNodeContents(node);return range.getClientRects().length;})()}));
          assert.equal(text.text,toastMessage,'long error text must remain complete');
          assert.ok(text.fontSize>=11,'error text stays readable');
          if(!before){assert.ok(text.lines>1,'long errors wrap');assert.ok(text.scrollHeight<=text.height+1,'long error text remains reachable');}
          caseRows.push({cssWidth,physicalWidth:cssWidth*zoom,physicalHeight:700,zoom,toast:true,...measurement});
        }
        if(full)caseRows.push(...await scanOperationalGeometry(page,scene.spec,{widths:layoutWidths,heights:layoutHeights,zoom}));
        assert.deepEqual(await page.evaluate(()=>operationalCSP),[],'same-origin resources obey Portal CSP');
        results.push({scene:scene.name,room:scene.room,role:scene.role,zoom,rows:caseRows});
        await writeFile(reportPath,JSON.stringify({before,results,errors,outside},null,2));
        console.log(JSON.stringify({scene:scene.name,zoom,measurements:caseRows.length,failed:caseRows.filter(row=>!row.pass).length}));
      }finally{for(const release of gates)release();await context.unrouteAll({behavior:'wait'});await context.close();}
    }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  const failed=results.flatMap(result=>result.rows.filter(row=>!row.pass).map(row=>({scene:result.scene,zoom:result.zoom,...row})));
  if(!before)assert.deepEqual(failed,[],'all rendered layout relationships pass');
  console.log(JSON.stringify({status:failed.length?'BASELINE-DEFECTS':'PASS',scenes:results.length,measurements:results.reduce((sum,row)=>sum+row.rows.length,0),failed:failed.length,reportPath}));
}finally{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(service&&!service.closing)service.close();await rm(temporary,{recursive:true,force:true});
}
