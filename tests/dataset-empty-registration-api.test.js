import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const [machine]=MACHINES.map(m=>m.id),owner='builtin-admin',VERSION='a'.repeat(64),OP='b'.repeat(64);
const dataset='u-'+createHash('sha256').update(owner).digest('hex').slice(0,16)+'-discarded';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'empty-registration-api-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Empty-Shell-Fixture-Password-2026!'}));
  const calls=[];let item={dataset,ownerIds:[owner],versions:[]},capability=1,failRead=false;
  const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(host,operation,args)=>{
    calls.push({machine:host,operation,args:structuredClone(args)});
    if(operation==='storage.dataset-delete.capabilities')return {protocol:'dataset-delete-node-v1',machine:host,datasetDelete:capability};
    if(operation==='datasets.list'){
      if(failRead&&host===MACHINES.at(-1).id)throw Error('read unavailable');
      return {datasets:host===machine&&item?[structuredClone(item)]:[]};
    }
    assert.equal(operation,'datasets.unregister');
    return {operationId:OP,dataset:args.dataset,version:args.version??null,state:'UNREGISTERING'};
  });
  clearInterval(service.executionTimer);
  const login=await service.login('admin','Empty-Shell-Fixture-Password-2026!');
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {service,calls,login,setItem:v=>item=v,setCap:v=>capability=v,setReadFailure:v=>failRead=v,
    remove:extra=>service.invoke(login.token,'datasets.unregister',{machine,dataset,...extra})};
}
const blocked=e=>e.status===409&&e.code==='LAST_COPY_UNPROVEN';
test('paired v1 admin whole-empty request dispatches only exact empty proof and no fabricated versions',async t=>{
  for(const extra of [{},{version:null}]){
    const f=await fixture(t),out=await f.remove(extra);
    assert.equal(out.result.state,'UNREGISTERING');
    assert.deepEqual(f.calls.filter(c=>c.operation==='datasets.unregister'),[{machine,operation:'datasets.unregister',args:{
      dataset,...extra,userId:owner,hostAdmin:true,protocol:'dataset-delete-node-v1',
      portalProvedOtherCopy:{protocol:'dataset-portal-copy-proof-v1',versions:[]}}}]);
    assert.deepEqual(f.calls.filter(c=>c.operation==='datasets.list').map(c=>c.machine),MACHINES.map(m=>m.id));
    assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_removal_exclusions').all(),[]);
  }
});
test('missing, malformed, shared or nonpersonal empty registry is not a complete-copy exception',async t=>{
  for(const item of [null,{dataset,versions:[]},{dataset,ownerIds:[],versions:[]},
    {dataset,ownerIds:[owner,'other'],versions:[]},{dataset,ownerIds:['other'],versions:[]},
    {dataset:'legacy',ownerIds:[owner],versions:[]},{dataset,ownerIds:[owner],versions:[{version:VERSION,state:'UNKNOWN'}]}]){
    const f=await fixture(t);f.setItem(item);
    await assert.rejects(f.remove({}),blocked);
    assert.equal(f.calls.filter(c=>c.operation==='datasets.unregister').length,0);
  }
});
test('administrator may remove another confirmed personal owner shell without changing its identity',async t=>{
  const f=await fixture(t),other='demo-user-23';
  const target='u-'+createHash('sha256').update(other).digest('hex').slice(0,16)+'-discarded';
  f.setItem({dataset:target,ownerIds:[other],versions:[]});
  const out=await f.remove({dataset:target});
  assert.equal(out.result.dataset,target);
  assert.deepEqual(f.calls.filter(c=>c.operation==='datasets.unregister'),[{machine,operation:'datasets.unregister',args:{
    dataset:target,userId:owner,hostAdmin:true,protocol:'dataset-delete-node-v1',
    portalProvedOtherCopy:{protocol:'dataset-portal-copy-proof-v1',versions:[]}}}]);
});
test('single version, failed inventory, old capability and actual last copy keep their protections',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.remove({version:VERSION}),blocked);
  f.setCap(0);await assert.rejects(f.remove({}),blocked);
  f.setCap(1);f.setReadFailure(true);await assert.rejects(f.remove({}),blocked);
  f.setReadFailure(false);f.setItem({dataset,ownerIds:[owner],versions:[{version:VERSION,state:'READY'}]});
  await assert.rejects(f.remove({}),blocked);
  assert.equal(f.calls.filter(c=>c.operation==='datasets.unregister').length,0);
});
test('members and forged proof or host fields never get the empty-shell branch',async t=>{
  const f=await fixture(t);
  const member=(await f.service.invoke(f.login.token,'users.create',{username:'member',password:'Empty-Shell-Member-Password-2026!'})).result;
  await f.service.invoke(f.login.token,'policy.full',{userId:member.id,policyVersion:0});
  const login=await f.service.login('member','Empty-Shell-Member-Password-2026!');f.calls.length=0;
  await assert.rejects(f.service.invoke(login.token,'datasets.unregister',{machine,dataset}),e=>e.status===403);
  for(const extra of [{portalProvedOtherCopy:{versions:[]}},{hostAdmin:true},{emptyRegistrationSnapshot:{}},{force:true}])
    await assert.rejects(f.remove(extra));
  assert.deepEqual(f.calls,[]);
});
