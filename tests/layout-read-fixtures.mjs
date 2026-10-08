import assert from 'node:assert/strict';
import {jobCompletion} from '../job-observation.mjs';

export const layoutReadOperations=new Set(['jobs.completion','datasets.training.capabilities','storage.usage.mine','storage.usage.users']);

// Read-only contract replies shared by strict layout fixtures. Unrecognized
// operations still reach each fixture's original Unexpected API guard.
export function layoutReadReply(operation,args,{principal,state,completion='unconfirmed'}){
 assert(layoutReadOperations.has(operation));assert(principal?.userId,'a layout read requires a logged-in principal');
 if(operation==='jobs.completion'){
  assert.deepEqual(Object.keys(args),['jobId']);
  const row=state.jobs.find(row=>row.id===args.jobId&&row.userId===principal.userId);
  assert.ok(row,'Completion reads stay bound to the fixture owner and exact job');
  const job={...row,spec:row.spec||{id:row.id,userId:row.userId,project:row.project||null,release:row.release||null}};
  const confirmed=completion==='confirmed'&&row.state==='SUCCEEDED';
  const native=confirmed?{nodeJobId:job.nodeJobId,state:'SUCCEEDED',assignedIndices:[],nativeObservation:{
   protocol:'native-observation-v1',status:'CONFIRMED',jobId:job.id,userId:job.userId,nodeJobId:job.nodeJobId,
   submitKey:job.id,specVerified:true,state:'SUCCEEDED',nativeVersion:1,observedAt:Math.floor(Date.now()/1000),
   latestRetry:null,latestAttempt:{id:job.latestAttempt.id,ordinal:job.latestAttempt.ordinal,state:job.latestAttempt.state,
    exit_code:job.latestAttempt.exitCode,failure_reason:job.latestAttempt.failureReason,
    started_at:job.latestAttempt.startedAt,finished_at:job.latestAttempt.finishedAt},
  }}:null;
  return jobCompletion(job,native);
 }
 if(operation==='datasets.training.capabilities'){
  assert.deepEqual(Object.keys(args).sort(),['dataset','machine','version']);
  assert(state.machines.some(row=>row.id===args.machine));assert.equal(typeof args.dataset,'string');assert(args.dataset);
  assert.match(args.version,/^[a-f0-9]{64}$/);
  return {protocol:1,machine:args.machine,dataset:args.dataset,version:args.version,
   warehouse:{available:false,reason:'本地夹具未提供仓库读取证明'}};
 }
 assert.deepEqual(args,{},'usage reads never override the session identity or machine');
 const machines=()=>state.machines.map(row=>({machine:row.id,available:false,reason:'本地夹具未提供空间采样',
  collectedAt:null,complete:false,projectBytes:null,projects:[]}));
 const checkedAt=new Date().toISOString();
 if(operation==='storage.usage.mine')return {protocol:1,checkedAt,machines:machines()};
 assert.equal(principal.role,'admin','all-user usage requires an administrator');
 return {protocol:1,checkedAt,users:state.users.map(row=>({userId:row.id,label:row.name||row.username||row.id,machines:machines()}))};
}
