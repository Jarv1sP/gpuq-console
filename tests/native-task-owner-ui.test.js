import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {visibleGPUQStatus,readGPUQStatus} from '../gpuq-status.mjs';
import {MACHINES} from '../dist/machines.js';
import {resourceCards} from '../dist/resources-ui.js';
import {taskIdentityHTML,taskTable,canEditPriority} from '../dist/execution-ui.js';

const machine=MACHINES[0],owner='native-fixture-owner',name='原生训练 <img src=x onerror=alert(1)>';
const description='第一阶段\n<script>仅作文字</script>';
function host(){return {id:machine.id,reachable:true,gpus:Array.from({length:machine.cards},(_,index)=>({index,memoryTotalMiB:24576,memoryUsedMiB:index===0?1200:0,utilization:0,processesAvailable:true,processes:index===0?[{pid:42,memoryUsedMiB:1200,scheduling:{jobId:'Jnative-fixture',priority:2}}]:[]})),gpuq:{connected:true,jobs:[{id:'Jnative-fixture',name:'legacy-wrapper',owner,state:'RUNNING',priority:2,gpu_count:1,assigned_gpu_indices:[0],display_metadata:{name,description,submitter:{name:'不能认作管理员',username:'portal-admin-fixture'}}}]}};}
function project(raw,role='admin',jobs=[]){return visibleGPUQStatus({checkedAt:new Date().toISOString(),stale:false,hosts:[raw]},{role,userId:'viewer'},{[machine.id]:1},{jobs,users:[{id:'account',username:'portal-admin-fixture',name:'不能认作管理员'}]});}
function render(snapshot,admin=true){return resourceCards({machines:[machine],limits:{[machine.id]:1},snapshot,production:true,admin,management:false,userId:'viewer',jobs:[]});}

test('canonical native metadata stays readonly and labels the OS owner in compute and console renderers',()=>{
  const raw=host(),snapshot=project(raw),task=snapshot.hosts[0].tasks[0];
  assert.equal(task.name,name);assert.equal(task.description,description);assert.deepEqual(task.submitter,{name:owner,username:owner});
  const html=render(snapshot),identity=taskIdentityHTML(task);
  for(const text of ['原生用户 '+owner,'原生训练 &lt;img','&lt;script&gt;仅作文字&lt;/script&gt;'])assert.ok(html.includes(text),text);
  assert.ok(html.includes('原生训练 &lt;img src=x onerror=alert(1)&gt; · 原生用户 '+owner),'the actual GPU hover title includes name and native owner');
  assert.match(identity,/原生用户 native-fixture-owner/);
  assert.doesNotMatch(html,/<img|<script>|portal-admin-fixture|不能认作管理员|data-job-cancel|data-job-logs|data-job-priority/);
  const attempted={...task,canSetPriority:true,state:'QUEUED',priority:'normal',userId:'viewer',project:'forged-project'};
  assert.equal(canEditPriority(attempted,true),false);
  const table=taskTable([attempted],{admin:true,userId:'viewer'});
  assert.match(table,/只读/);assert.doesNotMatch(table,/<button|data-job-cancel|data-job-logs|data-job-output|data-job-priority|data-job-watch/);
  const portal={...attempted,source:'portal'};
  assert.equal(canEditPriority(portal,true),true);assert.match(taskTable([portal],{admin:true,userId:'viewer'}),/data-job-cancel|data-job-logs|data-job-priority/);
  assert.equal(raw.gpuq.jobs[0].owner,owner);assert.equal(raw.gpuq.jobs[0].display_metadata.submitter.username,'portal-admin-fixture');
});

test('members stay masked; disconnected, duplicate and ambiguous native IDs never adopt display labels',()=>{
  const member=render(project(host(),'member'),false);
  assert.match(member,/GPUQ 任务（未关联平台）/);
  for(const hidden of [name,'原生训练',description,owner,'portal-admin-fixture','原生用户'])assert.ok(!member.includes(hidden),hidden);
  for(const mutate of [h=>h.reachable=false,h=>h.gpuq.connected=false,h=>h.gpuq.jobs.push(structuredClone(h.gpuq.jobs[0])),h=>h.gpuq.jobs[0].display_metadata.name='\u009b2J']){
    const raw=host();mutate(raw);const snapshot=project(raw),html=render(snapshot);
    assert.ok(!html.includes('原生训练'));assert.ok(!html.includes('第一阶段'));assert.doesNotMatch(html,/data-job-cancel|data-job-logs/);
  }
  const ambiguous=[{id:'portal-a',nodeJobId:'Jnative-fixture',machine:machine.id,state:'RUNNING',name:'平台A'},{id:'portal-b',nodeJobId:'Jnative-fixture',machine:machine.id,state:'RUNNING',name:'平台B'}];
  const html=render(project(host(),'admin',ambiguous));assert.ok(!html.includes('原生训练'));assert.ok(!html.includes('第一阶段'));
});

test('the real status reader removes stale native metadata before rendering',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-owner-ui-'));
  try{
    const now=Date.now(),path=join(dir,'status');
    await writeFile(path,JSON.stringify({version:1,checkedAt:new Date(now-240000).toISOString(),hosts:[host()]}));
    const status=await readGPUQStatus(path,now);assert.equal(status.stale,true);
    const snapshot=visibleGPUQStatus(status,{role:'admin'},{},{jobs:[],users:[]});
    assert.deepEqual(snapshot.hosts[0].tasks,[]);
    const html=render(snapshot);assert.doesNotMatch(html,/原生训练|原生用户|第一阶段|native-fixture-owner/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
