import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingCardHTML,warehouseCardHTML} from '../dist/dataset-flow.js';
import {maintenanceFor} from '../dist/maintenance-state.js';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id,other=MACHINES[1].id;
const snapshot={version:1,revision:1,global:null,machines:{[machine]:{reason:'维护原因 <script>',since:'2026-01-01T00:00:00Z'}}};

test('maintained training card shows one state rather than individual unknown statistics',()=>{
 const html=trainingCardHTML({machine,maintenance:maintenanceFor(snapshot,machine),readyContentBytes:null,budgetBytes:null,projectBytes:null,volume:{totalBytes:null,availableBytes:null}});
 assert.match(html,/维护中/);assert.match(html,/data-v3-filter=/);assert.doesNotMatch(html,/未知|GiB|v4-training-bar|v4-data-value/);
 assert.match(html,/维护原因 &lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test('maintained warehouse shows one state and preserves its filter identity',()=>{
 const html=warehouseCardHTML({machine,maintenance:maintenanceFor(snapshot,machine),totalBytes:null,availableBytes:null,contentBytes:null},true);
 assert.match(html,/维护中/);assert.match(html,/data-v4-warehouse=/);assert.match(html,/aria-pressed="true"/);assert.doesNotMatch(html,/未知|capacity-strata|capacity-values/);
});
test('maintenance on another node does not hide a healthy node reading',()=>{
 const html=trainingCardHTML({machine:other,maintenance:maintenanceFor(snapshot,other),readyContentBytes:64,usageComplete:false,budgetBytes:128,volume:{totalBytes:1000,usedBytes:300,availableBytes:700}});
 assert.doesNotMatch(html,/维护中/);assert.match(html,/≥ 64 B/);assert.match(html,/700 B/);
});
test('global maintenance applies to every displayed room card',()=>{
 const value={...snapshot,global:{reason:'全平台维护'}};
 for(const id of [machine,other])for(const render of [trainingCardHTML,warehouseCardHTML])assert.match(render({machine:id,maintenance:maintenanceFor(value,id)}),/维护中/);
});
test('unknown maintenance protocol cannot be presented as confirmed maintenance',()=>{
 const html=trainingCardHTML({machine,maintenance:maintenanceFor({version:0,machines:snapshot.machines},machine)});
 assert.doesNotMatch(html,/维护中/);assert.match(html,/未知/);
});
