import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installJobNotifications,loadTelegramNotifications} from '../job-notifications.mjs';
import {normalizeProgress} from '../dist/job-progress.js';
import {jobNotificationHTML} from '../dist/job-progress-ui.js';
import {PortalService} from '../portal-service.mjs';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {standaloneClient} from '../client-bundle.mjs';

const ID='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const report=extra=>normalizeProgress({reported:true,stale:false,snapshot:{sequence:1,phase:'train',epochs_completed:1,epochs_total:10,steps_completed:null,steps_total:null,metrics:{loss:1},eta_seconds:null,severity:'info',message:null,updated_at:1,...extra}});
function fixture(t,{database=':memory:',send=async()=>{},configured=true}={}){
  const users=[{id:'demo-user-1',enabled:true},{id:'demo-user-2',enabled:true},{id:'builtin-admin',enabled:true}],job={id:ID,userId:users[0].id,username:'alice',machine:'gpu-1',state:'RUNNING',name:'train',latestAttempt:{id:'Aabc'},progress:report({})};
  const db=new DatabaseSync(database),service={db,store:{users,jobs:[job],get:id=>users.find(u=>u.id===id)},enqueue:async cb=>cb(),audit(){}};
  let now=100;
  const config=configured?{chatByUserId:{'demo-user-1':'12345'},send}:null;
  installJobNotifications(service,config,{clock:()=>now,timer:false});t.after(()=>db.close());
  return {db,service,job,users,principal:{userId:users[0].id,username:'alice'},clock:value=>now=value,on:()=>service.configureJobNotification({userId:users[0].id,username:'alice'},{jobId:ID,enabled:true})};
}

test('notification default is off and only exact owner may choose existing private destination',t=>{
  const f=fixture(t);assert.equal(f.service.jobNotificationState(f.job,f.users[0].id).enabled,false);
  f.service.captureJobNotifications();assert.equal(f.db.prepare('SELECT count(*) n FROM job_notification_outbox').get().n,0);
  for(const userId of [f.users[1].id,'builtin-admin'])assert.throws(()=>f.service.configureJobNotification({userId},{jobId:ID,enabled:true}),e=>e.status===403);
  for(const extra of [{chatId:'9999'},{userId:f.users[1].id},{token:'never'},{enabled:1}])assert.throws(()=>f.service.configureJobNotification(f.principal,{jobId:ID,enabled:true,...extra}));
  assert.equal(f.on().enabled,true);f.users[0].enabled=false;assert.throws(f.on,e=>e.status===403);
  assert.deepEqual(f.service.jobNotificationState(f.job,f.users[1].id),{configured:false,enabled:false,pending:0,failed:0});
});

test('disabled configuration cannot subscribe and never starts background delivery',t=>{
  const f=fixture(t,{configured:false});assert.throws(f.on,e=>e.status===409);assert.equal(f.service.notificationTimer,undefined);
});

test('notification subscription audit failure rolls back and does not opt user in',t=>{
  const f=fixture(t);f.service.audit=()=>{throw Error('audit unavailable');};assert.throws(f.on,/audit unavailable/);
  assert.equal(f.service.jobNotificationState(f.job,f.users[0].id).enabled,false);
});

test('100 percent and warning are advisory, sparse notification dedup survives sequence changes',async t=>{
  const sent=[],f=fixture(t,{send:async(chat,text)=>sent.push({chat,text})});f.on();
  f.job.progress=report({epochs_completed:10});await f.service.flushJobNotifications();assert.equal(sent.length,0);assert.equal(f.job.state,'RUNNING');
  f.job.progress=report({severity:'error',message:'synthetic warning'});await f.service.flushJobNotifications();assert.equal(sent.length,1);assert.match(sent[0].text,/报告异常/);assert.match(sent[0].text,/RUNNING/);
  f.job.progress=report({sequence:2,severity:'error',message:'synthetic warning'});await f.service.flushJobNotifications();assert.equal(sent.length,1);
  f.job.progress={...report({severity:'warning',message:'slow step'}),stale:true};await f.service.flushJobNotifications();assert.equal(sent.length,3);
  f.job.state='UNKNOWN';f.job.progress=null;await f.service.flushJobNotifications();assert.equal(sent.length,3);assert.equal(f.job.state,'UNKNOWN');
  f.job.state='SUCCEEDED';await f.service.flushJobNotifications();await f.service.flushJobNotifications();assert.equal(sent.length,4);
  assert.equal(f.db.prepare("SELECT count(*) n FROM job_notification_outbox WHERE payload IS NOT NULL").get().n,0);
});

test('durable outbox retries after reopen with bounded delay and no raw transport secrets',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-notify-'));t.after(()=>rm(dir,{recursive:true,force:true}));const database=join(dir,'db'),sent=[];
  let fail=true;
  const config={chatByUserId:{'demo-user-1':'12345'},send:async(chat,text)=>{if(fail)throw Error('https://secret-bot-token@private');sent.push({chat,text});}};
  const f=fixture(t,{database,send:config.send});f.on();f.job.state='FAILED';await f.service.flushJobNotifications();
  let row=f.db.prepare('SELECT * FROM job_notification_outbox').get();assert.equal(row.state,'QUEUED');assert.equal(row.attempts,1);assert.equal(row.next_at,130);assert.doesNotMatch(JSON.stringify(row),/secret-bot-token/);
  await f.service.flushJobNotifications();assert.equal(f.db.prepare('SELECT attempts FROM job_notification_outbox').get().attempts,1);
  // A second service sees exactly the same persisted subscription and queued
  // event; the earlier worker is idle and never holds a transaction over I/O.
  const db=new DatabaseSync(database),reopened={...f.service,db};t.after(()=>db.close());
  installJobNotifications(reopened,config,{clock:()=>131,timer:false});fail=false;await reopened.flushJobNotifications();
  row=db.prepare('SELECT * FROM job_notification_outbox').get();assert.equal(row.state,'SENT');assert.equal(row.payload,null);assert.equal(sent.length,1);assert.match(sent[0].text,/FAILED/);
});

test('429 honors retry-after and does not drain remaining queue into rate limit',async t=>{
  let sends=0;const f=fixture(t,{send:async()=>{sends++;throw Object.assign(Error('rate limit private description'),{code:429,retryAfter:50});}});f.on();
  f.job.progress={...report({severity:'error',message:'a'}),stale:true};await f.service.flushJobNotifications();assert.equal(sends,1);
  assert.equal(f.db.prepare('SELECT next_at FROM job_notification_outbox WHERE id=1').get().next_at,150);
  f.clock(149);await f.service.flushJobNotifications();assert.equal(sends,1);f.clock(151);await f.service.flushJobNotifications();assert.equal(sends,2);
});

test('permanent failure clears payload; cancel/revoke discards pending notices without stopping training',async t=>{
  let sends=0;const f=fixture(t,{send:async()=>{sends++;throw Object.assign(Error('blocked'),{code:403,permanent:true});}});f.on();f.job.state='FAILED';await f.service.flushJobNotifications();
  const row=f.db.prepare('SELECT * FROM job_notification_outbox').get();assert.equal(row.state,'FAILED');assert.equal(row.payload,null);await f.service.flushJobNotifications();assert.equal(sends,1);
  f.job.state='RUNNING';f.job.latestAttempt.id='Anew';f.job.progress=report({severity:'error',message:'new warning'});f.service.captureJobNotifications();
  f.service.configureJobNotification(f.principal,{jobId:ID,enabled:false});assert.equal(f.service.jobNotificationState(f.job,f.principal.userId).pending,0);assert.equal(f.job.state,'RUNNING');
  f.on();f.service.captureJobNotifications();f.users[0].enabled=false;await f.service.flushJobNotifications();assert.equal(sends,1);assert.equal(f.job.state,'RUNNING');
});

test('message retention clears old receipts while dedup cursor prevents replay of old completion',async t=>{
  let sends=0;const f=fixture(t,{send:async()=>sends++});f.on();f.job.state='CANCELED';await f.service.flushJobNotifications();assert.equal(sends,1);
  f.clock(100+8*86400);await f.service.flushJobNotifications();assert.equal(sends,1);assert.equal(f.db.prepare('SELECT count(*) n FROM job_notification_outbox').get().n,0);
});

test('notification UI controls exist only for owner with configured destination',()=>{
  const job={id:ID,userId:'alice',state:'RUNNING',notifications:{configured:true,enabled:false}};
  assert.match(jobNotificationHTML(job,'alice'),/开启 Telegram 通知/);assert.equal(jobNotificationHTML(job,'admin'),'');
  job.notifications.configured=false;assert.equal(jobNotificationHTML(job,'alice'),'');job.notifications.configured=true;job.state='SUCCEEDED';assert.match(jobNotificationHTML(job,'alice'),/disabled/);
});

test('Telegram transport has fixed HTTPS target, bounded plain text and generic failures only',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-telegram-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const token='123456:'+('A'.repeat(32)),tokenFile=join(dir,'token'),path=join(dir,'config');await writeFile(tokenFile,token,{mode:0o600});await writeFile(path,JSON.stringify({tokenFile,chatByUserId:{'demo-user-1':'12345'}}),{mode:0o600});
  let called;
  const config=await loadTelegramNotifications(path,{fetchImpl:async(url,request)=>{called={url,request};return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});}});
  await config.send('12345','plain <b>not HTML</b>');assert.equal(called.url,'https://api.telegram.org/bot'+token+'/sendMessage');assert.equal(called.request.redirect,'error');assert.deepEqual(JSON.parse(called.request.body),{chat_id:'12345',text:'plain <b>not HTML</b>',link_preview_options:{is_disabled:true}});
  const broken=await loadTelegramNotifications(path,{fetchImpl:async()=>{throw Error('request URL '+token);}});
  await assert.rejects(broken.send('12345','test'),e=>!e.message.includes(token));
  await chmod(path,0o644);await assert.rejects(loadTelegramNotifications(path));await chmod(path,0o600);
  await writeFile(path,JSON.stringify({tokenFile,chatByUserId:{'demo-user-1':'12345'},token}));await assert.rejects(loadTelegramNotifications(path));
  assert.equal(await loadTelegramNotifications(undefined),null);
});

test('persistent PortalService owns subscriptions; source and downloaded CLI use one authenticated API',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-notification-api-')),bootstrap=join(dir,'bootstrap'),database=join(dir,'db'),password=randomUUID()+randomUUID(),sent=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const config={chatByUserId:{'builtin-admin':'12345'},send:async(chat,text)=>sent.push({chat,text})};
  const service=await PortalService.open(database,bootstrap,undefined,undefined,config);clearInterval(service.notificationTimer);
  const login=await service.login('admin',password),job={id:ID,name:'notification-test',machine:'gpu-1',userId:'builtin-admin',username:'admin',state:'RUNNING',cards:1,spec:{argv:['python','train.py']}};
  service.store.jobs.push(job);service.save();
  assert.equal(service.state(login.principal).jobs[0].notifications.configured,true);
  const calls=[],server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});res.setHeader('Content-Type','application/json');
    try{res.end(JSON.stringify(await service.invoke(login.token,operation,args)));}catch(error){res.statusCode=error.status||400;res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));service.close();await rm(dir,{recursive:true,force:true});});
  const session=join(dir,'session'),file=join(dir,'gpuctl.mjs');await writeFile(file,await standaloneClient());await writeFile(session,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:login.token,principal:login.principal}));
  const run=args=>new Promise(resolve=>{const p=spawn(process.execPath,[file,'--session-file',session,'--json',...args]);let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('close',code=>resolve({code,out,err}));});
  const on=await run(['notify',ID,'on']);assert.equal(on.code,0,on.err);assert.equal(JSON.parse(on.out).data.enabled,true);
  job.state='SUCCEEDED';service.save();await service.flushJobNotifications();assert.equal(sent.length,1);
  const saved=service.db.prepare('SELECT data FROM portal_state').get().data;assert.doesNotMatch(saved,/chatByUserId|12345|Telegram token/);
  assert.equal((await run(['notify',ID,'status'])).code,0);assert.equal((await run(['notify',ID,'off'])).code,0);
  assert.deepEqual(calls.filter(c=>c.operation==='notifications.job').map(c=>c.args),[{jobId:ID,enabled:true},{jobId:ID},{jobId:ID,enabled:false}]);
});

test('account revocation between sends prevents later queued deliveries',async t=>{
  let sends=0,f;f=fixture(t,{send:async()=>{sends++;f.users[0].enabled=false;}});f.on();f.job.progress={...report({severity:'error',message:'first'}),stale:true};
  await f.service.flushJobNotifications();assert.equal(sends,1);assert.equal(f.service.jobNotificationState(f.job,f.principal.userId).pending,0);
});

test('noisy training has bounded event history and retains a final notification slot',t=>{
  const f=fixture(t);f.on();
  for(let i=0;i<140;i++){f.job.progress=report({severity:'warning',message:'warning '+i});f.service.captureJobNotifications();}
  assert.equal(f.db.prepare('SELECT count(*) n FROM job_notification_outbox').get().n,127);
  f.job.state='SUCCEEDED';f.service.captureJobNotifications();assert.equal(f.db.prepare('SELECT count(*) n FROM job_notification_outbox').get().n,128);
  assert.match(f.db.prepare('SELECT payload FROM job_notification_outbox ORDER BY id DESC LIMIT 1').get().payload,/SUCCEEDED/);
});

test('ten unsuccessful delivery attempts stop retry and clear the message body',async t=>{
  let sends=0;const f=fixture(t,{send:async()=>{sends++;throw Error('network failure');}});f.on();f.job.state='FAILED';
  for(let i=0;i<12;i++){f.clock(100+i*4000);await f.service.flushJobNotifications();}
  const row=f.db.prepare('SELECT * FROM job_notification_outbox').get();assert.equal(sends,10);assert.equal(row.attempts,10);assert.equal(row.state,'FAILED');assert.equal(row.payload,null);
});

test('removing optional bot configuration discards pending bodies without changing training',t=>{
  const f=fixture(t);f.on();f.job.progress=report({severity:'error',message:'pending private observation'});f.service.captureJobNotifications();
  assert.equal(f.db.prepare('SELECT count(*) n FROM job_notification_outbox WHERE payload IS NOT NULL').get().n,1);
  const before=structuredClone(f.job);installJobNotifications(f.service,null,{timer:false});
  assert.equal(f.db.prepare('SELECT count(*) n FROM job_notification_outbox WHERE payload IS NOT NULL').get().n,0);assert.deepEqual(f.job,before);
});

test('notification storage failure is isolated at install and status read; no payload endpoint is exposed',t=>{
  const f=fixture(t);f.job.state='FAILED';f.job.error='native training failure';const before=structuredClone(f.job);
  f.db.exec('DROP TABLE job_notification_outbox');
  const status=f.service.jobNotificationState(f.job,f.principal.userId);assert.equal(status.degraded,true);assert.equal(status.pending,null);assert.deepEqual(f.job,before);
  assert.deepEqual(Object.keys(status).sort(),['configured','degraded','enabled','failed','pending']);
  const failing={...f.service,db:{exec(){throw Error('private database error');}}};installJobNotifications(failing,{chatByUserId:{'demo-user-1':'12345'}},{timer:false});
  assert.equal(failing.jobNotificationState(f.job,f.principal.userId).degraded,true);assert.deepEqual(f.job,before);
});

test('failed delivery receipt can recover without restart, with documented possible duplicate',async t=>{
  let sends=0;const f=fixture(t,{send:async()=>sends++});f.on();f.job.state='FAILED';f.job.error='original training error';
  f.db.exec("CREATE TRIGGER deny_receipt BEFORE UPDATE ON job_notification_outbox WHEN NEW.state='SENT' BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;");
  await assert.rejects(f.service.flushJobNotifications());assert.equal(sends,1);assert.equal(f.job.state,'FAILED');assert.equal(f.job.error,'original training error');
  assert.equal(f.db.prepare('SELECT state FROM job_notification_outbox').get().state,'SENDING');
  f.db.exec('DROP TRIGGER deny_receipt');await f.service.flushJobNotifications();assert.equal(sends,2);assert.equal(f.db.prepare('SELECT state FROM job_notification_outbox').get().state,'SENT');
});

test('global outbox capacity is bounded without discarding existing records',t=>{
  const f=fixture(t);f.on();
  const insert=f.db.prepare("INSERT INTO job_notification_outbox(job_id,user_id,generation,event_key,payload,state,next_at,created_at) VALUES(?,?,1,?,NULL,'SENT',100,100)");
  f.db.exec('BEGIN');for(let index=0;index<10000;index++)insert.run(ID,f.principal.userId,'fixture-'+index);f.db.exec('COMMIT');
  f.job.state='SUCCEEDED';f.service.captureJobNotifications();assert.equal(f.db.prepare('SELECT count(*) n FROM job_notification_outbox').get().n,10000);
  assert.equal(JSON.parse(f.db.prepare('SELECT seen_keys FROM job_notification_subscriptions').get().seen_keys).length,0);
  f.db.prepare('DELETE FROM job_notification_outbox WHERE id=1').run();f.service.captureJobNotifications();
  assert.equal(f.db.prepare('SELECT count(*) n FROM job_notification_outbox').get().n,10000);assert.match(f.db.prepare('SELECT payload FROM job_notification_outbox ORDER BY id DESC LIMIT 1').get().payload,/SUCCEEDED/);
});
