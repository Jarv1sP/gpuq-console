// One allocation contract shared by browser, CLI and submission service.
import {schedulingPolicy} from './scheduling-policy.js';
// Existing Console contract: scripts/configure.mjs inventories and the
// job-resources.py budget reader both support up to 64 cards per node. Native
// GPUQ itself limits by configured pool size; this is not a new native cap.
export function elasticAllocation(value,cards,scheduling){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['minCards','globalBatch','microBatch','autoExpand'].includes(k)))throw Error('弹性卡参数无效。');
  const {minCards,globalBatch,microBatch,autoExpand=false}=value;
  if(!Number.isInteger(cards)||cards<1||cards>64||!Number.isInteger(minCards)||minCards<1||minCards>cards)throw Error('最低卡数须为 1 到最大卡数之间的整数。');
  if(!Number.isSafeInteger(globalBatch)||globalBatch<1||!Number.isSafeInteger(microBatch)||microBatch<1||typeof autoExpand!=='boolean')throw Error('global batch、每卡 micro batch 须为正整数。');
  // Division first avoids unsafe products for large valid JS integers.
  const allowed=globalBatch%microBatch===0?Array.from({length:cards-minCards+1},(_,i)=>i+minCards).filter(n=>(globalBatch/microBatch)%n===0):[];
  if(!allowed.length)throw Error('弹性范围内没有能够整除 global batch 的合法卡数。');
  if(autoExpand){
    let consent;
    try{consent=schedulingPolicy(scheduling,true);}catch(error){throw Error('自动扩卡需要有效的保存和恢复策略：'+error.message);}
    if(!consent.checkpointable||consent.restartPolicy!=='on-preempt')throw Error('自动扩卡需要 checkpoint 适配器及保存后自动恢复策略。');
  }
  if(autoExpand&&allowed.length<2)throw Error('自动扩卡需要至少两种合法卡数。');
  return {elastic:{minCards,globalBatch,microBatch,autoExpand},allowed};
}

export function elasticCapable(host){return host?.reachable===true&&host.gpuq?.connected===true&&Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('console-elastic-v1');}

export function allocationLabel(job){return job.elastic?`弹性 ${job.elastic.minCards}–${job.cards} 张 · 当前 ${job.actualCards??job.assignedIndices?.length??0} 张 · 合法卡数 ${(job.allowedGpuCounts||[]).join(',')}`:`${job.cards} 张`;}
