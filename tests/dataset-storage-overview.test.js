import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetStorageOverviewCall} from '../dataset-storage-overview.mjs';
import {MACHINES} from '../dist/model.js';

const [hot,other,cold]=MACHINES.map(machine=>machine.id),hash='a'.repeat(64),hash2='b'.repeat(64);
const principal={userId:'demo-user-1',role:'member'};
const snapshot=(id='c',overrides={})=>({filesystemBytes:1000,usedBytes:300,availableBytes:650,reserveBytes:50,usableBytes:600,
  volumeDeviceId:id.repeat(64),checkedAt:'2026-01-01T00:00:00Z',readOnly:false,guarded:true,...overrides});
const capacity=(volume=snapshot(),warehouse=null,budgetBytes=400)=>({...volume,storageOverview:{protocol:'dataset-storage-node-v1',cache:{volume,budgetBytes},warehouse}});
const record=(dataset,versions,owners=['demo-user-1'])=>({dataset,ownerIds:owners,versions});
function fixture({records={},capacities={},limits={[hot]:1,[other]:1,[cold]:1}}={}){
  const user={id:principal.userId,enabled:true,role:'member',limits},calls=[];
  const service={store:{users:[{id:user.id,username:'alice'},{id:'demo-user-2',username:'bob'}],get:id=>id===user.id?structuredClone(user):null},
    bridge:async(machine,operation,args)=>{
      calls.push({machine,operation,args});
      assert.deepEqual(args,{userId:'builtin-admin',hostAdmin:true});
      if(operation==='datasets.list')return {datasets:records[machine]||[]};
      assert.equal(operation,'datasets.capacity');
      return capacities[machine]||capacity();
    }};
  return {service,user,calls,call:(args={},who=principal)=>datasetStorageOverviewCall(service,who,args)};
}

test('warehouse originals are distinguished from local cache readiness, with physical volume capacity and logical content sizes',async()=>{
  const f=fixture({records:{
    [cold]:[record('sample',[{version:hash,state:'REGISTERED',warehouseReady:true,canPrepare:true,bytes:42,files:2}])],
    [hot]:[record('sample',[{version:hash,state:'READY',bytes:42,files:2}])]},
    capacities:{[cold]:capacity(snapshot('d'),{state:'READY',volume:snapshot('e',{filesystemBytes:2000,usedBytes:900,availableBytes:1000,reserveBytes:50,usableBytes:950})})}});
  const value=await f.call();
  assert.equal(value.protocol,'dataset-storage-overview-v1');assert.equal(value.partial,false);
  assert.equal(value.filePreviewAvailable,false);assert.equal(value.warehouse.state,'READY');
  assert.equal(value.warehouse.originalContentBytes,42);assert.equal(value.warehouse.datasetCount,1);assert.equal(value.warehouse.versionCount,1);
  assert.equal(value.warehouse.volumes[0].volume.totalBytes,2000);assert.equal(value.warehouse.volumes[0].volume.usedBytes,900);
  assert.equal(value.caches.find(row=>row.machine===hot).readyContentBytes,42);
  assert.equal(value.caches.find(row=>row.machine===cold).readyContentBytes,0);
  assert.equal(value.caches.find(row=>row.machine===cold).budgetBytes,400);
  const version=value.datasets[0].versions[0];
  assert.equal(version.contentBytes,42);assert.equal(version.fileCount,2);assert.equal(version.ownerLabel,'所属用户：alice');
  assert.deepEqual(version.originals,[{machine:cold,dataset:'sample',state:'READY',warehouseReady:true,canUse:true}]);
  assert.equal(version.caches.find(row=>row.machine===cold).state,'NOT_LOCAL');
  assert.equal(version.caches.find(row=>row.machine===cold).canUse,false);
  assert.match(value.checkedAt,/Z$/);assert.match(value.physicalVolumes[0].id,new RegExp('^'+hot+':'));
  assert.equal(f.calls.length,MACHINES.length*2);
});

test('zero-quota members see inventory and capacity metadata, never inherit foreign use or file access',async()=>{
  const f=fixture({limits:{},records:{[hot]:[record('private',[{version:hash,state:'READY',bytes:42,files:1,
    manifest:{path:'/private/token'},sourceId:'/host/secret',ownerIds:['secret'],readToken:'credential'}],['demo-user-2'])]}});
  const value=await f.call();assert.equal(value.datasets[0].versions[0].ownerLabel,'所属用户：bob');
  assert.equal(value.datasets[0].versions[0].canUse,false);
  assert.ok(value.datasets[0].versions[0].caches.every(row=>row.canUse===false&&row.canPrepare===false));
  assert.equal(value.filePreviewAvailable,false);
  assert.doesNotMatch(JSON.stringify(value),/ownerIds|demo-user-|credential|secret|\/host|\/private|manifest|sourceId|readToken/);
  assert.ok(f.calls.every(call=>['datasets.list','datasets.capacity'].includes(call.operation)));
});

test('legacy or failed capacity reads do not invent a warehouse or report unknown capacity as zero',async()=>{
  const f=fixture({capacities:{[cold]:snapshot('e')}}),bridge=f.service.bridge;
  f.service.bridge=(machine,operation,args)=>operation==='datasets.capacity'&&machine===other?Promise.reject(Error('secret mount /dev/sda unavailable')):bridge(machine,operation,args);
  const value=await f.call();assert.equal(value.partial,true);assert.equal(value.warehouse.state,'UNKNOWN');
  assert.equal(value.warehouse.originalContentBytes,null);assert.equal(value.warehouse.datasetCount,null);
  const unknown=value.caches.find(row=>row.machine===other);
  assert.equal(unknown.state,'UNAVAILABLE');assert.equal(unknown.volume.totalBytes,null);
  assert.equal(value.caches.find(row=>row.machine===cold).volume.totalBytes,1000);
  assert.ok(value.warehouse.warnings.some(row=>row.machine===cold&&row.code==='WAREHOUSE_FACTS_UNAVAILABLE'));
  assert.doesNotMatch(JSON.stringify(value),/secret|\/dev|sda/);
});

test('same device bind aliases are deduplicated; content usage never masquerades as whole-volume used or quota',async()=>{
  const shared=snapshot('d'),f=fixture({records:{[cold]:[record('sample',[{version:hash,state:'READY',warehouseReady:true,bytes:42,files:2,
    storageReference:{dataset:'wc-sample',version:hash}}])]},capacities:{[cold]:capacity(shared,{state:'READY',volume:shared},800)}});
  const value=await f.call();
  assert.equal(value.physicalVolumes.filter(row=>row.machine===cold).length,1);
  assert.equal(value.warehouse.volumes[0].originalContentBytes,42);
  assert.equal(value.caches.find(row=>row.machine===cold).readyContentBytes,42);
  assert.equal(value.caches.find(row=>row.machine===cold).volume.usedBytes,300);
  assert.ok(value.warehouse.warnings.some(row=>row.code==='CACHE_WAREHOUSE_SHARED_VOLUME'));
  assert.equal(value.datasets[0].versions[0].caches[0].dataset,'wc-sample');
  assert.equal(value.datasets[0].versions[0].originals[0].dataset,'sample');
});

test('warehouse warning watermarks are observations only and do not reject reads or emit personal capacity caps',async()=>{
  const full=snapshot('e',{usedBytes:950,availableBytes:0,usableBytes:0,readOnly:true}),f=fixture({capacities:{[cold]:capacity(snapshot('d'),{state:'READY',volume:full})}});
  const value=await f.call();
  assert.deepEqual(value.warehouse.warnings.map(row=>row.code),['WAREHOUSE_USAGE_HIGH','WAREHOUSE_FREE_SPACE_LOW','WAREHOUSE_READ_ONLY']);
  assert.equal(value.warehouse.volumes[0].volume.usableBytes,0);
  assert.equal(value.warehouse.state,'READY');assert.doesNotMatch(JSON.stringify(value),/userCap|hardQuota/);
});

test('unavailable catalog usage is unknown, including counts, even if physical capacity remains readable',async()=>{
  const f=fixture({capacities:{[cold]:capacity(snapshot('d'),{state:'READY',volume:snapshot('e')})}}),bridge=f.service.bridge;
  f.service.bridge=(machine,operation,args)=>machine===cold&&operation==='datasets.list'?Promise.reject(Error('offline')):bridge(machine,operation,args);
  const value=await f.call(),cache=value.caches.find(row=>row.machine===cold),warehouse=value.warehouse.volumes[0];
  assert.equal(cache.readyContentBytes,null);assert.equal(cache.readyVersionCount,null);assert.equal(cache.usageComplete,false);
  assert.equal(warehouse.originalContentBytes,null);assert.equal(warehouse.datasetCount,null);assert.equal(value.warehouse.state,'UNKNOWN');
  assert.equal(cache.volume.usedBytes,300);
});

test('missing/inconsistent logical size fields do not fabricate cache/original usage',async()=>{
  const f=fixture({records:{[cold]:[record('sample',[{version:hash,state:'REGISTERED',warehouseReady:true,bytes:42,files:2},{version:hash2,state:'READY',warehouseReady:true,storageReference:{dataset:'wc-sample',version:hash2}}])],
    [hot]:[record('sample',[{version:hash,state:'READY',bytes:43,files:2}])]},capacities:{[cold]:capacity(snapshot('d'),{state:'READY',volume:snapshot('e')})}});
  const value=await f.call();assert.equal(value.warehouse.originalContentBytes,null);
  assert.equal(value.datasets[0].versions.find(row=>row.version===hash).contentBytes,null);
  assert.equal(value.caches.find(row=>row.machine===cold).readyContentBytes,null);
});

test('malformed volumes, unsafe numbers and unknown warehouse protocol fail closed without raw node data',async()=>{
  const f=fixture({capacities:{[hot]:capacity(snapshot('d',{usedBytes:9999,token:'not-public',mount:'/secret'})),
    [cold]:capacity(snapshot('e'),{state:'READY',volume:snapshot('f',{availableBytes:-1})})}});
  const value=await f.call();assert.equal(value.caches.find(row=>row.machine===hot).volume.state,'UNKNOWN');
  assert.equal(value.warehouse.state,'UNKNOWN');assert.equal(value.partial,true);
  assert.doesNotMatch(JSON.stringify(value),/not-public|\/secret|token|mount/);
});

test('extra parameters/disabled accounts reject before I/O; revocation mid-read rejects the whole response',async()=>{
  const f=fixture();
  for(const args of [{machine:hot},{path:'/tmp'},{userId:'demo-user-2'},{hostAdmin:true},{},null,[]]){
    if(args&&Object.keys(args).length===0&&!Array.isArray(args))continue;
    await assert.rejects(f.call(args),error=>error.status===400);
  }
  await assert.rejects(f.call({},null),error=>error.status===403);assert.equal(f.calls.length,0);
  f.user.enabled=false;await assert.rejects(f.call(),error=>error.status===403);f.user.enabled=true;
  const bridge=f.service.bridge;
  f.service.bridge=async(machine,operation,args)=>{const value=await bridge(machine,operation,args);if(operation==='datasets.capacity')f.user.enabled=false;return value;};
  await assert.rejects(f.call(),error=>error.status===403);
});

test('overview never refreshes removal exclusions, even for administrators',async()=>{
  const f=fixture();
  f.service.db={prepare:()=>assert.fail('overview must not mutate cleanup bookkeeping')};
  const value=await f.call({}, {...principal,role:'admin'});
  assert.equal(value.protocol,'dataset-storage-overview-v1');
});

test('all-account real project usage is independent from cache logical sizes and never invented for legacy nodes',async()=>{
  const measured=capacity();Object.assign(measured.storageOverview.cache,{projectBytes:8192,projectUsageComplete:true,projectCollectedAt:'2026-01-01T01:00:00Z'});
  const f=fixture({capacities:{[hot]:measured,[cold]:snapshot('e')},records:{[hot]:[record('sample',[{version:hash,state:'READY',bytes:42,files:1}])]}});
  const value=await f.call(),actual=value.caches.find(row=>row.machine===hot);
  assert.equal(actual.projectBytes,8192);assert.equal(actual.projectUsageComplete,true);assert.equal(actual.projectCollectedAt,'2026-01-01T01:00:00Z');
  assert.equal(actual.readyContentBytes,42);assert.equal(actual.volume.usedBytes,300);
  const old=value.caches.find(row=>row.machine===cold);
  assert.equal(old.projectBytes,null);assert.equal(old.projectUsageComplete,false);assert.equal(old.projectCollectedAt,null);
  assert.equal(actual.volume.collectedAt,'2026-01-01T00:00:00Z');
  assert.doesNotMatch(JSON.stringify(value),/projects-v2|oci\/|userId|ownerIds|demo-user/);
});

test('last-success time survives unsuccessful observations without retaining stale capacity or project byte values',async()=>{
  const measured=capacity();Object.assign(measured.storageOverview.cache,{projectBytes:0,projectUsageComplete:true,projectCollectedAt:'2026-01-01T01:00:00Z'});
  const f=fixture({capacities:{[hot]:measured}}),bridge=f.service.bridge;
  assert.equal((await f.call()).caches.find(row=>row.machine===hot).projectBytes,0);
  f.service.bridge=(machine,op,request)=>machine===hot&&op==='datasets.capacity'?Promise.reject(Error('offline')):bridge(machine,op,request);
  const row=(await f.call()).caches.find(row=>row.machine===hot);
  assert.equal(row.volume.totalBytes,null);assert.equal(row.volume.checkedAt,null);assert.equal(row.volume.collectedAt,'2026-01-01T00:00:00Z');
  assert.equal(row.projectBytes,null);assert.equal(row.projectUsageComplete,false);assert.equal(row.projectCollectedAt,'2026-01-01T01:00:00Z');
  f.service.bridge=bridge;Object.assign(measured.storageOverview.cache,{projectBytes:99,projectUsageComplete:false,projectCollectedAt:'2026-01-01T01:00:00Z'});
  const failed=(await f.call()).caches.find(row=>row.machine===hot);
  assert.equal(failed.projectBytes,null);assert.equal(failed.projectUsageComplete,false);assert.equal(failed.projectCollectedAt,'2026-01-01T01:00:00Z');
});

test('malformed or unbounded project measurements are unknown, not zero; current original proof is explicit',async()=>{
  for(const fields of [{projectBytes:-1,projectUsageComplete:true},{projectBytes:Number.MAX_SAFE_INTEGER+1,projectUsageComplete:true},{projectBytes:0,projectUsageComplete:1},{projectBytes:0,projectUsageComplete:true,projectCollectedAt:'not-time'}]){
    const measured=capacity();Object.assign(measured.storageOverview.cache,{projectCollectedAt:'2026-01-01T01:00:00Z',...fields});
    const f=fixture({capacities:{[hot]:measured},records:{[cold]:[record('sample',[{version:hash,state:'REGISTERED',warehouseReady:false,bytes:42,files:1}])]}});
    const value=await f.call(),row=value.caches.find(row=>row.machine===hot);
    assert.equal(row.projectBytes,null);assert.equal(row.projectUsageComplete,false);
    assert.equal(value.datasets[0].versions[0].originals[0].warehouseReady,false);
    assert.equal(value.datasets[0].versions[0].originals[0].canUse,false);
  }
});

test('directory preview capability requires a real protocol node and an actor-authorized confirmed fixed source, not content-preview access',async()=>{
  const capable={...capacity(),datasetFileList:1},records={[hot]:[record('sample',[{version:hash,state:'READY',bytes:42,files:1}])]};
  const f=fixture({capacities:{[hot]:capable},records});
  const available=await f.call();assert.equal(available.filePreviewAvailable,true);assert.equal(available.fileContentPreviewAvailable,false);
  records[hot][0].ownerIds=['demo-user-2'];assert.equal((await f.call()).filePreviewAvailable,false);
  records[hot][0].ownerIds=['demo-user-1'];records[hot][0].versions[0].state='REGISTERED';
  assert.equal((await f.call()).filePreviewAvailable,false);
  records[hot][0].versions[0].warehouseReady=true;assert.equal((await f.call()).filePreviewAvailable,true);
  capable.datasetFileList='1';assert.equal((await f.call()).filePreviewAvailable,false);
  capable.datasetFileList=1;Object.assign(capable.storageOverview.cache.volume,{availableBytes:-1});assert.equal((await f.call()).filePreviewAvailable,false);
});
