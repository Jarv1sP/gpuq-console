// The training report is advisory. Scheduler state alone determines completion.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clean=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,max):null;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const age=value=>finite(value)&&value>=0?value:null;
const pair=(completed,total)=>completed===null&&total===null||Number.isSafeInteger(completed)&&Number.isSafeInteger(total)&&total>0&&completed>=0&&completed<=total;
export const JOB_TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);

export function normalizeProgress(value){
  if(value===undefined||value===null)return null;
  if(!object(value))return {reported:false,stale:false,error:'invalid progress snapshot',snapshot:null};
  const base={reported:value.reported===true,stale:value.stale===true,error:value.error?'invalid progress snapshot':null,
    heartbeatAgeSeconds:age(value.heartbeat_age_seconds),progressAgeSeconds:age(value.progress_age_seconds),snapshot:null};
  if(!base.reported)return base;
  const s=value.snapshot;
  if(!object(s)||!Number.isSafeInteger(s.sequence)||s.sequence<0||!clean(s.phase,64)||
    !pair(s.epochs_completed,s.epochs_total)||!pair(s.steps_completed,s.steps_total)||
    !object(s.metrics)||Object.keys(s.metrics).length>32||Object.entries(s.metrics).some(([k,v])=>!/^[A-Za-z][A-Za-z0-9_.:/-]{0,63}$/.test(k)||!finite(v))||
    !['info','warning','error'].includes(s.severity)||s.eta_seconds!==null&&(!finite(s.eta_seconds)||s.eta_seconds<0))
    return {...base,reported:false,error:'invalid progress snapshot'};
  return {...base,source:'training-self-report',snapshot:{sequence:s.sequence,phase:clean(s.phase,64),
    epochsCompleted:s.epochs_completed,epochsTotal:s.epochs_total,stepsCompleted:s.steps_completed,stepsTotal:s.steps_total,
    metrics:Object.fromEntries(Object.entries(s.metrics)),etaSeconds:s.eta_seconds,severity:s.severity,
    message:s.severity==='info'?null:clean(s.message,512),updatedAt:age(s.updated_at)}};
}

export function normalizeAttempt(value){
  if(!object(value))return null;
  return {id:clean(value.id,256),ordinal:Number.isSafeInteger(value.ordinal)&&value.ordinal>0?value.ordinal:null,
    state:clean(value.state,40),exitCode:Number.isInteger(value.exit_code)?value.exit_code:null,
    failureReason:clean(value.failure_reason,512),startedAt:age(value.started_at),finishedAt:age(value.finished_at)};
}

export function applyJobFeedback(job,result){
  // Older nodes omit these fields; discard an old attempt's report rather than
  // displaying it as live after a restart or a version mismatch.
  job.progress=normalizeProgress(result.progress);
  job.latestAttempt=normalizeAttempt(result.latestAttempt);
}

export function progressPercent(progress){
  const s=progress?.snapshot;if(!progress?.reported||!s)return null;
  const completed=s.stepsTotal?s.stepsCompleted:s.epochsCompleted,total=s.stepsTotal||s.epochsTotal;
  return Number.isFinite(total)&&total>0?Math.floor(100*completed/total):null;
}

export function progressText(progress){
  if(!progress)return '进度未上报';
  if(progress.error)return '进度上报无效';
  if(!progress.reported||!progress.snapshot)return '进度未上报';
  const s=progress.snapshot,parts=[s.phase];
  if(s.epochsTotal)parts.push(`轮次 ${s.epochsCompleted}/${s.epochsTotal}`);
  if(s.stepsTotal)parts.push(`步数 ${s.stepsCompleted}/${s.stepsTotal}`);
  const percent=progressPercent(progress);if(percent!==null)parts.push(percent+'%');
  if(s.etaSeconds!==null)parts.push('预计剩余 '+Math.ceil(s.etaSeconds/60)+' 分钟');
  if(progress.stale)parts.push('进度停滞（训练上报超时）');
  if(s.severity!=='info')parts.push(s.severity==='error'?'训练报告异常':'训练报告警告');
  if(s.message)parts.push(s.message);
  return parts.join(' · ');
}

export function feedbackKey(job){
  return JSON.stringify([job.state,job.cancelRequested===true,job.error,job.latestAttempt,job.progress?.stale,job.progress?.error,job.progress?.snapshot]);
}

export function jobFeedbackText(job){
  const parts=[`${clean(job.name,64)||'train'} · ${clean(job.username,24)||'-'} · ${clean(job.id,256)||'-'}`,
    `${clean(job.machine,128)||'待选服务器'} · ${clean(job.state,40)||'UNKNOWN'} · ${progressText(job.progress)}`];
  if(job.error)parts.push(clean(job.error,512));
  const attempt=job.latestAttempt;
  if(attempt?.exitCode!==null&&attempt?.exitCode!==undefined)parts.push('退出码 '+attempt.exitCode);
  if(attempt?.failureReason)parts.push(attempt.failureReason);
  return parts.join('\n');
}

export const watchExitCode=job=>job.state==='SUCCEEDED'?0:job.state==='CANCELED'?130:job.state==='FAILED'?1:3;
