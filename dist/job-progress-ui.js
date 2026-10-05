import {progressPercent,progressText} from './job-progress.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function jobProgressHTML(job){
  const progress=job.progress,s=progress?.snapshot,percent=progressPercent(progress);
  const metrics=s?Object.entries(s.metrics||{}).slice(0,4).map(([key,value])=>key+'='+Number(value).toPrecision(5)).join(' · '):'';
  return `<div class="task-progress"><small>${escape(progressText(progress))}</small>${percent===null?'':`<progress max="100" value="${percent}" aria-label="${escape(job.name)} 的训练上报进度">${percent}%</progress>`}${metrics?`<small>${escape(metrics)}</small>`:''}${s?'<small>训练上报；完成状态以调度器确认为准。</small>':''}${job.latestAttempt?.exitCode===null||job.latestAttempt?.exitCode===undefined?'':`<small>退出码：${escape(job.latestAttempt.exitCode)}</small>`}${job.latestAttempt?.failureReason?`<small class="task-error">${escape(job.latestAttempt.failureReason)}</small>`:''}</div>`;
}

export function jobNotificationHTML(job,userId){
  if(job.userId!==userId||!job.notifications?.configured)return '';
  if(job.notifications.degraded)return '<small>通知存储暂不可用</small>';
  const enabled=job.notifications.enabled===true,terminal=['SUCCEEDED','FAILED','CANCELED'].includes(job.state);
  return `<button class="button" data-job-notify="${escape(job.id)}" ${terminal&&!enabled?'disabled':''}>${enabled?'关闭 Telegram 通知':'开启 Telegram 通知'}</button>`;
}
