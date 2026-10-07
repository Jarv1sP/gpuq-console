// Actual Portal and source assets; only node observations are fixtures.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {refreshVisible} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';

const root=await mkdtemp(join(tmpdir(),'project-preparation-ui-')),shots=join(process.env.UI_SCREENSHOTS||'/tmp/project-preparation-ui','preparation');
const password='Preparation-Fixture-Only-2026!',target=MACHINES[0].id,source=MACHINES[1].id,release='a'.repeat(64);
const calls=[],errors=[],outside=[];let server,service,browser;
const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));const origin='http://127.0.0.1:'+port;
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(root,'bootstrap'),statusPath=join(root,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(machine=>({id:machine.id,reachable:true,checkedAt:new Date().toISOString(),gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {environmentModes:['shared','isolated','oci'],projects:[]};
    if(operation==='files.list')return {entries:[]};
    if(operation==='sync'){const job=service.store.jobs.find(row=>row.id===args.job.id);assert.ok(job);return {state:job.state,nodeJobId:'fixture-'+job.id,assignedIndices:[]};}
    throw Error('Unexpected project preparation operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(root,'portal.sqlite'),bootstrap,statusPath,bridge,secure:false,origin}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'preparation-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:8,limits:{[source]:Math.min(4,MACHINES[1].cards),[target]:Math.min(4,MACHINES[0].cards)}});
  const principals=[service.store.users.find(user=>user.username===member.username),service.store.users.find(user=>user.username==='admin')];
  const jobs=principals.map(user=>{const id=randomUUID();return {id,userId:user.id,username:user.username,name:'copy-personal-project',machine:target,cards:2,state:'PREPARING_DATA',createdAt:Date.now()/1000,project:'personal-project',release,assignedIndices:[],
    machineSelection:{mode:'auto'},projectPreparation:{from:source,project:'personal-project',release,state:'PREPARING',operationId:randomUUID()},spec:{id,argv:['python','train.py']}};});
  service.store.jobs.push(...jobs);service.save();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const [index,principal] of principals.entries()){
    const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'}),page=await context.newPage(),job=jobs[index];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('401'))errors.push(message.text());});
    await context.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol)){await route.continue();return;}outside.push(url.href);await route.abort();}));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(principal.username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    await page.locator('.wb-focal [data-project-preparation]').waitFor();
    assert.match(await page.locator('.wb-focal .subline').textContent(),/自动选机/);
    assert.match(await page.locator('.wb-focal .subline').textContent(),/请求 2 张/);
    assert.equal(await page.locator('.wb-focal [data-project-preparation]>.server-id').getAttribute('title'),target);
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:width<760?844:1080});await page.evaluate(()=>document.fonts.ready);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.screenshot({path:join(shots,principal.role+'-copy-'+width+'.png'),fullPage:true,animations:'disabled'});
      await page.locator('.wb-focal [data-job-mission]').click();await page.locator('#job-mission').waitFor({state:'visible'});
      assert.match(await page.locator('#job-mission [data-project-preparation]').textContent(),/复制项目到.*未占显卡/);
      assert.equal(await page.locator('#job-mission [data-project-preparation]>.server-id').getAttribute('title'),target);
      assert.equal(await page.locator('#job-mission .r5-mission-hardware').count(),0);assert.match(await page.locator('#job-mission .r5-mission-gpus').textContent(),/显卡尚未分配/);
      assert.equal(await page.locator('#job-mission').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
      await page.screenshot({path:join(shots,principal.role+'-mission-'+width+'.png'),animations:'disabled'});await page.keyboard.press('Escape');
    }
    await page.setViewportSize({width:1440,height:1080});
    for(const state of ['WAITING','READY','UNCONFIRMED','FAILED']){
      job.projectPreparation.state=state;service.save();await refreshVisible(page);
      const expected={WAITING:'复制项目到',READY:'项目已就绪',UNCONFIRMED:'项目准备待确认',FAILED:'项目复制失败'}[state];
      await page.waitForFunction(text=>document.querySelector('.wb-focal [data-project-preparation]')?.textContent.includes(text),expected);
      assert.equal(job.machine,target);assert.equal(job.projectPreparation.from,source);assert.equal(job.state,'PREPARING_DATA');
    }
    job.projectPreparation.state='READY';job.state='PENDING';service.save();await refreshVisible(page);
    await page.locator('.wb-focal [data-project-preparation]').waitFor({state:'detached'});assert.match(await page.locator('.wb-focal .subline').textContent(),/自动选机/);
    assert.equal(await page.locator('.wb-focal .subline>.server-id').getAttribute('title'),target);
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  assert.ok(calls.every(call=>['projects.list','files.list','sync'].includes(call.operation)),'viewing progress never dispatches copying, training, cancellation or deletion');
  console.log('PASS: member/admin cards and mission; project phases; actual target/source; no GPU allocation; 1440/390/320; read-only node calls; no script/CSP/external errors');
}finally{
  await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));if(service&&!service.closing){clearInterval(service.executionTimer);await service.close();}await rm(root,{recursive:true,force:true});
}
