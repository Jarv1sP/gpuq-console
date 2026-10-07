// Actual warehouse and cache modules, with explicit local protocol fixtures.
// No production sessions, catalog contents or writes are used.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):MACHINES;
const output=process.env.UI_SCREENSHOTS||'/tmp/stargate-warehouse-cache';await mkdir(output,{recursive:true});
const origin='https://simulated-warehouse-cache.test',root=new URL('../dist/',import.meta.url),version='a'.repeat(64);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try{for(const role of ['member','admin'])for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());await page.clock.install();
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin,'No external requests');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+['styles','fonts','starbase','shell','datasets','dataset-flow','dataset-warehouse','copy-help'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')+'<body class="sb" data-room="datasets" style="min-height:100vh;background:var(--bg)"><main id="main-content"><h1 id="page-title">数据集</h1><p>模拟数据</p><section id="page-datasets"></section></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});assert(!url.pathname.includes('..'));
  return route.fulfill({body:await readFile(new URL('.'+url.pathname,root)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.goto(origin);await page.evaluate(async({role,machines,version})=>{
  const {warehouseWorkspaceHTML,datasetWarehouseView}=await import('/dataset-warehouse-view.js'),section=document.querySelector('#page-datasets');
  section.innerHTML=warehouseWorkspaceHTML();for(const row of machines)section.querySelector('[name=dataset-machine]').add(new Option(row.id,row.id));
  window.calls=[];window.operations=new Map();window.capMode='normal';window.sequence=0;window.refreshes=0;window.lose=false;
  const source=machines[0].id,dataset='sample',callbacks=new Set();
  window.snapshot={protocol:'dataset-storage-overview-v1',warehouse:{state:'UNKNOWN',volumes:[]},caches:machines.map(row=>({machine:row.id,state:'READY',volume:{}})),
   datasets:[{dataset,versions:[{version,canUse:true,ownerLabel:'所属用户：alice',contentBytes:4096,fileCount:2,originals:[{machine:machines.at(-1).id,state:'READY'}],caches:machines.map((row,index)=>({machine:row.id,dataset:'physical-'+index,state:index===0?'READY':'NOT_LOCAL',canUse:index===0,canPrepare:index!==0}))}]}]};
  window.store={production:true,principal:{userId:'alice',username:'alice',role,enabled:true},authGeneration:0,data:{machines},onAuthChange:fn=>{callbacks.add(fn);return()=>callbacks.delete(fn);},async call(operation,args){
   calls.push({operation,args:structuredClone(args),actor:store.principal.userId});
   if(operation==='datasets.cache.capabilities'){
    if(args.dataset!==dataset||args.version!==version||!machines.some(row=>row.id===args.machine)||Object.keys(args).sort().join()!=='dataset,machine,version')throw Error('Unexpected capability target');
    if(capMode==='delayed')return new Promise(resolve=>window.releaseCapability=resolve);
    if(capMode==='404')throw Object.assign(Error('unknown operation'),{status:404});
    if(capMode==='denied')throw Object.assign(Error('读取授权已撤销'),{status:403});
    if(capMode==='old'||args.machine===machines[2].id)return {protocol:0,prepare:false,release:false};
    if(args.machine===machines.at(-1).id)throw Object.assign(Error('读取租约尚未结束'),{status:403});
    return {protocol:1,prepare:args.machine!==source,release:args.machine===source,prepareCancel:false,releaseCancel:true};
   }
   let row;
   if(operation==='datasets.cache.prepare'||operation==='datasets.cache.release'){
    if(args.dataset!==dataset||args.version!==version||Object.keys(args).sort().join()!=='dataset,key,machine,version')throw Error('Unexpected action target');
    const action=operation.split('.').at(-1),operationId='10000000-0000-4000-8000-'+String(++sequence).padStart(12,'0');
    row={...args,action,operationId,state:'RUNNING',phase:action==='prepare'?'COPYING':'RELEASING',canCancel:action==='release'};operations.set(operationId,row);
    if(lose)throw Error('模拟回执丢失');
   }else if(operation==='datasets.cache.status'){
    if(Object.keys(args).join()!=='operationId')throw Error('Status must use the original ID');row=operations.get(args.operationId);if(!row)throw Error('Unknown original ID');
   }else throw Error('Unexpected operation '+operation);
   return structuredClone(row);
  }};
  window.view=datasetWarehouseView(store,section,()=>{},{refresh(){refreshes++;view.storageOverview(snapshot);},removeUI:{canOpenFullDelete:()=>false},machineAllowed:()=>true,authorizedMachines:()=>machines,access:value=>({selectable:value.canUse&&value.state==='READY',canRetry:false})});
  view.catalog({machine:source,machines:machines.map(row=>({machine:row.id,state:'ok'})),datasets:[]});view.storageOverview(snapshot);
 },{role,machines,version});
 await page.waitForFunction(n=>calls.length===n,machines.length);await page.locator('[data-v3-select=sample]').click();
 const source=machines[0].id,target=machines[1].id,button=action=>page.locator('[data-v3-cache-action='+action+'][data-machine="'+source+'"]');
 assert.equal(await page.locator('[data-v3-cache-action=prepare]').count(),1);assert.equal(await button('release').count(),1);assert.equal(await button('transfer').count(),1);
 assert.equal(await page.locator('.v3-cache-reason').textContent(),'读取租约尚未结束');
 assert.equal(await page.locator('[data-v3-cache-action][data-machine="'+machines[2].id+'"]').count(),0,'Protocol 0 has no new action');
 assert.equal(await page.locator('[data-v3-cache]').count(),0,'A denied new contract is not bypassed through the old prepare flow');
 assert((await page.evaluate(()=>calls)).every(row=>row.operation==='datasets.cache.capabilities'));
 await button('transfer').click();assert.equal(await page.locator('#warehouse-cache-action select option').count(),1);
 assert.equal(await page.locator('[data-cache-transfer-source] [data-cache-start]').count(),0);
 await page.locator('[data-cache-transfer-target] [data-cache-start]').click();await page.waitForFunction(()=>document.querySelector('[data-state=RUNNING]'));
 assert.equal(await page.locator('[data-cache-transfer-target] [data-cache-cancel]').count(),0,'Shared prepare cannot be canceled');
 assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.release').length),0);
 await page.evaluate(()=>{const row=operations.values().next().value;row.phase='READY';});await page.locator('[data-cache-query]').click();
 assert.equal(await page.locator('[data-cache-transfer-source] [data-cache-start]').count(),0,'Phase READY does not complete preparation');
 await page.evaluate(()=>{const row=operations.values().next().value;row.state='READY';row.canCancel=false;});await page.locator('[data-cache-query]').click();
 await page.locator('[data-cache-transfer-source] [data-cache-start]').waitFor();
 assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.release').length),0,'Confirmed READY only offers separate release');
 assert.equal(await page.locator('[data-cache-transfer-source] [data-cache-start]').textContent(),'释放原服务器缓存');
 await page.waitForFunction(()=>document.querySelector('link[data-cache-operation-style]')?.sheet);
 await page.evaluate(()=>document.fonts.ready);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 for(const control of await page.locator('#warehouse-cache-action .button:visible,#warehouse-cache-action select:visible').all()){
  const rect=await control.boundingBox();assert(rect.x>=-1&&rect.x+rect.width<=width+1&&rect.height>=44,JSON.stringify({rect,element:await control.evaluate(node=>node.outerHTML)}));
 }
 await page.screenshot({path:join(output,'transfer-'+role+'-'+width+'.png')});
 await page.locator('[data-cache-transfer-source] [data-cache-start]').click();await page.waitForFunction(()=>document.querySelector('[data-state=RUNNING]'));
 const writes=await page.evaluate(()=>calls.filter(row=>/datasets.cache.(prepare|release)$/.test(row.operation)));
 assert.equal(writes.length,2);assert.equal(writes[0].args.machine,target);assert.equal(writes[1].args.machine,source);assert.notEqual(writes[0].args.key,writes[1].args.key);
 assert(writes.every(row=>row.args.dataset==='sample'&&row.args.version===version),'Use logical dataset and full version, never physical alias');
 await page.evaluate(()=>{const row=[...operations.values()].find(row=>row.action==='release');row.state='RELEASED';row.phase='RELEASED';row.canCancel=false;row.receiptOnly=true;row.locationState='NOT_OBSERVED';});
 await page.locator('[data-cache-transfer-source] [data-cache-query]').click();await page.locator('[data-state=RELEASED]').waitFor();
 await page.locator('[data-v3-cache-close]').click();assert.equal(await page.locator('.v3-server').filter({has:page.locator('.v3-server-text>b[title="'+source+'"]')}).locator('.v3-g.ready').count(),1,'Historical RELEASED does not overwrite a fresh READY catalog location');
 for(const mode of ['old','denied','404']){
  await page.evaluate(mode=>{capMode=mode;view.storageOverview(snapshot);},mode);
  await page.waitForFunction(mode=>mode==='404'?document.querySelector('[data-v3-cache]'):document.querySelector('[data-v3-cache-action]')===null,mode);
  await page.clock.runFor(100);
  assert.equal(await page.locator('[data-v3-cache-action]').count(),0);
  if(mode==='denied'){assert.equal(await page.locator('[data-v3-cache]').count(),0);assert.equal(await page.locator('.v3-cache-reason').first().textContent(),'读取授权已撤销');}
 }
 await page.evaluate(()=>{capMode='delayed';view.storageOverview(snapshot);});await page.waitForFunction(()=>typeof releaseCapability==='function');
 await page.evaluate(()=>{store.principal={userId:'bob',username:'bob',role:'member'};store.authGeneration++;view.reset();view.catalog({machine:null,machines:store.data.machines.map(row=>({machine:row.id,state:'ok'})),datasets:[]});releaseCapability({protocol:1,prepare:true,release:true});});
 await page.clock.runFor(5000);assert.equal(await page.locator('[data-v3-cache-action]').count(),0);assert.equal(await page.locator('#warehouse-cache-action').isVisible(),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('stargate.cache-operations.v1:bob')),null);assert.equal(await page.evaluate(()=>calls.filter(row=>/datasets.cache.(prepare|release)$/.test(row.operation)).length),2);
 assert.deepEqual(errors,[]);await page.close();
}console.log('WAREHOUSE CACHE UI PASS: protocol1/0/403/404; explicit prepare, confirmed target before separate release; logical refs; receipt-only location truth; stale account denial; member/admin 1440/390/320.');}finally{await browser.close();}
