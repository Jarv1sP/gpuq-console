// Real disposable Portal + SQLite + browser assets; synthetic busy nodes only.
// No production data, SSH, GPUs, routes or member quota mutations outside fixture.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {openSubmit,closeSubmit} from './starbase-workflows.mjs';

const dir=await mkdtemp(join(tmpdir(),'admin-quota-browser-')),bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');
const machine=MACHINES[0],capacity=MACHINES.reduce((sum,row)=>sum+row.cards,0),password='Admin-Quota-Browser-Fixture-2026!';
const shots=process.env.UI_SCREENSHOTS||join(dir,'shots'),errors=[],outside=[],calls=[];
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const origin='http://127.0.0.1:'+port;let server,service,browser;
try{
  await mkdir(shots,{recursive:true});await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(row=>({id:row.id,reachable:true,
    gpus:Array.from({length:row.cards},(_,index)=>({index,memoryTotalMiB:32768,memoryUsedMiB:4096,processesAvailable:true,processes:[{pid:1000+index,memoryUsedMiB:4096}]})),
    gpuq:{connected:true,health:'ok',observeOnly:false,jobs:[],capabilities:['priority-policy-v1','console-yield-v1','console-elastic-v1','console-placement-v1','console-sharing-v1']}}))}));
  const bridge=async(target,operation,args)=>{calls.push({target,operation,args:structuredClone(args)});if(operation==='projects.list')return {projects:[]};if(operation==='sync')return {state:'PENDING',nodeJobId:'Jfixture-'+args.job.id,assignedIndices:[],queueReason:'waiting for available GPU'};throw Error('Unexpected fixture bridge operation: '+operation);};
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,statusPath,bridge}));clearInterval(service.executionTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'quota-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[machine.id]:1}});
  const queued=userId=>{const id=randomUUID();return {id,userId,username:userId==='builtin-admin'?'admin':member.username,machine:machine.id,cards:1,state:'PENDING',name:'queued-fixture',priority:'normal',createdAt:Date.now()/1000,spec:{id,argv:['true']}};};
  service.store.jobs.push(...Array.from({length:capacity+1},()=>queued('builtin-admin')),queued(member.id));service.save();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const role of ['admin','member']){
    const context=await browser.newContext({viewport:{width:1440,height:1080}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();outside.push(route.request().url());return route.abort();});
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(role==='admin'?'admin':member.username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    await page.locator('[name=workspace-machine]').selectOption(machine.id);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
    const exempt=role==='admin',demand=capacity+1;
    if(exempt){assert.match(await page.locator('#self-summary').innerText(),/不限个人额度/);assert.doesNotMatch(await page.locator('#self-summary').innerText(),new RegExp(demand+' / '+capacity));assert.equal(await page.locator('#self-summary .wb-quota-segments').count(),0);assert.match(await page.locator('#quota-ledger').innerText(),/不限个人额度 · 资源不足正常排队/);assert.doesNotMatch(await page.locator('#quota-ledger').innerText(),new RegExp(demand+' /'));}
    else{assert.match(await page.locator('#self-summary').innerText(),/1 \/ 1/);assert.match(await page.locator('#quota-ledger').innerText(),/1 \/ 1/);assert.doesNotMatch(await page.locator('#quota-ledger').innerText(),/不限个人额度/);}
    await openSubmit(page);assert.equal(await page.locator('[name=cards]').getAttribute('max'),String(machine.cards),'single request is bounded by hardware, never remaining personal quota');
    await page.locator('[name=cards]').fill(String(exempt?machine.cards:1));assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),false,'queued demand does not impose a client-only submission fence');
    const preflight=await page.locator('#submit-check-list').innerText();assert.equal(preflight.includes('不限个人额度'),exempt);
    await closeSubmit(page);await page.keyboard.press('Control+k');await page.locator('#mission-control').waitFor({state:'visible'});
    const meter=await page.locator('.mc-overview .mc-meter').first().innerText();assert.equal(meter.includes('不限个人额度'),exempt);if(exempt)assert.doesNotMatch(meter,/\//);else assert.match(meter,/1 \/ 1/);
    if(exempt)assert.match(await page.locator('#control-servers').innerText(),new RegExp('单次最多 '+machine.cards+' 张'));
    await page.keyboard.press('Escape');await page.locator('#mission-control').waitFor({state:'hidden'});await page.setViewportSize({width:390,height:844});await page.locator('[data-nav=me]').click();
    const me=await page.locator('#me-content .me-telemetry').innerText();assert.equal(me.includes('不限个人额度'),exempt);if(exempt)assert.doesNotMatch(me,/\//);else assert.match(me,/1 \/ 1/);
    for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1080});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,role+'-'+width+'.png'),fullPage:true});}
    await context.close();
  }
  assert.deepEqual(calls.filter(row=>row.operation!=='projects.list'),[],'readout verification does not submit or re-dispatch any fixture job');assert.deepEqual(outside,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',checks:['admin queued demand exceeds physical inventory without personal ceiling','work summary + ledger + submit preflight + control + account agree','member 1/1 unchanged','single request max remains physical cards','neither queued demand nor inventory total disables submit','1440/390 layout','no job dispatch or outside requests'],screenshots:shots}));
}finally{await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));if(service&&!service.closing)await service.close();await rm(dir,{recursive:true,force:true});}
