// Actual portal login + local future-protocol responses. No production account,
// real dataset, node, GPU or backend training-storage enablement is claimed.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {openSubmit} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
const folder=await mkdtemp(join(tmpdir(),'gpuq-training-storage-')),password='Training-Storage-Local-Fixture-Only!',release='a'.repeat(64),version='b'.repeat(64);
const [machine,other]=MACHINES.map(item=>item.id),calls=[],submissions=[],errors=[],outside=[],shots=process.env.TRAINING_STORAGE_SHOTS||'/tmp/gpuq-training-storage-ui';
const project={project:'vision',environmentMode:'oci',state:'READY',releases:[{release,state:'READY'}],latestReadyRelease:release};
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
let server,service,browser;
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(folder,'bootstrap'),statusPath=join(folder,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,processesAvailable:true,processes:[]})),gpuq:{connected:true,observeOnly:false,jobs:[],schedulableIndices:[0,1],capabilities:[]}}))}));
  ({server,service}=await createPortalServer({database:join(folder,'db'),bootstrap,statusPath,origin,secure:false,bridge:async(_,operation)=>{
    if(operation==='projects.list')return {environmentModes:['oci'],projects:[project]};if(operation==='projects.status')return project;throw Error('Unexpected local bridge '+operation);
  }}));clearInterval(service.executionTimer);service.reconcile=async()=>{};await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'storage-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[machine]:2,[other]:2}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const role of ['member','admin']){
    const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage(),userId=role==='member'?member.id:admin.principal.userId;
    let capability='old',submission='success',denyStatus=409;const localCalls=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',guardedRoute(async route=>{
      const request=route.request(),url=new URL(request.url());if(url.origin!==origin){outside.push(url.href);return route.abort();}
      if(url.pathname!=='/api/call')return route.fallback();const body=request.postDataJSON();calls.push(body);localCalls.push(body);
      if(body.operation==='datasets.training.capabilities'){
        assert.deepEqual(Object.keys(body.args).sort(),['dataset','machine','version']);assert.equal(body.args.machine,machine);assert.match(body.args.version,/^[a-f0-9]{64}$/);
        return route.fulfill({json:{result:{...body.args,protocol:capability==='old'?0:capability==='future'?2:1,warehouse:{available:capability!=='unavailable',reason:capability==='unavailable'?'服务器离线 <img src=x>':null}}}});
      }
      if(body.operation==='jobs.submit'){
        const args=structuredClone(body.args);submissions.push(args);assert.equal(Object.hasOwn(args,'userId'),false);assert.equal(Object.hasOwn(args,'hostAdmin'),false);
        if(submission.startsWith('denied'))return route.fulfill({status:denyStatus,json:{code:'SUBMISSION_REJECTED',error:'原错误 <img src=x>',storage:{protocol:1,reasonCode:submission==='denied-unknown'?'TRAINING_STORAGE_UNKNOWN':'TRAINING_STORAGE_INSUFFICIENT',requiredBytes:submission==='denied'?4*1024**3:null,availableBytes:submission==='denied-unknown'?null:1024**3}}});
        if(submission==='lost')return route.abort('connectionreset');
        const selected=args.machine==='auto'?other:args.machine,job={...args,id:randomUUID(),key:args.key,userId,machine:selected,state:'PREPARING_DATA',createdAt:new Date().toISOString(),...(args.machine==='auto'?{selectionSummary:{protocol:1,selectedMachine:selected,storageExcluded:[{machine,reason:'storage-insufficient'},{machine:other,reason:'storage-unverified'}]}}:{})};
        return route.fulfill({json:{result:job}});
      }
      return route.fallback();
    }));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(role==='member'?'storage-member':'admin');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    await page.locator('[name=workspace-machine]').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled);
    await page.locator('[name=workspace-project]').selectOption('vision');await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
    await openSubmit(page);await page.locator('[name=training-target]').selectOption('current');
    const controls=page.locator('.training-read-mode'),cached=page.locator('[data-dataset-read-mode=cache]'),warehouse=page.locator('[data-dataset-read-mode=warehouse]');
    assert.equal(await controls.isVisible(),false,'no selected dataset must not show new controls');
    async function selectDataset(mode,name){capability=mode;const response=page.waitForResponse(r=>r.request().postDataJSON()?.operation==='datasets.training.capabilities');await page.locator('[name=datasets]').fill(name+'@'+version);await response;await page.waitForFunction(()=>document.querySelector('.training-read-mode').getAttribute('aria-busy')==='false');}
    for(const mode of ['old','future','unavailable']){await selectDataset(mode,mode);assert.equal(await controls.isHidden(),true);assert.equal(await page.locator('.submit-cli').isVisible(),true);}
    assert.equal(await page.locator('#training-data-field .ui-info>summary').getAttribute('title'),'服务器离线 <img src=x>');assert.equal(await page.locator('#training-data-field img').count(),0);
    await selectDataset('available','sample');assert.equal(await controls.isVisible(),true);assert.equal(await cached.getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#training-data-field .ui-info').count(),1);assert.equal(await page.locator('#training-data-field .ui-info>summary').getAttribute('title'),'省缓存空间；小文件随机读取可能更慢');
    const submit=()=>page.locator('#train-form [type=submit]').click(),confirmed=()=>page.waitForFunction(()=>document.querySelector('#submission-receipt strong').textContent==='已提交');
    await submit();await confirmed();assert.equal(Object.hasOwn(submissions.at(-1),'datasetReadMode'),false,'default cache does not alter the old submission wire key');
    assert.doesNotMatch(await page.locator('#submit-command').textContent(),/--data-read/,'cache remains the default in the CLI preview');
    await page.locator('[data-receipt-new-draft]').click();await warehouse.click();assert.equal(await warehouse.getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.submit-cli').isVisible(),true,'warehouse has an equivalent supported CLI command');
    const warehouseCommand=await page.locator('#submit-command').textContent();assert.match(warehouseCommand,/--data-read warehouse -- \/bin\/bash -c/);assert.ok(warehouseCommand.includes("--data 'sample@"+version+"'"));assert.ok(warehouseCommand.includes("--release '"+release+"'"));
    for(const width of [1440,390,320]){await page.setViewportSize({width,height:width<=390?844:1100});await page.locator('#training-data-field').scrollIntoViewIfNeeded();await controls.evaluate(async root=>{await Promise.all(root.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));});assert.equal(await warehouse.getAttribute('aria-pressed'),'true');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const rects=await controls.locator('button').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,height:r.height};}));assert.equal(rects[0].top,rects[1].top);assert.ok(rects[1].left>=rects[0].right);assert.ok(rects.every(r=>r.height>=40));await page.screenshot({path:join(shots,role+'-read-mode-'+width+'.png')});}
    await submit();await confirmed();assert.equal(submissions.at(-1).datasetReadMode,'warehouse');
    await page.locator('[data-receipt-new-draft]').click();submission='lost';await page.locator('[name=name]').fill('lost-warehouse');await submit();await page.waitForFunction(()=>document.querySelector('#submit-summary').textContent==='提交结果待确认');const lost=structuredClone(submissions.at(-1));
    assert.equal(lost.datasetReadMode,'warehouse');submission='success';await page.locator('[data-receipt-retry]').click();await confirmed();assert.deepEqual(submissions.at(-1),lost,'explicit lost-reply retry retains key, machine and warehouse mode');
    await page.locator('[data-receipt-new-draft]').click();
    for(const mode of ['denied','denied-null','denied-unknown'])for(const status of [409,503]){
      submission=mode;denyStatus=status;await page.locator('[name=name]').fill(mode+'-'+status);const count=submissions.length;await submit();await page.waitForFunction(()=>document.querySelector('#submission-receipt strong').textContent==='未提交');
      assert.equal(await page.locator('[data-receipt-retry],#submission-retry').count(),0);assert.equal(submissions.length,count+1);assert.equal(submissions.at(-1).machine,machine);assert.equal(submissions.at(-1).datasetReadMode,'warehouse');
      assert.equal(await page.locator('#submit-receipt-actions .form-error').innerText(),mode==='denied'?'空间不足 · 需要 4 GiB · 可用 1 GiB':'原错误 <img src=x>');assert.equal(await page.locator('#submit-receipt-actions img').count(),0);
    }
    submission='success';await page.locator('[name=training-target]').selectOption('auto');assert.equal(await controls.isHidden(),true,'AUTO does not borrow development-machine direct-read capability');
    const autoCommand=await page.locator('#submit-command').textContent();assert.ok(autoCommand.startsWith("gpuctl use '"+machine+"'\ngpuctl run --machine auto"),'AUTO command explicitly selects the same development machine before release validation');assert.doesNotMatch(autoCommand,/--data-read/,'switching to AUTO clears the unverified warehouse choice');
    await page.locator('[name=name]').fill('automatic');await submit();await confirmed();assert.equal(Object.hasOwn(submissions.at(-1),'datasetReadMode'),false);assert.equal(submissions.at(-1).machine,'auto');
    assert.match(await page.locator('#submit-receipt-actions .training-selection').textContent(),new RegExp('自动选择.*'+other));assert.equal(await page.locator('#submit-receipt-actions .training-selection .server-id').textContent(),other);assert.equal(await page.locator('#submit-receipt-actions .training-storage-info').getAttribute('title'),machine+' 空间不足\n'+other+' 空间未核实');
    for(const width of [1440,390,320]){await page.setViewportSize({width,height:width<=390?844:1100});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,role+'-auto-receipt-'+width+'.png')});}
    assert.equal(localCalls.some(body=>['datasets.prepare','projects.create','projects.publish','files.put','terminal.open'].includes(body.operation)),false,'capability reads never prepare data, create projects or start terminals');
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);assert.equal(service.store.jobs.length,0,'future protocol remains local mock data; no actual training is dispatched');
  console.log(JSON.stringify({status:'passed',roles:['member','admin'],widths:[1440,390,320],screenshots:shots,submissions:submissions.length,checks:['strict legacy/future/unknown capability','exact machine and version queries','legacy cache key','warehouse wire field and equivalent CLI','AUTO CLI pins development machine','one label tooltip','409/503 storage refusal and null/UNKNOWN original error','no automatic retries or switching','lost receipt retains key and mode','AUTO fixed selected machine and exclusion tooltip']}));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));else service?.close();await rm(folder,{recursive:true,force:true});}
