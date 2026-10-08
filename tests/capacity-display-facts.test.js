import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetCatalogCall} from '../dataset-catalog.mjs';
import {warehouseStorageCards,adaptStorageOverview,displayStorageCapacity} from '../dist/dataset-catalog-model.js';
import {cacheCapacityAmount,trainingCardHTML} from '../dist/dataset-flow.js';
import {MACHINES} from '../dist/model.js';
const {datasetStorageOverviewCall}=await import(process.env.STARGATE_OVERVIEW_TEST_MODULE||'../dataset-storage-overview.mjs');

const machine=MACHINES[0].id,at='2026-01-01T00:00:00Z';
const principal={userId:'demo-user-1',role:'member'};
const volume=(extra={})=>({filesystemBytes:1000,usedBytes:300,availableBytes:650,reserveBytes:50,usableBytes:600,
  volumeDeviceId:'a'.repeat(64),checkedAt:at,collectedAt:at,readOnly:false,guarded:true,...extra});
const reply=()=>({...volume(),inodeUsageKnown:false,datasetFileList:1,storageOverview:{protocol:'dataset-storage-node-v1',
  cache:{volume:volume(),budgetBytes:400,projectBytes:null,projectUsageComplete:false,projectCollectedAt:null,
    projectUsage:{owners:[{owner:'private-owner'}],projects:[{owner:'private-owner',project:'private-project'}]}},
  warehouse:{state:'READY',volume:volume({filesystemBytes:2000,usedBytes:900,availableBytes:1000,usableBytes:950,volumeDeviceId:'b'.repeat(64),path:'/private/mount',readToken:'private-token'})}}});
function fixture(value=reply()){
  const calls=[],user={id:principal.userId,enabled:true,limits:{[machine]:1}};
  const service={store:{get:()=>user},bridge:async(...args)=>{calls.push(args);return value;}};
  return {user,calls,service,call:()=>datasetCatalogCall(service,principal,'datasets.capacity',{machine})};
}

test('single-machine capacity retains only safe versioned display facts with original collection times',async()=>{
  const f=fixture(),result=await f.call();
  assert.equal(result.storageOverview.protocol,'dataset-storage-node-v1');
  assert.equal(result.storageOverview.warehouse.state,'READY');
  assert.equal(result.storageOverview.warehouse.volume.filesystemBytes,2000);
  assert.equal(result.storageOverview.warehouse.volume.collectedAt,at);
  assert.equal(result.storageOverview.cache.volume.usedBytes,300);
  assert.equal(result.storageOverview.cache.budgetBytes,400);
  assert.equal(result.storageOverview.cache.projectBytes,null);
  assert.equal(result.storageOverview.cache.projectUsageComplete,false);
  assert.equal(result.datasetFileList,1);
  assert.deepEqual(f.calls,[[machine,'datasets.capacity',{userId:principal.userId,hostAdmin:false}]]);
  assert.doesNotMatch(JSON.stringify(result),/private-|readToken|path|owners|projectUsage\"/);
});

test('warehouse progressive fallback reads its own volume before a full overview arrives',async()=>{
  const result=await fixture().call(),cards=warehouseStorageCards(null,{datasets:[]},new Map([[machine,result]]));
  assert.equal(cards.length,1);
  assert.equal(cards[0].machine,machine);
  assert.equal(cards[0].totalBytes,2000);
  assert.equal(cards[0].availableBytes,1000);
  assert.equal(cards[0].contentBytes,null,'a physical reading cannot invent dataset content');
  assert.equal(cards[0].collectedAt,at);
});

test('old nodes and an unknown protocol keep the original capacity projection without a warehouse',async()=>{
  for(const protocol of [null,'unrecognized']){
    const value=reply();if(protocol===null)delete value.storageOverview;else value.storageOverview.protocol=protocol;
    const result=await fixture(value).call();
    assert.equal(result.filesystemBytes,1000);assert.equal(result.availableBytes,650);
    assert.equal('storageOverview' in result,false);assert.equal('datasetFileList' in result,false);
    assert.deepEqual(warehouseStorageCards(null,{datasets:[]},new Map([[machine,result]])),[]);
  }
});

test('invalid warehouse facts cannot borrow a healthy cache volume or turn into zero',async()=>{
  const value=reply();value.storageOverview.warehouse.volume.availableBytes=3000;
  const result=await fixture(value).call();
  assert.equal(result.storageOverview.warehouse.state,'UNAVAILABLE');
  assert.equal(result.storageOverview.warehouse.volume,null);
  assert.equal(result.storageOverview.cache.volume.filesystemBytes,1000);
  const [card]=warehouseStorageCards(null,{datasets:[]},new Map([[machine,result]]));
  assert.equal(card.totalBytes,null);assert.equal(card.availableBytes,null);
});

test('project totals require complete sampling and a real collection time; confirmed zero is preserved',async()=>{
  for(const complete of [false,true]){
    const value=reply(),cache=value.storageOverview.cache;
    cache.projectBytes=0;cache.projectUsageComplete=complete;cache.projectCollectedAt=at;
    const result=await fixture(value).call();
    assert.equal(result.storageOverview.cache.projectBytes,complete?0:null);
    assert.equal(result.storageOverview.cache.projectUsageComplete,complete);
  }
  const value=reply();Object.assign(value.storageOverview.cache,{projectBytes:12,projectUsageComplete:true,projectCollectedAt:'invalid'});
  const result=await fixture(value).call();
  assert.equal(result.storageOverview.cache.projectBytes,null);assert.equal(result.storageOverview.cache.projectUsageComplete,false);
});

test('no machine authorization rejects before bridge; authorization revoked during read still rejects the reply',async()=>{
  const f=fixture();f.user.limits={};
  await assert.rejects(f.call(),error=>error.status===403);assert.equal(f.calls.length,0);
  f.user.limits={[machine]:1};f.service.bridge=async(...args)=>{f.calls.push(args);f.user.enabled=false;return reply();};
  await assert.rejects(f.call(),error=>error.status===403);assert.equal(f.calls.length,1);
});

function cacheFixture(versions,{unreadable=false}={}){
  const f=fixture();f.service.bridge=async(id,operation)=>{
    if(operation==='datasets.capacity')return reply();
    assert.equal(operation,'datasets.list');
    if(unreadable&&id===machine)throw Error('catalog unavailable');
    return {datasets:id===machine?[{dataset:'sample',ownerIds:[principal.userId],versions}]:[]};
  };
  return ()=>datasetStorageOverviewCall(f.service,principal,{});
}

test('a known READY cache remains a displayed lower bound when another version is UNKNOWN',async()=>{
  const value=await cacheFixture([{version:'a'.repeat(64),state:'READY',bytes:64,files:1},
    {version:'b'.repeat(64),state:'UNKNOWN',bytes:128,files:2}])();
  const cache=value.caches.find(row=>row.machine===machine);
  assert.equal(cache.readyContentBytes,64);assert.equal(cache.usageComplete,false);
  const display=displayStorageCapacity(adaptStorageOverview(value),null,new Map(),MACHINES).caches.find(row=>row.machine===machine);
  assert.match(cacheCapacityAmount(display),/^≥ /);assert.doesNotMatch(cacheCapacityAmount(display),/未知/);
  assert.match(trainingCardHTML(display),/≥ 64 B/);
});

test('missing READY size contributes no invented bytes while another confirmed cache remains a lower bound',async()=>{
  const value=await cacheFixture([{version:'a'.repeat(64),state:'READY',bytes:64,files:1},
    {version:'b'.repeat(64),state:'READY',files:2}])();
  const cache=value.caches.find(row=>row.machine===machine);
  assert.equal(cache.readyContentBytes,64);assert.equal(cache.usageComplete,false);
});

test('unreadable catalogs and entirely unknown READY sizes never turn into a zero cache total',async()=>{
  for(const options of [{unreadable:true},{}]){
    const value=await cacheFixture([{version:'a'.repeat(64),state:'READY',files:1}],options)();
    const cache=value.caches.find(row=>row.machine===machine);
    assert.equal(cache.readyContentBytes,null);assert.equal(cache.usageComplete,false);
  }
});
