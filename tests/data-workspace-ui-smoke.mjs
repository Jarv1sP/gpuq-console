// Offline Chromium acceptance for personal /data2 upload, publication and fences.
// Every HTTP request is fulfilled from this repository or memory.
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin='https://offline-data-workspace.test',screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-data-workspace-ui';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  await mkdir(screenshots,{recursive:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],unexpected=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/datasets.css"><main><h1>数据集</h1><section id="page-datasets"></section></main>'});
    if(['/datasets-ui.js','/data-workspace.js','/dataset-upload.js','/transfer-upload.js','/cloud-import-ui.js','/styles.css','/workspace.css','/datasets.css'].includes(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:await readFile(new URL('../dist'+url.pathname,import.meta.url),'utf8')});
    if(url.pathname==='/favicon.ico')return route.fulfill({status:204});unexpected.push(url.href);return route.abort();
  });
  await page.goto(origin);
  await page.evaluate(async()=>{
    const {datasetsUI}=await import('/datasets-ui.js');
    window.calls=[];window.toasts=[];window.gatePut=false;window.gatePublish=false;window.remote=new Map();window.published=false;
    window.store={production:true,principal:{userId:'alice',role:'member'},authGeneration:0,data:{machines:[{id:'node-a'},{id:'node-b'}]},onAuthChange(callback){this.authChanged=callback;},async call(operation,args){
      calls.push({operation,args:structuredClone(args),user:this.principal.userId});
      if(operation==='datasets.list')return {datasets:published?[{dataset:'personal-test',versions:[{version:'a'.repeat(64),state:'READY',canPrepare:false,files:1,bytes:4}]}]:[]};
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
      throw Error('Unexpected operation '+operation);
    }};
    window.render=datasetsUI(store,value=>toasts.push(value));render();
  });
  const files=page.locator('[name=data-workspace-files]');
  await files.setInputFiles([{name:'training.zip',mimeType:'application/zip',buffer:Buffer.alloc(2*1024**2+3,7)}]);
  await page.locator('#data-workspace-upload').click();
  await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent.includes('已上传 1 个文件'));
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.operation==='datasets.workspace.put').map(call=>call.args.offset)),[0,1024**2,2*1024**2]);
  assert.equal(await page.evaluate(()=>calls.some(call=>call.operation.includes('publish'))),false);
  assert.equal(await page.locator('#terminal-data-open').isEnabled(),true);
  await page.locator('.data-workspace-browser summary').click();await page.locator('#data-workspace-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#data-workspace-files-list').textContent.includes('<unsafe>.zip'));
  assert.equal(await page.locator('#data-workspace-files-list unsafe').count(),0);
  await page.locator('[data-workspace-path="prepared"]').click();await page.waitForFunction(()=>calls.some(call=>call.operation==='datasets.workspace.list'&&call.args.path==='prepared'));
  await page.locator('[name=data-workspace-publish-path]').fill('prepared');await page.locator('[name=data-workspace-name]').fill('training');await page.locator('#data-workspace-publish').click();
  await page.waitForFunction(()=>document.querySelector('#dataset-catalog').textContent.includes('本机已就绪'));
  assert.match(await page.locator('#data-workspace-status').textContent(),/已发布/);
  assert.ok(await page.locator('[data-use-dataset]').isEnabled());
  await page.screenshot({path:screenshots+'/data-workspace-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'workspace page must fit 390px');
  assert.equal(await page.locator('.data-workspace-fields').first().evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length),1);
  await page.screenshot({path:screenshots+'/data-workspace-mobile.png',fullPage:true});
  // An account switch after a durable upload reply must neither send more data
  // under the next account nor repopulate the next account's controls.
  await files.setInputFiles([{name:'late.zip',mimeType:'application/zip',buffer:Buffer.alloc(2*1024**2,5)}]);
  await page.evaluate(()=>{gatePut=true;});await page.locator('#data-workspace-upload').click();await page.waitForFunction(()=>typeof releasePut==='function');
  const before=await page.evaluate(()=>calls.length);
  await page.evaluate(()=>{store.principal={userId:'bob',role:'member'};store.authGeneration++;store.authChanged();render();releasePut();});await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>calls.length),before);assert.doesNotMatch(await page.locator('#data-workspace-status').textContent(),/late.zip/);
  assert.equal(await page.locator('[name=data-workspace-files]').evaluate(node=>node.files.length),0);
  // A server reply arriving after a machine change cannot start polling for
  // the old machine through the new selection. The remote publish is retained.
  await page.evaluate(()=>{gatePublish=true;});await page.locator('[name=data-workspace-publish-path]').fill('prepared');await page.locator('[name=data-workspace-name]').fill('second');await page.locator('#data-workspace-publish').click();await page.waitForFunction(()=>typeof releasePublish==='function');
  const beforeMachine=await page.evaluate(()=>calls.length);
  await page.evaluate(()=>{const select=document.querySelector('[name=dataset-machine]');select.value='node-b';select.dispatchEvent(new Event('change',{bubbles:true}));releasePublish();});await page.waitForTimeout(1700);
  assert.equal(await page.evaluate(count=>calls.slice(count).some(call=>call.operation==='datasets.workspace.status'),beforeMachine),false);
  assert.match(await page.locator('#data-workspace-status').textContent(),/已切换服务器/);assert.equal(await page.locator('[name=dataset-machine]').inputValue(),'node-b');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log('PERSONAL DATA UI PASS: raw bounded upload; no automatic extraction/publication; file-list escaping; publication then READY catalog; 390px layout; late account reply stops chunks; late machine reply stops polling. Screenshots: '+screenshots);
}finally{await browser.close();}
