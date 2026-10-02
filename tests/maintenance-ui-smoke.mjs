// Real local Portal/SQLite/cookie/browser; no host, GPU or network mutations.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
import {seedLegacy,password} from './maintenance-fixture.mjs';

const dir=await mkdtemp(join(tmpdir(),'gpuq-retired-maintenance-browser-')),calls=[],errors=[],external=[];let server,service,browser;
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
try{
  const bootstrap=join(dir,'bootstrap'),status=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge:async(machine,operation,args)=>{calls.push({machine,operation,args});throw Error('No host calls expected');}}));
  clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'browser-member',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  const legacy=seedLegacy(service,member,{title:'<img src=x onerror=alert(1)> 旧记录\u202e',script:'printf "history" #\r\u202e\u0085'});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
  async function login(username){
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('[data-nav=maintenance]').count(),0);
    await page.goto(origin+'/#maintenance');await page.locator('#maintenance-list [data-id="'+legacy.id+'"]').waitFor();
  }
  for(const username of [member.username,'admin']){
    await login(username);await page.locator('[data-id="'+legacy.id+'"]').click();await page.locator('#maintenance-detail pre').waitFor();
    assert.equal(await page.locator('#maintenance-create,[data-maintenance=approve],[data-maintenance=cancel]').count(),0);
    assert.equal(await page.locator('#maintenance-detail img').count(),0);
    const detail=await page.locator('#maintenance-detail').textContent();assert.ok(detail.includes('\\u{000d}'));assert.ok(detail.includes('\\u{202e}'));assert.ok(detail.includes('\\u{0085}'));assert.doesNotMatch(detail,/[\r\u202e\u0085]/u);
    assert.match(await page.locator('#page-maintenance').textContent(),/未执行（流程已停用）/);
    const rejected=await page.evaluate(async id=>{const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'maintenance.approve',args:{id,revision:1,previewToken:'legacy-token'}})});return response.status;},legacy.id);assert.equal(rejected,410);
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile archive must not overflow');
    await mkdir('/tmp/gpuq-maintenance-ui',{recursive:true});await page.screenshot({path:'/tmp/gpuq-maintenance-ui/retired-'+username+'-mobile.png',fullPage:true});
    await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor({state:'visible'});await page.setViewportSize({width:1440,height:1000});
  }
  assert.equal(service.db.prepare('SELECT state FROM maintenance_requests WHERE id=?').get(legacy.id).state,'PENDING');assert.deepEqual(calls,[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Retired maintenance browser passed: no nav/composer/approval, old bookmark history, escaped script, 410 for old browser calls, identity switch and mobile layout.');
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}else service?.close();await rm(dir,{recursive:true,force:true});}
