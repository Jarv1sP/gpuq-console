// Actual owner-bound Portal output API with synthetic node observations/files.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {mockCampusFiles} from './personal-file-campus-mock.mjs';
const directory=await mkdtemp(join(tmpdir(),'stargate-job-results-')),shots=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-job-results','job-results'),password='Results-Local-Fixture-Only-2026!',release='a'.repeat(64),machine=MACHINES[0].id;
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
const cleanup=[];let campus;
let server,service,browser,mode='success',holdList=false,releaseList,listEntered;const calls=[],errors=[],outside=[];
const project='vision-results',file='metrics.json',contents=Buffer.from('{"loss":0.1}\n'),fixtureTime=Math.floor(Date.now()/1000);
const settle=async(page,selector)=>page.locator(selector).evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})));});
try{
 await mkdir(shots,{recursive:true});const bootstrap=join(directory,'bootstrap'),statusPath=join(directory,'status');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(row=>({id:row.id,reachable:true,gpus:[],gpuq:{connected:true,jobs:[]}}))}));
 campus=await mockCampusFiles({after:callback=>cleanup.push(callback)},async(operation,args)=>{assert.equal(operation,'files.get');assert.equal(args.area,'output');assert.equal(args.project,project);assert.equal(args.path,file);assert.equal(args.userId,service.store.jobs.find(row=>row.id===args.runId).userId);return {protocol:2,path:file,size:contents.length,offset:args.offset,data:contents.subarray(args.offset).toString('base64'),eof:true};},{allowedOrigins:[origin]});
 const bridge=async(node,operation,args)=>{
  calls.push({node,operation,args:structuredClone(args)});
  if(operation==='projects.list')return {environmentModes:['oci'],projects:[{project,state:'READY',environmentMode:'oci',latestReadyRelease:release,releases:[{release,state:'READY'}]}]};
  if(operation==='projects.status')return {project,state:'READY',environmentMode:'oci',latestReadyRelease:release,releases:[{release,state:'READY'}]};
  if(operation==='projects.quota')return {enabled:false};if(operation==='logs')return {text:'Simulated successful task.'};
  if(operation==='watch'){const job=args.job;return {nodeJobId:'J0123456789ab',state:mode==='success'?'SUCCEEDED':'UNKNOWN',assignedIndices:[],nativeObservation:{protocol:'native-observation-v1',status:'CONFIRMED',jobId:job.id,userId:job.userId,nodeJobId:'J0123456789ab',submitKey:job.id,specVerified:true,state:'SUCCEEDED',nativeVersion:1,observedAt:fixtureTime,latestRetry:null,latestAttempt:{id:'A'+'b'.repeat(32),ordinal:1,state:'EXITED_SUCCESS',exit_code:0,failure_reason:null,started_at:fixtureTime-900,finished_at:fixtureTime-300}}};}
  if(operation==='files.list'){if(holdList){holdList=false;await new Promise(resolve=>{releaseList=resolve;listEntered?.();});}return {entries:args.path==='checkpoints'?[{name:'model.bin',type:'file',size:4096}]:[{name:'checkpoints',type:'directory',size:4096},{name:file,type:'file',size:contents.length},{name:'非常长的训练输出文件名称-very-long-model-result.json',type:'file',size:1048576}]};}
  if(operation==='files.direct.prepare')return campus.ticket(args);
  if(operation==='files.get'){assert.equal(args.area,'output');assert.equal(args.project,project);assert.equal(node,machine);assert.equal(args.path,file);assert.equal(args.userId,service.store.jobs.find(row=>row.id===args.runId).userId);return {data:contents.toString('base64'),eof:true};}
  throw Error('Unexpected simulated node call '+operation);
 };
 ({server,service}=await createPortalServer({database:join(directory,'db'),bootstrap,statusPath,origin,secure:false,bridge,directUploadOrigins:[campus.endpoint]}));clearInterval(service.executionTimer);service.reconcile=async()=>{};await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'result-owner',password})).result;await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[machine]:1}});
 const jobs=[admin.principal.userId,member.id].map(userId=>{const id=randomUUID();return {id,userId,machine,project,release,nodeJobId:'J0123456789ab',name:'已完成的训练',cards:1,state:'SUCCEEDED',key:id,cancelRequested:false,createdAt:new Date((fixtureTime-1200)*1000).toISOString(),finishedAt:new Date((fixtureTime-300)*1000).toISOString(),assignedIndices:[],spec:{id,userId,machine,project,release,cards:1,argv:['python','train.py']},latestAttempt:{id:'A'+'b'.repeat(32),ordinal:1,state:'EXITED_SUCCESS',exitCode:0,failureReason:null,startedAt:fixtureTime-900,finishedAt:fixtureTime-300}};});service.store.jobs.push(...jobs);service.save();const before=structuredClone(jobs);
 browser=await chromium.launch({headless:true,args:['--ignore-certificate-errors-spki-list='+campus.spki],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 for(const [index,role] of ['admin','member'].entries()){
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true}),page=await context.newPage(),job=jobs[index];await page.addInitScript(()=>{window.showSaveFilePicker=undefined;});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',guardedRoute(async route=>{if(![origin,campus.endpoint].includes(new URL(route.request().url()).origin)){outside.push(route.request().url());return route.abort();}return route.fallback();}));
  await page.goto(origin);await page.locator('#login-form [name=username]').fill(role==='admin'?'admin':'result-owner');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(id=>document.querySelector('[data-job-pull="'+id+'"]'),job.id);assert.equal(await page.locator('[data-job-pull]').count(),1);assert.equal(await page.locator('[data-job-pull="'+jobs[1-index].id+'"]').count(),0,'admin and member do not get another owner pull entry');
  assert.equal(await page.locator('[data-job-pull]').getAttribute('title'),'请及时将结果下载到自己的电脑；平台不会自动备份或删除。','the existing completion proof gates the result reminder too');
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});await page.screenshot({path:join(shots,'card-'+role+'-'+width+'.png')});
   await page.locator('[data-job-mission="'+job.id+'"]').click();await page.locator('#job-mission [data-job-pull]').waitFor();await settle(page,'#job-mission');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(shots,'mission-'+role+'-'+width+'.png')});await page.locator('[data-mission-close]').click();
   await page.locator('[data-job-detail="'+job.id+'"]').first().click();await page.locator('#job-overview-view [data-job-pull]').waitFor();await settle(page,'.job-log-dialog');await page.screenshot({path:join(shots,'detail-'+role+'-'+width+'.png')});await page.locator('#job-overview-view [data-job-pull]').click();await page.locator('[data-result-path="'+file+'"]').waitFor();await settle(page,'.job-log-dialog');
   assert.equal(await page.locator('#workspace-pull-command').isDisabled(),true);await page.locator('[data-result-path="checkpoints"]').click();await page.locator('[data-result-path="checkpoints/model.bin"]').waitFor();await page.locator('[data-result-path="."]').click();await page.locator('[data-result-path="'+file+'"]').click();
   await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copiedResultCommand=text},configurable:true}));await page.locator('#workspace-pull-command').click();assert.equal(await page.evaluate(()=>copiedResultCommand),'gpuctl pull '+file+' LOCAL_FILE --machine '+machine+' --project '+project+' --job '+job.id);
   const downloadPromise=page.waitForEvent('download');await page.locator('#workspace-download').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),file);assert.deepEqual(await readFile(await download.path()),contents);
   assert(!/已下载|结果总大小/.test(await page.locator('#job-output-view').innerText()));assert.equal(await page.locator('#workspace-upload').isVisible(),false);assert.equal(await page.locator('[name=files]').isVisible(),false,'verified output is a read-only view');assert.equal(await page.locator('#workspace-result').isVisible(),false,'confirmed result directory has no empty status frame');
   const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,rows:[...document.querySelectorAll('.job-result-file')].map(node=>{const name=node.children[1].getBoundingClientRect(),size=node.children[2].getBoundingClientRect(),row=node.getBoundingClientRect();return {left:row.left,right:row.right,height:row.height,nameRight:name.right,sizeLeft:size.left};})}));assert(geometry.scroll<=width+1);assert(geometry.rows.every(row=>row.left>=0&&row.right<=width+1&&row.height>=44&&row.nameRight<=row.sizeLeft+1));
   await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(shots,'output-'+role+'-'+width+'.png')});await page.locator('#close-job-log').click();
  }
  await page.locator('#my-job-table [data-job-pull]').click();await page.locator('[data-result-path="'+file+'"]').waitFor();holdList=true;const held=new Promise(resolve=>listEntered=resolve);await page.locator('#workspace-list').click();await held;await page.locator('#close-job-log').click();releaseList();releaseList=null;listEntered=null;await page.locator('.job-log-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#workspace-output-files').isHidden(),true,'retired directory response cannot paint after the output panel closes');
  // Recheck before opening: historical SUCCEEDED and earlier proof cannot bypass a new UNKNOWN receipt.
  mode='unknown';const readCount=calls.filter(row=>row.operation==='files.list').length;await page.locator('#my-job-table [data-job-pull]').click();await page.locator('#my-job-table [data-job-pull]').waitFor({state:'detached'});assert.equal(await page.locator('.job-log-dialog').isVisible(),false);assert.equal(calls.filter(row=>row.operation==='files.list').length,readCount);mode='success';
  await page.locator('[data-job-detail="'+job.id+'"]').first().click();await page.locator('[data-job-completion-check]').click();await page.locator('#job-overview-view [data-job-pull]').waitFor();await page.locator('#close-job-log').click();
  const foreign=await page.evaluate(async({job,machine,project})=>(await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'files.list',args:{machine,project,area:'output',runId:job,path:'.'}})})).status,{job:jobs[1-index].id,machine,project});assert.equal(foreign,403,'actual Portal rejects another owner, including admin');
  await page.unrouteAll({behavior:'wait'});await context.close();
 }
 assert.deepEqual(jobs,before);assert.equal(calls.some(row=>/submit|cancel|remove|delete|files.put/.test(row.operation)),false);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log('JOB RESULTS UI PASS: verified own task card/detail, output folder navigation, exact run binding, actual single-file download, CLI copy, UNKNOWN recheck refusal, admin/member 1440/390, owner403 and zero mutations.');
}finally{releaseList?.();await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else service?.close();for(const callback of cleanup)await callback();await rm(directory,{recursive:true,force:true});}
