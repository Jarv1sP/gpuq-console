// Real portal API, SQLite, downloaded CLI; only the native node boundary is fake.
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

const progress={reported:true,stale:false,snapshot:{sequence:1,phase:'train',epochs_completed:10,epochs_total:10,steps_completed:null,steps_total:null,metrics:{loss:0.1},eta_seconds:0,severity:'error',message:'training self-report only',updated_at:1}};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-live-watch-')),bootstrap=join(dir,'bootstrap'),password=randomUUID()+randomUUID(),calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
  let observe=async()=>({nodeJobId:'Jwatch',state:'RUNNING',assignedIndices:[0],progress});
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args});assert.equal(operation,'watch');return observe();};
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge});clearInterval(service.executionTimer);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));const login=await service.login('admin',password);
  service.store.users.find(user=>user.id===login.principal.userId).limits={'gpu-1':1};
  const id=randomUUID(),job={id,userId:login.principal.userId,username:'admin',name:'watch-live',machine:'gpu-1',cards:1,state:'RUNNING',spec:{id,argv:['python','train.py']}};
  service.store.jobs.push(job);service.save();
  const response=await fetch(origin+'/gpuctl.mjs');assert.equal(response.status,200);const file=join(dir,'gpuctl.mjs'),session=join(dir,'session');
  await writeFile(file,await response.text());await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal}));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {calls,service,job,origin,dir,file,session,setObserve:next=>observe=next,cli:args=>{const child=spawn(process.execPath,[file,'--session-file',session,...args]);let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);return {child,ended:new Promise(resolve=>child.once('close',code=>resolve({code,out,err})))};}};
}

test('downloaded watch queries real API without controls; advisory100% stays RUNNING and UNKNOWN retains quota',async t=>{
  const f=await fixture(t);let reads=0;
  f.setObserve(async()=>({nodeJobId:'Jwatch',state:++reads===1?'RUNNING':'UNKNOWN',assignedIndices:[],progress}));
  const result=await f.cli(['watch',f.job.id,'--interval','1','--json']).ended;assert.equal(result.code,3,result.err);
  const rows=result.out.trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(row=>row.state),['RUNNING','UNKNOWN']);assert.equal(rows[0].progress.snapshot.epochsCompleted,10);
  assert.equal(usage(f.service.store.jobs,f.job.userId),1);assert.ok(f.calls.every(call=>call.operation==='watch'));
});

test('Ctrl+C aborts downloaded CLI pending real API request and does not cancel or retry training',async t=>{
  const f=await fixture(t);let started,release;const waiting=new Promise(resolve=>started=resolve),held=new Promise(resolve=>release=resolve);
  f.setObserve(async()=>{started();await held;return {nodeJobId:'Jwatch',state:'RUNNING',progress};});
  const cli=f.cli(['watch',f.job.id]);t.after(()=>{release();if(cli.child.exitCode===null)cli.child.kill('SIGTERM');});
  await waiting;cli.child.kill('SIGINT');
  const result=await Promise.race([cli.ended,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('watch did not detach promptly')),2000);timer.unref();})]);
  assert.equal(result.code,130,result.err);assert.equal(f.job.state,'RUNNING');assert.equal(usage(f.service.store.jobs,f.job.userId),1);
  assert.deepEqual(f.calls.map(call=>call.operation),['watch']);release();
});
