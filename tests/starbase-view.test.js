import test from 'node:test';
import assert from 'node:assert/strict';
import {controlSnapshot,serverSlotsHTML} from '../dist/control-ui.js';
import {trainingReadout,workbenchCards,jobOverviewHTML,stateClass,personalQuotaReadout} from '../dist/workbench-ui.js';

function fixture(role='member'){
  const jobs=[{id:'own-run',userId:'owner',name:'own',state:'RUNNING',machine:'gpu-1',cards:2},{id:'own-prep',userId:'owner',state:'PREPARING_DATA',cards:1},{id:'other-failed',userId:'other',state:'FAILED',cards:8}];
  return {principal:{userId:'owner',role},production:true,jobs,users:[{id:'owner',role,total:4,limits:{'gpu-1':4}},{id:'pending',name:'待审批',role:'member',enabled:true,total:0}],data:{machines:[{id:'gpu-1',cards:2},{id:'private-node',cards:8}],gpuq:{stale:false,hosts:[{id:'gpu-1',reachable:true,gpuq:{connected:true,health:'ok',observeOnly:false},gpus:[{index:0,processesAvailable:true,processes:[]},{index:1,processesAvailable:false,processes:[]}]}]}},usage:()=>2};
}
test('a reachable host with failed/missing scheduler health or duplicate cards is never reported free',()=>{
  for(const gpuq of [undefined,{connected:false,health:'ok'},{connected:true,health:'unknown'},{connected:true},{connected:true,health:'error'}]){
    const store=fixture();store.data.gpuq.hosts[0].gpuq=gpuq;store.data.gpuq.hosts[0].gpus[1].processesAvailable=true;
    const server=controlSnapshot(store).servers[0];assert.equal(server.state,'unknown');assert.equal(server.busy,null);
  }
  const store=fixture(),host=store.data.gpuq.hosts[0];host.gpus[1].processesAvailable=true;host.gpus[1].index=0;assert.equal(controlSnapshot(store).servers[0].busy,null);
  host.gpus[1].index=2;assert.equal(controlSnapshot(store).servers[0].busy,null);
  store.data.gpuq.stale=undefined;assert.equal(controlSnapshot(store).servers[0].state,'unknown');
});
test('control is owner-bound and never treats an incomplete process inventory as free',()=>{
  const store=fixture(),snapshot=controlSnapshot(store,{sessions:[{id:'mine',userId:'owner'},{id:'foreign',userId:'other'},{id:'root',userId:'owner',hostAdmin:true}],activities:[{id:'data',userId:'owner',state:'RUNNING'},{id:'foreign-data',userId:'other',state:'FAILED'}]});
  assert.deepEqual(snapshot.jobs.map(job=>job.id),['own-run','own-prep']);assert.deepEqual(snapshot.sessions.map(row=>row.id),['mine']);assert.equal(snapshot.attention.length,0);assert.deepEqual(snapshot.servers.map(row=>row.id),['gpu-1']);assert.equal(snapshot.servers[0].busy,null);assert.equal(snapshot.dataCount,null);
  store.data.gpuq.hosts[0].gpus[1].processesAvailable=true;assert.equal(controlSnapshot(store).servers[0].busy,0);
  store.data.gpuq.stale=true;assert.equal(controlSnapshot(store).servers[0].busy,null);assert.equal(controlSnapshot(store).servers[0].state,'unknown');
});
test('individual control slots cannot look free when the full GPU inventory is unconfirmed',()=>{
  const store=fixture(),host=store.data.gpuq.hosts[0];
  host.gpus.forEach(gpu=>Object.assign(gpu,{processesAvailable:true,memoryUsedMiB:0,memoryTotalMiB:32768}));
  assert.match(serverSlotsHTML(controlSnapshot(store).servers[0]),/slot free/);
  for(const change of [()=>{host.gpus[1].index=0;},()=>{host.gpus[1].index=2;},()=>{host.gpus.pop();}]){
    const original=structuredClone(host.gpus);change();const server=controlSnapshot(store).servers[0];
    assert.equal(server.available,false);assert.equal(server.busy,null);
    assert.doesNotMatch(serverSlotsHTML(server),/slot (?:free|used)/);assert.match(serverSlotsHTML(server),/占用未确认/);host.gpus=original;
  }
  host.gpus[0].memoryUsedMiB=-1;assert.match(serverSlotsHTML(controlSnapshot(store).servers[0]),/GPU 0 · 占用未确认/);
});
test('primary control omits member approvals for both roles, and only a complete data listing has an aggregate',()=>{
  assert.equal(controlSnapshot(fixture()).attention.length,0);const snapshot=controlSnapshot(fixture('admin'),{activitiesComplete:true,activities:[{id:'one',userId:'owner',state:'RUNNING'},{id:'one',userId:'owner',state:'RUNNING'},{id:'two',userId:'owner',state:'FAILED'}]});assert.equal(snapshot.dataCount,1);assert.equal(snapshot.attention.length,0,'member approvals live in the backend and timestamp-less failures do not create an alert');assert.equal(snapshot.attention.some(row=>row.id.startsWith('user:')),false);
  assert.deepEqual(snapshot.approvals.map(row=>row.id),['pending'],'approvals remain actionable in the admin console; missing failure times do not alert');
  const store=fixture();store.principal=null;assert.deepEqual(controlSnapshot(store).jobs,[]);assert.equal(controlSnapshot(store).quota,null);
});
test('control quota exemption follows the current enabled account rather than a stale principal',()=>{
  const store=fixture('admin');store.users[0].enabled=true;store.usage=()=>31;
  let snapshot=controlSnapshot(store);assert.equal(snapshot.quotaReadout.exempt,true);assert.equal(snapshot.quotaReadout.value,'31');assert.equal(snapshot.usage,31);assert.equal(snapshot.quota,4,'physical inventory metadata remains available, but is not the personal ceiling');
  store.users[0].role='member';snapshot=controlSnapshot(store);assert.equal(snapshot.quotaReadout.exempt,false);assert.equal(snapshot.quotaReadout.value,'31 / 4');
  store.users[0].role='admin';store.users[0].enabled=false;assert.equal(controlSnapshot(store).quotaReadout.exempt,false);
});
test('documented 2026-10-07 exemption prefers a backend field, with enabled-role fallback',()=>{
  // 来源：STARGATE 功能与接口手册（2026-10-07），shared / 独占 / AUTO 一致。
  const admin={role:'admin',enabled:true,total:30};
  assert.deepEqual(personalQuotaReadout(admin,31),{exempt:true,label:'不限个人额度',value:'31',note:''});
  assert.equal(personalQuotaReadout({...admin,personalCardQuotaExempt:false},31).value,'31 / 30');
  assert.equal(personalQuotaReadout({...admin,personalCardQuotaExempt:true},31).exempt,true);
  assert.equal(personalQuotaReadout({...admin,enabled:false,personalCardQuotaExempt:true},31).exempt,false);
  assert.equal(personalQuotaReadout({...admin,role:'member'},31).value,'31 / 30');
});
test('stale or missing self-report never becomes a progress percentage or ETA',()=>{
  const job={progress:{reported:true,stale:true,snapshot:{epochsCompleted:12,epochsTotal:40,etaSeconds:60,updatedAt:1790700000,metrics:{loss:.4}}}};assert.equal(trainingReadout(job).percent,null);assert.equal(trainingReadout(job).eta,'');assert.deepEqual(trainingReadout(job).metrics,[]);
  job.progress.stale=false;assert.equal(trainingReadout(job).percent,30);assert.equal(trainingReadout(job).epoch,'第 12 / 40 轮');assert.match(trainingReadout(job).eta,/训练上报/);
  job.progress.snapshot.metrics={accuracy:.8,epoch:12,lr:.0003,val_acc:.7,loss:.4};assert.deepEqual(trainingReadout(job).metrics.map(([name])=>name),['loss','val_acc','lr']);
  assert.equal(stateClass({state:'RUNNING',cancelRequested:true}),'st-cancel');
});
test('workbench and drawer escape task data and do not reveal another member’s command',()=>{
  const job={id:'full-identity-123',name:'<img src=x onerror=alert(1)>',description:'<script>bad</script>',state:'RUNNING',userId:'owner',cards:1,machine:'gpu-1',argv:['PRIVATE-COMMAND']};
  const html=workbenchCards([job]);assert.equal((html.match(/hero-frame/g)||[]).length,1);assert.doesNotMatch(html,/<img|<script/);assert.match(html,/full-identity-123/);assert.doesNotMatch(jobOverviewHTML(job,{owned:false}),/PRIVATE-COMMAND/);assert.match(jobOverviewHTML(job),/PRIVATE-COMMAND/);
});
