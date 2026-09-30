import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gpuPlacement,placementCapable} from '../dist/gpu-allocation.js';
import {placementFromForm,placementSummary} from '../dist/gpu-allocation-ui.js';
import {normalizeJobSubmission} from '../job-submission.mjs';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

test('fixed selection is canonical; shared consent and hardware caps are explicit',()=>{
  assert.deepEqual(gpuPlacement({gpuIndices:[3,1]},2),{gpuIndices:[1,3],shared:false});
  const shared=gpuPlacement({gpuIndices:[3],shared:true,vramMiB:4096,hami:true},1);
  assert.deepEqual(shared,{gpuIndices:[3],shared:true,vramMiB:4096,hami:true,smPercent:100});
  for(const value of [{gpuIndices:[3,3]},{gpuIndices:[-1]},{gpuIndices:[3],shared:true},{gpuIndices:[3],vramMiB:1},{gpuIndices:[3],shared:true,vramMiB:1,hami:true,smPercent:101}])assert.throws(()=>gpuPlacement(value,value.gpuIndices.length));
  assert.throws(()=>gpuPlacement({gpuIndices:[3]},1,{}),/弹性/);
  assert.throws(()=>gpuPlacement({gpuIndices:[3],shared:true,vramMiB:4096},1,null,{yieldPolicy:'now',restartPolicy:'never'}),/自动让位/);
  assert.throws(()=>gpuPlacement({gpuIndices:[3],shared:true,vramMiB:4096},1,null,null,'idle'),/自动让位/);
  const host={reachable:true,gpuq:{connected:true,capabilities:['console-placement-v1','console-sharing-v1','console-hami-v1']}};
  assert.equal(placementCapable(host,shared),true);assert.equal(placementCapable(host,{...shared,smPercent:50}),false);
  const form=new FormData();for(const [k,v] of Object.entries({'gpu-placement':'shared','gpu-indices':'3','vram-mib':'4096'}))form.set(k,v);
  assert.deepEqual(placementFromForm(form,1,null,null,'normal'),{gpuIndices:[3],shared:true,vramMiB:4096,hami:false});
  assert.match(placementSummary({placement:shared}),/共享 GPU 3/);
});

test('pinned target and sharing budget change immutable submit identity',()=>{
  const base={machine:MACHINES[0].id,cards:2,argv:['python','train.py'],key:randomUUID()},principal={role:'member'};
  const a=normalizeJobSubmission({...base,placement:{gpuIndices:[2,0]}},principal),b=normalizeJobSubmission({...base,placement:{gpuIndices:[0,2]}},principal);
  assert.equal(a.digest,b.digest);assert.notEqual(a.digest,normalizeJobSubmission({...base,placement:{gpuIndices:[0,1]}},principal).digest);
  base.cards=1;const shared={gpuIndices:[3],shared:true,vramMiB:4096};
  assert.notEqual(normalizeJobSubmission({...base,placement:shared},principal).digest,normalizeJobSubmission({...base,placement:{...shared,vramMiB:2048}},principal).digest);
});

test('portal accepts explicit one-sided sharing and rejects unavailable fixed cards/runtime before quota reservation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-placement-test-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,memoryUsedMiB:8192,processes:[{pid:123,memoryUsedMiB:8192}]})),gpuq:{connected:true,observeOnly:false,capabilities:['priority-policy-v1','preempt-idle-only-v1','console-placement-v1','console-sharing-v1'],jobs:[]}}))}));
  const calls=[],s=await PortalService.open(join(dir,'db'),bootstrap,status,async(machine,operation,args)=>{calls.push({machine,operation,args});return {state:'PENDING',assignedIndices:[]};});clearInterval(s.executionTimer);
  const settle=async()=>{await new Promise(r=>setImmediate(r));while(s.reconciling)await new Promise(r=>setTimeout(r,2));};
  t.after(async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});});
  const admin=await s.login('admin',password),member=(await s.invoke(admin.token,'users.create',{username:'alice',password})).result,user=await s.login('alice',password);
  await s.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[MACHINES[0].id]:2}});
  const key=randomUUID(),input={machine:MACHINES[0].id,cards:1,argv:['python','small.py'],key,placement:{gpuIndices:[3],shared:true,vramMiB:4096}},submit=more=>s.invoke(user.token,'jobs.submit',{...input,...more});
  const [a,b]=await Promise.all([submit({}),submit({})]);assert.equal(a.result.id,b.result.id);await settle();assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args.job.placement,{gpuIndices:[3],shared:true,vramMiB:4096,hami:false});
  for(const placement of [{gpuIndices:[100],shared:false},{gpuIndices:[3],shared:true,vramMiB:50000},{gpuIndices:[3],shared:true,vramMiB:4096,hami:true}])await assert.rejects(submit({key:randomUUID(),placement}),e=>[409,503].includes(e.status));
  assert.equal(s.store.jobs.length,1);
});
