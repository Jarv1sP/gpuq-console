import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readGPUQStatus,visibleGPUQStatus} from '../gpuq-status.mjs';

test('live status expires closed and never exposes legacy job owners to members',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-status-')),path=join(dir,'status.json'),now=Date.now();
  try{
    await writeFile(path,JSON.stringify({version:1,checkedAt:new Date(now).toISOString(),hosts:[
      {id:'gpu-1',reachable:true,gpus:[{index:0}],gpuq:{connected:true,jobs:[{id:'J1',owner:'legacy-owner',name:'private-name'}]}},
      {id:'gpu-2',reachable:true,gpus:[],gpuq:{connected:true,jobs:[]}}
    ]}));
    const fresh=await readGPUQStatus(path,now);assert.equal(fresh.stale,false);
    const member=visibleGPUQStatus(fresh,{role:'member'},{'gpu-1':1});
    assert.equal(member.hosts.length,1);assert.equal(JSON.stringify(member).includes('legacy-owner'),false);assert.equal(member.hosts[0].gpuq.jobs,undefined);
    const admin=visibleGPUQStatus(fresh,{role:'admin'},{});assert.equal(admin.hosts[0].gpuq.jobs[0].id,'J1');
    const stale=await readGPUQStatus(path,now+181000);assert.equal(stale.stale,true);assert.ok(stale.hosts.every(h=>!h.reachable&&!h.gpuq.connected));
    await writeFile(path,'corrupted');assert.equal((await readGPUQStatus(path)).stale,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('per-card process detail is admin-only and members receive only anonymous occupancy',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-processes-')),path=join(dir,'status.json'),now=Date.now();
  const gpu={index:0,uuid:'GPU-123',model:'RTX Test',memoryTotalMiB:24576,memoryUsedMiB:1024,utilization:73,temperatureC:61,powerDrawW:220.5,powerLimitW:350,processesAvailable:true,secret:'hidden-extra',processes:[{pid:123,name:'/private/user/project/python',owner:'private-owner',memoryUsedMiB:1000,type:'private-training-name',command:'secret-arguments',environment:{TOKEN:'secret-token'}}]};
  try{
    await writeFile(path,JSON.stringify({version:1,checkedAt:new Date(now).toISOString(),hosts:[{id:'gpu-1',reachable:true,gpus:[gpu],gpuq:{connected:true,jobs:[{name:'private-job',owner:'private-owner'}]}},{id:'gpu-2',reachable:true,gpus:[{...gpu,uuid:'GPU-hidden'}],gpuq:{connected:true,jobs:[]}}]}));
    const snapshot=await readGPUQStatus(path,now),admin=visibleGPUQStatus(snapshot,{role:'admin'},{}),member=visibleGPUQStatus(snapshot,{role:'member'},{'gpu-1':1});
    assert.deepEqual(admin.hosts[0].gpus[0].processes,[{pid:123,name:'python',owner:'private-owner',memoryUsedMiB:1000,type:'compute'}]);
    const card=member.hosts[0].gpus[0];assert.equal(member.hosts.length,1);assert.equal(card.utilization,73);assert.equal(card.powerDrawW,220.5);assert.equal(card.temperatureC,61);
    assert.deepEqual(card.processes,[{pid:123,memoryUsedMiB:1000,type:'compute'}]);
    for(const forbidden of ['private-owner','private-job','private-training-name','secret-arguments','secret-token','hidden-extra','GPU-hidden','/private/user'])assert.equal(JSON.stringify(member).includes(forbidden),false,forbidden);
    assert.equal(JSON.stringify(admin.hosts[0].gpus).includes('secret-arguments'),false);
    assert.equal(visibleGPUQStatus(snapshot,{role:'member'},{}).hosts.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('unknown metrics remain unknown and unavailable processes do not hide a card',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-unknown-')),path=join(dir,'status.json'),now=Date.now();
  try{
    await writeFile(path,JSON.stringify({version:1,checkedAt:new Date(now).toISOString(),hosts:[{id:'gpu-1',reachable:true,gpus:[{index:0,model:'Known GPU',memoryTotalMiB:24576,memoryUsedMiB:'N/A',utilization:120,temperatureC:null,powerDrawW:-1,processesAvailable:false,processesError:'Process owner metadata unavailable',processes:[{pid:321,name:'python',owner:'private-owner',memoryUsedMiB:null},{pid:-1,name:'bad'}]}],gpuq:{connected:false,jobs:[]}}]}));
    const snapshot=await readGPUQStatus(path,now),member=visibleGPUQStatus(snapshot,{role:'member'},{'gpu-1':1});
    assert.equal(member.hosts[0].gpus.length,1);const card=member.hosts[0].gpus[0];
    for(const field of ['memoryUsedMiB','utilization','temperatureC','powerDrawW'])assert.equal(card[field],null);
    assert.equal(card.memoryTotalMiB,24576);assert.equal(card.processesAvailable,false);assert.equal(card.processes.length,1);assert.equal(card.processes[0].memoryUsedMiB,null);assert.ok(card.processesError);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('GPU process lists are bounded before returning snapshots',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-bounds-')),path=join(dir,'status.json'),now=Date.now();
  try{
    await writeFile(path,JSON.stringify({version:1,checkedAt:new Date(now).toISOString(),hosts:[{id:'gpu-1',reachable:true,gpus:[{index:0,processesAvailable:true,processes:Array.from({length:200},(_,n)=>({pid:n+1,name:'python',memoryUsedMiB:1}))}],gpuq:{connected:false,jobs:[]}}]}));
    const snapshot=await readGPUQStatus(path,now);assert.equal(snapshot.hosts[0].gpus[0].processes.length,128);assert.equal(snapshot.hosts[0].gpus[0].processesAvailable,false);assert.ok(snapshot.hosts[0].gpus[0].processesError);
  }finally{await rm(dir,{recursive:true,force:true});}
});
