import {MACHINES} from './dist/model.js';
import {elasticCapable,placementCapable} from './dist/gpu-allocation.js';
import {yieldCapable} from './dist/scheduling-policy.js';
import {datasetCatalogCall} from './dataset-catalog.mjs';

const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const readyProbe=(value,project)=>value?.protocol==='portable-project-v1'&&value.enabled===true&&value.environmentMode==='oci'&&
  ['amd64','arm64'].includes(value.architecture)&&value.project===project.project&&value.release===project.release&&value.releaseReady===true&&/^sha256:[a-f0-9]{64}$/.test(value.image);

// Admission only: every operation here is read-only. A chosen target is stored
// with the job before project/data workers may start. Queuing never reselects it.
export async function selectMachine(service,user,request,priorityCapable){
  if(!service.projectCopyProbe||!service.prepareProject)fail('跨机个人容器尚未启用；请先手选服务器。',503);
  const policy=JSON.stringify(user),check=()=>{
    if(service.closing||JSON.stringify(service.store.get(user.id))!==policy)fail('账号授权已改变，请重试；未提交训练。',403);
  };
  await service.refreshGPUQ();check();
  if(service.gpuq?.stale!==false)fail('机器状态已过期，暂不接受自动选机。',503);
  const hosts=service.gpuq.hosts;
  const authorized=MACHINES.filter(m=>user.limits[m.id]>0&&hosts.find(h=>h.id===m.id)?.reachable===true&&!service.maintenanceFor?.(m.id));
  const allowed=request.machineSelection.candidates;
  const eligible=authorized.filter(m=>{
    const h=hosts.find(h=>h.id===m.id),gpus=h.gpus||[],q=h.gpuq;
    // schedulableIndices is the currently free pool, not healthy total
    // capacity: an empty pool can still accept queued/shared work. Health is
    // the authoritative node fence (including GPU/Xid recovery failures).
    if(allowed&&!allowed.includes(m.id)||user.limits[m.id]<request.cards||q?.connected!==true||q.health!=='ok'||q.observeOnly!==false||gpus.filter(g=>g.memoryTotalMiB>=request.minVramGiB*1024-512).length<request.cards)return false;
    if(request.elastic&&!elasticCapable(h)||request.placement&&!placementCapable(h,request.placement))return false;
    if(request.placement){const selected=request.placement.gpuIndices.map(index=>gpus.find(g=>g.index===index));
      if(selected.some(g=>!g||g.memoryTotalMiB<request.minVramGiB*1024-512)||request.placement.shared&&selected[0].memoryTotalMiB<request.placement.vramMiB)return false;}
    if(request.priorityProvided&&!priorityCapable(h)||request.explicit&&(!priorityCapable(h)||!yieldCapable(h)))return false;
    return !(request.explicit?.mode&&request.explicit.mode!=='queue'&&!q.capabilities?.includes('preempt-opt-in-only-v1'));
  });
  if(!eligible.length)fail('没有已授权、健康且满足卡数、显存和调度能力的候选服务器。');
  const sources=(await Promise.all(authorized.map(async m=>{
    try{const probe=await service.projectCopyProbe(user.id,m.id,request.project);return readyProbe(probe,request.project)?{machine:m.id,probe}:null;}catch{return null;}
  }))).filter(Boolean);check();
  if(!sources.length)fail('未找到可迁移的 READY 个人容器项目版本；请先发布项目。');
  const source=sources[0];
  if(sources.some(s=>s.probe.architecture!==source.probe.architecture||s.probe.image!==source.probe.image))fail('同一项目版本的镜像或架构信息不一致；请管理员核对，未提交训练。');
  const choices=(await Promise.all(eligible.map(async m=>{
    check();
    let local=sources.find(s=>s.machine===m.id),from=local?.machine;
    if(!local){
      for(const candidate of sources){
        try{const target=await service.projectCopyProbe(user.id,m.id,{project:request.project.project,from:candidate.machine});
          if(target?.protocol==='portable-project-v1'&&target.enabled===true&&target.environmentMode==='oci'&&target.project===request.project.project&&target.architecture===candidate.probe.architecture&&target.sources?.includes(candidate.machine)){from=candidate.machine;break;}
        }catch{}
      }
      if(!from)return null;
    }
    let localData=0;
    if(request.datasets.length){
      let catalog;
      try{catalog=await datasetCatalogCall(service,{userId:user.id,role:user.role},'datasets.catalog',{machine:m.id});}catch{return null;}
      for(const ref of request.datasets){
        const value=catalog.datasets?.find(d=>d.dataset===ref.dataset)?.versions?.find(v=>v.version===ref.version);
        if(value?.state==='READY')localData++;
        else if(!value||!(value.canPrepare===true||value.state==='PREPARING'))return null;
      }
    }
    const host=hosts.find(h=>h.id===m.id),queue=host.gpuq.jobs||[];
    const waiting=queue.filter(j=>['PENDING','STARTING'].includes(j.state)).length;
    // Locality dominates this advisory queue tiebreaker; scheduling still owns
    // actual GPU allocation and can wait rather than promise a free card.
    return {machine:m.id,from,localProject:!!local,localData,waiting};
  }))).filter(Boolean);check();
  if(!choices.length)fail('候选机器缺少兼容的项目复制通道或可读取的数据来源；未提交训练。');
  choices.sort((a,b)=>Number(b.localProject&&b.localData===request.datasets.length)-Number(a.localProject&&a.localData===request.datasets.length)||
    b.localData-a.localData||Number(b.localProject)-Number(a.localProject)||a.waiting-b.waiting||a.machine.localeCompare(b.machine));
  const chosen=choices[0];
  if(service.maintenanceFor?.(chosen.machine))fail('选中的服务器刚进入维护，请重新提交；未启动准备。');
  return {machine:chosen.machine,projectPreparation:{from:chosen.from,...request.project,state:chosen.localProject?'READY':'WAITING'}};
}
