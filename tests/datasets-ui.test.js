import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetRows,datasetMachines,datasetLocation,capacityText,datasetCapacityHTML,archiveStatus} from '../dist/datasets-ui.js';
const rows=catalog=>datasetRows({machine:'gpu-1',...catalog});
test('dataset cards show one concise username label, never guess from the dataset prefix',()=>{
 const catalog={datasets:[{dataset:'u-guessed-owner-data',versions:[{version:'a'.repeat(64),state:'READY',ownerLabel:'所属用户：alice',locations:[{machine:'gpu-1',state:'READY',ownerLabel:'所属用户：alice'}]}]}]};
 const html=rows(catalog);assert.match(html,/<p class="dataset-owner">所属用户：alice<\/p>/);
 assert.equal(html.split('所属用户：alice').length-1,1);
 delete catalog.datasets[0].versions[0].ownerLabel;
 assert.match(rows(catalog),/dataset-owner">所属用户：未知/);
});
test('conflicting replicas retain each ownership label and escape all owner text',()=>{
 const html=rows({datasets:[{dataset:'mine',versions:[{version:'a'.repeat(64),state:'READY',ownerLabel:'各机授权不同（见副本位置）',locations:[{machine:'gpu-1',state:'READY',ownerLabel:'所属用户：<img src=x>'},{machine:'gpu-2',state:'READY',ownerLabel:'共享授权用户：alice、bob'}]}]}]});
 assert.match(html,/各机授权不同/);assert.match(html,/gpu-1 · 已就绪 · 所属用户：&lt;img src=x&gt;/);assert.match(html,/gpu-2 · 已就绪 · 共享授权用户：alice、bob/);assert.doesNotMatch(html,/<img/);
});
test('archive UI distinguishes confirmed preservation from local readiness and escapes errors',()=>{
 assert.equal(archiveStatus(null),'');
 for(const phase of ['QUEUED','COPYING','PROVISIONING','FAILED','BLOCKED']){
   const html=archiveStatus({phase,dataset:'mine',version:'a'.repeat(64),error:'<script>'});
   assert.match(html,/本机数据继续保留/);assert.doesNotMatch(html,/长期原件已保存|<script>/);
   assert.equal(html.includes('data-retry-archive'),['FAILED','BLOCKED'].includes(phase));
 }
 assert.doesNotMatch(archiveStatus({phase:'ARCHIVED',originalRetained:false}),/长期原件已保存/);
 assert.match(archiveStatus({phase:'ARCHIVED',originalRetained:true,archiveMachine:'cold<script>'}),/cold&lt;script&gt;/);
});
test('archive action belongs only to the selected machine, not another replica',()=>{
 const catalog={machine:'gpu-1',datasets:[{dataset:'mine',versions:[{version:'a'.repeat(64),state:'READY',locations:[{machine:'gpu-2',state:'READY',storage:{phase:'FAILED',dataset:'mine',version:'a'.repeat(64)}}]}]}]};
 assert.doesNotMatch(rows(catalog),/data-retry-archive/);
 catalog.machine='gpu-2';assert.match(rows(catalog),/data-retry-archive="mine"/);
});
test('dataset cards keep full immutable versions and escape all text',()=>{
 const html=rows({datasets:[{dataset:'<unsafe>',versions:[{version:'" onfocus="evil',state:'FAILED',bytes:1024,files:1}]}]});
 assert.ok(html.includes('&lt;unsafe&gt;'));assert.ok(html.includes('&quot; onfocus=&quot;evil'));assert.ok(!html.includes('<unsafe>'));
 assert.match(html,/准备失败/);
});
test('only ready datasets can be used and failed preparations can be retried',()=>{
 const ready=rows({datasets:[{dataset:'tiny',versions:[{version:'a'.repeat(64),state:'READY',bytes:1,files:1}]}]});
 assert.match(ready,/data-prepare-dataset="tiny"[^>]+disabled/);assert.doesNotMatch(ready,/data-use-dataset="tiny"[^>]+disabled/);
 const failed=rows({datasets:[{dataset:'tiny',versions:[{version:'a'.repeat(64),state:'FAILED',bytes:1,files:1}]}]});
 assert.doesNotMatch(failed,/data-prepare-dataset="tiny"[^>]+disabled/);assert.match(failed,/data-use-dataset="tiny"[^>]+disabled/);
 assert.match(rows({datasets:[]}),/还没有数据集/);
});
test('personal uploads without a configured source show resume guidance instead of a broken prepare action',()=>{
 const staging=rows({datasets:[{dataset:'u-user-private',versions:[{version:'a'.repeat(64),state:'STAGING',canPrepare:false}]}]});
 assert.doesNotMatch(staging,/data-prepare-dataset/);assert.match(staging,/重新选择同一目录继续上传/);assert.match(staging,/data-use-dataset="u-user-private"[^>]+disabled/);
 const ready=rows({datasets:[{dataset:'u-user-private',versions:[{version:'a'.repeat(64),state:'READY',canPrepare:false}]}]});
 assert.doesNotMatch(ready,/data-prepare-dataset/);assert.doesNotMatch(ready,/data-use-dataset="u-user-private"[^>]+disabled/);
});
test('evicted workspace publications guide users to republish, not resume a directory upload',()=>{
 const html=rows({datasets:[{dataset:'w-user-private',versions:[{version:'a'.repeat(64),state:'REGISTERED',canPrepare:false}]}]});
 assert.match(html,/个人数据空间.*重新发布/);assert.doesNotMatch(html,/继续上传|data-prepare-dataset/);assert.match(html,/data-use-dataset="w-user-private"[^>]+disabled/);
});
test('remote readiness never enables training or preparation on the selected machine',()=>{
 const html=rows({machine:'gpu-2',datasets:[{dataset:'same',versions:[{version:'a'.repeat(64),state:'NOT_LOCAL',canPrepare:false,locations:[{machine:'gpu-1<script>',state:'READY'}]}]}]});
 assert.match(html,/本机没有此版本/);assert.match(html,/gpu-1&lt;script&gt;/);assert.doesNotMatch(html,/<script>|data-prepare-dataset/);
 assert.match(html,/data-use-dataset="same"[^>]+disabled/);assert.match(html,/没有可用复制来源/);
});
test('approved remote source enables preparation, never claims a local ready copy',()=>{
 const html=rows({datasets:[{dataset:'remote',versions:[{version:'a'.repeat(64),state:'NOT_LOCAL',canPrepare:true,sourceMachine:'gpu-4'}]}]});
 assert.doesNotMatch(html,/data-(?:use|prepare)-dataset="remote"[^>]+disabled/);assert.match(html,/准备后训练/);assert.doesNotMatch(html,/实验室内网/);assert.doesNotMatch(html,/本机已就绪/);
});
test('unknown selected-machine status remains unavailable even when another location is ready',()=>{
 const html=rows({datasets:[{dataset:'same',versions:[{version:'a'.repeat(64),canPrepare:false,locations:[{machine:'gpu-1',state:'READY'}]}]}]});
 assert.match(html,/本机状态待确认/);assert.match(html,/data-use-dataset="same"[^>]+disabled/);assert.doesNotMatch(html,/data-prepare-dataset/);
});
test('capacity distinguishes unknown readings and shared space from a personal quota',()=>{
 assert.match(capacityText(null),/容量待更新/);assert.match(capacityText({available:false,availableBytes:99,filesystemBytes:100}),/容量待更新/);
 assert.match(capacityText({available:true,availableBytes:-1,filesystemBytes:100}),/容量待更新/);
 const text=capacityText({available:true,filesystemBytes:1024**4,availableBytes:100*1024**3,usableBytes:90*1024**3,reserveBytes:10*1024**3});
 assert.match(text,/100\.00 GiB/);assert.match(text,/90\.00 GiB/);assert.match(text,/安全预留 10\.00 GiB/);assert.match(datasetCapacityHTML({available:true,filesystemBytes:1024**4,availableBytes:100*1024**3,usableBytes:90*1024**3},'gpu-1'),/共享数据盘，容量不是个人配额/);
});
test('approved local preparation can be selected for training without claiming it is READY',()=>{
 for(const state of ['REGISTERED','STAGING','PREPARING']){
  const html=rows({datasets:[{dataset:'source',versions:[{version:'a'.repeat(64),state,canPrepare:state!=='PREPARING'}]}]});
  assert.doesNotMatch(html,/data-use-dataset="source"[^>]+disabled/);assert.match(html,/准备后训练/);assert.match(html,/准备期间不占额度/);assert.doesNotMatch(html,/本机已就绪/);
 }
 for(const state of ['NOT_LOCAL','UNKNOWN'])assert.match(rows({datasets:[{dataset:'absent',versions:[{version:'a'.repeat(64),state,canPrepare:true}]}]}),/data-use-dataset="absent"[^>]+disabled/);
 const failed=rows({datasets:[{dataset:'source',versions:[{version:'a'.repeat(64),state:'FAILED',canPrepare:true}]}]});
 assert.match(failed,/data-use-dataset="source"[^>]+disabled/);assert.doesNotMatch(failed,/data-prepare-dataset="source"[^>]+disabled/);
});
test('an unavailable catalog is not presented as an empty confirmed library',()=>{
 const html=rows({datasets:[],partial:true});assert.match(html,/目录未确认/);assert.doesNotMatch(html,/还没有分配或上传/);
});
test('location matrix uses authorized catalog machines and distinguishes absence from an unavailable catalog',()=>{
 const catalog={machine:'gpu-1',partial:true,machines:[{machine:'gpu-1',state:'ok'},{machine:'gpu-2',state:'ok'},{machine:'gpu-3',state:'unavailable'}],datasets:[{dataset:'same',versions:[{version:'a'.repeat(64),state:'REGISTERED',locations:[{machine:'gpu-1',state:'REGISTERED'}]}]}]};
 const version=catalog.datasets[0].versions[0],machines=datasetMachines(catalog);
 assert.deepEqual(machines.map(item=>item.machine),['gpu-1','gpu-2','gpu-3']);
 assert.equal(datasetLocation(version,machines[1],catalog).state,'NOT_LOCAL');
 assert.equal(datasetLocation(version,machines[2],catalog).state,'UNKNOWN');
 const html=rows(catalog);assert.match(html,/gpu-2 · 没有此版本/);assert.match(html,/gpu-3 · 目录未确认/);
 assert.doesNotMatch(html,/gpu-4|0\.0 MiB|0 个文件/,'No unauthorized machine or invented missing size');
});
test('an explicit unknown local location wins over a confirmed machine catalog',()=>{
 const machine={machine:'gpu-1',state:'ok'},catalog={machine:'gpu-1'};
 assert.equal(datasetLocation({state:'READY',locations:[{machine:'gpu-1',state:'UNKNOWN'}]},machine,catalog).state,'UNKNOWN');
 assert.equal(datasetLocation({state:'FUTURE_STATE'},machine,catalog).state,'UNKNOWN');
});
