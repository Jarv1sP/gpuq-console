// UI contract acceptance with loopback static assets and synthetic API replies.
// No real accounts, execution bridge, SSH, shell commands or GPU jobs are used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';

const screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-priority-ui',errors=[],blocked=[],calls=[];
const [machine,legacy]=MACHINES.map(item=>item.id),checkedAt='2026-09-29T08:00:00Z';
const baseJob={machine,cards:1,schedulerCheckedAt:checkedAt,schedulerState:'PENDING',queueReason:'等待空闲 GPU；已有普通任务不会自动中断。',state:'PENDING',priority:'normal',schedulerPriority:2,canSetPriority:true};
const jobs=[{...baseJob,id:'queue-1',userId:'admin',username:'admin',name:'长名称训练任务 / priority draft fixture'},
  {...baseJob,id:'running-1',userId:'member',username:'member',name:'normal-running',state:'RUNNING',schedulerState:'RUNNING',queueReason:'任务正在运行',canSetPriority:false},
  {...baseJob,id:'legacy-1',userId:'admin',username:'admin',name:'legacy-unknown',priority:null,schedulerPriority:null,schedulerCheckedAt:null,queueReason:null,canSetPriority:false},
  {...baseJob,id:'preempted-1',userId:'member',username:'member',name:'idle-preempted',priority:'idle',schedulerPriority:0,state:'CANCELED',schedulerState:'CANCELED',queueReason:'最低任务已让位结束，不重新排队。',preempted:true,canSetPriority:false}];
let browser,server;
try{
  await mkdir(screenshots,{recursive:true});
  server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname,filename=path==='/'?'index.html':path.slice(1);
    if(!/^(index\.html|[a-z-]+\.(?:js|css))$/.test(filename)){res.writeHead(404);res.end();return;}
    try{let content=await readFile(new URL('../dist/'+filename,import.meta.url));if(filename==='index.html')content=content.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;');res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'});res.end(content);}catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function open(role,capabilityMap={[machine]:true,[legacy]:false}){
    const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage(),principal={userId:role,username:role,role};
    const state=()=>({machines:MACHINES,executionEnabled:true,...(capabilityMap===null?{}:{execution:{priorityCapabilities:capabilityMap}}),
      users:(role==='admin'?['admin','member']:['member']).map(id=>({id,name:id,username:id,role:id,enabled:true,total:8,limits:{[machine]:4,[legacy]:4}})),
      jobs:structuredClone(jobs.filter(job=>role==='admin'||job.userId===role).map(job=>({...job,canSetPriority:job.canSetPriority&&capabilityMap?.[job.machine]===true}))),gpuq:{checkedAt,stale:false,hosts:MACHINES.map(item=>({id:item.id,reachable:true,gpus:[],gpuq:{connected:true,jobs:[]}}))}});
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin){if(['data:','blob:'].includes(url.protocol))return route.continue();blocked.push(url.href);return route.abort();}
      if(url.pathname!=='/api/call')return route.continue();
      const {operation,args={}}=route.request().postDataJSON();calls.push({role,operation,args});let result=null,status=200,error;
      if(operation==='projects.list')result={projects:[]};
      else if(operation==='jobs.submit'){const controlled=args.machine===machine&&Object.hasOwn(args,'priority');result={...baseJob,...args,id:'submitted-'+calls.length,userId:role,username:role,priority:controlled?args.priority:null,schedulerPriority:controlled?{idle:0,normal:2,high:4}[args.priority]:null,canSetPriority:controlled};jobs.push(result);}
      else if(operation==='jobs.priority'){
        const job=jobs.find(item=>item.id===args.jobId);
        if(role!=='admin'||!job?.canSetPriority){status=403;error='排队优先级不可修改';}
        else if(job.priority!==args.expectedPriority){status=409;error='优先级已改变，请刷新并重新选择。';}
        else{job.priority=args.priority;job.schedulerPriority={idle:0,normal:2,high:4}[args.priority];result=job;}
      }else if(operation!=='state'){status=400;error='Unexpected mock operation: '+operation;}
      return route.fulfill({status,contentType:'application/json',body:JSON.stringify(error?{error}:{result,state:state(),principal})});
    });
    await page.goto(origin);await page.locator('#execution-workspace').waitFor();return page;
  }
  const responseFor=(page,operation)=>page.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation===operation);
  async function refresh(page,keepFocus=false){const ready=responseFor(page,'state');if(keepFocus)await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));else await page.locator('#refresh-state').click();await ready;await page.waitForFunction(()=>!document.querySelector('#train-form [name=priority]').disabled||!document.querySelector('[name=workspace-machine]').value);}
  async function selectMachine(page,value){const ready=responseFor(page,'projects.list');await page.locator('[name=workspace-machine]').selectOption(value);await ready;await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);}
  async function capture(page,name){await page.evaluate(()=>{document.querySelector('#toast').classList.remove('visible');for(const table of document.querySelectorAll('.task-table-wrap'))table.scrollTop=0;scrollTo(0,0);});await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('#toast')).opacity)===0);await page.screenshot({path:join(screenshots,name),fullPage:true});}

  const member=await open('member');await selectMachine(member,machine);await member.locator('#train-form').evaluate(form=>form.closest('details').open=true);
  assert.equal(await member.locator('[name=priority]').inputValue(),'normal');assert.equal(await member.locator('[name=priority] option[value=high]').count(),0);
  assert.equal(await member.locator('[data-job-priority]').count(),0);
  await member.locator('[name=priority]').selectOption('idle');await member.locator('[name=command]').fill('python keep_my_draft.py');
  assert.match(await member.locator('#priority-note').textContent(),/结束进程/);await refresh(member);
  assert.equal(await member.locator('[name=priority]').inputValue(),'idle');assert.equal(await member.locator('[name=command]').inputValue(),'python keep_my_draft.py');
  await selectMachine(member,legacy);assert.equal(await member.locator('[name=priority]').inputValue(),'idle','unavailable capability does not silently change an interruptible draft');assert.equal(await member.locator('#train-form [type=submit]').isDisabled(),true);assert.match(await member.locator('#priority-note').textContent(),/尚未确认支持/);
  await member.locator('[name=priority]').selectOption('normal');assert.equal(await member.locator('#train-form [type=submit]').isEnabled(),true);assert.match(await member.locator('#priority-note').textContent(),/服务器原有策略提交/);
  const legacySubmitted=responseFor(member,'jobs.submit');await member.locator('#train-form [type=submit]').click();await legacySubmitted;assert.equal(Object.hasOwn(calls.findLast(item=>item.operation==='jobs.submit').args,'priority'),false,'legacy default must not assert a new scheduler policy');
  await selectMachine(member,machine);await member.locator('[name=priority]').selectOption('idle');const submitted=responseFor(member,'jobs.submit');await member.locator('#train-form [type=submit]').click();await submitted;
  assert.equal(calls.findLast(item=>item.operation==='jobs.submit').args.priority,'idle');assert.match(await member.locator('#my-job-table').textContent(),/让位结束/);
  await capture(member,'priority-member-desktop.png');await member.setViewportSize({width:390,height:844});await capture(member,'priority-member-mobile.png');assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));

  const admin=await open('admin');await selectMachine(admin,machine);assert.equal(await admin.locator('[name=priority] option[value=high]').count(),1);
  await admin.locator('[data-nav=users]').click();await admin.locator('.team-jobs summary').click();
  const select=admin.locator('#all-jobs [data-job-priority="queue-1"]');assert.equal(await select.count(),1);assert.equal(await admin.locator('#all-jobs [data-job-priority="running-1"]').count(),0);assert.equal(await admin.locator('#all-jobs [data-job-priority="legacy-1"]').count(),0);
  await select.selectOption('high');await select.focus();await refresh(admin,true);assert.equal(await select.inputValue(),'high');assert.equal(await select.evaluate(el=>el===document.activeElement),true);
  // A concurrent admin update must not replace the edit baseline during polling.
  jobs[0].priority='idle';await refresh(admin,true);assert.equal(await select.inputValue(),'high');assert.equal(await select.getAttribute('data-original-priority'),'normal');
  let saved=responseFor(admin,'jobs.priority');await admin.locator('#all-jobs [data-job-priority-save="queue-1"]').click();assert.equal((await saved).status(),409);assert.equal(await select.inputValue(),'high');assert.match(await admin.locator('#toast').textContent(),/已改变/);
  jobs[0].priority='normal';await refresh(admin);saved=responseFor(admin,'jobs.priority');await admin.locator('#all-jobs [data-job-priority-save="queue-1"]').click();assert.equal((await saved).status(),200);assert.equal(jobs[0].priority,'high');
  assert.deepEqual(calls.findLast(item=>item.operation==='jobs.priority').args,{jobId:'queue-1',priority:'high',expectedPriority:'normal'});
  await capture(admin,'priority-admin-desktop.png');await admin.setViewportSize({width:390,height:844});await capture(admin,'priority-admin-mobile.png');assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const oldAdmin=await open('admin',null);await selectMachine(oldAdmin,machine);await oldAdmin.locator('#train-form').evaluate(form=>form.closest('details').open=true);
  for(const priority of ['idle','high'])assert.equal(await oldAdmin.locator('[name=priority] option[value='+priority+']').evaluate(node=>node.disabled),true);
  assert.equal(await oldAdmin.locator('[data-job-priority]').count(),0);assert.equal(await oldAdmin.locator('#train-form [type=submit]').isEnabled(),true);
  const oldSubmitted=responseFor(oldAdmin,'jobs.submit');await oldAdmin.locator('#train-form [type=submit]').click();await oldSubmitted;assert.equal(Object.hasOwn(calls.findLast(item=>item.operation==='jobs.submit').args,'priority'),false,'older state without execution capabilities preserves the exact normal submit wire');
  await oldAdmin.context().close();
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log(JSON.stringify({status:'passed',screenshots,checks:['member normal/idle only','capability-unknown restriction without draft replacement','submit priority','confirmed preemption label','admin queued-only editing','refresh retains draft and focus','concurrent edit baseline conflict','390px no overflow','no external requests']}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
