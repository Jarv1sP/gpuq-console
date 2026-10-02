// Durable data staging precedes scheduler submission. No GPU lease is held
// during this phase, and a portal restart resumes observation, not a new job.
export const DATA_PREPARING='PREPARING_DATA';
const inFlight=new WeakMap();
const fingerprint=job=>JSON.stringify([job.userId,job.machine,job.cards,job.digest,job.spec,job.datasets,job.project,job.release]);

function persist(service,job,change){
  const before=structuredClone(job);
  try{change();service.save();}
  catch(error){for(const key of Object.keys(job))delete job[key];Object.assign(job,before);throw error;}
}
function finish(service,job,state,error){
  persist(service,job,()=>{job.state=state;job.error=error;job.finishedAt=new Date().toISOString();});
}
function current(service,id,snapshot){
  const job=service.store.jobs.find(value=>value.id===id);
  if(service.closing||!job||job.state!==DATA_PREPARING)return null;
  if(job.cancelRequested){finish(service,job,'CANCELED',null);return null;}
  let user;
  try{user=service.store.get(job.userId);}catch{finish(service,job,'FAILED','账号已移除；数据准备未转入训练。');return null;}
  if(!user.enabled||!user.limits[job.machine]||user.limits[job.machine]<job.cards||user.total<job.cards){finish(service,job,'FAILED','账号或机器授权已改变；未启动训练。');return null;}
  // Any role/grant/profile revision or job-spec change invalidates the result
  // obtained under the earlier authority. Never promote such a stale result.
  if(snapshot&&(JSON.stringify(user)!==snapshot.policy||fingerprint(job)!==snapshot.jobFingerprint)){
    finish(service,job,'FAILED','账号授权或任务配置已改变；请重新提交，未启动训练。');return null;
  }
  return {job,user};
}

async function observe(service,id,usage){
  const snapshot=await service.enqueue(()=>{
    const live=current(service,id);if(!live)return null;
    return {job:structuredClone(live.job),policy:JSON.stringify(live.user),jobFingerprint:fingerprint(live.job)};
  });
  if(!snapshot)return;
  const {job}=snapshot,identity={userId:job.userId,hostAdmin:false},states=[],references=[];
  let failure=null;
  // Remote operations intentionally stay OUTSIDE the global mutation queue.
  // A slow manifest/SSH response cannot block cancellation or terminal opens.
  for(const ref of job.datasets){
    if(!await service.enqueue(()=>!!current(service,id,snapshot)))return;
    let status,reference;
    const transfer=service.datasetReplicaState?.(job.userId,job.machine,ref);
    try{
      if(service.resolveDataset){const resolved=await service.resolveDataset(job.userId,job.machine,ref);status=resolved.status;reference=resolved.reference;}
      else{status=await service.bridge(job.machine,'datasets.status',{...identity,...ref});reference=ref;}
    }
    catch(error){if(!service.prepareDataset)throw error;status=transfer||await service.prepareDataset(job.userId,job.machine,ref,{retry:false});}
    if(status.state!=='READY'&&transfer)status=transfer.state==='FAILED'?transfer:await service.prepareDataset(job.userId,job.machine,ref,{retry:false});
    if(status?.dataset!==ref.dataset||status?.version!==ref.version)throw Error('数据准备状态与请求版本不符，未启动训练。');
    if(!['READY','PREPARING','FAILED'].includes(status.state)){
      if(!await service.enqueue(()=>!!current(service,id,snapshot)))return;
      status=service.prepareDataset?await service.prepareDataset(job.userId,job.machine,ref,{retry:false}):await service.bridge(job.machine,'datasets.prepare',{...identity,...ref});
      if(status?.dataset!==ref.dataset||status?.version!==ref.version)throw Error('数据准备结果与请求版本不符，未启动训练。');
    }
    states.push({dataset:ref.dataset,version:ref.version,state:status.state,
      ...(Number.isSafeInteger(status.remainingBytes)&&status.remainingBytes>=0?{remainingBytes:status.remainingBytes}:{})});
    if(status.state==='FAILED'){failure='数据准备失败：'+ref.dataset+'。请在数据集页面检查并重试。';break;}
    if(status.state==='READY'){
      const resolved=reference?{status,reference}:service.resolveDataset?await service.resolveDataset(job.userId,job.machine,ref):{status,reference:ref};
      if(resolved.status.state!=='READY'||!resolved.reference)throw Error('本机副本已改变；未申请 GPU。');
      references.push(resolved.reference);
    }
  }
  const ready=!failure&&states.length===job.datasets.length&&states.every(state=>state.state==='READY');
  if(ready){
    if(!await service.enqueue(()=>!!current(service,id,snapshot)))return;
    if(job.project){
      const project=await service.bridge(job.machine,'projects.verify',{userId:job.userId,project:job.project,release:job.release});
      if(project?.state!=='READY'||project.project!==job.project||project.release!==job.release)failure='项目版本不可用；未启动训练。';
    }
    if(!failure)await service.refreshGPUQ();
  }
  return service.enqueue(()=>{
    const live=current(service,id,snapshot);if(!live)return;
    const {job:currentJob,user}=live;
    // The fresh quota check and SUBMITTING reservation share this short queue
    // turn, so concurrent preparations cannot both spend the same free quota.
    persist(service,currentJob,()=>{
      currentJob.dataPreparation={datasets:states,checkedAt:new Date().toISOString()};currentJob.error=null;
      if(failure){currentJob.state='FAILED';currentJob.error=failure;currentJob.finishedAt=new Date().toISOString();return;}
      if(!ready){currentJob.queueReason='正在准备本机数据；尚未申请 GPU。';return;}
      if(usage(service.store.jobs,user.id)+currentJob.cards>user.total||usage(service.store.jobs,user.id,currentJob.machine)+currentJob.cards>user.limits[currentJob.machine]){
        currentJob.queueReason='数据已就绪，等待个人可用卡数额度；尚未申请 GPU。';return;
      }
      const host=service.gpuq?.hosts.find(h=>h.id===currentJob.machine);
      if(service.gpuq?.stale||!host?.reachable||!host.gpuq?.connected||host.gpuq.observeOnly){currentJob.queueReason='数据已就绪，等待服务器恢复；尚未申请 GPU。';return;}
      currentJob.spec.datasets=references;
      currentJob.state='SUBMITTING';currentJob.queueReason='数据准备完成，等待节点调度。';currentJob.dataPreparation.finishedAt=new Date().toISOString();
    });
  });
}

export function advanceDataPreparation(service,job,usage){
  let pending=inFlight.get(service);if(!pending){pending=new Map();inFlight.set(service,pending);}
  if(pending.has(job.id))return pending.get(job.id);
  const operation=observe(service,job.id,usage).finally(()=>{if(pending.get(job.id)===operation)pending.delete(job.id);});
  pending.set(job.id,operation);return operation;
}
