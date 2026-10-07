import test from 'node:test';
import assert from 'node:assert/strict';
import {projectPreparationReadout,workbenchCards,missionHTML,missionGPUs,jobFacts,jobOverviewHTML,trainingReadout} from '../dist/workbench-ui.js';

const target='fixture-destination-long-id',source='fixture-development-location';
const job=(state='PREPARING_DATA',preparation='PREPARING')=>({id:'copy-task',userId:'owner',name:'copy-task',machine:target,cards:2,state,
  project:'personal-project',release:'a'.repeat(64),assignedIndices:[],machineSelection:{mode:'auto'},
  projectPreparation:{from:source,project:'personal-project',release:'a'.repeat(64),state:preparation,operationId:'fixed-copy-operation'}});

test('waiting and copying project phases expose the chosen target without changing the development source',()=>{
  for(const state of ['WAITING','PREPARING']){
    const row=job('PREPARING_DATA',state),before=structuredClone(row),readout=projectPreparationReadout(row);
    assert.equal(readout.copying,true);assert.equal(readout.label,'复制项目');assert.equal(readout.from,source);
    assert.equal(readout.operationId,'fixed-copy-operation');
    for(const html of [workbenchCards([row]),missionHTML(row),jobOverviewHTML(row)]){
      assert.match(html,/data-project-preparation/);assert.match(html,/复制项目到/);assert.match(html,/未占显卡/);
      assert.ok(html.includes('title="'+target+'"'));assert.ok(html.includes(source));assert.match(html,/自动选机/);
    }
    assert.match(jobFacts(row),/请求 2 张/);assert.deepEqual(row,before);
  }
});

test('project preparation remains visible in compact cards as well as the focused card',()=>{
  const html=workbenchCards([{...job('RUNNING','READY'),id:'running'},job()]);
  const compact=html.slice(html.indexOf('class="job compact-job"'));
  assert.match(compact,/复制项目到/);assert.match(compact,/自动选机/);assert.match(compact,/请求 2 张/);
});

test('READY moves the display to data preparation without claiming training has started',()=>{
  const row=job('PREPARING_DATA','READY');
  assert.equal(projectPreparationReadout(row).copying,false);assert.equal(projectPreparationReadout(row).label,'准备数据');
  const html=workbenchCards([row]);assert.match(html,/项目已就绪/);assert.match(html,/未占显卡/);assert.doesNotMatch(html,/复制项目到/);
  assert.equal(row.state,'PREPARING_DATA');
});

test('unknown and failed project receipts stay explicit; a running task keeps only its automatic-selection label',()=>{
  for(const state of [undefined,'UNCONFIRMED','corrupt']){
    const row=job();row.projectPreparation.state=state;assert.equal(projectPreparationReadout(row).label,'项目准备待确认');
    assert.doesNotMatch(missionHTML(row),/项目已就绪/);
  }
  assert.match(missionHTML(job('PREPARING_DATA','FAILED')),/项目复制失败/);
  const running=job('RUNNING','READY');assert.equal(projectPreparationReadout(running),null);
  assert.doesNotMatch(missionHTML(running),/data-project-preparation/);assert.match(missionHTML(running),/自动选机/);
});

test('preparation never presents requested or leftover GPU indices as an allocation',()=>{
  const row={...job(),assignedIndices:[0,1]},machines=[{id:target,cards:2}];
  assert.deepEqual(missionGPUs(row,{stale:false,hosts:[]},machines),[]);
  assert.match(missionHTML(row,{machines}),/显卡尚未分配/);assert.doesNotMatch(missionHTML(row,{machines}),/r5-mission-hardware/);
  assert.match(jobFacts(row),/请求 2 张/);assert.doesNotMatch(jobFacts(row),/GPU 0/);
  row.progress={reported:true,stale:false,snapshot:{epochsCompleted:12,epochsTotal:40,metrics:{loss:.5}}};
  assert.equal(trainingReadout(row).percent,null);assert.deepEqual(trainingReadout(row).metrics,[]);
  assert.match(missionHTML(row),/wb-stage-hero/);assert.doesNotMatch(missionHTML(row),/r5-mission-percentage/);
});

test('legacy tasks keep their existing preparation label and remote facts are escaped as text',()=>{
  const legacy={...job(),projectPreparation:undefined,machineSelection:undefined};
  assert.equal(projectPreparationReadout(legacy),null);assert.doesNotMatch(workbenchCards([legacy]),/自动选机|data-project-preparation/);
  assert.match(workbenchCards([legacy]),/准备数据/);
  const unsafe=job();unsafe.machine='<script>target</script>';unsafe.projectPreparation.from='<img src=x onerror=alert(1)>';
  unsafe.projectPreparation.operationId='<script>operation</script>';
  for(const html of [workbenchCards([unsafe]),missionHTML(unsafe),jobOverviewHTML(unsafe)]){
    assert.doesNotMatch(html,/<script>|<img /);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);
  }
});
