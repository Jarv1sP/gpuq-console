// Shared browser/server contract. Rendering and DOM state live in scheduling-ui.
const FIELDS=new Set(['rank','yieldPolicy','restartPolicy','checkpointable']);
const DEFAULTS=Object.freeze({rank:'P2',yieldPolicy:'never',restartPolicy:'never',checkpointable:false});

export function schedulingPolicy(value,admin=false){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!FIELDS.has(k))){
    throw Error('自定义调度参数无效。');
  }
  const policy={...DEFAULTS,...value};
  const {rank,yieldPolicy,restartPolicy,checkpointable}=policy;
  if(typeof rank!=='string'||!/^P[0-4]$/.test(rank))throw Error('排队等级必须为 P0–P4。');
  if(Number(rank[1])>2&&!admin)throw Object.assign(Error('P3/P4 仅管理员可用。'),{status:403});
  if(!['never','now','save'].includes(yieldPolicy)||!['never','on-preempt'].includes(restartPolicy)||typeof checkpointable!=='boolean'){
    throw Error('让位或恢复策略无效。');
  }
  if(yieldPolicy==='save'&&!checkpointable)throw Error('保存让位需要明确确认训练已接入 epoch checkpoint 适配器。');
  if(restartPolicy==='on-preempt'&&(yieldPolicy!=='save'||!checkpointable)){
    throw Error('自动恢复需要保存让位和 checkpoint 适配器；立即让位不自动从头重跑。');
  }
  return policy;
}

export function yieldCapable(host){
  return host?.reachable===true&&host.gpuq?.connected===true&&
    Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('console-yield-v1');
}
