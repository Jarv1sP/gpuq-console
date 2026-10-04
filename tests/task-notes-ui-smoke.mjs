import {refreshVisible} from './starbase-workflows.mjs';
// Real cookie-authenticated notes, temporary SQLite, no scheduler or SSH.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
const dir=await mkdtemp(join(tmpdir(),'gpuq-notes-web-')),password='Notes-Browser-Fixture-2026!',errors=[],sent=[];
let server,service,browser,drop=false;
try{
  const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));const origin='http://127.0.0.1:'+port;
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false}));await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));clearInterval(service.executionTimer);
  const login=await service.login('admin',password),alice=(await service.invoke(login.token,'users.create',{username:'alice',password})).result;
  const job={id:randomUUID(),userId:alice.id,machine:'gpu-1',name:'我的训练',state:'UNKNOWN',cards:1,spec:{argv:['PRIVATE-TRAINING-COMMAND'],preemptIdleOnly:true},createdAt:new Date().toISOString()};service.store.jobs.push(job);service.save();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage({viewport:{width:390,height:920}});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/api/call',async route=>{const data=route.request().postDataJSON();sent.push(data);if(drop&&data.operation==='community.notes.create'){drop=false;await route.fetch();return route.abort();}return route.continue();});
  await page.goto(origin+'/#community');await page.locator('#login-form [name=username]').fill('alice');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=community]').click();await page.locator('[data-community-tab=chat]').click();await page.locator('#community-task-notes summary').click();await page.locator('#task-note-lifetime').waitFor();await page.waitForFunction(()=>!document.querySelector('#task-note-lifetime').disabled);
  assert.equal(await page.locator('#task-note-lifetime').inputValue(),'');
  await page.locator('#task-note-lifetime').selectOption('task');await page.locator('#task-note-job').selectOption(job.id);await page.locator('#task-note-body').fill('<img src=x onerror=window.XSS=1>\n预计今晚结束');drop=true;await page.locator('#task-note-form [type=submit]').click();await page.locator('#task-note-error').filter({hasText:'发送结果未确认'}).waitFor();assert.equal(await page.locator('#task-note-lifetime').isDisabled(),true);await page.locator('#task-note-form [type=submit]').click();await page.locator('.task-note').waitFor();
  const creates=sent.filter(x=>x.operation==='community.notes.create');assert.equal(creates[0].args.key,creates[1].args.key);assert.equal(await page.locator('.task-note img').count(),0);assert.equal(await page.evaluate(()=>window.XSS),undefined);assert.equal(await page.locator('.task-note').count(),1);
  await page.locator('#task-note-lifetime').selectOption('general');await page.locator('#task-note-body').fill('长期通知');await page.locator('#task-note-form [type=submit]').click();await page.waitForFunction(()=>document.querySelectorAll('.task-note').length===2);
  const general=page.locator('.task-note').filter({hasText:'长期通知'});await general.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('#task-note-editor [name=body]').fill('保留未提交草稿');
  const note=service.db.prepare('SELECT id,revision FROM community_notes WHERE body=?').get('长期通知');const token=(await service.login('alice',password)).token;await service.invoke(token,'community.notes.update',{id:String(note.id),revision:note.revision,body:'另一客户端已改'});
  await page.locator('#task-note-editor [type=submit]').click();await page.locator('[data-note-edit-error]').filter({hasText:'留言已被修改'}).waitFor();assert.equal(await page.locator('#task-note-editor [name=body]').inputValue(),'保留未提交草稿');await page.locator('[data-note-close]').click();
  job.state='SUCCEEDED';service.save();service.pruneTaskNotes();await page.locator('#notes-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('.task-note').length===1);assert.match(await page.locator('.task-note').innerText(),/另一客户端已改/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  // A task may finish after the server saves a note but before its lost reply
  // can be retried. Refresh must keep the frozen binding for that exact retry.
  const endingJob={...job,id:randomUUID(),name:'即将结束的训练',state:'RUNNING'};service.store.jobs.push(endingJob);service.save();
  await refreshVisible(page);await page.locator('#task-note-lifetime').selectOption('task');await page.locator('#task-note-job').selectOption(endingJob.id);await page.locator('#task-note-body').fill('结束前丢失响应');drop=true;
  await page.locator('#task-note-form [type=submit]').click();await page.locator('#task-note-error').filter({hasText:'发送结果未确认'}).waitFor();
  const uncertain=sent.filter(x=>x.operation==='community.notes.create').at(-1).args;endingJob.state='FAILED';service.save();service.pruneTaskNotes();
  await refreshVisible(page);await page.locator('#notes-refresh').click();
  assert.equal(await page.locator('#task-note-job').inputValue(),endingJob.id,'terminal refresh must preserve the uncertain task binding');
  await page.locator('#task-note-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#task-note-body').value==='');
  assert.deepEqual(sent.filter(x=>x.operation==='community.notes.create').at(-1).args,uncertain);assert.equal(await page.locator('.task-note').count(),1);
  await page.locator('.task-note').getByRole('button',{name:'删除',exact:true}).click();await page.locator('#task-notes-list .community-empty').waitFor();assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',checks:['explicit lifetime','own task names','same-key lost reply retry','terminal task lost-reply retry','plain text','stale edit preserves draft','terminal cleanup','persistent general note','manual deletion','390px layout']}));
}finally{await browser?.close();await new Promise(resolve=>server?.close(resolve)||resolve());await rm(dir,{recursive:true,force:true});}
