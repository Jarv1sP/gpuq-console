// All overview replies are explicitly simulated. No production sessions or writes.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {inspectGeometry} from './layout-geometry.mjs';
import {MACHINES} from '../dist/machines.js';
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):MACHINES;
const output=process.env.UI_SCREENSHOTS||'/tmp/stargate-capacity-ui';await mkdir(output,{recursive:true});
const origin='https://simulated-capacity.test',root=new URL('../dist/',import.meta.url),version='a'.repeat(64),GiB=1024**3;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try{for(const role of ['member','admin'])for(const width of [1440,1024,390,320]){
 const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin);
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/datasets.css"><link rel="stylesheet" href="/dataset-flow.css"><link rel="stylesheet" href="/dataset-warehouse.css"><link rel="stylesheet" href="/admin-data-storage.css"><body class="sb" data-room="datasets" style="min-height:100vh;background:var(--bg)"><main id="main-content"><p>模拟数据 · 只读界面验证</p><div class="page-heading"><h1 id="page-title">数据集</h1><div class="heading-actions"></div></div><section id="page-datasets"></section><section class="admin-data-storage" id="admin-capacity-fixture"></section></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});assert(!url.pathname.includes('..'));
  return route.fulfill({body:await readFile(new URL('.'+url.pathname,root)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.goto(origin);await page.evaluate(async({role,machines,version,GiB})=>{
  const {warehouseWorkspaceHTML,datasetWarehouseView}=await import('/dataset-warehouse-view.js');
  const root=document.querySelector('#page-datasets');root.innerHTML=warehouseWorkspaceHTML();
  for(const machine of machines)root.querySelector('[name=dataset-machine]').add(new Option(machine.id,machine.id));
  window.calls=[];window.reply=null;window.waitReply=null;window.filesMode='ok';
  window.store={production:true,principal:{userId:'reader',username:'示例成员',role},authGeneration:0,data:{machines},onAuthChange(){},async call(operation,args){calls.push({operation,args});if(operation==='datasets.files.list'){
   if(!['sample-data','foreign-private'].includes(args.dataset)||args.version!==version||Object.keys(args).sort().join()!=='dataset,version')throw Error('Unexpected file scope');
   if(filesMode==='forbidden')throw Object.assign(Error('Forbidden'),{status:403});
   if(filesMode==='unavailable')return {available:false,reason:'DATASET_FILES_NODE_UNAVAILABLE'};
   return {protocol:'dataset-files-list-v1',available:true,...args,path:'',entries:[{name:'labels.json',path:'labels.json',type:'file',bytes:42}],nextCursor:null};
  }if(operation==='datasets.cache.capabilities'){if(!['sample-data','legacy-data'].includes(args.dataset)||args.version!==version||!machines.some(row=>row.id===args.machine)||Object.keys(args).sort().join()!=='dataset,machine,version')throw Error('Unexpected capability target');return {protocol:0,prepare:false,release:false};}assertOperation(operation);if(waitReply)return await waitReply;return reply;}};
  function assertOperation(operation){if(operation!=='datasets.overview')throw Error('Unexpected simulated read/write '+operation);}
  const first=machines[0].id,at='2026-10-08T01:23:00Z';
  const volume=(id,used,available,total=1000*GiB)=>({id,state:'READY',checkedAt:at,totalBytes:total,usedBytes:used*GiB,availableBytes:available*GiB,reserveBytes:50*GiB,usableBytes:(available-50)*GiB});
  const item=(dataset,ownerLabel,canUse)=>({dataset,displayName:dataset==='sample-data'?'校园场景数据':dataset,versions:[{version,ownerLabel,canUse,contentBytes:142*GiB,fileCount:48320,originals:[{machine:machines.at(-1).id,dataset,warehouseReady:true,state:'READY'}],caches:machines.map((row,index)=>({machine:row.id,dataset,state:index===0?'READY':'NOT_LOCAL',canUse,canPrepare:true}))}]});
  window.snapshot={protocol:'dataset-storage-overview-v1',checkedAt:at,partial:false,filePreviewAvailable:false,
   warehouse:{state:'READY',volumes:[{machine:machines.at(-1).id,volume:volume('warehouse-volume',700,300,1000*GiB),originalContentBytes:600*GiB,warnings:[]}]},
   caches:machines.map((row,index)=>({machine:row.id,state:'READY',volume:volume('cache-volume-'+index,700,300),readyContentBytes:[620,900,310,200][index]*GiB,budgetBytes:1000*GiB,readyVersionCount:3,usageComplete:true})),
   datasets:[item('sample-data','所属用户：示例成员',true),item('foreign-private','所属用户：其他成员',false)]};
  const legacy={machine:first,machines:machines.map(row=>({machine:row.id,state:'ok'})),datasets:[{dataset:'legacy-data',versions:[{version,bytes:142*GiB,files:48320,canUse:true,state:'READY',ownerLabel:'所属用户：示例成员',locations:[{machine:first,dataset:'legacy-data',state:'READY',canUse:true,warehouseReady:true}]}]}]};
  window.view=datasetWarehouseView(store,root,()=>{},{refresh(){},removeUI:{canOpenFullDelete:()=>false},machineAllowed:()=>true,authorizedMachines:()=>machines,access:v=>({selectable:v.canUse===true&&v.state==='READY',browseOnly:v.canUse!==true,canRetry:false})});
  view.catalog(legacy);view.capacity({machine:first,available:true,filesystemBytes:1000*GiB,availableBytes:300*GiB,reserveBytes:50*GiB,usableBytes:250*GiB},first);window.legacy=legacy;
 },{role,machines,version,GiB});
 assert.equal(await page.locator('.capacity-warehouse').count(),1,'Capacity components are visible using existing confirmed reads');
 assert.equal(await page.locator('.capacity-value-data b').textContent(),'142.00 GiB');
 assert.equal(await page.locator('.v4-free b').textContent(),'未知');
 assert.equal(await page.locator('.v4-training-card').count(),machines.length);assert.equal(await page.locator('#warehouse-machine-capacity,.v3-rail,.capacity-detail').count(),0);
 assert.equal(await page.locator('[data-v3-cache-action]').count(),0);
 await page.evaluate(async()=>{document.body.dataset.room='work';await view.loadOverview();document.body.dataset.room='datasets';});
 assert.deepEqual(await page.evaluate(()=>calls),[],'No overview read outside the dataset room');
 await page.evaluate(async()=>{reply={protocol:0};await view.loadOverview();});assert.equal(await page.locator('.capacity-warehouse').count(),1);assert.equal(await page.locator('[data-v3-select=legacy-data]').count(),1);
 await page.evaluate(async()=>{reply={...snapshot,partial:true,datasets:[],warehouse:{state:'UNKNOWN',volumes:[]}};await view.loadOverview();});
 assert.equal(await page.locator('[data-v3-select=legacy-data]').count(),1,'An empty incomplete overview cannot erase a confirmed existing catalog');
 assert.equal(await page.locator('.v3-partial').textContent(),'部分');
 await page.evaluate(async()=>{reply=snapshot;await view.loadOverview();});
 assert.equal(await page.locator('[data-v3-select]').count(),role==='admin'?2:1);assert.equal(await page.locator('#page-title .v3-count').textContent(),(role==='admin'?2:1)+' 个');
 const cardRules={roots:['.v4-warehouses','.v4-training']};
 assert((await inspectGeometry(page,cardRules)).pass,'large clickable cards pass the shared default geometry rules');
 if(width===1440){
  const card=await page.locator('.v4-warehouse-card').first().elementHandle(),original=await card.getAttribute('class'),style=await card.getAttribute('style');
  try{await card.evaluate(node=>{node.classList.remove('v4-warehouse-card');node.style.height='124px';});const ordinary=await inspectGeometry(page,cardRules);assert(ordinary.failures.some(row=>row.rule==='control-step'),'a plain 124px button remains rejected');}
  finally{await card.evaluate((node,{original,style})=>{node.className=original;if(style===null)node.removeAttribute('style');else node.setAttribute('style',style);},{original,style});await card.dispose();}
  assert((await inspectGeometry(page,cardRules)).pass,'the restored large card passes without flattening it');
 }
 // Contract pending backend finalization: a new upload warehouse can have
 // no registered versions yet. No capacity or migration success is implied.
 await page.evaluate(target=>{store.data.datasetUploadAdmission={protocol:1,available:true,targetMachine:target};view.render();},machines[0].id);
 const uploadTarget=page.locator('[data-v4-warehouse="'+machines[0].id+'"]');
 assert.equal(await page.locator('.v4-warehouse-card').count(),2);assert.equal(await uploadTarget.locator('.v4-dataset-count').textContent(),'0 个数据集');
 assert.equal(await uploadTarget.locator('.v4-upload-target[aria-label="上传目标"]').textContent(),'↑');assert.equal(await page.locator('.v4-upload-target').count(),1);
 assert.match(await uploadTarget.locator('.v4-free').textContent(),/未知/);assert.equal(await uploadTarget.locator('.capacity-data').count(),0);
 await uploadTarget.click();assert.equal(await page.locator('[data-v3-select]').count(),0,'upload placement never fabricates migrated versions');await uploadTarget.click();
 assert.equal(await page.locator('[data-v3-select]').count(),role==='admin'?2:1);assert((await inspectGeometry(page,cardRules)).pass);
 if([1440,390].includes(width))await page.screenshot({path:join(output,role+'-upload-target-'+width+'.png'),fullPage:true});
 await page.evaluate(()=>{store.data.datasetUploadAdmission.available=false;view.render();});assert.equal(await page.locator('.v4-warehouse-card').count(),1);assert.equal(await page.locator('.v4-upload-target').count(),0);
 await page.evaluate(()=>{store.data.datasetUploadAdmission={protocol:1,available:true};view.render();});assert.equal(await page.locator('.v4-warehouse-card').count(),1);
 await page.locator('[data-v4-warehouse="'+machines.at(-1).id+'"]').click();
 assert.equal(await page.locator('[data-v4-warehouse="'+machines.at(-1).id+'"] .v4-dataset-count').textContent(),(await page.locator('[data-v3-select]').count())+' 个数据集','overview warehouse card and its filtered rows agree even when the legacy catalog has no matching warehouse location');
 await page.locator('[data-v4-warehouse="'+machines.at(-1).id+'"]').click();
 await page.locator('[data-v3-filter="'+machines[0].id+'"]').click();
 const geometry=async()=>{
  await page.evaluate(()=>document.fonts.ready);
  const value=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,bar:document.querySelector('.capacity-strata').getBoundingClientRect().height,
   cache:document.querySelector('.v4-training-bar').getBoundingClientRect().height,cards:document.querySelectorAll('.v4-training-card').length}));
  assert(value.scroll<=width+1,JSON.stringify(value));assert.equal(value.bar,16);assert.equal(value.cache,8);assert.equal(value.cards,machines.length);
  const copy=await page.locator('#page-datasets').innerText();assert.doesNotMatch(copy,/原件|软件预算|所在磁盘|承载卷|只预警|检查于|最后成功/);
  assert.equal(await page.locator('.capacity-warehouse p,.capacity-detail p').count(),0,'No explanatory paragraphs');
 };
 await geometry();assert.equal(await page.locator('.capacity-proof.confirmed').count(),1);
 assert.equal(await page.locator('[data-v3-upload]').first().isEnabled(),true);
 await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(output,role+'-normal-'+width+'.png'),fullPage:true});
 for(const scene of ['unknown','warning','shared']){
  await page.evaluate(scene=>{
   const value=structuredClone(snapshot);
   if(scene==='unknown'){value.warehouse.volumes[0].volume.totalBytes=null;value.caches[0].readyContentBytes=null;value.caches[0].usageComplete=false;value.datasets[0].versions[0].originals[0].warehouseReady=false;}
   if(scene==='warning'){value.warehouse.warnings=[{code:'WAREHOUSE_FREE_SPACE_LOW'}];value.warehouse.volumes[0].volume.availableBytes=20*1024**3;value.warehouse.volumes[0].volume.usedBytes=980*1024**3;}
   if(scene==='shared'){value.caches.at(-1).volume=structuredClone(value.warehouse.volumes[0].volume);}
   view.storageOverview(value);
  },scene);
  if(scene==='shared')await page.locator('[data-v3-filter="'+machines.at(-1).id+'"]').click();
  await geometry();
  if(scene==='unknown'){assert.equal(await page.locator('.capacity-warehouse.unknown').count(),1);assert.equal(await page.locator('.capacity-proof.confirmed').count(),0);assert(await page.locator('.capacity-warehouse').getAttribute('title'));}
  if(scene==='warning'){assert.equal(await page.locator('.capacity-warning').textContent(),'仓库空间不足');assert.equal(await page.locator('[data-v3-upload]').first().isEnabled(),true,'Warning does not ban an upload');}
  if(scene==='shared')assert.equal(await page.locator('[data-v3-filter="'+machines.at(-1).id+'"] .capacity-shared').textContent(),'与仓库同盘');
  await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(output,role+'-'+scene+'-'+width+'.png'),fullPage:true});
 }
 await page.evaluate(()=>{const value=structuredClone(snapshot);Object.assign(value.caches[0],{projectBytes:100*1024**3,projectUsageComplete:false,projectCollectedAt:'2026-10-08T01:23:00Z'});value.caches[0].volume.collectedAt='2026-10-08T02:34:00Z';view.storageOverview(value);});
 const firstCard=page.locator('[data-v3-filter="'+machines[0].id+'"]');
 assert.equal(await firstCard.locator('.v4-project-value').textContent(),'100.00 GiB+');
 assert((await firstCard.locator('.v4-project-value').getAttribute('title')).includes('部分统计 · 采集于'));
 assert((await firstCard.getAttribute('title')).includes('采集于'));
 assert.equal(await page.locator('.v4-training-key').filter({hasText:'容器'}).count(),1,'the legend appears once, only when at least one numeric container quantity exists');
 assert.equal(await page.locator('.v4-training-card .v4-project-value').count(),1,'unknown project quantities on other nodes stay absent');
 const segments=await firstCard.locator('.v4-training-bar').evaluate(node=>({width:node.clientWidth,parts:[...node.querySelectorAll(':scope>i:not(.v4-budget)')].map(row=>row.getBoundingClientRect().width)}));
 assert(segments.parts.every(value=>value>=0)&&segments.parts.reduce((a,b)=>a+b,0)<=segments.width+1,'inconsistent logical amounts cannot overflow the real disk bar');
 await page.evaluate(()=>{const value=structuredClone(snapshot);value.caches[0].readyContentBytes=0;value.caches[0].usageComplete=false;view.storageOverview(value);});
 assert.equal(await firstCard.locator('.v4-data-value').textContent(),(role==='admin'?'284.00':'142.00')+' GiB+','an incomplete zero is supplemented only by this account\'s current readable READY catalog versions');
 assert(!await page.locator('.v4-training').textContent().then(text=>text.includes('容器')));
 await page.evaluate(()=>{const value=structuredClone(snapshot);Object.assign(value.caches[0].volume,{totalBytes:null,usedBytes:null,availableBytes:null,collectedAt:'2026-10-08T01:23:00Z'});view.storageOverview(value);});
 assert.equal(await firstCard.locator('.v3-server-name small b').textContent(),'未知','past collection time does not revive an old physical reading');
 assert.equal(await firstCard.locator('.v4-training-bar.unknown').count(),1);
 await page.evaluate(()=>view.storageOverview(snapshot));
 await page.locator('[data-v4-clear=all]').click();
 await page.evaluate(()=>{filesMode='ok';view.storageOverview({...snapshot,filePreviewAvailable:true});});
 if(width<760){assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.files.list').length),0,'a hidden phone detail must not read files');await page.locator('[data-v3-select=sample-data]').click();}
 await page.locator('#warehouse-files-preview .files-preview').waitFor();assert.equal(await page.locator('#warehouse-files-preview .files-preview-name').textContent(),'labels.json');
 const fileReads=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.files.list').length);
 await page.evaluate(()=>{view.render();view.render();});assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.files.list').length),fileReads,'capacity and capability rerenders preserve the live directory rather than duplicate reads');
 if(role==='admin'){
  if(width<760)await page.locator('[data-v3-back]').click();
  await page.evaluate(()=>window.filesMode='forbidden');await page.locator('[data-v3-select=foreign-private]').click();
  await page.waitForFunction(()=>!document.querySelector('#warehouse-files-preview .files-preview'));
  assert.equal(await page.locator('#warehouse-files-preview').textContent(),'','a globally available preview does not authorize this dataset');
  if(width<760)await page.locator('[data-v3-back]').click();
  await page.evaluate(()=>window.filesMode='ok');await page.locator('[data-v3-select=sample-data]').click();await page.locator('#warehouse-files-preview .files-preview').waitFor();
 }
 await page.evaluate(()=>{view.storageOverview({...snapshot,filePreviewAvailable:false});});assert.equal(await page.locator('#warehouse-files-preview .files-preview').count(),0);
 await page.evaluate(()=>{filesMode='unavailable';view.storageOverview({...snapshot,filePreviewAvailable:true});});
 await page.waitForFunction(()=>!document.querySelector('#warehouse-files-preview .files-preview'));
 assert.equal(await page.locator('#warehouse-files-preview').textContent(),'','node unavailable is not a fake empty file tree');
 await page.evaluate(()=>view.storageOverview(snapshot));
 if(width<760)await page.locator('[data-v3-back]').click();
 if(role==='admin'){
  await page.evaluate(async()=>{const {storageCapacityDetailHTML,applyCapacityGeometry}=await import('/dataset-flow.js');const {adaptStorageOverview}=await import('/dataset-catalog-model.js');
   const root=document.querySelector('#admin-capacity-fixture');root.innerHTML='<h2>模拟后台容量组件</h2><div class="storage-fleet">'+adaptStorageOverview(snapshot).caches.map(row=>'<article class="storage-server-card"><h3>'+row.machine+'</h3>'+storageCapacityDetailHTML(row)+'</article>').join('')+'</div>';applyCapacityGeometry(root);});
  assert.equal(await page.locator('#admin-capacity-fixture .capacity-disk').count(),machines.length);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(output,'admin-cards-'+width+'.png'),fullPage:true});
 }
 await page.evaluate(async()=>{waitReply=new Promise(resolve=>window.releaseOverview=resolve);window.pending=view.loadOverview();store.principal={userId:'new-reader',username:'新成员',role:'member'};store.authGeneration++;view.reset();releaseOverview(snapshot);await pending;});
 assert.equal(await page.locator('#warehouse-capacity').textContent(),'未知','A retired account reply cannot restore warehouse locations, capacity or datasets');assert.equal(await page.locator('[data-v4-warehouse]').count(),0);
 assert.deepEqual(await page.locator('.v4-data-value').allTextContents(),machines.map(()=>'未知'));assert.equal(await page.locator('.v4-project-value').count(),0);
 assert.equal(await page.locator('[data-v3-select]').count(),0);
 assert((await page.evaluate(()=>calls)).every(row=>row.operation==='datasets.overview'&&Object.keys(row.args).length===0||row.operation==='datasets.files.list'&&['sample-data','foreign-private'].includes(row.args.dataset)&&row.args.version===version&&Object.keys(row.args).sort().join()==='dataset,version'||row.operation==='datasets.cache.capabilities'&&['sample-data','legacy-data'].includes(row.args.dataset)&&row.args.version===version&&machines.some(machine=>machine.id===row.args.machine)&&Object.keys(row.args).sort().join()==='dataset,machine,version'));assert.deepEqual(errors,[]);await page.close();
}console.log('CAPACITY UI PASS: simulated member/admin 1440/1024/390/320; normal/unknown/warning/shared, no explanation copy, legacy fallback, account fence, readonly room gating.');}finally{await browser.close();}
