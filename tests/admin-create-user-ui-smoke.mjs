import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
import {openMembers} from './admin-members-workflows.mjs';
import {inspectGeometry} from './layout-geometry.mjs';

const temporary=await mkdtemp(join(tmpdir(),'admin-create-user-')),output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-admin-create-user','create-user');
const password='Local-Account-Fixture-2026!',errors=[],outside=[],requests=[];
let server,service,browser,mode='normal',release,started;
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const settle=page=>page.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();});
try{
  await mkdir(output,{recursive:true});const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  ({server,service}=await createPortalServer({database:join(temporary,'db'),bootstrap,origin,secure:false,bridge:async(_machine,operation)=>{if(operation==='projects.list')return {projects:[]};throw Error('Accounts never execute a node operation');}}));
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);await new Promise(resolve=>server.listen(new URL(origin).port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),key='stargate.create-user.v1:'+admin.principal.userId;
  const member=(await service.invoke(admin.token,'users.create',{username:'create-member',password})).result;await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>{globalThis.createUserCSP=[];document.addEventListener('securitypolicyviolation',event=>createUserCSP.push(event.violatedDirective));});
  await context.route('**/*',guardedRoute(async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin&&!['blob:','data:'].includes(url.protocol)){outside.push(url.href);return route.abort();}
    if(url.pathname==='/api/call'){
      const request=route.request().postDataJSON();requests.push(request);
      if(request.operation==='users.create'){
        assert.equal(request.args.role,'member');assert.equal(Object.keys(request.args).some(name=>['limits','total','enabled'].includes(name)),false);
        if(mode==='refused'){mode='normal';return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'只有管理员可以创建账号。'})});}
        if(mode==='lost'){mode='normal';await route.fetch();return route.abort('failed');}
        if(mode==='incomplete'){mode='normal';await route.fetch();return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{}})});}
        if(mode==='delayed'){mode='normal';const response=await route.fetch();started();await new Promise(resolve=>release=resolve);return route.fulfill({response});}
      }
    }
    return route.continue();
  }));
  const login=async username=>{await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});};
  const form=page.locator('#create-user-form'),open=async()=>{await openMembers(page);await page.locator('[data-member-create]').click();await page.locator('#create-user-dialog[open]').waitFor();};
  const fill=async username=>{await form.locator('[name=username]').fill(username);await form.locator('[name=name]').fill('新建同学');await form.locator('[name=password]').fill(password);};
  const count=()=>requests.filter(row=>row.operation==='users.create').length;
  await page.goto(origin);await login('admin');assert.equal(await page.locator('#create-user-dialog').count(),0,'no account form mounted on main');await open();
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});await settle(page);
    const result=await inspectGeometry(page,{roots:['#create-user-dialog'],controls:'button,input',containment:'button,input',scrollPanels:['#create-user-dialog']});assert.deepEqual(result.failures,[],JSON.stringify({width,...result}));
    if(width<760)for(const button of await form.locator('button:visible').all())assert.ok((await button.boundingBox()).height>=44);
    await page.screenshot({path:join(output,'new-account-'+width+'.png'),animations:'disabled'});
  }
  await fill('created-zero');await form.locator('[type=submit]').click();await page.locator('#create-user-dialog').waitFor({state:'hidden'});
  const created=service.store.users.find(user=>user.username==='created-zero');assert(created);assert.equal(created.role,'member');assert.equal(created.total,0);assert.deepEqual(created.limits,{});
  assert.equal(await page.locator('.user-row.selected').getAttribute('data-user'),created.id);assert.equal(await page.locator('[data-action=save-policy]').innerText(),'批准授权');assert.equal(await page.locator('#editor h2').innerText(),'新建同学');
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);assert.equal((await service.login(created.username,password)).principal.userId,created.id);
  await page.locator('[data-machine]').first().check();assert.equal(await page.locator('[data-member-create]').isDisabled(),true,'a quota draft cannot be discarded by creating an account');await page.locator('[data-action=reset-draft]').click();
  await open();mode='refused';await fill('create-refused');const beforeRefusal=count();await form.locator('[type=submit]').click();await page.locator('[data-create-user-error]').filter({hasText:'只有管理员可以创建账号。'}).waitFor();assert.equal(count(),beforeRefusal+1);assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);assert.equal(service.store.users.some(user=>user.username==='create-refused'),false);await page.locator('[data-create-user-close]').first().click();
  for(const failure of ['lost','incomplete']){
    await open();mode=failure;const username='create-'+failure;await fill(username);const before=count();await form.locator('[type=submit]').click();await page.locator('[data-create-user-error]').filter({hasText:'结果未确认'}).waitFor();
    assert.equal(count(),before+1);assert.equal(await form.locator('[type=submit]').isVisible(),false);assert.equal(await form.locator('[name=password]').inputValue(),'');
    const saved=await page.evaluate(key=>localStorage.getItem(key),key);assert.deepEqual(JSON.parse(saved),{username});assert.equal(saved.includes(password),false);
    await page.reload();await page.locator('[data-member-create]').click();await page.locator('[data-create-user-state]').filter({hasText:'创建结果待确认'}).waitFor();
    await page.locator('[data-create-user-query]').click();await page.locator('#create-user-dialog').waitFor({state:'hidden'});assert.equal(count(),before+1,'recovery only queries the directory, never replays creation');assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);
  }
  await open();mode='delayed';const waiting=new Promise(resolve=>started=resolve);await fill('create-retired');const beforeDelayed=count();await form.locator('[type=submit]').click();await waiting;
  await page.evaluate(()=>{globalThis.retiredCreateForm=document.querySelector('#create-user-form');retiredCreateForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));location.hash='#work';});await page.locator('#page-work').waitFor();assert.equal(count(),beforeDelayed+1);
  const received=page.waitForResponse(response=>response.request().postDataJSON()?.operation==='users.create');release();await received;await settle(page);assert.equal(await page.locator('#create-user-dialog').count(),0,'late receipt never opens a retired admin form');
  await page.evaluate(()=>retiredCreateForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle(page);assert.equal(count(),beforeDelayed+1,'retired form has no write handlers');
  await page.evaluate(({key})=>localStorage.setItem(key,JSON.stringify({username:'only-first-admin'})),{key});
  await page.locator('#account-menu-toggle').click();await page.locator('#switch-account').click();await login(member.username);await page.evaluate(()=>location.hash='#admin/members');await page.locator('#admin-denied').waitFor();
  assert.equal(await page.locator('#create-user-dialog').count(),0);assert.equal(await page.locator('[data-member-create]').isVisible(),false);assert.equal(await page.locator('#admin-content [data-member-create]').count(),0);
  const memberLogin=await service.login(member.username,password);await assert.rejects(service.invoke(memberLogin.token,'users.create',{username:'forbidden-new',password}),error=>error.status===403);assert.equal(service.store.users.some(user=>user.username==='forbidden-new'),false);
  const other=(await service.invoke(admin.token,'users.create',{username:'create-other-admin',password,role:'admin'})).result;
  await page.locator('#account-menu-toggle').click();await page.locator('#switch-account').click();await login(other.username);await open();assert.equal(await form.locator('[name=username]').inputValue(),'');assert.equal(await page.locator('[data-create-user-query]').isVisible(),false,'another account cannot inherit the first admin intent');
  assert.deepEqual(await page.evaluate(()=>createUserCSP),[]);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log('CREATE USER PASS: zero-quota member, original approval, draft, 403, lost/incomplete receipt query-only/reload, no persisted password, retired/account/member boundaries, 1440/390/320.');
}finally{
  if(browser)for(const context of browser.contexts())await context.unrouteAll({behavior:'ignoreErrors'});await browser?.close();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else service?.close();await rm(temporary,{recursive:true,force:true});
}
