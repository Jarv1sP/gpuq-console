// Actual Portal, cookie identity, CSP and source assets; only nodes are fixtures.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {accountMenu,openSubmit,closeSubmit} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';

const root=await mkdtemp(join(tmpdir(),'project-directory-ui-')),shots=join(process.env.UI_SCREENSHOTS||'/tmp/project-directory-ui','directory');
const password='Directory-Fixture-Only-2026!',source=MACHINES[1].id,other=MACHINES[0].id,release='c'.repeat(64);
const projects=new Map(),calls=[],errors=[],outside=[],csp=[],http=[];
const key=(machine,user,project)=>JSON.stringify([machine,user,project]);
let server,service,browser;
const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));const origin='http://127.0.0.1:'+port;
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(root,'bootstrap'),statusPath=join(root,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(machine=>({id:machine.id,reachable:true,checkedAt:new Date().toISOString(),gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:20*1024**3,usableBytes:492*1024**3,totalInodes:100000,availableInodes:50000,inodeUsageKnown:true,guarded:true};
    if(operation==='projects.list')return {environmentModes:machine===source?['shared','isolated','oci']:['shared','isolated'],projects:[...projects].filter(([id])=>{const [m,u]=JSON.parse(id);return m===machine&&u===args.userId;}).map(([,info])=>structuredClone(info))};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**3,availableBytes:512*1024**2,reserveBytes:16*1024**2,usableBytes:496*1024**2,guarded:true};
    const id=key(machine,args.userId,args.project);
    if(operation==='projects.create'){assert.equal(machine,source);assert.equal(args.environmentMode,'oci');const info={project:args.project,environmentMode:'oci',state:'DRAFT',releases:[]};projects.set(id,info);return structuredClone(info);}
    if(operation==='projects.status'){assert.ok(projects.has(id));assert.equal(args.key,undefined);return structuredClone(projects.get(id));}
    if(operation==='projects.publish'){assert.ok(projects.has(id));assert.match(args.key,/^[a-f0-9-]{36}$/);const info=projects.get(id);info.state='READY';info.publication={id:args.key,state:'READY',release};info.releases=[{state:'READY',release}];info.latestReadyRelease=release;return structuredClone(info);}
    if(operation==='terminal.open'){assert.equal(machine,source);assert.equal(args.hostAdmin,false);assert.equal(args.project,'new-container');return {id:randomUUID(),writerToken:randomUUID()};}
    if(operation==='terminal.exchange')return {offset:0,data:'',exited:false};
    if(operation==='terminal.close')return {closed:true};
    if(operation==='terminal.detach')return {detached:true};
    throw Error('Unexpected directory fixture operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(root,'portal.sqlite'),bootstrap,statusPath,bridge,secure:false,origin}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'directory-member',password})).result,zero=(await service.invoke(admin.token,'users.create',{username:'directory-zero',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:8,limits:{[source]:Math.min(4,MACHINES[1].cards),[other]:Math.min(4,MACHINES[0].cards)}});
  for(const [machine,mode] of [[source,'oci'],[other,'shared']])projects.set(key(machine,member.id,'same-name'),{project:'same-name',environmentMode:mode,state:'READY',releases:[{state:'READY',release}],latestReadyRelease:release});
  projects.set(key(source,'builtin-admin','admin-container'),{project:'admin-container',environmentMode:'oci',state:'READY',releases:[{state:'READY',release}],latestReadyRelease:release});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1080}}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));page.on('response',async response=>{if(response.status()>=400)http.push([response.status(),response.request().postDataJSON()?.operation,await response.text()]);});
  await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>{globalThis.directoryCSP??=[];directoryCSP.push(event.violatedDirective);}));
  await page.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol)){await route.fallback();return;}outside.push(url.href);await route.abort();}));
  const response=operation=>page.waitForResponse(value=>value.url()===origin+'/api/call'&&value.request().postDataJSON()?.operation===operation);
  async function action(operation,fn){const pending=response(operation);await fn();const value=await pending;assert.equal(value.status(),200,await value.text());await idle();}
  async function idle(){await page.waitForFunction(()=>document.querySelector('[name=workspace-project]')&&!document.querySelector('[name=workspace-project]').disabled);}
  async function login(username){await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=work]').click();}
  async function assertPrompt(label,empty,title){
    await page.waitForFunction(value=>document.querySelector('#context-machine option[value=""]')?.textContent===value,empty);
    assert.equal(await page.locator('#context-machine').evaluate(select=>[...select.closest('label').childNodes].find(node=>node.nodeType===Node.TEXT_NODE)?.textContent.trim()),label);
    assert.equal(await page.locator('#context-machine').getAttribute('title'),title);
    if(label==='训练')assert.equal(await page.locator('#context-machine').evaluate(select=>{const text=select.closest('.server-select').querySelector('.server-id-head');return text.scrollWidth<=text.clientWidth+1;}),true,'the complete training prompt is readable without an ellipsis');
  }
  async function capture(role){
    for(const width of [1440,1024,390,320]){await page.setViewportSize({width,height:1080});await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'all original content remains within the viewport');await page.screenshot({path:join(shots,role+'-'+width+'.png'),fullPage:true});}
  }

  await login('directory-member');await idle();
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'');
  const duplicates=await page.locator('[name=workspace-project] option[data-project=same-name]').evaluateAll(options=>options.map(option=>({value:option.value,machine:option.dataset.machine})));
  assert.equal(duplicates.length,2);assert.notEqual(duplicates[0].value,duplicates[1].value);
  await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption(duplicates.find(item=>item.machine===source).value));
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'','choosing a container never requires a prior topbar choice');
  assert.equal(await page.locator('[name=terminal-machine]').inputValue(),source);
  assert.equal(await page.locator('[name=training-target]').inputValue(),'auto');
  assert.equal(await page.locator('#page-title').textContent(),'same-name','encoded selector identities are never shown as a title');
  assert.equal(calls.filter(call=>call.operation==='projects.status').at(-1).machine,source);
  await assertPrompt('训练','自动选择','自动选择兼容服务器');
  assert.match(await page.locator('#context-machine').getAttribute('aria-label'),/开发位置保持不变/);
  for(const width of [1440,1024,390,320]){
    await page.setViewportSize({width,height:1080});await assertPrompt('训练','自动选择','自动选择兼容服务器');
    assert.equal(await page.locator('#context-project').inputValue(),await page.locator('[name=workspace-project]').inputValue());
    assert.equal(await page.locator('#context-project option:checked').getAttribute('data-machine'),source);
    const projectGeometry=await page.locator('#context-project').evaluate(select=>{const style=getComputedStyle(select),canvas=document.createElement('canvas'),measure=canvas.getContext('2d');measure.font=[style.fontStyle,style.fontWeight,style.fontSize,style.fontFamily].join(' ');return {width:innerWidth,usable:select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),needed:measure.measureText(select.selectedOptions[0].dataset.project).width};});
    assert.ok(projectGeometry.usable>=projectGeometry.needed,'the short selected project name remains readable beside the training prompt: '+JSON.stringify(projectGeometry));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(shots,`member-auto-training-${width}.png`),fullPage:true});
  }await page.setViewportSize({width:1440,height:1080});
  await openSubmit(page);await page.locator('[name=training-target]').selectOption('current');await assertPrompt('训练','开发位置',source);
  assert.equal(await page.locator('[name=terminal-machine]').inputValue(),source);
  await page.locator('[name=training-target]').selectOption('auto');await assertPrompt('训练','自动选择','自动选择兼容服务器');await closeSubmit(page);
  await page.screenshot({path:join(shots,'member-no-server-1440.png'),fullPage:true});
  await page.locator('[name=workspace-machine]').selectOption(other);await idle();
  assert.equal(await page.locator('[name=terminal-machine]').inputValue(),source,'focus changes never move the developer terminal');
  assert.equal(await page.locator('[name=workspace-project] option:checked').getAttribute('data-machine'),source);
  await assertPrompt('服务器','可选服务器',other);
  assert.match(await page.locator('#project-location').textContent(),new RegExp(source));
  await capture('member');
  const sharedValue=await page.locator('[name=workspace-project] option[data-project=same-name]').evaluateAll((options,machine)=>options.find(option=>option.dataset.machine===machine).value,other);
  await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption(sharedValue));
  await assertPrompt('服务器','请选择服务器',other);
  assert.equal(await page.locator('[name=training-target]').inputValue(),'current','shared projects keep their explicit-server training contract');
  await page.locator('[name=workspace-machine]').selectOption('');await idle();
  await assertPrompt('服务器','请选择服务器','');
  // The storage shortcut chooses an existing owner project without creating or submitting.
  await action('projects.status',()=>page.evaluate(({machine,userId})=>document.dispatchEvent(new CustomEvent('gpuq-open-project',{detail:{machine,project:'same-name',userId,authGeneration:1}})),{machine:source,userId:member.id}));
  assert.equal(calls.filter(call=>['projects.create','projects.publish','jobs.submit'].includes(call.operation)).length,0);
  // Return to no topbar selection and create on the node which actually admitted OCI.
  await page.locator('[name=workspace-machine]').selectOption('');await page.locator('[name=workspace-project]').selectOption('');await idle();
  await page.locator('#project-create>summary').click();assert.equal(await page.locator('[name=environment-mode]').inputValue(),'oci');assert.equal(await page.locator('[name=environment-choice]').count(),0);await page.locator('[name=new-project]').fill('new-container');
  await page.setViewportSize({width:390,height:1080});await page.locator('#project-create').scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'member-create-no-server-390.png'),fullPage:true});
  await action('projects.create',()=>page.locator('#project-create-form [type=submit]').click());
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'');
  const created=calls.filter(call=>call.operation==='projects.create');assert.equal(created.length,1);assert.equal(created[0].machine,source);assert.equal(created[0].args.project,'new-container');
  await action('terminal.open',()=>page.locator('#terminal-open').click());await page.locator('.terminal-dialog').waitFor({state:'visible'});
  page.once('dialog',value=>value.accept());await action('terminal.close',()=>page.locator('#terminal-stop').click());await page.locator('.terminal-dialog').waitFor({state:'hidden'});
  // A missing publish reply still confirms only the original key and original source.
  let dropped=false;await page.route(origin+'/api/call',guardedRoute(async route=>{if(!dropped&&route.request().postDataJSON()?.operation==='projects.publish'){dropped=true;await route.fetch();await route.abort();return;}await route.fallback();}));
  await action('projects.status',()=>page.locator('#project-publish').click());assert.match(await page.locator('#project-status').textContent(),/训练版本已生成/);
  const published=calls.filter(call=>call.operation==='projects.publish');assert.equal(published.length,1);assert.equal(published[0].machine,source);assert.equal(projects.get(key(source,member.id,'new-container')).publication.id,published[0].args.key);
  await openSubmit(page);assert.equal(await page.locator('[name=training-target]').inputValue(),'auto');assert.equal(await page.locator('[name=machine]').inputValue(),source);await closeSubmit(page);
  await accountMenu(page);await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor({state:'visible'});
  await login('admin');await idle();await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption('admin-container'));assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'');assert.equal(await page.locator('[name=workspace-project] option[data-project=same-name]').count(),0,'member catalog does not survive an account switch');await capture('admin');
  csp.push(...await page.evaluate(()=>globalThis.directoryCSP||[]));
  await accountMenu(page);await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor({state:'visible'});
  const before=calls.length;await login('directory-zero');await page.locator('#project-create').waitFor();assert.equal(await page.locator('#project-create-form [type=submit]').isDisabled(),true);assert.equal(await page.locator('[name=environment-choice]').count(),0);assert.equal(await page.locator('#project-create-availability').textContent(),'暂无服务器授权');assert.equal(calls.length,before,'zero authorization sends no node calls');
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);assert.deepEqual(csp,[]);assert.deepEqual(http,[]);
  console.log(JSON.stringify({status:'PASS',checks:['global own directory with exact duplicate-name identity','create without topbar using confirmed node OCI capability','focus changes retain development source','terminal source and confirmed end flow','lost publish reply pins the same key and source','AUTO training without a topbar machine','account switch and zero authorization','member/admin 1440/1024/390/320 no horizontal overflow, scripts, CSP or external requests'],shots}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
