// Disposable loopback Portal and a fixed dual-root node contract only.
// No SSH, production account, dataset bytes or GPU task is used.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
const dir=await mkdtemp(join(tmpdir(),'warehouse-logical-cache-ui-'));
const password='Warehouse-Fixture-Only-2026!',machine=MACHINES[0].id,version='a'.repeat(64),dataset='training-data',physical='private-training-cache';
const calls=[],errors=[],blocked=[];let server,service,browser,owner,prepared=false;
const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port,origin='http://127.0.0.1:'+port;await new Promise(resolve=>reserve.close(resolve));
try{
  const bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(row=>({id:row.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,schedulableIndices:[],jobs:[]}}))}));
  const status=()=>({dataset,version,state:prepared?'READY':'REGISTERED',warehouseReady:true,warehouseCanPrepare:true,canPrepare:true,
    ...(prepared?{storageReference:{dataset:physical,version}}:{})});
  const bridge=async(host,operation,args)=>{
    calls.push({host,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects:[]};
    if(operation==='transfers.capabilities')return {enabled:false,protocol:'lan-transfer-v1',sources:[]};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3,guarded:true};
    if(operation==='datasets.list')return {datasets:host!==machine?[]:[{dataset,ownerIds:[owner.id],versions:[{...status(),bytes:12,files:1}]},
      {dataset:physical,ownerIds:[owner.id],versions:[{version,state:prepared?'READY':'REGISTERED',logicalDataset:dataset}]}]};
    if(operation==='datasets.status'){assert.equal(args.userId,owner.id);assert.equal(args.hostAdmin,false);assert.deepEqual({dataset:args.dataset,version:args.version},{dataset,version});return status();}
    if(operation==='datasets.prepare'){
      assert.equal(host,machine);assert.deepEqual(args,{userId:owner.id,hostAdmin:false,dataset,version});prepared=true;return status();
    }
    throw Error('Unexpected warehouse fixture RPC '+operation);
  };
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,statusPath,bridge}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password);owner=(await service.invoke(admin.token,'users.create',{username:'warehouse-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:owner.id,policyVersion:0,total:1,limits:{[machine]:1}});
  const member=await service.login('warehouse-member',password),before=calls.length;
  for(const operation of ['datasets.status','datasets.prepare'])for(const extra of [
    {storageReference:{dataset:physical,version}},{warehouseReady:true},{root:'/private'},{namespace:'cache'}])
    await assert.rejects(service.invoke(member.token,operation,{machine,dataset,version,...extra}),error=>error.status===400);
  assert.equal(calls.length,before,'client cache/root metadata is rejected before any node call');
  service.revokeSession(member.token);
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route('**/*',guardedRoute(async route=>{
    if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());await route.abort('blockedbyclient');
  }));
  await page.goto(origin);await page.locator('#login-form [name=username]').fill('warehouse-member');
  await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();
  await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=datasets]').click();
  await page.locator('[data-v3-select="'+dataset+'"]').waitFor({state:'visible'});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    if(await page.locator('[data-v3-back]').isVisible())await page.locator('[data-v3-back]').click();
    assert.equal(await page.locator('[data-v3-select]').count(),1,'a durable physical binding does not add a second user dataset');
    assert.equal(await page.locator('[data-v3-select] .v3-flag').count(),0,'the protected HDD original is saved, not an unrecorded SSD-only dataset');
    await page.locator('[data-v3-select="'+dataset+'"]').click();
    assert.equal(await page.locator('#warehouse-inspector .v3-code code').first().textContent(),'--data '+dataset+'@'+version);
    assert.equal(await page.locator('#warehouse-inspector .v3-code code').last().textContent(),'/data2/'+dataset);
    assert.equal(await page.locator('[data-use-dataset="'+dataset+'"]').isEnabled(),true,'existing automatic data preparation stays available');
    assert.doesNotMatch(await page.locator('.v3-server.cur').textContent(),/已缓存|缓存就绪/,'HDD READY is not advertised as a prepared SSD cache');
    assert.equal(await page.locator('[data-v3-cache="'+machine+'"]').isEnabled(),true);
    assert.doesNotMatch(await page.locator('#page-datasets').textContent(),/private-training-cache|storageReference|namespace/);
    assert.equal(await page.locator('#page-datasets [name=storageRoot],#page-datasets [name=storageTier],#page-datasets [name=namespace]').count(),0);
  }
  await page.locator('[data-v3-cache="'+machine+'"]').click();
  await page.locator('[data-v3-cache="'+machine+'"]').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('.v3-server.cur .v3-server-text').textContent.includes('已缓存'));
  assert.equal(await page.locator('[data-use-dataset="'+dataset+'"]').isEnabled(),true);
  assert.equal(await page.locator('[data-v3-select]').count(),1);assert.equal(await page.locator('[data-v3-cache="'+machine+'"]').count(),0);
  assert.equal(service.store.jobs.length,0);assert.equal(calls.filter(row=>row.operation==='datasets.prepare').length,1);
  assert.equal(calls.some(row=>row.operation==='sync'||row.operation==='transfers.create'),false);
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log('WAREHOUSE LOGICAL CACHE UI PASS: 1440/390; one logical dataset, protected HDD original, no false SSD READY, automatic preparation remains available, exact local preparation, unchanged logical command/mount.');
}finally{
  await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));if(service&&!service.closing)service.close();await rm(dir,{recursive:true,force:true});
}
