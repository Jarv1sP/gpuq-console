// Invoked by the existing datasets smoke CI entry. Disposable Portal/accounts;
// node observations and archive records are explicit local contract fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {datasetHelpGeometry,checkDatasetHelpRegressions,checkDatasetBodyHelpRegressions} from './dataset-help-geometry.mjs';
const {inspectGeometry,scanGeometry,layoutZooms}=await import(process.env.DATA_FLOW_GEOMETRY_MODULE||'./layout-geometry.mjs');
const dir=await mkdtemp(join(tmpdir(),'dataset-flow-')),out=process.env.UI_SCREENSHOTS||join(dir,'shots');
const password='Local-Database-Cache-Fixture-Only-2026!',hash='a'.repeat(64),second='b'.repeat(64);
const [target,source,third,database]=MACHINES.map(row=>row.id);
const calls=[],errors=[],geometries=[],pins=new Set(['pre-existing']);let mode='normal',gate,releaseGate,pinReply='normal',databasePhase=null,server,service,browser;
const fixtureOwners=['builtin-admin'];
const ref={machine:target,dataset:'local-samples',version:hash};
const states={scans:['PREPARING','READY',null,null],'sample-pictures':['REGISTERED','FAILED','READY',null],'tiny-local':['READY',null,null,null],validation:[null,null,'READY',null]};
// A modal makes the background inert. Scan the dialog's active controls while
// open; scan the complete room again after closing it for every catalog state.
const geometry={...datasetHelpGeometry,roots:['#page-datasets:not(:has(#dataset-add-dialog[open]))','#dataset-add-dialog[open]','#page-admin:not([hidden])'],
  controls:'button,input:not([type=file]):not([type=checkbox]),select,summary,a[href]',
  numericCells:['.v3-size,.v3-versions','.admin-data-storage .dataset-volume'],largeTargets:'.v3-row,.v3-upload-choices>.button',
  scrollPanels:['.v3-detail-scroll','#dataset-add-dialog[open]'],containment:'input,select,button,h3,.server-id',
  bottomReserve:[{content:'#main-content',controls:'#room-nav,#mobile-control,#control-strip'}]};
async function closeRoutedContext(context){await context.unrouteAll({behavior:'wait'});await context.close();}
try{
  await mkdir(out,{recursive:true});const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port,bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  ({server,service}=await createPortalServer({database:join(dir,'portal.sqlite'),bootstrap,origin,secure:false,bridge:async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});const index=MACHINES.findIndex(row=>row.id===machine);assert.ok(index>=0);
    if(operation==='projects.list')return {projects:[]};
    if(operation==='datasets.upload.routes')return {available:false,protocol:'dataset-upload-v1',reason:'not-configured',relayLimitBytes:256*1024**2};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3};
    if(operation==='datasets.list'){
      if(gate&&machine===target)await gate;
      if(mode==='empty')return {datasets:[]};
      if(mode==='unknown'&&machine!==target)throw Error('Local fixture catalog unavailable');
      return {datasets:Object.entries(states).flatMap(([dataset,values])=>{
        const state=mode==='unknown'?(machine===target?'UNKNOWN':null):values[index];if(!state)return [];
        return [{dataset:dataset==='tiny-local'?'local-samples':dataset,ownerIds:fixtureOwners,versions:[{version:dataset==='validation'?second:hash,state,canPrepare:state!=='UNKNOWN'&&state!=='PREPARING',bytes:dataset==='tiny-local'?2048:7*1024**3,files:dataset==='tiny-local'?1:120,...(state==='FAILED'?{error:'本地模拟缓存取回失败，可重试。'}:{})}]}];
      })};
    }
    if(operation==='datasets.storage.status'){
      assert.equal(args.hostAdmin,true);
      if(pinReply==='status-lost'&&args.pinId)throw Error('本地模拟确认暂不可用');
      return {enabled:index!==2,highWater:.83,lowWater:.61,budgetBytes:1000*1024**3,capacity:{usedBytes:1},...(args.dataset?{version:{dataset:args.dataset,version:args.version,state:'READY',role:'cache',pinCount:pins.size,leaseCount:0,recoveryVerified:true,manualPinProtocol:1,...(args.pinId?{manualPin:{pinId:args.pinId,owner:args.userId,present:pins.has(args.pinId)}}:{})}}:{})};
    }
    if(operation==='datasets.storage.plan'){
      assert.equal(args.hostAdmin,true);return {enabled:index!==2,dryRun:true,usageBytes:(index===1?900:620)*1024**3,budgetBytes:1000*1024**3,highWater:.83,lowWater:.61,reservedBytes:0,candidates:index===1?[{dataset:'sample-pictures',version:hash,bytes:7*1024**3,lastUsedAt:1700000000}]:[],protectedUnknown:index===1?[{dataset:'unknown',version:hash}]:[],unavailableAuthorities:[]};
    }
    if(operation==='datasets.storage.pin'){assert.equal(args.hostAdmin,true);pins.add(args.pinId);if(pinReply==='lost'){pinReply='status-lost';throw Error('本地模拟回执丢失');}return {pinned:true,pinId:args.pinId};}
    if(operation==='datasets.storage.unpin'){assert.equal(args.hostAdmin,true);return {unpinned:pins.delete(args.pinId)};}
    if(operation==='datasets.prepare')return {dataset:args.dataset,version:args.version,state:'PREPARING',operationId:'c'.repeat(64)};
    if(operation==='datasets.status')return {dataset:args.dataset,version:args.version,state:'PREPARING'};
    throw Error('Unexpected local fixture operation '+operation);
  }}));clearInterval(service.executionTimer);
  service.datasetAliases=(_owner,machine)=>new Map(machine===target?[['local-samples@'+hash,'tiny-local']]:[]);
  // Explicit local replica capability lets the real catalog supply a source;
  // a database destination alone must never manufacture that route.
  const originalTransferCall=service.transferCall.bind(service);service.transferCall=(principal,operation,args)=>operation==='transfers.capabilities'?Promise.resolve({enabled:true,sources:[source],targets:[target]}):originalTransferCall(principal,operation,args);
  service.archiveState=(_owner,machine,value)=>value.dataset==='local-samples'?null:{...value,phase:mode==='unknown'?'BLOCKED':value.dataset==='validation'?(databasePhase||'COPYING'):'ARCHIVED',archiveMachine:database,localMachine:machine,originalRetained:mode!=='unknown'&&value.dataset!=='validation'};
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'data-flow-member',password})).result;await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  fixtureOwners.push(member.id);
  const zero=(await service.invoke(admin.token,'users.create',{username:'zero-cache-grants',password})).result;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function login(page,username){await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('#room-nav [data-nav=datasets]').click();await page.locator('#page-datasets').waitFor({state:'visible'});await page.evaluate(()=>document.fonts.ready);}
  async function pageFor(role,zoom=1){const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:zoom,permissions:['clipboard-read','clipboard-write']});await context.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());assert.equal(url.origin,origin);if(url.pathname==='/api/call'&&mode==='error'&&route.request().postDataJSON()?.operation==='datasets.catalog')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'本地模拟目录查询失败'})});return route.continue();}));const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/#datasets');await login(page,role==='admin'?'admin':role==='zero'?zero.username:member.username);return page;}
  async function load(page){if(!await page.locator('#datasets-refresh').isVisible()&&await page.locator('[data-v3-back]').isVisible())await page.locator('[data-v3-back]').click();await page.locator('#datasets-refresh').click();await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);}
  async function detail(page,dataset){const row=page.locator('[data-v3-select="'+dataset+'"]');if(!await row.isVisible()&&await page.locator('[data-v3-back]').isVisible())await page.locator('[data-v3-back]').click();await row.click();await page.locator('#warehouse-inspector .v3-train').waitFor();}
  async function sourceSheet(page,source){if(!await page.locator('#dataset-add-dialog').isVisible())await page.locator('[data-v3-upload]').first().click();if(source==='directory'){const tab=page.locator('[data-dataset-source=directory]');if(await tab.isVisible())await tab.click();}else {const tab=page.locator('[data-dataset-source="'+source+'"]');if(await tab.isVisible())await tab.click();else await page.locator('[data-v3-source="'+source+'"]').click();}}
  async function storage(page){await page.evaluate(()=>{location.hash='admin/storage';});await page.locator('#page-admin .admin-data-storage').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-storage-refresh]').disabled);}

  async function check(page,label,width){await page.setViewportSize({width,height:width<760?900:1000});await page.evaluate(async()=>{for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(resolve=>requestAnimationFrame(resolve));});const result=await inspectGeometry(page,geometry);geometries.push({label,...result});await writeFile(join(out,'key-geometry.json'),JSON.stringify(geometries,null,2));assert.ok(result.pass,JSON.stringify({label,failures:result.failures}));}
  async function capture(page,name){await page.mouse.move(0,100);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:join(out,name+'-viewport.png'),animations:'disabled'});await page.screenshot({path:join(out,name+'.png'),fullPage:true,animations:'disabled'});}
  async function captureComponent(page,selector,name){
    const viewport=page.viewportSize(),element=page.locator(selector),height=Math.ceil(await element.evaluate(node=>node.getBoundingClientRect().height));
    // Capture the native viewport rather than an element crop: Chromium can
    // place sticky controls over the crop when it moves the capture viewport.
    // A taller viewport and real scrolling leave space above and below the card.
    try{
      await page.setViewportSize({width:viewport.width,height:Math.max(viewport.height,height+448)});
      await element.evaluate(node=>scrollTo(0,Math.max(0,node.getBoundingClientRect().top+scrollY-224)));
      await page.mouse.move(0,0);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
      const bounds=await element.boundingBox();assert.ok(bounds&&bounds.y>=0&&bounds.y+bounds.height<=page.viewportSize().height,'complete component remains in the native screenshot viewport');
      await page.screenshot({path:join(out,name+'.png'),animations:'disabled'});
    }
    finally{await page.setViewportSize(viewport);}
  }
  const memberPage=await pageFor('member');await load(memberPage);
  await checkDatasetBodyHelpRegressions(memberPage);
  const memberCalls=calls.slice();assert.ok(memberCalls.every(row=>!row.operation.startsWith('datasets.storage.')));assert.equal(await memberPage.locator('.dataset-cache-admin').count(),0);
  assert.equal(await memberPage.locator('[data-v3-select]').count(),4,'every logical dataset remains one row across all physical copies');
  assert.equal(await memberPage.locator('.dataset-matrix,.datasets-ledger-strip,#datasets-quota:visible').count(),0,'warehouse replaces matrix and GPU quota');
  assert.equal(await memberPage.locator('.v3-server-chip:not(.v3-all)').count(),MACHINES.length);
  await detail(memberPage,'sample-pictures');assert.equal(await memberPage.locator('.v3-store>span:last-of-type').textContent(),'已存入仓库');
  assert.equal(await memberPage.locator('.v3-store>code').getAttribute('title'),database);
  assert.equal(await memberPage.locator('.v3-server-text>b[title="'+source+'"]+span').textContent(),'取回失败');
  await detail(memberPage,'validation');assert.equal(await memberPage.locator('.v3-store>span:last-of-type').textContent(),'正在存入仓库');
  assert.equal(await memberPage.locator('.v3-strata.storing').evaluateAll(nodes=>nodes.reduce((count,node)=>count+node.getAnimations().length,0)),0,'unverified copying has no fabricated animation or progress in either the list or detail');
  await detail(memberPage,'tiny-local');assert.equal(await memberPage.locator('.v3-store>span:last-of-type').textContent(),'未存入仓库');
  assert.doesNotMatch(await memberPage.locator('#warehouse-inspector').innerText(),/已释放|\d+%|SSD|HDD|NVMe|归档|GC/);
  const readyIcon=memberPage.locator('.v3-server.cur .v3-g.ready');assert.equal(await readyIcon.evaluate(node=>node.getBoundingClientRect().width),10,'v3 uses the compact ready glyph from the approved warehouse design');assert.notEqual(await readyIcon.evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.equal(await memberPage.locator('.v3-store .v3-strata>i').count(),3,'warehouse uses the three-level icon without claiming another physical cache');
  assert.equal(await memberPage.locator('[data-dataset-more-slot],[data-remove-more],[data-cache-pin-slot]').count(),0,'privileged controls are absent from the member main view');
  const sourceHeader=memberPage.locator('[data-v3-filter="'+source+'"]'),beforeHover=calls.length;await sourceHeader.hover();assert.equal(calls.length,beforeHover,'filter inspection makes no node request');
  assert.equal(await sourceHeader.locator('.v3-server-name>span').textContent(),source);
  await memberPage.emulateMedia({reducedMotion:'reduce'});await sourceHeader.focus();assert.equal(await memberPage.locator('.v3-g').first().evaluate(node=>node.getAnimations().length),0);await memberPage.locator('#datasets-refresh').focus();await memberPage.emulateMedia({reducedMotion:'no-preference'});
  for(const [phase,label] of [['QUEUED','等待存入仓库'],['PROVISIONING','校验中'],['CERTIFYING','检查恢复能力'],['FAILED','存入失败'],['BLOCKED','待确认']]){
    databasePhase=phase;await load(memberPage);await detail(memberPage,'validation');assert.equal(await memberPage.locator('.v3-store>span:last-of-type').textContent(),label);assert.doesNotMatch(await memberPage.locator('#warehouse-inspector').innerText(),/\d+%|已存入仓库/);
    for(const width of [1440,1024,390,320]){await check(memberPage,'database-'+phase,width);if(width<760)await detail(memberPage,'validation');await captureComponent(memberPage,'.warehouse-v3','database-'+phase+'-'+width);}
  }
  databasePhase=null;await load(memberPage);await detail(memberPage,'scans');
  assert.equal(await memberPage.locator('.v3-server.cur .v3-server-text>span').textContent(),'取回中');assert.equal(await memberPage.locator('.v3-server.cur [data-v3-cache]').count(),0,'active retrieval is not resubmitted');
  assert.equal(await memberPage.locator('.v3-server-text>b[title="'+source+'"]+span').textContent(),'已缓存');
  assert.equal(await memberPage.locator('.v3-server.cur .v3-g.fetch').evaluate(node=>node.getAnimations().length),0,'retrieval remains static without real progress');
  assert.doesNotMatch(await memberPage.locator('#warehouse-inspector').innerText(),/\d+%/);
  for(const width of [1440,1024,390,320]){await memberPage.setViewportSize({width,height:1000});await detail(memberPage,'scans');await check(memberPage,'preparing-details',width);await captureComponent(memberPage,'.warehouse-v3','member-preparing-details-'+width);}
  await detail(memberPage,'tiny-local');await memberPage.locator('[data-v3-copy="'+hash+'"]').click();assert.equal(await memberPage.evaluate(()=>navigator.clipboard.readText()),hash,'copy always includes the full immutable version');
  assert.deepEqual(await memberPage.locator('.v3-train .v3-code code').allTextContents(),['--data tiny-local@'+hash,'/data2/tiny-local']);assert.equal(await memberPage.locator('.v3-train .v3-lock').textContent(),'只读');
  await memberPage.setViewportSize({width:1440,height:1000});
  for(const source of ['directory','link','workspace']){
    await sourceSheet(memberPage,source);
    for(const width of [1440,1024,390,320]){await check(memberPage,'sheet-'+source,width);await capture(memberPage,'sheet-'+source+'-'+width);}
  }
  assert.equal(await memberPage.locator('.dataset-sheet-head .data-workspace-footnote').textContent(),'上传前请确认磁盘容量；停止上传会保留已收到的文件片段。');
  assert.equal(await memberPage.locator('.data-workspace-card>.ui-info,.data-workspace-card>.data-workspace-footnote,.dataset-upload-notes').count(),0);
  await checkDatasetHelpRegressions(memberPage);
  const helpButton=memberPage.locator('[data-dataset-help-source=workspace] [data-copy-help]'),helpCalls=calls.length;
  await helpButton.click();assert.equal(await memberPage.locator('#'+await helpButton.getAttribute('aria-controls')).isVisible(),true);
  assert.equal(calls.length,helpCalls,'opening the preserved explanation sends no node request');
  await memberPage.keyboard.press('Escape');assert.equal(await memberPage.locator('#dataset-add-dialog').getAttribute('open'),'');
  await helpButton.click();
  for(const width of [1440,1024,390,320])await check(memberPage,'bounded-tooltip',width);
  await memberPage.keyboard.press('Escape');assert.equal(await memberPage.locator('.copy-help-popup:popover-open').count(),0);assert.equal(await memberPage.locator('#dataset-add-dialog').getAttribute('open'),'');await memberPage.keyboard.press('Escape');
  await memberPage.locator('#dataset-add-dialog').waitFor({state:'hidden'});
  assert.equal(await memberPage.locator('.datasets-ledger-strip').count(),0,'no GPU or database statistics ledger returns after closing upload');
  const adminPage=await pageFor('admin');await load(adminPage);await checkDatasetBodyHelpRegressions(adminPage);assert.equal(await adminPage.locator('.dataset-cache-admin,[data-cache-retention],[data-remove-more]').count(),0,'administrators see the same personal main view');await storage(adminPage);await adminPage.locator('#dataset-cache-admin>summary').click();await adminPage.waitForFunction(()=>document.querySelector('.dataset-cache-gauges')?.children.length===4);assert.equal(await adminPage.locator('[data-budget-state=high]').count(),1);assert.equal(await adminPage.locator('[data-budget-state=disabled]').count(),1);assert.match(await adminPage.locator('.dataset-cache-previews').innerText(),/超过高水位时将释放（预览，不会立即删除）/);assert.equal(await adminPage.locator('.dataset-cache-previews button').count(),0);
  const adminLocal=adminPage.locator('.admin-storage-row').filter({has:adminPage.locator('[data-cache-pin-slot][data-dataset="local-samples"]')});await adminLocal.locator('.dataset-version-details>summary').click();await adminLocal.locator('[data-cache-retention=pin]').waitFor({state:'visible'});await adminPage.waitForFunction(()=>!document.querySelector('[data-cache-pin-slot][data-dataset="local-samples"] [data-cache-retention=pin]').disabled);assert.equal(await adminLocal.locator('[data-cache-retention=unpin]').count(),0,'foreign pin count provides no generic unpin');
  for(const width of [1440,1024,390,320]){await check(adminPage,'retention-details',width);await captureComponent(adminPage,'.admin-storage-row:has([data-cache-pin-slot][data-dataset="local-samples"])','admin-retention-'+width);}
  pinReply='lost';await adminLocal.locator('[data-cache-retention=pin]').click();await adminLocal.locator('[data-cache-retention=retry]').waitFor();await adminLocal.locator('.form-error').waitFor();assert.match(await adminLocal.locator('.dataset-pin-status').innerText(),/结果未确认/);assert.equal(await adminLocal.locator('[data-cache-retention=retry]').isDisabled(),true);
  await adminPage.reload();await storage(adminPage);await adminLocal.locator('.dataset-version-details>summary').click();await adminLocal.locator('.form-error').waitFor();assert.equal(await adminLocal.locator('[data-cache-retention=pin]').count(),0);assert.equal(await adminLocal.locator('[data-cache-retention=retry]').isDisabled(),true);
  pinReply='normal';await adminLocal.getByRole('button',{name:'重新查询',exact:true}).click();await adminLocal.locator('[data-cache-retention=unpin]').waitFor();const writes=calls.filter(row=>row.operation==='datasets.storage.pin');assert.equal(writes.length,1,'reload and query never recreate a pin');assert.match(writes[0].args.pinId,/^manual-/);assert.equal(writes[0].args.dataset,'local-samples');assert.equal(writes[0].args.version,hash);assert.equal(writes[0].machine,target);
  await adminPage.locator('#dataset-cache-admin>summary').click();await adminPage.waitForFunction(()=>document.querySelector('.dataset-cache-gauges')?.children.length===4);
  const beforeExplicit=calls.filter(row=>row.operation.startsWith('datasets.storage.')).length;
  await adminPage.locator('[data-cache-refresh]').click();await adminPage.waitForFunction(()=>!document.querySelector('[data-cache-refresh]').disabled);assert.equal(calls.filter(row=>row.operation.startsWith('datasets.storage.')).length,beforeExplicit+8,'only explicit policy refresh repeats four node status/plan pairs');
  await adminPage.locator('#dataset-cache-admin>summary').click();await adminPage.locator('#dataset-cache-admin>summary').click();
  const beforeRefresh=calls.filter(row=>row.operation.startsWith('datasets.storage.')).length;
  await adminPage.locator('#refresh-state').click();await adminPage.waitForFunction(()=>!document.querySelector('#refresh-state').disabled);assert.equal(calls.filter(row=>row.operation.startsWith('datasets.storage.')).length,beforeRefresh,'app render cannot poll storage');
  await adminPage.locator('#room-nav [data-nav=work]').click();await adminPage.clock.install();await adminPage.clock.runFor(31000);assert.equal(calls.filter(row=>row.operation.startsWith('datasets.storage.')).length,beforeRefresh,'hidden dataset details cannot cause storage RPC');await adminPage.clock.resume();await storage(adminPage);await adminLocal.locator('.dataset-version-details>summary').click();await adminLocal.locator('[data-cache-retention=unpin]').waitFor();
  pins.delete(writes[0].args.pinId);await adminLocal.locator('[data-cache-retention=query]').click();await adminLocal.locator('[data-cache-retention=retry]').waitFor();assert.equal(calls.filter(row=>row.operation==='datasets.storage.pin').length,1,'absent proof never automatically recreates a pin');
  adminPage.once('dialog',dialog=>dialog.accept());await adminLocal.locator('[data-cache-retention=retry]').click();await adminLocal.locator('[data-cache-retention=unpin]').waitFor();const restoredWrites=calls.filter(row=>row.operation==='datasets.storage.pin');assert.equal(restoredWrites.length,2);assert.deepEqual(restoredWrites[0],restoredWrites[1],'explicit restore preserves the original ID and reference');
  adminPage.once('dialog',dialog=>dialog.accept());await adminLocal.locator('[data-cache-retention=unpin]').click();await adminLocal.locator('[data-cache-retention=pin]').waitFor();assert.deepEqual([...pins],['pre-existing']);await adminLocal.locator('.dataset-version-details>summary').click();
  await adminPage.locator('#room-nav [data-nav=datasets]').click();await load(adminPage);
  for(const source of ['directory','link','workspace']){
    await sourceSheet(adminPage,source);
    for(const width of [1440,1024,390,320]){await check(adminPage,'admin-sheet-'+source,width);await capture(adminPage,'admin-sheet-'+source+'-'+width);}
  }
  await adminPage.locator('[data-dataset-add-close]').click();await adminPage.locator('#dataset-add-dialog').waitFor({state:'hidden'});
  const actors=[{role:'member',views:[{zoom:1,page:memberPage}]},{role:'admin',views:[{zoom:1,page:adminPage}]}];
  for(const {role,views} of actors){
    const page=views[0].page,viewport=page.viewportSize(),scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
    try{
      for(const width of [1440,768,390,320]){
        await page.setViewportSize({width,height:width<760?900:1000});
        const footer=page.locator('.help-links');
        assert.equal(await footer.isVisible(),width>=760,'the first-use footer remains hidden on phones');
        if(width>=760){
          assert.equal(await footer.locator(':scope>span:not(.copy-help)').textContent(),'首次使用');
          assert.equal(await footer.locator('[data-copy-help]').count(),1);
          assert.equal(await footer.locator('.copy-help-popup>span').textContent(),'从第一次登录，到一次完整训练。');
          assert.equal(await footer.locator('.copy-help-guide').getAttribute('href'),'/guide/start');
          await footer.scrollIntoViewIfNeeded();
        }else await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
        const result=await inspectGeometry(page,{...datasetHelpGeometry,roots:width>=760?['.help-links']:['#page-datasets'],controls:'a[href],button,summary'});
        geometries.push({label:role+'-footer-help',...result});assert.ok(result.pass,JSON.stringify(result.failures));
        await page.screenshot({path:join(out,role+'-footer-help-'+width+'-viewport.png'),animations:'disabled'});
      }
    }finally{await page.setViewportSize(viewport);await page.evaluate(({x,y})=>scrollTo(x,y),scroll);}
  }
  // Native Portal state coverage remains here. The new warehouse fixture
  // performs all twenty prior role/state/source profiles at three browser
  // scales and 177 width/height pairs: exactly 10,620, without matrix injection.
  for(const {role,views} of actors)for(const state of ['normal','empty','loading','error','unknown','maintenance']){
    mode=state==='maintenance'?'normal':state;
    if(state==='maintenance')await service.invoke(admin.token,'maintenance.set',{scope:target,enabled:true,revision:service.operationalMaintenance(admin.principal).revision,reason:'本地模拟维护'});
    if(state==='loading')gate=new Promise(resolve=>releaseGate=resolve);
    for(const {page} of views){
      if(state==='loading'){await page.locator('#datasets-refresh').click();await page.waitForFunction(()=>document.querySelector('#datasets-status').textContent.includes('加载中'));}else await load(page);
      await page.locator('#refresh-state').click();await page.waitForFunction(()=>!document.querySelector('#refresh-state').disabled);
      for(const width of [1440,1024,390,320]){await check(page,role+'-'+state,width);await capture(page,role+'-'+state+'-'+width);}
      if(state==='unknown'){assert.equal(await page.locator('[data-v3-cache]:enabled,[data-use-dataset]:enabled').count(),0,'unknown observations grant no action');assert.match(await page.locator('#dataset-catalog').innerText(),/待确认/);}
      if(state==='error')assert.equal(await page.locator('[data-v3-select]').count(),0,'failed refresh clears stale catalog actions');
    }
    if(state==='loading'){releaseGate();gate=null;for(const {page} of views)await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);}
    if(state==='maintenance')await service.invoke(admin.token,'maintenance.set',{scope:target,enabled:false,revision:service.operationalMaintenance(admin.principal).revision});
  }
  mode='normal';await adminPage.locator('#refresh-state').click();await adminPage.waitForFunction(()=>!document.querySelector('#refresh-state').disabled);await storage(adminPage);await adminLocal.locator('.dataset-version-details>summary').click();await adminPage.waitForFunction(()=>document.querySelector('[data-cache-pin-slot][data-dataset="local-samples"] [data-cache-retention=pin]')?.disabled===false);await adminLocal.locator('[data-cache-retention=pin]').click();await adminLocal.locator('[data-cache-retention=unpin]').waitFor();
  await adminPage.evaluate(()=>document.querySelector('#switch-account').click());await adminPage.locator('#login-dialog').waitFor({state:'visible'});assert.equal(await adminPage.locator('[data-cache-pin-slot],.dataset-cache-admin').count(),0);
  await login(adminPage,member.username);await load(adminPage);assert.equal(await adminPage.locator('.dataset-cache-admin,[data-cache-retention]').count(),0,'the next account inherits no retention controls');
  await adminPage.evaluate(()=>document.querySelector('#switch-account').click());await adminPage.locator('#login-dialog').waitFor({state:'visible'});await login(adminPage,'admin');await storage(adminPage);await adminLocal.locator('.dataset-version-details>summary').click();await adminLocal.locator('[data-cache-retention=unpin]').waitFor();assert.equal(pins.size,2);assert.ok(pins.has('pre-existing'));assert.ok(calls.some(row=>row.operation==='datasets.storage.status'&&row.args.pinId===calls.filter(row=>row.operation==='datasets.storage.pin').at(-1).args.pinId),'same account restores only after exact server proof');
  const zeroPage=await pageFor('zero');assert.equal(await zeroPage.locator('.dataset-cache-admin,[data-cache-retention],[data-dataset-more-slot]').count(),0);assert.equal(await zeroPage.locator('#datasets-refresh').isEnabled(),true);
  const zeroCalls=calls.length;await load(zeroPage);
  assert.equal(await zeroPage.locator('[data-v3-select]').count(),4,'Zero quota can browse the complete metadata library');
  assert.equal(await zeroPage.locator('.v3-server-chip:not(.v3-all)').count(),MACHINES.length);
  assert.equal(await zeroPage.locator('[name=dataset-machine]').inputValue(),'');
  assert.equal(await zeroPage.locator('[name=dataset-machine]').isDisabled(),true);
  assert.equal(await zeroPage.locator('#datasets-capacity').isVisible(),false);
  assert.equal(await zeroPage.locator('#datasets-add>summary').getAttribute('aria-disabled'),'true');
  assert.equal(await zeroPage.locator('#datasets-add>summary').evaluate(node=>getComputedStyle(node).opacity),'0.5');
  assert.equal(await zeroPage.locator('[data-v3-upload]').first().isDisabled(),true);await zeroPage.locator('[data-v3-upload]').first().evaluate(button=>{button.disabled=false;button.click();button.disabled=true;});assert.equal(await zeroPage.locator('#dataset-add-dialog').isVisible(),false);
  assert.equal(await zeroPage.locator('[data-use-dataset]:enabled,[data-v3-cache]:enabled,.v3-edit:enabled,[data-retry-archive],[data-remove-more],[data-remove-confirm]').count(),0);await detail(zeroPage,'tiny-local');assert.equal(await zeroPage.locator('[data-use-dataset]').isDisabled(),true);const deniedClicks=calls.length;await zeroPage.locator('[data-use-dataset]').evaluate(button=>{button.disabled=false;button.click();button.disabled=true;});assert.equal(calls.length,deniedClicks,'DOM tampering cannot bypass zero execution authority');assert.equal(await zeroPage.locator('#work-submit').isVisible(),false);
  assert.ok(calls.slice(zeroCalls).every(row=>row.operation==='datasets.list'),'Browsing zero-quota metadata makes no capacity, storage, preparation or execution RPC');
  for(const width of [1440,1024,390,320]){await check(zeroPage,'zero-quota-library',width);await capture(zeroPage,'zero-quota-library-'+width);}
  const zeroAuth=await service.login(zero.username,password),beforeDenied=calls.length;
  for(const operation of ['status','plan','pin','unpin'])await assert.rejects(service.invoke(zeroAuth.token,'datasets.storage.'+operation,operation==='plan'?{machine:target}:{...ref,...(['pin','unpin'].includes(operation)?{pinId:'manual-local-denied-fixture'}:{})}),error=>error.status===403);
  assert.equal(calls.length,beforeDenied,'zero-authority member is rejected before any node operation');
  assert.ok(calls.filter(row=>row.operation.startsWith('datasets.storage.')).every(row=>row.args.userId===admin.principal.userId),'members never issue storage admin operations');
  assert.deepEqual(errors,[]);await writeFile(join(out,'contract.json'),JSON.stringify({status:'PASS',inventory:MACHINES.map(row=>row.id),memberStorageCalls:0,pinCalls:calls.filter(row=>row.operation==='datasets.storage.pin').length,physicalCache:'local-samples',reloadReadOnlyRecovery:true,retainedForeignPins:1,identityBoundPinRecovery:true,noBackgroundStorageRPC:true,zeroAuthorityDenied:4,errors,stateScreenshots:48,sheetScreenshots:24,geometry:geometries.length,fullScan:process.env.DATA_FLOW_FULL_SCAN==='1'},null,2));
  console.log('WAREHOUSE/STORAGE UI PASS: true original and cache observations, static unverified retrieval, exact full versions, moved admin policy and pin recovery, zero authority and all six Portal states × two roles × three widths.');
}catch(error){console.error('FIXTURE DEBUG',JSON.stringify({errors,calls:calls.filter(row=>row.operation.startsWith('datasets.storage.')).slice(-12),pages:browser?await Promise.all(browser.contexts().flatMap(c=>c.pages()).map(p=>p.locator('[data-cache-pin-slot]').allTextContents())):[]}));throw error;}finally{releaseGate?.();if(browser)await Promise.all(browser.contexts().map(closeRoutedContext));await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(dir,{recursive:true,force:true});}

// Retain the full layout gate under the existing CI entry.
await import('./dataset-warehouse-ui-smoke.mjs');
await import('./admin-data-storage-ui-smoke.mjs');
