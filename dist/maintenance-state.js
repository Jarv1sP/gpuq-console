// Presentation and explicit recovery orchestration only. The Portal remains
// authoritative for admission, actor permissions and revision CAS.
export const recoveryConfirmation='确认此范围的诊断维修已完成并恢复新操作？未取消的等待任务会继续；已取消或终态任务不会自动重跑。其他范围的维护状态不会改变。';
export const maintenanceConsequence='仅控制平台准入，不会自动停止任务、终端、节点服务或 SSH。确认诊断维修全部完成后，再明确恢复。';
export function maintenanceInfoHTML(text,label='说明'){
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<span class="maintenance-info"><button type="button" data-maintenance-info aria-expanded="false" aria-label="${escape(label)}">ⓘ</button><span class="maintenance-info-body" role="note">${escape(text)}</span></span>`;
}
export function maintenanceClock(value){const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'未更新';}
export function maintenanceFor(value,machine){return value?.version===1?(value.global||value.machines?.[machine]||null):null;}
export const maintenanceActive=value=>value?.version===1&&!!(value.global||Object.keys(value.machines||{}).length);
export const heldDuringMaintenance=(job,value)=>!!maintenanceFor(value,job.machine)&&['PENDING','QUEUED'].includes(job.state)&&!job.cancelRequested;
export function maintenanceTime(since){const date=new Date(since);return since&&Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'开始时间未提供';}
export function maintenanceElapsed(since,now=Date.now()){
  const start=Date.parse(since);if(!Number.isFinite(start)||start>now)return '持续时间未确认';
  const minutes=Math.floor((now-start)/60000);return minutes<60?`已持续 ${minutes} 分钟`:`已持续 ${Math.floor(minutes/60)} 小时 ${minutes%60} 分钟`;
}
const readOrStop=new Set(['jobs.logs','jobs.watch','jobs.diagnostics','jobs.cancel','projects.list','projects.quota','projects.status','projects.verify','files.list','files.get','datasets.list','datasets.catalog','datasets.capacity','datasets.status','datasets.workspace.list','datasets.workspace.get','datasets.workspace.status','datasets.upload.status','datasets.upload.list','datasets.upload.pause','datasets.upload.direct-revoke','datasets.import.list','datasets.import.status','datasets.import.cancel','datasets.storage.status','datasets.storage.plan','transfers.list','transfers.status','transfers.capabilities','transfers.cancel','transfers.progress','transfers.confirm-source-release','transfers.release-source','terminal.close','terminal.detach','cloud.info','cloud.import.list','cloud.import.status','cloud.import.cancel','cloud.files.info','cloud.files.list','cloud.files.status','cloud.files.cancel']);
export function maintenanceBlocks(operation,args={},data,principal){
  // Limit the UI guard to execution operations. Account, guide, community,
  // state and maintenance controls never go through a maintenance page gate.
  if(!/^(jobs\.(submit|priority)|projects\.|files\.|datasets\.|transfers\.|terminal\.|cloud\.)/.test(operation)||readOrStop.has(operation))return null;
  if(principal?.role==='admin'&&operation.startsWith('terminal.')&&args.hostAdmin===true)return null;
  if(operation==='terminal.exchange'&&!args.input||operation==='transfers.io'&&['status','direct-revoke'].includes(args.action))return null;
  const job=args.jobId?data?.jobs?.find(job=>job.id===args.jobId):null;
  const machines=[args.machine,args.from,args.sourceMachine,args.targetMachine,args.source?.machine,job?.machine];
  return maintenanceFor(data?.operationalMaintenance)||machines.map(machine=>maintenanceFor(data?.operationalMaintenance,machine)).find(Boolean)||null;
}
export function assertMaintenanceOperation(operation,args,data,principal){
  const entry=maintenanceBlocks(operation,args,data,principal);if(entry)throw Object.assign(Error(`维护中：${entry.reason}。新任务、终端输入和数据写入已暂停；仍可查看日志、下载或取消任务。`),{code:'MAINTENANCE_ACTIVE',status:503});
}
const disabledBeforeMaintenance=new WeakMap();
export function restoreMaintenanceControls(root){
  for(const node of root.querySelectorAll('[data-maintenance-blocked]')){const previous=disabledBeforeMaintenance.get(node);if(previous){node.disabled=previous.disabled;node.title=previous.title;disabledBeforeMaintenance.delete(node);}node.removeAttribute('data-maintenance-blocked');}
}
export function disableMaintenanceControls(root,selectors,entry){
  if(!entry)return;
  for(const node of root.querySelectorAll(selectors)){if(!disabledBeforeMaintenance.has(node))disabledBeforeMaintenance.set(node,{disabled:node.disabled,title:node.title});node.disabled=true;node.title='维护中：平台写入暂停；仍可查看状态、下载或取消。';node.setAttribute('data-maintenance-blocked','');}
}
export function recoveryPlan(value,machines,selected){
  if(value?.version!==1||!Number.isSafeInteger(value.revision))throw Error('维护状态尚未确认，请刷新。');
  const ids=machines.map(machine=>typeof machine==='string'?machine:machine.id),chosen=new Set(selected);
  if(!chosen.size||[...chosen].some(id=>!ids.includes(id)||!maintenanceFor(value,id)))throw Error('请选择仍在维护的服务器。');
  const steps=[];
  if(value.global){
    // Protect every remaining server before removing the global admission
    // lock. Preserve pre-existing independent reasons and timestamps.
    for(const id of ids)if(!chosen.has(id)&&!value.machines[id])steps.push({scope:id,enabled:true,reason:value.global.reason});
    for(const id of ids)if(chosen.has(id)&&value.machines[id])steps.push({scope:id,enabled:false});
    steps.push({scope:'all',enabled:false});
  }else for(const id of ids)if(chosen.has(id))steps.push({scope:id,enabled:false});
  return {revision:value.revision,selected:ids.filter(id=>chosen.has(id)),remaining:ids.filter(id=>!chosen.has(id)&&maintenanceFor(value,id)),steps};
}
export async function executeRecovery(plan,call,isCurrent=()=>true){
  let revision=plan.revision;const applied=[];
  for(const step of plan.steps){
    try{
      if(!isCurrent())throw Error('登录状态已改变；恢复已停止，请原账号刷新核对。');
      const result=await call('maintenance.set',{...step,revision});
      if(result?.version!==1||result.revision!==revision+1)throw Error('恢复回执版本未确认；已停止，请刷新核对。');
      revision=result.revision;applied.push({...step,revision});
    }catch(error){error.applied=applied;error.unconfirmed=step;throw error;}
  }
  return {revision,applied};
}
export function recoveryChecks(data,machine,sessions=[]){
  const snapshot=data?.gpuq,host=snapshot?.hosts?.find(host=>host.id===machine),checkedAt=host?.checkedAt||snapshot?.checkedAt;
  const tasks=[...new Map([...(data?.jobs||[]).filter(job=>job.machine===machine),...(host?.tasks||[])].map(job=>[job.id,job])).values()];
  const unknown=tasks.filter(job=>!['PREPARING_DATA','SUBMITTING','PENDING','QUEUED','STARTING','RUNNING','SUCCEEDED','FAILED','CANCELED','PREEMPTING','PREEMPTED'].includes(job.state));
  const running=tasks.filter(job=>job.state==='RUNNING'),queued=tasks.filter(job=>['PENDING','QUEUED'].includes(job.state)&&!job.cancelRequested);
  const roots=sessions.filter(session=>session.machine===machine&&session.hostAdmin);
  const checks=[
    {label:'监控快照',status:snapshot?.stale===false&&Number.isFinite(Date.parse(checkedAt))?'通过':'待确认',detail:checkedAt?`采集于 ${maintenanceTime(checkedAt)}${snapshot?.stale?' · 已过期':''}`:'尚无采集时间',required:true},
    {label:'服务器可达',status:host?.reachable===true?'通过':host?.reachable===false?'需处理':'待确认',detail:host?.reachable===true?'采集器确认可达':'当前可达性未确认；不代表任务已结束',required:true},
    {label:'任务状态核对',status:unknown.length?'需处理':host?.gpuq?.connected===true?'通过':'待确认',detail:unknown.length?`${unknown.length} 项状态待核对：${unknown.map(job=>job.name||job.id).join('、')}`:host?.gpuq?.connected===true?'本次返回的任务无 UNKNOWN 状态':'调度器连接未确认；不能推断没有任务',required:true},
    {label:'ROOT 运维会话',status:roots.length?'待确认':'通过',detail:`本页面已知 ${roots.length} 个${roots.length?'，请结束或明确核对后恢复':''}；不代表整机无其他 ROOT / SSH 会话`,required:false},
    {label:'等待任务',status:'待确认',detail:`平台与本次采集返回 ${queued.length} 项；恢复后未取消的等待任务会继续派发`,required:false}
  ];
  return {ready:checks.filter(check=>check.required).every(check=>check.status==='通过'),checks,running,queued,roots,checkedAt,host};
}
