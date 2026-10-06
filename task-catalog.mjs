import {taskIdentity,nativeTaskDisplay} from './dist/task-metadata.js';

const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);
const string=(value,max=120)=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,'').slice(0,max):null;
const indices=value=>Array.isArray(value)?value.filter(i=>Number.isSafeInteger(i)&&i>=0).slice(0,64):[];
const priority=value=>Number.isInteger(value)&&value>=0&&value<=4?value:null;
function nativeTask(job,admin){return {id:string(job.id),nodeJobId:string(job.id),source:'native',
  name:admin?string(job.name)||'GPUQ 任务':'GPUQ 任务（未关联平台）',description:'',submitter:admin?{name:string(job.owner)||'未知用户',username:string(job.owner)}:null,
  state:string(job.state,32)||'UNKNOWN',priority:priority(job.priority),yieldPolicy:string(job.yield_policy,16),
  assignedGpuIndices:indices(job.assigned_gpu_indices),gpuCount:Number.isInteger(job.gpu_count)?job.gpu_count:null,updatedAt:job.updated_at??null};}
function portalTask(job,users,native=null){const identity=taskIdentity(job,users),display=native&&native.id===job.nodeJobId?nativeTaskDisplay(native.display_metadata,identity.submitter.username):null;return {id:job.id,nodeJobId:job.nodeJobId||null,source:'portal',...(display||identity),
  state:string(job.state,32)||'UNKNOWN',schedulerState:string(native?.state,32),priority:priority(native?.priority??job.schedulerPriority),
  yieldPolicy:string(native?.yield_policy??job.yieldPolicy??job.schedulerPolicy?.yield_policy,16),
  assignedGpuIndices:indices(native?.assigned_gpu_indices??job.assignedIndices),gpuCount:job.cards,updatedAt:native?.updated_at??job.schedulerCheckedAt??job.checkedAt??job.createdAt??null};}

// Join on (machine, exact native job ID), never GPU index, OS username, PID
// ancestry guesses or portal- prefixes. The output is an explicit read-only
// allowlist, not publicJob(): no argv, spec, paths, errors, logs or user grants.
export function taskCatalog(host,{jobs=[],users=[]}={},admin=false){
  const platform=jobs.filter(j=>j.machine===host.id),byNative=new Map();
  for(const job of platform){if(!job.nodeJobId)continue;const previous=byNative.get(job.nodeJobId);byNative.set(job.nodeJobId,previous===undefined?job:null);}
  const tasks=[],seen=new Set(),byNode=new Map();
  for(const native of host.gpuq?.jobs||[]){
    if(!native||typeof native.id!=='string'||byNode.has(native.id))continue;
    const job=byNative.get(native.id),task=job?portalTask(job,users,native):nativeTask(native,admin);
    tasks.push(task);byNode.set(native.id,task);if(job)seen.add(job.id);
  }
  // Include not-yet-dispatched and active jobs missing from the bounded node
  // sample. They are queue records, not proof that their GPUs are occupied.
  for(const job of platform.filter(j=>!seen.has(j.id)&&!TERMINAL.has(j.state)).slice(-100))tasks.push(portalTask(job,users));
  return {tasks,byNode};
}
