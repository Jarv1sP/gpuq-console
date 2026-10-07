import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES as exampleMachines} from '../dist/machines.js';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';
import {inspectGeometry} from './layout-geometry.mjs';

const MACHINES=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):exampleMachines;
const origin='https://offline-personal-remove.test',version='a'.repeat(64),dataset='my-training-data',physical='private-upload-v1',operationId='b'.repeat(64),errors=[],outside=[],shots=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-personal-remove','personal-remove');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});await mkdir(shots,{recursive:true});
try{
 for(const role of ['member','admin']){
  let principal={userId:'personal-'+role,username:'personal-'+role,role},mode='normal',receipt=null,release,started,holdRead=false;
  const calls=[],messages=[],catalog=()=>({datasetDelete:1,partial:false,datasets:[{dataset,versions:[{version,locations:MACHINES.map((machine,index)=>({machine:machine.id,dataset:index===0?physical:dataset,state:'READY',deletionPermissions:{memberAllowed:true}}))}]}]});
  let fresh=catalog();const state={machines:MACHINES,users:[],jobs:[],executionEnabled:true};
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin){outside.push(url.href);return route.abort();}
   const json=result=>route.fulfill({contentType:'application/json',body:JSON.stringify({result,principal,state})});
   if(url.pathname==='/api/call'){
    const {operation,args}=route.request().postDataJSON();calls.push({operation,args});
    if(operation==='datasets.catalog'){assert.deepEqual(args,{machine:MACHINES[0].id});const result=structuredClone(fresh);if(holdRead){holdRead=false;started();await new Promise(resolve=>release=resolve);}return json(result);}
    if(operation==='datasets.unregister'){
     assert.deepEqual(args,{machine:MACHINES[0].id,dataset:physical,version});receipt={operationId,dataset:physical,version,state:'UNREGISTERING'};
     if(mode==='lost')return route.abort('failed');
     if(mode==='forbidden')return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'这份数据只能由管理员删除。'})});
     return json(receipt);
    }
    if(operation==='datasets.status'){assert.deepEqual(args,{machine:MACHINES[0].id,operationId});return json(receipt);}
    throw Error('Personal removal cannot invoke '+operation);
   }
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/copy-help.css"></head><body class="sb" data-room="datasets"><div class="shell"><header class="topbar"><span class="wordmark" aria-label="STARGATE"></span></header><main><h1>数据集</h1><section id="page-datasets"><button class="button quiet" data-existing-delete-entry>删除数据集…</button></section></main></div></body></html>'});
   const asset=STARBASE_ASSETS[url.pathname]||(url.pathname.match(/^\/[a-z-]+\.(?:js|css)$/)&&url.pathname.slice(1));
   if(asset)return route.fulfill({contentType:asset.endsWith('.woff2')?'font/woff2':asset.endsWith('.js')?'text/javascript':'text/css',body:await readFile(new URL('../dist/'+asset,import.meta.url))});
   if(url.pathname==='/favicon.ico')return route.fulfill({status:204});outside.push(url.href);return route.abort();
  });
  const bootstrap=async()=>page.evaluate(async({principal,state,catalog,dataset,version})=>{
   const {DemoClient}=await import('/client.js'),{datasetRemoveUI,personalRemovalStorageKey}=await import('/dataset-remove-ui.js');
   window.store=new DemoClient();store.remote=true;store.production=true;store.token='offline-fixture';store.principal=principal;store.data=state;window.currentCatalog=catalog;window.messages=[];window.reloaded=0;
   window.removals=datasetRemoveUI(store,document.querySelector('#page-datasets'),message=>messages.push(message),{management:false,catalog:()=>currentCatalog,reload:()=>reloaded++});
   window.personalKey=personalRemovalStorageKey(principal.userId);document.querySelector('[data-existing-delete-entry]').onclick=()=>removals.openFullDelete(dataset,version);
  },{principal,state,catalog:catalog(),dataset,version});
  const reset=async()=>{await page.goto(origin);await page.evaluate(()=>localStorage.clear());await bootstrap();fresh=catalog();mode='normal';};
  const open=async()=>{await page.locator('[data-existing-delete-entry]').click();await page.locator('[data-full-delete-personal]').click();await page.locator('#personal-remove-dialog [data-personal-remove-confirm]').waitFor();};
  const writeCount=()=>calls.filter(call=>call.operation==='datasets.unregister').length;
  await page.goto(origin);await bootstrap();
  for(const cap of [0,'1',true,null]){
   await page.evaluate(cap=>{currentCatalog.datasetDelete=cap;},cap);assert.equal(await page.evaluate(({dataset,version})=>removals.openFullDelete(dataset,version),{dataset,version}),false);assert.equal(await page.locator('[data-full-delete-personal]').count(),0);
  }
  for(const field of [false,undefined]){
   await page.evaluate(field=>{currentCatalog.datasetDelete=1;currentCatalog.datasets[0].versions[0].locations.forEach(row=>row.deletionPermissions=field===undefined?undefined:{memberAllowed:field});},field);
   assert.equal(await page.evaluate(({dataset,version})=>removals.openFullDelete(dataset,version),{dataset,version}),false);
  }
  assert.equal(calls.length,0,'unsupported or unproved permission renders no entry and sends no request');await page.evaluate(catalog=>currentCatalog=catalog,catalog());await open();assert.equal(writeCount(),0);
  assert.equal(await page.locator('[name=personal-remove-machine]').inputValue(),MACHINES[0].id);assert.match(await page.locator('#personal-remove-dialog').innerText(),/其他服务器上的完整副本/);assert.match(await page.locator('#personal-remove-dialog').innerText(),new RegExp(physical));
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});
   const geometry=await inspectGeometry(page,{roots:['#personal-remove-dialog'],controls:'button,select',containment:'button,select,.personal-remove-copies,.personal-remove-copies .server-id',scrollPanels:['#personal-remove-dialog']});assert.deepEqual(geometry.failures,[],JSON.stringify({role,width,...geometry}));
   await page.screenshot({path:join(shots,'confirm-'+role+'-'+width+'.png'),animations:'disabled'});
  }
  await page.locator('[data-personal-remove-confirm]').click();await page.locator('[data-personal-removal-record]').waitFor();assert.equal(writeCount(),1);assert.equal(calls.filter(call=>call.operation.startsWith('datasets.delete')).length,0);
  receipt={...receipt,state:'UNREGISTERED',unregistered:true};await page.locator('[data-personal-removal-query] [type=submit]').click();await page.waitForFunction(()=>!document.querySelector('[data-personal-removal-record]'));assert.equal(await page.evaluate(()=>reloaded),1);assert.equal(writeCount(),1);
  await reset();fresh.datasets[0].versions[0].locations.slice(1).forEach(row=>row.state='NOT_LOCAL');await open();assert.equal(await page.locator('[data-personal-remove-confirm]').isDisabled(),true);assert.match(await page.locator('#personal-remove-dialog').innerText(),/最后一份完整数据/);assert.equal(writeCount(),1);
  await reset();fresh.datasets[0].versions[0].locations.forEach(row=>row.deletionPermissions.memberAllowed=false);await page.locator('[data-existing-delete-entry]').click();await page.locator('[data-full-delete-personal]').click();await page.locator('#personal-remove-dialog').filter({hasText:'当前不能按机器删除'}).waitFor();assert.equal(await page.locator('[data-personal-remove-confirm]').count(),0);assert.equal(writeCount(),1);
  await reset();await open();mode='lost';await page.locator('[data-personal-remove-confirm]').click();await page.locator('[data-personal-removal-record]').filter({hasText:'移除结果待确认'}).waitFor();const lost=writeCount();assert.equal(lost,2);
  await page.reload();await bootstrap();assert.equal(writeCount(),lost);assert.equal(await page.locator('[name=operationId]').count(),1);assert.equal(calls.filter(call=>call.operation==='datasets.status').length,1,'reload does not auto-query an unknown task');
  await open();assert.equal(await page.locator('[data-personal-remove-confirm]').isDisabled(),true,'unknown target cannot be removed again');await page.locator('[aria-label="关闭移除确认"]').click();
  receipt={operationId,dataset:physical,version,state:'UNREGISTERED',unregistered:true};await page.locator('[name=operationId]').fill(operationId);await page.locator('[data-personal-removal-query] [type=submit]').click();await page.waitForFunction(()=>!document.querySelector('[data-personal-removal-record]'));assert.equal(writeCount(),lost);assert.deepEqual(calls.at(-1).args,{machine:MACHINES[0].id,operationId});
  await reset();await open();mode='forbidden';await page.locator('[data-personal-remove-confirm]').click();await page.locator('.personal-removal-records').filter({hasText:'这份数据只能由管理员删除。'}).waitFor();assert.equal(writeCount(),lost+1);
  await reset();holdRead=true;const oldRead=new Promise(resolve=>started=resolve);await page.locator('[data-existing-delete-entry]').click();await page.locator('[data-full-delete-personal]').click();await oldRead;
  await page.locator('[data-personal-remove-close]').click();fresh.datasets[0].versions[0].locations.slice(1).forEach(row=>row.state='NOT_LOCAL');await open();assert.equal(await page.locator('[data-personal-remove-confirm]').isDisabled(),true);
  const oldResponse=page.waitForResponse(res=>res.request().postDataJSON()?.operation==='datasets.catalog');release();await (await oldResponse).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.locator('[data-personal-remove-confirm]').isDisabled(),true,'retired complete-copy reply cannot enable a newer blocked confirmation');
  await reset();holdRead=true;const reading=new Promise(resolve=>started=resolve);await page.locator('[data-existing-delete-entry]').click();await page.locator('[data-full-delete-personal]').click();await reading;
  await page.evaluate(()=>{document.body.dataset.room='work';});await page.locator('#personal-remove-dialog').waitFor({state:'hidden'});const response=page.waitForResponse(res=>res.request().postDataJSON()?.operation==='datasets.catalog');release();await response;assert.equal(await page.locator('#personal-remove-dialog[open]').count(),0);assert.equal(writeCount(),lost+1);
  await reset();await open();await page.evaluate(()=>{window.retiredPersonalForm=document.querySelector('#personal-remove-dialog form');store.authGeneration++;store.principal={userId:'other-member',role:'member'};store.authListeners.forEach(listener=>listener());retiredPersonalForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  assert.equal(await page.locator('#personal-remove-dialog[open]').count(),0);assert.equal(await page.locator('[data-personal-removal-record]').count(),0);assert.equal(writeCount(),lost+1,'retired account form never sends a deletion');
  await context.unrouteAll({behavior:'ignoreErrors'});await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log('PERSONAL REMOVE PASS: cap0/missing permission hidden, fresh physical name and complete-copy proof, confirmation, original receipt/unknown/reload, 403, account/room retirement, member/admin 1440/390/320; no full-delete or privilege fields.');
}finally{for(const context of browser.contexts())await context.unrouteAll({behavior:'ignoreErrors'});await browser.close();}
