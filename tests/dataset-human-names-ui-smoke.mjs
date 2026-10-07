// Disposable loopback Portal + synthetic catalog only. No node or GPU calls.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {inspectGeometry} from './layout-geometry.mjs';

const dir=await mkdtemp(join(tmpdir(),'dataset-human-names-'));
const screenshots=process.env.UI_SCREENSHOTS||join(dir,'screenshots');
const password='Human-Name-Fixture-Only-2026!',version='a'.repeat(64),machine=MACHINES[0].id;
const upload='u-0123456789abcdef-ZJU-MoCap',workspace='w-fedcba9876543210-ZJU-MoCap';
const calls=[],errors=[],blocked=[];let server,service,browser,owner;
const reserve=net.createServer();
await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port,origin='http://127.0.0.1:'+port;
await new Promise(resolve=>reserve.close(resolve));
try{
  await mkdir(screenshots,{recursive:true});
  const bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(row=>({
    id:row.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,schedulableIndices:[],jobs:[]}}))}));
  const bridge=async(host,operation,args)=>{
    calls.push({host,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects:[]};
    if(operation==='transfers.capabilities')return {enabled:false,protocol:'lan-transfer-v1',sources:[]};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3,guarded:true};
    if(operation==='datasets.list')return {datasets:host===machine?[upload,workspace].map(dataset=>({dataset,
      ownerIds:[owner.id],versions:[{version,state:'READY',files:12,bytes:128*1024**2,canPrepare:false}]})):[]};
    throw Error('Unexpected synthetic node operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,statusPath,bridge}));
  clearInterval(service.executionTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password);
  owner=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:owner.id,policyVersion:0,total:1,limits:{[machine]:1}});
  await service.invoke(admin.token,'users.create',{username:'browse-only',password});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  let scenes=0;
  for(const username of ['alice','admin','browse-only']){
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.route('**/*',guardedRoute(async route=>{
      if(new URL(route.request().url()).origin===origin)return route.continue();
      blocked.push(route.request().url());await route.abort('blockedbyclient');
    }));
    await page.goto(origin);
    await page.locator('#login-form [name=username]').fill(username);
    await page.locator('#login-form [name=password]').fill(password);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#login-dialog').waitFor({state:'hidden'});
    await page.locator('[data-nav=datasets]').click();
    const first=page.locator('[data-v3-select="'+upload+'"]');
    await first.waitFor({state:'visible'});
    assert.equal(await page.locator('[data-v3-select]').count(),2,'Equal display names retain distinct immutable datasets');
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:width===1440?1000:844});
      if(await page.locator('[data-v3-back]').isVisible())await page.locator('[data-v3-back]').click();
      assert.equal(await first.locator('.v3-name b').textContent(),'ZJU-MoCap');
      assert.equal(await first.locator('.v3-id').textContent(),upload);
      assert.equal(await first.locator('.v3-owner').textContent(),'alice');
      await first.focus();await page.keyboard.press('Enter');
      const inspector=page.locator('#warehouse-inspector');
      await inspector.locator('h2').waitFor({state:'visible'});
      assert.equal(await inspector.locator('h2>span').textContent(),'ZJU-MoCap');
      assert.equal(await inspector.locator('.v3-idline code').textContent(),upload);
      assert.equal(await inspector.locator('.v3-code code').first().textContent(),'--data '+upload+'@'+version);
      assert.equal(await inspector.locator('.v3-code code').last().textContent(),'/data2/'+upload);
      assert.equal(await inspector.locator('.v3-edit').isEnabled(),username==='alice');
      assert.equal(await inspector.locator('[data-use-dataset]').isEnabled(),username==='alice');
      await inspector.locator('.v3-idline .v3-copy').click();
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),upload,'Copy remains the full training identity');
      const geometry=await inspectGeometry(page,{roots:['#page-datasets'],controls:'.v3-row,.v3-copy,.v3-back,.v3-edit',largeTargets:'.v3-row'});
      assert.deepEqual(geometry.failures,[],username+' '+width+' geometry');
      await page.screenshot({path:join(screenshots,username+'-'+width+'.png'),fullPage:true,animations:'disabled'});scenes++;
    }
    if(username==='alice'){
      await page.locator('#warehouse-inspector .v3-edit').click();
      const dialog=page.locator('.v3-label-dialog');await dialog.locator('[name=displayName]').waitFor({state:'visible'});
      await page.waitForFunction(()=>!document.querySelector('.v3-label-dialog [type=submit]').disabled);
      assert.equal(await dialog.locator('[name=displayName]').inputValue(),'ZJU-MoCap');
      await dialog.locator('[name=displayName]').fill('人体动作');await dialog.locator('[type=submit]').click();
      await dialog.waitFor({state:'hidden'});
      assert.equal(await page.locator('#warehouse-inspector h2>span').textContent(),'人体动作');
      assert.equal(await page.locator('#warehouse-inspector .v3-idline code').textContent(),upload);
    }
    await page.close();
  }
  assert.equal(service.store.jobs.length,0,'Browsing and label edits submit no GPU task');
  assert.ok(calls.every(row=>['projects.list','transfers.capabilities','datasets.capacity','datasets.list'].includes(row.operation)),'Nodes receive reads only');
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log('DATASET HUMAN NAMES UI PASS: '+scenes+' native 1440/390/320 role scenarios; readable defaults, exact copied IDs/commands, independent names, unchanged owner/use gates, keyboard and geometry.');
}finally{
  await browser?.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  await rm(dir,{recursive:true,force:true});
}
