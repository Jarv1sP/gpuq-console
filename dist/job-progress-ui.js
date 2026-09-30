import {progressPercent,progressText} from './job-progress.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function jobProgressHTML(job){
  const progress=job.progress,s=progress?.snapshot,percent=progressPercent(progress);
  const metrics=s?Object.entries(s.metrics||{}).slice(0,4).map(([key,value])=>key+'='+Number(value).toPrecision(5)).join(' · '):'';
  return `<div class="task-progress"><small>${escape(progressText(progress))}</small>${percent===null?'':`<progress max="100" value="${percent}" aria-label="${escape(job.name)} 的训练自报进度">${percent}%</progress>`}${metrics?`<small>${escape(metrics)}</small>`:''}${s?'<small>训练自报；完成状态以调度器确认为准。</small>':''}${job.latestAttempt?.exitCode===null||job.latestAttempt?.exitCode===undefined?'':`<small>退出码：${escape(job.latestAttempt.exitCode)}</small>`}${job.latestAttempt?.failureReason?`<small class="task-error">${escape(job.latestAttempt.failureReason)}</small>`:''}</div>`;
}
