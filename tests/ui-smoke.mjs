// Browser acceptance: npm ci --ignore-scripts && npx playwright install chromium
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=await mkdtemp(join(tmpdir(),'amax-ui-')),password='UI-Test-Only-Password-2026';let server,browser;
try{
 const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin=`http://127.0.0.1:${port}`;
 const portal=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async()=>({ok:true})});server=portal.server;await new Promise(r=>server.listen(port,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const admin=await browser.newPage({viewport:{width:1440,height:1050}}),member=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
 for(const p of [admin,member])p.on('pageerror',e=>errors.push(e.message));
 async function login(p,name){await p.goto(origin);await p.locator('#login-form [name=username]').fill(name);await p.locator('#login-form [name=password]').fill(password);await p.locator('#login-form [type=submit]').click();await p.locator('#login-dialog').waitFor({state:'hidden'});}
 await login(admin,'admin');await admin.locator('[data-nav=users]').click();assert.equal(await admin.locator('#add-user').count(),0);
 await admin.locator('.management-toolbar [data-action=invites]').click();await admin.locator('[data-action=rotate-invite]').click();await admin.locator('#confirm-action').click();const code=await admin.locator('#current-invite').inputValue();assert.ok(code.startsWith('AMAX-U-'));
 await admin.locator('[data-close=invites-dialog]').click();await admin.reload();await admin.locator('.management-toolbar [data-action=invites]').click();assert.equal(await admin.locator('#current-invite').inputValue(),code);await admin.locator('[data-close=invites-dialog]').click();
 await member.goto(origin);await member.locator('#open-register').click();for(const [name,value] of Object.entries({username:'验收同学',password,confirm:password,invite:code}))await member.locator(`#register-form [name=${name}]`).fill(value);await member.locator('#register-form [type=submit]').click();await member.locator('#register-dialog').waitFor({state:'hidden'});
 assert.equal(await member.locator('[data-nav=users]').isVisible(),false);assert.equal(await member.locator('#page-resources').isVisible(),true);assert.match(await member.locator('#resource-summary').textContent(),/我的额度：0/);assert.equal(await member.locator('[data-use-machine]:enabled').count(),0);
 // Verify automatic registration discovery, without pressing refresh.
 await admin.locator('[data-user]').filter({hasText:'验收同学'}).waitFor({timeout:22000});await admin.locator('[data-user]').filter({hasText:'验收同学'}).click();await admin.locator('[data-machine=gpu-1]').check();await admin.locator('[data-quota=gpu-1]').fill('2');await admin.locator('[data-quota=total]').fill('2');
 await admin.waitForTimeout(16000);assert.equal(await admin.locator('[data-quota=gpu-1]').inputValue(),'2');await admin.locator('[data-action=save-policy]').click();
 await member.waitForFunction(()=>document.querySelector('#resource-summary').textContent.includes('我的额度：2'),{},{timeout:22000});await member.locator('[data-use-machine=gpu-1]').click();await member.locator('summary').filter({hasText:'提交训练'}).click();await member.locator('[name=command]').fill('python unchanged_draft.py');await member.waitForTimeout(16000);assert.equal(await member.locator('[name=command]').inputValue(),'python unchanged_draft.py');
 await admin.locator('#filter-all').click();await admin.locator('[data-user]').filter({hasText:'验收同学'}).click();await admin.locator('summary').filter({hasText:'账号权限与状态'}).click();await admin.locator('[data-action=role]').click();await admin.locator('#confirm-action').click();
 await member.reload();await member.locator('#login-dialog').waitFor();await member.locator('#login-form [name=username]').fill('验收同学');await member.locator('#login-form [name=password]').fill(password);await member.locator('#login-form [type=submit]').click();await member.locator('[data-nav=users]').click();await member.locator('#filter-all').click();await member.locator('[data-user]').filter({hasText:'管理员'}).filter({hasNotText:'验收同学'}).click();await member.locator('summary').filter({hasText:'账号权限与状态'}).click();await member.locator('[data-action=enabled]').click();await member.locator('#confirm-action').click();await member.locator('summary').filter({hasText:'账号权限与状态'}).click();await member.locator('[data-action=delete]').click();await member.locator('#confirm-action').click();
 await member.locator('#confirm-dialog').waitFor({state:'hidden'});assert.equal(portal.service.store.users.some(u=>u.username==='admin'),false);
 if(process.env.UI_SCREENSHOTS){await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});await member.screenshot({path:join(process.env.UI_SCREENSHOTS,'users-desktop.png'),fullPage:true});await member.setViewportSize({width:390,height:844});await member.locator('[data-nav=resources]').click();await member.screenshot({path:join(process.env.UI_SCREENSHOTS,'resources-mobile.png'),fullPage:true});}
 assert.deepEqual(errors,[]);console.log('UI PASS: register, zero quota, auto pending, grant, auto permissions, preserved drafts, readable invite, named admin, bootstrap retirement, mobile layout.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
