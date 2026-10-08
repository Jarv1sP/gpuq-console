// Simulated nodes only: no real credentials, uploads, shell, or external calls.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {mockCampusFiles} from './personal-file-campus-mock.mjs';

const root=await mkdtemp(join(tmpdir(),'project-upload-capability-'));
const shots=join(process.env.UI_SCREENSHOTS||'/tmp/project-upload-capability','upload-capability');
const password='Upload-Capability-Simulated-2026!',machine=MACHINES[0].id,release='a'.repeat(64),uploadId='a1234567-1234-4234-8234-123456789abc';
const calls=[],errors=[],outside=[],info={project:'upload-project',environmentMode:'oci',state:'READY',releases:[{release,state:'READY'}],latestReadyRelease:release};
const cleanup=[];let campus;let server,service,browser,supported=true;
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(root,'bootstrap'),statusPath=join(root,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  campus=await mockCampusFiles({after:callback=>cleanup.push(callback)},async(operation,args)=>{if(operation==='files.get'){assert.equal(args.path,'train.py');return {protocol:2,path:args.path,size:4,offset:args.offset,data:Buffer.from('abcd').subarray(args.offset).toString('base64'),eof:true};}assert.equal(operation,'files.put');calls.push({machine:args.machine,operation,args:structuredClone(args)});return {path:args.path,uploadId:args.uploadId,complete:true,size:args.totalSize,sha256:args.sha256};},{allowedOrigins:[origin]});
  const bridge=async(node,operation,args)=>{
    calls.push({machine:node,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {environmentModes:['oci'],projects:node===machine?[info]:[]};
    if(operation==='projects.status')return info;
    if(operation==='files.list')return {entries:[]};
    if(operation==='files.upload.status')return {...args,protocol:2,state:'UPLOADING',uploadId,receivedBytes:2,resumable:true};
    if(operation==='files.direct.prepare')return campus.ticket(args);
    if(operation==='files.put')return {path:args.path,uploadId:args.uploadId,complete:true,size:args.totalSize,sha256:args.sha256};
    throw Error('Unexpected simulated upload operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(root,'db'),bootstrap,statusPath,origin,secure:false,bridge,directUploadOrigins:[campus.endpoint]}));
  clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'upload-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[machine]:1}});
  browser=await chromium.launch({headless:true,args:['--ignore-certificate-errors-spki-list='+campus.spki],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const mode of ['supported','unsupported']){
    supported=mode==='supported';const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce',acceptDownloads:true}),page=await context.newPage(),requests=[];
    await page.addInitScript(()=>{window.showSaveFilePicker=undefined;});
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',guardedRoute(async route=>{
      const url=new URL(route.request().url());
      if(![origin,campus.endpoint].includes(url.origin)&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);await route.abort();return;}
      if(url.pathname==='/api/call'){
        const body=route.request().postDataJSON();requests.push(body);
        if(!supported&&body.operation==='files.upload.status'){await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Unknown operation files.upload.status'})});return;}
      }
      await route.continue();
    }));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill('upload-member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    await page.locator('[name=workspace-project] option[data-project="upload-project"]').waitFor({state:'attached'});await page.locator('[name=workspace-project]').selectOption('upload-project');await page.waitForFunction(()=>!document.querySelector('#project-publish').disabled);
    await page.locator('#workspace-files>summary').click();assert.equal(await page.locator('#workspace-upload').textContent(),'上传','No recovery claim before node confirmation');
    await page.locator('[name=files]').setInputFiles({name:'train.py',mimeType:'text/plain',buffer:Buffer.from('abcd')});
    const start=calls.length,requestStart=requests.length;await page.locator('#workspace-upload').click();
    if(supported){
      await page.waitForFunction(()=>document.querySelector('#workspace-result').textContent.includes('已上传 1 个文件'));
      const writes=calls.slice(start).filter(row=>row.operation==='files.put');assert.equal(writes.length,1);assert.equal(writes[0].args.offset,2);assert.equal(Buffer.from(writes[0].args.data,'base64').toString(),'cd');assert.equal(writes[0].args.uploadId,uploadId);assert.equal(await page.locator('#workspace-upload').textContent(),'上传 / 续传');
      await page.locator('[name=file-path]').fill('train.py');const downloadPromise=page.waitForEvent('download');await page.locator('#workspace-download').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'train.py');assert.equal((await readFile(await download.path())).toString(),'abcd');
    }else{
      await page.waitForFunction(()=>document.querySelector('#workspace-result').textContent.includes('未发送文件'));
      assert.equal(calls.slice(start).some(row=>['files.put','files.direct.prepare'].includes(row.operation)),false,'unknown recovery never dispatches raw bytes or a replacement identity');
      assert.equal(requests.slice(requestStart).filter(row=>row.operation==='files.upload.status').length,1);assert.equal(await page.locator('#workspace-upload').textContent(),'上传');
    }
    assert.equal(requests.some(row=>['files.put','files.get'].includes(row.operation)||Object.hasOwn(row.args||{},'data')||Object.hasOwn(row.args||{},'bytes')),false,'zero Portal file body requests');
    for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1080});await page.locator('#workspace-files').evaluate(node=>node.scrollIntoView({block:'center'}));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,mode+'-'+width+'.png'),animations:'disabled'});}
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log('PROJECT UPLOAD CAPABILITY PASS: simulated supported/unsupported nodes, capability-gated label, exact original ID/offset, campus HTTPS upload/code download, unknown recovery zero bytes, no write replay, 1440/390.');
}finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));if(service&&!service.closing){clearInterval(service.executionTimer);await service.close();}for(const callback of cleanup)await callback();await rm(root,{recursive:true,force:true});}
