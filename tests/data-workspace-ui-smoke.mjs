// Offline Chromium acceptance for personal /data2 upload, publication and fences.
// Every HTTP request is fulfilled from this repository or memory.
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';
const origin='https://offline-data-workspace.test',screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-data-workspace-ui';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  await mkdir(screenshots,{recursive:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],unexpected=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/datasets.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/dataset-flow.css"><link rel="stylesheet" href="/dataset-warehouse.css"><body class="sb" data-room="datasets"><main><div class="page-heading"><h1 id="page-title">数据集</h1><div class="heading-actions"></div></div><section id="page-datasets"></section></main>'});
    if(['/dataset-catalog-model.js','/dataset-label-client.js','/dataset-warehouse-view.js','/dataset-files-preview.js','/dataset-upload-metrics.js','/dataset-warehouse.css','/dataset-flow.js','/dataset-cache-admin.js','/manual-pin-state.js','/maintenance-state.js','/copy-help-ui.js','/datasets-ui.js','/dataset-remove-ui.js','/dataset-full-delete-ui.js','/dataset-full-delete-state.js','/dataset-remove.css','/workbench-ui.js','/job-progress.js','/motion-ui.js','/data-route.js','/data-workspace.js','/cloud-files-ui.js','/dataset-upload.js','/upload-routes.js','/transfer-upload.js','/cloud-import-ui.js','/styles.css','/workspace.css','/datasets.css'].includes(url.pathname)||Object.hasOwn(STARBASE_ASSETS,url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.woff2')?'font/woff2':'text/css',body:await readFile(new URL('../dist'+url.pathname,import.meta.url))});
    if(url.pathname==='/favicon.ico')return route.fulfill({status:204});unexpected.push(url.href);return route.abort();
  });
  await page.goto(origin);
  await page.evaluate(async()=>{
    const {datasetsUI}=await import('/datasets-ui.js');
    window.calls=[];window.toasts=[];window.gatePut=false;window.gatePublish=false;window.gateCatalog=false;window.capacityFail=false;window.remote=new Map();window.cloudRows=new Map();window.published=false;
    window.store={production:true,principal:{userId:'alice',role:'member'},authGeneration:0,
      users:['alice','bob','carol'].map(id=>({id,role:'member',enabled:true,limits:{'node-a':1,'node-b':1},total:2})),usage(){return 0;},
      data:{machines:[{id:'node-a'},{id:'node-b'}]},listeners:[],onAuthChange(callback){this.listeners.push(callback);},async call(operation,args){
      calls.push({operation,args:structuredClone(args),user:this.principal.userId});
      if(operation==='datasets.upload.routes')return {available:false,protocol:'dataset-upload-v1',machine:args.machine};
      if(operation==='cloud.info')return {capabilityVerified:false,configurationEnabled:true};
      if(operation==='datasets.capacity'){if(capacityFail)throw Error('test capacity unavailable');return {machine:args.machine,available:true,filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3};}
      if(operation==='datasets.overview'){if(Object.keys(args).length)throw Error('overview accepts no args');return {protocol:0};}
      if(operation==='datasets.catalog'){
        // Alice's published metadata remains discoverable after an account
        // switch; discovery never transfers Alice's content permission.
        const canUse=this.principal.userId==='alice'&&this.users.find(row=>row.id==='alice').limits['node-a']>0;
        const result={machine:args.machine,machines:this.data.machines.map(row=>({machine:row.id,state:'ok'})),
          datasets:published?[{dataset:'personal-test',versions:[{version:'a'.repeat(64),state:args.machine==='node-a'&&canUse?'READY':'NOT_LOCAL',
            canUse,canPrepare:false,files:1,bytes:4,locations:[{machine:'node-a',dataset:'personal-test',state:'READY',canUse,canPrepare:false}]}]}]:[]};
        if(gateCatalog)await new Promise(resolve=>{window.releaseCatalog=resolve;});return result;
      }
      if(operation==='datasets.workspace.put'){
        const id=this.principal.userId+':'+args.machine+':'+args.path,old=remote.get(id)||0,length=atob(args.data).length;
        if(args.offset!==(args.truncate?0:old))throw Error('File exists; explicitly enable overwrite');
        const size=args.offset+length;remote.set(id,size);
        if(gatePut)await new Promise(resolve=>{window.releasePut=resolve;});
        return {path:args.path,size};
      }
      if(operation==='datasets.workspace.list')return {path:args.path,entries:[{type:'directory',name:'prepared',size:0},{type:'file',name:'<unsafe>.zip',size:4}]};
      if(operation==='datasets.workspace.publish'){
        if(gatePublish)await new Promise(resolve=>{window.releasePublish=resolve;});
        return {operationId:args.key,state:'PUBLISHING',path:args.path,name:args.name};
      }
      if(operation==='datasets.workspace.status'){
        if(args.operationId){published=true;return {operationId:args.operationId,state:'READY',dataset:'personal-test',version:'a'.repeat(64)};}
        return {state:'EDITABLE',mountPath:'/data2'};
      }
      if(operation==='cloud.files.info')return {enabled:true};
      if(operation.startsWith('cloud.files.')){
        const scope=this.principal.userId+':'+args.machine,rows=cloudRows.get(scope)||[];
        if(operation==='cloud.files.list')return {files:structuredClone(rows)};
        if(operation==='cloud.files.status'){const row=rows.find(row=>row.operationId===args.operationId);if(!row)throw Object.assign(Error('operation not found'),{status:404});return structuredClone(row);}
        if(operation==='cloud.files.upload')rows.push({operationId:args.key,action:'upload',name:'training.zip',path:args.path,state:'VERIFYING',bytes:2*1024**2+3,totalBytes:2*1024**2+3});
        else if(operation==='cloud.files.verify'){const row=rows.find(row=>row.operationId===args.fileId);if(!row)throw Error('Cloud file is not owned by this account');row.state='VERIFIED';}
        else if(operation==='cloud.files.download'){if(!rows.some(row=>row.operationId===args.fileId&&row.state==='VERIFIED'))throw Error('Cloud source is not verified');rows.push({operationId:args.key,action:'download',name:'training.zip',path:args.path,state:'READY'});}
        else throw Error('Unexpected cloud operation '+operation);
        cloudRows.set(scope,rows);return {operationId:args.key,state:operation==='cloud.files.verify'?'VERIFIED':rows.find(row=>row.operationId===args.key)?.state};
      }
      throw Error('Unexpected operation '+operation);
    }};
    window.render=datasetsUI(store,value=>toasts.push(value));render();
  });
  await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  await page.locator('[data-v3-upload]').first().click();
  await page.locator('[data-v3-source=workspace]').click();
  const files=page.locator('[name=data-workspace-files]');
  await files.setInputFiles([{name:'training.zip',mimeType:'application/zip',buffer:Buffer.alloc(2*1024**2+3,7)}]);
  const callsBeforeLarge=await page.evaluate(()=>calls.length);
  await files.evaluate(input=>{Object.defineProperty(input.files[0],'size',{value:256*1024**2+1,configurable:true});input.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.locator('#data-workspace-relay-warning').isVisible(),true);
  await page.locator('#data-workspace-upload').click();
  await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent.includes('确认 VPS 中转'));
  assert.equal(await page.evaluate(()=>calls.length),callsBeforeLarge,'Oversized raw upload must not silently relay before confirmation');
  await files.evaluate(input=>{delete input.files[0].size;input.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.locator('#data-workspace-relay-warning').isHidden(),true);
  await page.locator('#data-workspace-upload').click();
  await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent.includes('已上传 1 个文件'));
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.operation==='datasets.workspace.put').map(call=>call.args.offset)),[0,1024**2,2*1024**2]);
  assert.equal(await page.evaluate(()=>calls.some(call=>call.operation.includes('publish'))),false);
  assert.equal(await page.locator('#terminal-data-open').isEnabled(),true);
  assert.equal(await page.locator('#cloud-files').isHidden(),true,'The public workspace keeps experimental cloud files hidden');
  assert.equal(await page.evaluate(()=>calls.some(call=>call.operation.startsWith('cloud.files.'))),false,'Opening the public workspace does not probe experimental cloud files');
  // Exercise the preserved component with an explicit local fixture enable,
  // as in cloud-files-ui-smoke; this does not expose its production entry.
  await page.locator('#cloud-files').evaluate(node=>{node.hidden=false;});
  const cloudEntry=page.locator('.data-workspace-browser > summary').filter({hasText:'云端副本'});
  await cloudEntry.click();await page.locator('#cloud-files-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#cloud-files-list').textContent.includes('还没有云文件'));
  await page.locator('[name=cloud-files-path]').fill('incoming/training.zip');await page.locator('#cloud-files-form [type=submit]').click();
  await page.locator('[data-cloud-verify]').waitFor();await page.locator('[data-cloud-verify]').click();
  await page.locator('[data-cloud-restore]').waitFor();page.once('dialog',dialog=>dialog.accept('restored/training.zip'));await page.locator('[data-cloud-restore]').click();
  await page.waitForFunction(()=>document.querySelector('#cloud-files-list').textContent.includes('已保存到数据空间'));
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>['cloud.files.upload','cloud.files.verify','cloud.files.download'].includes(call.operation)).map(call=>[call.operation,call.user,call.args.machine])),[['cloud.files.upload','alice','node-a'],['cloud.files.verify','alice','node-a'],['cloud.files.download','alice','node-a']]);
  assert.equal(await page.evaluate(()=>calls.find(call=>call.operation==='cloud.files.download').args.path),'restored/training.zip');
  // A changed cloud identity is retained as a paused operation, never resumed
  // by re-verification. Confirming the source and starting a NEW download are
  // separate user actions with independent keys.
  const oldDownload=await page.evaluate(()=>structuredClone(calls.find(call=>call.operation==='cloud.files.download').args));
  await page.evaluate(key=>{const row=cloudRows.get('alice:node-a').find(row=>row.operationId===key);row.state='PAUSED';row.canResume=false;row.errorCode='CLOUD_FILE_IDENTITY_CHANGED';row.error='private backend implementation detail';},oldDownload.key);
  await page.locator('#cloud-files-refresh').click();await page.waitForFunction(()=>document.querySelector('#cloud-files-list').textContent.includes('云端文件已变化'));
  const changed=page.locator('#cloud-files-list li').filter({hasText:'云端文件已变化'});
  assert.match(await changed.textContent(),/重新校验.*新的路径/);assert.match(await changed.textContent(),/已有文件会保留/);
  assert.doesNotMatch(await changed.textContent(),/可续传|private backend implementation/);assert.equal(await changed.locator('button:not([data-copy-help])').count(),0);
  const changedHelp=changed.locator('[data-copy-help]');assert.equal(await changedHelp.count(),1);
  const writesBeforeHelp=await page.evaluate(()=>calls.filter(call=>['cloud.files.upload','cloud.files.verify','cloud.files.download','cloud.files.resume','cloud.files.cancel'].includes(call.operation)).length);
  await changedHelp.click();assert.equal(await page.locator('#'+await changedHelp.getAttribute('aria-controls')).isVisible(),true);
  assert.equal(await page.evaluate(()=>calls.filter(call=>['cloud.files.upload','cloud.files.verify','cloud.files.download','cloud.files.resume','cloud.files.cancel'].includes(call.operation)).length),writesBeforeHelp,'Cloud explanation cannot send an operation');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-cloud-verify]').textContent(),'重新校验');await page.locator('[data-cloud-verify]').click();
  await page.waitForFunction(()=>calls.filter(call=>call.operation==='cloud.files.verify').length===2&&document.querySelector('#cloud-files-status').textContent.includes('已提交'));
  const reverified=await page.evaluate(()=>calls.filter(call=>call.operation==='cloud.files.verify').map(call=>call.args));
  assert.notEqual(reverified[0].key,reverified[1].key);assert.notEqual(reverified[1].key,oldDownload.key);assert.notEqual(reverified[1].key,reverified[1].fileId);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.operation==='cloud.files.download').length),1,'Reverify must not silently resume or download');
  page.once('dialog',dialog=>dialog.accept('restored/reverified-training.zip'));await page.locator('[data-cloud-restore]').click();
  await page.waitForFunction(()=>calls.filter(call=>call.operation==='cloud.files.download').length===2);
  const nextDownload=await page.evaluate(()=>calls.findLast(call=>call.operation==='cloud.files.download').args);
  assert.notEqual(nextDownload.key,oldDownload.key);assert.equal(nextDownload.fileId,oldDownload.fileId);assert.equal(nextDownload.path,'restored/reverified-training.zip');
  assert.equal(await page.evaluate(key=>cloudRows.get('alice:node-a').find(row=>row.operationId===key).state,oldDownload.key),'PAUSED');
  await cloudEntry.click();
  await page.locator('.data-workspace-browser > summary').filter({hasText:'查看文件与发布进度'}).click();await page.locator('#data-workspace-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#data-workspace-files-list').textContent.includes('<unsafe>.zip'));
  assert.equal(await page.locator('#data-workspace-files-list unsafe').count(),0);
  await page.locator('[data-workspace-path="prepared"]').click();await page.waitForFunction(()=>calls.some(call=>call.operation==='datasets.workspace.list'&&call.args.path==='prepared'));
  await page.locator('[name=data-workspace-publish-path]').fill('prepared');await page.locator('[name=data-workspace-name]').fill('training');await page.locator('#data-workspace-publish').click();
  await page.locator('[data-v3-select=personal-test]').waitFor();
  assert.equal(await page.locator('#warehouse-inspector .v3-server').filter({has:page.locator('b[title="node-a"]')}).locator('.v3-g.ready').count(),1,'The confirmed server cache uses the filled status symbol');
  assert.doesNotMatch(await page.locator('#warehouse-inspector').textContent(),/已缓存/,'No redundant cache explanation accompanies the symbol');
  assert.match(await page.locator('#data-workspace-status').textContent(),/已发布/);
  assert.ok(await page.locator('[data-use-dataset]').isEnabled());
  await page.screenshot({path:screenshots+'/data-workspace-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'workspace page must fit 390px');
  assert.equal(await page.locator('#dataset-panel-workspace .data-workspace-fields').first().evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length),1);
  await page.screenshot({path:screenshots+'/data-workspace-mobile.png',fullPage:true});
  await page.locator('#dataset-source-workspace').scrollIntoViewIfNeeded();
  await page.screenshot({path:screenshots+'/data-workspace-mobile-viewport.png',fullPage:false});
  // An account switch after a durable upload reply must neither send more data
  // under the next account nor repopulate the next account's controls.
  await files.setInputFiles([{name:'late.zip',mimeType:'application/zip',buffer:Buffer.alloc(2*1024**2,5)}]);
  await page.evaluate(()=>{gatePut=true;});await page.locator('#data-workspace-upload').click();await page.waitForFunction(()=>typeof releasePut==='function');
  const before=await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.workspace.put').length);
  await page.evaluate(()=>{store.principal={userId:'bob',role:'member'};store.authGeneration++;store.listeners.forEach(listener=>listener());render();releasePut();});await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.workspace.put').length),before,'Late old-account reply causes no further file blocks');assert.doesNotMatch(await page.locator('#data-workspace-status').textContent(),/late.zip/);
  assert.equal(await page.locator('[name=data-workspace-files]').evaluate(node=>node.files.length),0);
  await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  await page.locator('[data-v3-upload]').first().click();
  await page.locator('[data-v3-source=workspace]').click();
  // A server reply arriving after a machine change cannot start polling for
  // the old machine through the new selection. The remote publish is retained.
  await page.evaluate(()=>{gatePublish=true;});await page.locator('[name=data-workspace-publish-path]').fill('prepared');await page.locator('[name=data-workspace-name]').fill('second');await page.locator('#data-workspace-publish').click();await page.waitForFunction(()=>typeof releasePublish==='function');
  const beforeMachine=await page.evaluate(()=>calls.length);
  await page.evaluate(()=>{const select=document.querySelector('[name=dataset-machine]');select.value='node-b';select.dispatchEvent(new Event('change',{bubbles:true}));releasePublish();});await page.waitForTimeout(1700);
  assert.equal(await page.evaluate(count=>calls.slice(count).some(call=>call.operation==='datasets.workspace.status'),beforeMachine),false);
  assert.match(await page.locator('#data-workspace-status').textContent(),/已切换服务器/);assert.equal(await page.locator('[name=dataset-machine]').inputValue(),'node-b');
  // A failed space reading is explicit but cannot erase a confirmed catalog.
  await page.locator('[data-dataset-add-close]').click();
  await page.evaluate(()=>{capacityFail=true;});await page.locator('#datasets-refresh').click();
  await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  assert.match(await page.locator('#datasets-capacity').textContent(),/容量待更新/);
  assert.equal(await page.locator('[data-v3-select]').count(),0,'The main list hides Alice’s unreadable version from Bob');
  assert.equal(await page.locator('[data-use-dataset]').count(),0,'No training entry exists for the hidden version');
  // Revoking a different machine invalidates the entire aggregate, even when
  // the selected machine is unchanged and an old directory reply arrives late.
  await page.evaluate(()=>{gateCatalog=true;});await page.locator('#datasets-refresh').click();
  await page.waitForFunction(()=>typeof releaseCatalog==='function');
  await page.evaluate(()=>{store.users.find(row=>row.id==='bob').limits={'node-b':1};render();releaseCatalog();});await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-v3-select]').count(),0);assert.match(await page.locator('#datasets-status').textContent(),/授权已更新/);
  // The new contract refreshes after permission changes. Release that fresh
  // authorized read, then independently hold the next old-login observation.
  await page.evaluate(()=>{gateCatalog=false;releaseCatalog();});
  await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
  // A response belonging to the previous login cannot refill the new view.
  await page.evaluate(()=>{gateCatalog=true;window.releaseCatalog=undefined;});await page.locator('#datasets-refresh').click();
  await page.waitForFunction(()=>typeof releaseCatalog==='function');
  await page.evaluate(()=>{store.principal={userId:'carol',role:'member'};store.authGeneration++;store.listeners.forEach(listener=>listener());render();releaseCatalog();});await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-v3-select]').count(),0);assert.doesNotMatch(await page.locator('#datasets-capacity').textContent(),/512\.00/);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log('PERSONAL DATA UI PASS: raw bounded upload; no automatic extraction/publication; cloud identity pause retained, explicit fresh-key reverify and separate new download; file-list escaping; publication then READY catalog; 390px layout; late account reply stops chunks; late machine reply stops polling; unknown capacity keeps catalog; revoked remote-machine permission invalidates aggregate; old login cannot repaint catalog. Offline mock nodes only. Screenshots: '+screenshots);
}finally{await browser.close();}
