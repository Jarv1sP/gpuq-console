// Actual Portal/RPC + SQLite + HTTP-downloaded artifact. Official API is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createPortalServer} from '../portal-server.mjs';
import {usage} from '../execution.mjs';

async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-live-notify-')),bootstrap=join(dir,'bootstrap'),tokenFile=join(dir,'token'),config=join(dir,'notifications'),token='123456:'+('T'.repeat(32)),password=randomUUID()+randomUUID(),sent=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));await writeFile(tokenFile,token,{mode:0o600});await writeFile(config,JSON.stringify({tokenFile,chatByUserId:{'builtin-admin':'12345'}}),{mode:0o600});
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port,original=globalThis.fetch;
  globalThis.fetch=async(url,args)=>{
    if(String(url).startsWith('https://api.telegram.org/')){assert.equal(String(url),'https://api.telegram.org/bot'+token+'/sendMessage');sent.push(JSON.parse(args.body));return new Response(JSON.stringify({ok:true,result:{message_id:sent.length}}),{status:200});}
    if(!String(url).startsWith(origin))throw Error('test refuses external network');return original(url,args);
  };
  let observation={nodeJobId:'Jnotify',state:'RUNNING',assignedIndices:[0]};
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,notificationConfigPath:config,bridge:async()=>observation});clearInterval(service.executionTimer);clearInterval(service.notificationTimer);
  globalThis.fetch=original;await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));const login=await service.login('admin',password),id=randomUUID(),job={id,userId:login.principal.userId,username:'admin',name:'notify-live',machine:'gpu-1',cards:1,state:'RUNNING',error:'original training diagnostic',spec:{id,argv:['python','train.py']}};
  service.store.users.find(user=>user.id===login.principal.userId).limits={'gpu-1':1};service.store.jobs.push(job);service.save();
  const file=join(dir,'gpuctl.mjs'),session=join(dir,'session');await writeFile(file,await(await fetch(origin+'/gpuctl.mjs')).text());await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal}));
  t.after(async()=>{globalThis.fetch=original;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const cli=args=>new Promise(resolve=>{const child=spawn(process.execPath,[file,'--session-file',session,'--json',...args]);let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.once('close',code=>resolve({code,out,err}));});
  return {service,job,login,sent,token,origin,cli,setObserve:next=>observation=next};
}

test('HTTP-downloaded CLI opts in through actual RPC and fake official API sends only to private mapped owner',async t=>{
  const f=await setup(t);assert.equal(f.service.state(f.login.principal).jobs[0].notifications.enabled,false);
  assert.equal((await f.cli(['notify',f.job.id,'on'])).code,0);
  f.setObserve({nodeJobId:'Jnotify',state:'FAILED',assignedIndices:[],error:'native training failed'});await f.service.reconcile();await f.service.flushJobNotifications();await f.service.flushJobNotifications();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].chat_id,'12345');assert.match(f.sent[0].text,/FAILED/);assert.equal(f.job.error,'native training failed');
  assert.equal((await f.cli(['notify',f.job.id,'status'])).code,0);assert.equal((await f.cli(['notify',f.job.id,'off'])).code,0);
  assert.doesNotMatch(JSON.stringify(f.service.export()),/12345|chatByUserId|tokenFile/);assert.doesNotMatch(JSON.stringify(f.service.db.prepare('SELECT * FROM job_notification_outbox').all()),new RegExp(f.token));
  const status=await f.service.invoke(f.login.token,'notifications.job',{jobId:f.job.id});assert.deepEqual(Object.keys(status.result).sort(),['configured','enabled','failed','pending']);
  await assert.rejects(f.service.invoke(f.login.token,'notifications.job',{jobId:f.job.id,payload:true}));
});

test('notification capture/cleanup DB faults cannot alter confirmed FAILED or its error',async t=>{
  const f=await setup(t);await f.service.invoke(f.login.token,'notifications.job',{jobId:f.job.id,enabled:true});
  f.setObserve({nodeJobId:'Jnotify',state:'FAILED',assignedIndices:[],error:'original native failure'});await f.service.reconcile();const before=structuredClone(f.job);
  f.service.db.exec("CREATE TRIGGER deny_notice_capture BEFORE INSERT ON job_notification_outbox BEGIN SELECT RAISE(ABORT,'notification insert unavailable'); END;");
  await assert.rejects(f.service.flushJobNotifications());assert.deepEqual(f.job,before);assert.equal(f.job.state,'FAILED');assert.equal(f.job.error,'original native failure');assert.equal(usage(f.service.store.jobs,f.job.userId),0);
  assert.equal(JSON.parse(f.service.db.prepare('SELECT data FROM portal_state').get().data).jobs[0].state,'FAILED');
  f.service.db.exec('DROP TRIGGER deny_notice_capture');await f.service.flushJobNotifications();assert.equal(f.sent.length,1);
  f.service.db.exec("CREATE TRIGGER deny_notice_cleanup BEFORE DELETE ON job_notification_outbox BEGIN SELECT RAISE(ABORT,'notification cleanup unavailable'); END;");
  // Expiration operates in the separate notification table, never job.error.
  f.service.db.prepare('UPDATE job_notification_outbox SET created_at=0').run();await assert.rejects(f.service.flushJobNotifications());assert.deepEqual(f.job,before);
});
