import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

test('downloaded CLI queue preserves native-only administrator labels without associating accounts or dispatching',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-native-label-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  const password='Native-Label-Fixture-Only-2026!';await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const native=Array.from({length:3},(_,i)=>({id:'Jnative'+i,name:'old-raw-training-'+i,owner:'private-native-owner',state:i===2?'UNKNOWN':'RUNNING',gpu_count:1,assigned_gpu_indices:[i],
    display_metadata:{name:'机械臂｜中文训练'+i,description:'已核实节点展示标签'+i,submitter:{name:'张三',username:'alice'}}}));
  const snapshot=checkedAt=>writeFile(status,JSON.stringify({version:1,checkedAt,hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,jobs:m.id==='gpu-1'?native:[]}}))}));
  await snapshot(new Date().toISOString());let calls=0;
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath:status,origin,secure:false,bridge:async()=>{calls++;throw Error('This read-only fixture must not dispatch');}});
  clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const session=join(dir,'session'),client=join(dir,'gpuctl.mjs');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password);await writeFile(session,JSON.stringify({url:origin,token:admin.token,principal:admin.principal,machine:'gpu-1'}));
  await writeFile(client,await(await fetch(origin+'/gpuctl.mjs')).text());
  const queue=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[client,'--session-file',session,'--json','queue','--machine','gpu-1']);let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>resolve({code,err,data:out?JSON.parse(out).data:null}));child.stdin.end();});
  let result=await queue();assert.equal(result.code,0,result.err);assert.equal(result.data.stale,false);
  assert.deepEqual(result.data.hosts[0].tasks.map(j=>({id:j.nodeJobId,name:j.name,description:j.description,source:j.source,submitter:j.submitter,state:j.state})),native.map(j=>({id:j.id,name:j.display_metadata.name,description:j.display_metadata.description,source:'native',submitter:{name:j.owner,username:j.owner},state:j.state})));
  const state=(await service.invoke(admin.token,'state')).state;assert.equal(state.jobs.length,0);assert.deepEqual(state.gpuq.hosts[0].gpuq.jobs,native);assert.equal(calls,0);
  const member=(await service.invoke(admin.token,'users.create',{username:'observer',password})).result;await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const signed=await service.login('observer',password);await writeFile(session,JSON.stringify({url:origin,token:signed.token,principal:signed.principal,machine:'gpu-1'}));
  result=await queue();assert.equal(result.code,0,result.err);assert.equal(result.data.hosts[0].tasks.length,3);
  for(const task of result.data.hosts[0].tasks){assert.equal(task.source,'native');assert.equal(task.name,'GPUQ 任务（未关联平台）');assert.equal(task.description,'');assert.equal(task.submitter,null);}
  for(const hidden of ['中文训练','展示标签','private-native-owner','alice','display_metadata'])assert.ok(!JSON.stringify(result.data).includes(hidden),hidden);
  await snapshot(new Date(Date.now()-240000).toISOString());await writeFile(session,JSON.stringify({url:origin,token:admin.token,principal:admin.principal,machine:'gpu-1'}));
  result=await queue();assert.equal(result.code,0,result.err);assert.equal(result.data.stale,true);assert.equal(result.data.hosts[0].reachable,false);assert.deepEqual(result.data.hosts[0].tasks,[]);assert.equal(calls,0);assert.equal(service.store.jobs.length,0);
});
