import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetRows,capacityText,archiveStatus} from '../dist/datasets-ui.js';
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
 assert.doesNotMatch(datasetRows(catalog),/data-retry-archive/);
 catalog.machine='gpu-2';assert.match(datasetRows(catalog),/data-retry-archive="mine"/);
});
test('dataset cards keep full immutable versions and escape all text',()=>{
 const html=datasetRows({datasets:[{dataset:'<unsafe>',versions:[{version:'" onfocus="evil',state:'FAILED',bytes:1024,files:1}]}]});
 assert.ok(html.includes('&lt;unsafe&gt;'));assert.ok(html.includes('&quot; onfocus=&quot;evil'));assert.ok(!html.includes('<unsafe>'));
 assert.match(html,/准备失败/);
});
test('only ready datasets can be used and failed preparations can be retried',()=>{
 const ready=datasetRows({datasets:[{dataset:'tiny',versions:[{version:'a'.repeat(64),state:'READY',bytes:1,files:1}]}]});
 assert.match(ready,/data-prepare-dataset="tiny"[^>]+disabled/);assert.doesNotMatch(ready,/data-use-dataset="tiny"[^>]+disabled/);
 const failed=datasetRows({datasets:[{dataset:'tiny',versions:[{version:'a'.repeat(64),state:'FAILED',bytes:1,files:1}]}]});
 assert.doesNotMatch(failed,/data-prepare-dataset="tiny"[^>]+disabled/);assert.match(failed,/data-use-dataset="tiny"[^>]+disabled/);
 assert.match(datasetRows({datasets:[]}),/还没有分配/);
});
test('personal uploads without a configured source show resume guidance instead of a broken prepare action',()=>{
 const staging=datasetRows({datasets:[{dataset:'u-user-private',versions:[{version:'a'.repeat(64),state:'STAGING',canPrepare:false}]}]});
 assert.doesNotMatch(staging,/data-prepare-dataset/);assert.match(staging,/重新选择同一目录继续上传/);assert.match(staging,/data-use-dataset="u-user-private"[^>]+disabled/);
 const ready=datasetRows({datasets:[{dataset:'u-user-private',versions:[{version:'a'.repeat(64),state:'READY',canPrepare:false}]}]});
 assert.doesNotMatch(ready,/data-prepare-dataset/);assert.doesNotMatch(ready,/data-use-dataset="u-user-private"[^>]+disabled/);
});
test('evicted workspace publications guide users to republish, not resume a directory upload',()=>{
 const html=datasetRows({datasets:[{dataset:'w-user-private',versions:[{version:'a'.repeat(64),state:'REGISTERED',canPrepare:false}]}]});
 assert.match(html,/个人数据空间.*重新发布/);assert.doesNotMatch(html,/继续上传|data-prepare-dataset/);assert.match(html,/data-use-dataset="w-user-private"[^>]+disabled/);
});
test('remote readiness never enables training or preparation on the selected machine',()=>{
 const html=datasetRows({machine:'gpu-2',datasets:[{dataset:'same',versions:[{version:'a'.repeat(64),state:'NOT_LOCAL',canPrepare:false,locations:[{machine:'gpu-1<script>',state:'READY'}]}]}]});
 assert.match(html,/本机没有此版本/);assert.match(html,/gpu-1&lt;script&gt;/);assert.doesNotMatch(html,/<script>|data-prepare-dataset/);
 assert.match(html,/data-use-dataset="same"[^>]+disabled/);assert.match(html,/没有到本机的可用共享通道/);
});
test('approved remote source enables preparation, never claims a local ready copy',()=>{
 const html=datasetRows({datasets:[{dataset:'remote',versions:[{version:'a'.repeat(64),state:'NOT_LOCAL',canPrepare:true,sourceMachine:'gpu-4'}]}]});
 assert.doesNotMatch(html,/data-(?:use|prepare)-dataset="remote"[^>]+disabled/);assert.match(html,/准备后训练/);assert.match(html,/实验室内网/);assert.doesNotMatch(html,/本机已就绪/);
});
test('unknown selected-machine status remains unavailable even when another location is ready',()=>{
 const html=datasetRows({datasets:[{dataset:'same',versions:[{version:'a'.repeat(64),canPrepare:false,locations:[{machine:'gpu-1',state:'READY'}]}]}]});
 assert.match(html,/本机状态待确认/);assert.match(html,/data-use-dataset="same"[^>]+disabled/);assert.doesNotMatch(html,/data-prepare-dataset/);
});
test('capacity distinguishes unknown readings and shared space from a personal quota',()=>{
 assert.match(capacityText(null),/暂未确认/);assert.match(capacityText({available:false,availableBytes:99,filesystemBytes:100}),/暂未确认/);
 assert.match(capacityText({available:true,availableBytes:-1,filesystemBytes:100}),/暂未确认/);
 const text=capacityText({available:true,filesystemBytes:1024**4,availableBytes:100*1024**3,usableBytes:90*1024**3,reserveBytes:10*1024**3});
 assert.match(text,/100\.00 GiB/);assert.match(text,/90\.00 GiB/);assert.match(text,/安全预留 10\.00 GiB/);assert.match(text,/共享磁盘容量，不是个人配额/);
});
test('approved local preparation can be selected for training without claiming it is READY',()=>{
 for(const state of ['REGISTERED','STAGING','PREPARING']){
  const html=datasetRows({datasets:[{dataset:'source',versions:[{version:'a'.repeat(64),state,canPrepare:state!=='PREPARING'}]}]});
  assert.doesNotMatch(html,/data-use-dataset="source"[^>]+disabled/);assert.match(html,/准备后训练/);assert.match(html,/不会提前占卡/);assert.doesNotMatch(html,/本机已就绪/);
 }
 for(const state of ['NOT_LOCAL','UNKNOWN'])assert.match(datasetRows({datasets:[{dataset:'absent',versions:[{version:'a'.repeat(64),state,canPrepare:true}]}]}),/data-use-dataset="absent"[^>]+disabled/);
 const failed=datasetRows({datasets:[{dataset:'source',versions:[{version:'a'.repeat(64),state:'FAILED',canPrepare:true}]}]});
 assert.match(failed,/data-use-dataset="source"[^>]+disabled/);assert.doesNotMatch(failed,/data-prepare-dataset="source"[^>]+disabled/);
});
test('an unavailable catalog is not presented as an empty confirmed library',()=>{
 const html=datasetRows({datasets:[],partial:true});assert.match(html,/目录尚未完整确认/);assert.doesNotMatch(html,/还没有分配或上传/);
});
