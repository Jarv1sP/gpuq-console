// Focused privileged section fixture. The final room integration also runs
// through PR-K1's real route; this fixture never mounts or hides production UI.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';
import {inspectGeometry} from './layout-geometry.mjs';

const origin='https://offline-admin-storage.test',version='a'.repeat(64),out=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-admin-storage','admin-storage');
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):MACHINES;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const geometry={roots:['.admin-data-storage'],numericCells:['.dataset-volume,.storage-user-table .num'],largeTargets:'.storage-server-select',containment:'input,select,button,h3,.server-id',
  labelledHelp:[{buttons:'.admin-data-storage [data-copy-help]',rows:'.storage-policy>header,.storage-retention>header,.storage-users>header,.storage-delete-tasks>header,#cloud-admin>summary',labels:':scope>h3,:scope>h4,:scope>span:not(.copy-help)'}],
  disclosureRows:['.dataset-version-details>summary'],repeatedPadding:['.admin-storage-row']};
const records=[];
try{
  await mkdir(out,{recursive:true});
  for(const role of ['member','admin'])for(const width of [1440,1024,390,320]){
    const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),calls=[],errors=[],pins=new Set(['foreign-pin']);let losePin=false,denyPinStatus=false,cloudDisabled=true,lostReconnect=false;
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());assert.equal(url.origin,origin,'no external request');
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/dataset-flow.css"><link rel="stylesheet" href="/copy-help.css"><body class="sb" data-room="admin"><main id="main-content"><h1>数据与存储</h1><section id="storage-fixture"></section></main></html>`});
      if(url.pathname==='/api/fixture'){
        const {operation,args={}}=route.request().postDataJSON();calls.push({operation,args});
        assert.equal(role,'admin','member sends zero privileged API requests');
        const reply=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
        if(operation==='datasets.list')return reply({datasets:[{dataset:'samples',ownerLabel:'所属用户：alice',versions:[{version,state:'READY',bytes:7*1024**3,files:120}]},{dataset:'shared-data',ownerLabel:'共享授权用户：alice、bob',versions:[{version,state:'READY',bytes:2*1024**3,files:50}]},{dataset:'empty-work',ownerLabel:'所属用户：bob',versions:[]}]});
        if(operation==='datasets.catalog')return reply({machine:args.machine,datasetDelete:0,partial:false,machines:machines.map(row=>({machine:row.id,state:'ok'})),datasets:[{dataset:'samples',versions:[{version,locations:[{machine:machines[0].id,dataset:'samples',storage:{dataset:'samples',version,phase:'ARCHIVED',originalRetained:true,archiveMachine:machines.at(-1).id}}]}]}]});
        if(operation==='datasets.storage.status'){
          if(denyPinStatus&&args.pinId)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'原保留状态待确认'})});
          return reply({enabled:true,...(args.dataset?{version:{dataset:args.dataset,version:args.version,state:'READY',pinCount:pins.size,manualPinProtocol:1,...(args.pinId?{manualPin:{pinId:args.pinId,owner:'fixture-admin',present:pins.has(args.pinId)}}:{})}}:{})});
        }
        if(operation==='datasets.storage.plan')return reply({enabled:true,dryRun:true,usageBytes:900*1024**3,budgetBytes:1000*1024**3,highWater:.83,lowWater:.61,candidates:[{dataset:'shared-data',version,bytes:2*1024**3,lastUsedAt:1700000000}],protectedUnknown:[],unavailableAuthorities:[]});
        if(operation==='datasets.storage.pin'){pins.add(args.pinId);if(losePin){denyPinStatus=true;return route.abort('failed');}return reply({pinned:true,pinId:args.pinId});}
        if(operation==='datasets.storage.unpin')return reply({unpinned:pins.delete(args.pinId)});
        if(operation==='cloud.info')return reply({backend:'clouddrive',capabilityVerified:true,configurationEnabled:true,managedExternally:true,disabled:cloudDisabled,aliyunConnected:!cloudDisabled});
        if(operation==='cloud.auth.reconnect'){assert.deepEqual(args,{});cloudDisabled=false;if(lostReconnect){lostReconnect=false;return route.abort('failed');}return reply({reconnected:true,backend:'clouddrive',managedExternally:true});}
        throw Error('unexpected admin fixture operation '+operation);
      }
      assert(Object.hasOwn(STARBASE_ASSETS,url.pathname)||['/styles.css','/workspace.css','/job-progress.js','/cloud-import-ui.js','/cloud-files-ui.js','/data-workspace.js','/data-route.js','/dataset-upload.js'].includes(url.pathname),'registered local asset '+url.pathname);
      return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.woff2')?'font/woff2':'text/css',body:await readFile(new URL('../dist'+url.pathname,import.meta.url))});
    });
    await page.goto(origin);
    await page.evaluate(async({role,machines})=>{
      const {mountAdminDataStorage}=await import('/admin-data-storage.js');window.notifications=[];
      window.store={production:true,principal:{userId:'fixture-'+role,role},authGeneration:0,data:{machines},onAuthChange(){},async call(operation,args={}){const response=await fetch('/api/fixture',{method:'POST',body:JSON.stringify({operation,args})});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});return value;}};
      window.storageModule=mountAdminDataStorage(document.querySelector('#storage-fixture'),{store,toast:message=>notifications.push(message)});
    },{role,machines});
    if(role==='member'){
      assert.equal(await page.locator('#storage-fixture').textContent(),'需要管理员权限');assert.equal(calls.length,0);assert.equal(await page.locator('button,input,select').count(),0);
      await page.screenshot({path:join(out,'denied-'+width+'.png')});await context.close();continue;
    }
    await page.locator('.admin-storage-row').first().waitFor();await page.waitForFunction(()=>!document.querySelector('[data-storage-refresh]').disabled);
    assert.equal(await page.locator('.admin-storage-row').count(),2);assert.equal(await page.locator('.storage-server-card').count(),machines.length);assert.equal(await page.locator('.admin-storage-locations,[data-storage-owner]').count(),0,'operations does not repeat the browsing directory');
    assert.equal(calls.filter(row=>row.operation==='datasets.storage.status'&&!row.args.dataset).length,machines.length);assert.equal(calls.filter(row=>row.operation==='datasets.storage.plan').length,machines.length);assert(!calls.some(row=>row.operation==='datasets.storage.status'&&row.args.dataset),'closed retention sends no version query');assert(!calls.some(row=>row.operation.endsWith('.pin')||row.operation.endsWith('.unpin')),'overview is read-only');
    assert.equal(calls.filter(row=>row.operation==='cloud.info').length,1,'open connection shows only an initial read');assert(!calls.some(row=>row.operation.startsWith('cloud.auth.')),'mount never mutates a connection');
    assert.equal(await page.locator('#cloud-auth-disconnect').isHidden(),true,'disabled CloudDrive offers only reconnect and query');
    assert.equal(await page.locator('.storage-warehouse-badge').count(),1);assert.equal(await page.locator('.storage-server-card').filter({has:page.locator('.storage-warehouse-badge')}).count(),1);
    assert.equal(await page.locator('[data-admin-full-delete]').count(),0,'capability zero has no delete entry');
    assert.deepEqual(await page.locator('[name=dataset-machine] option').evaluateAll(nodes=>nodes.map(node=>node.value)),machines.map(row=>row.id));
    assert.equal(await page.locator('.storage-server-card').last().locator('.storage-warehouse-badge').textContent(),'仓库');
    assert.equal(await page.locator('.storage-user-table [role=row]').count(),3);assert.match(await page.locator('[data-storage-users]').textContent(),/alice.*2.*36.00 GiB.*bob.*1.*8.00 GiB/);assert.equal(await page.locator('[data-storage-delete-capability]').textContent(),'节点未启用彻底删除');
    const help=await page.locator('[data-copy-help]').evaluateAll(nodes=>nodes.map(node=>({border:getComputedStyle(node).borderTopWidth,radius:getComputedStyle(node).borderRadius})));assert(help.every(row=>row.border==='0px'&&row.radius==='50%'),'all help buttons retain the shared borderless circle');
    const report=await inspectGeometry(page,geometry);assert(report.pass,JSON.stringify(report.failures));records.push({role,width,report});
    await page.screenshot({path:join(out,'directory-'+width+'.png'),fullPage:true});
    await page.locator('[data-storage-select]').nth(1).click();await page.waitForFunction(()=>!document.querySelector('[data-storage-refresh]').disabled);assert.equal(await page.locator('[data-storage-machine]').textContent(),machines[1].id);assert(!calls.some(row=>row.operation==='datasets.storage.status'&&row.args.dataset));assert.equal(calls.filter(row=>row.operation==='datasets.storage.plan').length,machines.length,'server selection reuses explicit overview without polling');await page.locator('[data-storage-select]').first().click();await page.waitForFunction(()=>!document.querySelector('[data-storage-refresh]').disabled);
    const detail=page.locator('.storage-pin-row').filter({hasText:'samples'});await detail.locator('summary').click();
    await page.waitForFunction(()=>document.querySelector('[data-cache-retention=pin]')&&!document.querySelector('[data-cache-retention=pin]').disabled);
    const slot=detail.locator('[data-cache-pin-slot]');assert.match(await slot.textContent(),/已固定保留 1 处/);
    assert.deepEqual(calls.find(row=>row.operation==='datasets.storage.status'&&row.args.dataset).args,{machine:machines[0].id,dataset:'samples',version});
    await slot.locator('[data-cache-retention=pin]').click();await slot.locator('[data-cache-retention=unpin]').waitFor();
    const pin=calls.find(row=>row.operation==='datasets.storage.pin');assert.match(pin.args.pinId,/^manual-/);assert.equal(pins.size,2);
    page.on('dialog',dialog=>dialog.accept());await slot.locator('[data-cache-retention=unpin]').click();await slot.locator('[data-cache-retention=pin]').waitFor();
    assert.equal(calls.find(row=>row.operation==='datasets.storage.unpin').args.pinId,pin.args.pinId);assert(pins.has('foreign-pin'));assert.equal(pins.size,1);
    await page.locator('.dataset-cache-gauge').first().waitFor();
    assert.equal(await page.locator('.dataset-cache-number').first().textContent(),'90%900.00 GiB / 1000.00 GiB','budget percentage uses only explicit plan bytes');
    assert.match(await page.locator('.dataset-cache-preview').first().textContent(),/超过高水位时将释放（预览，不会立即删除）/);
    const writes=calls.filter(row=>row.operation.endsWith('.pin')||row.operation.endsWith('.unpin')).length;
    await page.locator('[data-storage-refresh]').click();await page.waitForFunction(()=>!document.querySelector('[data-storage-refresh]').disabled);
    assert.equal(calls.filter(row=>row.operation.endsWith('.pin')||row.operation.endsWith('.unpin')).length,writes,'refresh never creates or replays a pin');
    const policyReport=await inspectGeometry(page,geometry);assert(policyReport.pass,JSON.stringify(policyReport.failures));records.push({role,width,policyReport});
    await page.screenshot({path:join(out,'policy-'+width+'.png'),fullPage:true});
    if(width===1440){
      await page.locator('.storage-pin-row').filter({hasText:'samples'}).locator('summary').click();
      const ownSlot=page.locator('.storage-pin-row').filter({hasText:'samples'}).locator('[data-cache-pin-slot]');
      await ownSlot.locator('[data-cache-retention=pin]').waitFor();losePin=true;
      await ownSlot.locator('[data-cache-retention=pin]').click();await page.waitForFunction(()=>document.querySelector('[data-cache-pin-slot]').textContent.includes('结果未确认'));
      const uncertain=calls.filter(row=>row.operation==='datasets.storage.pin').at(-1);
      assert.equal(await ownSlot.locator('[data-cache-retention=retry]').isDisabled(),true);
      denyPinStatus=false;await ownSlot.locator('[data-cache-retention=query]').click();await ownSlot.locator('[data-cache-retention=unpin]').waitFor();
      assert.equal(calls.filter(row=>row.operation==='datasets.storage.pin').length,2,'status reconciles the original pin, never sends a replacement');
      assert.equal(calls.filter(row=>row.operation==='datasets.storage.status').at(-1).args.pinId,uncertain.args.pinId);
      assert(pins.has('foreign-pin'));
    }
    if(width===1440){await page.evaluate(()=>{store.data.users=[{id:store.principal.userId,enabled:true,limits:{}}];store.data.operationalMaintenance={version:1,global:{reason:'local maintenance'},machines:{}};});await page.locator('#cloud-auth-reconnect').click();await page.getByText('云盘已连接。',{exact:true}).waitFor();assert.equal(calls.filter(row=>row.operation==='cloud.auth.reconnect').length,1,'admin global connection is independent of server quota/maintenance');assert.equal(await page.locator('#cloud-auth-disconnect').isVisible(),true,'disconnect is available only after a confirmed connection');lostReconnect=true;await page.locator('#cloud-auth-reconnect').click();await page.getByText('重新连接结果待确认，请重新查询。',{exact:true}).waitFor();assert.equal(calls.filter(row=>row.operation==='cloud.auth.reconnect').length,2);await page.locator('#cloud-auth-info').click();await page.getByText('云盘已连接。',{exact:true}).waitFor();assert.equal(calls.filter(row=>row.operation==='cloud.auth.reconnect').length,2,'lost receipt causes only an explicit status read, never replay');const count=calls.length;await page.evaluate(()=>{store.principal={userId:'other-member',role:'member'};store.authGeneration++;document.querySelector('#cloud-auth-reconnect').disabled=false;document.querySelector('#cloud-auth-reconnect').click();});await page.waitForTimeout(50);assert.equal(calls.length,count,'role revocation prevents reconnect even after DOM tampering');}
    const before=calls.length;await page.evaluate(()=>storageModule.destroy());await page.waitForTimeout(100);assert.equal(calls.length,before,'unmount stops reads and polling');assert.equal(await page.locator('#storage-fixture>*').count(),0);
    assert.deepEqual(errors,[]);await context.close();
  }
  await writeFile(join(out,'geometry.json'),JSON.stringify(records,null,2));console.log('ADMIN STORAGE MODULE PASS: per-server operations; no duplicate directory; actual budgets and release candidates; member zero-RPC denial; policy budget truth; original-owner pin/unpin and lost-reply reconciliation; no automatic writes; teardown;1440/390/320. Registry integration is checked separately through #admin.');
}finally{await browser.close();}
