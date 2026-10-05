import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {cohortOwners,installOciCohort} from '../oci-cohort.mjs';
import {DemoStore} from '../dist/model.js';
const user=(id='demo-user-3',enabled=true,grants={'gpu-1':1})=>({id,enabled,limits:grants,role:'member'});
const digest=owners=>createHash('sha256').update(JSON.stringify(owners)).digest('hex');
const settled=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
const owners=(users,machine)=>cohortOwners(users,machine,id=>users.find(user=>user.id===id));
function fixture(machines=['gpu-1']){
  const calls=[],audits=[],db=new DatabaseSync(':memory:');
  const service={db,store:{users:[user()]},audit:(...args)=>audits.push(args),bridge:async(machine,operation,args)=>{
    calls.push({machine,operation,args});return {enabled:true,changed:true,revision:args.revision,ownersSHA256:digest(args.owners)};
  }};
  service.store.get=id=>service.store.users.find(user=>user.id===id);
  installOciCohort(service,machines);return {service,calls,audits,close:()=>{service.closing=true;db.close();}};
}
test('default OFF makes no node call and does not create bookkeeping',async()=>{
  const f=fixture([]);try{f.service.store.users=[];assert.equal(f.service.syncOciAccountEvent(),undefined);await f.service.ociCohortAdmission('gpu-1','revoked');await f.service.ociProjectAdmission('gpu-1','revoked','sample',{creatingOCI:true});await f.service.ociProjectAdmission('gpu-1','revoked','sample');assert.equal(f.calls.length,0);assert.equal(f.service.db.prepare("SELECT 1 FROM sqlite_master WHERE name='oci_cohort_revision'").get(),undefined);}finally{f.close();}
});
test('only current enabled machine-granted immutable identities enter sorted cohort',()=>{
  assert.deepEqual(owners([user('demo-user-4'),user('demo-user-3',false),user('demo-user-5',true,{}),user('builtin-admin')],'gpu-1'),['builtin-admin','demo-user-4']);
  assert.deepEqual(owners([user('demo-user-3',false)],'gpu-1'),[]);
  for(const id of ['all','*','demo-user-3\n','other'])assert.throws(()=>owners([user(id)],'gpu-1'));
  assert.throws(()=>owners([user(),user()],'gpu-1'));
});
test('administrator effective machine permissions match store.get without changing raw grants; disabled and ungranted members deny',async()=>{
  const f=fixture();try{
    const store=new DemoStore();store.users=[{...user('builtin-admin',true,{}),role:'admin'},{...user('demo-user-4',false,{}),role:'admin'},user('demo-user-5',true,{})];f.service.store=store;
    const raw=structuredClone(store.users);await f.service.ociCohortAdmission('gpu-1','builtin-admin');
    assert.deepEqual(f.calls[0].args.owners,['builtin-admin']);assert.deepEqual(store.users,raw);
    const count=f.calls.length;for(const id of ['demo-user-4','demo-user-5','demo-user-999'])await assert.rejects(f.service.ociCohortAdmission('gpu-1',id),e=>e.status===403);
    assert.equal(f.calls.length,count);store.users[0].enabled=false;await assert.rejects(f.service.ociCohortAdmission('gpu-1','builtin-admin'),e=>e.status===403);
  }finally{f.close();}
});
test('private control operation receives derived owners but no passwords or supplied owner',async()=>{
  const f=fixture();try{f.service.store.users[0].password='must-not-read';await f.service.ociCohortAdmission('gpu-1','demo-user-3');assert.deepEqual(f.calls,[{machine:'gpu-1',operation:'projects.oci-cohort.sync',args:{hostAdmin:true,owners:['demo-user-3'],revision:1}}]);await f.service.ociCohortAdmission('gpu-1','demo-user-3');assert.equal(f.calls.length,1);}finally{f.close();}
});
test('grant/revoke events update cohort and preserve nobody as an empty set',async()=>{
  const f=fixture();try{f.service.syncOciAccountEvent();await settled();f.service.store.users[0].enabled=false;f.service.syncOciAccountEvent();await settled();assert.deepEqual(f.calls[1].args.owners,[]);assert.equal(f.calls[1].args.revision,2);await assert.rejects(f.service.ociCohortAdmission('gpu-1','demo-user-3'),e=>e.status===403);assert.equal(f.calls.length,2);}finally{f.close();}
});
test('queued old event derives live state, never reintroduces revoked account',async()=>{
  const f=fixture();let unblock;
  try{f.service.bridge=async(machine,operation,args)=>{f.calls.push({machine,operation,args});if(args.revision===1)await new Promise(resolve=>unblock=resolve);return {enabled:true,revision:args.revision,ownersSHA256:digest(args.owners)};};const old=assert.rejects(f.service.syncOciCohort('gpu-1'),e=>e.status===503);await new Promise(r=>setImmediate(r));const queued=f.service.syncOciCohort('gpu-1');f.service.store.users[0].enabled=false;unblock();await old;await queued;assert.deepEqual(f.calls.map(c=>c.args.owners),[['demo-user-3'],[]]);assert.deepEqual(f.calls.map(c=>c.args.revision),[1,2]);}finally{f.close();}
});
test('membership change during first admission is denied after ACK',async()=>{
  const f=fixture();try{f.service.bridge=async(machine,operation,args)=>{f.service.store.users[0].enabled=false;return {enabled:true,revision:args.revision,ownersSHA256:digest(args.owners)};};await assert.rejects(f.service.ociCohortAdmission('gpu-1','demo-user-3'),e=>e.status===503);}finally{f.close();}
});
test('unconfirmed ACK fails closed; account event failure is retained without fallback or retry',async()=>{
  const f=fixture();try{f.service.bridge=async()=>{f.calls.push('failed');throw Error('offline');};assert.equal(f.service.syncOciAccountEvent(),undefined);await settled();assert.equal(f.calls.length,1);assert.equal(f.audits.length,1);await settled();assert.equal(f.calls.length,1);await assert.rejects(f.service.ociCohortAdmission('gpu-1','demo-user-3'));assert.equal(f.calls.length,2);assert.equal(f.service.store.users[0].enabled,true);}finally{f.close();}
});
test('account notifications are nonblocking and bounded to one coalesced pending event per node',async()=>{
  const f=fixture();let unblock;
  try{
    f.service.bridge=async(machine,operation,args)=>{f.calls.push({machine,operation,args});if(args.revision===1)await new Promise(resolve=>unblock=resolve);return {enabled:true,revision:args.revision,ownersSHA256:digest(args.owners)};};
    assert.equal(f.service.syncOciAccountEvent(),undefined);await settled();
    f.service.store.users[0].enabled=false;for(let i=0;i<1000;i++)f.service.syncOciAccountEvent();
    assert.equal(f.calls.length,1);unblock();await settled();
    assert.deepEqual(f.calls.map(c=>c.args.owners),[['demo-user-3'],[]]);assert.equal(f.audits.length,1);
  }finally{f.close();}
});
test('only trusted OCI project metadata synchronizes; shared/isolated and unknown metadata never grant OCI',async()=>{
  const f=fixture();let mode='shared';
  try{
    const bridge=f.service.bridge;f.service.bridge=async(machine,operation,args)=>operation==='projects.status'?{project:args.project,environmentMode:mode}:bridge(machine,operation,args);
    for(mode of ['shared','isolated'])await f.service.ociProjectAdmission('gpu-1','demo-user-3','sample');
    assert.equal(f.calls.length,0);mode='oci';await f.service.ociProjectAdmission('gpu-1','demo-user-3','sample');assert.equal(f.calls.length,1);
    mode=undefined;await assert.rejects(f.service.ociProjectAdmission('gpu-1','demo-user-3','sample'),e=>e.status===503);
    f.service.bridge=async()=>({project:'other',environmentMode:'oci'});await assert.rejects(f.service.ociProjectAdmission('gpu-1','demo-user-3','sample'),e=>e.status===503);
  }finally{f.close();}
});
test('wrong revision, digest, capability and invalid host configuration reject',async()=>{
  for(const bad of [{enabled:false},{enabled:true,revision:1,ownersSHA256:'wrong'},{enabled:true,revision:0,ownersSHA256:digest(['demo-user-3'])}]){const f=fixture();try{f.service.bridge=async()=>bad;await assert.rejects(f.service.syncOciCohort('gpu-1'));}finally{f.close();}}
  for(const machines of [['gpu-1','gpu-1'],['unknown'],null,'gpu-1']){const db=new DatabaseSync(':memory:');try{assert.throws(()=>installOciCohort({db},machines));}finally{db.close();}}
});
test('persistent revisions increase after in-process reinstallation, no backward epoch reset',async()=>{
  const f=fixture();try{await f.service.syncOciCohort('gpu-1');installOciCohort(f.service,['gpu-1']);await f.service.syncOciCohort('gpu-1');assert.equal(f.calls[1].args.revision,2);}finally{f.close();}
});
