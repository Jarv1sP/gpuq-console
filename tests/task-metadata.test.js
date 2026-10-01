import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {displayName,taskDescription,taskIdentity} from '../dist/task-metadata.js';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';
import {visibleGPUQStatus} from '../gpuq-status.mjs';
import {resourceCards} from '../dist/resources-ui.js';
import {taskCatalog} from '../task-catalog.mjs';

const args={key:randomUUID(),machine:'gpu-1',cards:2,name:'多卡 baseline',argv:['python','train.py','--secret','DO-NOT-SHARE']};
const owner={id:'owner-a',username:'alice',name:'张三'},other={id:'owner-b',username:'bob',name:'李四'};
function job(extra={}){return {...createSubmittedJob(normalizeJobSubmission({...args,description:'验证新数据集\n预计两小时'},{role:'member'}),owner,false),nodeJobId:'Jsame',state:'RUNNING',...extra};}
const native=(id='Jsame')=>({id,name:'portal-wrapper',owner:'internal-user',state:'RUNNING',priority:2,gpu_count:2,assigned_gpu_indices:[0,1]});
function host(id='gpu-1'){return {id,reachable:true,gpus:[0,1].map(index=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[{pid:index+42,name:'python',owner:'private-os-user',memoryUsedMiB:20,scheduling:{jobId:'Jsame',priority:2}}]})),gpuq:{connected:true,jobs:[native()]}};}
test('shared validators keep unicode/plain-text metadata bounded and distinct from executable argv',()=>{
  assert.equal(displayName(' 张三 '),'张三');assert.equal(displayName('😀'.repeat(32)).length,64);
  assert.equal(taskDescription(' a\r\nb '),'a\nb');assert.equal(taskDescription(undefined),'');
  for(const n of ['',null,{},'a'.repeat(33),'\x1b[2J','名字\u202e'])assert.throws(()=>displayName(n));
  for(const d of [null,{},'a'.repeat(2001),'😀'.repeat(2000),'\0','x\u202e'])assert.throws(()=>taskDescription(d));
  const request=normalizeJobSubmission({...args,description:'实验说明'},{role:'member'}),created=createSubmittedJob(request,owner,false);
  assert.equal(created.submitterName,'张三');assert.equal(created.description,'实验说明');assert.equal(created.spec.description,undefined);assert.equal(created.spec.submitterName,undefined);assert.deepEqual(created.spec.argv,args.argv);
  for(const forged of [{submitterName:'fake'},{username:'fake'},{userId:'someone'},{submitter:{name:'fake'}}])assert.throws(()=>normalizeJobSubmission({...args,...forged},{role:'member'}));
  const legacy=normalizeJobSubmission(args,{role:'member'});
  assert.equal(normalizeJobSubmission({...args,description:''},{role:'member'}).digest,legacy.digest);
  assert.notEqual(request.digest,legacy.digest);assert.notEqual(normalizeJobSubmission({...args,description:'changed'},{role:'member'}).digest,request.digest);
});
test('submitter names are snapshots; legacy fallback uses exact immutable user ID, not recycled username',()=>{
  const created=job();assert.equal(taskIdentity(created,[{...owner,name:'改名'}]).submitter.name,'张三');
  const legacy={name:'old',userId:owner.id,username:owner.username};assert.equal(taskIdentity(legacy,[owner]).submitter.name,'张三');
  assert.equal(taskIdentity(legacy,[{...owner,id:'new-owner',name:'同名新账号'}]).submitter.name,'alice');assert.equal(taskIdentity(legacy,[]).description,'');
});
test('resource projection joins exact machine/native ID for shared and multi-GPU tasks without leaking execution data',()=>{
  const a=job(),b=job({id:'different-host-job',machine:'gpu-2',submitterName:'李四'}),h=host(),context={jobs:[a,b],users:[owner,other]};
  const visible=visibleGPUQStatus({checkedAt:new Date().toISOString(),stale:false,hosts:[h,host('gpu-2')]},{role:'member',userId:other.id},{'gpu-1':1},context);
  assert.equal(visible.hosts.length,1);assert.equal(visible.hosts[0].tasks.length,1);assert.equal(visible.hosts[0].tasks[0].submitter.name,'张三');
  for(const g of visible.hosts[0].gpus)assert.equal(g.processes[0].task.id,a.id);
  const json=JSON.stringify(visible);for(const hidden of ['DO-NOT-SHARE','argv','spec','private-os-user','different-host-job'])assert.ok(!json.includes(hidden),hidden);
  const shared=job({id:'shared-job',nodeJobId:'Jshared',userId:other.id,username:other.username,submitterName:other.name});
  const both=host();both.gpuq.jobs.push(native('Jshared'));both.gpus[0].processes.push({pid:123,memoryUsedMiB:2,scheduling:{jobId:'Jshared',priority:0}});
  const result=visibleGPUQStatus({hosts:[both]},{role:'member'},{'gpu-1':1},{jobs:[a,shared],users:[owner,other]});
  assert.deepEqual(result.hosts[0].gpus[0].processes.map(p=>p.task.submitter.name),['张三','李四']);
});
test('unknown process ownership, ambiguous IDs, native records and missing samples never guess metadata',()=>{
  const a=job(),h=host();h.gpus[0].processes[0].scheduling=undefined;
  const result=visibleGPUQStatus({hosts:[h]},{role:'member'},{'gpu-1':1},{jobs:[a],users:[owner]});assert.equal(result.hosts[0].gpus[0].processes[0].task,undefined);
  const ambiguous=taskCatalog(h,{jobs:[a,{...a,id:'duplicate'}],users:[owner]},false);assert.equal(ambiguous.byNode.get('Jsame').source,'native');assert.equal(ambiguous.byNode.get('Jsame').submitter,null);
  const waiting=job({id:'not-dispatched',nodeJobId:undefined,state:'PENDING'});h.gpuq.jobs=[];
  const catalog=taskCatalog(h,{jobs:[waiting],users:[owner]},false);assert.equal(catalog.tasks[0].name,args.name);assert.equal(catalog.tasks[0].state,'PENDING');assert.equal(catalog.byNode.size,0);
});
test('overview renders human metadata as escaped text and never grants task-control buttons',()=>{
  const submitted=job({name:'<img src=x onerror=alert(1)>',description:'第一行\n<script>private description</script>'});
  const snapshot=visibleGPUQStatus({checkedAt:new Date().toISOString(),stale:false,hosts:[host()]},{role:'member'},{'gpu-1':1},{jobs:[submitted],users:[owner]});
  const html=resourceCards({machines:[{id:'gpu-1',cards:2,model:'Test',memory:'24 GiB'}],limits:{'gpu-1':1},snapshot,production:true});
  assert.match(html,/张三/);assert.match(html,/第一行/);assert.match(html,/&lt;script&gt;/);assert.match(html,/任务队列与近期记录/);assert.doesNotMatch(html,/<script>|<img|data-job-cancel|data-job-logs|DO-NOT-SHARE|internal-user/);
  const drained=job({state:'UNKNOWN'}),raw=host();raw.gpuq.jobs[0].state='CANCELED';assert.equal(taskCatalog(raw,{jobs:[drained],users:[owner]},false).tasks[0].state,'UNKNOWN');
});
