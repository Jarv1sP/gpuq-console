// A terminal Portal lifecycle is immutable here. A host-side retry is an
// observation, not authority to reserve quota, reacquire holds or cancel it.
import {normalizeAttempt,normalizeProgress,jobTiming} from './dist/job-progress.js';
import {createHash} from 'node:crypto';

const states=new Set(['PENDING','STARTING','RUNNING','PREEMPTING','SUCCEEDED','FAILED','CANCELED','LOST']);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const seconds=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// The 2026-10-08 cleanup intentionally removed old node records and outputs.
// Only an exact missing-record error for an older terminal job proves this
// case; a timeout or a missing file inside an existing output does not.
export function jobOutputReadError(job,error){
  const created=Date.parse(job?.createdAt);
  if(!job||!['SUCCEEDED','FAILED','CANCELED'].includes(job.state)||!Number.isFinite(created)||
    created>=Date.parse('2026-10-08T00:00:00Z')||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(job.id)||
    error?.status!==undefined&&error.status!==400)return error;
  const missing=/^\[Errno 2\] No such file or directory: '[^'\r\n]*\/jobs\/([a-f0-9-]{36})\.json'$/.exec(error?.message||'');
  if(missing?.[1]!==job.id)return error;
  return Object.assign(Error('该任务的节点记录已随 2026-10-08 清盘移除，输出不可恢复'),{
    status:410,code:'JOB_RECORD_PURGED',jobId:job.id,
    job:Object.fromEntries(['id','machine','project','release','createdAt','finishedAt','state','nodeJobId']
      .filter(key=>Object.hasOwn(job,key)).map(key=>[key,job[key]])),
  });
}
export const jobOutputErrorBody=error=>error?.code==='JOB_RECORD_PURGED'
  ?{code:error.code,reasonCode:error.code,jobId:error.jobId,job:error.job}:{};

// Supplied only after an operator confirms absence in both the current and
// pre-cleanup node roots. A 404 by itself never proves a cleanup. This is an
// optional, read-only deployment setting; it does not edit the original rows.
const recordFields=['kind','id','machine','userId','project','name','path','totalSize','sha256','totalBytes','entries','manifestBytes','dataset','version','lastKnownState','receivedBytes','manifestOffset','remainingBytes'];
export function confirmedPurgedRecords(input='[]'){
  const rows=typeof input==='string'?JSON.parse(input):input;
  if(!Array.isArray(rows)||rows.length>128)throw Error('Invalid confirmed purged records');
  return Object.freeze(rows.map(row=>{
    if(!object(row)||Object.keys(row).some(key=>!recordFields.includes(key))||
      !['upload','project','workspace','status'].includes(row.kind)||!['id','machine','userId'].every(key=>typeof row[key]==='string'&&row[key].length>0&&row[key].length<=128)||
      ['upload','workspace'].includes(row.kind)&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row.id)||
      row.kind==='status'&&(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.dataset||'')||!/^[a-f0-9]{64}$/.test(row.version||'')||row.id!==row.version)||
      Object.values(row).some(value=>typeof value!=='string'&&(!Number.isSafeInteger(value)||value<0)))
      throw Error('Invalid confirmed purged record');
    return Object.freeze({...row});
  }));
}
export function purgedRecordReadError(service,token,operation,args,error,records){
  if(!object(args)||![undefined,400,404].includes(error?.status))return error;
  const projectMissing=error.message==='Project not found for this user';
  const uploadMissing=error.message==='上传不存在；恢复已有仓库上传需要原平台的位置记录。';
  const datasetRead=['datasets.upload.status','datasets.upload.routes'].includes(operation);
  const fileRead=operation==='files.upload.status'||operation==='files.list'||operation==='files.direct-ticket';
  // Exact, operator-confirmed identities only. A missing file inside an
  // existing workspace, an unrelated version, or an RPC timeout is not proof.
  const workspaceRead=operation==='datasets.workspace.status'&&typeof args.operationId==='string'&&
    error.message===`[Errno 2] No such file or directory: '${args.operationId}.json'`;
  const versionRead=operation==='datasets.status'&&args.operationId===undefined&&
    error.message==='dataset registration or version does not exist or was removed; refresh the dataset list';
  if(!(datasetRead&&uploadMissing||(fileRead||operation==='projects.status')&&projectMissing||workspaceRead||versionRead))return error;
  if(fileRead&&(args.area??'code')!=='code')return error;
  const principal=service.terminalPrincipal(token,args);
  service.assertMaintenanceAllowed?.(operation,args,principal);
  const owned=records.filter(row=>row.userId===principal.userId&&row.machine===args.machine);
  const upload=owned.find(row=>row.kind==='upload'&&(
    datasetRead?row.id===args.uploadId:
    (operation==='files.upload.status'||operation==='files.direct-ticket'&&args.action==='put')&&
      row.project===args.project&&row.path===args.path&&row.totalSize===args.totalSize&&row.sha256===args.sha256&&
      (args.uploadId===undefined||args.uploadId===row.id)));
  const record=upload||(projectMissing&&owned.find(row=>row.kind==='project'&&row.id===args.project))||
    (workspaceRead&&owned.find(row=>row.kind==='workspace'&&row.id===args.operationId))||
    (versionRead&&owned.find(row=>row.kind==='status'&&row.dataset===args.dataset&&row.version===args.version));
  if(!record)return error;
  const label=({upload:'上传',project:'项目',workspace:'发布',status:'数据集版本'})[record.kind];
  const action=['workspace','status'].includes(record.kind)?'发布':'上传';
  return Object.assign(Error(`该${label}的节点记录已随 2026-10-08 清盘移除，请从源头重新${action}`),{
    status:410,code:'RECORD_PURGED',recordType:record.kind,recordId:record.id,record:{...record},
    ...(record.kind==='upload'?{uploadId:record.id}:record.kind==='project'?{project:record.id}:
      record.kind==='workspace'?{operationId:record.id}:{dataset:record.dataset,version:record.version}),
  });
}
export const purgedRecordErrorBody=error=>error?.code==='RECORD_PURGED'
  ?{code:error.code,reasonCode:error.code,recordType:error.recordType,recordId:error.recordId,record:error.record,
    ...(error.recordType==='upload'?{uploadId:error.uploadId}:error.recordType==='project'?{project:error.project}:
      error.recordType==='workspace'?{operationId:error.operationId}:{dataset:error.dataset,version:error.version})}:{};

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

export function cacheBusyRecovery(job,result,observation){
  const attempt=observation?.latestAttempt;
  if(job.state!=='FAILED'||job.cancelRequested||observation?.status!=='CONFIRMED'||observation.state!=='FAILED'||
     observation.manualRecovery?.required!==false||observation.retryDetected||attempt?.state!=='EXITED_FAILURE'||
     attempt.exitCode!==125||!attempt.id||!seconds(attempt.finishedAt)||result?.jobId!==job.id)return null;
  const capture=result.captures?.find(c=>c?.jobId===job.id&&c.state==='COMPLETE'&&c.nativeAttemptId===attempt.id&&
    c.runnerExit?.nativeAttemptId===attempt.id&&c.runnerExit.exitCode===125&&
    c.runnerExit.phase==='PROJECT_PREPARATION'&&c.runnerExit.error?.phase==='PROJECT_PREPARATION'&&
    c.runnerExit.error.errorClass==='CacheBusy');
  if(!capture)return null;
  return {reason:'DATASET_CACHE_BUSY',retryMode:'new-submission-key',originalJobId:job.id,
    message:'训练启动前等待数据缓存锁超时，原任务已失败。原 key 只查询这次失败，不会重跑。确认原任务已停止且数据就绪后，重复原 run 命令并去掉旧 --key（或换新 UUID）才会新建任务；保留原项目、release、数据版本和训练参数。不明或运行中时先查原 UUID，不要换 key。'};
}

// A fresh, authenticated success observation for downstream consumers. This
// does not reopen the Portal lifecycle or acquire/release any resources.
export function jobCompletion(job,result){
  const observation=terminalNativeObservation(job,result?.nativeObservation);
  // #110: read the original owner-bound Portal receipt, not native submitKey
  // (which identifies job.id). This proves recorded identity, never completion.
  const key=typeof job.key==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(job.key)?job.key:null;
  const requestSha256=typeof job.digest==='string'&&/^[a-f0-9]{64}$/.test(job.digest)?job.digest:null;
  const base={protocol:'job-completion-v1',readOnly:true,jobId:job.id,machine:job.machine,
    userId:job.userId,nodeJobId:job.nodeJobId||null,project:job.spec.project||null,
    release:job.spec.release||null,specSha256:createHash('sha256').update(JSON.stringify(job.spec)).digest('hex'),
    submission:{protocol:'job-submission-identity-v1',source:'portal-record',status:key&&requestSha256?'RECORDED':'UNCONFIRMED',key,requestSha256},
    portalHistory:{state:job.state,cancelRequested:job.cancelRequested===true,latestAttempt:job.latestAttempt||null},
    completed:false,state:'UNCONFIRMED',nativeObservation:observation};
  const reject=reason=>({...base,reason});
  if(job.spec.id!==job.id||job.spec.userId!==job.userId)return reject('IMMUTABLE_IDENTITY_MISMATCH');
  if(job.cancelRequested||job.state==='CANCELED')return reject('PORTAL_CANCELLATION_REQUIRES_REVIEW');
  const queued=['SUBMITTING','PENDING','QUEUED','PREPARING_DATA'].includes(job.state)&&!job.latestAttempt&&
    base.submission.status==='RECORDED';
  // Admission is durable before dispatch is confirmed. A missing native ID in
  // that phase is expected, not evidence of a lost record or a host-side retry.
  // Unknown/terminal history and any existing attempt retain the strict path.
  if(queued&&(!job.nodeJobId||observation.status==='CONFIRMED'&&observation.state==='PENDING'&&
      !observation.latestAttempt&&!observation.retryDetected)){
    const nativeObservation=job.nodeJobId?{...observation,manualRecovery:{required:false,reason:null},message:'任务正在排队。'}:
      {protocol:'native-observation-v1',readOnly:true,status:'WAITING',retryDetected:false,
        manualRecovery:{required:false,reason:null},message:'提交已登记，等待节点确认。'};
    return {...base,state:'WAITING',reason:job.nodeJobId?'JOB_PENDING':'SUBMISSION_PENDING',
      nativeObservation,message:nativeObservation.message};
  }
  if(observation.status!=='CONFIRMED')return reject('NATIVE_OBSERVATION_UNAVAILABLE');
  // The native watch also confirms no live scheduler consumer and completed
  // dataset-lease cleanup. A SUCCEEDED field in an arbitrary log is not proof.
  if(result?.nodeJobId!==job.nodeJobId||result?.state!=='SUCCEEDED'||
     !Array.isArray(result.assignedIndices)||result.assignedIndices.length||observation.state!=='SUCCEEDED')
    return reject('NATIVE_COMPLETION_NOT_CONFIRMED');
  const attempt=observation.latestAttempt,previous=job.latestAttempt;
  if(!attempt||attempt.state!=='EXITED_SUCCESS'||attempt.exitCode!==0||attempt.failureReason!==null||
     !seconds(attempt.startedAt)||!seconds(attempt.finishedAt)||attempt.finishedAt<attempt.startedAt||attempt.finishedAt>observation.observedAt)
    return reject('SUCCESSFUL_ATTEMPT_NOT_CONFIRMED');
  const changed=job.state!=='SUCCEEDED'||previous?.id!==attempt.id||previous?.ordinal!==attempt.ordinal;
  if(changed&&(!positive(previous?.ordinal)||attempt.ordinal<=previous.ordinal||
     !observation.retryDetected||observation.latestRetry.createdAt>attempt.startedAt))
    return reject('TRUSTED_RETRY_NOT_CONFIRMED');
  return {...base,completed:true,state:'SUCCEEDED',reason:null,completedAttempt:attempt,
    observedAt:observation.observedAt,nativeVersion:observation.nativeVersion,
    message:'已核验同一不可变任务的末次成功尝试；原失败历史与配额生命周期未改写。'};
}
export function nativeObservationText(observation){
  if(!observation)return '';
  if(observation.status!=='CONFIRMED')return '节点只读观察：UNKNOWN；保留门户原终态，未自动重试。';
  return `节点只读观察：${observation.state}${observation.latestAttempt?.ordinal?` · 第 ${observation.latestAttempt.ordinal} 次尝试`:''}`+
    (observation.retryDetected?' · 已确认宿主手动重试':'')+'\n'+observation.message;
}
