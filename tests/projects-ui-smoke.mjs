import {terminalContractSmoke} from './terminal-contract-ui-smoke.mjs';
import {openMaintenance} from './admin-maintenance-workflows.mjs';
import {closeSubmit,openSubmit,refreshVisible} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
// Loopback-only browser acceptance: disposable portal DB and fake project,
// terminal, file and GPUQ operations. No real credentials, shell, SSH or GPUs.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';

const folder=await mkdtemp(join(tmpdir(),'gpuq-project-ui-'));
const screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-projects-ui';
const password='Project-Browser-Fixture-Only-2026!',release='a'.repeat(64),nextRelease='b'.repeat(64),datasetVersion='c'.repeat(64);
const [machine,other]=MACHINES.map(item=>item.id),calls=[],pageErrors=[],httpErrors=[],blocked=[],projects=new Map(),terminals=new Map(),uploads=new Map(),uploadIdentities=new Map();
let server,service,browser,badReceiptOnce=false,dropUploadReplyOnce=false,terminalGate,releaseTerminalGate,ociAvailable=false;
const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const origin='http://127.0.0.1:'+port,key=(node,user,project)=>JSON.stringify([node,user,project]);
const copy=value=>structuredClone(value);
try{
  await mkdir(screenshots,{recursive:true});
  const bootstrap=join(folder,'bootstrap.json'),statusPath=join(folder,'status.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(item=>({id:item.id,reachable:true,
    gpus:Array.from({length:item.cards},(_,index)=>({index,model:item.model,memoryTotalMiB:32768,memoryUsedMiB:0,utilization:0,temperatureC:30,powerDrawW:15,powerLimitW:450,processesAvailable:true,processes:[]})),
    gpuq:{connected:true,observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
  const bridge=async(node,operation,args)=>{
    calls.push({machine:node,operation,args:copy(args),at:Date.now()});
    const identity=key(node,args.userId,args.project),project=projects.get(identity);
    if(operation==='projects.list')return {environmentModes:ociAvailable?['oci']:[],projects:[...projects].filter(([entry])=>{const [m,u]=JSON.parse(entry);return m===node&&u===args.userId;}).map(([,value])=>copy(value))};
    if(operation==='projects.create'){assert.ok(!project);const value={project:args.project,state:'DRAFT',releases:[],latestReadyRelease:null,environmentMode:args.environmentMode||'shared'};projects.set(identity,value);return copy(value);}
    if(operation==='projects.status'){assert.ok(project);return copy(project);}
    if(operation==='projects.publish'){
      assert.ok(project);assert.ok(![...terminals.values()].some(value=>value.machine===node&&value.userId===args.userId&&value.project===args.project),'active dev terminal must block publish');
      assert.match(args.key,/^[a-f0-9-]{36}$/);project.publication={id:args.key,state:'PUBLISHING'};
      project.state='PUBLISHING';project.progress={phase:'copying',completedEntries:12,completedBytes:512,totalEntries:20,totalBytes:1024};return copy(project);
    }
    if(operation==='projects.verify'){assert.ok(project?.releases.some(item=>item.release===args.release&&item.state==='READY'));return {project:args.project,release:args.release,state:'READY'};}
    if(operation==='terminal.open'){const id=args.mode==='reconnect'?args.id:randomUUID(),writerToken=randomUUID();if(args.hostAdmin){assert.equal(args.userId,'builtin-admin');assert.equal(args.project,undefined);}if(args.mode==='reconnect')assert.ok(terminals.has(id));terminals.set(id,{...copy(args),machine:node,writerToken});if(terminalGate){const gate=terminalGate;terminalGate=null;await gate;}return {id,writerToken};}
    if(operation==='terminal.exchange'){
      const session=terminals.get(args.id);assert.ok(session);assert.equal(args.project,session.project);assert.equal(args.hostAdmin,session.hostAdmin);assert.equal(node,session.machine);assert.equal(args.writerToken,session.writerToken);
      const bytes=Buffer.from('Local mock project terminal. No shell is executed.\r\n');return {offset:bytes.length,data:args.offset?'':bytes.toString('base64'),exited:false};
    }
    if(operation==='terminal.close'){const session=terminals.get(args.id);assert.ok(session);assert.equal(args.project,session.project);assert.equal(node,session.machine);terminals.delete(args.id);return {closed:true};}
    if(operation==='terminal.detach'){const session=terminals.get(args.id);assert.ok(session);assert.equal(args.writerToken,session.writerToken);return {detached:true};}
    if(operation==='files.upload.status'){
      const record=[...uploadIdentities.values()].find(value=>value.machine===node&&value.userId===args.userId&&value.project===args.project&&value.path===args.path&&value.totalSize===args.totalSize&&value.sha256===args.sha256&&(!args.uploadId||args.uploadId===value.uploadId));
      if(!record)return {protocol:2,state:'ABSENT',path:args.path};
      return {protocol:2,state:record.complete?'COMPLETE':'UPLOADING',path:record.path,uploadId:record.uploadId,totalSize:record.totalSize,sha256:record.sha256,receivedBytes:(uploads.get(record.uploadId)||[]).reduce((size,part)=>size+part.length,0),resumable:true,...(record.complete?{complete:true,size:record.totalSize,completionPending:false}:{})};
    }
    if(operation==='files.put'){
      if(args.project){assert.equal(args.area,'code');assert.equal(Object.hasOwn(args,'truncate'),false);assert.match(args.uploadId,/^[a-f0-9-]{36}$/);
        uploadIdentities.set(args.uploadId,{...copy(args),machine:node,complete:args.final});
        const parts=uploads.get(args.uploadId)||[];assert.equal(args.offset,parts.reduce((n,part)=>n+part.length,0));parts.push(Buffer.from(args.data,'base64'));uploads.set(args.uploadId,parts);
        if(args.final){const data=Buffer.concat(parts);assert.equal(data.length,args.totalSize);assert.equal(createHash('sha256').update(data).digest('hex'),args.sha256);}}
      else{assert.equal(args.truncate,args.offset===0);assert.equal(args.area,undefined);assert.equal(args.uploadId,undefined);}
      if(args.project&&args.final&&badReceiptOnce){badReceiptOnce=false;return {complete:true,size:args.totalSize};}
      return args.project?{path:args.path,complete:args.final,size:args.final?args.totalSize:args.offset+Buffer.from(args.data,'base64').length,...(args.final?{sha256:args.sha256}:{})}:{written:Buffer.from(args.data,'base64').length};
    }
    if(operation==='files.list')return {entries:[{type:'file',name:args.area==='output'?'metrics.json':'train.py',size:32}]};
    if(operation==='files.get')return {data:Buffer.from('{"loss":0.1}\n').toString('base64'),eof:true};
    if(operation==='datasets.list')return {datasets:[{dataset:'sample',versions:[{version:datasetVersion,state:'READY',bytes:16,files:1}]}]};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:20*1024**3,usableBytes:492*1024**3,totalInodes:100000,availableInodes:50000,inodeUsageKnown:true,guarded:true};
    if(operation==='datasets.status')return {dataset:args.dataset,version:args.version,state:'READY'};
    if(operation==='sync')return {state:'SUCCEEDED',nodeJobId:'mock-'+args.job.id,assignedIndices:[0]};
    if(operation==='logs')return {text:'mock project completed'};
    throw Error('Unexpected mock operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(folder,'portal.sqlite'),bootstrap,origin,secure:false,statusPath,bridge}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'project-user',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[machine]:1,[other]:1}});
  projects.set(key(other,member.id,'other-project'),{project:'other-project',state:'READY',releases:[{release:nextRelease,state:'READY'}],latestReadyRelease:nextRelease});
  projects.set(key(machine,'builtin-admin','admin-project'),{project:'admin-project',state:'DRAFT',releases:[],latestReadyRelease:null});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  async function configure(target){
    target.on('pageerror',error=>pageErrors.push(error.message));
    target.on('response',response=>{if(response.status()>=400)httpErrors.push({status:response.status(),operation:response.request().postDataJSON()?.operation});});
    await target.context().route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){blocked.push(url.href);await route.abort();return;}
      if(url.pathname==='/api/call'&&dropUploadReplyOnce&&route.request().postDataJSON()?.operation==='files.put'){dropUploadReplyOnce=false;await route.fetch();await route.abort('connectionreset');return;}
      await route.continue();}));
  }
  await configure(page);
  async function login(target,username){await target.goto(origin);await target.locator('#login-form [name=username]').fill(username);await target.locator('#login-form [name=password]').fill(password);await target.locator('#login-form [type=submit]').click();await target.locator('#login-dialog').waitFor({state:'hidden'});}
  const responseFor=(target,operation)=>target.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation===operation);
  async function action(operation,fn,target=page){if(operation==='terminal.close')target.once('dialog',dialog=>{assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),/结束.*终端/);return dialog.accept();});const waiting=responseFor(target,operation);await fn();const response=await waiting;assert.equal(response.status(),200,await response.text());return response;}
  async function idle(target=page){await target.waitForFunction(()=>!document.querySelector('[name=workspace-machine]')?.disabled);}
  async function capture(name,target=page){await target.waitForFunction(()=>{const toast=document.querySelector('#toast');return !toast||(!toast.classList.contains('visible')&&Number(getComputedStyle(toast).opacity)===0);});await target.evaluate(()=>scrollTo(0,0));await target.screenshot({path:join(screenshots,name),fullPage:true});}
  async function setMachine(value,target=page){await target.evaluate(()=>location.hash='#work');await target.locator('#page-work').waitFor({state:'visible'});await closeSubmit(target);await action('projects.list',()=>target.locator('[name=workspace-machine]').selectOption(value),target);await idle(target);}

  await login(page,'project-user');
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'');
  assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  assert.equal(await page.locator('[name=workspace-machine] option[value=auto],[name=machine] option[value=auto],[name=terminal-machine] option[value=auto],[name=file-machine] option[value=auto]').count(),0,'development and terminal contexts remain explicitly selected');
  assert.equal(await page.locator('[name=training-target]').inputValue(),'current');
  assert.equal(await page.locator('[name=training-target] option[value=auto]').count(),1,'only the independent training target offers automatic placement');
  assert.equal(await page.locator('[name=training-target] option[value=auto]').isDisabled(),true,'automatic placement is unavailable without a fixed OCI project');
  assert.equal(await page.locator('#host-maintenance').isVisible(),false);
  assert.equal(await page.locator('[name=terminal-host]').count(),0,'no sticky ROOT mode switch exists');
  await setMachine(machine);
  assert.equal(await page.locator('#project-create-form [type=submit]').isDisabled(),true,'unknown OCI capability never falls back to a shared project');
  assert.equal(calls.filter(call=>call.operation==='projects.create').length,0);
  ociAvailable=true;await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();
  for(const name of ['machine','terminal-machine','file-machine'])assert.equal(await page.locator(`[name=${name}]`).inputValue(),machine);
  await page.locator('#project-create>summary').click();await page.locator('[name=new-project]').fill('vision-demo');
  assert.equal(await page.locator('[name=environment-mode]').inputValue(),'oci');
  assert.equal(await page.locator('[name=environment-choice]').count(),0,'new projects offer no shared/isolated mode choice');
  assert.equal(await page.locator('[name=environment-mode] option').count(),1);
  await action('projects.create',()=>page.locator('#project-create-form [type=submit]').click());await idle();
  assert.equal(calls.filter(call=>call.operation==='projects.create').at(-1).args.environmentMode,'oci');
  assert.match(await page.locator('#project-status-detail').textContent(),/个人容器/);
  assert.equal(await page.locator('[name=workspace-project]').inputValue(),'vision-demo');
  assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  assert.match(await page.locator('#workspace-mode-note').textContent(),/代码与容器环境一起保存为训练版本/);
  await page.locator('#workspace-files>summary').click();
  const file=Buffer.alloc(1048576+11,65);await page.locator('[name=files]').setInputFiles({name:'train.py',mimeType:'text/plain',buffer:file});
  await page.locator('#workspace-upload').click();await page.waitForFunction(()=>document.querySelector('#workspace-result').textContent.includes('已上传 1 个文件'));await idle();
  const puts=calls.filter(call=>call.operation==='files.put');assert.equal(puts.length,2);assert.equal(puts[0].args.uploadId,puts[1].args.uploadId);assert.deepEqual(puts.map(call=>call.args.final),[false,true]);
  badReceiptOnce=true;await page.locator('[name=files]').setInputFiles({name:'retry.py',mimeType:'text/plain',buffer:Buffer.from('retry fixture')});
  await action('files.put',()=>page.locator('#workspace-upload').click());await idle();
  assert.match(await page.locator('#project-status').textContent(),/尚未确认完整文件/);
  const failedUpload=calls.filter(call=>call.operation==='files.put').at(-1).args.uploadId;
  const putCount=calls.filter(call=>call.operation==='files.put').length;
  await action('files.upload.status',()=>page.locator('#workspace-upload').click());await idle();
  assert.equal(calls.filter(call=>call.operation==='files.put').length,putCount,'verified completion after a lost receipt must not reupload');
  assert.equal(calls.filter(call=>call.operation==='files.upload.status').at(-1).args.sha256,uploadIdentities.get(failedUpload).sha256);
  assert.equal(calls.filter(call=>call.operation==='files.put').at(-1).args.uploadId,failedUpload);
  assert.match(await page.locator('#workspace-result').textContent(),/已上传 1 个文件/);
  assert.doesNotMatch(await page.locator('#project-status').textContent(),/尚未确认完整文件/);
  const originalUpload=randomUUID(),resumeFile=Buffer.alloc(1048576+13,66),resumeHash=createHash('sha256').update(resumeFile).digest('hex');
  uploadIdentities.set(originalUpload,{machine,userId:member.id,project:'vision-demo',path:'resume.py',totalSize:resumeFile.length,sha256:resumeHash,uploadId:originalUpload,complete:false});uploads.set(originalUpload,[resumeFile.subarray(0,1048576)]);
  await page.locator('[name=files]').setInputFiles({name:'resume.py',mimeType:'text/plain',buffer:resumeFile});
  const resumeStart=calls.length;await action('files.put',()=>page.locator('#workspace-upload').click());await idle();
  const resumedPuts=calls.slice(resumeStart).filter(row=>row.operation==='files.put');assert.equal(resumedPuts.length,1);assert.equal(resumedPuts[0].args.uploadId,originalUpload);assert.equal(resumedPuts[0].args.offset,1048576);assert.equal(Buffer.from(resumedPuts[0].args.data,'base64').length,13);
  const lostStart=calls.length;dropUploadReplyOnce=true;await page.locator('[name=files]').setInputFiles({name:'interrupted.py',mimeType:'text/plain',buffer:resumeFile});
  await page.locator('#workspace-upload').click();await page.waitForFunction(()=>!document.querySelector('#workspace-upload').disabled&&document.querySelector('#workspace-result').textContent.includes('已上传 1 个文件'));await idle();
  const lostPuts=calls.slice(lostStart).filter(row=>row.operation==='files.put'),recoveryRead=calls.slice(lostStart).filter(row=>row.operation==='files.upload.status').at(-1);
  assert.deepEqual(lostPuts.map(row=>row.args.offset),[0,1048576]);assert.equal(lostPuts[0].args.uploadId,lostPuts[1].args.uploadId);assert.equal(recoveryRead.args.uploadId,lostPuts[0].args.uploadId);
  await capture('project-upload-resume-member-1440.png');
  await action('files.list',()=>page.locator('#workspace-list').click());assert.match(await page.locator('#workspace-result').textContent(),/train.py/);

  await action('terminal.open',()=>page.locator('#terminal-open').click());await page.locator('.terminal-dialog').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('.terminal-dialog .xterm'));
  await page.locator('#terminal-disconnect').click();assert.equal(await page.locator('#project-publish').isDisabled(),true);
  assert.equal(terminals.size,1,'disconnect keeps development session alive');
  const opened=calls.filter(call=>call.operation==='terminal.open').length;
  page.once('dialog',dialog=>dialog.accept([...terminals.keys()][0]));
  await page.locator('#terminal-reconnect').click();await page.locator('.terminal-dialog').waitFor({state:'visible'});await page.locator('#terminal-disconnect').click();
  assert.equal(calls.filter(call=>call.operation==='terminal.open').length,opened+1,'reconnect explicitly reacquires the same session');assert.equal(terminals.size,1);
  await action('terminal.open',()=>page.locator('#terminal-open').click());await page.locator('.terminal-dialog').waitFor({state:'visible'});await page.locator('#terminal-disconnect').click();assert.equal(terminals.size,2,'new always creates an independent session');
  await action('terminal.close',()=>page.locator('#project-terminal-stop').click());await page.locator('#project-terminal-stop').waitFor({state:'hidden'});assert.equal(terminals.size,0);await idle();
  for(const call of calls.filter(call=>call.operation.startsWith('terminal.'))){assert.equal(call.machine,machine);assert.equal(call.args.project,'vision-demo');assert.equal(call.args.hostAdmin,false);}

  await page.locator('#train-form').evaluate(form=>{form.closest('details').open=true;});
  await page.locator('[name=training-target]').selectOption('current');
  await page.locator('[name=command]').fill('python train.py --output /outputs/result.json');await page.locator('[name=name]').fill('project-smoke');
  await closeSubmit(page);await action('projects.publish',()=>page.locator('#project-publish').click());await idle();
  assert.match(await page.locator('#project-status').textContent(),/正在生成训练版本/);assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  assert.match(await page.locator('#project-status-detail').textContent(),/复制：12 \/ 20 项，512 \/ 1024 B/);
  const publication=projects.get(key(machine,member.id,'vision-demo'));publication.state='READY';publication.releases=[{release,state:'READY'}];publication.latestReadyRelease=release;publication.publication={id:publication.publication.id,state:'READY',release};
  await responseFor(page,'projects.status');await idle();
  assert.equal(await page.locator('[name=release]').inputValue(),release);assert.equal(await page.locator('#release-full').textContent(),release);
  assert.equal(await page.locator('#train-form [type=submit]').isEnabled(),true);
  await action('projects.publish',()=>page.locator('#project-publish').click());await idle();
  publication.state='FAILED';publication.publication.state='FAILED';publication.error='mock failure';publication.errorDetails={path:'code/<img src=x onerror=alert(1)>',mode:'0o664',links:2,kind:'file',remediation:'make a private copy'};
  await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();
  assert.match(await page.locator('#project-status-detail').textContent(),/code\/<img src=x onerror=alert\(1\)>/);
  assert.match(await page.locator('#project-status-detail').textContent(),/权限：0o664.*链接数：2.*make a private copy/);
  assert.equal(await page.locator('#project-status-detail img').count(),0);
  publication.state='READY';publication.publication={id:publication.publication.id,state:'READY',release};delete publication.error;delete publication.errorDetails;
  await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();
  await capture('projects-desktop-ready.png');

  // A newly published release never silently moves an existing draft to latest.
  publication.releases.push({release:nextRelease,state:'READY'});publication.latestReadyRelease=nextRelease;
  await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();
  assert.equal(await page.locator('[name=release]').inputValue(),release);
  publication.releases=[{release:nextRelease,state:'READY'}];
  await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();
  assert.equal(await page.locator('[name=release]').inputValue(),release,'temporarily absent release is not replaced with latest');
  assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  publication.releases.unshift({release,state:'READY'});await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();
  await refreshVisible(page);await idle();
  assert.equal(await page.locator('[name=command]').inputValue(),'python train.py --output /outputs/result.json');
  assert.equal(await page.locator('[name=name]').inputValue(),'project-smoke');

  // Dataset entry keeps the same project when its explicitly chosen node is the same.
  await closeSubmit(page);await page.locator('[data-nav=datasets]').click();
  await page.locator('[data-use-dataset=sample]').waitFor({state:'visible'});
  await action('datasets.catalog',()=>page.locator('#datasets-refresh').click());
  await page.locator('[data-use-dataset=sample]').click();
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),machine);assert.equal(await page.locator('[name=workspace-project]').inputValue(),'vision-demo');
  assert.equal(await page.locator('[name=datasets]').inputValue(),'sample@'+datasetVersion);
  const submitted=await action('jobs.submit',()=>page.locator('#train-form [type=submit]').click());
  const job=(await submitted.json()).result;assert.equal(job.machine,machine);assert.equal(job.project,'vision-demo');assert.equal(job.release,release);
  assert.deepEqual(job.datasets,[{dataset:'sample',version:datasetVersion}]);assert.deepEqual(job.command,['/bin/bash','-c','python train.py --output /outputs/result.json']);
  await idle();
  await closeSubmit(page);await page.locator('[data-nav=work]').click();await action('files.list',()=>page.locator('#my-job-table [data-job-output]').click());await idle();
  assert.equal(await page.locator('[name=release]').inputValue(),release,'viewing output must not replace the pinned training draft with latest');
  assert.equal(await page.locator('[name=file-area]').inputValue(),'output');assert.equal(await page.locator('[name=file-run-id]').inputValue(),job.id);
  assert.equal(await page.locator('#workspace-upload').isDisabled(),true);assert.match(await page.locator('#workspace-result').textContent(),/metrics.json/);
  await page.locator('[name=file-path]').fill('metrics.json');
  const downloadEvent=page.waitForEvent('download');await action('files.get',()=>page.locator('#workspace-download').click());const download=await downloadEvent;assert.equal(download.suggestedFilename(),'metrics.json');
  const get=calls.filter(call=>call.operation==='files.get').at(-1);assert.equal(get.args.area,'output');assert.equal(get.args.runId,job.id);assert.equal(get.args.project,'vision-demo');
  await page.setViewportSize({width:390,height:844});await capture('projects-mobile-output.png');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px workbench must not overflow');

  await page.locator('[name=workspace-project]').selectOption('');await idle();
  await setMachine(other);assert.equal(await page.locator('[name=workspace-project]').inputValue(),'');
  assert.equal(await page.locator('[name=file-path]').inputValue(),'.');assert.equal(await page.locator('[name=file-run-id]').inputValue(),'');assert.equal(await page.locator('[name=file-area]').inputValue(),'code');
  for(const name of ['machine','terminal-machine','file-machine'])assert.equal(await page.locator(`[name=${name}]`).inputValue(),other);
  await page.locator('[name=files]').setInputFiles({name:'legacy.py',mimeType:'text/plain',buffer:Buffer.from('legacy test')});
  await action('files.put',()=>page.locator('#workspace-upload').click());await idle();
  const legacy=calls.filter(call=>call.operation==='files.put').at(-1);assert.equal(legacy.machine,other);assert.equal(legacy.args.project,undefined);assert.equal(legacy.args.truncate,true);
  await openSubmit(page);await page.locator('[name=datasets]').fill('');await page.locator('[name=command]').fill('python legacy.py');
  const legacySubmission=await action('jobs.submit',()=>page.locator('#train-form [type=submit]').click());await idle();
  const legacyJob=(await legacySubmission.json()).result;assert.equal(legacyJob.machine,other);assert.equal(legacyJob.project,undefined);assert.equal(legacyJob.release,undefined);
  await closeSubmit(page);await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption('other-project'));await idle();
  await capture('projects-mobile-ready.png');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px selected-project layout must not overflow');
  await page.locator('#project-create>summary').click();
  assert.equal(await page.locator('[name=environment-mode]').inputValue(),'oci');
  assert.equal(await page.locator('[name=environment-choice]').count(),0);
  await capture('projects-mobile-environment.png');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px environment creation form must not overflow');

  const adminPage=await browser.newPage({viewport:{width:1440,height:1000}});await configure(adminPage);await login(adminPage,'admin');await setMachine(machine,adminPage);
  assert.equal(await adminPage.locator('#host-maintenance').isVisible(),false,'primary workspace never exposes ROOT maintenance');
  async function rootEntry(){await openMaintenance(adminPage);if(!await adminPage.locator('#host-maintenance').evaluate(el=>el.open))await adminPage.locator('#host-maintenance summary').click();await adminPage.locator('[data-maintenance-root-machine]').selectOption(machine);}
  async function workEntry(){await adminPage.evaluate(()=>location.hash='#work');await adminPage.locator('#page-work').waitFor({state:'visible'});await idle(adminPage);}
  await action('terminal.open',()=>adminPage.locator('#terminal-open').click(),adminPage);await adminPage.locator('.terminal-dialog').waitFor({state:'visible'});
  assert.equal(calls.filter(call=>call.operation==='terminal.open').at(-1).args.hostAdmin,false,'admin default terminal remains private');
  await action('terminal.close',()=>adminPage.locator('#terminal-stop').click(),adminPage);
  await action('projects.status',()=>adminPage.locator('[name=workspace-project]').selectOption('admin-project'),adminPage);await idle(adminPage);
  await adminPage.locator('#workspace-files>summary').click();
  await adminPage.locator('[name=files]').setInputFiles({name:'resume.py',mimeType:'text/plain',buffer:resumeFile});
  const adminUploadStart=calls.length;await action('files.put',()=>adminPage.locator('#workspace-upload').click(),adminPage);await idle(adminPage);
  const adminPuts=calls.slice(adminUploadStart).filter(row=>row.operation==='files.put');assert.equal(adminPuts[0].args.offset,0);assert.notEqual(adminPuts[0].args.uploadId,originalUpload);assert.equal(adminPuts[0].args.userId,'builtin-admin','another actor never resumes member bytes');
  await capture('project-upload-resume-admin-1440.png',adminPage);
  await openMaintenance(adminPage);assert.equal(await adminPage.locator('#host-maintenance').isVisible(),true);assert.equal(await adminPage.locator('#host-maintenance').evaluate(el=>el.open),false,'backend maintenance starts collapsed');await rootEntry();
  const beforeRoot=calls.filter(call=>call.operation==='terminal.open').length;
  adminPage.once('dialog',dialog=>dialog.dismiss());await adminPage.locator('#terminal-root-open').click();
  assert.equal(calls.filter(call=>call.operation==='terminal.open').length,beforeRoot,'canceling ROOT confirmation sends no API request');
  adminPage.once('dialog',dialog=>dialog.accept());await action('terminal.open',()=>adminPage.locator('#terminal-root-open').click(),adminPage);await adminPage.locator('.terminal-dialog').waitFor({state:'visible'});
  const rootSession=calls.filter(call=>call.operation==='terminal.open').at(-1);assert.equal(rootSession.args.hostAdmin,true);assert.equal(rootSession.args.project,undefined);
  assert.equal(await adminPage.locator('[name=workspace-project]').inputValue(),'admin-project','host maintenance does not change the personal project');
  assert.match(await adminPage.locator('#terminal-session-note').textContent(),/宿主机 ROOT.*绕过 GPU 配额/);
  assert.doesNotMatch(await adminPage.locator('#terminal-session-note').textContent(),/不分配 GPU/);
  const rootId=[...terminals].find(([,value])=>value.hostAdmin)[0];
  await action('terminal.detach',()=>adminPage.locator('#terminal-disconnect').click(),adminPage);
  await workEntry();
  adminPage.once('dialog',dialog=>dialog.accept(rootId));await adminPage.locator('#terminal-reconnect').click();
  await adminPage.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('终端类型'));
  assert.equal(calls.filter(call=>call.operation==='terminal.open').length,beforeRoot+1,'development reconnect cannot silently attach known ROOT session');
  await rootEntry();
  adminPage.once('dialog',dialog=>{adminPage.once('dialog',next=>next.accept(rootId));return dialog.accept();});
  await action('terminal.open',()=>adminPage.locator('#terminal-root-reconnect').click(),adminPage);await adminPage.locator('.terminal-dialog').waitFor({state:'visible'});
  await action('terminal.close',()=>adminPage.locator('#terminal-stop').click(),adminPage);
  await workEntry();
  await setMachine(other,adminPage);
  await action('terminal.open',()=>adminPage.locator('#terminal-open').click(),adminPage);await adminPage.locator('.terminal-dialog').waitFor({state:'visible'});
  assert.equal(calls.filter(call=>call.operation==='terminal.open').at(-1).args.hostAdmin,false,'changing machine after ROOT never promotes the next development session');
  await action('terminal.close',()=>adminPage.locator('#terminal-stop').click(),adminPage);
  await setMachine(machine,adminPage);await action('projects.status',()=>adminPage.locator('[name=workspace-project]').selectOption('admin-project'),adminPage);await idle(adminPage);
  await capture('projects-admin-project.png',adminPage);
  await adminPage.setViewportSize({width:390,height:844});await capture('projects-admin-personal-mobile.png',adminPage);
  assert.ok(await adminPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px personal terminal entry must not overflow');
  await rootEntry();await capture('projects-admin-maintenance-mobile.png',adminPage);assert.ok(await adminPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px backend ROOT entries must not overflow');await workEntry();
  await adminPage.locator('[name=workspace-project]').selectOption('');await idle(adminPage);
  await rootEntry();
  terminalGate=new Promise(resolve=>{releaseTerminalGate=resolve;});
  adminPage.once('dialog',dialog=>dialog.accept());await adminPage.locator('#terminal-root-open').click();
  for(let wait=0;wait<100&&![...terminals.values()].some(value=>value.hostAdmin);wait++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok([...terminals.values()].some(value=>value.hostAdmin),'delayed ROOT request reached the fake node');
  const staleRootId=[...terminals].find(([,value])=>value.hostAdmin)[0];
  const changedMachine=responseFor(adminPage,'projects.list');await workEntry();await adminPage.locator('[name=workspace-machine]').selectOption(other);
  const lateDetached=responseFor(adminPage,'terminal.detach');releaseTerminalGate();await Promise.all([lateDetached,changedMachine]);await idle(adminPage);
  assert.equal(await adminPage.locator('.terminal-dialog').isVisible(),false,'late ROOT open cannot attach after the workspace changed');
  assert.equal(terminals.has(staleRootId),true,'changing workspace detaches but does not destroy the old ROOT session');
  await setMachine(machine,adminPage);
  await rootEntry();
  adminPage.once('dialog',dialog=>{adminPage.once('dialog',next=>next.accept(staleRootId));return dialog.accept();});
  await action('terminal.open',()=>adminPage.locator('#terminal-root-reconnect').click(),adminPage);await adminPage.locator('.terminal-dialog').waitFor({state:'visible'});
  await action('terminal.close',()=>adminPage.locator('#terminal-stop').click(),adminPage);
  // Two independent buttons can be clicked before either open response arrives.
  // Verify both orders through actual browser events and delayed HTTP responses.
  for(const firstRoot of [true,false]){
    // Hold only response delivery: the portal deliberately serializes node
    // operations, but network responses can still reach the browser out of order.
    const responseGate=new Promise(resolve=>{releaseTerminalGate=resolve;});let intercepted=false;
    const holdResponse=async route=>{
      const body=route.request().postDataJSON();
      if(!intercepted&&body?.operation==='terminal.open'&&(body.args.hostAdmin===true)===firstRoot){
        intercepted=true;const response=await route.fetch();await responseGate;await route.fulfill({response});
      }else await route.continue();
    };
    await adminPage.route(origin+'/api/call',holdResponse);
    const firstButton=firstRoot?'terminal-root-open':'terminal-open',secondButton=firstRoot?'terminal-open':'terminal-root-open';
    if(firstRoot)await rootEntry();else await workEntry();
    if(firstRoot)adminPage.once('dialog',dialog=>dialog.accept());
    await adminPage.locator('#'+firstButton).click();
    for(let wait=0;wait<100&&terminals.size===0;wait++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(terminals.size,1,'first request is held at the fake node before starting the second');
    const delayedId=[...terminals.keys()][0];
    if(firstRoot)await workEntry();else await rootEntry();
    if(!firstRoot)adminPage.once('dialog',dialog=>dialog.accept());
    await action('terminal.open',()=>adminPage.locator('#'+secondButton).click(),adminPage);
    await adminPage.locator('.terminal-dialog').waitFor({state:'visible'});
    const title=await adminPage.locator('#terminal-title').textContent();assert.match(title,firstRoot?/个人开发/:/ROOT 运维/);
    const released=responseFor(adminPage,'terminal.detach');releaseTerminalGate();await released;
    await adminPage.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('旧终端保留'));
    assert.equal(await adminPage.locator('#terminal-title').textContent(),title,'late response cannot replace the newest chosen privilege context');
    assert.equal(calls.filter(call=>call.operation==='terminal.detach').at(-1).args.id,delayedId);
    assert.equal(terminals.has(delayedId),true,'superseded terminal remains reconnectable after its writer is released');
    await action('terminal.close',()=>adminPage.locator('#terminal-stop').click(),adminPage);
    if(firstRoot)await rootEntry();else await workEntry();
    if(firstRoot)adminPage.once('dialog',dialog=>{adminPage.once('dialog',next=>next.accept(delayedId));return dialog.accept();});
    else adminPage.once('dialog',dialog=>dialog.accept(delayedId));
    await action('terminal.open',()=>adminPage.locator(firstRoot?'#terminal-root-reconnect':'#terminal-reconnect').click(),adminPage);
    await adminPage.locator('.terminal-dialog').waitFor({state:'visible'});
    await action('terminal.close',()=>adminPage.locator('#terminal-stop').click(),adminPage);
    assert.equal(terminals.size,0);
    await adminPage.unroute(origin+'/api/call',holdResponse);
  }
  assert.deepEqual(pageErrors,[]);assert.deepEqual(blocked,[]);
  assert.deepEqual(httpErrors,[],'Public login and authenticated project flows must have zero HTTP errors');
  assert.equal(service.store.jobs.length,2);assert.equal(terminals.size,0);
  assert.ok(calls.filter(call=>call.operation==='projects.status').length<12,'publication polling stays bounded');
  console.log(JSON.stringify({status:'passed',checks:['explicit development machine/project','unknown OCI capability denies creation','default personal OCI without mode choices','plain-text publication progress/errors','verified chunk upload','project terminal open/exchange/reconnect/close','publish without live dev terminal','fixed READY release and preserved draft','dataset entry','project submit','own output list/download','legacy file compatibility','context clears run/path','admin root separation','delayed ROOT/development opens cannot replace newest intent','390px container form without overflow'],screenshots,calls:calls.length,jobs:service.store.jobs.length}));
}finally{releaseTerminalGate?.();await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}

// Keep the terminal contract browser suite in the existing CI project entry.
await terminalContractSmoke();
// Keep the new receipt contract in the existing CI browser entry point.
await import('./personal-project-ui-smoke.mjs');
// Exercise the independent personal-project entry in this existing CI job.
await import('./project-directory-ui-smoke.mjs');

// Shared transport and explicit refusal must retain lost-reply recovery.
await import("./submission-errors-ui-smoke.mjs");
// Personal disk quota shares the selected development project context.
await import('./project-quota-ui-smoke.mjs');
// Recovery is exposed only after an actual compatible node response.
await import('./project-upload-capability-ui-smoke.mjs');
// Public entries and wording reflect only verified production capabilities.
await import('./member-surface-ui-smoke.mjs');
