import test from 'node:test';
import assert from 'node:assert/strict';
import {readableDatasetCatalog} from '../dist/dataset-catalog-model.js';
const item=(dataset,canUse,ownerLabel,extra={})=>({dataset,displayName:dataset,versions:[{version:'a'.repeat(64),canUse,ownerLabel,servers:[],...extra}]});
const model={machine:null,partial:false,datasets:[
 item('mine',false,'所属用户：示例成员'),item('granted',true,'所属用户：其他成员'),
 item('private',false,'所属用户：其他成员'),item('unknown',false,'所属用户：未知'),
 item('similar',false,'所属用户：示例成员二'),
]};
const principal={userId:'reader',username:'示例成员',role:'member'};
test('members see only owned and explicitly readable versions, without granting an action',()=>{
 const before=JSON.stringify(model),result=readableDatasetCatalog(model,principal);
 assert.deepEqual(result.datasets.map(row=>row.dataset),['mine','granted']);assert.equal(result.datasets.length,2);
 assert.equal(result.datasets[0].versions[0].canUse,false,'Owned metadata does not grant reading or preparation');
 assert.equal(result.machine,null,'No machine quota is needed to see own metadata');assert.equal(JSON.stringify(model),before);
});
test('admins keep every dataset and original permission flags; anonymous has no visible rows',()=>{
 const admin=readableDatasetCatalog(model,{...principal,role:'admin'});
 assert.deepEqual(admin.datasets.map(row=>row.dataset),model.datasets.map(row=>row.dataset));
 assert.equal(admin.datasets.find(row=>row.dataset==='private').versions[0].canUse,false);
 assert.deepEqual(readableDatasetCatalog(model,null).datasets,[]);
});
test('version counts use readable versions, exact shared owners and per-location owner labels',()=>{
 const shared=item('shared',false,'共享授权用户：另一成员、示例成员');
 shared.versions.push({...shared.versions[0],version:'b'.repeat(64),ownerLabel:'所属用户：另一成员'});
 const different=item('per-location',false,'各机授权不同（见副本位置）',{servers:[{machine:'server-a',ownerLabel:'所属用户：示例成员'}]});
 const result=readableDatasetCatalog({datasets:[shared,different]},principal);
 assert.deepEqual(result.datasets.map(row=>row.dataset),['shared','per-location']);assert.equal(result.datasets[0].versions.length,1);
 assert.equal(shared.versions.length,2,'Filtering cannot rewrite the backend/admin catalog');
});
