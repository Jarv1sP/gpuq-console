import {openMembers} from './admin-members-workflows.mjs';
// Real frontend assets with browser-local replies only. No production login,
// accounts, capability probes or business writes. Set UI_GEOMETRY_SWEEP=1 for
// every 40px width, the common widths, three heights and all three zooms.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {polishRoomSpecs as specs} from './polish-room-specs.mjs';
import {checkDatasetHelpRegressions,checkDatasetSpacingRegressions,checkDatasetDisclosureRegressions} from './dataset-help-geometry.mjs';
const geometryURL=process.env.UI_GEOMETRY_MODULE?pathToFileURL(resolve(process.env.UI_GEOMETRY_MODULE)):new URL('./layout-geometry.mjs',import.meta.url);
const {inspectGeometry,scanGeometry,layoutWidths,layoutHeights,layoutZooms}=await import(geometryURL);
const source=fileURLToPath(new URL('..',import.meta.url));
const output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-polish-rooms','polish-rooms');
const phase='after';
const sweep=process.env.UI_GEOMETRY_SWEEP==='1';
const widths=sweep?[...new Set([...layoutWidths,390])].sort((a,b)=>a-b):[320,390,1440];
const {STARBASE_ASSETS}=await import(pathToFileURL(join(source,'frontend-assets.mjs')));
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):(await import('../dist/machines.js')).MACHINES;
const origin='https://offline-polish.test',checkedAt=new Date().toISOString(),version='b'.repeat(64),results=[],errors=[],scrollRegressions=[];
const modes=(process.env.UI_POLISH_MODES||'normal,empty,loading,error,unconfirmed,maintenance').split(',');
const rooms=(process.env.UI_POLISH_ROOMS||'community,members,cloud').split(',');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
 for(const room of rooms)for(const role of ['member','admin'])for(const mode of modes)for(const zoom of layoutZooms){
  const context=await browser.newContext({viewport:{width:Math.floor(1440/zoom),height:Math.floor(900/zoom)},deviceScaleFactor:zoom,reducedMotion:'reduce'}),page=await context.newPage(),release=[];
  const principal={userId:'fixture-'+role,username:'fixture-'+role,role};
  const me={id:principal.userId,username:principal.username,name:role==='admin'?'本地管理员':'本地验收成员',role,enabled:true,total:8,limits:Object.fromEntries(machines.map(m=>[m.id,m.cards])),policyVersion:1};
  const applicant={id:'new-member',username:'training-member-with-a-long-account-name',name:'等待审批的成员',role:'member',enabled:true,total:0,limits:{},policyVersion:1};
  const state={machines,executionEnabled:true,users:role==='admin'?[me,...(room==='members'&&mode==='empty'?[]:[applicant])]:[me],jobs:[],gpuq:{checkedAt,stale:false,hosts:[]},
   ...(mode==='maintenance'?{operationalMaintenance:{version:1,revision:1,global:null,machines:{[machines[0].id]:{reason:'本地维护验收',since:checkedAt}}}}:{})};
  const posts=mode==='empty'?[]:[{id:'1',kind:'announcement',announcementType:'maintenance',pinned:true,title:'训练排期与数据准备进展',body:'先确认数据版本，再选择服务器。长服务器名称来自清单，内容会随所在列换行。',author:{name:'实验室管理员'},createdAt:checkedAt,revision:1,commentCount:3},
   ...[2,3].map(id=>({id:String(id),kind:'feedback',status:'investigating',title:'较长的训练问题标题与复现步骤记录 '+id,body:'本地布局验收正文',author:{name:'负责训练的成员'},createdAt:checkedAt,revision:1,commentCount:12}))];
  const files=mode==='empty'?[]:[{operationId:'11111111-1111-4111-8111-111111111111',action:'upload',state:'VERIFIED',name:'training-samples-2026-validation-and-reproducibility.tar',path:'incoming/training-samples-2026.tar',bytes:0,totalBytes:4*1024**2},
   {operationId:'22222222-2222-4222-8222-222222222222',action:'upload',state:'RUNNING',name:'large-training-samples.tar',path:'incoming/large-training-samples.tar',bytes:1024**2,totalBytes:4*1024**2},
   {operationId:'33333333-3333-4333-8333-333333333333',action:'download',state:'PAUSED',name:'previous-training-samples.tar',path:'restored/previous-training-samples.tar',fileId:'11111111-1111-4111-8111-111111111111',errorCode:'CLOUD_FILE_IDENTITY_CHANGED',totalBytes:4*1024**2}];
  const json=(route,result)=>route.fulfill({contentType:'application/json',body:JSON.stringify({principal,state,result})});
  const fail=(route,message)=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:message})});
  page.on('pageerror',error=>errors.push({room,role,mode,message:error.message}));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());assert.equal(url.origin,origin,'no external request');
   if(url.pathname==='/api/call'){
    const {operation,args={}}=route.request().postDataJSON();
    if(operation==='state')return json(route,null);
    if(operation==='projects.list')return json(route,{projects:[]});
    if(operation==='datasets.overview'){assert.deepEqual(args,{});return json(route,{protocol:0});}
    if(operation==='datasets.catalog')return json(route,{machine:args.machine,checkedAt,machines:machines.map(m=>({machine:m.id,state:'ok'})),datasets:[{dataset:'local-fixture',name:'本地布局数据',versions:[{version,state:'READY',bytes:7*1024**3,files:12,canPrepare:false,locations:machines.map(m=>({machine:m.id,state:'READY'}))}]}]});
    if(operation==='datasets.upload.routes')return json(route,{available:false,protocol:'dataset-upload-v1',machine:args.machine});
    if(operation==='datasets.capacity')return json(route,{machine:args.machine,available:true,filesystemBytes:1024**4,availableBytes:512*1024**3,usableBytes:502*1024**3,reserveBytes:10*1024**3});
    if(operation==='cloud.info')return json(route,{capabilityVerified:false,configurationEnabled:true,aliyunConnected:false,nodeDirect:false,managedExternally:true});
    if(operation==='cloud.import.list')return json(route,{imports:[]});
    if(operation==='community.info'){if(mode==='loading')await new Promise(resolve=>release.push(resolve));if(mode==='error')return fail(route,'本地连接暂不可用');return json(route,{enabled:true,capabilities:['task-notes-v1']});}
    if(operation==='community.posts.list')return json(route,{posts,nextCursor:null});
    if(operation==='community.posts.get')return json(route,{post:posts.find(post=>post.id===args.id)});
    if(operation==='community.comments.list')return json(route,{comments:[],nextCursor:null});
    if(operation==='community.notes.list')return json(route,{notes:[],nextCursor:null});
    if(operation==='community.chat.list')return json(route,{messages:mode==='empty'?[]:[{id:'1',body:'今天的数据已准备完成，可以按计划开始训练。',author:{name:'训练成员'},createdAt:checkedAt,revision:1}],latestCursor:'1',nextCursor:null,hasMore:false});
    if(operation==='community.posts.create')return route.abort('failed');
    if(operation==='invites.list')return json(route,{code:'LOCAL-LAYOUT-FIXTURE',invitations:[{available:true,enabled:true,uses:3,createdAt:checkedAt}]});
    if(operation==='policy.save'){if(mode==='loading')await new Promise(resolve=>release.push(resolve));if(mode==='unconfirmed')return route.abort('failed');return fail(route,'额度尚未保存，请稍后查询。');}
    if(operation==='cloud.files.info'){if(mode==='loading')await new Promise(resolve=>release.push(resolve));return json(route,{enabled:true,nodeLocal:true,vpsRelay:false});}
    if(operation==='cloud.files.list')return mode==='error'?fail(route,'云端连接暂不可用'):json(route,{files,total:files.length,limit:50});
    if(operation==='cloud.files.upload')return route.abort('failed');
    if(operation==='cloud.files.status')return fail(route,'原操作回执暂时无法查询。');
    throw Error('unexpected API '+operation);
   }
   if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(machines)+';'});
   const file=url.pathname==='/'?'index.html':url.pathname.slice(1);assert(file==='index.html'||/^[a-z-]+\.(js|css)$/.test(file)||Object.hasOwn(STARBASE_ASSETS,url.pathname),'known static asset '+url.pathname);
   let body=await readFile(join(source,'dist',file));
   if(file==='index.html')body=body.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;globalThis.GPUQ_HAS_SESSION=true;');
   const mime=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.ico')?'image/x-icon':'text/html';
   return route.fulfill({contentType:mime,body});
  });
  try{
   await page.goto(origin);await page.locator('[data-nav=community]').waitFor();
   if(room==='community'){
    await page.locator('[data-nav=community]').click();await page.locator('#community-tabs').waitFor({state:'attached'});
    if(mode==='loading')await page.locator('#community-status').filter({hasText:'正在连接'}).waitFor();
    else if(mode==='error')await page.locator('#community-status').filter({hasText:'暂不可用'}).waitFor();
    else await page.waitForFunction(()=>document.querySelector('#community-posts')?.getAttribute('aria-busy')==='false');
    if(mode==='unconfirmed'){await page.locator('#community-create').click();await page.locator('#community-compose-form [name=title]').fill('保留发送草稿');await page.locator('#community-compose-form [name=body]').fill('回执丢失时保持原内容。');await page.locator('#community-compose-form [type=submit]').click();await page.locator('#community-compose-error').filter({hasText:'未确认'}).waitFor();}
   }else if(room==='members'){
    if(role==='member'){await page.evaluate(()=>location.hash='#users');await page.locator('#admin-denied').waitFor();assert.equal(await page.locator('[data-nav=users]').count(),0);assert.equal(await page.locator('#page-users').isVisible(),false);}
    else{await openMembers(page);await page.locator('#page-users').waitFor();
     if(['loading','error','unconfirmed'].includes(mode)){await page.locator('[data-machine]').first().check();await page.locator('[data-action=save-policy]').click();if(mode==='loading')await page.waitForFunction(()=>document.querySelector('[data-action=save-policy]').disabled);else await page.locator('#policy-error').filter({hasText:/./}).waitFor();}
    }
   }else{
    await page.locator('[data-nav=datasets]').click();
    // A control can be inside the viewport but behind a persistent layer.
    // Scroll it into the usable band and keep Playwright's real hit check.
    await page.locator('#datasets-refresh').evaluate(node=>{
     const visible=selector=>[...document.querySelectorAll(selector)].filter(n=>n.getClientRects().length&&n.getBoundingClientRect().height>0&&getComputedStyle(n).display!=='none');
     const top=Math.max(0,...visible('#app-topbar,#shell-context,#operational-maintenance').map(n=>n.getBoundingClientRect().bottom));
     const bottom=Math.min(innerHeight,...visible('#control-strip,.mobile-nav,#mobile-control').filter(n=>getComputedStyle(n).position==='fixed').map(n=>n.getBoundingClientRect().top));
     const r=node.getBoundingClientRect();if(bottom-top<r.height)throw Error('no reachable band for dataset refresh');
     scrollBy({top:r.top+r.height/2-(top+bottom)/2,behavior:'instant'});
    });
    await page.locator('#datasets-refresh').click();await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
    await page.locator('[data-v3-upload]').first().click();await page.locator('[data-v3-source=workspace]').click();
    await (await import('./experimental-cloud-harness.mjs')).experimentalCloudHarness(page);
    const initialList=mode==='loading'?null:page.waitForResponse(response=>response.url().endsWith('/api/call')&&response.request().postDataJSON()?.operation==='cloud.files.list');
    await page.locator('#cloud-files>summary').click();
    if(mode==='loading')await page.waitForFunction(()=>document.querySelector('#cloud-files-refresh').disabled);
    else{await initialList;await page.waitForFunction(()=>!document.querySelector('#cloud-files-refresh').disabled&&document.querySelector('#cloud-files-status').textContent!=='先查询云端状态。');if(mode==='unconfirmed'){await page.locator('[name=cloud-files-path]').fill('incoming/unconfirmed-layout.tar');assert.equal(await page.locator('[name=cloud-files-path]').inputValue(),'incoming/unconfirmed-layout.tar');await page.locator('#cloud-files-form [type=submit]').click();await page.locator('#cloud-files-status').filter({hasText:'未确认'}).waitFor();}}
   }
   if(room==='cloud'&&mode==='normal'&&zoom===1){
    await page.setViewportSize({width:320,height:900});
    await checkDatasetHelpRegressions(page);await checkDatasetSpacingRegressions(page);await checkDatasetDisclosureRegressions(page);
   }
   const spec={...specs[room],...(room==='community'&&mode==='unconfirmed'?{roots:['.community-dialog[open]']}:{} )};
   for(const width of (zoom===1?[1440,390,320]:[])){
    await page.setViewportSize({width,height:900});await page.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(requestAnimationFrame);});
    if(room==='cloud')await page.locator('#cloud-files').evaluate(node=>{const dialog=node.closest('dialog');dialog.scrollTop+=node.getBoundingClientRect().top-dialog.getBoundingClientRect().top-dialog.querySelector('header').getBoundingClientRect().height-12;});
    const folder=join(output,room,phase);await mkdir(folder,{recursive:true});
    const layout=role==='member'&&room==='members'?{pass:true,accessBoundary:true,width,failures:[]}:await inspectGeometry(page,spec);
    results.push({room,role,mode,width,...layout});await writeFile(join(output,'geometry-results.json'),JSON.stringify({results,errors},null,2));
    await page.screenshot({path:join(folder,mode+'-'+role+'-'+width+'.png')});
   }
   if(!(role==='member'&&room==='members')){const scanned=await scanGeometry(page,spec,{widths,heights:layoutHeights,zoom});results.push(...scanned.map(result=>({room,role,mode,...result})));}
   // Secondary surfaces share the same controls. Exercise their real entrance
   // and scroller, including everything below a phone's first viewport.
   if(mode==='normal'&&!(role==='member'&&room==='members')){
    const captureSurface=async(name,surfaceSpec,scrollPanel)=>{
     const layoutSpec=async()=>{
      if(name!=='post-detail')return surfaceSpec;
      // Short viewports scroll the complete detail sheet; taller ones scroll
      // its body. Check the actual scroller without changing any thresholds.
      const selector=await page.locator('.community-detail[open] .community-sheet-body').evaluate(node=>
       getComputedStyle(node).overflowY==='visible'?'.community-detail[open]':'.community-detail[open] .community-sheet-body');
      return {...surfaceSpec,scrollPanels:[selector]};
     };
     if(zoom===1)for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:900});await page.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(requestAnimationFrame);});
      const folder=join(output,room,phase);await mkdir(folder,{recursive:true});
      await page.screenshot({path:join(folder,name+'-'+role+'-'+width+'.png')});
      const activeSpec=await layoutSpec(),layout=await inspectGeometry(page,activeSpec);results.push({room,role,mode:name,...layout});
      if(width<760){await page.evaluate(selector=>{const node=selector?document.querySelector(selector):document.scrollingElement;node.scrollTop=node.scrollHeight;},name==='post-detail'?activeSpec.scrollPanels[0]:scrollPanel);await page.screenshot({path:join(folder,name+'-bottom-'+role+'-'+width+'.png')});}
     }
     for(const height of layoutHeights){
      await page.setViewportSize({width:Math.floor(widths[0]/zoom),height:Math.floor(height/zoom)});
      const scanned=await scanGeometry(page,await layoutSpec(),{widths,heights:[height],zoom});results.push(...scanned.map(result=>({room,role,mode:name,...result})));
     }
     if(name==='post-detail'&&zoom===1.5){
      await page.setViewportSize({width:Math.floor(320/zoom),height:Math.floor(700/zoom)});
      const activeSpec=await layoutSpec(),scroller=page.locator(activeSpec.scrollPanels[0]);
      const originalStyle=await scroller.getAttribute('style');
      let blocked;
      try{
       await scroller.evaluate(node=>node.style.setProperty('overflow-y','hidden','important'));
       blocked=await inspectGeometry(page,activeSpec);
       assert(blocked.failures.some(failure=>failure.rule==='unreachable-panel-content'),'the actual short-sheet scroller must expose clipped content');
      }finally{await scroller.evaluate((node,style)=>style===null?node.removeAttribute('style'):node.setAttribute('style',style),originalStyle);}
      const restored=await inspectGeometry(page,activeSpec);assert(restored.pass,JSON.stringify(restored.failures));
      scrollRegressions.push({role,selector:activeSpec.scrollPanels[0],blocked,restored});
      await writeFile(join(output,'scroll-regressions.json'),JSON.stringify(scrollRegressions,null,2));
     }
    };
    if(room==='community'){
     await page.setViewportSize({width:390,height:900});await page.locator('[data-community-tab=chat]').click();await page.locator('#community-task-notes>summary').click();await page.locator('#task-notes-list p').waitFor();
     await captureSurface('chat-and-notes',specs.community,'#community-messages');
     await page.setViewportSize({width:390,height:900});await page.locator('[data-community-tab=posts]').click();await page.locator('.community-post-open').first().click();await page.locator('#community-post-title').waitFor();
     await captureSurface('post-detail',{...specs.community,roots:['.community-detail[open]'],scrollPanels:['.community-detail[open] .community-sheet-body']},'.community-sheet-body');
    }else if(room==='members'){
     await page.locator('[data-action=invites]').click();await page.locator('#current-invite').waitFor();
     await captureSurface('invitations',{...specs.members,roots:['#invites-dialog[open]'],scrollPanels:['#invites-dialog[open]']},'#invites-dialog');
     await page.locator('#invites-dialog [data-close]').click();await page.locator('[data-action=reset-password]').click();await page.locator('#password-dialog').waitFor();
     await captureSurface('reset-password',{...specs.members,roots:['#password-dialog[open]'],scrollPanels:['#password-dialog[open]']},'#password-dialog');
     await page.locator('#password-dialog [data-close]').first().click();await page.locator('.account-settings>summary').click();
     await captureSurface('account-controls',specs.members);
    }else{
     await page.locator('.cloud-file-details').first().locator('summary').click();
     await captureSurface('operation-details',specs.cloud,'#dataset-add-dialog');
    }
   }
   await writeFile(join(output,'geometry-results.json'),JSON.stringify({results,errors},null,2));
   console.log(room,role,mode,'zoom '+zoom,results.filter(result=>result.room===room&&result.role===role&&result.mode===mode&&!result.pass).length+' geometry failures');
  }catch(error){
   const folder=join(output,'failure'),name=room+'-'+role+'-'+mode+'-zoom-'+zoom;
   await mkdir(folder,{recursive:true});await page.screenshot({path:join(folder,name+'.png')});
   const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollY,elements:
    ['#app-topbar','#shell-context','#operational-maintenance','.maintenance-settings','#main-content','#datasets-refresh','#control-strip'].map(selector=>{
     const node=document.querySelector(selector);if(!node)return {selector,missing:true};
     const r=node.getBoundingClientRect(),s=getComputedStyle(node),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
     return {selector,rect:{left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom},position:s.position,overflowY:s.overflowY,hidden:node.hidden,open:node.open,hit:top?{tag:top.tagName,id:top.id,className:top.className}:null};
    })}));
   await writeFile(join(folder,name+'.json'),JSON.stringify(geometry,null,2));throw error;
  }finally{for(const resolve of release)resolve();await context.unrouteAll({behavior:'ignoreErrors'});await context.close();}
 }
}finally{await browser.close();await mkdir(output,{recursive:true});await writeFile(join(output,'geometry-results.json'),JSON.stringify({results,errors},null,2)+'\n');}
assert.deepEqual(errors,[]);
const failed=results.filter(result=>!result.pass);
assert.equal(failed.length,0,JSON.stringify(failed.slice(0,12),null,2));
console.log(JSON.stringify({status:'passed',layouts:results.length,sweep,widths,heights:layoutHeights,zooms:layoutZooms,screenshots:output}));
