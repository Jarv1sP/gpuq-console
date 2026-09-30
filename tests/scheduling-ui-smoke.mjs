// Synthetic loopback portal only. Never submits a real GPU job.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
const machine=MACHINES[0].id,calls=[],errors=[],principal={userId:'alice',username:'alice',role:'member'};
let capable=true,browser,server;
const state=()=>({machines:MACHINES,users:[{id:'alice',username:'alice',role:'member',enabled:true,total:4,limits:{[machine]:4}}],jobs:[],executionEnabled:true,execution:{priorityCapabilities:{[machine]:true}},gpuq:{stale:false,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,jobs:[],capabilities:capable?['console-yield-v1']:[]}}))}});
try{
  server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!/^(index\.html|[a-z-]+\.(js|css))$/.test(name)){res.writeHead(404);res.end();return;}try{let content=await readFile(new URL('../dist/'+name,import.meta.url));if(name==='index.html')content=content.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;');res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(content);}catch{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin){errors.push('external request');return route.abort();}if(url.pathname!=='/api/call')return route.continue();const request=route.request().postDataJSON();calls.push(request);const result=request.operation==='projects.list'?{projects:[]}:request.operation==='jobs.submit'?{id:'synthetic-job',state:'PENDING'}:null;return route.fulfill({contentType:'application/json',body:JSON.stringify({state:state(),principal,result})});});
  await page.goto(origin);await page.locator('#execution-workspace').waitFor();await page.locator('[name=workspace-machine]').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await page.locator('#train-form').evaluate(f=>{f.closest('details').open=true;f.querySelector('#custom-scheduling').open=true;});
  await page.locator('[name=custom-policy]').check();assert.equal(await page.locator('[name=priority]').isDisabled(),true);
  assert.equal(await page.locator('[name=queue-rank] option[value=P4]').count(),0);
  await page.locator('[name=queue-rank]').selectOption('P1');await page.locator('[name=yield-policy]').selectOption('save');await page.locator('[name=restart-policy]').selectOption('on-preempt');
  await page.locator('#train-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('checkpoint'));
  assert.equal(calls.filter(x=>x.operation==='jobs.submit').length,0);
  await page.locator('[name=checkpointable]').check();await page.locator('[name=command]').fill('python checkpoint_train.py');
  const submitted=page.waitForResponse(r=>r.url()===origin+'/api/call'&&r.request().postDataJSON()?.operation==='jobs.submit');await page.locator('#train-form [type=submit]').click();await submitted;
  assert.deepEqual(calls.find(x=>x.operation==='jobs.submit').args.scheduling,{rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true});
  assert.equal(Object.hasOwn(calls.find(x=>x.operation==='jobs.submit').args,'priority'),false);
  capable=false;await page.locator('#refresh-state').click();await page.waitForFunction(()=>document.querySelector('#custom-policy-note').textContent.includes('尚未确认'));
  assert.equal(await page.locator('[name=custom-policy]').isChecked(),true);assert.equal(await page.locator('[name=queue-rank]').inputValue(),'P1');assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',checks:['explicit consent','adapter required','canonical submit','capability loss blocks without resetting draft','390px layout','no external requests']}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
