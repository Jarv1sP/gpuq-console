// Real client/module/CSS; only in-browser fixtures, no server deletions or login.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';
import {inspectGeometry} from './layout-geometry.mjs';

const origin='https://offline-full-delete.test',version='a'.repeat(64),shots=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-full-delete-ui','dataset-full-delete');
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):MACHINES;
const errors=[],external=[],checks=[],geometry=[];
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
await mkdir(shots,{recursive:true});
try{
 for(const role of ['member','admin']){
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']}),page=await context.newPage();await page.clock.install({time:new Date('2026-10-06T10:00:00Z')});
  let principal={userId:'local-'+role,username:'local-'+role,role},mode='DELETED',lostSubmit=false,queryLost=false,serial=0;
  const calls=[],tasks=new Map();
  const state=()=>({machines,users:[],jobs:[],executionEnabled:true});
  const json=(route,result)=>route.fulfill({contentType:'application/json',body:JSON.stringify({principal,state:state(),result})});
  const failure=(route,status,error,code)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({error,...(code?{code}:{})})});
  const fixtureCatalog=(dataset,allowed=true,capability=1)=>({datasetDelete:capability,datasets:[{dataset,versions:[{version,locations:machines.map((machine,index)=>({machine:machine.id,dataset:index===0?'physical-scans':dataset,state:'READY',storage:{phase:'ARCHIVED',originalRetained:true,archiveMachine:machines[0].id},deletionPermissions:{memberAllowed:allowed}}))}]}]});
  const task=(args,account)=>({operationId:`20000000-0000-4000-8000-${(++serial).toString().padStart(12,'0')}`,key:args.key,dataset:args.dataset,version:args.version,state:mode,
   ...(mode==='WAITING_CONTINUE'?{canContinue:true}:{}),...(mode==='BLOCKED'?{error:'这份数据仍有固定保留。'}:{}),
   retainUntil:'2026-10-13T10:00:00Z',copyNotice:'其他名称下的副本不受影响',createdAt:'2026-10-06T10:00:00Z',updatedAt:'2026-10-06T10:00:00Z',
   steps:machines.map((machine,index)=>({machine:machine.id,dataset:index===0?'physical-scans':args.dataset,operationId:`30000000-0000-4000-8000-${(index+1).toString().padStart(12,'0')}`,phase:'commit',state:mode==='DELETED'?'ISOLATED':'PLANNED',complete:index===0,retainUntil:'2026-10-13T10:00:00Z'})),events:[],account});
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.href);return route.abort();}
   if(url.pathname==='/api/call'){
    const {operation,args}=route.request().postDataJSON();calls.push({operation,args:structuredClone(args),account:principal.userId});
    if(operation==='datasets.delete'){
     assert.deepEqual(Object.keys(args).sort(),['dataset','key','version']);assert.equal(args.version,version);
     if(mode==='FORBIDDEN')return failure(route,403,'这份数据只能由管理员删除。');
     if(mode==='UNSUPPORTED')return failure(route,409,'服务器的删除能力未确认，请等待节点更新或恢复连接。');
     const result=task(args,principal.userId);tasks.set(args.key,result);if(lostSubmit){lostSubmit=false;return route.abort('failed');}return json(route,result);
    }
    if(operation==='datasets.delete.status'){
     assert.deepEqual(Object.keys(args),['key']);const result=tasks.get(args.key);
     if(queryLost)return route.abort('failed');
     if(!result||result.account!==principal.userId&&principal.role!=='admin')return failure(route,404,'删除记录不存在或无权查看。');
     return json(route,result);
    }
    if(['datasets.delete.continue','datasets.delete.cancel','datasets.delete.restore'].includes(operation)){
     assert.equal(principal.role,'admin');const result=[...tasks.values()].find(value=>value.operationId===args.operationId);assert(result);
     if(operation==='datasets.delete.restore'){
      assert.deepEqual(Object.keys(args).sort(),['machine','operationId']);assert.equal(args.machine,machines[0].id);
      result.state='BLOCKED';result.error='管理员已恢复数据和全部名称；旧删除编号不可重新执行。';result.steps[0].restoreState='RESTORED';
      return json(route,{operationId:args.operationId,machine:args.machine,dataset:result.steps[0].dataset,version,state:'RESTORED'});
     }
     assert.deepEqual(Object.keys(args),['operationId']);result.state=operation.endsWith('.cancel')?'CANCELED':'RUNNING';return json(route,result);
    }
    throw Error('Unexpected operation '+operation);
   }
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/copy-help.css"></head><body class="sb" data-room="datasets"><div class="shell"><header class="topbar"><span class="wordmark" aria-label="STARGATE"></span></header><main id="main-content"><div class="page-heading"><h1>数据集</h1></div><section id="page-datasets"><div id="dataset-catalog"></div><div id="test-entry"></div></section></main></div></body></html>`});
   const asset=STARBASE_ASSETS[url.pathname]||(url.pathname.match(/^\/[a-z-]+\.(?:js|css)$/)&&url.pathname.slice(1));
   if(asset){const binary=asset.endsWith('.woff2');return route.fulfill({contentType:binary?'font/woff2':asset.endsWith('.js')?'text/javascript':'text/css',body:await readFile(new URL('../dist/'+asset,import.meta.url),binary?undefined:'utf8')});}
   if(url.pathname==='/favicon.ico')return route.fulfill({status:204});external.push(url.href);return route.abort();
  });
  await page.goto(origin);
  await page.evaluate(async({principal,state})=>{
   const {DemoClient}=await import('/client.js'),{datasetRemoveUI}=await import('/dataset-remove-ui.js');
   window.store=new DemoClient();store.remote=true;store.production=true;store.token='offline-browser-fixture';store.principal=principal;store.data=state;
   window.currentCatalog=null;window.reloads=0;if(principal.role==='admin')document.body.dataset.room='admin';
   window.removals=datasetRemoveUI(store,document.querySelector('#page-datasets'),()=>{},{catalog:()=>currentCatalog,reload:()=>{reloads++;},management:principal.role==='admin'});
   window.setEntry=(catalog,dataset,version)=>{
    currentCatalog=catalog;const slot=document.querySelector('#test-entry');slot.replaceChildren();
    if(removals.canOpenFullDelete(dataset,version)){const button=document.createElement('button');button.className='button danger';button.dataset.fullDeleteOpen='';button.textContent='彻底删除';button.onclick=()=>removals.openFullDelete(dataset,version);slot.append(button);}
   };
  },{principal,state:state()});
  const setEntry=async(dataset,allowed=true,capability=1)=>page.evaluate(({catalog,dataset,version})=>setEntry(catalog,dataset,version),{catalog:fixtureCatalog(dataset,allowed,capability),dataset,version});
  const open=async dataset=>{await setEntry(dataset);await page.locator('[data-full-delete-open]').click();await page.locator('#dataset-full-delete-dialog[open]').waitFor();};
  const submit=async dataset=>{await page.locator('[name=full-delete-name]').fill(dataset);await page.locator('[data-full-delete-submit]').click();await page.waitForFunction(()=>!document.querySelector('[data-full-delete-submit]')&&!document.querySelector('[data-full-delete-query]')?.disabled);};
  const capture=async name=>{
   for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});await page.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();});
    const result=await inspectGeometry(page,{roots:['#dataset-full-delete-dialog[open]'],controls:'.button,input,select,summary',containment:'input,select,.button,.full-delete-facts>div,.full-delete-step-name,.full-delete-step-state',leftEdges:[['.full-delete-facts>div:first-child dt','.full-delete-facts>div:last-child dt']],helpContexts:['#dataset-full-delete-dialog [data-copy-help]'],labelledHelp:[{buttons:'.full-delete-name [data-copy-help]',rows:'.copy-caption',labels:':scope > span:not(.copy-help)'}],buttonRows:[{parent:'.dataset-full-delete-dialog .modal-actions'}],scrollPanels:['#dataset-full-delete-dialog[open]']});
    geometry.push({name,role,...result});assert.equal(result.pass,true,JSON.stringify({name,role,...result}));
    const heights=await page.evaluate(()=>[...document.querySelectorAll('#dataset-full-delete-dialog .button')].map(element=>({text:element.textContent,height:element.getBoundingClientRect().height})));
    assert(heights.every(control=>Math.abs(control.height-48)<=1),JSON.stringify({name,role,width,heights}));
    const names=await page.evaluate(()=>[...document.querySelectorAll('.full-delete-step-name .server-id')].map(element=>({name:element.textContent,title:element.title,rect:element.getBoundingClientRect().toJSON()})));
    for(const value of names){assert.equal(value.name,value.title);assert(value.rect.width>0&&value.rect.height>0);}
    assert.equal(await page.locator('.full-delete-record').count(),0);assert.equal(await page.getByText('完整编号',{exact:true}).count(),0);
    assert.equal(await page.locator('[role=progressbar]').count(),0);assert(!await page.locator('#dataset-full-delete-dialog').innerText().then(text=>text.includes('%')));
    await page.screenshot({path:join(shots,name+'-'+role+'-'+width+'.png')});
   }
  };
  for(const cap of [0,true,'1',null]){
   await setEntry('capability-off',true,cap);assert.equal(await page.locator('[data-full-delete-open]').count(),0);
   assert.equal(await page.evaluate(({dataset,version})=>removals.openFullDelete(dataset,version),{dataset:'capability-off',version}),false);
   assert.equal(await page.locator('#dataset-full-delete-dialog').count(),0);
  }
  await setEntry('shared-data',false);assert.equal(await page.locator('[data-full-delete-open]').count(),role==='admin'?1:0);
  await page.evaluate(({catalog,dataset,version})=>{delete catalog.datasets[0].versions[0].locations[0].deletionPermissions;catalog.datasets[0].versions[0].locations=catalog.datasets[0].versions[0].locations.slice(0,1);setEntry(catalog,dataset,version);},{catalog:fixtureCatalog('old-node'),dataset:'old-node',version});
  assert.equal(await page.locator('[data-full-delete-open]').count(),role==='admin'?1:0);assert.equal(calls.length,0);
  checks.push(role+': capability 0/string/boolean/null renders no entry or dialog and sends no requests; current memberAllowed true/false/missing, admin override');
  await open('scans');assert.equal(await page.locator('[data-full-delete-submit]').isDisabled(),true);await page.locator('[name=full-delete-name]').fill('scan');assert.equal(await page.locator('[data-full-delete-submit]').isDisabled(),true);
  await capture('confirmation');await page.locator('[data-copy-help]').click();assert.equal(calls.length,0);await page.keyboard.press('Escape');assert.equal(await page.locator('#dataset-full-delete-dialog[open]').count(),1);
  await submit('scans');assert(await page.locator('.full-delete-status').innerText().then(text=>text.includes('已删除')));assert(await page.locator('.full-delete-retention').innerText().then(text=>text.includes('2026/10/13')));assert(await page.locator('#dataset-full-delete-dialog').innerText().then(text=>text.includes('其他名称下的副本不受影响')));
  const current=[...tasks.values()].find(task=>task.dataset==='scans');
  assert.equal(await page.locator('.full-delete-reference code').textContent(),current.operationId.slice(0,8)+'…'+current.operationId.slice(-4));
  const beforeCopy=calls.length;await page.locator('[data-full-delete-copy]').click();await page.waitForFunction(()=>document.querySelector('[data-full-delete-copy]').textContent==='已复制');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),current.operationId);assert.equal(calls.length,beforeCopy);
  assert.equal(await page.locator('.full-delete-step-name>span:last-child').first().textContent(),'隔离原件（可恢复）');
  for(const label of await page.locator('.full-delete-step-name>span:last-child').allTextContents().then(values=>values.slice(1)))assert.equal(label,'移除缓存');
  await capture('deleted');
  if(role==='member'){
   assert.equal(await page.locator('[data-full-delete-action]').count(),0);
   assert(await page.locator('.full-delete-retention').innerText().then(text=>/^如需恢复，请联系管理员（保留至 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}）$/.test(text)));
   assert(!await page.locator('#dataset-full-delete-dialog').innerText().then(text=>text.includes('需要管理员处理')));
  }
  else{
   await page.locator('[data-full-delete-action=restore]').click();await capture('restore-confirmation');assert.equal(await page.locator('[name=full-delete-restore-machine]').inputValue(),machines[0].id);await page.locator('#dataset-full-delete-dialog form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#dataset-full-delete-dialog').textContent.includes('管理员已恢复数据和全部名称'));
   assert.equal(await page.locator('[data-full-delete-action=continue]').count(),0);assert.equal(calls.at(-2).operation,'datasets.delete.restore');assert.equal(calls.at(-1).operation,'datasets.delete.status');
  }
  await page.locator('[data-full-delete-close]').click();assert.equal(await page.locator('[data-full-delete-open]').evaluate(element=>element===document.activeElement),true);
  checks.push(role+': typed-name dangerous confirmation, matching DELETED, seven-day retainUntil, copy notice, no percentages, modal focus/Escape');
  mode='WAITING_CONTINUE';await open('waiting');await submit('waiting');await capture('waiting');
  if(role==='member'){assert.equal(await page.locator('[data-full-delete-action]').count(),0);assert(await page.locator('#dataset-full-delete-dialog').innerText().then(text=>text.includes('需要管理员处理')));}
  else{
   assert.equal(await page.locator('[data-full-delete-action=continue]').count(),1);const row=[...tasks.values()].at(-1);row.canContinue=false;await page.locator('[data-full-delete-query]').click();await page.waitForFunction(()=>!document.querySelector('[data-full-delete-action=continue]'));row.canContinue=true;await page.locator('[data-full-delete-query]').click();await page.locator('[data-full-delete-action=continue]').click();await page.locator('#dataset-full-delete-dialog form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('.full-delete-status').textContent.includes('正在删除'));
   await page.locator('[data-full-delete-action=cancel]').click();assert(await page.locator('#dataset-full-delete-dialog').innerText().then(text=>text.includes('不会强制中断')));await page.locator('#dataset-full-delete-dialog form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('.full-delete-status').textContent.includes('已取消删除'));
  }
  await page.locator('[data-full-delete-close]').click();checks.push(role+': WAITING_CONTINUE actual flag; members cannot render privileged buttons; admin continue/cancel original operation ID and confirmations');
  for(const [state,label] of [['BLOCKED','这份数据仍有固定保留。'],['FORBIDDEN','这份数据只能由管理员删除。'],['UNSUPPORTED','服务器的删除能力未确认，请等待节点更新或恢复连接。']]){
   mode=state;const dataset=state.toLowerCase();await open(dataset);await submit(dataset);assert(await page.locator('#dataset-full-delete-dialog').innerText().then(text=>text.includes(label)));assert(await page.locator('.full-delete-status').innerText().then(text=>text.includes('暂不能删除')));await capture(state.toLowerCase());await page.locator('[data-full-delete-close]').click();
  }
  checks.push(role+': BLOCKED node reason, original 403 and uncoded 409 UNSUPPORTED');
  mode='DELETED';lostSubmit=true;queryLost=true;await open('lost-receipt');await submit('lost-receipt');assert(await page.locator('.full-delete-status').innerText().then(text=>text.includes('删除结果待确认')));assert.equal(await page.locator('[data-full-delete-action]').count(),0);assert.equal(await page.locator('.modal-actions button').count(),1);assert.equal(await page.locator('.full-delete-reference').count(),0);await capture('unknown');
  const original=[...tasks.values()].at(-1);assert.equal(calls.at(-1).operation,'datasets.delete.status');assert.deepEqual(calls.at(-1).args,{key:original.key});
  await page.reload();await page.evaluate(async({principal,state,catalog,dataset,version})=>{
   const {DemoClient}=await import('/client.js'),{datasetFullDeleteUI}=await import('/dataset-full-delete-ui.js');
   window.store=new DemoClient();store.remote=true;store.production=true;store.token='offline-browser-fixture';store.principal=principal;store.data=state;
   window.fullDelete=datasetFullDeleteUI(store,{catalog:()=>catalog});fullDelete.openFullDelete(dataset,version);
  },{principal,state:state(),catalog:fixtureCatalog('lost-receipt'),dataset:'lost-receipt',version});
  assert(await page.locator('.full-delete-status').innerText().then(text=>text.includes('删除结果待确认')));assert.equal(calls.filter(call=>call.operation==='datasets.delete'&&call.args.dataset==='lost-receipt').length,1);
  queryLost=false;await page.locator('[data-full-delete-query]').click();await page.waitForFunction(()=>document.querySelector('.full-delete-status').textContent.includes('已删除'));assert.deepEqual(calls.at(-1).args,{key:original.key});
  checks.push(role+': lost initial and query receipt -> UNKNOWN query only, refresh keeps original account/key, no replay then authoritative recovery');
  const before=calls.length;principal={userId:'another-account',username:'another-account',role};
  await page.evaluate(principal=>{store.authGeneration++;store.principal=principal;for(const listener of store.authListeners)listener();},principal);assert.equal(await page.locator('#dataset-full-delete-dialog[open]').count(),0);assert.equal(await page.evaluate(key=>fullDelete.openFullDeleteRecord(key),original.key),false);assert.equal(calls.length,before);
  // The real client also keeps cross-account 404 intact, rather than replacing it
  // with local completion or retrying the original write for the new account.
  const rejected=await page.evaluate(async key=>{try{await store.call('datasets.delete.status',{key});return null;}catch(error){return {status:error.status,message:error.message};}},original.key);
  if(role==='member')assert.deepEqual(rejected,{status:404,message:'删除记录不存在或无权查看。'});
  checks.push(role+': auth switch closes old dialog and exposes no foreign local records; owner/admin status authorization');
  if(role==='admin'){
   mode='WAITING_CONTINUE';const primary=await context.newPage();primary.on('pageerror',error=>errors.push(error.message));await primary.goto(origin);
   await primary.evaluate(async({principal,state,catalog,version})=>{
    const {DemoClient}=await import('/client.js'),{datasetRemoveUI}=await import('/dataset-remove-ui.js');
    window.store=new DemoClient();store.remote=true;store.production=true;store.token='offline-browser-fixture';store.principal=principal;store.data=state;
    window.currentCatalog=catalog;window.reads=0;
    const root=document.querySelector('#page-datasets');root.querySelector('#dataset-catalog').innerHTML='<article class="dataset-card"><div class="dataset-card-heading"><span data-dataset-more-slot data-machine="'+state.machines[0].id+'" data-dataset="main-personal" data-version="'+version+'"></span></div></article>';
    window.mainRemove=datasetRemoveUI(store,root,()=>{},{management:false,catalog:()=>currentCatalog,readCatalog:()=>{reads++;throw Error('primary must not read admin listings');}});
   },{principal,state:state(),catalog:fixtureCatalog('main-personal'),version});
   assert.equal(await primary.locator('[data-remove-more]').count(),0);
   assert.equal(await primary.evaluate(({dataset,version})=>mainRemove.canOpenFullDelete(dataset,version),{dataset:'main-personal',version}),true);
   await primary.evaluate(({dataset,version})=>{currentCatalog.datasets[0].versions[0].locations.forEach(location=>location.deletionPermissions.memberAllowed=false);}, {dataset:'main-personal',version});
   assert.equal(await primary.evaluate(({dataset,version})=>mainRemove.canOpenFullDelete(dataset,version),{dataset:'main-personal',version}),false);
   await primary.evaluate(({dataset,version})=>{currentCatalog.datasets[0].versions[0].locations.forEach(location=>location.deletionPermissions.memberAllowed=true);mainRemove.openFullDelete(dataset,version);}, {dataset:'main-personal',version});
   await primary.locator('[name=full-delete-name]').fill('main-personal');await primary.locator('[data-full-delete-submit]').click();await primary.waitForFunction(()=>document.querySelector('.full-delete-status').textContent.includes('等待管理员继续'));
   assert.equal(await primary.locator('[data-full-delete-action]').count(),0);assert.equal(await primary.evaluate(()=>reads),0);assert(await primary.locator('.dataset-full-delete-dialog').innerText().then(text=>text.includes('需要管理员处理')));
   checks.push('management:false administrator has member-equivalent entry and no unregister/continue/cancel/restore UI or admin listing calls');
   await primary.unrouteAll({behavior:'ignoreErrors'});await primary.close();
   const backend=await context.newPage();backend.on('pageerror',error=>errors.push(error.message));await backend.goto(origin);
   const fresh=fixtureCatalog('admin-cache',false);fresh.datasets[0].versions[0].locations.forEach(location=>{delete location.storage;});
   const cached=structuredClone(fresh);cached.datasets[0].versions[0].locations=cached.datasets[0].versions[0].locations.slice(0,1);
   await backend.evaluate(async({principal,state,cached,fresh,version})=>{
    const {DemoClient}=await import('/client.js'),{datasetRemoveUI}=await import('/dataset-remove-ui.js');
    window.store=new DemoClient();store.remote=true;store.production=true;store.token='offline-browser-fixture';store.principal=principal;store.data=state;
    document.body.dataset.room='admin';window.reads=0;window.freshCatalog=fresh;window.messages=[];
    const root=document.querySelector('#page-datasets');root.id='admin-storage-pane';root.querySelector('#dataset-catalog').removeAttribute('id');root.firstElementChild.dataset.datasetCatalog='';
    root.firstElementChild.innerHTML='<article class="dataset-card"><div class="dataset-card-heading"><span data-dataset-more-slot data-machine="'+state.machines[0].id+'" data-dataset="admin-cache" data-version="'+version+'"></span></div></article>';
    window.adminRemove=datasetRemoveUI(store,root,message=>messages.push(message),{management:true,catalog:()=>cached,readCatalog:async()=>{reads++;return structuredClone(freshCatalog);}});
   },{principal,state:state(),cached,fresh,version});
   assert.equal(await backend.locator('[name=dataset-machine]').count(),0);
   assert.equal(await backend.evaluate(({dataset,version})=>adminRemove.canOpenFullDelete(dataset,version),{dataset:'admin-cache',version}),true);
   const beforeRead=calls.length;
   const openRemoval=async()=>{await backend.locator('[data-remove-more]').click();await backend.locator('[data-remove-version]').click();await backend.locator('#dataset-remove-dialog[open]').waitFor();};
   await openRemoval();assert.equal(await backend.evaluate(()=>reads),1);assert.equal(calls.length,beforeRead);
   assert.equal(await backend.locator('[data-remove-confirm]').isEnabled(),true);
   assert.match(await backend.locator('.dataset-remove-facts>div:nth-child(2)').innerText(),/admin-cache · 登记名 physical-scans/);
   for(const machine of machines.slice(1))assert(await backend.locator('.dataset-remove-facts>div:last-child').innerText().then(text=>text.includes(machine.id)));
   for(const width of [1440,390,320]){
    await backend.setViewportSize({width,height:1000});await backend.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();});
    const result=await inspectGeometry(backend,{roots:['#dataset-remove-dialog[open]'],controls:'.button',containment:'.button,.dataset-remove-facts>div',buttonRows:[{parent:'.dataset-remove-dialog .modal-actions'}]});
    assert.equal(result.pass,true,JSON.stringify(result));geometry.push({name:'management-reader',role,...result});
    await backend.screenshot({path:join(shots,'management-reader-admin-'+width+'.png')});
   }
   await backend.locator('[data-remove-close]').first().click();
   await backend.evaluate(()=>{freshCatalog.datasets[0].versions[0].locations=freshCatalog.datasets[0].versions[0].locations.slice(0,1);});
   await openRemoval();assert.equal(await backend.evaluate(()=>reads),2);assert.equal(await backend.locator('[data-remove-confirm]').isDisabled(),true);
   assert.match(await backend.locator('#dataset-remove-dialog').innerText(),/这可能是最后一份完整数据/);assert.equal(calls.length,beforeRead);
   await backend.evaluate(()=>{document.body.dataset.room='datasets';});await backend.locator('#dataset-remove-dialog[open]').waitFor({state:'detached'});
   assert.deepEqual(await backend.evaluate(()=>messages),[]);
   checks.push('management:true uses the fresh all-node reader and physical name without the primary machine selector; changed last-copy proof blocks deletion; leaving admin closes the dialog; zero writes');
   await backend.unrouteAll({behavior:'ignoreErrors'});await backend.close();
  }
  await context.unrouteAll({behavior:'ignoreErrors'});await context.close();
 }
}finally{await browser.close();}
assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
await writeFile(join(shots,'checks.json'),JSON.stringify({status:'passed',checks,geometry,errors,external},null,2));
console.log(JSON.stringify({status:'passed',screenshots:shots,checks,geometryRuns:geometry.length}));
