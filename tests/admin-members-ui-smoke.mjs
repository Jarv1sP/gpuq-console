// Original Portal account API, disposable accounts, real assets and CSP.
// A delayed invitation reply proves that leaving a section cannot reopen it.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {inspectGeometry} from './layout-geometry.mjs';
import {polishRoomSpecs} from './polish-room-specs.mjs';
import {openMembers} from './admin-members-workflows.mjs';

const output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-admin-members','admin-members');
const temporary=await mkdtemp(join(tmpdir(),'admin-members-')),password='Local-Member-Admin-2026!';
const errors=[],outside=[],requests=[],geometry=[];let server,service,browser;
const reserved=net.createServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+reserved.address().port;await new Promise(resolve=>reserved.close(resolve));
const settle=page=>page.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
try{
  await mkdir(output,{recursive:true});const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  ({server,service}=await createPortalServer({database:join(temporary,'db'),bootstrap,origin,secure:false,
    bridge:async(_machine,operation)=>{if(operation==='projects.list')return {projects:[]};throw Error('Account acceptance cannot execute a node operation');}}));
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(new URL(origin).port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password);
  const applicant=(await service.invoke(admin.token,'users.create',{username:'members-pending',name:'等待审批的同学',password})).result;
  const member=(await service.invoke(admin.token,'users.create',{username:'members-normal',name:'普通成员',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function open(username){
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{globalThis.memberCSP=[];document.addEventListener('securitypolicyviolation',event=>memberCSP.push(event.violatedDirective));});
    await context.route('**/*',guardedRoute(async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);await route.abort();return;}
      if(url.pathname==='/api/call')requests.push({username,...route.request().postDataJSON()});
      await route.continue();
    }));
    await page.goto(origin);await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    return {context,page};
  }
  const {context,page}=await open('admin');
  assert.equal(await page.locator('[data-nav=users]').count(),0,'administrator primary navigation has no member authorization');
  assert.equal(await page.locator('#members-parking').getAttribute('inert'),'');
  assert.equal(await page.locator('#editor').textContent(),'','management controls do not render on the workbench');
  await page.keyboard.press('Control+k');await page.locator('#control-command').fill('成员授权');
  assert.equal(await page.locator('[data-command-id=users]').count(),0);assert.equal(await page.locator('[data-control-attention^="user:"]').count(),0);await page.keyboard.press('Escape');
  await page.locator('#account-menu-toggle').click();await page.locator('#account-menu [data-shell-action=admin]').click();
  await page.locator('#admin-frame').waitFor();await page.locator('#admin-sections [data-admin-section=members]').click();
  await page.locator('#admin-content #page-users').waitFor();
  assert.equal(await page.locator('#admin-sections [data-admin-section=members] span:last-child').innerText(),'成员与额度');
  const sections=await page.locator('#admin-sections [data-admin-section]').evaluateAll(nodes=>nodes.map(node=>node.dataset.adminSection));
  for(const id of ['tasks','storage'])if(sections.includes(id))assert.ok(sections.indexOf(id)<sections.indexOf('members'),'member order30 follows '+id);
  if(sections.includes('maintenance'))assert.ok(sections.indexOf('maintenance')>sections.indexOf('members'),'member order30 precedes maintenance');
  assert.match(await page.locator('#filter-pending').innerText(),/^待处理 1$/);
  assert.equal(await page.locator('[data-user="'+applicant.id+'"]').count(),1,'pending approvals are retained in the backend');
  assert.equal(await page.locator('[data-action=save-policy]').innerText(),'批准授权');
  assert.equal(await page.locator('[data-machine]').count(),MACHINES.length);
  for(const width of [1440,1024,390,320]){
    await page.setViewportSize({width,height:width<760?844:1000});await settle(page);
    const result=await inspectGeometry(page,polishRoomSpecs.members);geometry.push({width,...result});assert.deepEqual(result.failures,[],`member controls at ${width}`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:join(output,'members-admin-'+width+'.png'),fullPage:true,animations:'disabled'});
  }
  await page.locator('[data-machine]').first().check();await page.locator('[data-quota=total]').fill('1');
  await page.evaluate(()=>location.hash='#work');await page.locator('#toast').filter({hasText:'请先保存或撤销授权草稿。'}).waitFor();
  assert.equal(new URL(page.url()).hash,'#admin/members');assert.equal(await page.locator('[data-quota=total]').inputValue(),'1');
  await page.locator('[data-action=reset-draft]').click();
  await page.locator('[data-action=invites]').first().click();await page.locator('#invites-dialog').waitFor();
  await page.evaluate(()=>location.hash='#work');await page.locator('#page-work').waitFor();
  assert.equal(await page.locator('#invites-dialog').isVisible(),false);assert.equal(await page.locator('#invites-content').textContent(),'');
  assert.equal(await page.locator('#members-parking #page-users').count(),1);assert.equal(await page.locator('#editor').textContent(),'');
  await page.setViewportSize({width:390,height:844});await page.locator('[data-nav=me]').click();
  assert.equal(await page.locator('#me-content [data-shell-action=members]').count(),0,'phone menu has no standalone member authorization');
  await page.locator('#me-content [data-shell-action=admin]').click();await openMembers(page);
  await page.evaluate(()=>location.hash='#users');await page.waitForFunction(()=>location.hash==='#admin/members');
  let release,started;const waiting=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>release=resolve);
  const delayed=guardedRoute(async route=>{if(route.request().postDataJSON()?.operation==='invites.list'){started();await hold;}await route.continue();});
  await page.route(origin+'/api/call',delayed);
  await page.locator('[data-action=invites]').first().click();await waiting;
  await page.evaluate(()=>location.hash='#work');await page.locator('#page-work').waitFor();
  const received=page.waitForResponse(response=>response.request().postDataJSON()?.operation==='invites.list');release();await received;await settle(page);
  assert.equal(await page.locator('#invites-dialog').isVisible(),false,'late invitation response does not reopen a retired section');
  assert.equal(await page.locator('#invites-content').textContent(),'');await page.unroute(origin+'/api/call',delayed);
  await openMembers(page);await page.locator('.account-settings>summary').click();await page.locator('[data-action=role]').click();
  await page.locator('#confirm-dialog').waitFor();const mutations=requests.filter(row=>row.operation==='users.role').length;
  await page.evaluate(()=>{globalThis.retiredConfirm=document.querySelector('#confirm-action');location.hash='#work';});await page.locator('#page-work').waitFor();
  await page.evaluate(()=>retiredConfirm.click());await settle(page);
  assert.equal(requests.filter(row=>row.operation==='users.role').length,mutations,'a parked confirmation cannot execute after leaving');
  assert.equal(await page.locator('#confirm-dialog').isVisible(),false);assert.equal(await page.locator('#confirm-message').textContent(),'');
  assert.deepEqual(await page.evaluate(()=>memberCSP),[]);await context.close();
  const regular=await open(member.username);
  for(const width of [1440,1024,390,320]){
    await regular.page.setViewportSize({width,height:width<760?844:1000});await regular.page.evaluate(()=>location.hash='#users');await regular.page.locator('#admin-denied').waitFor();await settle(regular.page);
    assert.equal(await regular.page.locator('[data-nav=users]').count(),0);assert.equal(await regular.page.locator('#admin-content #page-users').count(),0);assert.equal(await regular.page.locator('#editor').textContent(),'');
    assert.equal(await regular.page.locator('#admin-denied h2').innerText(),'需要管理员权限');assert.ok(await regular.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await regular.page.screenshot({path:join(output,'members-denied-'+width+'.png'),fullPage:true,animations:'disabled'});
  }
  assert.equal(requests.filter(row=>row.username===member.username&&/^(invites\.|users\.|policy\.)/.test(row.operation)).length,0,'member deep links never invoke the administrator API');
  assert.deepEqual(await regular.page.evaluate(()=>memberCSP),[]);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  await writeFile(join(output,'checks.json'),JSON.stringify({status:'PASS',geometry,errors,outside,checks:['primary navigation/phone/command removed','pending approvals retained','original server quotas','dirty route guard','legacy backend alias','inert parking','delayed response fence','retired confirmation cannot dispatch','member denial and zero privileged requests']},null,2));
  console.log('ADMIN MEMBERS PASS: original controls in order30, primary entries removed, 1440/1024/390/320, dirty/lifecycle/late replies/retired confirmation/member denial/CSP.');
}finally{
  if(browser)for(const context of browser.contexts())await context.unrouteAll({behavior:'ignoreErrors'});
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else service?.close();await rm(temporary,{recursive:true,force:true});
}
