// Development contract fixture only; no production file content or permission claim.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const origin='https://files-preview.fixture.test',assets=new URL('../dist/',import.meta.url),version='a'.repeat(64);
const screenshots=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-files-preview','files-preview');await mkdir(screenshots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{for(const role of ['member','admin'])for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,origin,'no network or production reads');
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/shell.css"><body class="sb"><main style="max-width:480px;margin:32px auto;padding:16px"><h1>仓库</h1><div id="fixture"><span id="existing">sample</span></div></main>'});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});
  assert(!url.pathname.includes('..'));return route.fulfill({body:await readFile(new URL('.'+url.pathname,assets)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
 });
 await page.goto(origin);
 await page.evaluate(async({role,version})=>{
  const {mountFilesPreview}=await import('/dataset-files-preview.js');window.mountFilesPreview=mountFilesPreview;
  window.calls=[];window.mode='normal';window.callbacks=new Set();window.abort=new AbortController();window.hold=false;window.releases=[];
  window.store={production:true,principal:{userId:'alice',role},authGeneration:0,onAuthChange:callback=>{callbacks.add(callback);return()=>callbacks.delete(callback);},call:async(op,args,{signal})=>{
   calls.push({op,args,signal});if(hold)await new Promise(resolve=>releases.push(resolve));
   if(mode==='offline')throw Error('offline');if(mode==='unsupported')return {available:false,reason:'DATASET_FILES_NODE_UNAVAILABLE'};
   if(mode==='403'||mode==='404')throw Object.assign(Error('denied'),{status:Number(mode)});if(mode==='missing')throw Error('未知执行操作。');
   const file=(name,bytes=1024,path=name)=>({name,path,type:'file',bytes}),folder=(name,path=name)=>({name,path,type:'directory',bytes:null});
   return {protocol:'dataset-files-list-v1',available:true,dataset:args.dataset,version:args.version,path:args.path||'',entries:args.path==='train'?args.cursor?[file('validation.bin',1048576,'train/validation.bin')]:[folder('images','train/images'),file('labels.json',2048,'train/labels.json')]:args.path==='train/images'?[file('sample-0001.png',4096,'train/images/sample-0001.png')]:args.cursor?[file('tail.bin',0)]:[folder('train'),file('README.md',8192),file('非常长的真实文件名-a-very-long-fixed-version-dataset-manifest.json',null),file('<img onerror=alert(1)>.txt',512)],nextCursor:args.path==='train'&&!args.cursor?'opaque-child':!args.path&&!args.cursor?'opaque-root':null};
  }};
  window.host=document.querySelector('#fixture');window.ui=mountFilesPreview(host,{store,dataset:'sample',version,signal:abort.signal});
 },{role,version});
 await page.locator('[data-files-toggle="train"]').waitFor();assert.equal(await page.locator('.files-preview-row').count(),4);assert.equal(await page.evaluate(()=>calls.length),1,'only the first layer opens automatically');
 assert.equal(await page.locator('[data-files-toggle="train"] .files-preview-size').count(),0);assert.equal(await page.locator('.files-preview-size').first().textContent(),'8.0 KiB');assert.equal(await page.locator('.files-preview-size').nth(1).textContent(),'未知');assert.equal(await page.locator('.files-preview img').count(),0,'filenames are text, not executable HTML');
 await page.locator('[data-files-toggle="train"]').focus();await page.keyboard.press('Enter');await page.locator('[data-files-toggle="train/images"]').waitFor();assert.deepEqual(await page.evaluate(()=>calls[1].args),{dataset:'sample',version,path:'train'});
 await page.locator('[data-files-toggle="train/images"]').click();await page.getByText('sample-0001.png',{exact:true}).waitFor();await page.locator('[data-files-more="train"]').click();await page.getByText('validation.bin',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>calls.find(row=>row.args.cursor==='opaque-child').args),{dataset:'sample',version,path:'train',cursor:'opaque-child'});
 await page.locator('[data-files-more=""]').click();await page.getByText('tail.bin',{exact:true}).waitFor();assert.equal(await page.locator('[data-files-more]').count(),0);assert.equal(await page.locator('.files-preview-row').count(),9);
 await page.evaluate(()=>document.activeElement?.blur());
 const geometry=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,buttons:[...document.querySelectorAll('.files-preview button')].map(node=>node.getBoundingClientRect().toJSON()),rows:[...document.querySelectorAll('.files-preview-row')].map(node=>{const name=node.querySelector('.files-preview-name').getBoundingClientRect(),tail=node.lastElementChild.getBoundingClientRect();return {name:name.toJSON(),tail:tail.toJSON()};})}));
 assert(geometry.scroll<=width+1,JSON.stringify(geometry));assert(geometry.buttons.every(rect=>rect.height>=44&&rect.left>=0&&rect.right<=width+1));assert(geometry.rows.every(row=>row.name.right<=row.tail.left+1),'name never overlaps the size or folder control');
 await page.screenshot({path:join(screenshots,'tree-'+role+'-'+width+'.png'),fullPage:true});
 const count=await page.evaluate(()=>calls.length);await page.locator('[data-files-toggle="train"]').click();assert.equal(await page.getByText('sample-0001.png',{exact:true}).count(),0);await page.locator('[data-files-toggle="train"]').click();assert.equal(await page.evaluate(()=>calls.length),count,'cached folders do not rerequest');
 await page.evaluate(({version})=>{ui.destroy();mode='offline';ui=mountFilesPreview(host,{store,dataset:'sample',version});},{version});await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('alert').textContent(),'无法读取');await page.screenshot({path:join(screenshots,'offline-'+role+'-'+width+'.png'),fullPage:true});
 await page.evaluate(()=>mode='normal');await page.getByRole('button',{name:'重试',exact:true}).click();await page.locator('[data-files-toggle="train"]').waitFor();
 for(const mode of ['unsupported','403','404','missing']){
  await page.evaluate(({mode,version})=>{ui.destroy();window.mode=mode;ui=mountFilesPreview(host,{store,dataset:'sample',version});},{mode,version});
  await page.waitForFunction(()=>calls.at(-1)?.args.dataset==='sample');await page.evaluate(()=>Promise.resolve());assert.equal(await page.locator('.files-preview').count(),0,mode+' renders no empty tree or explanation');assert.equal(await page.locator('#existing').textContent(),'sample');
 }
 await page.evaluate(({version})=>{mode='normal';hold=true;ui.destroy();abort=new AbortController();ui=mountFilesPreview(host,{store,dataset:'old',version,signal:abort.signal});abort.abort();hold=false;ui=mountFilesPreview(host,{store,dataset:'new',version:'b'.repeat(64)});},{version});await page.locator('[data-files-toggle="train"]').waitFor();
 assert.equal(await page.evaluate(()=>calls.findLast(row=>row.args.dataset==='old').signal.aborted),true);await page.evaluate(()=>{for(const resolve of releases.splice(0))resolve();});
 assert.equal(await page.locator('.files-preview').count(),1);assert.equal(await page.evaluate(()=>calls.at(-1).args.dataset),'new');assert.equal(await page.evaluate(()=>calls.at(-1).args.cursor),undefined,'cursor cannot leak between datasets');
 await page.evaluate(()=>{store.principal.userId='bob';store.authGeneration++;for(const callback of [...callbacks])callback();});assert.equal(await page.locator('.files-preview').count(),0);
 assert.equal(await page.evaluate(()=>calls.some(row=>row.op!=='datasets.files.list')),false,'zero downloads or writes');assert.deepEqual(errors,[]);await page.unrouteAll({behavior:'wait'});await page.close();
}console.log('FILES PREVIEW UI PASS: lazy tree and per-directory pagination; files-only sizes; 403/404/unavailable/missing hidden; network retry; dataset abort/account fence; text-only names; 1440/390/320 member/admin geometry; zero downloads/writes.');}finally{await browser.close();}
