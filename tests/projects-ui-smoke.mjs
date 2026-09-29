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
const [machine,other]=MACHINES.map(item=>item.id),calls=[],pageErrors=[],httpErrors=[],blocked=[],projects=new Map(),terminals=new Map(),uploads=new Map();
let server,service,browser,badReceiptOnce=false;
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
    if(operation==='projects.list')return {projects:[...projects].filter(([entry])=>{const [m,u]=JSON.parse(entry);return m===node&&u===args.userId;}).map(([,value])=>copy(value))};
    if(operation==='projects.create'){assert.ok(!project);const value={project:args.project,state:'DRAFT',releases:[],latestReadyRelease:null};projects.set(identity,value);return copy(value);}
    if(operation==='projects.status'){assert.ok(project);return copy(project);}
    if(operation==='projects.publish'){
      assert.ok(project);assert.ok(![...terminals.values()].some(value=>value.machine===node&&value.userId===args.userId&&value.project===args.project),'active dev terminal must block publish');
      project.state='PUBLISHING';return copy(project);
    }
    if(operation==='projects.verify'){assert.ok(project?.releases.some(item=>item.release===args.release&&item.state==='READY'));return {project:args.project,release:args.release,state:'READY'};}
    if(operation==='terminal.open'){const id=randomUUID();assert.equal(args.hostAdmin,false);terminals.set(id,{...copy(args),machine:node});return {id};}
    if(operation==='terminal.exchange'){
      const session=terminals.get(args.id);assert.ok(session);assert.equal(args.project,session.project);assert.equal(args.hostAdmin,session.hostAdmin);assert.equal(node,session.machine);
      const bytes=Buffer.from('Local mock project terminal. No shell is executed.\r\n');return {offset:bytes.length,data:args.offset?'':bytes.toString('base64'),exited:false};
    }
    if(operation==='terminal.close'){const session=terminals.get(args.id);assert.ok(session);assert.equal(args.project,session.project);assert.equal(node,session.machine);terminals.delete(args.id);return {closed:true};}
    if(operation==='files.put'){
      if(args.project){assert.equal(args.area,'code');assert.equal(Object.hasOwn(args,'truncate'),false);assert.match(args.uploadId,/^[a-f0-9-]{36}$/);
        const parts=uploads.get(args.uploadId)||[];assert.equal(args.offset,parts.reduce((n,part)=>n+part.length,0));parts.push(Buffer.from(args.data,'base64'));uploads.set(args.uploadId,parts);
        if(args.final){const data=Buffer.concat(parts);assert.equal(data.length,args.totalSize);assert.equal(createHash('sha256').update(data).digest('hex'),args.sha256);}}
      else{assert.equal(args.truncate,args.offset===0);assert.equal(args.area,undefined);assert.equal(args.uploadId,undefined);}
      if(args.project&&args.final&&badReceiptOnce){badReceiptOnce=false;return {complete:true,size:args.totalSize};}
      return args.project?{path:args.path,complete:args.final,size:args.final?args.totalSize:args.offset+Buffer.from(args.data,'base64').length,...(args.final?{sha256:args.sha256}:{})}:{written:Buffer.from(args.data,'base64').length};
    }
    if(operation==='files.list')return {entries:[{type:'file',name:args.area==='output'?'metrics.json':'train.py',size:32}]};
    if(operation==='files.get')return {data:Buffer.from('{"loss":0.1}\n').toString('base64'),eof:true};
    if(operation==='datasets.list')return {datasets:[{dataset:'sample',versions:[{version:datasetVersion,state:'READY',bytes:16,files:1}]}]};
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
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  async function configure(target){
    target.on('pageerror',error=>pageErrors.push(error.message));
    target.on('response',response=>{if(response.status()>=400)httpErrors.push({status:response.status(),operation:response.request().postDataJSON()?.operation});});
    await target.context().route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();blocked.push(url.href);return route.abort();});
  }
  await configure(page);
  async function login(target,username){await target.goto(origin);await target.locator('#login-form [name=username]').fill(username);await target.locator('#login-form [name=password]').fill(password);await target.locator('#login-form [type=submit]').click();await target.locator('#login-dialog').waitFor({state:'hidden'});}
  const responseFor=(target,operation)=>target.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation===operation);
  async function action(operation,fn,target=page){const waiting=responseFor(target,operation);await fn();const response=await waiting;assert.equal(response.status(),200,await response.text());return response;}
  async function idle(target=page){await target.waitForFunction(()=>!document.querySelector('[name=workspace-machine]')?.disabled);}
  async function capture(name,target=page){await target.waitForFunction(()=>{const toast=document.querySelector('#toast');return !toast||(!toast.classList.contains('visible')&&Number(getComputedStyle(toast).opacity)===0);});await target.evaluate(()=>scrollTo(0,0));await target.screenshot({path:join(screenshots,name),fullPage:true});}
  async function setMachine(value,target=page){await action('projects.list',()=>target.locator('[name=workspace-machine]').selectOption(value),target);await idle(target);}

  await login(page,'project-user');
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'');
  assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  assert.equal(await page.locator('option[value=auto]').count(),0);
  assert.equal(await page.locator('[name=terminal-host]').isVisible(),false);
  await setMachine(machine);
  for(const name of ['machine','terminal-machine','file-machine'])assert.equal(await page.locator(`[name=${name}]`).inputValue(),machine);
  await page.locator('#project-create summary').click();await page.locator('[name=new-project]').fill('vision-demo');
  await action('projects.create',()=>page.locator('#project-create-form [type=submit]').click());await idle();
  assert.equal(await page.locator('[name=workspace-project]').inputValue(),'vision-demo');
  assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  assert.match(await page.locator('#workspace-mode-note').textContent(),/\/opt\/project-env/);
  await page.locator('#workspace-files summary').click();
  const file=Buffer.alloc(1048576+11,65);await page.locator('[name=files]').setInputFiles({name:'train.py',mimeType:'text/plain',buffer:file});
  await page.locator('#workspace-upload').click();await page.waitForFunction(()=>document.querySelector('#workspace-result').textContent.includes('已上传 1 个文件'));await idle();
  const puts=calls.filter(call=>call.operation==='files.put');assert.equal(puts.length,2);assert.equal(puts[0].args.uploadId,puts[1].args.uploadId);assert.deepEqual(puts.map(call=>call.args.final),[false,true]);
  badReceiptOnce=true;await page.locator('[name=files]').setInputFiles({name:'retry.py',mimeType:'text/plain',buffer:Buffer.from('retry fixture')});
  await action('files.put',()=>page.locator('#workspace-upload').click());await idle();
  assert.match(await page.locator('#project-status').textContent(),/尚未确认完整文件/);
  const failedUpload=calls.filter(call=>call.operation==='files.put').at(-1).args.uploadId;
  await action('files.put',()=>page.locator('#workspace-upload').click());await idle();
  assert.notEqual(calls.filter(call=>call.operation==='files.put').at(-1).args.uploadId,failedUpload);
  assert.match(await page.locator('#workspace-result').textContent(),/已上传 1 个文件/);
  assert.doesNotMatch(await page.locator('#project-status').textContent(),/尚未确认完整文件/);
  await action('files.list',()=>page.locator('#workspace-list').click());assert.match(await page.locator('#workspace-result').textContent(),/train.py/);

  await action('terminal.open',()=>page.locator('#terminal-open').click());await page.locator('.terminal-dialog').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('.terminal-dialog .xterm'));
  await page.locator('#terminal-disconnect').click();assert.equal(await page.locator('#project-publish').isDisabled(),true);
  assert.equal(terminals.size,1,'disconnect keeps development session alive');
  const opened=calls.filter(call=>call.operation==='terminal.open').length;
  await page.locator('#terminal-open').click();await page.locator('.terminal-dialog').waitFor({state:'visible'});await page.locator('#terminal-disconnect').click();
  assert.equal(calls.filter(call=>call.operation==='terminal.open').length,opened,'reopen reconnects rather than creates a second session');
  await action('terminal.close',()=>page.locator('#project-terminal-stop').click());assert.equal(terminals.size,0);await idle();
  for(const call of calls.filter(call=>call.operation.startsWith('terminal.'))){assert.equal(call.machine,machine);assert.equal(call.args.project,'vision-demo');assert.equal(call.args.hostAdmin,false);}

  await page.locator('#train-form').evaluate(form=>{form.closest('details').open=true;});
  await page.locator('[name=command]').fill('python train.py --output /outputs/result.json');await page.locator('[name=name]').fill('project-smoke');
  await action('projects.publish',()=>page.locator('#project-publish').click());await idle();
  assert.match(await page.locator('#project-status').textContent(),/正在发布/);assert.equal(await page.locator('#train-form [type=submit]').isDisabled(),true);
  const publication=projects.get(key(machine,member.id,'vision-demo'));publication.state='READY';publication.releases=[{release,state:'READY'}];publication.latestReadyRelease=release;
  await responseFor(page,'projects.status');await idle();
  assert.equal(await page.locator('[name=release]').inputValue(),release);assert.equal(await page.locator('#release-full').textContent(),release);
  assert.equal(await page.locator('#train-form [type=submit]').isEnabled(),true);
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
  await page.locator('#refresh-state').click();await idle();
  assert.equal(await page.locator('[name=command]').inputValue(),'python train.py --output /outputs/result.json');
  assert.equal(await page.locator('[name=name]').inputValue(),'project-smoke');

  // Dataset entry keeps the same project when its explicitly chosen node is the same.
  await page.locator('[data-nav=datasets]').click();
  await action('datasets.list',()=>page.locator('#datasets-refresh').click());
  await page.locator('[data-use-dataset=sample]').click();
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),machine);assert.equal(await page.locator('[name=workspace-project]').inputValue(),'vision-demo');
  assert.equal(await page.locator('[name=datasets]').inputValue(),'sample@'+datasetVersion);
  const submitted=await action('jobs.submit',()=>page.locator('#train-form [type=submit]').click());
  const job=(await submitted.json()).result;assert.equal(job.machine,machine);assert.equal(job.project,'vision-demo');assert.equal(job.release,release);
  assert.deepEqual(job.datasets,[{dataset:'sample',version:datasetVersion}]);assert.deepEqual(job.command,['/bin/bash','-c','python train.py --output /outputs/result.json']);
  await idle();
  await action('files.list',()=>page.locator('#my-job-table [data-job-output]').click());await idle();
  assert.equal(await page.locator('[name=release]').inputValue(),release,'viewing output must not replace the pinned training draft with latest');
  assert.equal(await page.locator('[name=file-area]').inputValue(),'output');assert.equal(await page.locator('[name=file-run-id]').inputValue(),job.id);
  assert.equal(await page.locator('#workspace-upload').isDisabled(),true);assert.match(await page.locator('#workspace-result').textContent(),/metrics.json/);
  await page.locator('[name=file-path]').fill('metrics.json');
  const downloadEvent=page.waitForEvent('download');await action('files.get',()=>page.locator('#workspace-download').click());const download=await downloadEvent;assert.equal(download.suggestedFilename(),'metrics.json');
  const get=calls.filter(call=>call.operation==='files.get').at(-1);assert.equal(get.args.area,'output');assert.equal(get.args.runId,job.id);assert.equal(get.args.project,'vision-demo');
  await page.setViewportSize({width:390,height:844});await capture('projects-mobile-output.png');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px workbench must not overflow');

  await setMachine(other);assert.equal(await page.locator('[name=workspace-project]').inputValue(),'');
  assert.equal(await page.locator('[name=file-path]').inputValue(),'.');assert.equal(await page.locator('[name=file-run-id]').inputValue(),'');assert.equal(await page.locator('[name=file-area]').inputValue(),'code');
  for(const name of ['machine','terminal-machine','file-machine'])assert.equal(await page.locator(`[name=${name}]`).inputValue(),other);
  await page.locator('[name=files]').setInputFiles({name:'legacy.py',mimeType:'text/plain',buffer:Buffer.from('legacy test')});
  await action('files.put',()=>page.locator('#workspace-upload').click());await idle();
  const legacy=calls.filter(call=>call.operation==='files.put').at(-1);assert.equal(legacy.machine,other);assert.equal(legacy.args.project,undefined);assert.equal(legacy.args.truncate,true);
  await page.locator('[name=datasets]').fill('');await page.locator('[name=command]').fill('python legacy.py');
  const legacySubmission=await action('jobs.submit',()=>page.locator('#train-form [type=submit]').click());await idle();
  const legacyJob=(await legacySubmission.json()).result;assert.equal(legacyJob.machine,other);assert.equal(legacyJob.project,undefined);assert.equal(legacyJob.release,undefined);
  await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption('other-project'));await idle();
  await capture('projects-mobile-ready.png');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px selected-project layout must not overflow');

  const adminPage=await browser.newPage({viewport:{width:1440,height:1000}});await configure(adminPage);await login(adminPage,'admin');await setMachine(machine,adminPage);
  await adminPage.locator('[name=terminal-host]').check();await action('projects.status',()=>adminPage.locator('[name=workspace-project]').selectOption('admin-project'),adminPage);await idle(adminPage);
  assert.equal(await adminPage.locator('[name=terminal-host]').isChecked(),false);assert.equal(await adminPage.locator('[name=terminal-host]').isDisabled(),true);
  await capture('projects-admin-project.png',adminPage);
  assert.deepEqual(pageErrors,[]);assert.deepEqual(blocked,[]);
  assert.deepEqual(httpErrors,[{status:401,operation:'state'},{status:401,operation:'state'}]);
  assert.equal(service.store.jobs.length,2);assert.equal(terminals.size,0);
  assert.ok(calls.filter(call=>call.operation==='projects.status').length<10,'publication polling stays bounded');
  console.log(JSON.stringify({status:'passed',checks:['explicit shared machine/project','create and draft','verified chunk upload','project terminal open/exchange/reconnect/close','publish without live dev terminal','fixed READY release and preserved draft','dataset entry','project submit','own output list/download','legacy file compatibility','context clears run/path','admin root separation','390px no overflow'],screenshots,calls:calls.length,jobs:service.store.jobs.length}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
