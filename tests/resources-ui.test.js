import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceCards,monitorSummary} from '../dist/resources-ui.js';
const machine={id:'gpu-1',cards:1,model:'GPU',memory:'24 GiB'};
const snapshot={checkedAt:new Date().toISOString(),stale:false,hosts:[{id:'gpu-1',reachable:true,gpus:[{index:0,utilization:0,memoryTotalMiB:24576,memoryUsedMiB:null,processesAvailable:true,processes:[{pid:42,name:'<script>alert(1)</script>',owner:'other-owner',memoryUsedMiB:1024}]}],gpuq:{connected:true,jobs:[]}}]};
test('process priorities are displayed only when matched; member view omits job identity',()=>{
 const data=structuredClone(snapshot);data.hosts[0].gpus[0].processes.push({pid:43,memoryUsedMiB:2,scheduling:{priority:0,jobId:'private-job'}});
 const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot:data,admin:true,production:true});
 assert.match(html,/P0（原队列）/);assert.match(html,/未确认 \/ 未纳管/);assert.match(html,/private-job/);
 const member=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot:data,production:true});assert.ok(!member.includes('private-job'));
});
test('resource display distinguishes zero, unknown and stale and escapes process values',()=>{
 const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot,admin:true,production:true});
 assert.match(html,/0%/);assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('<script>'));assert.match(html,/other-owner/);assert.match(html,/—/);
 const stale=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot:{...snapshot,stale:true},admin:true,production:true});assert.match(stale,/状态未知/);assert.ok(!stale.includes('data-gpu-index'));assert.match(monitorSummary({...snapshot,stale:true},true),/已过期/);
});
test('resource page never renders unapproved card or private process fields for a member',()=>{
 const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot,production:true});assert.ok(!html.includes('other-owner'));assert.ok(!html.includes('alert(1)'));assert.match(html,/>42</);
 const denied=resourceCards({machines:[machine],snapshot,production:true});assert.ok(!denied.includes('data-gpu-index'));assert.match(denied,/未授权查看监控/);assert.match(denied,/disabled/);
});
