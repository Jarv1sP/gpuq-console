import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {executionCall} from '../execution.mjs';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';
import {defaultDatasetDisplayName} from '../dist/dataset-display-name.js';
import {datasetListView} from '../dataset-catalog.mjs';

function fixture(){
 const user={id:'demo-user-1',username:'member',enabled:true,limits:{'gpu-1':1},role:'member'},calls=[],audits=[];
 const principal={userId:user.id,username:user.username,role:user.role};
 const service={store:{get:()=>user},audit:(...a)=>audits.push(a),bridge:async(machine,op,args)=>{
  calls.push({machine,op,args});
  if(op==='projects.storage.info')return {protocol:'personal-storage-v1',available:false,hostPath:'/private'};
  if(op==='projects.storage.copies')return {protocol:'personal-copies-v1',copies:[]};
  if(op.startsWith('projects.storage.publish'))return {state:'PUBLISHING',operationId:args.key};
  return {protocol:'personal-copy-v1',key:args.key,state:'UNKNOWN'};
 }};
 return {user,service,calls,audits,call:(action,args)=>executionCall(service,principal,'projects.storage.'+action,args)};
}
test('personal storage uses only current actor, machine grant and relative data paths',async()=>{
 const f=fixture(),key=randomUUID(),args={machine:'gpu-1',key,sourceTier:'hdd',targetTier:'ssd',sourcePath:'samples',targetPath:'hot'};
 const result=await f.call('copy',args);assert.equal(result.state,'UNKNOWN');
 assert.deepEqual(f.calls[0],{machine:'gpu-1',op:'projects.storage.copy',args:{...Object.fromEntries(Object.entries(args).filter(([k])=>k!=='machine')),userId:f.user.id}});
 for(const extra of [{userId:'demo-user-2'},{hostAdmin:true},{sourcePath:'/etc'},{targetPath:'../other'},{targetTier:'hdd'},{sourcePath:'x\u202e'},{machine:'gpu-2'},{force:true}])await assert.rejects(f.call('copy',{...args,...extra}));
 assert.equal(f.calls.length,1);f.user.limits['gpu-1']=0;await assert.rejects(f.call('copy',args));
 f.user.limits['gpu-1']=1;f.user.enabled=false;await assert.rejects(f.call('copy',args));assert.equal(f.calls.length,1);
});
test('status/list/info never retry launches and do not expose physical paths',async()=>{
 const f=fixture(),key=randomUUID();assert.deepEqual(await f.call('info',{machine:'gpu-1'}),{protocol:'personal-storage-v1',available:false});
 await f.call('copy.status',{machine:'gpu-1',key});await f.call('copies',{machine:'gpu-1'});
 assert.equal(f.audits.length,0);assert.equal(f.calls.filter(c=>c.op==='projects.storage.copy').length,0);
 await assert.rejects(f.call('constructor',{machine:'gpu-1'}));
});
test('permission change and missing receipt retain original key instead of replay',async()=>{
 const f=fixture(),key=randomUUID();f.service.bridge=async()=>{f.calls.push(key);f.user.enabled=false;return {protocol:'personal-copy-v1',key,state:'QUEUED'};};
 await assert.rejects(f.call('copy',{machine:'gpu-1',key,sourceTier:'hdd',targetTier:'ssd',sourcePath:'a',targetPath:'b'}),e=>e.status===403);
 assert.deepEqual(f.calls,[key]);
});
test('publishing validates tier, name and path but never client identity or privileges',async()=>{
 const f=fixture(),key=randomUUID();const args={machine:'gpu-1',tier:'hdd',key,name:'dataset',path:'processed'};
 assert.equal((await f.call('publish',args)).storageTier,'hdd');
 for(const extra of [{tier:'auto'},{path:'/host/path'},{name:'../bad'},{role:'admin'},{owners:['other']}])await assert.rejects(f.call('publish',{...args,...extra}));
 await f.call('publish.status',{machine:'gpu-1',tier:'hdd',key});assert.equal(f.calls.length,2);
});
test('workspace mode is an immutable opt-in and omission preserves old digest/spec',()=>{
 const user={id:'demo-user-1',username:'member',enabled:true},principal={role:'member'},args={machine:'gpu-1',cards:1,argv:['python','train.py'],key:randomUUID(),project:'test',release:'a'.repeat(64)};
 const legacy=normalizeJobSubmission(args,principal),isolated=normalizeJobSubmission({...args,workspaceMode:'isolated'},principal),shared=normalizeJobSubmission({...args,workspaceMode:'shared'},principal);
 assert.notEqual(legacy.digest,isolated.digest);assert.notEqual(isolated.digest,shared.digest);
 assert.equal(Object.hasOwn(createSubmittedJob(legacy,user,false).spec,'workspaceMode'),false);
 assert.equal(createSubmittedJob(shared,user,false).spec.workspaceMode,'shared');
 for(const workspaceMode of [true,'auto','',{},[]])assert.throws(()=>normalizeJobSubmission({...args,workspaceMode},principal));
 assert.throws(()=>normalizeJobSubmission({machine:'gpu-1',cards:1,argv:['x'],key:randomUUID(),workspaceMode:'shared'},principal));
});
test('copy/publication responses whitelist display fields, never physical roots or owner envelopes',async()=>{
 const f=fixture(),key=randomUUID();
 f.service.bridge=async(machine,op)=>op.endsWith('.copies')?{protocol:'personal-copies-v1',copies:[{protocol:'personal-copy-v1',key,state:'UNKNOWN',hostPath:'/private',userId:'foreign'}],hostPath:'/private'}:op.includes('publish')?{operationId:key,state:'READY',dataset:'h-0123456789abcdef-test',version:'a'.repeat(64),hostPath:'/private'}:{protocol:'personal-copy-v1',key,state:'UNKNOWN',hostPath:'/private'};
 assert.deepEqual(await f.call('copy.status',{machine:'gpu-1',key}),{protocol:'personal-copy-v1',key,state:'UNKNOWN'});
 assert.deepEqual((await f.call('copies',{machine:'gpu-1'})).copies,[{protocol:'personal-copy-v1',key,state:'UNKNOWN'}]);
 assert.equal(Object.hasOwn(await f.call('publish.status',{machine:'gpu-1',tier:'hdd',key}),'hostPath'),false);
});
test('HDD/SSD personal display names and verified tier preserve immutable physical IDs',()=>{
 for(const prefix of ['h','s']){const id=prefix+'-0123456789abcdef-user-data';assert.equal(defaultDatasetDisplayName(id),'user-data');assert.equal(id,prefix+'-0123456789abcdef-user-data');}
 const version={version:'a'.repeat(64),state:'READY',storageTier:'hdd'};
 const row=datasetListView({datasets:[{dataset:'h-0123456789abcdef-data',storageTier:'hdd',versions:[version]}]},[]).datasets[0];
 assert.equal(row.storageTier,'hdd');assert.equal(row.versions[0].storageTier,'hdd');
 assert.equal(Object.hasOwn(datasetListView({datasets:[{dataset:'old',versions:[{...version,storageTier:'guessed'}]}]},[]).datasets[0].versions[0],'storageTier'),false);
});
