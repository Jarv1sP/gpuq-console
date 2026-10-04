// Invoked by transfers-http-ui-smoke; loopback only. Partial lists and late
// account replies must not become false totals in the shared control strip.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const shots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-transfers-ui';
const errors=[],external=[];
const fixture=`
import {transfersUI} from '/transfers-ui.js';
const hooks=[];
let held,hold=false;
const rows=[
 {id:'running',name:'confirmed-copy',kind:'copy',state:'RUNNING',from:'gpu-1',machine:'gpu-2',result:{bytes:1024,totalBytes:4096},lastConfirmedRoute:'node-lan'},
 {id:'unknown',name:'needs-confirmation',kind:'upload',state:'UNKNOWN',machine:'gpu-1'},
 {id:'canceled',name:'stopped-copy',kind:'copy',state:'CANCELED',from:'gpu-1',machine:'gpu-2'},
 {id:'future',name:'unrecognized-state',kind:'upload',state:'FUTURE_STATE',machine:'gpu-1'}
];
const store={production:true,authGeneration:1,principal:{userId:'alice',role:'member'},data:{machines:[{id:'gpu-1'},{id:'gpu-2'}],transfers:{version:1}},
 onAuthChange(fn){hooks.push(fn)},
 async call(operation,args){
  if(operation!=='transfers.list')throw Error('Unexpected mutation '+operation);
  const userId=this.principal.userId;
  if(hold&&userId==='alice'){hold=false;return new Promise(resolve=>{held=()=>resolve({transfers:rows,nextCursor:null})})}
  return userId==='bob'?{transfers:[{id:'bob-only',name:'new-account-transfer',kind:'copy',state:'PAUSED',machine:'gpu-2'}],nextCursor:null}:args.cursor?{transfers:rows.slice(2),nextCursor:null}:{transfers:rows.slice(0,2),nextCursor:2};
 }};
window.snapshots=[];
document.addEventListener('gpuq-data-activities',event=>window.snapshots.push(event.detail));
const render=transfersUI(store,message=>{throw Error(message)});
window.testState={hold(){hold=true},release(){held()},switchAccount(){store.principal={userId:'bob',role:'member'};store.authGeneration++;hooks.forEach(fn=>fn());render(false)},render};
render(true);
`;
let server,browser;
try{
 await mkdir(shots,{recursive:true});
 server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:"});return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>STARBASE transfer fixture</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/datasets.css"><body><main><h1>传输与导入</h1><section id="page-transfers"></section></main><script type="module" src="/fixture.js"></script></body></html>')}
  if(path==='/fixture.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(fixture)}
  if(!/^\/(?:[a-z-]+\.(?:js|css)|vendor\/fonts\/[A-Za-z-]+\.woff2)$/.test(path)){res.writeHead(404);return res.end()}
  try{const data=await readFile(new URL('../dist'+path,import.meta.url));res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'font/woff2'});res.end(data)}catch{res.writeHead(404);res.end()}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort()});
 await page.goto(origin);
 await page.locator('#transfer-list article').first().waitFor();
 let snapshot=await page.evaluate(()=>window.snapshots.at(-1));
 assert.equal(snapshot.userId,'alice');assert.equal(snapshot.complete,false);assert.equal(snapshot.items.length,2);
 assert.match(await page.locator('#transfer-status').textContent(),/部分记录/);
 assert.deepEqual(await page.locator('[data-transfer-group]').evaluateAll(nodes=>nodes.map(node=>node.dataset.transferGroup)),['attention','active']);
 assert.equal(await page.locator('#transfer-copy').evaluate(node=>node.open),false);
 await page.locator('#transfer-more').click();
 await page.locator('#transfer-list article').filter({hasText:'stopped-copy'}).waitFor();
 snapshot=await page.evaluate(()=>window.snapshots.at(-1));
 assert.equal(snapshot.complete,true);assert.deepEqual(snapshot.items.map(item=>item.id),['running','unknown','canceled','future']);
 assert.equal(await page.locator('#transfer-list article').count(),4);
 assert.deepEqual(await page.locator('[data-transfer-group]').evaluateAll(nodes=>nodes.map(node=>node.dataset.transferGroup)),['attention','active','done']);
 assert.equal(await page.locator('[data-transfer-group=attention] article').count(),2);
 assert.equal(await page.locator('[data-transfer-group=done] [data-transfer-action=cancel]').count(),0);
 assert.equal(await page.locator('[data-transfer-group=attention] progress').count(),0,'Unknown state and size cannot invent a meter');
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:width<760?844:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'No page overflow at '+width);
  await page.screenshot({path:join(shots,'transfers-groups-'+width+'.png'),fullPage:true});
 }
 await page.locator('#transfer-copy > summary').focus();await page.keyboard.press('Enter');
 await page.locator('#transfer-copy-form').waitFor();
 assert.equal(await page.locator('#transfer-copy-form :is(input,select)').evaluateAll(nodes=>nodes.every(node=>parseFloat(getComputedStyle(node).fontSize)>=16)),true);
 await page.evaluate(()=>window.testState.hold());
 await page.locator('#transfer-refresh').click();
 await page.evaluate(()=>window.testState.switchAccount());
 snapshot=await page.evaluate(()=>window.snapshots.at(-1));
 assert.equal(snapshot.userId,'bob');assert.equal(snapshot.complete,false);assert.deepEqual(snapshot.items,[]);
 assert.equal(await page.locator('#transfer-list article').count(),0);
 await page.evaluate(()=>window.testState.render(true));
 await page.locator('#transfer-list article').filter({hasText:'new-account-transfer'}).waitFor();
 await page.evaluate(()=>window.testState.release());
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 snapshot=await page.evaluate(()=>window.snapshots.at(-1));
 assert.equal(snapshot.userId,'bob');assert.equal(snapshot.complete,true);assert.deepEqual(snapshot.items.map(item=>item.id),['bob-only']);
 assert.doesNotMatch(await page.locator('#transfer-list').textContent(),/confirmed-copy|needs-confirmation|stopped-copy/);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('TRANSFERS UI PASS: confirmed records only, partial lists never become totals, all pagination records retained and attention first, unknown/future states require confirmation, canceled is terminal, late old-account list cannot repaint or emit into the new account, 1440/390/320 layouts, keyboard copy disclosure, production CSP and local fonts without browser errors.');
}finally{
 await browser?.close();
 if(server)await new Promise(resolve=>server.close(resolve));
}
