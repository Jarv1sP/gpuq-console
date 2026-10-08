import {randomUUID} from 'node:crypto';
import {trainingStorageDigest} from './training-storage.mjs';

// Private Portal state, not a new queue or client-selectable cohort flag.
// Every remote request has its full original spec/tuple saved first. Transfer
// followups use the same context in the existing transfer row after restart.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw Object.assign(Error('训练准备的固定身份或容量准入未确认；不会使用旧准备入口。'),{status:409,code:'TRAINING_PREPARATION_UNVERIFIED'});};
export function assertTrainingPreparation(service,value,{cleanup=false}={}){
  const job=service.store.jobs.find(row=>row.id===value?.job?.id);
  if(!job||!job.trainingStoragePlan||job.userId!==value.job.userId||job.machine!==value.preparation?.targetMachine||
     value.job.datasetReadMode==='warehouse'||!UUID.test(value.preparation?.id||'')||
     !job.trainingPreparations?.some(row=>same(row,value))||
     value.planRequest?.userId!==job.userId||value.planRequest.hostAdmin!==false||value.planRequest.datasetReadMode!=='cache')fail();
  if(!cleanup&&(job.cancelRequested||!['PREPARING_DATA','SUBMITTING'].includes(job.state)))fail();
  return job;
}

export async function bindTrainingPreparation(service,jobId,template){
  return service.enqueue(()=>{
    const job=service.store.jobs.find(row=>row.id===jobId);
    if(!job?.trainingStoragePlan||!job.trainingStorageRequest||job.trainingStoragePlan.noReclaim!==true||job.trainingStoragePlan.fits!==true||
       job.trainingStoragePlan.owner!==job.userId||job.trainingStoragePlan.machine!==job.machine||
       job.trainingStoragePlan.requestSHA256!==trainingStorageDigest(job.trainingStorageRequest)||
       job.cancelRequested||job.state!=='PREPARING_DATA'||job.spec?.id!==job.id||job.spec.userId!==job.userId)fail();
    if(!['dataset','transfer'].includes(template.kind)||template.reference?.version!==template.logicalReference?.version||
       !job.spec.datasets?.some(ref=>ref.dataset===template.logicalReference?.dataset&&ref.version===template.logicalReference?.version))fail();
    const old=job.trainingPreparations?.find(row=>row.preparation.kind===template.kind&&same(row.preparation.logicalReference,template.logicalReference));
    if(old){
      if(old.preparation.sourceMachine!==template.sourceMachine||old.preparation.targetMachine!==job.machine||
         !same(old.preparation.reference,template.reference)||template.id&&template.id!==old.preparation.id)fail();
      return structuredClone(old);
    }
    const value={job:structuredClone(job.spec),planRequest:structuredClone(job.trainingStorageRequest),
      preparation:{protocol:1,id:template.id||randomUUID(),kind:template.kind,sourceMachine:template.sourceMachine,targetMachine:job.machine,
        logicalReference:structuredClone(template.logicalReference),reference:structuredClone(template.reference)}};
    const before=job.trainingPreparations;
    try{job.trainingPreparations=[...(before||[]),value];service.save();}catch(error){if(before===undefined)delete job.trainingPreparations;else job.trainingPreparations=before;throw error;}
    return structuredClone(value);
  });
}

export async function trainingPreparationCall(service,value,operation,args){
  const cleanup=['datasets.cancel','transfers.cancel','transfers.status','transfers.confirm-source-release','transfers.confirm-unprepared-cancel'].includes(operation);
  assertTrainingPreparation(service,value,{cleanup});
  const result=await service.bridge(value.preparation.targetMachine,'storage.training.prepare',{...structuredClone(value),operation,args});
  assertTrainingPreparation(service,value,{cleanup});
  return result;
}

export async function prepareTrainingDataset(service,jobId,logicalReference,reference){
  const job=service.store.jobs.find(row=>row.id===jobId);if(!job)fail();
  const value=await bindTrainingPreparation(service,jobId,{kind:'dataset',sourceMachine:job.machine,logicalReference,reference});
  return trainingPreparationCall(service,value,'datasets.prepare',{userId:job.userId,hostAdmin:false,...reference});
}

export function assertTrainingProjectPreparation(service,value,{cleanup=false}={}){
  const job=service.store.jobs?.find(row=>row.id===value?.job?.id),prep=value?.preparation;
  if(!job||!job.trainingStoragePlan||job.userId!==value.job.userId||job.machine!==prep?.targetMachine||
     prep.kind!=='project'||prep.protocol!==1||!UUID.test(prep.id||'')||
     prep.reference?.project!==job.project||prep.reference.release!==job.release||
     prep.sourceMachine!==job.projectPreparation?.from||
     !job.trainingPreparations?.some(row=>same(row,value))||
     value.job.project!==job.project||value.job.release!==job.release||
     value.planRequest?.userId!==job.userId||value.planRequest.hostAdmin!==false||
     value.planRequest.project!==job.project||value.planRequest.release!==job.release||
     value.planRequest.datasetReadMode!==(value.job.datasetReadMode||'cache')||
     value.planRequest.projectFootprint?.sourceMachine!==prep.sourceMachine)fail();
  if(!cleanup&&(job.cancelRequested||job.state!=='PREPARING_DATA'||!same(job.spec,value.job)||
     !same(job.trainingStorageRequest,value.planRequest)||job.trainingStoragePlan.noReclaim!==true||
     job.trainingStoragePlan.fits!==true||job.trainingStoragePlan.owner!==job.userId||
     job.trainingStoragePlan.machine!==job.machine||job.trainingStoragePlan.requestSHA256!==trainingStorageDigest(value.planRequest)))fail();
  return job;
}

export async function bindTrainingProjectPreparation(service,jobId,{sourceMachine,project,release}){
  return service.enqueue(()=>{
    const job=service.store.jobs?.find(row=>row.id===jobId),request=job?.trainingStorageRequest,plan=job?.trainingStoragePlan;
    if(!job||!request||!plan||plan.noReclaim!==true||plan.fits!==true||plan.owner!==job.userId||plan.machine!==job.machine||
       plan.requestSHA256!==trainingStorageDigest(request)||job.cancelRequested||job.state!=='PREPARING_DATA'||
       job.spec?.id!==job.id||job.spec.userId!==job.userId||project!==job.project||release!==job.release||
       job.spec.project!==project||job.spec.release!==release||sourceMachine!==job.projectPreparation?.from||
       sourceMachine===job.machine||request.projectFootprint?.sourceMachine!==sourceMachine)fail();
    const old=job.trainingPreparations?.find(row=>row.preparation.kind==='project');
    if(old){assertTrainingProjectPreparation(service,old);return structuredClone(old);}
    const value={job:structuredClone(job.spec),planRequest:structuredClone(request),
      preparation:{protocol:1,id:randomUUID(),kind:'project',sourceMachine,targetMachine:job.machine,reference:{project,release}}};
    const before=job.trainingPreparations;
    try{job.trainingPreparations=[...(before||[]),value];service.save();}catch(error){if(before===undefined)delete job.trainingPreparations;else job.trainingPreparations=before;throw error;}
    return structuredClone(value);
  });
}

export async function trainingProjectPreparationCall(service,value,machine,operation,args){
  const cleanup=['projects.copy.cancel','projects.copy.revoke','projects.copy.release','projects.copy.status'].includes(operation);
  assertTrainingProjectPreparation(service,value,{cleanup});
  if(![value.preparation.sourceMachine,value.preparation.targetMachine].includes(machine))fail();
  const result=await service.bridge(machine,'storage.training.project.prepare',{...structuredClone(value),operation,args});
  assertTrainingProjectPreparation(service,value,{cleanup});return result;
}

export async function cancelTrainingPreparations(service,job){
  for(const value of job.trainingPreparations||[]){
    if(value.preparation.kind==='project'){
      if(!service.cancelTrainingProjectCopy)fail();
      const result=await service.cancelTrainingProjectCopy(value);
      if(!['SUCCEEDED','CANCELED'].includes(result.state)||result.cleanupComplete!==true)throw Error('准备项目的原 worker 停止尚未确认。');
    }else if(value.preparation.kind==='transfer'){
      if(!service.transferCall)fail();
      const user=service.store.get(job.userId);
      const result=service.transferSnapshot?.(job.userId,value.preparation.id)?
        await service.transferCall({userId:user.id,username:user.username,role:'member'},'transfers.cancel',{id:value.preparation.id}):
        await trainingPreparationCall(service,value,'transfers.cancel',{id:value.preparation.id,userId:job.userId});
      if(!['SUCCEEDED','CANCELED'].includes(result.state))throw Error('准备传输的原 worker 停止尚未确认。');
    }else{
      const result=await trainingPreparationCall(service,value,'datasets.cancel',{userId:job.userId,hostAdmin:false,...value.preparation.reference});
      if(result.state!=='CANCELED'||result.confirmedStopped!==true)throw Error('准备缓存的原 worker 停止尚未确认。');
    }
  }
}
