import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {executionCall} from '../execution.mjs';

test('reconciliation and restart clean only confirmed terminal task notes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-task-note-reconcile-'));
  const database=join(dir,'portal.sqlite'),bootstrap=join(dir,'bootstrap.json'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  let remoteState='UNKNOWN';
  const bridge=async()=>({state:remoteState,nodeJobId:'Jnotes',assignedIndices:[]});
  let service=await PortalService.open(database,bootstrap,undefined,bridge);clearInterval(service.executionTimer);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  let admin=await service.login('admin',password);
  const job={id:randomUUID(),userId:admin.principal.userId,username:'admin',machine:MACHINES[0].id,cards:1,
    state:'RUNNING',name:'test',spec:{argv:['python','train.py']}};
  service.store.jobs.push(job);service.save();
  const note=async(body,jobId)=>service.invoke(admin.token,'community.notes.create',{key:randomUUID(),body,...(jobId?{jobId}:{})});
  await note('task-only-body',job.id);await note('general-only-body');
  await service.reconcile();
  assert.equal(service.db.prepare('SELECT count(*) n FROM community_notes').get().n,2);
  assert.equal((await service.invoke(admin.token,'community.notes.list',{})).result.notes.length,2);
  remoteState='SUCCEEDED';await service.reconcile();
  // Assert before any community read: list also runs GC and must not mask a
  // missing reconciliation hook.
  assert.equal(service.db.prepare('SELECT count(*) n FROM community_notes WHERE job_id IS NOT NULL').get().n,0);
  assert.deepEqual((await service.invoke(admin.token,'community.notes.list',{})).result.notes.map(n=>n.body),['general-only-body']);
  const saved=service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data;
  assert.doesNotMatch(saved,/task-only-body|general-only-body/);
  assert.doesNotMatch(JSON.stringify(service.db.prepare('SELECT * FROM audit').all()),/task-only-body|general-only-body/);

  // A priority response can also observe a task finishing in the meantime.
  job.state='PENDING';job.priorityMutable=true;job.spec.preemptIdleOnly=true;job.schedulerPolicy={};
  service.store.users.find(u=>u.id===admin.principal.userId).limits[MACHINES[0].id]=1;
  service.gpuq={stale:false,hosts:[{id:MACHINES[0].id,reachable:true,gpuq:{connected:true,capabilities:['priority-policy-v1','preempt-idle-only-v1','priority-rank-v1']}}]};
  service.refreshGPUQ=async()=>{};
  await note('priority-result-cleanup-body',job.id);
  await executionCall(service,admin.principal,'jobs.priority',{jobId:job.id,priority:'normal'});
  assert.equal(service.db.prepare('SELECT count(*) n FROM community_notes WHERE job_id IS NOT NULL').get().n,0);

  job.state='RUNNING';service.save();await note('startup-cleanup-body',job.id);
  job.state='FAILED';service.save(); // Simulate shutdown between state persistence and GC.
  service.close();service=await PortalService.open(database,undefined,undefined,bridge);clearInterval(service.executionTimer);
  assert.equal(service.db.prepare('SELECT count(*) n FROM community_notes WHERE job_id IS NOT NULL').get().n,0);
  admin=await service.login('admin',password);
  assert.deepEqual((await service.invoke(admin.token,'community.notes.list',{})).result.notes.map(n=>n.body),['general-only-body']);
});

test('CLI notes require explicit lifetime and preserve retry keys and revision',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-task-note-cli-')),session=join(dir,'session.json');
  const task=randomUUID(),key=randomUUID(),calls=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});
    res.setHeader('Content-Type','application/json');
    if(operation==='state'){res.end(JSON.stringify({state:{machines:[],jobs:[],users:[]}}));return;}
    const note={id:'8',revision:2,body:'留言',author:{username:'alice'},jobId:args.jobId||null};
    const result=operation==='community.notes.list'?{notes:[note],nextCursor:null}:operation==='community.notes.delete'?{id:'8',deleted:true}:{note};
    res.end(JSON.stringify({result}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(session,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'synthetic-test-token',principal:{username:'alice',userId:'alice',role:'member'}}));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const cli=args=>new Promise(resolve=>{
    const p=spawn(process.execPath,['cli.mjs','--session-file',session,'--json',...args],{cwd:new URL('..',import.meta.url)});let out='',err='';
    p.stdout.on('data',s=>out+=s);p.stderr.on('data',s=>err+=s);p.on('exit',code=>resolve({code,out,err}));
  });
  assert.equal((await cli(['note','--job',task,'--key',key,'预计今晚结束'])).code,0);
  assert.deepEqual(calls.find(c=>c.operation==='community.notes.create').args,{body:'预计今晚结束',key,jobId:task});
  assert.equal((await cli(['note','--general','--key',randomUUID(),'维护公告'])).code,0);
  assert.equal((await cli(['notes'])).code,0);
  assert.equal((await cli(['note-delete','8'])).code,0);
  assert.deepEqual(calls.find(c=>c.operation==='community.notes.delete').args,{id:'8',revision:2});
  const writes=calls.filter(c=>c.operation==='community.notes.create').length;
  assert.notEqual((await cli(['note','未选择生命周期'])).code,0);
  assert.notEqual((await cli(['note','--job',task,'--general','冲突选项'])).code,0);
  assert.equal(calls.filter(c=>c.operation==='community.notes.create').length,writes);
});

test('cleanup failure preserves the real training failure and retries without changing task state',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-note-cleanup-failure-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const cause='CUDA out of memory: original training failure';
  const service=await PortalService.open(database,bootstrap,undefined,async()=>({state:'FAILED',error:cause,nodeJobId:'Jgc',assignedIndices:[]}));clearInterval(service.executionTimer);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),job={id:randomUUID(),userId:admin.principal.userId,username:'admin',machine:MACHINES[0].id,cards:1,state:'RUNNING',name:'training',spec:{argv:['python','train.py']}};
  service.store.jobs.push(job);service.save();
  await service.invoke(admin.token,'community.notes.create',{key:randomUUID(),jobId:job.id,body:'temporary task note'});
  service.db.exec("CREATE TEMP TRIGGER fail_note_cleanup BEFORE DELETE ON community_notes BEGIN SELECT RAISE(ABORT,'simulated cleanup failure'); END;");
  const warn=console.warn;console.warn=()=>{};
  try{await service.reconcile();}finally{console.warn=warn;}
  assert.equal(job.state,'FAILED');assert.equal(job.error,cause);
  assert.equal(JSON.parse(service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data).jobs[0].error,cause);
  assert.equal(service.noteCleanupPending,true);
  assert.equal(service.db.prepare('SELECT count(*) n FROM community_notes').get().n,1);
  service.db.exec('DROP TRIGGER fail_note_cleanup');await service.reconcile();
  assert.equal(service.noteCleanupPending,false);assert.equal(job.error,cause);assert.equal(job.state,'FAILED');
  assert.equal(service.db.prepare('SELECT count(*) n FROM community_notes').get().n,0);
});

test('an unpersisted terminal result cannot delete task note bodies',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-note-state-save-failure-')),bootstrap=join(dir,'bootstrap'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async()=>({state:'SUCCEEDED',nodeJobId:'Jsave',assignedIndices:[]}));clearInterval(service.executionTimer);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),job={id:randomUUID(),userId:admin.principal.userId,username:'admin',machine:MACHINES[0].id,cards:1,state:'RUNNING',name:'training',spec:{argv:['python','train.py']}};
  service.store.jobs.push(job);service.save();await service.invoke(admin.token,'community.notes.create',{key:randomUUID(),jobId:job.id,body:'keep until durable completion'});
  service.db.exec("CREATE TEMP TRIGGER fail_state_save BEFORE UPDATE ON portal_state BEGIN SELECT RAISE(ABORT,'simulated state save failure'); END;");
  await assert.rejects(service.reconcile(),/simulated state save failure/);
  assert.equal(job.state,'RUNNING','scheduler feedback must roll memory back when persistence fails');assert.equal(JSON.parse(service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data).jobs[0].state,'RUNNING');
  assert.equal(service.db.prepare('SELECT count(*) n FROM community_notes').get().n,1);
  // Also defend against an unpersisted in-memory observation from another path.
  job.state='SUCCEEDED';
  assert.equal((await service.invoke(admin.token,'community.notes.list',{})).result.notes.length,1);
  service.db.exec('DROP TRIGGER fail_state_save');service.save();await service.reconcile();
  assert.equal(service.db.prepare('SELECT count(*) n FROM community_notes').get().n,0);
});
