import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readGPUQStatus,visibleGPUQStatus} from '../gpuq-status.mjs';

test('live status expires closed and never exposes legacy job owners to members',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'amax-status-')),path=join(dir,'status.json'),now=Date.now();
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
