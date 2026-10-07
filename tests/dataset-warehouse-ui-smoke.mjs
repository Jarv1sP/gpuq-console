// Actual v3 assets; all network replies are browser-local fixtures. No production login.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {inspectGeometry,scanGeometry,layoutZooms} from './layout-geometry.mjs';
import {datasetHelpGeometry} from './dataset-help-geometry.mjs';
const root=new URL('..',import.meta.url).pathname,output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-warehouse-ui','warehouse-v3');
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):(await import('../dist/machines.js')).MACHINES;
const origin='https://offline-pr-j.test',node='https://upload-fixture.test',checkedAt=new Date().toISOString(),revision='c'.repeat(64),certificate='d'.repeat(64),results=[],errors=[],calls=[],mainStructures=new Map();
const hddIngress=process.env.DATASET_HDD_INGRESS==='1',uploadMachine=hddIngress?machines[3].id:machines[0].id;
function catalog(machine,role){
 const names=['ImageNet 子集','校园场景分割','语音指令 v2','tiny-local','CT 影像 2025'],ids=['imagenet-sub','campus-seg','voice-cmd','tiny-local','med-ct-2025'];
 return {machine,partial:false,machines:machines.map(m=>({machine:m.id,state:'ok'})),datasets:ids.map((dataset,index)=>{
  const version=String(index+1).repeat(64),phase=['ARCHIVED','ARCHIVED','COPYING',null,'ARCHIVED'][index];
  const locations=machines.map((m,i)=>({machine:m.id,dataset,canUse:true,ownerLabel:'所属用户：fixture-user',state:index===0?(i===0||i===1?'READY':'NOT_LOCAL'):index===1?(i===0?'PREPARING':i===3?'READY':'NOT_LOCAL'):index===2?(i===2?'READY':'NOT_LOCAL'):index===3?(i===1?'READY':'NOT_LOCAL'):(i===1?'FAILED':'NOT_LOCAL'),canPrepare:true,...(i===0&&phase?{storage:{dataset,version,phase,archiveMachine:machines[3].id,originalRetained:phase==='ARCHIVED'}}:{})}));
  const local=locations.find(row=>row.machine===machine),v={version,state:local.state,canUse:true,bytes:[142,61,18,0,412][index]*1024**3+(index===3?2048:0),files:[1281167,48320,210553,1,96011][index],ownerLabel:local.ownerLabel,canPrepare:local.state!=='UNKNOWN',sourceMachine:locations.find(row=>row.state==='READY')?.machine||null,locations};
  return {dataset,name:names[index],displayNameRevision:3,labelScope:'personal',versions:index===0?[v,{...v,version:'a'.repeat(64),bytes:120*1024**3,locations:locations.map(row=>({...row,storage:row.storage?{...row.storage,version:'a'.repeat(64)}:undefined}))}]:[v]};
 })};
}
const fullScan=process.env.DATA_FLOW_FULL_SCAN==='1',scans=[];
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try{
 await mkdir(output,{recursive:true});
 for(const role of ['member','admin'])for(const width of [1440,1024,390,320])for(const zoom of fullScan&&width===1440?layoutZooms:[1]){
  const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:zoom,reducedMotion:'reduce'}),page=await context.newPage();
  const principal={userId:'demo-user-1',username:'fixture-'+role,role},me={id:principal.userId,username:principal.username,name:role==='admin'?'管理员':'本地验收成员',role,enabled:true,total:8,limits:Object.fromEntries(machines.map(m=>[m.id,m.cards])),policyVersion:1};
  let scene='normal',pendingReads=[];
  const state={machines,executionEnabled:true,users:[me],jobs:[],gpuq:{checkedAt,stale:false,hosts:[]},transfers:{version:1}};
  page.on('pageerror',error=>{errors.push({role,width,message:error.message});console.error('PAGEERROR',error.stack);});
  const json=(route,result)=>route.fulfill({contentType:'application/json',body:JSON.stringify({principal,state,result})});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());assert([origin,node].includes(url.origin),'no external request '+url.origin);
   if(url.origin===node){assert.equal(url.pathname,'/capabilities');assert.equal(route.request().method(),'GET');assert(!route.request().headers().authorization);return route.fulfill({contentType:'application/json',body:JSON.stringify({protocol:'dataset-upload-v1',listenerReady:true,machine:uploadMachine,revision})});}
   if(url.pathname==='/api/call'){
    const {operation,args={}}=route.request().postDataJSON();calls.push({role,width,operation,args});
    if(operation==='state')return json(route,null);
    if(operation==='transfers.list'){
      assert.deepEqual(args,args.limit===undefined?{cursor:0}:{cursor:0,limit:50},'the empty fixture permits only the initial owner-scoped reads from transfers and control, not identity overrides or pagination');
      return json(route,{transfers:[],nextCursor:null});
    }
    if(operation==='projects.list')return json(route,{projects:[]});
    if(operation==='datasets.overview'){assert.deepEqual(args,{});return json(route,{protocol:0});}
    if(operation==='datasets.catalog'){
      if(scene==='loading'){await new Promise(resolve=>pendingReads.push(resolve));}
      if(scene==='error')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'目录查询暂时不可用',principal,state})});
      const value=catalog(args.machine,role);
      if(scene==='empty')value.datasets=[];
      if(scene==='unknown'){value.partial=true;value.machines.forEach(row=>row.state='unavailable');value.datasets.forEach(item=>item.versions.forEach(v=>{v.state='UNKNOWN';v.canPrepare=false;v.locations.forEach(row=>{row.state='UNKNOWN';row.canPrepare=false;if(row.storage)row.storage={...row.storage,phase:'BLOCKED',originalRetained:false};});}));}
      return json(route,value);
    }
    if(operation==='datasets.capacity'){const i=machines.findIndex(m=>m.id===args.machine),used=[.62,.9,.31,.62][i];return json(route,{machine:args.machine,available:true,filesystemBytes:1000*1024**3,availableBytes:Math.floor((1-used)*1000)*1024**3,usableBytes:(Math.floor((1-used)*1000)-20)*1024**3,reserveBytes:20*1024**3});}
    if(operation==='datasets.upload.routes')return json(route,{available:true,protocol:'dataset-upload-v1',machine:hddIngress?uploadMachine:args.machine,revision,certificateSha256:certificate,routes:[{id:'primary',kind:'campus-direct',endpoint:node}],...(hddIngress?{placementProtocol:1,requestedMachine:args.machine,storageMachine:uploadMachine,storageTier:'hdd',legacyPlacement:false}:{})});
    if(operation==='cloud.info')return json(route,{capabilityVerified:false,configurationEnabled:true,aliyunConnected:false,nodeDirect:false,managedExternally:true});
    if(operation==='datasets.storage.status')return json(route,{enabled:true,version:{dataset:args.dataset,version:args.version,state:'READY',pinCount:0,manualPinProtocol:1,manualPin:null}});
    if(operation==='datasets.storage.plan')return json(route,{enabled:true,usageBytes:30*1024**3,budgetBytes:300*1024**3,lowWater:.6,highWater:.8,candidates:[]});
    throw Error('unexpected API '+operation);
   }
   if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(machines)+';'});
   const file=url.pathname==='/'?'index.html':url.pathname.slice(1);assert(!file.includes('..'));let body=await readFile(join(root,'dist',file));
   if(file==='index.html')body=body.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;globalThis.GPUQ_HAS_SESSION=true;');
   const contentType=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.ico')?'image/x-icon':file.endsWith('.png')?'image/png':'text/html';
   return route.fulfill({contentType,body});
  });
  await page.goto(origin+'/#datasets');await page.waitForFunction(()=>document.querySelectorAll('[data-v3-select]').length===5&&!document.querySelector('#datasets-refresh').disabled);
  // Exact existing public catalog/capacity shapes, with overview unsupported.
  // The capacity design must be visible before any new node protocol exists.
  assert.equal(await page.locator('.capacity-warehouse .capacity-strata').count(),1);
  assert.equal(await page.locator('.v3-server-chip .capacity-cache-rail').count(),machines.length);
  assert.equal(await page.locator('#warehouse-machine-capacity .capacity-disk>span').count(),20);
  const legacyCatalog=catalog(machines[0].id,role),total=legacyCatalog.datasets.flatMap(row=>row.versions).reduce((n,v)=>n+v.bytes,0);
  const {transferBytes}=await import('../dist/data-route.js');
  assert.equal(await page.locator('.capacity-value-data b').textContent(),transferBytes(total));
  assert.equal(await page.locator('.capacity-head .num').textContent(),'未知','a cache filesystem cannot establish warehouse capacity');
  assert.equal(await page.locator('#warehouse-machine-capacity .capacity-metric').first().locator('.capacity-big small').textContent(),'/ 未知','a cache filesystem cannot establish a cache budget');
  assert((await page.locator('#warehouse-machine-capacity .capacity-disk').getAttribute('aria-label')).includes(transferBytes(620*1024**3)));
  assert.equal(await page.locator('[data-v3-cache-action]').count(),0,'display fallback cannot grant new cache actions');
  async function shot(stage){
   await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
   const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,dialogs:[...document.querySelectorAll('dialog[open]')].map(dialog=>({width:dialog.clientWidth,scroll:dialog.scrollWidth}))}));
   assert(geometry.scroll<=width+1,'document overflow '+JSON.stringify(geometry));for(const dialog of geometry.dialogs)assert(dialog.scroll<=dialog.width+1,'dialog overflow '+JSON.stringify(geometry));
   const hints=await inspectGeometry(page,{...datasetHelpGeometry,roots:[stage==='main'?'#page-datasets':'#dataset-add-dialog'],largeTargets:'.v3-row,.v3-upload-choices>.button'});assert(hints.pass,JSON.stringify(hints.failures));
   const file=role+'-'+stage+'-'+width+'.png';await page.screenshot({path:join(output,file),fullPage:stage==='main'});results.push({role,width,stage,file,geometry});
  }
  await shot('main');
  assert.equal(await page.locator('.dataset-matrix,.datasets-tabbar,.datasets-ledger-strip').count(),0,'one warehouse replaces the matrix and top ledgers');
  assert.equal(await page.locator('[data-v3-select=imagenet-sub]').count(),1,'two immutable versions remain one logical dataset row');
  assert.deepEqual(await page.locator('[data-v3-version] option').evaluateAll(nodes=>nodes.map(node=>node.value)),['1'.repeat(64),'a'.repeat(64)]);
  assert.equal(await page.locator('.v3-server-chip:not(.v3-all)').count(),machines.length);
  assert.equal(await page.locator('[data-v3-select=imagenet-sub] .v3-owner').textContent(),'fixture-user');
  assert.equal(await page.locator('.v3-meta>span').first().textContent(),'所属 fixture-user');
  assert.equal(await page.locator('#page-datasets .dataset-cache-admin,#page-datasets [data-cache-pin-slot],#page-datasets [data-remove-more],#page-datasets #cloud-admin,#page-datasets [data-v3-delete]').count(),0,'main view contains no privileged operations, and missing delete capability grants no entry');
  const structure=await page.locator('#page-datasets').evaluate(root=>[...root.querySelectorAll('*')].map(node=>[node.tagName,node.id.replace(/^copy-help-\d+$/,'copy-help-generated'),node.getAttribute('role'),node.getAttribute('name')]));
  if(role==='member')mainStructures.set(width,structure);else assert.deepEqual(structure,mainStructures.get(width),'admin and member dataset main views have the same component structure');
  if(width>=760){
   const training=page.locator('.v3-train'),before=await training.boundingBox();
   await page.locator('.v3-detail-scroll').evaluate(node=>node.scrollTop=node.scrollHeight);
   const after=await training.boundingBox();assert(Math.abs(before.y-after.y)<=1,'training footer does not move with the server/policy scroller');
   assert(await training.locator('[data-use-dataset]').isVisible());assert.equal(await training.locator('.v3-code').count(),2);
   const strip=await page.locator('#control-strip').boundingBox();assert(after.y+after.height<=strip.y-12,'training and both commands remain above the control strip '+JSON.stringify({role,width,after,strip,detail:await page.locator('#warehouse-inspector').evaluate(root=>({rect:root.getBoundingClientRect().toJSON(),max:getComputedStyle(root).maxHeight,sections:[...root.querySelectorAll('.v3-detail-scroll>section,.v3-server,.v3-train,.v3-code')].map(node=>({cls:node.className,rect:node.getBoundingClientRect().toJSON(),padding:getComputedStyle(node).padding}))}))}));
   const firstUse=await page.locator('.help-links').boundingBox();assert(firstUse.y>=after.y+after.height,'the first-use caption follows the naturally sized detail panel without overlapping it');
   await page.locator('.v3-detail-scroll').evaluate(node=>node.scrollTop=0);
   for(const node of await page.locator('.v3-server [data-v3-cache],.v3-server [data-remove-more]').all())assert.deepEqual(await node.evaluate(node=>({height:node.getBoundingClientRect().height,font:getComputedStyle(node).fontSize})),{height:32,font:'13px'});
   await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
   const footer=await page.locator('.help-links').boundingBox();assert(footer.y+footer.height<=strip.y-12,'first-use label and hint can scroll above the shared bottom layer');
   await page.evaluate(()=>scrollTo(0,0));
   for(const size of [{width:1440,height:900},{width:1024,height:768}]){
    await page.setViewportSize(size);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.locator('#warehouse-inspector').scrollIntoViewIfNeeded();
    const visibility=await page.locator('#warehouse-inspector').evaluate(root=>{const middle=root.querySelector('.v3-detail-scroll'),box=middle.getBoundingClientRect(),train=root.querySelector('.v3-train').getBoundingClientRect();return {overflow:root.classList.contains('v3-inspector-overflow'),scroll:middle.scrollHeight-middle.clientHeight,rows:[...root.querySelectorAll('.v3-server')].map(row=>{const r=row.getBoundingClientRect();return {top:r.top,bottom:r.bottom,complete:r.top>=box.top-1&&r.bottom<=box.bottom+1&&r.bottom<=train.top+1};})};});
    assert.equal(visibility.rows.length,4);
    assert(visibility.rows.every(row=>row.complete),'all four server rows are complete at '+JSON.stringify({role,size,visibility}));
    assert.equal(visibility.scroll,0,'four server rows do not need an internal scrollbar at '+JSON.stringify({role,size,visibility}));
   }
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>scrollTo(0,0));
  }else{
   // A real active task moves the shared control button into the mobile
   // strip. Dataset actions must remain visible even without a direct child button.
   state.jobs=[{id:'b'.repeat(64),userId:me.id,machine:machines[0].id,state:'RUNNING',cards:1,command:'python train.py',createdAt:checkedAt}];
   await page.locator('#refresh-state').click();await page.waitForFunction(()=>!document.querySelector('#refresh-state').disabled);
   assert.equal(await page.locator('#warehouse-page-actions [data-v3-upload]').isVisible(),true,'an active task cannot hide the dataset upload action on phones');
   assert.deepEqual(await page.locator('#warehouse-search').evaluate(node=>({height:node.getBoundingClientRect().height,font:getComputedStyle(node).fontSize})),{height:40,font:'14px'});
   const actions=await page.locator('#warehouse-page-actions>.button').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return r.y+r.height/2;}));assert(Math.max(...actions)-Math.min(...actions)<=1);
   if(width===390){const rail=await page.locator('.v3-rail').boundingBox(),chip=await page.locator('.v3-server-chip').nth(3).boundingBox();assert(chip.x<rail.x+rail.width&&chip.x+chip.width>rail.x+rail.width,'third server exposes the horizontal-scroll continuation');}
   assert.equal(await page.locator('.help-links').isVisible(),false);
   await page.addStyleTag({content:'.sb #page-datasets #warehouse-search{height:48px!important;min-height:48px!important}'}).then(async style=>{const result=await inspectGeometry(page,{...datasetHelpGeometry,roots:['#page-datasets']});assert(result.failures.some(row=>row.rule==='compact-search'),'the old 48px phone search fails the exact new contract');await style.evaluate(node=>node.remove());});
  }
  await page.locator('[data-v3-upload]').first().click();await page.locator('#dataset-add-dialog[open]').waitFor();await shot('upload-1');
  assert.equal(await page.locator('.v3-drop h3').textContent(),width<760?'选择文件':'拖入文件夹或文件');
  assert.equal(await page.locator('.v3-other-sources>.button').count(),3);
  assert.equal(await page.locator('.v3-other-sources>[data-v3-source=aliyun]').isHidden(),true,'Experimental cloud entry stays hidden in the public room');
  assert.deepEqual(await page.locator('.v3-other-sources>.button:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.v3Source)),['link','workspace']);
  for(const source of await page.locator('.v3-other-sources>.button:visible').all())assert(await source.evaluate(node=>getComputedStyle(node).borderTopStyle==='solid'&&node.getBoundingClientRect().height>=44));
  await page.locator('#v3-file-picker').setInputFiles([{name:'training-images.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(4*1024**2,1)},{name:'training-labels.json',mimeType:'application/json',buffer:Buffer.from('{"labels":[1,2,3]}')}]);
  await page.waitForFunction(()=>document.querySelector('#v3-upload-route')?.classList.contains('ok'));await shot('upload-2');
  if(hddIngress){
   const text=await page.locator('#dataset-add-dialog').textContent();
   assert(text.includes(uploadMachine),'the physical HDD destination is visible, not the selected training node');
   assert(text.includes('仓库'),'the upload capacity labels the actual warehouse destination');assert.doesNotMatch(text,/机械|固态|原件/);
  }
  await page.keyboard.press('Escape');await page.locator('#dataset-add-dialog').waitFor({state:'hidden'});
  assert(await page.locator('[data-v3-upload]').evaluate(node=>document.activeElement===node),'closing returns focus to upload');
  await page.locator('#warehouse-search').fill('campus-seg');assert.equal(await page.locator('[data-v3-select]').count(),1);
  await page.locator('#warehouse-search').fill('');
  const keyboardCalls=calls.length,firstRow=page.locator('[data-v3-select]').first(),secondRow=page.locator('[data-v3-select]').nth(1),secondId=await secondRow.getAttribute('data-v3-select');
  await firstRow.focus();await firstRow.press('ArrowDown');
  assert.equal(await page.locator('[data-v3-select][aria-selected=true]').getAttribute('data-v3-select'),secondId);
  const focus=await page.evaluate(()=>({tag:document.activeElement.tagName,id:document.activeElement.id,dataset:document.activeElement.dataset.v3Select||null}));
  assert.equal(focus.dataset,secondId,'keyboard selection retains focus on the real row '+JSON.stringify({role,width,zoom,focus}));
  await page.locator('#dataset-add-dialog').evaluate(dialog=>dialog.dispatchEvent(new Event('close')));
  assert.equal(await secondRow.evaluate(row=>document.activeElement===row),true,'a delayed drawer close event must not steal focus from a newer dataset selection');
  await secondRow.press('Home');assert.equal(await firstRow.getAttribute('aria-selected'),'true');
  assert.equal(calls.length,keyboardCalls,'arrow selection does not cache data or submit training');
  await page.locator('[data-v3-filter]').nth(1).click();assert.equal(await page.locator('[data-v3-select]').count(),2);
  await page.locator('[data-v3-filter=""]').click();assert.equal(await page.locator('[data-v3-select]').count(),5);
  if(width<760){await page.locator('[data-v3-select="campus-seg"]').click();assert(await page.locator('[data-v3-back]').isVisible());assert.equal(await page.locator('.v3-inspector h2>span').textContent(),'校园场景分割');await page.locator('[data-v3-back]').click();assert(await page.locator('.v3-list').isVisible());}
  if(fullScan&&width===1440){
   const spec={...datasetHelpGeometry,roots:['#page-datasets:not(:has(#dataset-add-dialog[open]))','#dataset-add-dialog[open]'],largeTargets:'.v3-row,.v3-upload-choices>.button',numericCells:['.v3-size,.v3-versions'],scrollPanels:['.v3-inspector-overflow .v3-detail-scroll','#dataset-add-dialog[open]'],bottomReserve:[{content:'#main-content',controls:'#room-nav,#mobile-control,#control-strip'}]};
   const scan=async label=>{const measured=await scanGeometry(page,spec,{zoom});scans.push({role,label,zoom,count:measured.length});await writeFile(join(output,'geometry-'+role+'-'+label+'-'+zoom+'.json'),JSON.stringify({role,label,zoom,results:measured},null,2));assert.equal(await page.evaluate(()=>devicePixelRatio),zoom);assert(measured.every(row=>row.pass),JSON.stringify({role,label,zoom,failures:measured.filter(row=>!row.pass).slice(0,2)}));console.log('GEOMETRY',role,label,zoom,measured.length,'PASS');};
   const reload=async()=>{await page.locator('#datasets-refresh').click();await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);};
   // The same twenty role/state profiles as the prior matrix suite, now
   // measured against the complete warehouse and its native source drawers.
   for(const mode of ['normal','empty','loading','error','unknown','maintenance']){
    scene=mode;state.operationalMaintenance=mode==='maintenance'?{version:1,revision:1,global:null,machines:{[machines[0].id]:{reason:'本地维护验收',since:checkedAt}}}:{version:1,revision:2,global:null,machines:{}};
    await page.setViewportSize({width:1440,height:1000});
    if(mode==='loading'){await page.locator('#datasets-refresh').click();await page.waitForFunction(()=>document.querySelector('#datasets-refresh').disabled);}else await reload();
    await scan(mode);
    if(mode==='loading'){scene='normal';pendingReads.splice(0).forEach(resolve=>resolve());await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);}
   }
   scene='normal';state.operationalMaintenance={version:1,revision:3,global:null,machines:{}};await reload();await page.setViewportSize({width:1440,height:1000});
   await page.setViewportSize({width:390,height:1000});await page.locator('[data-v3-select="imagenet-sub"]').click();assert(await page.locator('.v3-inspector').isVisible());await page.setViewportSize({width:1440,height:1000});await scan('details');
   await page.setViewportSize({width:1440,height:1000});await page.locator('[data-v3-upload]').first().click();
   for(const source of ['directory','link','workspace']){if(source!=='directory')await page.locator('[data-dataset-source="'+source+'"]').click();await page.locator('#dataset-add-dialog').evaluate(node=>node.scrollTop=0);await scan('sheet-'+source);}
   await page.keyboard.press('Escape');
  }
  await context.close();
 }
 const onlyReads=new Set(['state','transfers.list','projects.list','datasets.catalog','datasets.overview','datasets.capacity','datasets.upload.routes','cloud.info','datasets.storage.status','datasets.storage.plan']);assert(calls.every(row=>onlyReads.has(row.operation)),'no upload begin/ticket or other API writes');
 assert(!calls.some(row=>row.operation.startsWith('datasets.storage.')||row.operation.startsWith('cloud.auth.')),"visiting an admin's main view sends no privileged data/storage RPC");
 assert.deepEqual(errors,[]);if(fullScan)assert.equal(scans.reduce((sum,row)=>sum+row.count,0),10620,'Every original role/state/zoom/width/height profile is measured');await writeFile(join(output,'shots.json'),JSON.stringify({checkedAt,results,errors,calls,scans},null,2));console.log('PASS '+results.length+' native v3 screenshots: member/admin × main/upload-1/upload-2 ×1440/390/320; shared help geometry; no overflow/script errors; anonymous route probe, no upload begin/ticket/write; search, filters, phone detail/back and Esc focus.');
}finally{await browser.close();}
