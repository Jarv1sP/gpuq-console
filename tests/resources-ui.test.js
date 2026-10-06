import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceCards,resourceServerView,monitorSummary,compactResourceId} from '../dist/resources-ui.js';
const machine={id:'gpu-1',cards:1,model:'GPU',memory:'24 GiB'};
const snapshot={checkedAt:new Date().toISOString(),stale:false,hosts:[{id:'gpu-1',reachable:true,gpus:[{index:0,utilization:0,memoryTotalMiB:24576,memoryUsedMiB:null,processesAvailable:true,processes:[{pid:42,name:'<script>alert(1)</script>',owner:'other-owner',memoryUsedMiB:1024}]}],gpuq:{connected:true,jobs:[]}}]};
test('resource ID fallback preserves distinct suffixes and full inventory values',()=>{
 const ids=['example-rack-model-08','example-rack-model-06'];
 const compact=ids.map(id=>compactResourceId(id,value=>value.length<=12));
 assert.notEqual(compact[0],compact[1]);
 compact.forEach((value,index)=>{assert.ok(value.length<=12);assert.match(value,/…model-/);assert.ok(value.endsWith(ids[index].split('-').slice(-2).join('-')));});
 assert.equal(compactResourceId(ids[0],()=>true),ids[0]);
 assert.equal(compactResourceId('example-verylongsuffix',()=>false),'…verylongsuffix');
 const html=resourceCards({machines:ids.map(id=>({...machine,id})),admin:true});
 for(const id of ids){assert.ok(html.includes('title="'+id+'"'));assert.ok(html.includes('data-resource-select="'+id+'"'));}
});
test('process priorities are displayed only when matched; member view omits job identity',()=>{
 const data=structuredClone(snapshot);data.hosts[0].gpus[0].processes.push({pid:43,memoryUsedMiB:2,scheduling:{priority:0,jobId:'private-job'}});
 const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot:data,admin:true,production:true});
 assert.match(html,/P0（原队列）/);assert.match(html,/未确认/);assert.match(html,/private-job/);
 const member=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot:data,production:true});assert.ok(!member.includes('private-job'));
});
test('resource display distinguishes zero, unknown and stale and escapes process values',()=>{
 const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot,admin:true,production:true});
 assert.match(html,/0%/);assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('<script>'));assert.match(html,/other-owner/);assert.match(html,/—/);
 const stale=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot:{...snapshot,stale:true},admin:true,production:true});assert.match(stale,/状态未知/);assert.ok(!stale.includes('data-gpu-index'));assert.match(monitorSummary({...snapshot,stale:true},true),/已过期/);
});
test('resource page never renders unapproved card or private process fields for a member',()=>{
 const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot,production:true});assert.ok(!html.includes('other-owner'));assert.ok(!html.includes('alert(1)'));assert.match(html,/>42</);
 const denied=resourceCards({machines:[machine],snapshot,production:true});assert.ok(!denied.includes('data-gpu-index'));assert.match(denied,/未授权/);assert.match(denied,/disabled/);
});

test('fleet preserves physical capacity while only the selected server reveals detail',()=>{
 const machines=[machine,{...machine,id:'gpu-2',cards:2},{...machine,id:'gpu-3',cards:6}];
 const html=resourceCards({machines,selectedMachine:'gpu-2',snapshot,production:true,admin:true});
 assert.equal((html.match(/class="resource-tower(?: [^"]*)?"/g)||[]).length,9);
 assert.equal((html.match(/data-resource-selected=/g)||[]).length,1);
 assert.match(html,/data-resource-selected="gpu-2"/);
 assert.ok(!html.includes('>42</'),'Unselected server process data stays out of the detail');
 assert.match(html,/data-resource-card-count="6"/,'Six-card servers never become eight invented slots');
});

test('invalid, incomplete, stale, demo and missing process evidence never become idle',()=>{
 const clear=structuredClone(snapshot);Object.assign(clear.hosts[0].gpus[0],{memoryUsedMiB:0,processes:[]});
 const options={limits:{'gpu-1':1},production:true};
 assert.equal(resourceServerView(machine,{...options,snapshot:clear}).busy,0);
 for(const change of [
  data=>data.hosts[0].gpus.push({...data.hosts[0].gpus[0]}),
  data=>data.hosts[0].gpus[0].index=1,
  data=>data.hosts[0].gpus=[],
  data=>data.hosts[0].gpus[0].processesAvailable=false,
  data=>data.hosts[0].gpus[0].processes=null,
  data=>data.hosts.push({...data.hosts[0]}),
  data=>data.stale=true,
  data=>data.hosts[0].reachable=false,
 ]){
  const data=structuredClone(clear);change(data);
  assert.equal(resourceServerView(machine,{...options,snapshot:data}).busy,null);
  const html=resourceCards({machines:[machine],...options,snapshot:data});
  assert.doesNotMatch(html,/resource-tower-bar free/);
  assert.match(html,/占用未确认/);
 }
 assert.equal(resourceServerView(machine,{...options,snapshot:clear,production:false}).busy,null);
 assert.doesNotMatch(resourceCards({machines:[machine],...options,snapshot:clear,production:false}),/resource-tower-bar free/);
});

test('unknown memory is not a zero fill and monitoring does not prove scheduler admission',()=>{
 const data=structuredClone(snapshot);Object.assign(data.hosts[0].gpus[0],{memoryUsedMiB:null,processes:[]});data.hosts[0].gpuq={connected:false};
 const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot:data,production:true});
 assert.match(html,/resource-tower-bar unknown/);assert.doesNotMatch(html,/data-resource-level=/);
 assert.match(html,/训练连接不可用/);assert.match(html,/监控在线/);
 assert.doesNotMatch(html,/可立即启动/);
});

test('white fills require confirmed process-to-own-task joins, never placement guesses',()=>{
 const data=structuredClone(snapshot);Object.assign(data.hosts[0].gpus[0],{memoryUsedMiB:1024,processes:[{pid:42,task:{id:'own',name:'my training'}}]});
 const options={machines:[machine],limits:{'gpu-1':1},snapshot:data,production:true,userId:'me',jobs:[{id:'own',userId:'me',assignedIndices:[0]}]};
 assert.match(resourceCards(options),/resource-tower-bar mine/);
 data.hosts[0].gpus[0].processes.push({pid:43,task:{id:'someone-else',name:'other training'}});
 assert.match(resourceCards(options),/resource-tower-bar used/);
 data.hosts[0].gpus[0].processes=[{pid:44}];
 assert.match(resourceCards(options),/resource-tower-bar used/);
 assert.doesNotMatch(resourceCards(options),/resource-tower-bar mine/);
});

test('unauthorized selection reveals no monitoring, queues, task metadata or administrative tools',()=>{
 const data=structuredClone(snapshot);data.hosts[0].tasks=[{id:'secret',name:'DO-NOT-REVEAL',description:'PRIVATE-DESCRIPTION'}];
 const html=resourceCards({machines:[machine],snapshot:data,production:true});
 for(const privateValue of ['DO-NOT-REVEAL','PRIVATE-DESCRIPTION','other-owner','alert(1)','data-resource-root','data-resource-level'])assert.ok(!html.includes(privateValue),privateValue);
 assert.match(html,/resource-tower-bar locked/);
});

test('a many-task GPU keeps a compact tile while retaining every process task in detail',()=>{
 const data=structuredClone(snapshot);data.hosts[0].gpus[0].memoryUsedMiB=2048;
 data.hosts[0].gpus[0].processes=Array.from({length:20},(_,index)=>({pid:100+index,memoryUsedMiB:100,task:{id:'task-'+index,name:'Experiment '+index,submitter:{name:'Researcher '+index},description:'Description '+index}}));
 const html=resourceCards({machines:[machine],limits:{'gpu-1':1},snapshot:data,production:true});
 assert.match(html,/另 19 个任务 · 详见进程/);
 for(let index=0;index<20;index++){assert.ok(html.includes('Experiment '+index));assert.ok(html.includes('Description '+index));}
});

test('maintenance stays independent of measured occupancy and preserves authorization',()=>{
 const data=structuredClone(snapshot);data.hosts[0].gpus[0].memoryUsedMiB=1024;
 const entry={reason:'维修 <script>unsafe</script>',since:'2026-10-05T00:00:00Z'};
 const maintenance={version:1,revision:9,global:null,machines:{'gpu-1':entry}};
 const options={machines:[machine],limits:{'gpu-1':1},snapshot:data,production:true,maintenance};
 const view=resourceServerView(machine,options);
 assert.equal(view.fresh,true);assert.equal(view.maintenance,entry);
 const html=resourceCards(options);
 assert.match(html,/maintenance-lock-band/);assert.match(html,/维修 &lt;script&gt;unsafe&lt;\/script&gt;/);
 assert.doesNotMatch(html,/<script>/);assert.match(html,/data-resource-level=/);assert.match(html,/>42</);
 assert.equal(resourceServerView(machine,{...options,maintenance:{...maintenance,global:entry,machines:{}}}).maintenance,entry);
 const denied=resourceCards({...options,limits:{}});
 assert.doesNotMatch(denied,/维修|maintenance-lock-band|data-resource-level=/);
});
