// Personal workspace reads only: actual UI assets, no production login or writes.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const origin='https://offline-workspace-download.test',root=new URL('../dist/',import.meta.url),output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-workspace-download','workspace-download');
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):(await import('../dist/machines.js')).MACHINES;
await mkdir(output,{recursive:true});const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{for(const role of ['member','admin'])for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin,'all requests are browser-local');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/datasets.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/dataset-flow.css"><body class="sb" data-room="datasets"><main id="main-content"><section id="page-datasets"></section></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});assert(!url.pathname.includes('..'));
  return route.fulfill({body:await readFile(new URL('.'+url.pathname,root)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.goto(origin);await page.evaluate(async({role,machines})=>{
  const {dataWorkspaceHTML,dataWorkspaceUI}=await import('/data-workspace.js');const section=document.querySelector('#page-datasets');
  section.innerHTML='<label>服务器<select name="dataset-machine"></select></label>'+dataWorkspaceHTML();const select=section.querySelector('[name=dataset-machine]');for(const row of machines)select.add(new Option(row.id,row.id));
  window.calls=[];window.toasts=[];window.gateRead=false;window.gateList=false;window.denied=false;window.invalidList=false;window.savedCount=0;window.closeCount=0;window.abortCount=0;
  window.store={production:true,principal:{userId:'alice',role},authGeneration:0,data:{machines},call:async(operation,args)=>{
   calls.push({operation,args:structuredClone(args),user:store.principal?.userId});
   if(operation==='datasets.workspace.list')return {path:args.path,entries:[{name:'sample.bin',size:1024**2+3,type:'file'},{name:'很长的文件名用于手机换行检查.zip',size:4,type:'file'},{name:'socket',type:'unsupported',size:0}]};
   if(operation==='datasets.workspace.status')return {state:'EDITABLE'};
   if(operation==='datasets.list'){if(gateList)await new Promise(resolve=>window.releaseList=resolve);if(invalidList)throw Error('节点暂时离线');return {datasets:[{dataset:'empty-data',name:'空登记 <示例>',versions:[]},{dataset:'ready-data',versions:[{version:'a'.repeat(64)}]}]};}
   if(operation==='datasets.workspace.get'){
    if(denied)throw Object.assign(Error('此服务器未授权'),{status:403});if(gateRead)await new Promise(resolve=>window.releaseRead=resolve);
    const size=1024**2+3,length=Math.min(1024**2,size-args.offset);return {path:args.path,offset:args.offset,size,eof:args.offset+length===size,data:btoa('x'.repeat(length))};
   }
   throw Error('unexpected operation '+operation);
  }};
  window.view=dataWorkspaceUI(store,section,message=>toasts.push(message));view.controls();
  Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:undefined});
 },{role,machines});
 const filePanel=page.locator('.data-workspace-browser').filter({has:page.locator('#data-workspace-refresh')});await filePanel.locator(':scope > summary').click();await page.locator('#data-workspace-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('[data-workspace-download]').length===2);
 const downloadEvent=page.waitForEvent('download');await page.locator('[data-workspace-download="sample.bin"]').click();const download=await downloadEvent,body=await readFile(await download.path());assert.equal(body.length,1024**2+3);assert(body.every(byte=>byte===120));assert.equal(download.suggestedFilename(),'sample.bin');
 await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent.startsWith('已下载'));
 assert.deepEqual(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.workspace.get').map(row=>row.args)),[{machine:machines[0].id,path:'sample.bin',offset:0},{machine:machines[0].id,path:'sample.bin',offset:1024**2}]);
 await page.locator('#data-workspace-registrations > summary').click();await page.waitForFunction(()=>document.querySelector('#data-workspace-registrations-list').textContent.includes('没有登记版本'));
 assert.equal(await page.locator('#data-workspace-registrations-list li').count(),1);assert.match(await page.locator('#data-workspace-registrations-list').textContent(),/空登记 <示例>/);assert.equal(await page.locator('#data-workspace-registrations-list button').count(),0);
 assert.deepEqual(await page.evaluate(()=>calls.filter(row=>row.operation==='datasets.list').map(row=>row.args)),[{machine:machines[0].id,includeEmpty:true}]);
 const geometry=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,buttons:[...document.querySelectorAll('[data-workspace-download]')].map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height};})}));assert(geometry.scroll<=width+1,JSON.stringify(geometry));assert(geometry.buttons.every(row=>row.left>=-1&&row.right<=width+1&&row.height>=44));
 await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(output,role+'-'+width+'.png'),fullPage:true});
 if(width===1440){
  await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>({createWritable:async()=>({write:async bytes=>window.savedCount+=bytes.length,close:async()=>window.closeCount++,abort:async()=>window.abortCount++})})}));
  await page.locator('[data-workspace-download="sample.bin"]').click();await page.waitForFunction(()=>closeCount===1);assert.equal(await page.evaluate(()=>savedCount),1024**2+3);assert.equal(await page.evaluate(()=>abortCount),0);
  await page.evaluate(()=>{gateRead=true;savedCount=closeCount=abortCount=0;});await page.locator('[data-workspace-download="sample.bin"]').click();await page.waitForFunction(()=>typeof releaseRead==='function');await page.locator('#data-workspace-cancel').click();await page.evaluate(()=>releaseRead());await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent.includes('下载已停止'));
  assert.deepEqual(await page.evaluate(()=>[savedCount,closeCount,abortCount]),[0,0,1]);
  await page.evaluate(()=>{window.releaseRead=undefined;});await page.locator('[data-workspace-download="sample.bin"]').click();await page.waitForFunction(()=>typeof releaseRead==='function');const before=await page.evaluate(()=>calls.length);await page.evaluate(machine=>{view.reset();document.querySelector('[name=dataset-machine]').value=machine;view.controls();releaseRead();},machines[1].id);await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>calls.length),before);assert.equal(await page.evaluate(()=>savedCount),0);assert.equal(await page.locator('[data-workspace-download]').count(),0);
  await page.evaluate(()=>{gateRead=false;});await page.locator('#data-workspace-refresh').click();await page.waitForFunction(()=>!document.querySelector('#data-workspace-refresh').disabled);
  await page.evaluate(()=>{denied=true;});await page.locator('[data-workspace-download="sample.bin"]').click();await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent==='此服务器未授权');assert.equal(await page.evaluate(()=>closeCount),0);
  await page.evaluate(()=>{denied=false;gateList=true;window.releaseList=undefined;});await page.locator('#data-workspace-registrations-refresh').click();await page.waitForFunction(()=>typeof releaseList==='function');await page.evaluate(()=>{store.principal={userId:'bob',role:'member'};store.authGeneration++;view.reset();view.controls();releaseList();});await page.waitForTimeout(50);assert.equal(await page.locator('#data-workspace-registrations-list li').count(),0,'late Alice list cannot repaint Bob');
  await page.evaluate(()=>{gateList=false;invalidList=true;});await page.locator('#data-workspace-registrations-refresh').click();await page.waitForFunction(()=>document.querySelector('#data-workspace-registrations-list').textContent==='空登记暂未确认');assert.doesNotMatch(await page.locator('#data-workspace-registrations-list').textContent(),/没有空登记/);
 }
 assert.deepEqual(errors,[]);assert((await page.evaluate(()=>calls)).every(row=>['datasets.workspace.list','datasets.workspace.status','datasets.workspace.get','datasets.list'].includes(row.operation)),'no writes or unrelated permission probes');await page.close();
}console.log('WORKSPACE DOWNLOAD UI PASS: real binary download, direct streaming save and abort, original path/offset, zero writes, grants, account/machine fences, explicit empty registrations; member/admin 1440/390/320.');}finally{await browser.close();}
