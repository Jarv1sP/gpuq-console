import test from 'node:test';
import assert from 'node:assert/strict';
import {createStorageDisplayHistory,storageDisplayHistory,STORAGE_READING_MAX_AGE_MS} from '../dist/dataset-catalog-model.js';
const fields=['totalBytes','availableBytes','contentBytes'];
const at='2026-10-08T15:00:00Z';
test('success → failure → success retains confirmed warehouse cards and exact observation times',()=>{
 let clock=0;const history=createStorageDisplayHistory({now:()=>clock}).use('alice');
 history.confirmWarehouse('node-a');history.observe('warehouse','node-a',{machine:'node-a',totalBytes:100,availableBytes:30,contentBytes:0},fields,at);
 history.fail('warehouse');let row=history.project('warehouse','node-a',{machine:'node-a'},fields);
 assert.deepEqual(history.warehouses(),['node-a']);assert.equal(row.availableBytes,30);assert.equal(row.contentBytes,0);assert.equal(row.collectedAt,at);assert.equal(row.stale,true);
 clock=100;history.observe('warehouse','node-a',{machine:'node-a',totalBytes:100,availableBytes:40,contentBytes:0},fields,'2026-10-08T15:01:00Z');
 row=history.project('warehouse','node-a',null,fields);assert.equal(row.availableBytes,40);assert.equal(row.stale,false);assert.deepEqual(history.warehouses(),['node-a']);
 clock+=STORAGE_READING_MAX_AGE_MS;row=history.project('warehouse','node-a',null,fields);
 assert.equal(row.availableBytes,null);assert.equal(row.totalBytes,null);assert.equal(row.contentBytes,null);assert.deepEqual(history.warehouses(),['node-a'],'expiration removes readings, never a confirmed card');
});
test('first pending readings use skeleton state; failed first reads are unknown, never zero',()=>{
 const history=createStorageDisplayHistory().use('alice');history.begin('training',['node-a']);
 let row=history.project('training','node-a',{machine:'node-a'},['readyContentBytes']);assert.equal(row.loading,true);assert.equal(row.readyContentBytes,null);
 history.fail('training','node-a');row=history.project('training','node-a',null,['readyContentBytes']);assert.equal(row.loading,false);assert.equal(row.readyContentBytes,null);
});
test('old collectedAt cannot be refreshed by a repeated old sample, while partial cache remains a lower bound',()=>{
 let clock=0;const history=createStorageDisplayHistory({now:()=>clock}).use('alice');
 const value={readyContentBytes:42,usageComplete:false,volume:{availableBytes:10,collectedAt:at}};
 history.observe('training','node-a',value,['readyContentBytes','volume.availableBytes'],at);clock=STORAGE_READING_MAX_AGE_MS-1;
 history.observe('training','node-a',value,['readyContentBytes','volume.availableBytes'],at);history.fail('training');
 let row=history.project('training','node-a',{},['readyContentBytes','volume.availableBytes']);assert.equal(row.usageComplete,false);assert.equal(row.volume.collectedAt,at);assert.equal(row.stale,true);
 clock++;row=history.project('training','node-a',{},['readyContentBytes','volume.availableBytes']);assert.equal(row.readyContentBytes,null);assert.equal(row.volume.availableBytes,null);
});
test('account changes erase warehouse membership and all samples; display history is scoped to auth generation',()=>{
 const store={principal:{userId:'alice',role:'member'},authGeneration:0};const history=storageDisplayHistory(store);
 history.confirmWarehouse('node-a');history.observe('warehouse','node-a',{totalBytes:42},['totalBytes'],at);
 store.principal.userId='bob';assert.deepEqual(storageDisplayHistory(store).warehouses(),[]);assert.deepEqual(history.keys('warehouse'),[]);
 history.confirmWarehouse('node-b');store.authGeneration++;assert.deepEqual(storageDisplayHistory(store).warehouses(),[]);
});
test('a failed physical field stays stale when an independent cache-content read succeeds',()=>{
 const history=createStorageDisplayHistory().use('alice');history.observe('training','node-a',{volume:{availableBytes:42,collectedAt:at},readyContentBytes:1},['volume.availableBytes','readyContentBytes'],at);
 history.fail('training');history.observe('training','node-a',{readyContentBytes:2,usageComplete:true},['readyContentBytes'],at);
 const row=history.project('training','node-a',{machine:'node-a'},['volume.availableBytes','readyContentBytes']);assert.equal(row.volume.availableBytes,42);assert.equal(row.readyContentBytes,2);assert.equal(row.stale,true);assert.equal(row.volume.collectedAt,at);
});

test('last readable list shares ten-minute expiry without restoring operation permissions',()=>{
 let clock=0;const history=createStorageDisplayHistory({now:()=>clock}).use('alice'),markup='<span>samples</span>';
 history.observe('catalog-list','last',{markup,sample:1},['sample'],at);history.fail('catalog-list');
 let row=history.project('catalog-list','last',null,['sample']);assert.equal(row.markup,markup);assert.equal(row.sample,1);assert.equal(row.stale,true);assert.equal(row.collectedAt,at);
 clock=STORAGE_READING_MAX_AGE_MS;row=history.project('catalog-list','last',null,['sample']);assert.equal(row.sample,null);
 history.use('bob');assert.deepEqual(history.keys('catalog-list'),[]);
});
