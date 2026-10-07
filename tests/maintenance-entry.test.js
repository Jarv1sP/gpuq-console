import test from 'node:test';
import assert from 'node:assert/strict';
import {operationalMaintenanceHTML} from '../dist/maintenance-ui.js';
import {trainingUnavailable} from '../dist/execution-ui.js';
import {DemoClient} from '../dist/client.js';
import {workbenchCards} from '../dist/workbench-ui.js';

const maintenance={version:1,revision:51,global:null,machines:{locked:{reason:'磁盘维修'},other:{reason:'另一台的原因'}}};
test('readonly notification follows the selected scope, never unrelated machines',()=>{
  assert.doesNotMatch(workbenchCards([],{maintenance}),/维护|暂停/,'Empty tasks do not imply unrelated maintenance restricts this server');
  assert.equal(operationalMaintenanceHTML(maintenance,'active'),'');
  assert.equal(operationalMaintenanceHTML(maintenance),'');
  const html=operationalMaintenanceHTML(maintenance,'locked');
  assert.match(html,/locked维护中/);assert.match(html,/磁盘维修/);assert.match(html,/暂停训练提交、终端输入和数据写入/);assert.doesNotMatch(html,/另一台的原因|data-maintenance-resume|maintenance\.set/);
});
test('global notice takes precedence and failed observations never imply recovery',()=>{
  const html=operationalMaintenanceHTML({...maintenance,global:{reason:'<维修>'}},'locked');
  assert.match(html,/全平台维护中/);assert.match(html,/&lt;维修&gt;/);assert.doesNotMatch(html,/<维修>|磁盘维修/);
  assert.match(operationalMaintenanceHTML(maintenance,'active',{unknown:true}),/维护状态未确认/);
  assert.match(operationalMaintenanceHTML(null,'active'),/维护状态未确认/);
});
test('training depends on live scheduling facts independently of portal maintenance',()=>{
  const active={id:'node',reachable:true,gpuq:{connected:true,observeOnly:false,health:'ok'}};
  assert.equal(trainingUnavailable({stale:false},[active]),false);
  const observing={...active,gpuq:{...active.gpuq,observeOnly:true}};
  assert.equal(trainingUnavailable({stale:false},[observing]),true);
  assert.equal(trainingUnavailable({stale:false},[observing,active]),false,'Automatic training retains any ready candidate');
  assert.equal(trainingUnavailable({stale:true},[observing]),false,'Stale data does not assert current scheduling closure');
  assert.equal(trainingUnavailable({stale:false},[{...active,gpuq:{...active.gpuq,connected:false}}]),true);
  assert.equal(trainingUnavailable({stale:false},[{...active,gpuq:{...active.gpuq,health:'degraded'}}]),true);
  assert.equal(trainingUnavailable({stale:false},[]),false,'Missing facts are not invented closure');
});
test('maintenance read failure preserves the last ledger and reports uncertainty until a fresh read',async()=>{
  const client=new DemoClient();client.principal={userId:'owner',role:'member'};client.data={operationalMaintenance:maintenance};
  client.invoke=async()=>{throw Error('read unavailable');};
  await assert.rejects(client.call('state'),/read unavailable/);assert.equal(client.maintenanceStatusUnknown,true);assert.equal(client.data.operationalMaintenance,maintenance);
  client.invoke=async()=>({state:{operationalMaintenance:maintenance}});await client.refresh();assert.equal(client.maintenanceStatusUnknown,false);
  client.invoke=async()=>{throw Error('status unavailable');};await assert.rejects(client.call('maintenance.status'),/status unavailable/);assert.equal(client.maintenanceStatusUnknown,true);
  client.invoke=async()=>({result:maintenance});await client.call('maintenance.status');assert.equal(client.maintenanceStatusUnknown,false);
});
test('late maintenance failures from another identity cannot overwrite the current observation',async()=>{
  const client=new DemoClient();client.principal={userId:'old',role:'member'};let reject;
  client.invoke=()=>new Promise((_,fail)=>{reject=fail;});const pending=client.call('state');
  client.authGeneration++;client.principal={userId:'new',role:'member'};client.maintenanceStatusUnknown=false;reject(Error('old read failed'));
  await assert.rejects(pending,error=>error.code==='STALE_SESSION');assert.equal(client.maintenanceStatusUnknown,false);
});
