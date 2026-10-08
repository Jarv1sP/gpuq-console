// Source UI with browser-local data only: no production authentication or writes.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const root=new URL('../dist/',import.meta.url),origin='https://fixture-member-storage.test',output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-storage-v5','storage-v5');
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):(await import('../dist/machines.js')).MACHINES;
await mkdir(output,{recursive:true});const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try{for(const role of ['member','admin'])for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:1080},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin);
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+['styles','starbase','shell','fonts','datasets','dataset-flow','dataset-warehouse','dataset-cache-operation'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')+'<body class="sb" data-room="datasets" style="min-height:100vh"><main id="main-content"><div class="page-heading"><h1 id="page-title">存储</h1><div class="heading-actions"></div></div><section id="page-datasets"></section></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});assert(!url.pathname.includes('..'));
  return route.fulfill({body:await readFile(new URL('.'+url.pathname,root)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.goto(origin);
 await page.evaluate(async({role,machines})=>{
  const {warehouseWorkspaceHTML,datasetWarehouseView}=await import('/dataset-warehouse-view.js');const section=document.querySelector('#page-datasets');section.innerHTML=warehouseWorkspaceHTML();
  const first=machines[0].id,version='a'.repeat(64);section.querySelector('[name=dataset-machine]').add(new Option(first,first));
  window.calls=[];window.opened=[];window.refreshes=0;window.capAllowed=true;window.authListeners=[];window.pendingProjects=[];
  document.addEventListener('gpuq-open-project',event=>opened.push(event.detail));
  window.store={production:true,principal:{userId:'fixture-me',username:'fixture-me',role},authGeneration:0,data:{machines},onAuthChange:fn=>authListeners.push(fn),call:async(operation,args)=>{
   calls.push({operation,args,actor:store.principal?.userId});
   if(operation==='storage.usage.mine'){
    if(Object.keys(args).length)throw Error('Unexpected usage scope');
    return window.usageReply||{protocol:1,machines:machines.map(row=>({machine:row.id,available:false,collectedAt:null,complete:false,projectBytes:null,projects:[]}))};
   }
   if(operation==='projects.list'){
    if(window.deferProjects)await new Promise(resolve=>pendingProjects.push(resolve));
    return {projects:args.machine===first?[{project:'vision-train',displayName:'视觉训练',environmentMode:'oci'},{project:'old-shared',environmentMode:'shared'},{project:'other-owner',environmentMode:'oci',userId:'fixture-other'}]:[]};
   }
   if(operation==='datasets.cache.capabilities')return {protocol:args.machine===first?1:0,release:window.capAllowed};
   if(operation==='datasets.cache.release')return {...args,action:'release',operationId:'12345678-1234-4234-9234-123456789abc',state:'RELEASED',phase:'RELEASED',canCancel:false};
   throw Error('Unexpected operation '+operation);
  }};
  const row=(dataset,canUse,ownerLabel,bytes,ready)=>({dataset,name:dataset==='my-images'?'我的训练图像':dataset,labelScope:'personal',displayNameRevision:1,versions:[{version,canUse,ownerLabel,bytes,files:40,state:'READY',canPrepare:false,locations:machines.map(machine=>({machine:machine.id,dataset,state:ready.includes(machine.id)?'READY':'NOT_LOCAL',canUse,ownerLabel,storage:machine.id===first?{dataset,version,phase:'ARCHIVED',archiveMachine:first,originalRetained:true}:undefined}))}]});
  window.catalog={machine:first,partial:false,machines:machines.map(machine=>({machine:machine.id,state:'ok'})),datasets:[row('my-images',false,'所属用户：fixture-me',3*1024**3,[first,machines[1].id]),row('granted-audio',true,'所属用户：fixture-other',1024**3,[machines[1].id]),row('not-mine',false,'所属用户：fixture-other',2*1024**3,[first]) ]};
  window.view=datasetWarehouseView(store,section,()=>{},{refresh:()=>refreshes++,removeUI:{canOpenFullDelete:()=>false},machineAllowed:id=>store.data.machines.some(machine=>machine.id===id),authorizedMachines:()=>store.data.machines,access:()=>({selectable:false,browseOnly:true,canRetry:false})});view.catalog(catalog);
 },{role,machines});
 assert.equal(await page.locator('#page-title').textContent(),'存储','storage heading has no dataset count');
 assert.equal(await page.locator('[data-storage-view=warehouse]').getAttribute('aria-selected'),'true');assert.equal(await page.locator('#member-storage').isVisible(),false);
 assert.deepEqual(await page.evaluate(()=>calls),[],'default warehouse does not preload personal projects or cache capabilities');
 const cards=await page.locator('.v4-warehouse-card,.v4-training-card').count();assert(cards>0);
 await page.locator('[data-storage-view=mine]').click();await page.waitForFunction(()=>!document.querySelector('.storage-mine-status')&&document.querySelector('[data-storage-project]'));
 await page.waitForFunction(()=>document.querySelector('[data-storage-release]'));
 assert.equal(await page.locator('#storage-warehouse-panel').isVisible(),false);assert.equal(await page.locator('.v4-warehouse-card,.v4-training-card').count(),cards);
 assert.equal(await page.locator('.storage-mine-machine').count(),2,'only nodes with owner OCI projects or observed readable READY caches');
 const text=await page.locator('#member-storage').textContent();assert(!text.includes('old-shared')&&!text.includes('other-owner')&&!text.includes('not-mine'),'no foreign metadata-only or legacy project rows');
 assert.equal(await page.locator('.storage-mine-total b').first().textContent(),'—');assert.equal(await page.locator('[data-storage-project]').locator('..').locator('..').locator('.storage-mine-size').textContent(),'—');
 assert.equal(await page.locator('.storage-mine-bar').count(),1,'a fully known cache-only node has a real total; unknown project usage has no bar');
 assert.equal(await page.locator('.storage-mine-bar').evaluate(node=>node.getBoundingClientRect().height),6);
 assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='storage.usage.mine').length),1,'one owner-scoped read accompanies personal project loading');
 assert.equal(await page.locator('.storage-mine-action').count(),await page.locator('.storage-mine-row').count(),'unavailable actions retain their fixed slot');
 assert.equal(await page.locator('[data-storage-release]').count(),1,'protocol 0 never exposes a release even with a true flag');
 for(const call of await page.evaluate(()=>calls.filter(row=>row.operation==='projects.list')))assert.deepEqual(Object.keys(call.args),['machine'],'projects.list is owner-scoped, without an identity override');
 await page.locator('[data-storage-project]').click();assert.deepEqual(await page.evaluate(()=>opened),[{machine:machines[0].id,project:'vision-train',userId:'fixture-me',authGeneration:0}]);
 await page.locator('[data-storage-release]').click();await page.locator('.storage-release-sheet').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.release').length),0,'opening the operation does not write');
 page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-cache-start]').click();assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.release').length),0,'canceling the confirmation does not release');
 page.once('dialog',dialog=>dialog.accept());await page.locator('[data-cache-start]').click();await page.waitForFunction(()=>refreshes===1);
 const writes=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.release'));assert.equal(writes.length,1);assert.deepEqual(Object.keys(writes[0].args).sort(),['dataset','key','machine','version']);assert.match(writes[0].args.key,/^[a-f0-9-]{36}$/);await page.keyboard.press('Escape');
 const capabilitiesBefore=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.capabilities').length);
 await page.evaluate(()=>{window.capAllowed=false;});await page.locator('[data-storage-view=warehouse]').click();await page.locator('[data-storage-view=mine]').click();await page.waitForFunction(()=>!document.querySelector('.storage-mine-status'));
 await page.locator('[data-storage-cache]').first().evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForFunction(before=>calls.filter(row=>row.operation==='datasets.cache.capabilities').length>before,capabilitiesBefore);assert.equal(await page.locator('[data-storage-release]').count(),0,'capability changes cannot retain release permission');
 await page.locator('[data-storage-view=warehouse]').click();await page.locator('[data-storage-view=warehouse]').focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!document.querySelector('.storage-mine-status'));assert.equal(await page.locator('[data-storage-view=mine]').evaluate(node=>node===document.activeElement),true);
 await page.evaluate(()=>window.capAllowed=true);await page.locator('[data-storage-view=warehouse]').click();await page.locator('[data-storage-view=mine]').click();await page.waitForFunction(()=>!document.querySelector('.storage-mine-status'));await page.locator('[data-storage-cache]').first().evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForFunction(()=>document.querySelector('[data-storage-release]'));
 await page.evaluate(()=>document.fonts.ready);await page.locator('#member-storage').scrollIntoViewIfNeeded();
 const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,slots:[...document.querySelectorAll('.storage-mine-action')].map(node=>node.getBoundingClientRect().width),amounts:[...document.querySelectorAll('.storage-mine-size')].map(node=>({align:getComputedStyle(node).textAlign,nums:getComputedStyle(node).fontVariantNumeric}))}));
 assert(geometry.scroll<=width,JSON.stringify(geometry));assert(geometry.slots.every(value=>value===48));assert(geometry.amounts.every(row=>row.align==='right'&&row.nums.includes('tabular-nums')));
 await page.evaluate(machines=>{window.usageReply={protocol:1,checkedAt:'2026-10-08T06:00:00Z',machines:machines.map((row,index)=>({machine:row.id,available:true,collectedAt:'2026-10-08T06:00:00Z',complete:true,projectBytes:index===0?2*1024**3:0,projects:index===0?[{project:'vision-train',name:'视觉训练',bytes:2*1024**3}]:[]}))};},machines);
 await page.locator('[data-storage-view=warehouse]').click();await page.locator('[data-storage-view=mine]').click();
 await page.waitForFunction(()=>document.querySelector('.storage-mine-total b')?.textContent==='5.00 GiB');
 assert.equal(await page.locator('[data-storage-project]').locator('..').locator('..').locator('.storage-mine-size').textContent(),'2.00 GiB');
 assert.equal(await page.locator('.storage-mine-bar').count(),2,'confirmed node sampling removes both project and total placeholders');
 for(const call of await page.evaluate(()=>calls.filter(row=>row.operation==='storage.usage.mine')))assert.deepEqual(call.args,{},'mine never sends an identity override');
 await page.screenshot({path:join(output,role+'-'+width+'.png'),fullPage:true});
 // Late replies from the previous account and zero authorization are fenced.
 await page.locator('[data-storage-view=warehouse]').click();await page.evaluate(()=>window.deferProjects=true);await page.locator('[data-storage-view=mine]').click();await page.waitForFunction(()=>pendingProjects.length===1);
 await page.evaluate(()=>{store.principal={userId:'fixture-zero',username:'zero',role:'member'};store.authGeneration++;store.data.machines=[];view.reset();authListeners.forEach(fn=>fn());pendingProjects.splice(0).forEach(resolve=>resolve());});
 await page.locator('[data-storage-view=mine]').click();await page.waitForFunction(()=>document.querySelector('.storage-mine-empty'));assert.equal(await page.locator('.storage-mine-machine').count(),0);assert.equal(await page.locator('[data-storage-release]').count(),0);
 assert.deepEqual(errors,[]);await page.close();
}console.log('STORAGE V5 PASS: member/admin 1440/390/320, lazy personal reads, OCI/READY/ACL scope, unknown usage, release confirmation and capability refresh, zero authorization and late-account fence.');}finally{await browser.close();}
