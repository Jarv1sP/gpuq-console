// A queue rank is not consent to discard state. Old presets stay unchanged.
export function schedulingPolicy(value,admin=false){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['rank','yieldPolicy','restartPolicy','checkpointable'].includes(k)))throw Error('自定义调度参数无效。');
  const rank=value.rank??'P2',yieldPolicy=value.yieldPolicy??'never',restartPolicy=value.restartPolicy??'never',checkpointable=value.checkpointable??false;
  if(typeof rank!=='string'||!/^P[0-4]$/.test(rank))throw Error('排队等级必须为 P0–P4。');
  if(Number(rank[1])>2&&!admin)throw Object.assign(Error('P3/P4 仅管理员可用。'),{status:403});
  if(!['never','now','save'].includes(yieldPolicy)||!['never','on-preempt'].includes(restartPolicy)||typeof checkpointable!=='boolean')throw Error('让位或恢复策略无效。');
  if(yieldPolicy==='save'&&!checkpointable)throw Error('保存让位需要明确确认训练已接入 epoch checkpoint 适配器。');
  if(restartPolicy==='on-preempt'&&(yieldPolicy!=='save'||!checkpointable))throw Error('自动恢复需要保存让位和 checkpoint 适配器；立即让位不自动从头重跑。');
  return {rank,yieldPolicy,restartPolicy,checkpointable};
}
export const yieldCapable=host=>host?.reachable===true&&host.gpuq?.connected===true&&Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('console-yield-v1');
export function schedulingFields(admin=false){return `<details id="custom-scheduling"><summary>自定义 GPUQ 调度</summary><label><input type="checkbox" name="custom-policy">使用独立排队等级与让位策略</label><label>排队等级<select name="queue-rank">${[0,1,2,...(admin?[3,4]:[])].map(n=>`<option value="P${n}" ${n===2?'selected':''}>P${n}</option>`).join('')}</select></label><label>允许高优先级任务抢占我<select name="yield-policy"><option value="never">不允许</option><option value="now">立即让位，不保存</option><option value="save">本轮保存后让位</option></select></label><label>让位后<select name="restart-policy"><option value="never">结束，不自动恢复</option><option value="on-preempt">排队并从 checkpoint 自动恢复</option></select></label><label><input type="checkbox" name="checkpointable">训练已接入 epoch checkpoint 和恢复适配器（DDP 全 rank 协同）</label><p id="custom-policy-note" class="muted"></p></details>`;}
export function schedulingFromForm(form,admin=false){return form.get('custom-policy')?schedulingPolicy({rank:form.get('queue-rank'),yieldPolicy:form.get('yield-policy'),restartPolicy:form.get('restart-policy'),checkpointable:form.get('checkpointable')==='on'},admin):null;}
export function appendSchedulingDetails(container,jobs){
  for(const button of container.querySelectorAll('[data-job-logs]')){
    const job=jobs.find(j=>j.id===button.dataset.jobLogs),cell=button.closest('tr')?.querySelector('[data-label="优先级 / 调度"]');
    if(!job?.scheduling||!cell)continue;
    const note=container.ownerDocument.createElement('small');
    note.textContent=`申请：${job.scheduling.rank} · 让位 ${job.scheduling.yieldPolicy} · 恢复 ${job.scheduling.restartPolicy}`;
    cell.append(note);
  }
}
