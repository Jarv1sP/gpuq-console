// Future cache protocol is simulated. This is not a production capability claim.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const origin='https://simulated-cache-operation.test',version='a'.repeat(64),root=new URL('../dist/',import.meta.url);
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):(await import('../dist/machines.js')).MACHINES;
const output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-cache-operation','cache-operation');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{for(const role of ['member','admin'])for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
 page.on('pageerror',cause=>errors.push(cause.message));await page.clock.install();
 page.on('dialog',dialog=>dialog.accept());
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin,'all data is simulated, zero external requests');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/copy-help.css"><body class="sb"><main style="max-width:480px;margin:40px auto;padding:16px"><h1>缓存操作</h1><p>模拟数据</p><div id="fixture"></div></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});
  assert(!url.pathname.includes('..'));return route.fulfill({body:await readFile(new URL('.'+url.pathname,root)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.goto(origin);
 await page.evaluate(async({role,machines,version})=>{
  const {mountCacheOperation,mountCacheTransfer}=await import('/dataset-cache-operation.js');
  window.calls=[];window.operations=new Map();window.capabilities=new Map(machines.map((row,index)=>[row.id,{protocol:1,prepare:index!==0&&index!==3,release:index===0}]));
  window.sequence=0;window.lose=false;window.hold=false;window.prepareState='RUNNING';window.preparePhase='COPYING';window.callbacks=new Set();window.active=true;
  window.store={production:true,principal:{userId:'alice',role,enabled:true},authGeneration:0,onAuthChange:callback=>{callbacks.add(callback);return ()=>callbacks.delete(callback);},call:async(operation,args)=>{
   const actor=store.principal.userId;calls.push({operation,args:structuredClone(args),actor});
   if(operation==='datasets.cache.capabilities')return structuredClone(capabilities.get(args.machine));
   let row;
   if(operation==='datasets.cache.prepare'||operation==='datasets.cache.release'){
    const action=operation.split('.').at(-1),operationId='10000000-0000-4000-8000-'+String(++sequence).padStart(12,'0');
    row={...args,operationId,action,state:action==='prepare'?prepareState:'RELEASING',phase:action==='prepare'?preparePhase:'RELEASING',canCancel:true,bytes:1024**2,totalBytes:4*1024**2,actor};operations.set(operationId,row);
    if(hold)await new Promise(resolve=>window.completeDelayed=resolve);
    if(lose)throw Error('模拟回执丢失');
   }else{
    row=operations.get(args.operationId);if(!row||row.actor!==actor)throw Object.assign(Error('模拟404'),{status:404});
    if(operation==='datasets.cache.cancel'){row.state='CANCELING';row.phase='STOPPING';row.canCancel=false;}
    else if(operation!=='datasets.cache.status')throw Error('unexpected simulated operation '+operation);
   }
   return structuredClone(row);
  }};
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copied=text},configurable:true});
  window.host=document.querySelector('#fixture');
  window.mount=(raw={protocol:1,prepare:true,release:true},action='prepare')=>window.ui=mountCacheOperation(host,{store,action,machine:machines[action==='prepare'?1:0].id,dataset:'sample',version,capabilities:raw,active:()=>active});
  window.transfer=()=>window.ui=mountCacheTransfer(host,{store,source:machines[0].id,targets:machines.slice(1).map(row=>({machine:row.id,capabilities:capabilities.get(row.id)})),dataset:'sample',version});
  window.clean=()=>{ui?.destroy();host.replaceChildren();localStorage.clear();};
  host.innerHTML='<span>现有缓存操作</span>';window.baseline=host.innerHTML;window.ui={destroy(){}};
 },{role,machines,version});
 // Undefined capabilities leave the existing UI unchanged, without probing or dispatching.
 await page.evaluate(async({machine,version})=>{const {mountCacheOperation}=await import('/dataset-cache-operation.js');ui.destroy();host.innerHTML=baseline;ui=mountCacheOperation(host,{store,action:'prepare',machine,dataset:'sample',version,capabilities:null});},{machine:machines[1].id,version});
 assert.equal(await page.locator('#fixture').innerHTML(),'<span>现有缓存操作</span>');assert.deepEqual(await page.evaluate(()=>calls),[]);
 await page.evaluate(()=>{clean();transfer();});assert.equal(await page.locator('[data-cache-transfer-body]').isVisible(),false);
 assert.equal(await page.locator('[data-cache-start]').count(),0);assert.equal(await page.locator('[data-copy-help]').count(),1);
 await page.locator('[data-cache-transfer-open]').click();assert.equal(await page.locator('select option').count(),2);
 await page.locator('[data-cache-start]').click();await page.waitForFunction(()=>document.querySelector('[data-state=RUNNING]'));
 const prepare=await page.evaluate(()=>calls.find(row=>row.operation==='datasets.cache.prepare'));assert.deepEqual(Object.keys(prepare.args).sort(),['dataset','key','machine','version']);assert.equal(prepare.args.machine,machines[1].id);
 assert.equal(await page.locator('[data-cache-transfer-source] [data-cache-start]').count(),0,'no release before READY');
 await page.locator('[data-cache-copy]').click();const original=await page.evaluate(()=>operations.values().next().value.operationId);assert.equal(await page.evaluate(()=>copied),original);
 assert.equal(await page.locator('.cache-operation-id code').textContent(),original.slice(0,8)+'…'+original.slice(-4));assert.equal(await page.locator('.cache-operation-progress').textContent(),'1.0 MiB / 4.0 MiB');
 assert.equal(await page.locator('[data-copy-help]').count(),1);assert.equal(await page.locator('select').isDisabled(),true);
 const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,rects:[...document.querySelectorAll('#fixture .button,#fixture input,#fixture select')].filter(node=>node.getBoundingClientRect().width>0).map(node=>node.getBoundingClientRect().toJSON())}));
 assert(geometry.scroll<=width+1,JSON.stringify(geometry));assert(geometry.rects.every(rect=>rect.left>=-1&&rect.right<=width+1&&rect.height>=44),JSON.stringify(geometry));
 await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(output,'transfer-'+role+'-'+width+'.png'),fullPage:true,animations:'disabled'});
 await page.evaluate(()=>{const row=operations.values().next().value;row.phase='READY';});await page.clock.runFor(1501);
 assert.equal(await page.locator('[data-state=RUNNING]').count(),1);assert.equal(await page.locator('[data-cache-transfer-source] [data-cache-start]').count(),0,'phase READY alone is not completion');
 await page.evaluate(()=>{const row=operations.values().next().value;row.state='READY';row.canCancel=false;});await page.clock.runFor(1501);
 await page.waitForFunction(()=>document.querySelector('[data-cache-transfer-source] [data-cache-start]'));
 assert.equal(await page.locator('[data-cache-transfer-target] .cache-operation-progress').count(),0,'terminal receipt does not retain an old progress fraction');
 assert.equal(await page.locator('[data-cache-transfer-source] [data-cache-start]').textContent(),'释放原服务器缓存');
 assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.release').length),0,'READY never automatically releases source');
 await page.locator('[data-cache-transfer-source] [data-cache-start]').click();await page.waitForFunction(()=>document.querySelector('[data-state=RELEASING]'));
 const release=await page.evaluate(()=>calls.find(row=>row.operation==='datasets.cache.release'));assert.equal(release.args.machine,machines[0].id);assert.equal(release.args.dataset,'sample');assert.equal(release.args.version,version);assert.notEqual(release.args.key,prepare.args.key);
 assert.equal(await page.evaluate(()=>calls.filter(row=>/unregister|evict/.test(row.operation)).length),0);
 await page.locator('[data-cache-transfer-source] [data-cache-cancel]').click();await page.waitForFunction(()=>document.querySelector('[data-state=CANCELING]'));assert.equal(await page.locator('[data-state=CANCELED]').count(),0);
 await page.evaluate(()=>{const row=[...operations.values()].find(row=>row.action==='release');row.state='CANCELED';row.phase='STOPPED';});await page.clock.runFor(1501);assert.equal(await page.locator('[data-state=CANCELED]').count(),1);
 await page.evaluate(()=>{clean();capabilities.set([...capabilities.keys()][0],{protocol:1,prepare:false,release:false,reason:'读取租约尚未结束 · 迁移保护'});mount({protocol:1,prepare:false,release:false,reason:'读取租约尚未结束 · 迁移保护'},'release');});
 assert.equal(await page.locator('[data-cache-start]').count(),0);assert.equal(await page.locator('[role=alert]').textContent(),'读取租约尚未结束 · 迁移保护');assert.equal(await page.locator('[role=alert]').getAttribute('title'),'读取租约尚未结束 · 迁移保护');
 await page.screenshot({path:join(output,'blocked-'+role+'-'+width+'.png'),fullPage:true,animations:'disabled'});
 await page.evaluate(()=>capabilities.set([...capabilities.keys()][0],{protocol:1,prepare:false,release:true}));await page.locator('[data-cache-check]').click();await page.waitForFunction(()=>document.querySelector('[data-cache-start]'));
 await page.locator('[data-cache-start]').click();await page.waitForFunction(()=>document.querySelector('[data-state=RELEASING]'));assert.equal(await page.locator('[data-state=RELEASED]').count(),0);
 await page.evaluate(()=>{const row=[...operations.values()].findLast(row=>row.action==='release');row.state='RELEASED';row.phase='RELEASED';row.canCancel=false;});await page.locator('[data-cache-query]').click();await page.waitForFunction(()=>document.querySelector('[data-state=RELEASED]'));
 assert.equal(await page.locator('[data-cache-start],[data-cache-cancel]').count(),0,'confirmed release is terminal');
 if(width===1440){
  await page.evaluate(()=>{clean();lose=true;mount();});await page.locator('[data-cache-start]').click();await page.waitForFunction(()=>document.querySelector('[data-cache-id-form]'));
  const before=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.prepare').length);
  assert.equal(await page.locator('[data-cache-start]').count(),0);await page.clock.runFor(5000);assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.prepare').length),before);
  const lost=await page.evaluate(()=>[...operations.values()].at(-1).operationId);await page.locator('[name=operationId]').fill(lost);await page.evaluate(()=>lose=false);await page.locator('[data-cache-id-form] button').click();await page.waitForFunction(()=>document.querySelector('[data-state=RUNNING]'));
  await page.evaluate(()=>{ui.destroy();mount();});await page.clock.runFor(1501);assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.prepare').length),before);
  assert.deepEqual(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.cache.status').at(-1).args),{operationId:lost});
  await page.evaluate(()=>{store.principal.userId='bob';store.authGeneration++;for(const callback of callbacks)callback();});assert.equal(await page.locator('.cache-operation').count(),0);
  const calls=await page.evaluate(()=>window.calls.length);await page.clock.runFor(5000);assert.equal(await page.evaluate(()=>window.calls.length),calls,'no reads for retired account');
 }
 assert.deepEqual(errors,[]);await page.close();
}console.log('CACHE OPERATION UI SIMULATED PASS: prepare/transfer/release/cancel, original UUID recovery, exact keys, account isolation, real bytes, old capability zero UI/calls, one help, member/admin 1440/390/320. No production availability claim.');}finally{await browser.close();}
