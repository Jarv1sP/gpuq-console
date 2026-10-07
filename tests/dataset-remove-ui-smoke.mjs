// Real frontend, browser-local replies. No production or node cleanup.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';
import {inspectGeometry} from './layout-geometry.mjs';
import {datasetHelpGeometry} from './dataset-help-geometry.mjs';
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):MACHINES;
const origin='https://offline-remove.test',shots=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-remove-ui','dataset-remove');
const V1='a'.repeat(64),V2='b'.repeat(64),V3='c'.repeat(64),localDataset='local-scans',errors=[],external=[],checks=[];
const geometry=[],wordGeometry=[];
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
await mkdir(shots,{recursive:true});
try{
 for(const role of ['member','admin']){
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();await page.clock.install();
  let userId='local-'+role,principal={userId,username:userId,role},stateMode='UNREGISTERING',lostSubmit=false,lostStatus=false,serial=0;
  const calls=[],ops=new Map(),deleted=new Set();let navigation=0,archiveMode=false,uniqueVersion=false,pendingNode=false,pendingReceiptKnown=false,rejectSubmit=null,deleteCapability=0;
  const state=()=>({machines,executionEnabled:true,users:[{id:userId,username:userId,name:'本地删除验收',role:principal.role,enabled:true,total:8,limits:Object.fromEntries(machines.map(m=>[m.id,m.cards]))}],jobs:[],gpuq:{checkedAt:new Date().toISOString(),stale:false,hosts:[]}});
  const key=(machine,dataset,version)=>[machine,dataset,version].join(':');
  const catalog=machine=>({machine,datasetDelete:deleteCapability,checkedAt:new Date().toISOString(),machines:machines.map(m=>({machine:m.id,state:'ok'})),datasets:[
   {dataset:'scans',name:'scans',versions:[V1,V2].map(version=>{
    const locations=machines.filter((_,i)=>version===V1?i<2:uniqueVersion?i===0:i<2).filter(m=>!deleted.has(key(m.id,localDataset,version))).map(m=>({machine:m.id,dataset:localDataset,state:'READY',...(m.id===machines[0].id&&pendingNode?{removalPending:true,...(!pendingReceiptKnown?{removalGraceEligible:true}:{})}:{}),...(m.id===machines[0].id&&archiveMode?{storage:{phase:'ARCHIVED',originalRetained:true,archiveMachine:machines[1].id}}:{})}));
    const local=locations.some(row=>row.machine===machine);return {version,state:local?'READY':'NOT_LOCAL',bytes:7*1024**3,files:12,canUse:true,canPrepare:!local,sourceMachine:locations[0]?.machine,locations};
   }).filter(version=>version.locations.length)},
   {dataset:'other-data',name:'other-data',versions:[{version:V3,state:'READY',bytes:1024,files:1,canUse:true,canPrepare:false,locations:machines.map(m=>({machine:m.id,dataset:'other-data',state:'READY'}))}]}
  ].filter(dataset=>dataset.versions.length)});
  page.on('pageerror',error=>errors.push(error.message));
  const reply=(route,result)=>route.fulfill({contentType:'application/json',body:JSON.stringify({principal,state:state(),result})});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.href);return route.abort();}
   if(url.pathname==='/api/call'){
    const {operation,args={}}=route.request().postDataJSON();calls.push({operation,args:structuredClone(args),userId});
    if(operation==='state')return reply(route,null);
    if(operation==='projects.list')return reply(route,{projects:[]});
    if(operation==='datasets.overview'){assert.deepEqual(args,{});return reply(route,{protocol:0});}
    if(operation==='datasets.catalog')return reply(route,catalog(args.machine));
    if(operation==='datasets.list'){
     assert.equal(principal.role,'admin');assert.deepEqual(Object.keys(args).sort(),['includeEmpty','machine']);assert.equal(args.includeEmpty,true);
     const datasets=catalog(args.machine).datasets.map(item=>({dataset:item.dataset==='scans'?localDataset:item.dataset,ownerLabel:'所属用户：'+userId,versions:item.versions.filter(version=>version.locations.some(location=>location.machine===args.machine)).map(version=>({version:version.version,state:'READY',bytes:version.bytes,files:version.files,canPrepare:false}))})).filter(item=>item.versions.length);
     return reply(route,{datasets});
    }
    if(operation==='datasets.storage.status'){assert.equal(principal.role,'admin');assert.deepEqual(Object.keys(args),['machine']);return reply(route,{enabled:false});}
    if(operation==='datasets.storage.plan'){assert.equal(principal.role,'admin');assert.deepEqual(Object.keys(args),['machine']);return reply(route,{enabled:false,dryRun:true,candidates:[],usageBytes:0});}
    if(operation==='cloud.info'){assert.equal(principal.role,'admin');assert.deepEqual(args,{});return reply(route,{backend:'clouddrive',managedExternally:true,configurationEnabled:false,capabilityVerified:false,disabled:true,aliyunConnected:false});}
    if(operation==='datasets.capacity')return reply(route,{machine:args.machine,available:true,filesystemBytes:1024**4,availableBytes:512*1024**3,usableBytes:502*1024**3,reserveBytes:10*1024**3});
    if(operation==='datasets.unregister'){
     assert.equal(principal.role,'admin');assert.equal(args.dataset,localDataset);assert.deepEqual(Object.keys(args).sort(),args.version?['dataset','machine','version']:['dataset','machine']);
     if(rejectSubmit){const code=rejectSubmit;rejectSubmit=null;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code,error:code==='LAST_COPY_UNPROVEN'?'这可能是这个版本的最后一份完整数据。为避免永久丢失，暂不能按机器删除；节点更新后可用「彻底删除」（7 天内可恢复）。':'这台服务器上的删除结果待确认'})});}
     const operationId=(++serial).toString(16).padStart(64,'0');ops.set(operationId,{...args,operationId,userId,state:'UNREGISTERING'});
     if(lostSubmit){const failure=lostSubmit;lostSubmit=false;if(failure==='http400')return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'节点响应超时；任务状态将自动核对。'})});return route.abort('failed');}return reply(route,{operationId,state:'UNREGISTERING',dataset:args.dataset,version:args.version??null});
    }
    if(operation==='datasets.status'){
     assert.deepEqual(Object.keys(args).sort(),['machine','operationId']);const op=ops.get(args.operationId);assert(op);assert.equal(op.machine,args.machine);assert.equal(op.userId,userId);
     if(lostStatus){lostStatus=false;return route.abort('failed');}
     if(stateMode==='UNREGISTERED')for(const version of op.version?[op.version]:[V1,V2])deleted.add(key(op.machine,op.dataset,version));
     return reply(route,{operationId:args.operationId,dataset:op.dataset,version:op.version??null,state:stateMode,...(stateMode==='UNREGISTERED'?{unregistered:true}:{}),...(stateMode==='FAILED'?{error:'有训练正在使用'}:{})});
    }
    throw Error('Unexpected operation '+operation);
   }
   if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(machines)+';'});
   const file=url.pathname==='/'?'index.html':url.pathname.slice(1);assert(file==='index.html'||/^[a-z-]+\.(js|css)$/.test(file)||Object.hasOwn(STARBASE_ASSETS,url.pathname));
   let body=await readFile(new URL('../dist/'+file,import.meta.url));if(file==='index.html')body=body.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;globalThis.GPUQ_HAS_SESSION=true;');
   return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':'text/html',body});
  });
  const storageReady=()=>page.waitForFunction(()=>document.querySelector('[data-admin-storage] [data-storage-refresh]')?.disabled===false&&document.querySelector('[data-admin-storage] .admin-storage-row'));
  const enterStorage=async()=>{await page.evaluate(()=>{location.hash='#admin/storage';});await storageReady();};
  const load=async()=>{
   await page.goto(origin+'/?fixture-reload='+(++navigation)+(role==='admin'?'#admin/storage':'#datasets'));
   if(role==='admin')await storageReady();else{await page.locator('#datasets-refresh').click();await page.locator('[data-v3-select=scans]').waitFor();await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);}
  };
  const card=version=>page.locator('[data-admin-storage] .admin-storage-row').filter({has:page.locator('[data-dataset-more-slot][data-dataset="'+localDataset+'"][data-version="'+version+'"]')});
  async function assertRetainedCopies(version){
   await page.evaluate(()=>{location.hash='#datasets';});await page.waitForFunction(()=>document.body.dataset.room==='datasets');
   if(await page.locator('[data-v3-back]').isVisible())await page.locator('[data-v3-back]').click();
   await page.locator('#datasets-refresh').click();await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);await page.locator('[data-v3-select=scans]').click();
   const detail=page.locator('#warehouse-inspector');await detail.locator('[data-v3-version]').selectOption(version);
   const servers=detail.locator('.v3-server');assert.equal(await servers.count(),machines.length);
   assert.equal(await servers.filter({has:page.locator('b[title="'+machines[0].id+'"]')}).locator('.v3-g.none').count(),1);
   assert.equal(await servers.filter({has:page.locator('b[title="'+machines[0].id+'"]')}).locator('[data-v3-cache][data-version="'+version+'"]').count(),1);
   assert.equal(await servers.filter({has:page.locator('b[title="'+machines[1].id+'"]')}).locator('.v3-g.ready').count(),1);
   assert.deepEqual(await detail.locator('[data-v3-version] option').evaluateAll(options=>options.map(option=>option.value)),[V1,V2]);
   assert.equal(await detail.locator('[data-use-dataset=scans]').getAttribute('data-version'),version);
   if(await detail.locator('[data-v3-back]').isVisible())await detail.locator('[data-v3-back]').click();
   assert.equal(await page.locator('[data-v3-select=other-data]').count(),1);await page.locator('[data-v3-select=other-data]').click();
   assert.equal(await detail.locator('[data-use-dataset=other-data]').count(),1);assert.equal(await detail.locator('[data-use-dataset=other-data]').getAttribute('data-version'),V3);
   assert.equal(await page.locator('[data-remove-more],[data-remove-version],[data-remove-dataset],#dataset-removal-records').count(),0,'the main warehouse never mounts administrator deletion controls');
   await enterStorage();assert.equal(await card(version).count(),0,'a removed physical registration disappears only from the selected server');
  }
  async function assertRemovalWords(name,width){
   const words=await page.evaluate(()=>[...document.querySelectorAll('.dataset-remove-blocked')].filter(node=>node.getClientRects().length&&!node.closest('dialog:not([open])')).flatMap(node=>{
    const word='按机器删除',walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;
    while((text=walker.nextNode())){
     const offset=text.textContent.indexOf(word);if(offset<0)continue;
     const characters=[...word].map((_,index)=>{const range=document.createRange();range.setStart(text,offset+index);range.setEnd(text,offset+index+1);const rect=range.getBoundingClientRect();return {top:rect.top,left:rect.left,right:rect.right,width:rect.width,height:rect.height};});
     const rect=node.getBoundingClientRect();return [{word,characters,parent:{left:rect.left,right:rect.right}}];
    }
    return [];
   }));
   if(['last-copy-blocked','whole-last-copy-blocked','server-last_copy_unproven'].includes(name))assert.equal(words.length,1,JSON.stringify({name,width,words}));
   for(const value of words){
    assert.equal(value.characters.length,5);assert(value.characters.every(rect=>rect.width>0&&rect.height>0));
    const tops=value.characters.map(rect=>rect.top);assert(Math.max(...tops)-Math.min(...tops)<=1,JSON.stringify({rule:'removal-word-wrap',name,width,...value}));
    assert(value.characters.every(rect=>rect.left>=value.parent.left-1&&rect.right<=value.parent.right+1),JSON.stringify({rule:'removal-word-clipping',name,width,...value}));
   }
   wordGeometry.push({name,role,width,words});
  }
  const capture=async name=>{for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});if(name==='unknown-receipt'||name==='lost-submit'||name.startsWith('server-')&&!await page.locator('#dataset-remove-dialog[open]').count())await page.locator('#dataset-removal-records').scrollIntoViewIfNeeded();await page.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(requestAnimationFrame);});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const controls=await page.evaluate(()=>[...document.querySelectorAll('#dataset-remove-dialog[open] .button,#dataset-removal-records .button,.dataset-remove-more .button')].map(element=>{const rect=element.getBoundingClientRect();return {text:element.textContent,height:rect.height,width:rect.width,minimum:innerWidth<=759?44:32};}).filter(rect=>rect.width&&rect.height));assert(controls.every(rect=>rect.height>=rect.minimum),JSON.stringify({name,width,controls}));const modal=await page.locator('#dataset-remove-dialog[open]').count();const result=await inspectGeometry(page,{roots:modal?['#dataset-remove-dialog[open]']:role==='admin'?['[data-admin-storage]']:['#page-datasets'],compactSearch:datasetHelpGeometry.compactSearch,controls:'.button,input,select',containment:'input,.button,.dataset-remove-facts>div,.dataset-remove-blocked',leftEdges:modal?[['.dataset-remove-facts>div:first-child dt','.dataset-remove-facts>div:last-child dt']]:[],helpContexts:modal?['#dataset-remove-dialog[open] [data-copy-help]']:['#dataset-removal-records [data-copy-help]'],buttonRows:modal?[{parent:'.dataset-remove-dialog .modal-actions'}]:[],scrollPanels:modal?['#dataset-remove-dialog[open]']:[]});geometry.push({name,role,...result});assert.equal(result.pass,true,JSON.stringify({name,role,...result}));await assertRemovalWords(name,width);await page.screenshot({path:join(shots,name+'-'+role+'-'+width+'.png')});}};
  const open=async(version,whole=false)=>{await card(version).locator('[data-remove-more]').click();await card(version).locator(whole?'[data-remove-dataset]':'[data-remove-version]').click();await page.locator('#dataset-remove-dialog').waitFor();};
  await load();
  if(role==='member'){
   assert.equal(await page.locator('[data-remove-more],[data-remove-version],[data-remove-dataset],#dataset-removal-records').count(),0);await capture('member-boundary');assert.equal(calls.some(x=>x.operation==='datasets.unregister'||x.operation==='datasets.status'),false);checks.push('member has no deletion DOM or calls');
   // The one approved compact search has an exact 40px/14px contract.
   // General mobile actions still require 44px; neither rule is relaxed.
   await page.setViewportSize({width:390,height:1000});
   const search=page.locator('#warehouse-search'),originalSearch=await search.getAttribute('style');
   try{
    await search.evaluate(node=>node.style.setProperty('height','44px','important'));
    const wrongHeight=await inspectGeometry(page,{roots:['#page-datasets'],controls:'input',compactSearch:datasetHelpGeometry.compactSearch});assert(wrongHeight.failures.some(row=>row.rule==='compact-search'));
    await search.evaluate(node=>{node.style.setProperty('height','40px','important');node.style.setProperty('font-size','15px','important');});
    const wrongFont=await inspectGeometry(page,{roots:['#page-datasets'],controls:'input',compactSearch:datasetHelpGeometry.compactSearch});assert(wrongFont.failures.some(row=>row.rule==='compact-search'));
   }finally{await search.evaluate((node,style)=>style===null?node.removeAttribute('style'):node.setAttribute('style',style),originalSearch);}
   const refresh=page.locator('#datasets-refresh'),originalRefresh=await refresh.getAttribute('style');
   try{
    await refresh.evaluate(node=>{node.style.setProperty('height','40px','important');node.style.setProperty('min-height','40px','important');});
    const smallAction=await inspectGeometry(page,{roots:['#page-datasets'],controls:'.button,input',compactSearch:datasetHelpGeometry.compactSearch});assert(smallAction.failures.some(row=>row.rule==='touch-height'&&row.elements.includes('#datasets-refresh')));
   }finally{await refresh.evaluate((node,style)=>style===null?node.removeAttribute('style'):node.setAttribute('style',style),originalRefresh);}
   const restored=await inspectGeometry(page,{roots:['#page-datasets'],controls:'.button,input',compactSearch:datasetHelpGeometry.compactSearch});assert.equal(restored.pass,true,JSON.stringify(restored.failures));checks.push('exact compact search height/font and unchanged general mobile touch target');
  }else{
   await page.locator('link[data-dataset-remove-style]').waitFor({state:'attached'});assert.equal(await page.locator('[data-remove-more]').count(),3);
   for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await card(V1).locator('[data-remove-more]').click();const menu=card(V1).locator('.dataset-remove-options');await menu.waitFor();assert.equal(await menu.locator('[data-remove-version] .server-id').textContent(),machines[0].id);await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(shots,'more-menu-admin-'+width+'.png')});await menu.evaluate(element=>element.hidePopover());}
   archiveMode=true;await open(V1);assert.match(await page.locator('#dataset-remove-dialog').textContent(),/仓库原件/);assert.equal(await page.locator('.dataset-remove-facts>div:last-child .server-id').textContent(),machines[1].id);await capture('archive-confirm');await page.getByRole('button',{name:'关闭删除确认',exact:true}).click();archiveMode=false;
   uniqueVersion=true;await open(V2);assert.equal(await page.locator('[data-remove-confirm]').isDisabled(),true);assert.match(await page.locator('#dataset-remove-dialog').textContent(),/这可能是最后一份完整数据，暂不能按机器删除/);await capture('last-copy-blocked');await page.getByRole('button',{name:'关闭删除确认',exact:true}).click();await open(V2,true);await page.locator('[name=remove-name]').fill(localDataset);assert.equal(await page.locator('[data-remove-confirm]').isDisabled(),true);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,0);await capture('whole-last-copy-blocked');await page.getByRole('button',{name:'关闭删除确认',exact:true}).click();uniqueVersion=false;
   // The last-copy hint must not promise a feature the nodes have not enabled.
   uniqueVersion=true;
   for(const capability of [0,1,true,'1']){
    deleteCapability=capability;await open(V2);
    const help=await page.locator('#dataset-remove-dialog .dataset-remove-blocked .copy-help-popup').textContent();
    if(capability===1)assert.match(help,/可用「彻底删除」/);else assert.doesNotMatch(help,/彻底删除/);
    assert.equal(await page.locator('[data-remove-confirm]').isDisabled(),true);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,0);
    await page.getByRole('button',{name:'关闭删除确认',exact:true}).click();
   }
   deleteCapability=0;uniqueVersion=false;checks.push('last-copy hint names full deletion only when current catalog capability is strictly 1');
   pendingNode=true;await open(V1);assert.match(await page.locator('#dataset-remove-dialog').textContent(),/这台服务器上的删除结果待确认/);assert.equal(await page.locator('[data-remove-confirm]').isDisabled(),true);await capture('server-pending-blocked');await page.locator('#dataset-remove-dialog .dataset-remove-blocked [data-copy-help]').click();await page.locator('#dataset-remove-dialog .dataset-remove-blocked .copy-help-popup:popover-open').waitFor();assert.equal(await page.locator('#dataset-remove-dialog .dataset-remove-blocked .copy-help-popup>span').textContent(),'请求发出后没有收到回执。为避免误删最后一份数据，这份副本暂时不算作可用副本；节点确认删除完成或 25 小时后会自动解除。');await capture('missing-receipt-help');await page.getByRole('button',{name:'关闭删除确认',exact:true}).click();pendingReceiptKnown=true;await open(V1);await page.locator('#dataset-remove-dialog .dataset-remove-blocked [data-copy-help]').click();const knownHelp=page.locator('#dataset-remove-dialog .dataset-remove-blocked .copy-help-popup:popover-open');await knownHelp.waitFor();assert.match(await knownHelp.textContent(),/按原编号/);assert.doesNotMatch(await knownHelp.textContent(),/25 小时/);assert.equal(await page.locator('[data-remove-confirm]').isDisabled(),true);await capture('known-receipt-help');await page.getByRole('button',{name:'关闭删除确认',exact:true}).click();pendingReceiptKnown=false;pendingNode=false;
   await open(V1);assert.match(await page.locator('#dataset-remove-dialog').textContent(),/其他服务器上的完整副本/);assert.equal(await page.locator('.dataset-remove-facts>div:first-child .server-id').textContent(),machines[0].id);assert.equal(await page.locator('.dataset-remove-facts>div:last-child .server-id').textContent(),machines[1].id);assert.doesNotMatch(await page.locator('.dataset-remove-facts>div:last-child').textContent(),/仓库原件/);await capture('version-confirm');
   await page.locator('[data-remove-confirm]').click();await page.locator('.dataset-removal-state').filter({hasText:'删除中'}).waitFor();assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,1);assert.equal(calls.find(x=>x.operation==='datasets.unregister').args.version,V1);
   // The initial unregister response already renders the operation number.
   // Wait for the actual timer-driven status reply before counting requests.
   const firstStatus=page.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='datasets.status');
   await page.clock.runFor(2000);await firstStatus;
   assert.equal(calls.filter(x=>x.operation==='datasets.status').length,1);await page.locator('[data-nav=resources]').click();const before=calls.filter(x=>x.operation==='datasets.status').length;await page.clock.runFor(30000);assert.equal(calls.filter(x=>x.operation==='datasets.status').length,before);await enterStorage();
   stateMode='UNKNOWN';await page.locator('[data-removal-query]').click();await page.locator('.dataset-removal-state').filter({hasText:'删除结果未确认'}).waitFor();await page.clock.runFor(30000);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,1);
   await page.locator('#dataset-removal-records').scrollIntoViewIfNeeded();await capture('unknown-receipt');
   stateMode='FAILED';await page.locator('[data-removal-query]').click();await page.locator('#dataset-removal-records').filter({hasText:'有训练正在使用'}).waitFor();assert.equal(await card(V1).count(),1);
   stateMode='UNREGISTERED';await page.locator('[data-removal-query]').click();await page.locator('#dataset-removal-records').waitFor({state:'detached'});await storageReady();
   await assertRetainedCopies(V1);
   // Recreate a stale displayed registration, then remove it before the fresh
   // confirmation read. It must never permit a second unregister request.
   deleted.delete(key(machines[0].id,localDataset,V1));await page.locator('[data-storage-refresh]').click();await storageReady();deleted.add(key(machines[0].id,localDataset,V1));
   await card(V1).locator('[data-remove-more]').click();await card(V1).locator('[data-remove-version]').click();await page.getByText('这台服务器没有此登记，请刷新目录。',{exact:true}).waitFor();assert.equal(await page.locator('#dataset-remove-dialog').isVisible(),false);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,1);
   // Whole-dataset confirmation cannot use a partial or display name.
   await open(V2,true);assert.equal(await page.locator('[data-remove-confirm]').isDisabled(),true);await page.locator('[name=remove-name]').fill('sca');assert.equal(await page.locator('[data-remove-confirm]').isDisabled(),true);await page.locator('[name=remove-name]').fill(localDataset);assert.equal(await page.locator('[data-remove-confirm]').isEnabled(),true);await capture('whole-confirm');
   await page.locator('[data-remove-confirm]').click();await page.locator('.dataset-removal-state').filter({hasText:'删除中'}).first().waitFor();assert.equal(Object.hasOwn(calls.filter(x=>x.operation==='datasets.unregister').at(-1).args,'version'),false);
   stateMode='UNKNOWN';await page.locator('[data-removal-query]').click();await page.locator('#dataset-removal-records').filter({hasText:'未确认'}).waitFor();lostStatus=true;await page.locator('[data-removal-query]').click();await page.waitForFunction(()=>!document.querySelector('[data-removal-query]').disabled);
   const idBefore=calls.filter(x=>x.operation==='datasets.status').at(-1).args.operationId;await load();await page.clock.runFor(2000);await page.waitForFunction(()=>!document.querySelector('[data-removal-query]').disabled);assert.equal(calls.filter(x=>x.operation==='datasets.status').at(-1).args.operationId,idBefore);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,2);
   stateMode='UNREGISTERED';await page.locator('[data-removal-query]').click();await page.locator('#dataset-removal-records').waitFor({state:'detached'});await storageReady();await assertRetainedCopies(V2);await assertRetainedCopies(V1);
   // A completely lost submission has no operation ID. It stays locked until
   // an administrator supplies the actual ID or confirms abandoning intent.
   deleted.delete(key(machines[0].id,localDataset,V1));await load();lostSubmit='http400';stateMode='UNKNOWN';await open(V1);await page.locator('[data-remove-confirm]').click();await page.locator('.dataset-removal-state').filter({hasText:'删除请求结果未确认'}).waitFor();const count=calls.filter(x=>x.operation==='datasets.unregister').length;
   await load();assert.equal(await card(V1).locator('[data-remove-version]').isDisabled(),true);await page.clock.runFor(30000);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,count);await page.locator('#dataset-removal-records').scrollIntoViewIfNeeded();await capture('lost-submit');
   await page.locator('[data-removal-abandon]').click();assert.match(await page.locator('#dataset-remove-dialog').textContent(),/再次删除可能重复执行/);await page.locator('#dataset-remove-dialog [data-remove-close]').click();assert.equal(await card(V1).locator('[data-remove-version]').isDisabled(),true);
   await page.locator('[name=operationId]').fill([...ops.keys()].at(-1));await page.locator('[data-removal-lookup] [type=submit]').click();await page.locator('[data-removal-query]').waitFor();assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,count);
   await page.locator('[data-removal-abandon]').click();await page.getByRole('button',{name:'放弃记录',exact:true}).click();await page.locator('#dataset-removal-records').waitFor({state:'detached'});assert.equal(await card(V1).locator('[data-remove-version]').isEnabled(),true);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,count);
   // A new admin login does not resume another admin's pending receipt.
   lostSubmit=true;await open(V1);await page.locator('[data-remove-confirm]').click();await page.locator('.dataset-removal-state').filter({hasText:'请求结果未确认'}).waitFor();userId='another-admin';principal={userId,username:userId,role:'admin'};await load();assert.equal(await page.locator('#dataset-removal-records').count(),0);await page.clock.runFor(30000);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,count+1);assert.equal(calls.some(x=>x.userId==='another-admin'&&x.operation==='datasets.status'),false);
   userId='refusal-admin';principal={userId,username:userId,role:'admin'};lostSubmit=false;await load();
   for(const code of ['LAST_COPY_UNPROVEN','DATASET_REMOVAL_PENDING']){
    const before=calls.filter(x=>x.operation==='datasets.unregister').length,operations=ops.size;rejectSubmit=code;await open(V1);await page.locator('[data-remove-confirm]').click();await page.locator('#dataset-removal-records').filter({hasText:code==='LAST_COPY_UNPROVEN'?'为避免永久丢失':'这台服务器上的删除结果待确认'}).waitFor();
    assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,before+1);assert.equal(ops.size,operations);assert.equal(await page.locator('[data-removal-query],[data-removal-abandon],[data-removal-lookup]').count(),0);assert.doesNotMatch(await page.locator('#dataset-removal-records').textContent(),/删除失败|删除请求结果未确认|重试/);await page.clock.runFor(30000);assert.equal(calls.filter(x=>x.operation==='datasets.unregister').length,before+1);await capture('server-'+code.toLowerCase());await page.locator('[data-removal-dismiss]').click();await page.locator('#dataset-removal-records').waitFor({state:'detached'});
   }
   checks.push('warehouse original fact','other complete copy fact','last copy disabled','whole mixed version disabled','node pending blocks repeat','authoritative server 409 no unknown/no retry','atomic five-character action phrase stays on one line without clipping','missing receipt grace help and known ID never promises timed release');
   checks.push('version scope','catalog alias resolves to the node registration name','no local registration cannot be removed','whole-name confirmation','2s then pause on leave','UNKNOWN no replay','lease FAILED reason','known receipt refresh','HTTP 400 bridge uncertainty stays locked','missing ID manual lookup','double-confirm abandon','other machines and datasets retained','cross-account isolation');
  }
  await context.unrouteAll({behavior:'ignoreErrors'});await context.close();
 }
}finally{await browser.close();}
assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(join(shots,'checks.json'),JSON.stringify({status:'passed',checks,geometry,wordGeometry,errors,external},null,2));console.log(JSON.stringify({status:'passed',screenshots:shots,checks}));
