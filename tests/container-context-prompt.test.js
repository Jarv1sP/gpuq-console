import test from 'node:test';
import assert from 'node:assert/strict';
import {containerContextPrompt} from '../dist/workbench-ui.js';
import {MACHINES} from '../dist/machines.js';

test('only confirmed personal containers replace the required-server prompt',()=>{
  for(const environmentMode of [undefined,'shared','isolated','future-mode']){
    const result=containerContextPrompt({environmentMode,trainingTarget:'auto'});
    assert.equal(result.label,'服务器');assert.equal(result.empty,'请选择服务器');
  }
  assert.deepEqual(containerContextPrompt({environmentMode:'oci',trainingTarget:'auto'}),{label:'训练',empty:'自动选择',title:'自动选择兼容服务器',ariaLabel:'切换服务器焦点，个人容器开发位置保持不变'});
});

test('the prompt reflects actual training mode without replacing source or focus',()=>{
  const source=MACHINES[1].id,focus=MACHINES[0].id;
  assert.deepEqual(containerContextPrompt({environmentMode:'oci',trainingTarget:'current',source}),{label:'训练',empty:'开发位置',title:source,ariaLabel:'切换服务器焦点，个人容器开发位置保持不变'});
  assert.equal(containerContextPrompt({environmentMode:'oci',trainingTarget:'auto',source,focus}).title,focus);
  assert.equal(containerContextPrompt({environmentMode:'oci',trainingTarget:'auto',source,focus}).label,'服务器');
  for(const trainingTarget of [undefined,'future-mode'])assert.equal(containerContextPrompt({environmentMode:'oci',trainingTarget}).empty,'可选服务器');
  assert.equal(containerContextPrompt({environmentMode:'oci',trainingTarget:'current'}).empty,'可选服务器');
  assert.equal(containerContextPrompt({environmentMode:'shared',trainingTarget:'auto',focus}).title,focus);
});
