// Real Portal/SQLite/cookies/browser; synthetic node observations, no GPU/SSH.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {openSubmit,closeSubmit,refreshVisible} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
import {inspectOperationalGeometry} from './operational-geometry.mjs';

const root=await mkdtemp(join(tmpdir(),'personal-layout-ui-')),shots=process.env.UI_SCREENSHOTS||'/tmp/personal-layout-ui';
const password='Personal-Layout-Fixture-Only-2026!',machine=MACHINES[0].id,release='a'.repeat(64),calls=[],errors=[],outside=[];
let server,service,browser;
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
const project=name=>({project:name,environmentMode:'oci',state:'READY',latestReadyRelease:release,releases:[{release,state:'READY'}],
  ...(name==='hdd-project'?{storageLayout:'personal-storage-v1',workspaceTier:'hdd',workspaceModes:['isolated','shared']}:{})});
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(root,'bootstrap'),statusPath=join(root,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,checkedAt:new Date().toISOString(),
    gpus:Array.from({length:m.cards},(_,index)=>({index,model:m.model,memoryTotalMiB:32768,memoryUsedMiB:0,processesAvailable:true,processes:[]})),
    gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
  const bridge=async(node,operation,args)=>{
    calls.push({node,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {environmentModes:['shared','isolated','oci'],projects:['hdd-project','legacy-project'].map(project)};
    if(operation==='projects.status')return project(args.project);
    if(operation==='projects.verify')return {...project(args.project),release:args.release};
    if(operation==='files.list')return {entries:[]};
    if(operation==='sync')return {state:'PENDING',assignedIndices:[],schedulerState:'WORKSPACE_PREPARING',queueReason:'正在后台准备 HDD 工作区；尚未申请 GPU。'};
    throw Error('Unexpected fixture operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(root,'portal.sqlite'),bootstrap,statusPath,bridge,secure:false,origin}));
  clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'storage-member',password})).result;
  const zero=(await service.invoke(admin.token,'users.create',{username:'storage-zero',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:4,limits:{[machine]:Math.min(4,MACHINES[0].cards)}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const username of [member.username,'admin',zero.username]){
    const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'}),page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();outside.push(url.href);await route.abort();}));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=work]').click();
    if(username===zero.username){assert.equal(await page.locator('[name=workspace-machine] option[value="'+machine+'"]').count(),0);assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);await context.close();continue;}
    await page.locator('[name=workspace-machine]').selectOption(machine);
    await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled&&document.querySelector('[name=workspace-project] option[value="hdd-project"]'));
    await page.locator('[name=workspace-project]').selectOption('hdd-project');
    await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled&&document.querySelector('#personal-workspace-field')?.hidden===false);
    await openSubmit(page);assert.equal(await page.locator('[name=workspace-mode]').inputValue(),'isolated');
    assert.equal(await page.locator('[name=training-target] option[value=auto]').evaluate(node=>node.disabled),true);
    assert.equal(await page.locator('[name=training-target]').inputValue(),'current');
    assert.match(await page.locator('#workspace-mode-note').textContent(),/data-hdd.*data-ssd.*机械盘/);
    await page.locator('[name=workspace-mode]').selectOption('shared');await page.locator('[name=command]').fill('python train.py --output /workspace/my-folder');
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:width<760?844:1080});
      await page.locator('[name=workspace-mode]').scrollIntoViewIfNeeded();
      const result=await inspectOperationalGeometry(page,{roots:['#personal-workspace-field'],controls:'select',viewportContainment:['#work-submit']});
      assert.deepEqual(result.failures,[],JSON.stringify({username,width,result}));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.screenshot({path:join(shots,username+'-shared-'+width+'.png'),animations:'disabled'});
    }
    await page.setViewportSize({width:1440,height:1080});await refreshVisible(page);
    assert.equal(await page.locator('[name=workspace-mode]').inputValue(),'shared');assert.match(await page.locator('[name=command]').inputValue(),/my-folder/);
    const response=page.waitForResponse(r=>r.url()===origin+'/api/call'&&r.request().postDataJSON()?.operation==='jobs.submit');await page.locator('#train-form [type=submit]').click();const reply=await response;assert.equal(reply.status(),200,await reply.text());
    const job=service.store.jobs.at(-1);assert.equal(job.spec.workspaceMode,'shared');assert.equal(job.spec.project,'hdd-project');assert.equal(job.spec.release,release);
    await service.reconcile();assert.equal(job.state,'PENDING');assert.equal(job.actualCards,0);assert.equal(job.nodeJobId,undefined);assert.match(job.queueReason,/尚未申请 GPU/);
    await closeSubmit(page);await page.locator('[name=workspace-project]').selectOption('legacy-project');
    await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled&&document.querySelector('#personal-workspace-field')?.hidden===true);
    await openSubmit(page);assert.equal(await page.locator('[name=workspace-mode]').isDisabled(),true);assert.equal(await page.locator('[name=training-target] option[value=auto]').evaluate(node=>node.disabled),false);await closeSubmit(page);await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  assert.ok(calls.filter(c=>c.operation==='sync').every(c=>c.args.job.workspaceMode==='shared'));
  console.log('PASS personal storage: member/admin shared choice, isolated default, retained draft, 1440/390/320 shared geometry, immutable API spec, background no-GPU pending, legacy and zero grant unchanged. '+shots);
}finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));if(service&&!service.closing)await service.close();await rm(root,{recursive:true,force:true});}
