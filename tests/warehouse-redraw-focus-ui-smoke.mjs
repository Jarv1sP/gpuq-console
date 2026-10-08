// Actual v4 warehouse and directory modules; all replies are local fixtures.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
const origin='https://warehouse-focus.fixture.test',assets=new URL('../dist/',import.meta.url),versions=['a'.repeat(64),'b'.repeat(64)];
const shots=join(process.env.UI_SCREENSHOTS||'/tmp/warehouse-focus','warehouse-focus');await mkdir(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{for(const role of ['member','admin'])for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',guardedRoute(async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin,'No external requests');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+['styles','fonts','starbase','shell','datasets','dataset-flow','dataset-warehouse'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')+'<body class="sb" data-room="datasets"><main id="main-content"><div class="page-heading"><h1 id="page-title">数据集 · 模拟数据</h1><div class="heading-actions"></div></div><section id="page-datasets"></section></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});assert(!url.pathname.includes('..'));
  await route.fulfill({body:await readFile(new URL('.'+url.pathname,assets)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 }));
 await page.goto(origin);await page.evaluate(async({role,machines,versions})=>{
  const {warehouseWorkspaceHTML,datasetWarehouseView}=await import('/dataset-warehouse-view.js'),section=document.querySelector('#page-datasets');
  section.innerHTML=warehouseWorkspaceHTML();for(const row of machines)section.querySelector('[name=dataset-machine]').add(new Option(row.id,row.id));
  window.calls=[];window.callbacks=new Set();
  const item=(dataset,machine)=>({dataset,versions:(dataset==='sample'?versions:versions.slice(0,1)).map(version=>({version,canUse:true,ownerLabel:'所属用户：alice',contentBytes:4096,fileCount:2,originals:[{machine,warehouseReady:true,state:'READY'}],caches:machines.map((row,index)=>({machine:row.id,dataset,state:index<2?'READY':'NOT_LOCAL',canUse:true,canPrepare:true}))}))});
  window.snapshot={protocol:'dataset-storage-overview-v1',filePreviewAvailable:true,warehouse:{state:'READY',volumes:[machines[0],machines.at(-1)].map(row=>({machine:row.id,volume:{id:'volume-'+row.id,state:'READY',totalBytes:1000000,usedBytes:100000,availableBytes:900000}}))},caches:machines.map(row=>({machine:row.id,state:'READY',volume:{id:'cache-'+row.id,state:'READY',totalBytes:1000000,usedBytes:100000,availableBytes:900000}})),datasets:[item('sample',machines[0].id),item('other',machines.at(-1).id)]};
  window.store={production:true,principal:{userId:'alice',username:'alice',role},authGeneration:0,data:{machines},onAuthChange:fn=>{callbacks.add(fn);return()=>callbacks.delete(fn);},async call(operation,args){
   calls.push({operation,args:structuredClone(args),actor:store.principal.userId});
   if(!['sample','other'].includes(args.dataset)||!versions.includes(args.version))throw Error('Unexpected dataset/version');
   if(operation==='datasets.cache.capabilities'){if(!machines.some(row=>row.id===args.machine))throw Error('Unexpected machine');return {protocol:0,prepare:false,release:false};}
   if(operation==='datasets.files.list')return {protocol:'dataset-files-list-v1',available:true,...args,path:args.path||'',entries:args.path?[{name:'labels.json',path:args.path+'/labels.json',type:'file',bytes:42}]:[{name:'train',path:'train',type:'directory',bytes:null}],nextCursor:null};
   throw Error('Unexpected operation '+operation);
  }};
  window.view=datasetWarehouseView(store,section,()=>{},{refresh:()=>view.storageOverview(snapshot),removeUI:{canOpenFullDelete:()=>false},machineAllowed:()=>true,authorizedMachines:()=>machines,access:(value)=>({selectable:value.state==='READY'&&value.canUse===true,prepare:value.canUse===true&&value.canPrepare===true,canRetry:false})});
  view.storageOverview(snapshot);
 },{role,machines:MACHINES,versions});
 assert.equal(await page.locator('.v4-warehouse-card').count(),2);assert.equal(await page.locator('.v4-training-card').count(),MACHINES.length);
 await page.locator('[data-v4-warehouse="'+MACHINES[0].id+'"]').click();assert.deepEqual(await page.locator('[data-v3-select]').evaluateAll(nodes=>nodes.map(node=>node.dataset.v3Select)),['sample']);
 await page.locator('[data-v4-clear=all]').click();await page.locator('[data-v3-filter="'+MACHINES[0].id+'"]').click();assert.equal(await page.locator('[data-v3-select]').count(),2);await page.locator('[data-v4-clear=all]').click();
 await page.locator('[data-v3-select=sample]').click();await page.locator('[data-files-toggle=train]').waitFor();
 assert.equal(await page.locator('.v4-step').count(),3);assert.equal(await page.locator('[data-v3-cache]').count(),2);assert.equal(await page.locator('[data-v3-cache-action]').count(),0,'Protocol 0 retains existing cache controls');
 const train=page.locator('[data-use-dataset]');await train.focus();await page.evaluate(()=>window.trainingNode=document.querySelector('[data-use-dataset]'));
 await page.evaluate(()=>view.uploadControls({busy:true}));assert.equal(await train.isDisabled(),true);assert.equal(await page.evaluate(()=>trainingNode===document.querySelector('[data-use-dataset]')),true,'A fixed-version redraw preserves the actual button while synchronizing disabled state');
 await page.evaluate(()=>view.uploadControls({busy:false}));assert.equal(await train.isEnabled(),true);assert.equal(await page.evaluate(()=>trainingNode===document.querySelector('[data-use-dataset]')),true);
 await train.focus();await page.evaluate(()=>view.storageOverview(snapshot));assert.equal(await train.evaluate(node=>document.activeElement===node),true,'Refresh restores the actual focused training button');
 await page.locator('[data-files-toggle=train]').click();await page.getByText('labels.json',{exact:true}).waitFor();await page.locator('[data-files-toggle=train]').focus();
 const reads=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.files.list').length);await page.evaluate(()=>window.folderNode=document.querySelector('[data-files-toggle=train]'));
 await page.evaluate(()=>{const updated=structuredClone(snapshot);updated.datasets[0].versions[0].caches[1].state='FAILED';view.storageOverview(updated);});
 assert.equal(await page.evaluate(()=>folderNode===document.querySelector('[data-files-toggle=train]')&&document.activeElement===folderNode),true,'A changed cache reply preserves the opened directory DOM and keyboard focus');assert.equal(await page.getByText('labels.json',{exact:true}).count(),1);assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.files.list').length),reads,'Refresh does not reread the retained fixed-version tree');
 await page.locator('[data-v3-version]').selectOption(versions[1]);await page.locator('[data-files-toggle=train]').waitFor();assert.equal(await page.evaluate(()=>trainingNode.isConnected),false,'A new version receives a new action node');assert.equal(await train.getAttribute('data-version'),versions[1]);
 await train.focus();await page.evaluate(()=>view.storageOverview(snapshot));assert.equal(await train.getAttribute('data-version'),versions[1],'Refresh never jumps back to the first version');assert.equal(await page.locator('[data-v3-select][aria-selected=true]').getAttribute('data-v3-select'),'sample');assert.equal(await train.evaluate(node=>document.activeElement===node),true);
 await page.evaluate(()=>{window.versionNode=document.querySelector('[data-use-dataset]');window.treeNode=document.querySelector('#warehouse-files-preview');});
 if(width<760)await page.locator('[data-v3-back]').click();await page.locator('[data-v3-select=other]').click();await page.locator('[data-files-toggle=train]').waitFor();assert.equal(await train.getAttribute('data-use-dataset'),'other');assert.equal(await page.evaluate(()=>versionNode.isConnected||treeNode.isConnected),false,'Dataset changes retire previous actions and preview');
 if(width<760)await page.locator('[data-v3-back]').click();await page.locator('[data-v3-select=other]').focus();await page.keyboard.press('ArrowUp');assert.equal(await page.locator('[data-v3-select][aria-selected=true]').getAttribute('data-v3-select'),'sample');assert.equal(await page.locator('[data-v3-select=sample]').evaluate(node=>document.activeElement===node),true);
 await page.locator('[data-v3-select=sample]').click();await page.locator('[data-files-toggle=train]').waitFor();await page.evaluate(()=>{window.accountNode=document.querySelector('[data-use-dataset]');window.accountCard=document.querySelector('[data-v4-warehouse]');store.principal={...store.principal,userId:'bob',username:'bob'};store.authGeneration++;view.render();});
 assert.equal(await page.evaluate(()=>accountNode.isConnected||accountCard.isConnected),false,'Even identical templates cannot reuse another account DOM');
 await page.evaluate(()=>document.fonts.ready);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,role+'-'+width+'.png'),fullPage:true});
 await page.evaluate(()=>{for(const callback of callbacks)callback();});assert.equal(await page.locator('[data-use-dataset],#warehouse-files-preview .files-preview').count(),0,'Identity reset retires actions and preview');
 assert.ok((await page.evaluate(()=>calls)).every(row=>['datasets.files.list','datasets.cache.capabilities'].includes(row.operation)),'All interactions remain readonly');assert.deepEqual(errors,[]);await page.close();
}console.log('WAREHOUSE REDRAW FOCUS PASS: v4 cards/filters/three steps/cache controls; fixed-version DOM, disabled state, preview/focus, selection, version/account fences; member/admin 1440/390; zero writes.');}finally{await browser.close();}
