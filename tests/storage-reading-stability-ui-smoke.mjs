// Simulated protocol replies only: no production access or write operations.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):MACHINES;
const output=process.env.UI_SCREENSHOTS||'/tmp/stargate-storage-stability';await mkdir(output,{recursive:true});
const origin='https://simulated-storage.test',root=new URL('../dist/',import.meta.url),GiB=1024**3,at='2026-10-08T15:00:00Z';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try{for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin);
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/datasets.css"><link rel="stylesheet" href="/dataset-flow.css"><link rel="stylesheet" href="/dataset-warehouse.css"><link rel="stylesheet" href="/admin-storage-members.css"><body class="sb" data-room="datasets" style="min-height:100vh;background:var(--bg)"><main id="main-content"><p>模拟数据 · 只读验证</p><div class="page-heading"><h1 id="page-title">数据集</h1><div class="heading-actions"></div></div><section id="page-datasets"></section><section id="members-fixture"></section></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});assert(!url.pathname.includes('..'));
  await route.fulfill({body:await readFile(new URL('.'+url.pathname,root)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.clock.install({time:new Date(at)});await page.goto(origin);
 await page.evaluate(async({machines,GiB,at})=>{
  const {warehouseWorkspaceHTML,datasetWarehouseView}=await import('/dataset-warehouse-view.js');
  const section=document.querySelector('#page-datasets');section.innerHTML=warehouseWorkspaceHTML();for(const row of machines)section.querySelector('[name=dataset-machine]').add(new Option(row.id,row.id));
  const auth=[];window.store={production:true,principal:{userId:'reader',username:'示例成员',role:'member'},authGeneration:0,data:{machines},onAuthChange(fn){auth.push(fn);},async call(op,args){if(op==='datasets.cache.capabilities'&&args.dataset==='sample-data'&&args.version==='a'.repeat(64)&&machines.some(row=>row.id===args.machine))return {protocol:0,prepare:false,release:false};throw Error('Unexpected API '+op);}};
  window.changeAccount=()=>{store.principal={userId:'second-reader',username:'新成员',role:'member'};store.authGeneration++;auth.forEach(fn=>fn());};
  window.view=datasetWarehouseView(store,section,()=>{},{refresh(){},removeUI:{canOpenFullDelete:()=>false},machineAllowed:()=>true,authorizedMachines:()=>machines,access:()=>({selectable:false})});view.beginRead();view.render();
  const volume=id=>({id,state:'READY',collectedAt:at,checkedAt:at,totalBytes:1000*GiB,usedBytes:700*GiB,availableBytes:300*GiB,reserveBytes:50*GiB,usableBytes:250*GiB});
  window.snapshot={protocol:'dataset-storage-overview-v1',checkedAt:at,partial:false,datasets:[{dataset:'sample-data',displayName:'校园场景数据',versions:[{version:'a'.repeat(64),ownerLabel:'所属用户：示例成员',canUse:true,contentBytes:142*GiB,fileCount:48320,originals:[machines[0],machines.at(-1)].map(row=>({machine:row.id,dataset:'sample-data',warehouseReady:true,state:'READY'})),caches:machines.map(row=>({machine:row.id,dataset:'sample-data',state:'READY',canUse:true,canPrepare:false}))}]}],warehouse:{state:'READY',volumes:[machines[0],machines.at(-1)].map(row=>({machine:row.id,volume:volume('warehouse-'+row.id),originalContentBytes:142*GiB,datasetCount:1,warnings:[]}))},caches:machines.map(row=>({machine:row.id,state:'READY',volume:volume('cache-'+row.id),readyContentBytes:42*GiB,readyVersionCount:1,usageComplete:true,budgetBytes:500*GiB}))};
 },{machines,GiB,at});
 assert.equal(await page.locator('.v4-training-card .storage-reading-skeleton').count(),machines.length*2);assert.doesNotMatch(await page.locator('.v4-training').innerText(),/未知/);
 await page.evaluate(()=>view.storageOverview(snapshot));const ids=await page.locator('[data-v4-warehouse]').evaluateAll(rows=>rows.map(row=>row.dataset.v4Warehouse));assert.deepEqual(ids,[machines[0].id,machines.at(-1).id]);
 const titles=await page.locator('.v4-warehouse-card').evaluateAll(rows=>rows.map(row=>row.title));assert(titles.every(title=>title.includes('采集于')));assert.equal(await page.locator('[data-v3-select=sample-data]').count(),1);assert.equal(await page.locator('[data-v3-select=sample-data]').isEnabled(),true);
 await page.evaluate(()=>view.catalogUnavailable());
 assert.deepEqual(await page.locator('[data-v4-warehouse]').evaluateAll(rows=>rows.map(row=>row.dataset.v4Warehouse)),ids);assert.equal(await page.locator('.v4-warehouse-card.storage-reading-stale').count(),2);assert.equal(await page.locator('.v4-training-card.storage-reading-stale').count(),machines.length);
 assert.deepEqual(await page.locator('.v4-warehouse-card').evaluateAll(rows=>rows.map(row=>row.title)),titles);assert.deepEqual(await page.locator('.v4-free b').allTextContents(),['300.00 GiB','300.00 GiB']);
 assert.equal(await page.locator('[data-v3-select=sample-data]').count(),1);assert.equal(await page.locator('[data-v3-select=sample-data]').isDisabled(),true);assert.equal(await page.locator('#dataset-catalog.storage-reading-stale').count(),1);assert((await page.locator('#dataset-catalog').getAttribute('title')).includes('采集于'));assert.equal(await page.locator('[data-use-dataset]').count(),0,'last list cannot recreate old training actions');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(output,'storage-stale-'+width+'.png'),fullPage:true});
 await page.clock.fastForward(600001);assert.equal(await page.locator('[data-v3-select]').count(),0);assert.equal(await page.locator('#dataset-catalog').textContent(),'未知');assert.deepEqual(await page.locator('.v4-free b').allTextContents(),['未知','未知']);assert.equal(await page.locator('[data-v4-warehouse]').count(),2);assert.deepEqual(await page.locator('.v4-data-value').allTextContents(),machines.map(()=>'未知'));
 await page.evaluate(()=>{snapshot.checkedAt='2026-10-08T15:11:00Z';snapshot.warehouse.volumes.forEach(row=>row.volume.collectedAt='2026-10-08T15:11:00Z');snapshot.caches.forEach(row=>row.volume.collectedAt='2026-10-08T15:11:00Z');view.storageOverview(snapshot);});assert.equal(await page.locator('.v4-warehouse-card.storage-reading-stale').count(),0);assert.equal(await page.locator('[data-v3-select=sample-data]').isEnabled(),true,'a successful fresh read restores list selection');assert.deepEqual(await page.locator('.v4-free b').allTextContents(),['300.00 GiB','300.00 GiB']);
 await page.evaluate(({machine,GiB})=>{view.capacity({machine,available:false,storageOverview:{protocol:'dataset-storage-node-v1',warehouse:{state:'READY',volume:{filesystemBytes:2000*GiB,usedBytes:1500*GiB,availableBytes:500*GiB,reserveBytes:50*GiB,collectedAt:'2026-10-08T15:12:00Z'}}}},machine);view.capacity(null,machine);},{machine:machines[0].id,GiB});
 assert.equal(await page.locator('[data-v4-warehouse="'+machines[0].id+'"] .v4-free b').textContent(),'500.00 GiB','explicit warehouse measurement remains independent of an unavailable training-cache disk');assert.equal(await page.locator('[data-v4-warehouse="'+machines[0].id+'"].storage-reading-stale').count(),1);
 await page.evaluate(()=>changeAccount());assert.equal(await page.locator('[data-v4-warehouse]').count(),0);assert.equal(await page.locator('[data-v3-select]').count(),0);assert.equal(await page.locator('.v4-training-card .storage-reading-skeleton').count(),machines.length*2);
 // Privileged member totals retain display readings but never escape the admin mount.
 await page.evaluate(async({machines,at})=>{
  const {mountAdminStorageMembers}=await import('/admin-storage-members.js');const version='a'.repeat(64);
  window.memberCatalog={checkedAt:at,partial:false,datasets:[{dataset:'samples',versions:[{version,bytes:42,locations:[{machine:machines[0].id,dataset:'samples',state:'READY',bytes:42,warehouseReady:true,ownerLabel:'所属用户：alice'}]}]}]};
  window.usageReply={protocol:1,users:[{userId:'alice-id',machines:[{machine:machines[0].id,available:true,complete:true,collectedAt:at,projectBytes:20,projects:[]}]}]};
  const auth=[];window.adminStore={production:true,principal:{userId:'admin',role:'admin'},authGeneration:0,users:[{id:'alice-id',username:'alice'}],onAuthChange(fn){auth.push(fn);return ()=>{};},async call(op){if(op!=='storage.usage.users')throw Error('Unexpected API');if(!usageReply)throw Error('Unavailable');return usageReply;}};
  window.members=mountAdminStorageMembers(document.querySelector('#members-fixture'),{store:adminStore,catalog:()=>memberCatalog});await members.load();window.adminAccountChange=()=>{adminStore.principal={userId:'other-admin',role:'admin'};adminStore.authGeneration++;auth.forEach(fn=>fn());members.sync();};
 },{machines,at});
 assert.equal(await page.locator('[data-member-size=container]').textContent(),'20 B');await page.evaluate(async()=>{memberCatalog=null;usageReply=null;members.sync();await members.load();});
 assert.equal(await page.locator('[data-member-size=warehouse]').textContent(),'42 B');assert.equal(await page.locator('[data-member-size=cache]').textContent(),'42 B');assert.equal(await page.locator('[data-member-size=container]').textContent(),'20 B');assert.equal(await page.locator('[data-storage-member-row].storage-reading-stale').count(),1);
 await page.clock.fastForward(600001);assert.equal(await page.locator('[data-member-size=warehouse]').textContent(),'待确认');assert.equal(await page.locator('[data-member-size=container]').textContent(),'—');await page.evaluate(()=>adminAccountChange());assert.equal(await page.locator('#members-fixture').textContent(),'');
 assert.deepEqual(errors,[]);await page.close();
 }console.log('STORAGE STABILITY PASS: first skeleton, success/failure/recovery, unchanged timestamps, ten-minute expiry and account fences; storage and admin members, 1440/390.');
}finally{await browser.close();}
