// Offline browser QA only: both cloud provider and execution nodes are mocks.
// No real Aliyun account, cloud download or production node is used here.
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin='https://offline-cloud-import.test',screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-cloud-import-ui';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  await mkdir(screenshots,{recursive:true});
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[],unexpected=[],dialogs=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.accept();});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/datasets.css"><main><h1>数据空间</h1><section id="page-datasets"></section></main>'});
    if(['/maintenance-state.js','/copy-help-ui.js','/cloud-import-ui.js','/styles.css','/workspace.css','/datasets.css'].includes(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:await readFile(new URL('../dist'+url.pathname,import.meta.url),'utf8')});
    if(url.pathname==='/favicon.ico')return route.fulfill({status:204});unexpected.push(url.href);return route.abort();
  });
  await page.goto(origin);
  await page.evaluate(async()=>{
    const {cloudImportHTML,cloudImportUI}=await import('/cloud-import-ui.js');
    window.calls=[];window.toasts=[];window.rows=new Map();window.loseNext=false;window.hideRows=false;window.holdNext=false;window.allowDiscard=false;
    const section=document.querySelector('#page-datasets');
    window.store={production:true,principal:{userId:'alice',role:'member'},authGeneration:0,async call(operation,args){
      const user=this.principal.userId;calls.push({operation,args:structuredClone(args),user});
      const key=user+':'+args.machine,items=rows.get(key)||[];
      if(operation==='cloud.info')return {backend:'aliyun',aliyunConnected:true,capabilityVerified:true};
      if(operation==='cloud.inspect')return {inspectionId:'inspection-alice',files:[{id:'file-1',name:'压缩数据.zip',size:1024**3},{id:'file-2',name:'<img onerror=alert(1)>.zip',size:2}]};
      if(operation==='cloud.import.start'){
        const row=items.find(r=>r.operationId===args.key)||{operationId:args.key,path:args.path,sourceKind:args.url?'https':'aliyun',state:'QUEUED',bytes:0,totalBytes:1024**3,canResume:false};
        if(!items.includes(row))items.push(row);rows.set(key,items);
        if(holdNext){holdNext=false;await new Promise(resolve=>{window.releaseStart=resolve;});}
        if(loseNext){loseNext=false;throw Error('模拟响应丢失');}
        hideRows=false;return structuredClone(row);
      }
      if(operation==='cloud.import.list')return {imports:hideRows?[]:structuredClone(items)};
      const row=items.find(r=>r.operationId===args.operationId);
      if(operation==='cloud.import.resume'){if(!row)throw Error('missing mock task');row.state='RUNNING';row.canResume=false;return structuredClone(row);}
      if(operation==='cloud.import.cancel'){row.state='CANCELING';row.canResume=false;return structuredClone(row);}
      if(operation==='cloud.import.status'){if(hideRows||!row)throw Object.assign(Error('original import absent'),{status:404});return {...structuredClone(row),canDiscard:allowDiscard};}
      if(operation==='cloud.import.discard'){if(!allowDiscard)throw Error('worker not stopped');rows.set(key,items.filter(r=>r!==row));return {discarded:true,operationId:args.operationId};}
      if(operation==='cloud.auth.begin')return {id:'mock-qr',image:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3C/svg%3E'};
      if(operation==='cloud.auth.poll')return {state:'CONFIRMED'};
      if(operation==='cloud.auth.disconnect')return {disconnected:true};
      throw Error('unexpected mock operation '+operation);
    }};
    window.render=()=>{section.innerHTML='<label>服务器<select name="dataset-machine"><option value="node-a">node-a</option><option value="node-b">node-b</option></select></label>'+cloudImportHTML(store.principal.role==='admin');window.ui.controls();};
    window.ui=cloudImportUI(store,section,value=>toasts.push(value));render();
  });
  const waitIdle=()=>page.waitForFunction(()=>!document.querySelector('#cloud-import-refresh').disabled);
  const refresh=async()=>{await page.locator('#cloud-import-refresh').click();await waitIdle();};
  const source=page.locator('[name=cloud-source]'),link=page.locator('[name=cloud-url]'),path=page.locator('[name=cloud-path]');
  assert.equal(await page.locator('#cloud-admin').count(),0);
  await source.selectOption('aliyun');await waitIdle();assert.equal(await page.locator('[name=cloud-sha256]').isDisabled(),true);
  await link.fill('https://www.alipan.com/s/mock-share');await page.locator('#cloud-inspect').click();await waitIdle();
  assert.equal(await page.locator('[name=cloud-file] option').count(),2);assert.equal(await page.locator('[name=cloud-file] img').count(),0);
  await page.locator('#cloud-import-form [type=submit]').click();await waitIdle();
  assert.equal(await page.evaluate(()=>calls.find(c=>c.operation==='cloud.import.start').args.inspectionId),'inspection-alice');
  assert.equal(await page.evaluate(()=>Object.hasOwn(calls.find(c=>c.operation==='cloud.import.start').args,'url')),false);

  // A lost start response locks the original request; exact retries reuse it.
  await source.selectOption('https');await link.fill('https://cdn.example.test/data.zip?signature=private');await path.fill('incoming/direct.zip');
  await page.evaluate(()=>{loseNext=true;hideRows=true;});await page.locator('#cloud-import-form [type=submit]').click();await waitIdle();
  const pending=await page.locator('#cloud-import-pending-key').textContent();assert.match(pending,/^[a-f0-9-]{36}$/);
  assert.equal(await link.isDisabled(),true);assert.equal(await page.locator('#cloud-import-form [type=submit]').isDisabled(),true);
  await refresh();assert.equal(await page.locator('#cloud-import-pending').isVisible(),true);
  // Even a programmatic form edit cannot mutate the frozen retry payload.
  await page.evaluate(()=>{document.querySelector('[name=cloud-path]').value='incoming/accidental.zip';});
  await page.locator('#cloud-import-retry').click();await waitIdle();
  const retryCalls=await page.evaluate(key=>calls.filter(c=>c.operation==='cloud.import.start'&&c.args.key===key),pending);
  assert.equal(retryCalls.length,2);assert.deepEqual(retryCalls[1].args,retryCalls[0].args);assert.equal(retryCalls[1].args.path,'incoming/direct.zip');
  assert.equal(await page.locator('#cloud-import-pending').isVisible(),false);assert.equal(await link.isEnabled(),true);
  assert.equal(await page.evaluate(()=>Object.values(localStorage).join('').includes('signature')),false);

  // Refresh can reconcile the saved ID without submitting again.
  await path.fill('incoming/refresh.zip');await page.evaluate(()=>{loseNext=true;});await page.locator('#cloud-import-form [type=submit]').click();await waitIdle();
  const beforeRefresh=await page.evaluate(()=>calls.filter(c=>c.operation==='cloud.import.start').length);
  await refresh();assert.equal(await page.locator('#cloud-import-pending').isVisible(),false);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='cloud.import.start').length),beforeRefresh);

  // Link renewal targets the same operation, and typed replacement survives a refresh.
  await page.evaluate(key=>{const row=rows.get('alice:node-a').find(r=>r.operationId===key);row.state='PAUSED';row.canResume=true;row.error='下载链接已过期';},pending);await refresh();
  const replace=page.locator('[data-import-replace="'+pending+'"]');
  await page.locator('[data-import-replace-panel="'+pending+'"] summary').click();await replace.locator('input').fill('https://cdn.example.test/data.zip?signature=renewed');await refresh();
  assert.equal(await replace.locator('input').inputValue(),'https://cdn.example.test/data.zip?signature=renewed');
  await replace.locator('button').click();await waitIdle();
  assert.deepEqual(await page.evaluate(()=>calls.findLast(c=>c.operation==='cloud.import.resume').args),{machine:'node-a',operationId:pending,url:'https://cdn.example.test/data.zip?signature=renewed'});

  // Cancellation is asynchronous, leaves partial data and cannot be discarded yet.
  await page.locator('[data-import-cancel="'+pending+'"]').click();await waitIdle();
  assert.ok(dialogs.some(text=>/临时文件会保留/.test(text)));assert.match(await page.locator('#cloud-import-list').textContent(),/正在取消/);
  assert.equal(await page.locator('[data-import-discard="'+pending+'"], [data-import-resume="'+pending+'"]').count(),0);
  await page.evaluate(key=>{const row=rows.get('alice:node-a').find(r=>r.operationId===key);row.state='CANCELED';row.canResume=true;},pending);await refresh();
  await page.locator('[data-import-discard="'+pending+'"]').click();await waitIdle();
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='cloud.import.discard').length),0);assert.match(await page.locator('#cloud-import-status').textContent(),/尚未确认停止/);
  await page.evaluate(()=>{allowDiscard=true;});await page.locator('[data-import-discard="'+pending+'"]').click();await waitIdle();
  assert.ok(dialogs.some(text=>/临时文件/.test(text)&&/文件不会删除/.test(text)));assert.equal(await page.locator('[data-import-discard="'+pending+'"]').count(),0);

  // An old response cannot paint or dispatch through a newly selected machine.
  await path.fill('incoming/held.zip');await page.evaluate(()=>{holdNext=true;});await page.locator('#cloud-import-form [type=submit]').click();await page.waitForFunction(()=>typeof releaseStart==='function');
  const heldKey=await page.locator('#cloud-import-pending-key').textContent(),beforeSwitch=await page.evaluate(()=>calls.length);
  await page.locator('[name=dataset-machine]').selectOption('node-b');await page.evaluate(()=>releaseStart());await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>calls.length),beforeSwitch);assert.equal(await page.locator('#cloud-import-pending').isVisible(),false);
  await page.locator('[name=dataset-machine]').selectOption('node-a');assert.equal(await page.locator('#cloud-import-pending-key').textContent(),heldKey);
  await refresh();assert.equal(await page.locator('#cloud-import-pending').isVisible(),false);

  // Two sources, long IDs and renewal form fit narrow layouts.
  await page.evaluate(()=>{for(const row of rows.get('alice:node-a')){row.state='PAUSED';row.canResume=true;}});await refresh();
  await page.screenshot({path:screenshots+'/cloud-import-desktop.png',fullPage:true});
  for(const width of [390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'cloud UI must fit '+width+'px');await page.screenshot({path:screenshots+'/cloud-import-'+width+'.png',fullPage:true});}
  // Authentication reset drops private link drafts and pending requests.
  await page.evaluate(()=>{store.principal={userId:'bob',role:'member'};store.authGeneration++;ui.reset();render();});
  assert.equal(await link.inputValue(),'');assert.equal(await page.locator('#cloud-import-list li').count(),0);await refresh();assert.equal(await page.locator('#cloud-import-list').textContent(),'暂无导入任务。');
  await page.evaluate(()=>{store.principal={userId:'admin',role:'admin'};store.authGeneration++;ui.reset();render();});
  await page.locator('#cloud-admin summary').click();await page.waitForFunction(()=>document.querySelector('#cloud-auth-status').textContent.includes('已登录'));await waitIdle();await page.locator('#cloud-auth-begin').click();await waitIdle();await page.locator('#cloud-auth-check').click();await waitIdle();assert.match(await page.locator('#cloud-auth-status').textContent(),/已登录，分享导入已核验/);
  await page.locator('#cloud-auth-disconnect').click();await waitIdle();assert.match(await page.locator('#cloud-auth-status').textContent(),/已断开/);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log('CLOUD IMPORT UI MOCK PASS: share selection; exact-key retries and refresh reconciliation; short-link replacement; async cancel; stopped-worker cleanup guard; account/machine fences; 320/390/1280px. Mock provider/nodes only, not real cloud acceptance. Screenshots: '+screenshots);
}finally{await browser.close();}

// Keep cloud-file contracts in this existing CI entrypoint.
await import('./cloud-files-ui-smoke.mjs');

// Share capability contracts reuse this existing CI entrypoint.
await import('./cloud-import-capability-ui-smoke.mjs');
await import('./dataset-remove-ui-smoke.mjs');
await import('./dataset-full-delete-ui-smoke.mjs');
