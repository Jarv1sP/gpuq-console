// Full frontend with offline authenticated replies. No real cloud account,
// Portal login, provider probe, download, server or production write is used.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';

const origin='https://offline-cloud-capability.test';
const screenshots=join(process.env.UI_SCREENSHOTS||'/tmp/gpuq-cloud-capability-ui','share-capability');
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):MACHINES;
const errors=[],unexpected=[],checks=[],checkedAt=new Date().toISOString();
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  await mkdir(screenshots,{recursive:true});
  for(const role of ['member','admin']){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
    const principal={userId:'local-'+role,username:'local-'+role,role},calls=[];
    const state={machines,executionEnabled:true,users:[{id:principal.userId,username:principal.username,name:'本地验收',role,enabled:true,total:8,limits:Object.fromEntries(machines.map(m=>[m.id,m.cards]))}],jobs:[],gpuq:{checkedAt,stale:false,hosts:[]}};
    let info={backend:'aliyun',aliyunConnected:true,nodeDirect:true,capabilityVerified:false},denyInfo=false;
    page.on('pageerror',e=>errors.push(e.message));
    const reply=(route,result)=>route.fulfill({contentType:'application/json',body:JSON.stringify({result,state,principal})});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
      if(url.pathname==='/api/call'){
        const {operation,args}=route.request().postDataJSON();calls.push({operation,args:structuredClone(args)});
        if(operation==='state')return reply(route,null);
        if(operation==='projects.list')return reply(route,{projects:[]});
        if(operation==='datasets.overview'){assert.deepEqual(args,{});return reply(route,{protocol:0});}
        if(operation==='datasets.catalog')return reply(route,{machine:args.machine,checkedAt,machines:machines.map(m=>({machine:m.id,state:'ok'})),datasets:[]});
        if(operation==='datasets.list')return reply(route,{datasets:[]});
        if(operation==='datasets.storage.status'){assert.equal(role,'admin');return reply(route,{enabled:false});}
        if(operation==='datasets.storage.plan'){assert.equal(role,'admin');return reply(route,{enabled:false,dryRun:true,candidates:[]});}
        if(operation==='datasets.capacity')return reply(route,{machine:args.machine,available:true,filesystemBytes:1024**4,availableBytes:512*1024**3,usableBytes:502*1024**3,reserveBytes:10*1024**3});
        if(operation==='datasets.upload.routes')return reply(route,{machine:args.machine,available:false,protocol:'dataset-upload-v1'});
        if(operation==='cloud.info')return denyInfo?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'后台状态暂时无法查询。'})}):reply(route,info);
        if(operation==='cloud.import.list')return reply(route,{imports:[]});
        if(operation==='cloud.inspect')return reply(route,{inspectionId:'local-inspection',files:[{id:'local-file',name:'training-data.zip',size:4*1024**2}]});
        if(operation==='cloud.auth.begin')return reply(route,{id:'local-qr',image:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3C/svg%3E'});
        if(operation==='cloud.auth.poll')return reply(route,{state:'CONFIRMED'});
        if(operation==='cloud.auth.disconnect')return reply(route,{disconnected:true});
        throw Error('unexpected API operation '+operation);
      }
      if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(machines)+';'});
      const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!/^(index\.html|[a-z-]+\.(js|css))$/.test(file)&&!Object.hasOwn(STARBASE_ASSETS,url.pathname)){if(file==='favicon.ico')return route.fulfill({status:204});unexpected.push(url.href);return route.abort();}
      let body=await readFile(new URL('../dist/'+file,import.meta.url));
      if(file==='index.html')body=body.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;globalThis.GPUQ_HAS_SESSION=true;');
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html',body});
    });
    await page.goto(origin);await page.locator('#execution-workspace').waitFor();
    await page.locator('[data-nav=datasets]').click();await page.locator('#datasets-refresh').click();await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
    await page.locator('#warehouse-page-actions [data-v3-upload]').click();await page.locator('[data-v3-source=link]').click();
    const source=page.locator('#dataset-add-dialog [name=cloud-source]'),submit=page.locator('#dataset-add-dialog #cloud-import-form [type=submit]');
    const idle=()=>page.waitForFunction(()=>!document.querySelector('#cloud-import-refresh').disabled);
    assert.equal(await source.inputValue(),'https');assert.equal(calls.some(c=>c.operation==='cloud.info'),false,'opening HTTPS does not probe share capability');
    assert.equal(await page.locator('#page-datasets #cloud-auth-begin').count(),0,'main import flow is identical for members and administrators');
    await source.selectOption('aliyun');await page.waitForFunction(()=>document.querySelector('#cloud-share-availability').hidden===false);await idle();
    assert.equal(await submit.isDisabled(),true);assert.equal(await page.locator('#cloud-share-fields').isHidden(),true);
    assert.equal(calls.filter(c=>c.operation==='cloud.info').length,1);
    assert.equal(calls.some(c=>['cloud.inspect','cloud.import.start'].includes(c.operation)),false);
    const shot=async(name,width,root='#dataset-add-dialog')=>{
      await page.setViewportSize({width,height:1000});await page.locator(root+' .cloud-import').scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);
      await page.evaluate(()=>{document.activeElement?.blur();scrollTo({top:0,left:0,behavior:'instant'});});
      const layout=await page.evaluate(root=>{const d=document.querySelector(root);return {width:innerWidth,document:document.documentElement.scrollWidth,dialog:d.scrollWidth,client:d.clientWidth,buttons:[...d.querySelectorAll('.cloud-import .button')].filter(b=>b.getClientRects().length).map(b=>b.getBoundingClientRect().height),help:[...d.querySelectorAll('.cloud-import [data-copy-help]')].filter(b=>b.getClientRects().length).map(b=>b.getBoundingClientRect().height),skip:document.querySelector('.skip-link').getBoundingClientRect().bottom};},root);
      assert(layout.document<=width+1);assert(layout.dialog<=layout.client+1);assert(layout.buttons.every(height=>height>=44),JSON.stringify(layout));assert(layout.help.every(height=>height>=(width<760?44:32)));assert(layout.skip<=0);checks.push({role,name,...layout});
      await page.screenshot({path:join(screenshots,name+'-'+role+'-'+width+'.png')});
    };
    for(const width of [1440,390,320])await shot('share-unavailable',width);
    await source.selectOption('https');await idle();assert.equal(await submit.isEnabled(),true);assert.equal(calls.filter(c=>c.operation==='cloud.info').length,1);
    await source.selectOption('aliyun');await idle();assert.equal(calls.filter(c=>c.operation==='cloud.info').length,1,'a cached refusal is not automatically retried');
    // Missing/malformed info and read failures must also close the write gate.
    for(const value of [null,{}, {aliyunConnected:true,nodeDirect:true}]){info=value;await page.locator('#cloud-share-refresh').click();await idle();assert.equal(await submit.isDisabled(),true);}
    denyInfo=true;await page.locator('#cloud-share-refresh').click();await idle();assert.equal(await submit.isDisabled(),true);assert.match(await page.locator('#cloud-import-status').textContent(),/无法查询/);denyInfo=false;
    info={backend:'aliyun',aliyunConnected:true,capabilityVerified:true};await page.locator('#cloud-share-refresh').click();await idle();
    assert.equal(await page.locator('#cloud-share-availability').isHidden(),true);assert.equal(await page.locator('#cloud-inspect').isEnabled(),true);
    await page.locator('[name=cloud-url]').fill('https://www.alipan.com/s/local-fixture');await page.locator('#cloud-inspect').click();await idle();assert.equal(calls.filter(c=>c.operation==='cloud.inspect').length,1);
    assert.equal(await page.locator('[name=cloud-file] option').textContent(),'training-data.zip · 4.0 MiB');
    if(role==='admin'){
      // The native administrator's real QR flow is preserved even when share
      // download itself is unverified; login is never treated as that proof.
      info={backend:'aliyun',aliyunConnected:true,capabilityVerified:false};
      await page.locator('#cloud-import-refresh').click();await idle();
      assert.equal(await submit.isDisabled(),true);await page.locator('[data-dataset-add-close]').click();await page.evaluate(()=>{location.hash='admin/storage';});
      const adminCloud=page.locator('.admin-data-storage .admin-storage-cloud');await adminCloud.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-storage-refresh]').disabled);
      assert.equal(await adminCloud.locator('#cloud-auth-begin').count(),1,'the original QR administration entry remains available in storage administration');
      const adminIdle=()=>page.waitForFunction(()=>!document.querySelector('.admin-data-storage #cloud-auth-begin').disabled);
      assert.equal(await adminCloud.locator('#cloud-admin').getAttribute('open'),'','connection state is visible on entry');await adminIdle();await adminCloud.locator('#cloud-auth-begin').click();await adminIdle();assert.equal(await adminCloud.locator('#cloud-auth-qr').isVisible(),true);
      await adminCloud.locator('#cloud-auth-check').click();await adminIdle();assert.equal(await adminCloud.locator('#cloud-auth-status').textContent(),'已登录，但分享导入未核验。');assert.equal(await submit.isDisabled(),true);
      await shot('native-admin-login-unverified',390,'.admin-data-storage');await page.setViewportSize({width:1440,height:1000});
      info={backend:'clouddrive',managedExternally:true,configurationEnabled:true,aliyunConnected:true,nodeDirect:true,capabilityVerified:false};
      await page.reload();await adminCloud.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-storage-refresh]').disabled);assert.equal(await adminCloud.locator('#cloud-admin').getAttribute('open'),'','connection state is visible on entry');await page.waitForFunction(()=>document.querySelector('.admin-data-storage #cloud-auth-status').textContent==='云盘已连接。');await adminIdle();assert.equal(await adminCloud.locator('#cloud-auth-begin').isHidden(),true);assert.equal(await adminCloud.locator('#cloud-auth-status').textContent(),'云盘已连接。');assert.equal(await adminCloud.locator('#cloud-auth-disconnect').isVisible(),true);
      for(const width of [1440,390])await shot('external-admin',width,'.admin-data-storage');
    }
    assert.equal(calls.some(c=>c.operation==='cloud.import.start'),false);
    assert.equal(calls.some(c=>Object.hasOwn(c.args,'userId')||Object.hasOwn(c.args,'hostAdmin')),false);
    await context.unrouteAll({behavior:'ignoreErrors'});await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await writeFile(join(screenshots,'checks.json'),JSON.stringify({result:'PASS',errors,unexpected,checks},null,2));
  console.log('CLOUD SHARE CAPABILITY UI PASS: explicit verification, no inferred capability/probe/retry, HTTPS independence, unavailable/malformed/network states, native admin QR preserved, external admin type, member/admin 1440/390/320. '+screenshots);
}finally{await browser.close();}
