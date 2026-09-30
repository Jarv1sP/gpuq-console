// True Portal/SQLite/cookie/browser, fake host commands. No SSH/root/GPU calls.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-browser-')),password='Maintenance-Browser-Only-2026!';
const calls=[],receipts=new Map(),errors=[],external=[];let server,service,browser;
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port;
try{
  const bootstrap=join(dir,'bootstrap'),status=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge:async(machine,operation,args)=>{
    calls.push({machine,operation,args});const id=args.key||args.id;
    if(operation==='host.exec')receipts.set(id,{id,state:'SUCCEEDED',stdout:'fixture result\n',stderr:'',exitCode:0});
    assert.ok(receipts.has(id),'No implicit submission during status');return receipts.get(id);
  }}));clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'browser-member',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
  async function login(username){await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=maintenance]').waitFor({state:'visible'});await page.locator('[data-nav=maintenance]').click();await page.locator('#maintenance-create').waitFor();}
  const requestTitle='<img src=x onerror=alert(1)> 系统库检查\u202e';
  const reviewedScript='printf "fixture only\\n"\n# direction \u202e\u0085\t';
  async function create(title){await page.locator('#maintenance-create [name=maintenance-machine]').selectOption('gpu-1');await page.locator('#maintenance-create [name=maintenance-title]').fill(title);await page.locator('#maintenance-create [name=maintenance-reason]').fill('缺少依赖，需要管理员检查\u2066');await page.locator('#maintenance-create [name=maintenance-script]').fill(reviewedScript);const response=page.waitForResponse(r=>r.request().postDataJSON()?.operation==='maintenance.create');await page.locator('#maintenance-create [type=submit]').click();assert.equal((await response).status(),200);await page.waitForFunction(()=>document.querySelector('#maintenance-create [type=submit]').disabled===false);}
  await login(member.username);await create(requestTitle);assert.equal(calls.length,0);assert.equal(await page.locator('[data-maintenance=approve]').count(),0);assert.equal(await page.locator('#maintenance-detail img').count(),0);
  const displayed=await page.locator('#maintenance-detail').textContent();assert.ok(displayed.includes('\\u{202e}'));assert.ok(displayed.includes('\\u{2066}'));assert.ok(displayed.includes('\\u{0085}'));assert.doesNotMatch(displayed,/[\u202e\u2066\u0085]/u);
  const first=service.db.prepare('SELECT id FROM maintenance_requests ORDER BY seq LIMIT 1').get().id;
  await page.locator('#maintenance-create [name=maintenance-reason]').fill('draft survives refresh');await page.locator('#refresh-state').click();assert.equal(await page.locator('#maintenance-create [name=maintenance-reason]').inputValue(),'draft survives refresh');
  await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor({state:'visible'});
  await login('admin');await page.locator('[data-id="'+first+'"]').click();await page.locator('[data-maintenance=return]').waitFor();
  page.once('dialog',dialog=>dialog.accept('请补充具体库名'));const returned=page.waitForResponse(r=>r.request().postDataJSON()?.operation==='maintenance.return');await page.locator('[data-maintenance=return]').click();assert.equal((await returned).status(),200);await page.waitForFunction(()=>document.querySelector('#maintenance-detail').textContent.includes('请补充具体库名'));assert.equal(calls.length,0);
  await page.locator('#switch-account').click();await login(member.username);await page.locator('[data-id="'+first+'"]').click();await page.waitForFunction(()=>document.querySelector('#maintenance-detail').textContent.includes('请补充具体库名'));
  await create('已补充的系统库检查');const second=service.db.prepare('SELECT id FROM maintenance_requests ORDER BY seq DESC LIMIT 1').get().id;
  await page.locator('#switch-account').click();await login('admin');await page.locator('[data-id="'+second+'"]').click();await page.locator('[data-maintenance=preview]').waitFor();
  assert.equal(await page.locator('[data-maintenance=approve]').isDisabled(),true);await page.locator('[data-maintenance=preview]').click();await page.waitForFunction(()=>document.querySelector('[data-maintenance=approve]')?.disabled===false);
  assert.match(await page.locator('#maintenance-impact').textContent(),/占用信息完整/);page.once('dialog',dialog=>dialog.accept());
  const approved=page.waitForResponse(r=>r.request().postDataJSON()?.operation==='maintenance.approve');await page.locator('[data-maintenance=approve]').click();assert.equal((await approved).status(),200);await page.waitForFunction(()=>document.querySelector('#maintenance-detail').textContent.includes('fixture result'));
  assert.equal(calls.filter(c=>c.operation==='host.exec').length,1);assert.equal(calls[0].args.userId,'builtin-admin');
  assert.equal(calls[0].args.argv[4],reviewedScript,'the displayed code points remain bound to the unchanged frozen script');
  await page.locator('#switch-account').click();await login(member.username);await page.locator('[data-id="'+second+'"]').click();await page.waitForFunction(()=>document.querySelector('#maintenance-detail').textContent.includes('fixture result'));
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile page must not overflow');
  await mkdir('/tmp/gpuq-maintenance-ui',{recursive:true});await page.screenshot({path:'/tmp/gpuq-maintenance-ui/member-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('Maintenance browser passed: create, draft retention, XSS text, return reason, approval, result, identity switch and mobile layout.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));else service?.close();await rm(dir,{recursive:true,force:true});}
