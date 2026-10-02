// Actual SQLite / cookies / Portal assets; Telegram sendMessage transport fake.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';

const dir=await mkdtemp(join(tmpdir(),'gpuq-notifier-ui-')),password='Notifier-Real-Browser-2026!',token='123456:'+('U'.repeat(32)),sent=[],errors=[],operations=[],originalFetch=globalThis.fetch;
let server,service,browser,state='RUNNING';
try{
  const bootstrap=join(dir,'bootstrap'),tokenFile=join(dir,'token'),config=join(dir,'config');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));await writeFile(tokenFile,token,{mode:0o600});await writeFile(config,JSON.stringify({tokenFile,chatByUserId:{'demo-user-1':'12345'}}),{mode:0o600});
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
  globalThis.fetch=async(url,args)=>{assert.equal(String(url),'https://api.telegram.org/bot'+token+'/sendMessage');sent.push(JSON.parse(args.body));return new Response(JSON.stringify({ok:true,result:{message_id:sent.length}}),{status:200});};
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,notificationConfigPath:config,bridge:async()=>({nodeJobId:'Jnotify-ui',state,assignedIndices:[],error:state==='FAILED'?'native training failure':null})}));globalThis.fetch=originalFetch;
  clearInterval(service.executionTimer);clearInterval(service.notificationTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),alice=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result,bob=(await service.invoke(admin.token,'users.create',{username:'bob',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:alice.id,policyVersion:service.state(admin.principal).users.find(user=>user.id===alice.id).policyVersion,limits:{'gpu-1':1},total:1});
  const id=randomUUID(),job={id,name:'notifier-real-job',userId:alice.id,username:'alice',machine:'gpu-1',cards:1,state:'RUNNING',spec:{id,argv:['python','train.py']}};service.store.jobs.push(job);service.save();
  const other=await service.login('bob',password);await assert.rejects(service.invoke(other.token,'notifications.job',{jobId:id,enabled:true}),e=>e.status===403);
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage({viewport:{width:390,height:920}});page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>{if(req.url().endsWith('/api/call'))operations.push(req.postDataJSON());});
  await page.goto(origin);await page.locator('#login-form [name=username]').fill('alice');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=work]').click();
  const toggle=page.locator('[data-job-notify="'+id+'"]');await toggle.waitFor();assert.match(await toggle.textContent(),/开启/);await service.flushJobNotifications();assert.equal(sent.length,0);
  await toggle.click();await page.waitForFunction(()=>document.querySelector('[data-job-notify]').textContent.includes('关闭'));assert.deepEqual(operations.findLast(request=>request.operation==='notifications.job').args,{jobId:id,enabled:true});
  state='FAILED';await service.reconcile();await service.flushJobNotifications();await service.flushJobNotifications();assert.equal(sent.length,1);assert.equal(sent[0].chat_id,'12345');assert.match(sent[0].text,/FAILED/);assert.equal(job.error,'native training failure');
  await toggle.click();await page.waitForFunction(()=>document.querySelector('[data-job-notify]').textContent.includes('开启'));assert.equal(await toggle.isDisabled(),true);
  assert.equal(job.state,'FAILED');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  const rows=service.db.prepare('SELECT * FROM job_notification_outbox').all();assert.equal(rows[0].payload,null);assert.doesNotMatch(JSON.stringify(service.export()),new RegExp(token));
  console.log(JSON.stringify({status:'passed',checks:['actual Portal/SQLite/cookie HTTP/assets','off by default','owner-only UI+RPC','fake official API','terminal notification dedup','sent body cleared','no training lifecycle mutation','390px layout']}));
}finally{globalThis.fetch=originalFetch;await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
