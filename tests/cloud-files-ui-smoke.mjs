// Real frontend, synthetic authenticated API/node replies. No cloud or Portal
// account, server, credentials, or production write is used by this test.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';

const origin='https://offline-cloud-files.test';
const screenshots=process.env.UI_SCREENSHOTS?join(process.env.UI_SCREENSHOTS,'cloud-files'):'/tmp/gpuq-cloud-files-ui';
// A private local inventory can validate long IDs without changing the public
// sample inventory or committing any real asset identifiers.
const machines=process.env.UI_INVENTORY_FIXTURE?JSON.parse(await readFile(process.env.UI_INVENTORY_FIXTURE,'utf8')):MACHINES;
const checkedAt=new Date().toISOString(),release='a'.repeat(64),errors=[],external=[],checks=[];
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  await mkdir(screenshots,{recursive:true});
  for(const role of ['member','admin']){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
    const userId='local-'+role,principal={userId,username:userId,role},calls=[],rows=new Map();
    const state={machines,executionEnabled:true,users:[{id:userId,username:userId,name:'本地验收',role,enabled:true,total:8,limits:Object.fromEntries(machines.map(m=>[m.id,m.cards]))}],jobs:[],gpuq:{checkedAt,stale:false,hosts:[]}};
    let lost=null,statusFailure=null,deny=false,cloudEnabled=true,shareEnabled=false;
    let releaseInitialList;const initialList=new Promise(resolve=>{releaseInitialList=resolve;});
    page.on('pageerror',error=>errors.push(error.message));
    const reply=(route,result)=>route.fulfill({contentType:'application/json',body:JSON.stringify({result,state,principal})});
    const reject=(route,error,status=403)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({error})});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){external.push(url.href);return route.abort();}
      if(url.pathname==='/api/call'){
        const {operation,args}=route.request().postDataJSON();calls.push({operation,args:structuredClone(args)});
        if(operation==='state')return reply(route,null);
        if(operation==='projects.list')return reply(route,{projects:[]});
        if(operation==='datasets.catalog')return reply(route,{machine:args.machine,checkedAt,machines:machines.map(m=>({machine:m.id,state:'ok'})),datasets:[{dataset:'local-sample',name:'样例数据',versions:[{version:release,state:'READY',bytes:7*1024**3,files:12,canPrepare:false,canUse:true,ownerLabel:'所属用户：'+userId,locations:machines.map(m=>({machine:m.id,state:'READY',canUse:true,ownerLabel:'所属用户：'+userId}))}]}]});
        if(operation==='datasets.upload.routes')return reply(route,{available:false,protocol:'dataset-upload-v1',machine:args.machine});
    if(operation==='datasets.capacity')return reply(route,{machine:args.machine,available:true,filesystemBytes:1024**4,availableBytes:512*1024**3,usableBytes:502*1024**3,reserveBytes:10*1024**3});
        if(operation==='cloud.info')return reply(route,{capabilityVerified:shareEnabled,configurationEnabled:true,aliyunConnected:true,nodeDirect:true,managedExternally:true});
        if(operation==='cloud.import.list')return reply(route,{imports:[]});
        if(operation==='cloud.inspect')return reject(route,'分享能力尚未开放。',409);
        if(operation.startsWith('cloud.files.')){
          if(deny)return reject(route,'这台服务器未授权。');
          const records=rows.get(args.machine)||[];
          if(operation==='cloud.files.info')return reply(route,{enabled:cloudEnabled&&args.machine!==machines[1]?.id,nodeLocal:true,vpsRelay:false});
          if(operation==='cloud.files.list'){await initialList;return reply(route,{files:records,total:records.length,limit:50});}
          if(operation==='cloud.files.status'){
            if(statusFailure)return reject(route,'原操作状态暂时无法查询。',statusFailure);
            const row=records.find(row=>row.operationId===args.operationId);
            if(!row)return reject(route,'没有这条个人操作。',404);
            return reply(route,row);
          }
          if(operation==='cloud.files.upload'||operation==='cloud.files.verify'||operation==='cloud.files.download'){
            const action=operation.split('.').at(-1),old=records.find(row=>row.operationId===args.key);
            if(old)assert.deepEqual({action:old.action,path:old.path,fileId:old.fileId},{action,path:args.path,fileId:args.fileId},'retry cannot rebind a file or destination');
            if(lost==='before'){lost=null;return route.abort('failed');}
            const row=old||{operationId:args.key,action,path:args.path,fileId:args.fileId,name:'research-data.tar',state:'QUEUED',bytes:0,totalBytes:4*1024**2,sha256:'b'.repeat(64)};
            row.state='QUEUED';row.canResume=false;if(!old)records.push(row);rows.set(args.machine,records);
            if(lost==='after'){lost=null;return route.abort('failed');}
            return reply(route,row);
          }
          throw Error('unexpected cloud operation '+operation);
        }
        throw Error('unexpected API operation '+operation);
      }
      if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(machines)+';'});
      const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!/^(index\.html|[a-z-]+\.(js|css))$/.test(file)&&!Object.hasOwn(STARBASE_ASSETS,url.pathname)){if(file==='favicon.ico')return route.fulfill({status:204});external.push(url.href);return route.abort();}
      let body=await readFile(new URL('../dist/'+file,import.meta.url));
      if(file==='index.html')body=body.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;globalThis.GPUQ_HAS_SESSION=true;');
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html',body});
    });
    await page.goto(origin);await page.locator('#execution-workspace').waitFor();
    const skipBounds=()=>page.locator('.skip-link').evaluate(node=>{const rect=node.getBoundingClientRect();return {focused:document.activeElement===node,top:rect.top,bottom:rect.bottom};});
    assert((await skipBounds()).bottom<=0);await page.locator('.skip-link').focus();
    const focusedSkip=await skipBounds();assert.equal(focusedSkip.focused,true);assert(focusedSkip.top>=0&&focusedSkip.bottom>focusedSkip.top);
    await page.evaluate(()=>document.activeElement?.blur());assert((await skipBounds()).bottom<=0);
    const screenshot=async name=>{
      // Native fixed sheets fit the real viewport. fullPage resizing can
      // paint an unfocused, offscreen fixed skip link into the expanded image.
      await page.evaluate(()=>{document.activeElement?.blur();scrollTo({top:0,left:0,behavior:'instant'});});
      assert((await skipBounds()).bottom<=0);await page.screenshot({path:join(screenshots,name+'.png')});
    };
    await page.locator('[data-nav=datasets]').click();
    await page.locator('#datasets-refresh').click();await page.locator('[data-v3-select]').first().waitFor();
    await page.waitForFunction(()=>!document.querySelector('#datasets-refresh').disabled);
    assert.deepEqual(await page.locator('.v3-server-chip:not(.v3-all)').evaluateAll(nodes=>nodes.map(node=>node.dataset.v3Filter)),machines.map(m=>m.id));assert.equal(await page.locator('.dataset-matrix').count(),0);
    const openCloud=async()=>{
      await page.locator('[data-v3-upload]').first().click();await page.locator('[data-v3-source=workspace]').click();
      assert.equal(await page.locator('#cloud-files').isHidden(),true,'Public rooms do not advertise the experimental cloud entry');
      // Keep every existing cloud-operation assertion in a deliberate component
      // harness. This exposes retained code only inside the synthetic test;
      // it does not restore a public room entry or change node permissions.
      await page.locator('#cloud-files').evaluate(el=>{el.hidden=false;});
      if(!await page.locator('#cloud-files').evaluate(el=>el.open))await page.locator('#cloud-files > summary').click();
    };
    const idle=()=>page.waitForFunction(()=>!document.querySelector('#cloud-files-refresh').disabled);
    const refresh=async()=>{await page.locator('#cloud-files-refresh').click();await idle();};
    const initialRead=page.waitForRequest(request=>request.url()===origin+'/api/call'&&request.postDataJSON().operation==='cloud.files.list');
    await openCloud();await initialRead;
    // An enabled button before the asynchronous <details> toggle starts is
    // not proof that the initial read finished. Hold that read explicitly,
    // check the real busy controls, then wait for the rendered list.
    assert.equal(await page.locator('#cloud-files-refresh').isDisabled(),true);
    assert.equal(await page.locator('#cloud-files-form [type=submit]').isDisabled(),true);
    assert.equal(calls.some(c=>c.operation==='cloud.files.upload'),false);
    releaseInitialList();await page.locator('#cloud-files-list li').waitFor();await idle();
    const submitUpload=async()=>{
      const request=page.waitForRequest(request=>request.url()===origin+'/api/call'&&request.postDataJSON().operation==='cloud.files.upload');
      await page.locator('#cloud-files-form [type=submit]').click();await request;await idle();
    };
    await page.locator('[name=cloud-files-path]').fill('incoming/research-data.tar');await submitUpload();
    const upload=calls.find(c=>c.operation==='cloud.files.upload').args;
    const own=()=>rows.get(machines[0].id),uploadRow=()=>own().find(row=>row.operationId===upload.key);
    const captureState=async(name,width)=>{await page.setViewportSize({width,height:1000});await page.locator('#cloud-files').evaluate(node=>{const dialog=node.closest('dialog');dialog.scrollTop+=node.getBoundingClientRect().top-dialog.getBoundingClientRect().top-dialog.querySelector('header').getBoundingClientRect().height-16;});await screenshot(name+'-'+role+'-'+width);};
    assert.equal(await page.locator('[data-cloud-restore]').count(),0);
    for(const state of ['RUNNING','VERIFYING']){uploadRow().state=state;await refresh();assert.equal(await page.locator('[data-cloud-restore]').count(),0);}
    await captureState('cloud-verifying',1440);
    await page.locator('[data-cloud-verify]').click();await idle();
    const verify=calls.find(c=>c.operation==='cloud.files.verify').args;
    assert.equal(verify.fileId,upload.key);assert.notEqual(verify.key,upload.key);assert.equal(await page.locator('[data-cloud-restore]').count(),0);
    own().find(row=>row.operationId===verify.key).state='VERIFIED';uploadRow().state='VERIFIED';await refresh();
    assert.equal(await page.locator('[data-cloud-restore]').count(),1);
    assert.deepEqual(await page.locator('#cloud-files-list > li > .mono').allTextContents(),['4.0 MiB','4.0 MiB']);
    await captureState('cloud-verified',390);await page.setViewportSize({width:1440,height:1000});
    let prompts=0;page.on('dialog',async dialog=>{prompts++;await dialog.accept('restored/research-data.tar');});
    await page.locator('[data-cloud-restore]').click();await idle();
    const download=calls.find(c=>c.operation==='cloud.files.download').args;
    assert.equal(download.fileId,upload.key);assert.equal(download.path,'restored/research-data.tar');assert.equal(prompts,1);
    const downloadRow=own().find(row=>row.operationId===download.key);downloadRow.state='PAUSED';downloadRow.canResume=true;downloadRow.bytes=1024**2;await refresh();
    const count=calls.length;await page.locator('[data-cloud-resume]').click();await idle();
    const resume=calls.slice(count).find(c=>c.operation==='cloud.files.download');assert.deepEqual(resume.args,download);assert.equal(prompts,1);
    assert.deepEqual(calls.slice(count,count+3).map(c=>c.operation),['cloud.files.status','cloud.files.status','cloud.files.download']);
    downloadRow.state='READY';await refresh();assert.match(await page.locator('#cloud-files-list').textContent(),/已保存到数据空间/);
    // A lost accepted reply is reconciled by status without another write.
    lost='after';await page.locator('[name=cloud-files-path]').fill('incoming/accepted.tar');const before=calls.length;await submitUpload();
    const accepted=calls.slice(before).find(c=>c.operation==='cloud.files.upload');
    assert.deepEqual(calls.slice(before).map(c=>c.operation),['cloud.files.upload','cloud.files.status']);assert.equal(calls.at(-1).args.operationId,accepted.args.key);
    assert.equal(await page.locator('#cloud-files-retry').isHidden(),true);assert.match(await page.locator('#cloud-files-status').textContent(),/等待传输/);
    // No result from a lost/unaccepted write: explicit retry still queries
    // first, and never consumes a subsequently edited destination.
    lost='before';statusFailure=503;await page.locator('[name=cloud-files-path]').fill('incoming/uncertain.tar');await submitUpload();
    const uncertain=calls.findLast(c=>c.operation==='cloud.files.upload').args;
    assert.equal(await page.locator('#cloud-files-retry').isVisible(),true);await page.locator('[name=cloud-files-path]').fill('incoming/changed.tar');
    const writeCount=()=>calls.filter(c=>c.operation==='cloud.files.upload').length;
    const originalCount=writeCount();await page.locator('#cloud-files-form [type=submit]').click();await idle();assert.equal(writeCount(),originalCount);
    await page.locator('#cloud-files-retry').click();await idle();assert.equal(writeCount(),originalCount);
    statusFailure=null;await page.locator('#cloud-files-retry').click();await idle();assert.deepEqual(calls.findLast(c=>c.operation==='cloud.files.upload').args,uncertain);
    // A foreign file ID is refused by the original-ID lookup before download.
    const restore=page.locator('[data-cloud-restore]');await restore.evaluate((button,id)=>{button.dataset.cloudRestore=id;},randomUUID());
    const downloads=calls.filter(c=>c.operation==='cloud.files.download').length;await restore.click();await idle();assert.equal(calls.filter(c=>c.operation==='cloud.files.download').length,downloads);assert.equal(prompts,1);
    await refresh();
    // Capture the real sheet viewport at all requested widths. Names are provided
    // by inventory; they are never a constant in the product or this test.
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:1000});await page.locator('#cloud-files').scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);
      const layout=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,dialog:document.querySelector('#dataset-add-dialog').scrollWidth,client:document.querySelector('#dataset-add-dialog').clientWidth,buttons:[...document.querySelectorAll('#cloud-files .button')].filter(el=>el.getClientRects().length).map(el=>({height:el.getBoundingClientRect().height,text:el.textContent}))}));
      assert(layout.document<=width+1);assert(layout.dialog<=layout.client+1);assert(layout.buttons.every(b=>b.height>=44));checks.push({role,...layout});
      await screenshot('cloud-files-'+role+'-'+width);
    }
    // A selected server with disabled cloud support has no fake empty list.
    cloudEnabled=false;await refresh();assert.equal(await page.locator('#cloud-files-form').isHidden(),true);assert.equal(await page.locator('#cloud-files-list li').count(),0);assert.equal(await page.locator('#cloud-files-status').textContent(),'这台服务器未开启云端文件');
    await screenshot('cloud-files-disabled-'+role+'-320');
    // Backend rejection remains visible for zero authorization; role cannot
    // turn it into availability or a successful operation.
    deny=true;await refresh();assert.match(await page.locator('#cloud-files-status').textContent(),/未授权/);deny=false;cloudEnabled=true;
    assert.equal(calls.some(c=>Object.hasOwn(c.args,'userId')||Object.hasOwn(c.args,'hostAdmin')),false);
    await context.unrouteAll({behavior:'ignoreErrors'});await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await writeFile(join(screenshots,'checks.json'),JSON.stringify({result:'PASS',errors,external,checks},null,2));
  console.log('CLOUD FILES UI PASS: verifying gate, explicit verification, same-key/path resume, lost receipt original-ID lookup, frozen retries, foreign-file/zero-authorization refusal, disabled service, member/admin 1440/390/320. Offline fixtures only. '+screenshots);
}finally{await browser.close();}
