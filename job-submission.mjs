import {createHash,randomUUID} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {projectReference} from './projects.mjs';
import {schedulingPolicy} from './dist/scheduling-policy.js';
import {elasticAllocation,gpuPlacement} from './dist/gpu-allocation.js';
import {taskDescription,displayName} from './dist/task-metadata.js';

const FIELDS=new Set([
  'machine','cards','minVramGiB','argv','name','description','key',
  'datasets','project','release','priority','scheduling','elastic','placement',
  'prepareData',
]);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};

export function datasetReferences(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>8)fail('每个任务最多关联 8 个数据集版本。');
  const names=new Set();
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='dataset,version'||
       typeof item.dataset!=='string'||typeof item.version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.dataset)||!/^[a-f0-9]{64}$/.test(item.version)||names.has(item.dataset))fail('数据集需指定唯一名称和完整版本哈希。');
    names.add(item.dataset);
  }
  return value.map(({dataset,version})=>({dataset,version}));
}

export function normalizeJobSubmission(args,principal){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!FIELDS.has(k)))fail('提交参数无效。');
  if(args.prepareData!==undefined&&typeof args.prepareData!=='boolean')fail('数据准备选项无效。');
  if(args.scheduling!==undefined&&args.priority!==undefined)fail('自定义调度不能与旧优先级预设混用。');
  let explicit=null;
  if(args.scheduling!==undefined){
    try{explicit=schedulingPolicy(args.scheduling,principal.role==='admin');}
    catch(error){fail(error.message,error.status||400);}
  }
  const priority=args.priority===undefined?'normal':args.priority;
  if(!['idle','normal','high'].includes(priority))fail('优先级必须为 idle、normal 或 high。');
  if(priority==='high'&&principal.role!=='admin')fail('高优先级仅管理员可用。',403);
  if(!Object.hasOwn(args,'machine')||typeof args.machine!=='string'||!MACHINES.some(m=>m.id===args.machine))fail('请明确选择有效的服务器；不支持自动选机。');
  const datasets=datasetReferences(args.datasets),project=projectReference(args,{release:true});
  if(typeof args.key!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.key))fail('需提供 UUID 提交键，重试必须复用。');
  if(!Array.isArray(args.argv)||!args.argv.length||args.argv.length>128||args.argv.some(a=>typeof a!=='string'||a.includes('\0'))||JSON.stringify(args.argv).length>12000)fail('训练命令无效或过长。');
  if(!Number.isInteger(args.cards)||args.cards<1||args.cards>Math.max(...MACHINES.map(m=>m.cards)))fail('申请卡数超出单机容量。');
  let allocation=null;
  if(args.elastic!==undefined){try{allocation=elasticAllocation(args.elastic,args.cards,explicit);}catch(error){fail(error.message);}}
  let placement=null;
  if(args.placement!==undefined){try{placement=gpuPlacement(args.placement,args.cards,allocation,explicit,priority);}catch(error){fail(error.message);}}
  const minVramGiB=args.minVramGiB??0;
  if(typeof minVramGiB!=='number'||!Number.isFinite(minVramGiB)||minVramGiB<0||minVramGiB>128)fail('最低显存参数无效。');
  const name=args.name||'train';
  if(typeof name!=='string'||name.length>64||/[\x00-\x1f]/.test(name))fail('任务名称无效。');
  const description=taskDescription(args.description);
  const request={machine:args.machine,cards:args.cards,minVramGiB,argv:[...args.argv],name,description,key:args.key,
    datasets,project,priority,priorityProvided:args.priority!==undefined,explicit,prepareData:args.prepareData===true,
    ...(placement?{placement}:{}),
    ...(allocation?{elastic:allocation.elastic,allowedGpuCounts:allocation.allowed}:{})};
  // This positional representation is a persisted compatibility contract, not
  // a second parser. Preserve old retry identities without rewriting records.
  const identity=[request.machine,request.cards,minVramGiB,request.argv,name];
  if(datasets.length)identity.push(datasets);
  if(project.project)identity.push(project);
  if(request.priorityProvided)identity.push({priority});
  if(explicit)identity.push({scheduling:explicit});
  if(allocation)identity.push({elastic:allocation.elastic});
  if(placement)identity.push({placement});
  if(description)identity.push({description});
  request.digest=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return request;
}

export function createSubmittedJob(request,user,prioritySupported,{id=randomUUID(),now=new Date().toISOString()}={}){
  const {machine,cards,minVramGiB,name,key,digest,project,datasets,priority,explicit}=request;
  const context={...project,...(datasets.length?{datasets:structuredClone(datasets)}:{}),...(request.elastic?{elastic:structuredClone(request.elastic)}:{}),...(request.placement?{placement:structuredClone(request.placement)}:{})};
  const policy=explicit?{scheduling:structuredClone(explicit)}:prioritySupported?{priority,preemptIdleOnly:true}:{};
  const spec={id,userId:user.id,username:user.username,cards,argv:[...request.argv],name,minVramGiB,...context,...policy};
  // Human-facing metadata belongs to the portal record, not the immutable
  // node execution spec: old nodes/receipts continue accepting the same spec.
  return {id,key,digest,spec,userId:user.id,username:user.username,submitterName:displayName(user.name??user.username),machine,cards,name,description:request.description,...context,
    ...(request.elastic?{allowedGpuCounts:[...request.allowedGpuCounts]}:{}),
    ...(explicit?{scheduling:structuredClone(explicit)}:{}),priority:explicit?null:prioritySupported?priority:null,
    state:'SUBMITTING',createdAt:now,cancelRequested:false};
}
