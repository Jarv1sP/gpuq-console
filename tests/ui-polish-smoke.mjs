// Visual and responsive acceptance with synthetic API data only.
// No real accounts, shell, SSH, jobs, credentials, or external requests.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
const screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-ui-polish';
const baseline=process.env.UI_BASELINE==='1',errors=[],external=[],checks=[];
const machine=MACHINES[0].id,release='a'.repeat(64),checkedAt=new Date().toISOString();
const job={id:'11111111-1111-4111-8111-111111111111',machine,userId:'admin',username:'admin',name:'vision-baseline',project:'vision-lab',release,cards:2,state:'RUNNING',priority:'normal',schedulerPriority:2,schedulerState:'RUNNING',schedulerCheckedAt:checkedAt,queueReason:'训练中；普通任务不会自动让位。',assignedIndices:[0,1]};
const state={machines:MACHINES,executionEnabled:true,execution:{priorityCapabilities:{[machine]:true}},
  users:[{id:'admin',name:'实验室管理员',username:'admin',role:'admin',enabled:true,approvedAt:checkedAt,total:8,limits:Object.fromEntries(MACHINES.map(m=>[m.id,m.cards]))}],
  jobs:[job,{...job,id:'22222222-2222-4222-8222-222222222222',name:'ablation / queued experiment',state:'PENDING',priority:'idle',schedulerPriority:0,schedulerState:'PENDING',canSetPriority:true,assignedIndices:[],queueReason:'等待空闲 GPU；最低任务允许让位结束，保留已写入输出。'}],
  gpuq:{checkedAt,stale:false,hosts:MACHINES.map(m=>({id:m.id,reachable:true,checkedAt,
    gpus:Array.from({length:m.cards},(_,index)=>({index,model:m.model,uuid:'GPU-'+m.id+'-'+index,memoryTotalMiB:32768,memoryUsedMiB:index<2?12800:0,utilization:index<2?76:0,temperatureC:index<2?62:31,powerDrawW:index<2?224:18,powerLimitW:450,processesAvailable:true,processes:index===0?[{pid:24018,name:'python train.py',owner:'researcher',memoryUsedMiB:12800,scheduling:{priority:2,jobId:job.id}}]:[]})),
    gpuq:{connected:true,observeOnly:false,jobs:[{id:'node-queue-1',name:'ablation-study',owner:'researcher',state:'PENDING',priority:0,yield_policy:'now',state_reason:'等待空闲 GPU',assigned_gpu_indices:[]}]}}))}};
let server,browser;
try{
  await mkdir(screenshots,{recursive:true});
  server=createServer(async(req,res)=>{
    const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
    if(!/^(index\.html|[a-z-]+\.(js|css))$/.test(file)){res.writeHead(404);res.end();return;}
    try{let content=await readFile(new URL('../dist/'+file,import.meta.url));if(file==='index.html')content=content.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;');res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(content);}catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1080}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin){if(['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();}
    if(url.pathname!=='/api/call')return route.continue();
    const {operation}=route.request().postDataJSON();let result=null;
    if(operation==='projects.list')result={projects:[{project:'vision-lab',state:'READY',environmentMode:'shared',latestReadyRelease:release,releases:[{release,state:'READY'}]}]};
    else if(operation==='projects.status')result={project:'vision-lab',state:'READY',environmentMode:'shared',latestReadyRelease:release,releases:[{release,state:'READY'}]};
    else if(operation==='datasets.list')result={datasets:[]};
    else assert.equal(operation,'state','Visual review cannot mutate data');
    return route.fulfill({contentType:'application/json',body:JSON.stringify({result,state,principal:{userId:'admin',username:'admin',role:'admin'}})});
  });
  await page.goto(origin);await page.locator('#execution-workspace').waitFor();
  await page.locator('[name=workspace-machine]').selectOption(machine);await page.locator('[name=workspace-project] option[value=vision-lab]').waitFor({state:'attached'});
  await page.locator('[name=workspace-project]').selectOption('vision-lab');
  await page.locator('#train-form').evaluate(form=>form.closest('details').open=true);
  await page.locator('[name=command]').fill('python train.py --output /outputs/result.json');
  const capture=async name=>{await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:join(screenshots,name+'.png')});};
  await capture('workspace-desktop');
  assert.match(await page.locator('#self-summary').innerText(),/8/);
  assert.equal(await page.locator('[name=priority] option').count(),3);
  assert.match(await page.locator('#my-job-table').innerText(),/等待空闲 GPU/);
  await page.locator('[data-nav=resources]').click();
  assert.equal(await page.locator('[data-gpu-index]').count(),MACHINES.reduce((n,m)=>n+m.cards,0));
  const first=page.locator('[data-resource-detail="'+machine+':0"]');await first.locator('summary').click();
  await page.locator('.node-queue summary').first().click();
  for(const text of ['76%','12.5','62 °C','24018','python train.py','researcher','等待空闲 GPU'])assert.ok((await page.locator('#machine-grid').innerText()).includes(text),text);
  await capture('resources-desktop');
  for(const width of [1024,900,820,768,390,320]){
    await page.setViewportSize({width,height:960});
    const layout=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,nav:[...document.querySelectorAll('[data-nav]')].filter(el=>!el.hidden).map(el=>({id:el.dataset.nav,visible:el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0,height:el.getBoundingClientRect().height}))}));
    checks.push(layout);
    if(!baseline){assert(layout.document<=width+1,`page overflow at ${width}`);assert(layout.nav.every(nav=>nav.visible&&nav.height>=44),`navigation unavailable at ${width}`);}
    if([820,390].includes(width))await capture('resources-'+width);
    if(width===390){
      await page.locator('.gpu-table-scroll').first().evaluate(el=>el.scrollLeft=el.scrollWidth);await capture('resources-390-processes');
      await page.locator('[data-nav=work]').click();await capture('workspace-mobile');
      assert.equal(await page.locator('[name=command]').inputValue(),'python train.py --output /outputs/result.json');
      if(!baseline)assert.equal(await page.locator('[name=workspace-machine]').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16),true);
      await page.locator('[data-nav=resources]').click();
    }
  }
  await page.setViewportSize({width:820,height:960});
  if(!baseline){
    await page.keyboard.press('Tab');
    await page.locator('.skip-link').focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'main-content');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  if(!baseline)assert.equal(await page.locator('#refresh-state').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await writeFile(join(screenshots,'checks.json'),JSON.stringify({baseline,checks,errors,external},null,2));
  console.log(JSON.stringify({status:'passed',baseline,screenshots,widths:checks.map(x=>x.width),features:['all per-card metrics/processes','raw GPUQ queue','quota','workspace draft','priority choices','320–1440 layout','tablet navigation','keyboard skip link','reduced motion']}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
