import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const password='Cohort-Only-Synthetic-Password-2026';
const settled=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
async function fixture(machines=['gpu-1']){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-cohort-api-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
  const calls=[];let failSync=false,mode='oci';
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args});if(operation==='projects.oci-cohort.sync'){if(failSync)throw Error('Synthetic node offline');return {enabled:true,changed:true,revision:args.revision,ownersSHA256:createHash('sha256').update(JSON.stringify(args.owners)).digest('hex')};}return {project:args.project,state:'DRAFT',releases:[],latestReadyRelease:null,environmentMode:mode};};
  const service=await PortalService.open(join(dir,'db'),bootstrap,status,bridge,undefined,undefined,machines);clearInterval(service.executionTimer);
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  const login=await service.login('alice',password);
  await settled();return {service,admin,member,login,calls,fail:v=>failSync=v,mode:v=>mode=v,close:async()=>{await settled();service.close();await rm(dir,{recursive:true,force:true});}};
}
test('actual account grant/revoke events and first project access sync only server-derived cohort',async()=>{
  const f=await fixture();try{
    assert.deepEqual(f.calls.filter(x=>x.operation==='projects.oci-cohort.sync').at(-1).args.owners,[]);
    await assert.rejects(f.service.invoke(f.login.token,'projects.create',{machine:'gpu-1',project:'sample',environmentMode:'oci'}),e=>e.status===403);
    await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
    await settled();
    assert.deepEqual(f.calls.filter(x=>x.operation==='projects.oci-cohort.sync').at(-1).args.owners,[f.member.id]);
    await f.service.invoke(f.login.token,'projects.create',{machine:'gpu-1',project:'sample',environmentMode:'oci'});
    assert.deepEqual(f.calls.at(-1).args,{project:'sample',environmentMode:'oci',userId:f.member.id});
    for(const args of [{machine:'gpu-1',project:'sample',owners:['builtin-admin']},{machine:'gpu-1',project:'sample',hostAdmin:true}])await assert.rejects(f.service.invoke(f.login.token,'projects.create',args));
    const count=f.calls.length;for(const token of [f.admin.token,f.login.token])await assert.rejects(f.service.invoke(token,'projects.oci-cohort.sync',{machine:'gpu-1',hostAdmin:true,owners:['builtin-admin'],revision:100}));assert.equal(f.calls.length,count);
    await f.service.invoke(f.admin.token,'users.enabled',{userId:f.member.id,enabled:false});
    await settled();
    assert.deepEqual(f.calls.filter(x=>x.operation==='projects.oci-cohort.sync').at(-1).args.owners,[]);
    assert.equal(f.service.store.jobs.length,0);
  }finally{await f.close();}
});
test('shared/isolated projects and readonly listings remain usable when membership sync fails',async()=>{
  const f=await fixture();try{
    f.fail(true);await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});await settled();
    const count=f.calls.filter(x=>x.operation==='projects.oci-cohort.sync').length;
    for(const environmentMode of ['shared','isolated']){
      f.mode(environmentMode);
      for(const operation of ['projects.list','projects.status','projects.create','projects.publish'])await f.service.invoke(f.login.token,operation,{machine:'gpu-1',...(operation==='projects.list'?{}:{project:'sample'}),...(operation==='projects.create'?{environmentMode}:{})});
      await f.service.invoke(f.login.token,'terminal.open',{machine:'gpu-1',project:'sample',clientId:randomUUID(),key:randomUUID(),mode:'new'});
    }
    assert.equal(f.calls.filter(x=>x.operation==='projects.oci-cohort.sync').length,count);
    await assert.rejects(f.service.invoke(f.login.token,'terminal.open',{machine:'gpu-1',project:'sample',environmentMode:'shared',clientId:randomUUID(),key:randomUUID(),mode:'new'}));
    assert.equal(f.calls.filter(x=>x.operation==='projects.oci-cohort.sync').length,count);
  }finally{await f.close();}
});
test('default OFF preserves legacy project and terminal bridge call counts exactly',async()=>{
  const f=await fixture([]);try{
    await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
    const count=f.calls.length;
    for(const operation of ['projects.list','projects.status','projects.create','projects.publish'])await f.service.invoke(f.login.token,operation,{machine:'gpu-1',...(operation==='projects.list'?{}:{project:'sample'})});
    await f.service.invoke(f.login.token,'terminal.open',{machine:'gpu-1',project:'sample',clientId:randomUUID(),key:randomUUID(),mode:'new'});
    assert.deepEqual(f.calls.slice(count).map(c=>c.operation),['projects.list','projects.status','projects.create','projects.publish','terminal.open']);
  }finally{await f.close();}
});
test('durable account approval and the global account queue do not await an offline node RPC',async()=>{
  const f=await fixture();let unblock,done;
  try{
    const bridge=f.service.bridge;
    f.service.bridge=async(machine,operation,args)=>{if(operation==='projects.oci-cohort.sync')await new Promise(r=>unblock=r);return bridge(machine,operation,args);};
    await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});await settled();assert.equal(typeof unblock,'function');
    assert.equal(f.service.store.get(f.member.id).limits['gpu-1'],1);
    const state=await f.service.invoke(f.admin.token,'state',{});assert.equal(state.principal.userId,'builtin-admin');
    let admitted=false;done=f.service.invoke(f.login.token,'projects.create',{machine:'gpu-1',project:'sample',environmentMode:'oci'}).then(()=>admitted=true);
    await settled();assert.equal(admitted,false);unblock();await done;assert.equal(admitted,true);
  }finally{unblock?.();await done;await f.close();}
});
test('failed event does not roll back durable grant, but first OCI request fails without node project start',async()=>{
  const f=await fixture();try{
    f.fail(true);await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
    assert.equal(f.service.store.get(f.member.id).limits['gpu-1'],1);
    const count=f.calls.filter(x=>x.operation==='projects.create').length;
    await assert.rejects(f.service.invoke(f.login.token,'projects.create',{machine:'gpu-1',project:'sample',environmentMode:'oci'}));
    assert.equal(f.calls.filter(x=>x.operation==='projects.create').length,count);
    const spec={machine:'gpu-1',project:'sample',clientId:randomUUID(),key:randomUUID(),mode:'new'};
    await assert.rejects(f.service.invoke(f.login.token,'terminal.open',spec));
    assert.equal(f.calls.filter(x=>x.operation==='terminal.open').length,0);
  }finally{await f.close();}
});
