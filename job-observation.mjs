// A terminal Portal lifecycle is immutable here. A host-side retry is an
// observation, not authority to reserve quota, reacquire holds or cancel it.
import {normalizeAttempt,normalizeProgress,jobTiming} from './dist/job-progress.js';

const states=new Set(['PENDING','STARTING','RUNNING','PREEMPTING','SUCCEEDED','FAILED','CANCELED','LOST']);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const seconds=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function unavailableObservation(reason='UNAVAILABLE'){
  return {protocol:'native-observation-v1',readOnly:true,status:'UNKNOWN',retryDetected:false,
    manualRecovery:{required:true,reason},message:'节点重试状态未确认；保留门户原终态，不提交、取消或重新申请资源。'};
}
export function terminalNativeObservation(job,raw){
  if(!job.nodeJobId)return unavailableObservation('NATIVE_ID_UNAVAILABLE');
  if(!object(raw)||raw.protocol!=='native-observation-v1'||raw.status!=='CONFIRMED')return unavailableObservation();
  if(raw.jobId!==job.id||raw.userId!==job.userId||raw.nodeJobId!==job.nodeJobId||raw.submitKey!==job.id||raw.specVerified!==true)
    return unavailableObservation('IDENTITY_MISMATCH');
  if(!Number.isSafeInteger(raw.nativeVersion)||raw.nativeVersion<0||!states.has(raw.state)||!seconds(raw.observedAt))return unavailableObservation('INVALID_EVIDENCE');
  const attempt=normalizeAttempt(raw.latestAttempt),previous=job.latestAttempt;
  if(raw.latestAttempt!==null&&(!object(raw.latestAttempt)||!attempt?.id||!positive(attempt.ordinal)))return unavailableObservation('INVALID_EVIDENCE');
  if(positive(previous?.ordinal)&&(!attempt||attempt.ordinal<previous.ordinal||attempt.ordinal===previous.ordinal&&attempt.id!==previous.id))
    return unavailableObservation('ATTEMPT_MISMATCH');
  const event=raw.latestRetry;
  if(event!==null&&(!object(event)||!positive(event.eventId)||!seconds(event.createdAt)||event.createdAt>raw.observedAt))return unavailableObservation('INVALID_EVIDENCE');
  // Use the scheduler's clock, not the later Portal reconciliation timestamp.
  // Pending retries need not have allocated a new attempt yet.
  const baseline=previous?.finishedAt;
  const retryDetected=!!event&&seconds(baseline)&&event.createdAt>baseline;
  const changed=raw.state!==job.state||positive(previous?.ordinal)&&attempt?.ordinal>previous.ordinal;
  const reason=retryDetected?'HOST_RETRY_REQUIRES_EXPLICIT_RECOVERY':changed?'TERMINAL_DIVERGENCE_UNCONFIRMED':null;
  return {protocol:raw.protocol,readOnly:true,status:'CONFIRMED',nodeJobId:raw.nodeJobId,
    state:raw.state,nativeVersion:raw.nativeVersion,observedAt:raw.observedAt,
    latestAttempt:attempt,progress:normalizeProgress(raw.progress),
    latestRetry:event?{eventId:event.eventId,createdAt:event.createdAt}:null,retryDetected,
    manualRecovery:{required:reason!==null,reason},
    message:reason?'仅观察节点当前状态；门户原终态、取消标记与已释放保护保持，未批准或执行新的重试。':'节点观察与门户原终态一致；未改变任务生命周期。'};
}
export const portalTerminalSnapshot=job=>({state:job.state,cancelRequested:job.cancelRequested===true,...jobTiming(job)});
export function nativeObservationText(observation){
  if(!observation)return '';
  if(observation.status!=='CONFIRMED')return '节点只读观察：UNKNOWN；保留门户原终态，未自动重试。';
  return `节点只读观察：${observation.state}${observation.latestAttempt?.ordinal?` · 第 ${observation.latestAttempt.ordinal} 次尝试`:''}`+
    (observation.retryDetected?' · 已确认宿主手动重试':'')+'\n'+observation.message;
}
