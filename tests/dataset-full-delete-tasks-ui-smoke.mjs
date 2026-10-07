// The storage room supplies the host; all records/API results are local fixtures.
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';
import {MACHINES} from '../dist/machines.js';
import {inspectGeometry} from './layout-geometry.mjs';

const origin='https://offline-delete-tasks.test',errors=[],outside=[],shots=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-delete-tasks','delete-tasks');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
await mkdir(shots,{recursive:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){outside.push(url.href);return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/copy-help.css"></head><body class="sb" data-room="admin"><div class="shell"><header class="topbar"><span class="wordmark" aria-label="STARGATE"></span></header><main><h1>数据与存储</h1><section id="storage-pane"><div id="delete-task-host"></div></section></main></div></body></html>'});
  const asset=STARBASE_ASSETS[url.pathname]||(url.pathname.match(/^\/[a-z-]+\.(?:js|css)$/)&&url.pathname.slice(1));
  if(asset)return route.fulfill({contentType:asset.endsWith('.woff2')?'font/woff2':asset.endsWith('.js')?'text/javascript':'text/css',body:await readFile(new URL('../dist/'+asset,import.meta.url))});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});outside.push(url.href);return route.abort();
 });
 await page.goto(origin);await page.clock.install({time:new Date('2026-10-07T10:00:00Z')});
 await page.evaluate(async machines=>{
  const {datasetRemoveUI}=await import('/dataset-remove-ui.js'),{fullDeleteStorageKey}=await import('/dataset-full-delete-state.js');
  const version='a'.repeat(64),until='2026-10-14T10:00:00Z';window.calls=[];window.authListeners=[];window.tasks=new Map();window.reloads=0;
  const rows=['waiting','deleted','unknown'].map((dataset,index)=>{
   const key=`10000000-0000-4000-8000-${(index+1).toString().padStart(12,'0')}`,operationId=`20000000-0000-4000-8000-${(index+1).toString().padStart(12,'0')}`;
   const task={key,operationId,dataset,version,state:['WAITING_CONTINUE','DELETED','UNKNOWN'][index],canContinue:index===0,retainUntil:until,events:[],steps:machines.map((machine,n)=>({machine:machine.id,dataset,operationId:`30000000-0000-4000-8000-${(n+1).toString().padStart(12,'0')}`,phase:'commit',state:index===1?'ISOLATED':'PLANNED',complete:n===0,retainUntil:until}))};
   tasks.set(key,task);return {key,operationId,dataset,version,state:task.state,task,confirmed:true,startedAt:Date.now()};
  });
  window.catalog={datasetDelete:1,datasets:rows.map(row=>({dataset:row.dataset,versions:[{version,locations:machines.map(machine=>({machine:machine.id,state:'READY'}))}]}))};
  window.store={principal:{userId:'task-admin',role:'admin'},authGeneration:0,data:{machines},onAuthChange:listener=>authListeners.push(listener),call:async(operation,args)=>{
   calls.push({operation,args:structuredClone(args)});
   if(operation==='datasets.delete.status'){
    const task=tasks.get(args.key);if(task?.dataset==='unknown')throw Error('删除结果未确认');return structuredClone(task);
   }
   const task=[...tasks.values()].find(row=>row.operationId===args.operationId);if(!task)throw Error('Unknown original operation');
   if(operation==='datasets.delete.continue'){task.state='RUNNING';return structuredClone(task);}
   if(operation==='datasets.delete.cancel'){task.state='CANCELED';return structuredClone(task);}
   if(operation==='datasets.delete.restore'){
    task.state='BLOCKED';task.steps[0].restoreState='RESTORED';return {operationId:task.operationId,machine:args.machine,dataset:task.dataset,version,state:'RESTORED'};
   }
   throw Error('Task list cannot create deletions: '+operation);
  }};
  localStorage.setItem(fullDeleteStorageKey(store.principal.userId),JSON.stringify(rows));
  window.removals=datasetRemoveUI(store,document.querySelector('#storage-pane'),()=>{},{management:true,catalog:()=>catalog,reload:()=>reloads++});
  window.scope=new AbortController();window.mounted=removals.mountFullDeleteTasks(document.querySelector('#delete-task-host'),{signal:scope.signal,active:()=>document.body.dataset.room==='admin'});
 },MACHINES);
 const row=name=>page.locator('[data-delete-task]').filter({has:page.locator('strong code',{hasText:name})});
 const writes=()=>page.evaluate(()=>calls.filter(call=>call.operation!=='datasets.delete.status'));
 assert.equal(await page.locator('[data-delete-task]').count(),3);assert.equal(await page.locator('[data-delete-task-action]').count(),0,'saved records never prove permission/completion');assert.equal(await page.evaluate(()=>calls.length),0,'mount does not dispatch or query automatically');
 await page.locator('[data-delete-tasks-refresh]').click();await row('waiting').locator('[data-delete-task-action=continue]').waitFor();
 assert.deepEqual(await writes(),[]);assert.equal(await row('unknown').locator('[data-delete-task-action]').count(),0);assert.equal(await row('deleted').locator('[data-delete-task-action=restore]').count(),1);
 const original=await page.evaluate(()=>[...tasks.values()].map(task=>({dataset:task.dataset,key:task.key,operationId:task.operationId})));
 assert.deepEqual(await page.evaluate(()=>calls.map(call=>call.args)),original.map(task=>({key:task.key})));
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});
  const geometry=await inspectGeometry(page,{roots:['#delete-task-host'],controls:'button',containment:'button,strong,.st'});assert.deepEqual(geometry.failures,[],JSON.stringify({width,...geometry}));
  if(width<760)for(const button of await page.locator('#delete-task-host button:visible').all())assert.ok((await button.boundingBox()).height>=44);
  await page.screenshot({path:join(shots,'tasks-'+width+'.png'),fullPage:true,animations:'disabled'});
 }
 await row('waiting').locator('[data-delete-task-action=continue]').click();assert.equal((await writes()).length,0,'action first shows confirmation');assert.match(await page.locator('.dataset-full-delete-dialog[open]').innerText(),/沿用原编号/);
 await page.locator('.dataset-full-delete-dialog[open] [type=submit]').click();await row('waiting').locator('[data-delete-task-action=cancel]').waitFor();
 assert.deepEqual((await writes()).at(-1),{operation:'datasets.delete.continue',args:{operationId:original[0].operationId}});
 await page.locator('.dataset-full-delete-dialog[open] [data-full-delete-close]').click();
 await row('waiting').locator('[data-delete-task-action=cancel]').click();assert.equal((await writes()).length,1);await page.locator('.dataset-full-delete-dialog[open] [type=submit]').click();await row('waiting').locator('.st').filter({hasText:'已取消删除'}).waitFor();
 assert.deepEqual((await writes()).at(-1),{operation:'datasets.delete.cancel',args:{operationId:original[0].operationId}});await page.locator('.dataset-full-delete-dialog[open] [data-full-delete-close]').click();
 await row('deleted').locator('[data-delete-task-action=restore]').click();assert.equal((await writes()).length,2);assert.equal(await page.locator('[name=full-delete-restore-machine]').inputValue(),MACHINES[0].id);await page.locator('.dataset-full-delete-dialog[open] [type=submit]').click();
 await page.locator('.full-delete-steps').filter({hasText:'已恢复'}).waitFor();assert.deepEqual((await writes()).at(-1),{operation:'datasets.delete.restore',args:{operationId:original[1].operationId,machine:MACHINES[0].id}});assert.equal(await row('deleted').locator('[data-delete-task-action=continue]').count(),0);
 await page.locator('.dataset-full-delete-dialog[open] [data-full-delete-close]').click();
 await page.evaluate(()=>{catalog.datasetDelete=0;mounted.render();});assert.equal(await page.locator('[data-delete-task-action]').count(),0,'capability zero has no write actions');
  await page.evaluate(()=>{catalog.datasetDelete=1;tasks.values().next().value.state='RUNNING';});await row('waiting').locator('[data-delete-task-query]').click();await row('waiting').locator('[data-delete-task-action=cancel]').waitFor();
 await page.evaluate(()=>{document.body.dataset.room='work';});const away=await page.evaluate(()=>calls.length);await page.clock.runFor(6000);assert.equal(await page.evaluate(()=>calls.length),away,'leaving the room stops status polling even before unmount');assert.equal(await page.locator('[data-delete-task]').count(),0);
 await page.evaluate(()=>{document.body.dataset.room='admin';});await row('waiting').locator('[data-delete-task-action=cancel]').waitFor();
 await row('waiting').locator('[data-delete-task-action=cancel]').click();await page.evaluate(()=>{window.retiredForm=document.querySelector('.dataset-full-delete-dialog[open] form');scope.abort();});
 assert.equal(await page.locator('.dataset-full-delete-dialog[open]').count(),0);assert.equal(await page.locator('[data-delete-task]').count(),0);const before=await page.evaluate(()=>calls.length);
 await page.evaluate(()=>retiredForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await page.clock.runFor(6000);assert.equal(await page.evaluate(()=>calls.length),before,'retired scope sends no action or polling query');
 await page.evaluate(()=>{scope=new AbortController();mounted=removals.mountFullDeleteTasks(document.querySelector('#delete-task-host'),{signal:scope.signal});store.principal={userId:'other-admin',role:'admin'};store.authGeneration++;authListeners.forEach(listener=>listener());});
 assert.equal(await page.locator('[data-delete-task]').count(),0,'auth switch removes previous admin records');assert.equal(await page.evaluate(()=>removals.fullDelete.records.length),0);
 await page.evaluate(()=>{mounted.destroy();store.principal={userId:'task-admin',role:'member'};store.authGeneration++;authListeners.forEach(listener=>listener());mounted=removals.mountFullDeleteTasks(document.querySelector('#delete-task-host'));});
 assert.equal(await page.locator('[data-delete-task]').count(),0,'member has no administrative task list');await page.evaluate(()=>mounted.destroy());
 await page.evaluate(()=>{store.principal={userId:'task-admin',role:'admin'};store.authGeneration++;authListeners.forEach(listener=>listener());const main=removals.fullDelete;window.mainHost=document.createElement('div');document.querySelector('main').append(mainHost);document.body.dataset.room='datasets';main.mountTasks(mainHost);});
 assert.equal(await page.locator('[data-delete-task]').count(),0,'primary room cannot mount administrator actions');assert.equal((await writes()).length,3);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
 console.log('DELETE TASKS PASS: authoritative original-key queries, confirmed continue/cancel/restore dialogs, UNKNOWN/cap0, account/member/room/abort boundaries, no new deletion, 1440/390/320.');
}finally{for(const context of browser.contexts())await context.unrouteAll({behavior:'ignoreErrors'});await browser.close();}
