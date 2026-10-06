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
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();await page.clock.install({time:new Date('2026-10-06T10:00:00Z')});
  let principal={userId:'local-'+role,username:'local-'+role,role},mode='DELETED',lostSubmit=false,queryLost=false,serial=0;
  const calls=[],tasks=new Map();
  const state=()=>({machines,users:[],jobs:[],executionEnabled:true});
  const json=(route,result)=>route.fulfill({contentType:'application/json',body:JSON.stringify({principal,state:state(),result})});
  const failure=(route,status,error,code)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({error,...(code?{code}:{})})});
  const fixtureCatalog=(dataset,allowed=true,capability=1)=>({datasetDelete:capability,datasets:[{dataset,versions:[{version,locations:machines.map(machine=>({machine:machine.id,dataset,state:'READY',deletionPermissions:{memberAllowed:allowed}}))}]}]});
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
     if(mode==='UNSUPPORTED')return failure(route,409,'服务器的删除能力未确认，请等待节点更新或恢复连接。','DATASET_DELETE_UNSUPPORTED');
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
   window.currentCatalog=null;window.reloads=0;
   window.removals=datasetRemoveUI(store,document.querySelector('#page-datasets'),()=>{},{catalog:()=>currentCatalog,reload:()=>{reloads++;}});
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
  await submit('scans');assert(await page.locator('.full-delete-status').innerText().then(text=>text.includes('已删除')));assert(await page.locator('.full-delete-facts').last().innerText().then(text=>text.includes('2026/10/13')));assert(await page.locator('#dataset-full-delete-dialog').innerText().then(text=>text.includes('其他名称下的副本不受影响')));
  await capture('deleted');
  if(role==='member'){assert.equal(await page.locator('[data-full-delete-action]').count(),0);assert(await page.locator('#dataset-full-delete-dialog').innerText().then(text=>text.includes('需要管理员处理')));}
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
  checks.push(role+': BLOCKED node reason, original 403 and coded 409 UNSUPPORTED');
  mode='DELETED';lostSubmit=true;queryLost=true;await open('lost-receipt');await submit('lost-receipt');assert(await page.locator('.full-delete-status').innerText().then(text=>text.includes('删除结果待确认')));assert.equal(await page.locator('[data-full-delete-action]').count(),0);assert.equal(await page.locator('.modal-actions button').count(),1);await capture('unknown');
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
  await context.unrouteAll({behavior:'ignoreErrors'});await context.close();
 }
}finally{await browser.close();}
assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
await writeFile(join(shots,'checks.json'),JSON.stringify({status:'passed',checks,geometry,errors,external},null,2));
console.log(JSON.stringify({status:'passed',screenshots:shots,checks,geometryRuns:geometry.length}));
