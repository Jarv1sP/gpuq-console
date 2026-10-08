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

export async function cancelTrainingPreparations(service,job){
  for(const value of job.trainingPreparations||[]){
    if(value.preparation.kind==='transfer'){
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
