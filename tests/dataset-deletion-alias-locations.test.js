import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,hosts,version,principal,admin,writes} from './dataset-deletion-fixture.mjs';

function aliasesFixture(t,{present=[],locations,grants}={}){
  const f=fixture(t,{onlySource:false}),bindings=new Map();
  grants??=[{id:randomUUID(),targetMachine:hosts[1],receiptSha256:'e'.repeat(64)}];
  const refs=grants.map(grant=>({sourceMachine:hosts[0],sourceDataset:'personal',version,
    targetMachine:grant.targetMachine,grantId:grant.id,receiptSha256:grant.receiptSha256}));
  locations??=refs.map((authorityReference,index)=>({dataset:'removed-alias-'+index,version,authorityReference}));
  const byName=name=>refs.filter(ref=>locations.some(location=>location.dataset===name&&JSON.stringify(location.authorityReference)===JSON.stringify(ref)));
  f.after=(host,op,args,result)=>{
    if(op==='datasets.list')result.datasets=host===hosts[0]?[{dataset:'personal',versions:[{version}]}]
      :present.filter(p=>p.host===host).map(p=>({dataset:p.dataset,versions:[{version}]}));
    if(op.endsWith('.locations'))result.locations=structuredClone(locations.filter(location=>location.authorityReference?.targetMachine===host));
    if(op.endsWith('.plan')){
      const source=host===hosts[0]&&args.dataset==='personal';
      const local=source||present.some(p=>p.host===host&&p.dataset===args.dataset);
      result.complete=local;result.absent=!local;
      result.authorityReferences=source?[]:structuredClone(byName(args.dataset));
      if(source)result.authority={protocol:'dataset-authority-dependencies-v1',sourceMachine:host,dataset:'personal',version,grants:structuredClone(grants)};
      if(local){assert.equal(Object.hasOwn(args,'authorization'),false);assert.equal(Object.hasOwn(args,'references'),false);}
      else{
        const sourcePlan=[...f.nodes.values()].find(node=>node.plan.machine===hosts[0]).plan;
        assert.deepEqual(args.authorization,Object.fromEntries(['operationId','machine','dataset','version','owners','memberAllowed','complete','snapshotSha256'].map(k=>[k,sourcePlan[k]])));
        assert.deepEqual(args.references,byName(args.dataset),'never use empty or host-wide refs for an absent alias');
      }
      // The real node permanently binds the original child UUID to these
      // target/proof arguments. Admin recovery changes actor, not the proof.
      const identity={dataset:args.dataset,version:args.version,authorization:args.authorization,references:args.references};
      if(bindings.has(args.operationId))assert.deepEqual(identity,bindings.get(args.operationId));
      else bindings.set(args.operationId,structuredClone(identity));
      if(f.planAfter)f.planAfter(host,args,result);
    }
    if(f.locationAfter&&op.endsWith('.locations'))f.locationAfter(host,result);
    if(f.statusAfter&&op.endsWith('.status'))f.statusAfter(host,args,result);
  };
  return Object.assign(f,{refs,locations,bindings});
}

test('one fixed grant gives each absent physical alias its complete source proof, not an empty ref set',async t=>{
  const f=aliasesFixture(t);
  f.locations.push({...f.locations[0],dataset:'another-removed-alias'});
  const r=await f.start();assert.equal(r.result.state,'DELETED',JSON.stringify(r.result));
  const plans=f.calls.filter(c=>c.op.endsWith('.plan')&&c.args.dataset!=='personal');
  assert.equal(plans.length,2);assert.ok(plans.every(c=>c.args.references.length===1));
  assert.deepEqual(plans.map(c=>c.args.references[0]),[f.refs[0],f.refs[0]]);
  assert.equal(r.result.steps.length,hosts.length+2);
  assert.doesNotMatch(JSON.stringify(r.result),/authorization|grantId|owners|receiptSha256|snapshotSha256/);
});

test('multiple grants on one host are grouped by physical name, and present plans authenticate locally',async t=>{
  const grants=[0,1].map(n=>({id:randomUUID(),targetMachine:hosts[1],receiptSha256:String(n+1).repeat(64)}));
  const f=aliasesFixture(t,{grants,present:[{host:hosts[1],dataset:'removed-alias-1'}]});
  // Duplicate location attestation cannot cause a second partial plan.
  f.locations.push(structuredClone(f.locations[0]));
  const r=await f.start();assert.equal(r.result.state,'DELETED',JSON.stringify(r.result));
  const absent=f.calls.find(c=>c.op.endsWith('.plan')&&c.args.dataset==='removed-alias-0');
  assert.deepEqual(absent.args.references,[f.refs[0]]);
  const local=f.calls.find(c=>c.op.endsWith('.plan')&&c.args.dataset==='removed-alias-1');
  assert.equal(Object.hasOwn(local.args,'authorization'),false);assert.equal(Object.hasOwn(local.args,'references'),false);
  assert.equal(f.calls.filter(c=>c.op.endsWith('.plan')&&c.args.dataset==='removed-alias-0').length,1);
});

test('all matching refs for one present physical name are collected before one local plan',async t=>{
  const grants=[0,1].map(n=>({id:randomUUID(),targetMachine:hosts[1],receiptSha256:String(n+1).repeat(64)}));
  const f=aliasesFixture(t,{grants,present:[{host:hosts[1],dataset:'shared-physical-alias'}]});
  f.locations.forEach(location=>{location.dataset='shared-physical-alias';});
  const r=await f.start();assert.equal(r.result.state,'DELETED',JSON.stringify(r.result));
  assert.equal(f.calls.filter(c=>c.op.endsWith('.plan')&&c.args.dataset==='shared-physical-alias').length,1);
  const row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  assert.deepEqual(row.steps.find(s=>s.dataset==='shared-physical-alias').plan.authorityReferences,f.refs);
});

test('foreign, malformed or missing grant locations prevent all fence/isolation dispatch',async t=>{
  for(const corrupt of [
    value=>{value.locations[0].authorityReference.grantId=randomUUID();},
    value=>{value.locations[0].authorityReference.targetMachine=hosts[2];},
    value=>{value.locations[0].authorityReference.force=true;},
    value=>{value.locations[0].version='f'.repeat(64);},
    value=>{value.locations[0].dataset='../foreign';},
    value=>{value.locations[0].owner=principal.userId;},
    value=>{value.locations[0]=null;},
    value=>{value.locations=[];},
  ]){
    const f=aliasesFixture(t);f.locationAfter=(host,value)=>{if(host===hosts[1])corrupt(value);};
    const r=await f.start();assert.ok(['UNKNOWN','BLOCKED'].includes(r.result.state));
    assert.equal(writes(f).length,0);assert.equal(r.result.steps.some(s=>s.dataset.startsWith('removed-alias')),false);
    assert.deepEqual(f.service.db.prepare('SELECT * FROM dataset_deletion_fences').all(),[]);
  }
});

test('a lost absence-plan ACK resumes the original child and exact proof only on explicit same-key continue',async t=>{
  const f=aliasesFixture(t);let lost=true,hideReceipt=true;
  f.planAfter=(host,args)=>{if(args.dataset==='removed-alias-0'){
    if(lost){lost=false;throw Error('lost original plan ACK');}hideReceipt=false;
  }};
  f.statusAfter=(host,args)=>{if(hideReceipt&&f.bindings.get(args.operationId)?.dataset==='removed-alias-0')throw Error('original plan read temporarily unreachable');};
  const r=await f.start();assert.equal(r.result.state,'UNKNOWN');assert.equal(writes(f).length,0);
  const before=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  const original=before.steps.find(s=>s.dataset==='removed-alias-0');assert.equal(original.plan,null);
  const count=f.calls.length;await f.call('datasets.delete.status',{key:r.args.key});
  assert.ok(f.calls.slice(count).every(c=>c.op.endsWith('.status')),'query never re-plans');
  await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  const result=await f.call('datasets.delete.status',{key:r.args.key});assert.equal(result.state,'DELETED',JSON.stringify(result));
  const plans=f.calls.filter(c=>c.op.endsWith('.plan')&&c.args.dataset==='removed-alias-0');
  assert.equal(plans.length,2);assert.equal(plans[0].args.operationId,original.operationId);assert.equal(plans[1].args.operationId,original.operationId);
  assert.deepEqual(plans[0].args.authorization,plans[1].args.authorization);assert.deepEqual(plans[0].args.references,plans[1].args.references);
  assert.equal(plans[1].args.userId,principal.userId);assert.equal(plans[1].args.hostAdmin,false,'admin continuation retains the original member actor');
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM dataset_deletions').get().n,1);
});

test('a saved absence plan cannot silently adopt a changed location grant under its original UUID',async t=>{
  const f=aliasesFixture(t);let interrupted=true;
  f.locationAfter=(host)=>{if(interrupted&&host===hosts[2])throw Error('next node reply lost');};
  const r=await f.start();assert.equal(r.result.state,'UNKNOWN');assert.equal(writes(f).length,0);
  const before=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  const alias=before.steps.find(s=>s.dataset==='removed-alias-0');assert.ok(alias.plan);
  // Simulate a changed attestation which is still a source grant: moving a
  // second grant onto that name is not permission to reuse the saved plan.
  f.refs.push({...f.refs[0],grantId:randomUUID(),receiptSha256:'f'.repeat(64)});
  f.locations.push({dataset:alias.dataset,version,authorityReference:f.refs[1]});
  f.planAfter=(host,args,value)=>{if(host===hosts[0])value.authority.grants.push({id:f.refs[1].grantId,targetMachine:hosts[1],receiptSha256:f.refs[1].receiptSha256});};
  interrupted=false;
  await f.call('datasets.delete.continue',{operationId:r.first.operationId},admin);await f.service.waitDatasetDeletions();
  const result=await f.call('datasets.delete.status',{key:r.args.key});assert.equal(result.state,'UNKNOWN');
  assert.equal(writes(f).length,0);assert.equal(f.calls.filter(c=>c.op.endsWith('.plan')&&c.args.dataset===alias.dataset).length,1);
  const row=JSON.parse(f.service.db.prepare('SELECT data FROM dataset_deletions').get().data);
  assert.equal(row.steps.find(s=>s.dataset===alias.dataset).operationId,alias.operationId);
  assert.deepEqual(row.steps.find(s=>s.dataset===alias.dataset).plan,alias.plan);
});
