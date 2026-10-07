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

test('degraded health carries only fixed diagnosis and bounded card indices across roles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gpuq-health-')),path=join(dir,'status.json'),now=Date.now();
 try{
  for(const issue of [{kind:'managed-gpu-missing',indices:[1],error:'secret-path <script>'},{kind:'scheduler-degraded',error:'secret-path'},{kind:'managed-gpu-missing',indices:[1,1]},{kind:'managed-gpu-missing',indices:['<script>']},{kind:'untrusted',indices:[1]}]){
   await writeFile(path,JSON.stringify({version:1,checkedAt:new Date(now).toISOString(),hosts:[{id:'gpu-1',reachable:true,gpus:[{index:0}],gpuq:{connected:true,health:'degraded',healthIssue:issue,schedulableIndices:[],jobs:[]}}]}));
   const snapshot=await readGPUQStatus(path,now),member=visibleGPUQStatus(snapshot,{role:'member'},{'gpu-1':1});
   const expected=issue.kind==='scheduler-degraded'?{kind:'scheduler-degraded'}:issue.kind==='managed-gpu-missing'&&issue.indices.length===1&&issue.indices[0]===1?{kind:'managed-gpu-missing',indices:[1]}:undefined;
   assert.deepEqual(member.hosts[0].gpuq.healthIssue,expected);
   assert.deepEqual(member.hosts[0].gpuq.schedulableIndices,[]);
   assert.doesNotMatch(JSON.stringify(member),/secret-path|<script>/);
   assert.equal(visibleGPUQStatus(snapshot,{role:'member'},{}).hosts.length,0);
   assert.equal((await readGPUQStatus(path,now+181000)).hosts[0].gpuq.healthIssue,undefined);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('GPU process lists are bounded before returning snapshots',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-bounds-')),path=join(dir,'status.json'),now=Date.now();
  try{
    await writeFile(path,JSON.stringify({version:1,checkedAt:new Date(now).toISOString(),hosts:[{id:'gpu-1',reachable:true,gpus:[{index:0,processesAvailable:true,processes:Array.from({length:200},(_,n)=>({pid:n+1,name:'python',memoryUsedMiB:1}))}],gpuq:{connected:false,jobs:[]}}]}));
    const snapshot=await readGPUQStatus(path,now);assert.equal(snapshot.hosts[0].gpus[0].processes.length,128);assert.equal(snapshot.hosts[0].gpus[0].processesAvailable,false);assert.ok(snapshot.hosts[0].gpus[0].processesError);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('matched process scheduling priority is visible without exposing another member job identity',()=>{
  const snap={hosts:[{id:'gpu-1',reachable:true,gpuq:{connected:true,jobs:[]},gpus:[{index:0,processes:[{pid:1,scheduling:{priority:0,jobId:'private-job',yieldPolicy:'now'}}]}]}]};
  const member=visibleGPUQStatus(snap,{role:'member'},{'gpu-1':1});
  assert.deepEqual(member.hosts[0].gpus[0].processes[0].scheduling,{priority:0});
  assert.equal(JSON.stringify(member).includes('private-job'),false);
  assert.equal(visibleGPUQStatus(snap,{role:'admin'},{}).hosts[0].gpus[0].processes[0].scheduling.jobId,'private-job');
});

test('host command readiness is explicit, fail-closed and visible only to administrators',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-host-cap-')),path=join(dir,'status.json'),now=Date.now();
  try{
    for(const value of [undefined,null,{},true,{version:2,available:true},{version:1,available:'true'},{version:1,available:true,secret:'not-forwarded'}]){
      await writeFile(path,JSON.stringify({version:1,checkedAt:new Date(now).toISOString(),hosts:[{id:'gpu-1',reachable:true,hostCommand:value,gpus:[],gpuq:{connected:false,jobs:[]}}]}));
      const snapshot=await readGPUQStatus(path,now),available=value?.version===1&&value?.available===true;
      assert.deepEqual(snapshot.hosts[0].hostCommand,{version:1,available});
      assert.equal(visibleGPUQStatus(snapshot,{role:'admin'},{}).hosts[0].hostCommand.available,available);
      assert.equal(Object.hasOwn(visibleGPUQStatus(snapshot,{role:'member'},{'gpu-1':1}).hosts[0],'hostCommand'),false);
      assert.equal((await readGPUQStatus(path,now+181000)).hosts[0].hostCommand.available,false);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
