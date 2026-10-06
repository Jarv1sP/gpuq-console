import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

test('downloaded CLI edits the fixed native task with explicit revision and never retries a conflict',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-label-cli-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),password='Label-CLI-Fixture-2026!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const nodeJobId='J123456789abc',id=randomUUID(),calls=[];
  let metadata={name:'原名称',description:'原描述',submitter:{name:'alice',username:'alice'}};
  const revision=()=>createHash('sha256').update(JSON.stringify({description:metadata.description,name:metadata.name,submitter:metadata.submitter})).digest('hex');
  const native={id:nodeJobId,name:'portal-'+id.slice(0,8),owner:'alice',state:'RUNNING',display_metadata:metadata};
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,capabilities:['console-task-display-edit-v1'],jobs:m.id==='gpu-1'?[native]:[]}}))}));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const url='http://127.0.0.1:'+port;
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin:url,secure:false,bridge:async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    assert.equal(machine,'gpu-1');assert.equal(args.nodeJobId,nodeJobId);
    if(operation==='tasks.display.set'){
      if(args.revision!==revision())throw Object.assign(Error('Display revision conflict'),{status:409});
      metadata={...metadata,name:args.name,description:args.description};
    }else assert.equal(operation,'tasks.display.get');
    return {protocol:'task-display-edit-v1',nodeJobId,available:true,name:metadata.name,description:metadata.description,revision:revision(),metadata,binding:{submitKey:id,owner:'alice',name:native.name}};
  }});
  for(const timer of ['executionTimer','maintenanceTimer','transferTimer','storageArchiveTimer'])clearInterval(service[timer]);
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),user=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:user.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const member=await service.login('alice',password),job={id,userId:user.id,username:'alice',machine:'gpu-1',nodeJobId,name:'immutable',description:'immutable',state:'RUNNING',cards:1,spec:{id,userId:user.id,username:'alice',name:'immutable',cards:1,argv:['python','train.py'],minVramGiB:0}};
  service.store.jobs.push(job);service.save();const original=structuredClone(job);
  const client=join(dir,'gpuctl.mjs'),session=join(dir,'session');
  await writeFile(client,await(await fetch(url+'/gpuctl.mjs')).text());
  await writeFile(session,JSON.stringify({url,token:member.token,principal:member.principal,machine:'gpu-1'}));
  const cli=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[client,'--session-file',session,'--json',...args],{stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>resolve({code,data:out?JSON.parse(out).data:null,err}));
  });
  const before=await cli(['task-label','get','gpu-1',nodeJobId]);assert.equal(before.code,0,before.err);assert.equal(before.data.name,'原名称');
  const edited=await cli(['task-label','set','gpu-1',nodeJobId,'--revision',before.data.revision,'--name','中文｜续训','--description','当前说明']);assert.equal(edited.code,0,edited.err);assert.equal(edited.data.name,'中文｜续训');assert.deepEqual(job,original);
  const count=calls.length,conflict=await cli(['task-label','set','gpu-1',nodeJobId,'--revision',before.data.revision,'--name','过期编辑','--description','']);
  assert.equal(conflict.code,1);assert.match(conflict.err,/conflict/);assert.equal(calls.length,count+1);assert.equal(calls.at(-1).operation,'tasks.display.set');
  for(const args of [
    ['task-label','set','gpu-1',nodeJobId,'--name','缺版本','--description',''],
    ['task-label','get','gpu-1',nodeJobId,'--machine','gpu-2'],
    ['task-label','get','gpu-1',nodeJobId,'--owner','other'],
    ['task-label','set','gpu-1',nodeJobId,'--revision',edited.data.revision,'--name','名称','--description','','--','python'],
  ]){const prior=calls.length,result=await cli(args);assert.equal(result.code,1);assert.equal(calls.length,prior);}
  const queued=await cli(['queue','--machine','gpu-1']);assert.equal(queued.code,0,queued.err);assert.equal(queued.data.hosts[0].tasks[0].name,'中文｜续训');assert.equal(queued.data.hosts[0].tasks[0].description,'当前说明');
  job.userId='demo-user-999';job.spec.userId='demo-user-999';const prior=calls.length,denied=await cli(['task-label','get','gpu-1',nodeJobId]);assert.equal(denied.code,1);assert.equal(calls.length,prior);
});
