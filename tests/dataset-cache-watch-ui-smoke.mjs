import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const origin='https://offline-cache-watch.test',root=new URL('../dist/',import.meta.url),version='a'.repeat(64),operationId='b'.repeat(64);
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):(await import('../dist/machines.js')).MACHINES;
const output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-cache-watch','cache-watch');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{for(const role of ['member','admin'])for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.clock.install();
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin,'no external request');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/datasets.css"><link rel="stylesheet" href="/dataset-flow.css"><link rel="stylesheet" href="/dataset-warehouse.css"><body class="sb" data-room="datasets"><main id="main-content" tabindex="-1"><div class="page-heading"><div><h1 id="page-title">数据集</h1></div><div class="heading-actions"></div></div><section data-page="datasets" id="page-datasets"></section></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});assert(!url.pathname.includes('..'));
  const body=await readFile(new URL('.'+url.pathname,root));return route.fulfill({body,contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.goto(origin);
 await page.evaluate(async({machines,role,version,operationId})=>{
  const {datasetWarehouseView,warehouseWorkspaceHTML}=await import('/dataset-warehouse-view.js');
  const section=document.querySelector('#page-datasets');section.innerHTML=warehouseWorkspaceHTML();const select=section.querySelector('[name=dataset-machine]');for(const machine of machines)select.add(new Option(machine.id,machine.id));select.value=machines[0].id;
  window.calls=[];window.toasts=[];window.state='REGISTERED';window.status='PREPARING';window.progress=false;window.lose=false;window.allow=true;window.refreshes=0;
  window.catalog=machine=>({machine,partial:false,machines:machines.map(row=>({machine:row.id,state:'ok'})),datasets:[{dataset:'sample',versions:[{version,state:machine===machines[1].id?window.state:'READY',canUse:window.allow,canPrepare:true,bytes:4*1024**2,files:4,ownerLabel:'所属用户：示例成员',locations:machines.map((row,i)=>({machine:row.id,dataset:'sample',state:i===1?window.state:'READY',canUse:true,canPrepare:true}))}]}]});
  window.store={production:true,principal:{userId:'alice',role},authGeneration:0,data:{machines},onAuthChange:()=>{},call:async(operation,args)=>{
   calls.push({operation,args:structuredClone(args),user:store.principal?.userId});
   if(operation==='datasets.catalog')return catalog(args.machine);
   if(operation==='datasets.prepare'){if(window.lose)throw Error('模拟回执丢失');return {dataset:'sample',version,state:'PREPARING',operationId};}
   if(operation==='datasets.status')return {dataset:'sample',version,state:window.status,...(args.operationId?{operationId}:{}),...(window.progress?{remainingBytes:3*1024**2}:{}),...(window.status==='FAILED'?{error:'源服务器暂时不可用'}:{})};
   throw Error('unexpected operation '+operation);
  }};
  window.view=datasetWarehouseView(store,section,message=>toasts.push(message),{refresh:async()=>{window.refreshes++;window.state='READY';view.catalog(catalog(machines[0].id));},removeUI:{canOpenFullDelete:()=>false},machineAllowed:()=>!!store.principal,authorizedMachines:()=>machines,access:v=>({prepare:v.canUse===true&&v.state!=='READY',selectable:v.state==='READY'&&v.canUse,canRetry:false})});
  view.catalog(catalog(machines[0].id));
 },{machines,role,version,operationId});
 const target=machines[1].id,row=page.locator('.v3-server').filter({has:page.locator('b',{hasText:target})});
 if(width<760)await page.locator('[data-v3-select]').click();
 await page.locator('[data-v3-cache="'+target+'"]').click();assert.equal(await row.locator('[role=status]').textContent(),'取回中');assert.equal(await row.locator('[data-v3-cache]').count(),0);
 await page.evaluate(()=>window.progress=true);await page.clock.runFor(1501);assert.equal(await row.locator('[role=status]').textContent(),'取回中 · 1.0 MiB / 4.0 MiB');
 const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,rows:[...document.querySelectorAll('.v3-server')].map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right};})}));assert(geometry.scroll<=width+1,JSON.stringify(geometry));assert(geometry.rows.every(row=>row.left>=-1&&row.right<=width+1));
 await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(output,role+'-progress-'+width+'.png'),fullPage:true,animations:'disabled'});
 await page.evaluate(()=>window.status='READY');await page.clock.runFor(1501);assert.equal(await page.evaluate(()=>refreshes),1);assert.match(await row.textContent(),/已缓存/);assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.prepare').length),1);
 const count=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.status').length);await page.clock.runFor(5000);assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.status').length),count,'READY stops polling');
 if(width===1440){
  await page.evaluate(()=>{view.reset();window.state='REGISTERED';window.status='PREPARING';window.lose=true;window.progress=false;view.catalog(catalog(store.data.machines[0].id));});
  await page.locator('[data-v3-cache="'+target+'"]').click();assert.match(await row.textContent(),/待确认/);await page.evaluate(()=>window.status='READY');await page.clock.runFor(1501);
  const request=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.status').at(-1));assert.deepEqual(request.args,{machine:target,dataset:'sample',version});assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.prepare').length),2,'lost reply never redispatches');
  await page.evaluate(()=>{view.reset();window.state='REGISTERED';window.status='PREPARING';window.lose=false;view.catalog(catalog(store.data.machines[0].id));});await page.locator('[data-v3-cache="'+target+'"]').click();await page.evaluate(()=>document.body.dataset.room='workbench');await page.clock.runFor(5000);
  const paused=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.status').length);assert.equal(paused,count+1,'leaving room stops reads');
  await page.evaluate(()=>{document.body.dataset.room='datasets';window.status='FAILED';});await page.clock.runFor(1501);assert.match(await row.textContent(),/取回失败/);assert.equal(await row.locator('[data-v3-cache]').textContent(),'重试');
  const failed=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.status').length);await page.clock.runFor(5000);assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.status').length),failed);
  await page.evaluate(()=>{view.reset();window.state='REGISTERED';window.allow=true;view.catalog(catalog(store.data.machines[0].id));window.allow=false;});const writes=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.prepare').length);await page.locator('[data-v3-cache="'+target+'"]').click();assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.prepare').length),writes,'fresh permission denial is zero dispatch');
 }
 await page.evaluate(()=>{view.reset();window.allow=true;window.state='REGISTERED';window.status='PREPARING';window.lose=false;window.progress=false;view.catalog(catalog(store.data.machines[0].id));});
 if(width<760)await page.locator('[data-v3-select]').click();
 await page.locator('[data-v3-cache="'+target+'"]').click();assert.match(await row.textContent(),/取回中/);
 await page.evaluate(()=>{window.state='FAILED';view.catalog(catalog(store.data.machines[0].id));});
 assert.match(await row.textContent(),/取回失败/,'A confirmed failed directory replaces the pending watch immediately');
 assert.equal(await row.locator('[data-v3-cache]').textContent(),'重试');assert.equal(await row.locator('[data-v3-cache]').isEnabled(),true);
 const catalogFailureReads=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.status').length),catalogFailureWrites=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.prepare').length);
 await page.clock.runFor(5000);assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.status').length),catalogFailureReads,'Confirmed catalog failure stops status polling');assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.prepare').length),catalogFailureWrites,'A catalog failure never retries preparation automatically');
 assert.deepEqual(errors,[]);await page.close();
}console.log('CACHE WATCH UI PASS: member/admin 1440/390/320; fixed original reads, real progress, READY/FAILED stop, lost reply no replay, room and fresh permission guard.');}finally{await browser.close();}
