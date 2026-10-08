// All data and identities below are explicitly simulated browser fixtures.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const origin='https://simulated-readable-warehouse.test',root=new URL('../dist/',import.meta.url);
const output=process.env.UI_SCREENSHOTS||'/tmp/stargate-readable-warehouse';await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{for(const role of ['member','admin'])for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin);
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/datasets.css"><link rel="stylesheet" href="/dataset-flow.css"><link rel="stylesheet" href="/dataset-warehouse.css"><body class="sb" data-room="datasets"><main id="main-content"><p>模拟数据 · 只读界面验证</p><div class="page-heading"><h1 id="page-title">数据集</h1><div class="heading-actions"></div></div><section id="page-datasets"></section></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});assert(!url.pathname.includes('..'));
  return route.fulfill({body:await readFile(new URL('.'+url.pathname,root)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.goto(origin);
 await page.evaluate(async role=>{
  const {warehouseWorkspaceHTML,datasetWarehouseView}=await import('/dataset-warehouse-view.js');
  const root=document.querySelector('#page-datasets');root.innerHTML=warehouseWorkspaceHTML();
  const machine='server-a',version='a'.repeat(64);root.querySelector('[name=dataset-machine]').add(new Option(machine,machine));
  window.calls=[];window.store={production:true,principal:{userId:'fixture-reader',username:'示例成员',role},authGeneration:0,data:{machines:[{id:machine}]},onAuthChange:()=>{},call:async(operation,args)=>{calls.push({operation,args});throw Error('No reads or writes expected');}};
  const row=(dataset,canUse,ownerLabel)=>({dataset,name:dataset,labelScope:'personal',displayNameRevision:1,versions:[{version,canUse,ownerLabel,bytes:1024,files:1,state:'READY',canPrepare:false,locations:[{machine,dataset,state:'READY',canUse,ownerLabel}]}]});
  window.catalog={machine,machines:[{machine,state:'ok'}],datasets:[row('own-data',false,'所属用户：示例成员'),row('granted-data',true,'所属用户：其他成员'),row('foreign-private',false,'所属用户：其他成员')]};
  window.view=datasetWarehouseView(store,root,()=>{},{refresh:()=>{},removeUI:{canOpenFullDelete:()=>false},machineAllowed:()=>true,authorizedMachines:()=>store.data.machines,access:v=>({selectable:v.canUse===true&&v.state==='READY',browseOnly:v.canUse!==true,canRetry:false})});
  view.catalog(catalog);
 },role);
 const expected=role==='admin'?['own-data','granted-data','foreign-private']:['own-data','granted-data'];
 assert.deepEqual(await page.locator('[data-v3-select]').evaluateAll(nodes=>nodes.map(node=>node.dataset.v3Select)),expected);
 assert.equal(await page.locator('#page-title .v3-count').count(),0,'storage heading does not count datasets');
 await page.locator('[data-v3-select=own-data]').click();assert.equal(await page.locator('[data-use-dataset]').isDisabled(),true,'Own visibility never supplies a reading or training grant');
 if(width<760)await page.locator('[data-v3-back]').click();
 await page.locator('[data-v3-select=granted-data]').click();assert.equal(await page.locator('[data-use-dataset]').isEnabled(),true);
 if(role==='member'){
  if(width<760)await page.locator('[data-v3-back]').click();
  await page.locator('#warehouse-search').fill('foreign-private');assert.equal(await page.locator('[data-v3-select]').count(),0);assert.equal(await page.locator('#page-title .v3-count').count(),0,'search cannot add a misleading dataset count to the storage heading');await page.locator('#warehouse-search').fill('');
  await page.evaluate(()=>{const button=document.createElement('button');button.dataset.v3Cache='server-a';button.dataset.dataset='foreign-private';button.dataset.version='a'.repeat(64);document.querySelector('#page-datasets').append(button);button.click();button.remove();});
 }
 assert.deepEqual(await page.evaluate(()=>calls),[],'Metadata filtering and injected hidden cache buttons cause zero RPC');
 const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(geometry.scroll<=width+1,JSON.stringify(geometry));
 await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(output,role+'-'+width+'.png'),fullPage:true});
 await page.evaluate(()=>{store.principal={userId:'fixture-other',username:'其他成员',role:'member'};view.reset();view.catalog(catalog);});
 assert.deepEqual(await page.locator('[data-v3-select]').evaluateAll(nodes=>nodes.map(node=>node.dataset.v3Select)),['granted-data','foreign-private'],'A new account gets its own visible set');
 assert.deepEqual(errors,[]);await page.close();
}console.log('READABLE WAREHOUSE PASS: simulated member/admin 1440/390/320; own/granted metadata only, visible counts, no inferred grants or injected writes, new-account fence.');}finally{await browser.close();}
