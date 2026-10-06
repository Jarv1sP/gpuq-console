// Disposable Portal and synthetic state only. An optional untracked manifest
// produces local layout evidence without adding deployment assets to Git.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES as examples} from '../dist/machines.js';
import {checkDelayedResourceFonts,installResourceResizeProbe,waitForResourceFont} from './resource-font-readiness.mjs';

const machines=process.env.PR2_ID_MANIFEST?JSON.parse(await readFile(process.env.PR2_ID_MANIFEST,'utf8')):[
  ...examples.map(machine=>({...machine,id:machine.id+'-node'})),
  {...examples[0],id:'w'.repeat(16)}
];
assert.equal(new Set(machines.map(machine=>machine.id)).size,machines.length);
assert.ok(machines.every(machine=>typeof machine.id==='string'&&Number.isSafeInteger(machine.cards)&&machine.cards>0));
const directory=await mkdtemp(join(tmpdir(),'resource-id-layout-'));
const screenshots=process.env.UI_SCREENSHOTS||join(directory,'screenshots');
const errors=[],external=[],csp=[],calls=[],checks=[],animations=[];
const checkedAt=new Date().toISOString(),release='a'.repeat(64),first=machines[0].id;
const user={id:'layout-user',username:'layout-user',name:'排版验收',role:'member',enabled:true,approvedAt:checkedAt,total:8,limits:Object.fromEntries(machines.map(machine=>[machine.id,machine.cards]))};
const job={id:'11111111-1111-4111-8111-111111111111',userId:user.id,machine:first,project:'layout-check',release,name:'layout-check',cards:1,state:'RUNNING',priority:'normal'};
const state={machines,users:[user],jobs:[job],executionEnabled:true,operationalMaintenance:{version:1,revision:0,global:null,machines:{}},gpuq:{checkedAt,stale:false,hosts:machines.map(machine=>({id:machine.id,reachable:true,checkedAt,gpuq:{connected:true,health:'ok',jobs:[]},gpus:Array.from({length:machine.cards},(_,index)=>({index,model:machine.model,memoryTotalMiB:machine.model.includes('5090')?32768:24576,memoryUsedMiB:index<3?10240:512,utilization:index<3?97:0,temperatureC:45,powerDrawW:180,powerLimitW:575,processesAvailable:true,processes:index===0?[{pid:24018,memoryUsedMiB:10240,...(machine.id===first?{task:{id:job.id,name:job.name,submitter:{name:user.name},state:'RUNNING'}}:{})}]:[]}))}))}};
let server,browser;
try{
  await mkdir(screenshots,{recursive:true});
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port,origin='http://127.0.0.1:'+port;await new Promise(resolve=>reserve.close(resolve));
  const bootstrap=join(directory,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Isolated-ID-Layout-2026!'}),{mode:0o600});
  ({server}=await createPortalServer({database:join(directory,'portal.sqlite'),bootstrap,secure:false,origin}));
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1080}});
  await installResourceResizeProbe(page);
  // Layout data remain synthetic; public runtime now requires a real fixture
  // session before restoring the mocked authenticated state.
  const login=await page.context().request.post(origin+'/api/login',{headers:{Origin:origin},data:{username:'admin',password:'Isolated-ID-Layout-2026!',client:'browser'}});
  assert.equal(login.status(),200);
  await page.addInitScript(()=>{
    globalThis.idAnimations=[];globalThis.idCSP=[];
    document.addEventListener('securitypolicyviolation',event=>idCSP.push(event.violatedDirective));
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(frames,options){if(this.classList.contains('flip-ghost'))idAnimations.push({tag:this.tagName,text:this.textContent,fontSize:getComputedStyle(this).fontSize,frames,options});return animate.call(this,frames,options);};
  });
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){external.push(url.href);return route.abort();}
    if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES=Object.freeze('+JSON.stringify(machines)+');'});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const {operation,args}=request.postDataJSON();calls.push({operation,args});let result=null;
    if(operation==='state'){}
    else if(operation==='projects.list')result={projects:[]};
    else if(operation==='datasets.list')result={datasets:[]};
    else if(operation==='datasets.catalog')result={machine:args.machine,machines:machines.map(machine=>({machine:machine.id,state:'ok'})),datasets:[]};
    else if(operation==='datasets.capacity')result={machine:args.machine,available:false};
    else if(operation==='community.info')result={enabled:true,capabilities:[]};
    else if(operation==='community.posts.list')result={posts:[],nextCursor:null};
    else throw Error('ID layout acceptance must not execute '+operation);
    return route.fulfill({contentType:'application/json',body:JSON.stringify({result,state,principal:{userId:user.id,username:user.username,role:user.role}})});
  });
  const response=await page.goto(origin+'/#resources');assert.equal(response.status(),200);
  await page.locator('.resource-identity').waitFor();await page.evaluate(()=>document.fonts.ready);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===1440?1080:844});
    for(const machine of machines){
      const current=await page.locator('[data-resource-selected]').getAttribute('data-resource-selected');
      if(current!==machine.id)await page.locator(`.resource-mini [data-resource-select="${machine.id}"]`).click();
      await page.waitForFunction(id=>document.querySelector('.resource-identity .resource-id-label')?.textContent===id,machine.id);
      await page.waitForFunction(()=>!document.querySelector('.object-transition-layer'));
      await page.evaluate(()=>scrollTo(0,0));
      await waitForResourceFont(page);
      const identity=await page.locator('.resource-identity').evaluate(element=>{
        const label=element.querySelector('.resource-id-label'),box=label.getBoundingClientRect(),style=getComputedStyle(element);
        return {text:label.textContent,title:label.title,fontSize:parseFloat(style.fontSize),whiteSpace:style.whiteSpace,height:box.height,left:box.left,right:box.right,textWidth:label.scrollWidth,available:label.clientWidth,ellipsis:getComputedStyle(label).textOverflow};
      });
      assert.equal(identity.text,machine.id);assert.equal(identity.title,machine.id);assert.equal(identity.whiteSpace,'nowrap');
      assert.ok(identity.fontSize>= (width<760?40:56)&&identity.fontSize<=160);
      assert.ok(identity.height<=identity.fontSize+1,'An ID must remain one line');
      assert.ok(identity.left>=0&&identity.right<=width,'The name must fit its container');
      if(identity.textWidth>identity.available+1){assert.equal(identity.fontSize,width<760?40:56);assert.equal(identity.ellipsis,'ellipsis');}
      const card=page.locator(`.resource-portrait[data-resource-machine="${machine.id}"]`);
      const chassis=await card.locator('.resource-chassis-scroll').evaluate(element=>({width:element.clientWidth,content:element.scrollWidth}));
      assert.ok(chassis.content<=chassis.width+1,'The complete chassis must fit without panning');
      const bays=await card.locator('[data-resource-card]').evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:box.right,height:element.offsetHeight};}));
      assert.equal(bays.length,machine.cards);assert.ok(bays.every(bay=>bay.left>=0&&bay.right<=width&&bay.height>=44));
      const readings=await card.locator('.resource-portrait-utils>span').evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return {text:element.textContent,left:box.left,right:box.right,width:element.scrollWidth,available:element.clientWidth};}));
      assert.equal(readings.length,machine.cards);assert.ok(readings.every(reading=>reading.left>=0&&reading.right<=width&&reading.width<=reading.available+1));
      for(const other of machines.filter(other=>other.id!==machine.id)){
        const label=page.locator(`.resource-mini[data-resource-machine="${other.id}"] .resource-id-label`);
        assert.equal(await label.textContent(),other.id);assert.equal(await label.getAttribute('title'),other.id);
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const file=machine.id+'-'+width+'.png';await page.screenshot({path:join(screenshots,file),animations:'disabled'});
      await page.screenshot({path:join(screenshots,machine.id+'-'+width+'-full.png'),fullPage:true,animations:'disabled'});
      checks.push({id:machine.id,width,cards:machine.cards,identity,bays,readings,file});
    }
    await page.locator(width<760?'.resource-fleet-actions [data-use-machine]':'#resource-primary').click();
    await page.waitForFunction(id=>document.querySelector('#context-machine')?.value===id,machines.at(-1).id);
    assert.equal(await page.locator('#context-machine').getAttribute('title'),machines.at(-1).id);
    assert.equal(await page.locator('#context-machine').evaluate(element=>getComputedStyle(element).textOverflow),'ellipsis');
    await page.locator('[data-nav=resources]').click();
  }
  await page.setViewportSize({width:1440,height:1080});
  await waitForResourceFont(page);
  const resize=await page.locator('.resource-identity').evaluate(element=>parseFloat(getComputedStyle(element).fontSize));
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(size=>parseFloat(getComputedStyle(document.querySelector('.resource-identity')).fontSize)<size,resize);
  const last=machines.at(-1);await page.locator('.resource-identity .resource-select').click();
  assert.equal(await page.locator('#resource-sheet-title').textContent(),last.id);assert.equal(await page.locator('#resource-sheet-title').getAttribute('title'),last.id);
  await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1080});
  for(const machine of machines){
    const label=page.locator('.cs-server .server-id').filter({hasText:machine.id});assert.equal(await label.count(),1);
    assert.ok((await label.locator('..').getAttribute('title')).startsWith(machine.id+' · '));
    assert.equal(await label.evaluate(element=>getComputedStyle(element).textOverflow),'ellipsis');
  }
  await page.screenshot({path:join(screenshots,'control-ids-1440.png'),animations:'disabled'});
  animations.push(...await page.evaluate(()=>idAnimations));
  assert.ok(animations.length,'Switching identities retains the approved shared-element motion');
  for(const animation of animations){assert.equal(animation.options.duration,320);assert.ok(!animation.text.includes('→'),'Only the ID travels, without the side-card arrow');if(animation.tag==='SPAN'){const scale=animation.frames.at(-1).transform.match(/scale\(([^,]+),([^)]+)\)/);assert.ok(scale);assert.equal(Number(scale[1]),Number(scale[2]),'Text shares uniform scaling even when the final ID is ellipsized');assert.ok(parseFloat(animation.fontSize)>=24,'The ghost retains the source typography');}}
  const fontReadiness=await checkDelayedResourceFonts(page,origin);
  csp.push(...await page.evaluate(()=>idCSP));assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(csp,[]);
  assert.ok(calls.every(call=>['state','projects.list','datasets.list','datasets.catalog','datasets.capacity','community.info','community.posts.list'].includes(call.operation)));
  await writeFile(join(screenshots,'checks.json'),JSON.stringify({checks,animations,errors,external,csp,fontReadiness,privateManifest:!!process.env.PR2_ID_MANIFEST},null,2));
  console.log(JSON.stringify({status:'passed',names:machines.length,views:checks.length,screenshots,errors,external,csp,fontReadiness}));
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(directory,{recursive:true,force:true});}
