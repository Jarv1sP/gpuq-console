import {accountMenu} from './starbase-workflows.mjs';
// Real Chrome profile cookies, Portal/SQLite and a restart at the same origin.
// No production credentials, GPU calls, SSH or external requests.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
const dir=await mkdtemp(join(tmpdir(),'gpuq-login-browser-')),password='Persistent-Browser-Only-2026!';
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port,profile=join(dir,'chrome-profile'),errors=[],external=[];
let server,service,context,clock=Date.now();
const start=async()=>{
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap:join(dir,'bootstrap'),origin,secure:false}));
  service.loginSessions.now=()=>clock;await new Promise(r=>server.listen(port,'127.0.0.1',r));
};
const browser=async()=>{
  context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.CHROME_PATH||undefined,viewport:{width:1100,height:900}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return page;
};
try{
  await writeFile(join(dir,'bootstrap'),JSON.stringify({username:'admin',password}));await start();
  let page=await browser();await page.goto(origin);
  await page.locator('#login-form [name=username]').fill('admin');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
  const cookie=(await context.cookies()).find(c=>c.name==='gpuq_session');assert.ok(cookie.httpOnly);assert.ok(cookie.expires>Date.now()/1000+360*86400);assert.equal(await page.evaluate(()=>document.cookie.includes('gpuq_session')),false);
  await context.close();context=null;await new Promise(r=>server.close(r));server=null;
  clock+=9*3600_000;await start();page=await browser();await page.goto(origin);
  await accountMenu(page);await page.locator('#current-account').filter({hasText:'admin'}).waitFor();assert.equal(await page.locator('#login-dialog').isVisible(),false);
  assert.equal((await context.cookies()).find(c=>c.name==='gpuq_session').value,cookie.value,'credential is not rotated or rewritten on ordinary requests');
  await accountMenu(page);await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor({state:'visible'});
  await context.close();context=null;await new Promise(r=>server.close(r));server=null;
  await start();page=await browser();await page.goto(origin);await page.locator('#login-dialog').waitFor({state:'visible'});assert.equal((await context.cookies()).some(c=>c.name==='gpuq_session'),false);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Persistent login browser passed: native on-disk Chrome profile, HttpOnly yearly cookie, close/reopen, nine hours, Portal restart and logout never revived.');
}finally{await context?.close();if(server)await new Promise(r=>server.close(r));else service?.close();await rm(dir,{recursive:true,force:true});}
