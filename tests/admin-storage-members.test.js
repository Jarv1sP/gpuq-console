import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptProjectUsage,storageMemberRows,memberStorageHTML,mountAdminStorageMembers} from '../dist/admin-storage-members.js';
import {adminDatasetCatalog} from '../dist/admin-data-storage.js';
const version='a'.repeat(64),other='b'.repeat(64);
const location=(machine='node-a',ownerLabel='所属用户：alice',extra={})=>({machine,dataset:'samples',ownerLabel,state:'READY',bytes:10,warehouseReady:true,...extra});
const catalog=(locations=[location()],extra={})=>({partial:false,datasets:[{dataset:'samples',versions:[{version,bytes:10,locations}]}],...extra});
const member=(value,name='alice')=>storageMemberRows(value).rows.find(row=>row.name===name);

test('pending project usage contract accepts only explicit nonnegative numeric bytes',()=>{
  assert.equal(adaptProjectUsage({bytes:0}),0);assert.equal(adaptProjectUsage({bytes:42}),42);
  for(const raw of [undefined,null,{},false,{bytes:'42'},{bytes:null},{bytes:false},{bytes:NaN},{bytes:Infinity},{bytes:-1},{bytes:1.1},{bytes:Number.MAX_SAFE_INTEGER+1},{projectBytes:42}])assert.equal(adaptProjectUsage(raw),null);
});
test('warehouse counts fixed versions once; READY cache counts each physical replica once',()=>{
  const value=catalog([location(),location('node-b'),location()]);
  value.datasets[0].versions.push({version:other,bytes:20,locations:[location('node-a',undefined,{bytes:20})]});
  const original=structuredClone(value),row=member(value);
  assert.equal(row.warehouseBytes,30);assert.equal(row.warehouseDatasets,1);assert.equal(row.cacheBytes,40);assert.equal(row.cacheDatasets,1);assert.equal(row.containerBytes,null);
  assert.deepEqual(row.machines.map(machine=>[machine.machine,machine.cacheBytes,machine.containerBytes]),[['node-a',30,null],['node-b',10,null]]);assert.deepEqual(value,original);
});
test('only exact READY caches count; a known no-warehouse fact remains zero',()=>{
  const row=member(catalog([location('node-a',undefined,{warehouseReady:false}),location('node-b',undefined,{state:'PREPARING',warehouseReady:false}),location('node-c',undefined,{state:'FAILED',warehouseReady:false})]));
  assert.equal(row.cacheBytes,10);assert.equal(row.warehouseBytes,0);assert.equal(row.warehouseDatasets,0);
});
test('trusted shared ownership credits named members and keeps the incomplete portion separately',()=>{
  const rows=storageMemberRows(catalog([location('node-a','共享授权用户：alice、陈宇轩、未知用户 1 位（账号已删除或未登记）')])).rows;
  assert.deepEqual(new Set(rows.map(row=>row.name)),new Set(['alice','陈宇轩','所属未知']));assert(rows.every(row=>row.cacheBytes===10&&row.warehouseBytes===10));assert.equal(rows.at(-1).key,'@unknown');
});
test('missing and unsafe ownership are not omitted or interpreted as accounts',()=>{
  for(const label of [undefined,'所属用户：未知（授权信息未完整返回）','所属用户：<img src=x>','owner:alice']){
    const rows=storageMemberRows(catalog([location('node-a',label===undefined?'':label)])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].name,'所属未知');assert.equal(rows[0].cacheBytes,10);
  }
  assert.equal(storageMemberRows(catalog([location('node-a','所属用户：unknown'),location('node-b','')])).rows.length,2);
});
test('empty registrations retain their trusted or unknown ownership',()=>{
  const rows=storageMemberRows({datasets:[{dataset:'empty',registrations:[{ownerLabel:'所属用户：bob'},{ownerLabel:''}],versions:[]}]}).rows;
  assert.deepEqual(new Set(rows.map(row=>row.name)),new Set(['bob','所属未知']));assert(rows.every(row=>row.cacheBytes===0&&row.warehouseBytes===0&&row.containerBytes===null));
});
test('missing, contradictory or overflowing sizes stay unknown instead of choosing a convenient value',()=>{
  const missing=catalog();missing.datasets[0].versions[0].bytes=null;assert.equal(member(missing).cacheBytes,null);assert.equal(member(missing).warehouseBytes,null);
  assert.equal(member(catalog([location(),location('node-a',undefined,{bytes:11})])).cacheBytes,null);
  const overflow=catalog([location('node-a',undefined,{bytes:Number.MAX_SAFE_INTEGER}),location('node-b',undefined,{bytes:Number.MAX_SAFE_INTEGER})]);overflow.datasets[0].versions[0].bytes=Number.MAX_SAFE_INTEGER;assert.equal(member(overflow).cacheBytes,null);
});
test('an incomplete all-node read does not claim a total, while observed per-machine facts survive',()=>{
  const row=member(catalog(undefined,{partial:true}));assert.equal(row.cacheBytes,null);assert.equal(row.warehouseBytes,null);assert.equal(row.warehouseDatasets,null);assert.equal(row.machines[0].cacheBytes,10);
  assert.deepEqual(storageMemberRows(null),{rows:[],available:false,partial:true});
});
test('unknown or future node state does not masquerade as an empty cache',()=>{
  for(const state of ['UNKNOWN','FUTURE',undefined]){const row=member(catalog([location('node-a',undefined,{state})]));assert.equal(row.cacheBytes,null);assert.equal(row.machines[0].cacheBytes,null);}
});
test('old nodes with no warehouse fact stay unknown; retained archive proof is bound to the full version',()=>{
  const old=location();delete old.warehouseReady;assert.equal(member(catalog([old])).warehouseBytes,null);
  old.storage={dataset:'samples',version,phase:'ARCHIVED',originalRetained:true,archiveMachine:'node-b'};
  let row=member(catalog([old]));assert.equal(row.warehouseBytes,10);assert.equal(row.machines.find(machine=>machine.machine==='node-b').warehouseBytes,10);
  old.storage.version=other;row=member(catalog([old]));assert.equal(row.warehouseBytes,null);
});
test('matching hashes under different physical names do not join warehouse or cache bytes',()=>{
  const value=catalog();value.datasets.push({dataset:'alias',versions:[{version,bytes:10,locations:[location('node-a',undefined,{dataset:'alias'})]}]});
  const row=member(value);assert.equal(row.warehouseBytes,20);assert.equal(row.warehouseDatasets,2);assert.equal(row.cacheBytes,20);assert.equal(row.cacheDatasets,2);
});
test('admin catalog retains only real boolean warehouse facts from understood node states',()=>{
  const build=(state,warehouseReady)=>adminDatasetCatalog('node-a',[{id:'node-a'}],[{machine:'node-a',state:'ok',datasets:[{dataset:'samples',ownerLabel:'所属用户：alice',versions:[{version,state,bytes:10,warehouseReady}]}]}]);
  for(const value of [true,false])assert.equal(build('READY',value).datasets[0].versions[0].locations[0].warehouseReady,value);
  assert.equal(build('FUTURE',true).datasets[0].versions[0].locations[0].warehouseReady,undefined);assert.equal(build('READY','true').datasets[0].versions[0].locations[0].warehouseReady,undefined);
});
test('member markup retains all size columns, unknown markers, cache dataset count and actual server ids',()=>{
  const html=memberStorageHTML(storageMemberRows(catalog()),new Set(['alice']));
  assert.match(html,/data-member-size="warehouse"[^>]*>10 B/);assert.match(html,/data-member-size="container"[^>]*>—/);assert.match(html,/data-member-size="cache"[^>]*title="1 个数据集">10 B/);
  assert.doesNotMatch(html,/<i class="project|<i class="[^"]*unknown/);assert.match(html,/容器 — · 缓存 10 B/);assert.match(html,/server-id/);assert.match(html,/1 个数据集 · 10 B/);assert.doesNotMatch(html,/%|原件|软件预算/);
});
test('unknown or zero bar components have no segment or separator, and only real quantities contribute',()=>{
  const value=catalog([location('node-a',undefined,{warehouseReady:false})]);let html=memberStorageHTML(storageMemberRows(value));
  assert.equal((html.match(/<i class=/g)||[]).length,1);assert.match(html,/<i class="cache" style="flex-grow:1"/);assert.doesNotMatch(html,/<i class="warehouse|<i class="project|unknown/);
  value.datasets[0].versions[0].bytes=null;html=memberStorageHTML(storageMemberRows(value));assert.doesNotMatch(html,/<i class=/);assert.match(html,/容器 — · 缓存 —/);
});
test('member principal and changed admin identity cannot render or access privileged aggregation',()=>{
  const host={innerHTML:'',replaceChildren(){this.innerHTML='';},addEventListener(){}},store={principal:{userId:'member',role:'member'},authGeneration:0};let reads=0;
  let module=mountAdminStorageMembers(host,{store,catalog(){reads++;return catalog();}});assert.equal(host.innerHTML,'');assert.equal(reads,0);module.destroy();
  store.principal={userId:'admin-a',role:'admin'};module=mountAdminStorageMembers(host,{store,catalog(){reads++;return catalog();}});assert.match(host.innerHTML,/alice/);assert.equal(reads,1);
  store.principal={userId:'admin-b',role:'admin'};store.authGeneration++;module.sync();assert.equal(host.innerHTML,'');assert.equal(reads,1);module.destroy();module.destroy();
});
test('users protocol fills actual container bytes by exact account identity; old or partial nodes stay unknown',()=>{
 const users=[{id:'alice-id',username:'alice',name:'Alice'}],usage={protocol:1,users:[{userId:'alice-id',label:'Alice',machines:[{machine:'node-a',available:true,collectedAt:'2026-10-08T06:00:00Z',complete:true,projectBytes:42,projects:[{project:'train',bytes:40}]}]}]};
 let model=storageMemberRows(catalog(),usage,users);assert.equal(model.rows.length,1);assert.equal(model.rows[0].containerBytes,42);assert.equal(model.rows[0].machines[0].containerBytes,42);
 assert.match(memberStorageHTML(model,new Set(['alice'])),/容器 42 B · 缓存 10 B/);
 usage.users[0].machines.push({machine:'node-b',available:false,complete:false,projectBytes:null,projects:[]});model=storageMemberRows(catalog(),usage,users);assert.equal(model.rows[0].containerBytes,null);assert.equal(model.rows[0].machines[0].containerBytes,42);assert.equal(model.rows[0].machines[1].containerBytes,null);
 model=storageMemberRows(null,usage,users);assert.equal(model.available,true);assert.equal(model.rows[0].cacheBytes,null);assert.equal(model.rows[0].machines[0].containerBytes,42,'project readings render independently of catalog');
});
