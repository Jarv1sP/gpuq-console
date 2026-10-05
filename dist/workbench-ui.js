import {progressPercent,progressText} from './job-progress.js';
import {maintenanceActive} from './maintenance-state.js';

export const escapeUI=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const endedJob=job=>['SUCCEEDED','FAILED','CANCELED'].includes(job.state);
export function stateClass(job){
  if(job.cancelRequested&&!endedJob(job))return 'st-cancel';
  return {RUNNING:'st-run',STARTING:'st-start',PENDING:'st-queue',QUEUED:'st-queue',PREPARING_DATA:'st-prep',SUBMITTING:'st-start',FAILED:'st-err',UNKNOWN:'st-unk',SUCCEEDED:'st-done',CANCELED:'st-stop',PREEMPTING:'st-cancel',PREEMPTED:'st-stop'}[job.state]||'st-unk';
}
export function stateWord(job){
  if(job.cancelRequested&&!endedJob(job))return '正在取消';
  if(job.state==='CANCELED'&&job.preempted===true)return '让位结束';
  return {RUNNING:'运行中',STARTING:'启动中',PENDING:'排队中',QUEUED:'排队中',PREPARING_DATA:'准备数据',SUBMITTING:'提交中',FAILED:'失败',UNKNOWN:'状态待核对',SUCCEEDED:'已完成',CANCELED:'已取消',PREEMPTING:'正在让位',PREEMPTED:'让位结束'}[job.state]||'状态未知';
}
export function stateHTML(job,word=true){return `<span class="st ${stateClass(job)}"><span class="g" aria-hidden="true"></span>${word?escapeUI(stateWord(job)):''}</span>`;}
export function trainingReadout(job){
  const p=job.progress,s=p?.snapshot,percent=progressPercent(p),fresh=p?.reported===true&&!!s&&!p.stale&&!p.error;
  let eta='';
  if(fresh&&Number.isFinite(s.etaSeconds)&&s.etaSeconds>=0){
    if(Number.isFinite(s.updatedAt)&&s.updatedAt>0){const date=new Date((s.updatedAt+s.etaSeconds)*1000);if(Number.isFinite(date.getTime()))eta='约 '+date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})+' · 训练上报';}
    else eta='训练上报剩余约 '+Math.ceil(s.etaSeconds/60)+' 分钟';
  }
  const rank=key=>({loss:0,val_acc:1,lr:2})[key]??3;
  const metrics=fresh?Object.entries(s.metrics||{}).filter(([key,value])=>Number.isFinite(value)&&!/^epochs?$/i.test(key)).sort(([a],[b])=>rank(a)-rank(b)).slice(0,3):[];
  const description=p?.stale?'进度停滞（训练上报超时）'+(s?.epochsTotal?` · 上次轮次 ${s.epochsCompleted}/${s.epochsTotal}`:'')+(s?.message?' · '+s.message:''):progressText(p);
  return {fresh,percent:fresh?percent:null,eta,epoch:fresh&&s.epochsTotal?`第 ${s.epochsCompleted} / ${s.epochsTotal} 轮`:'',metrics,description};
}
function shortTime(value){
  if(value===undefined||value===null||value==='')return '';
  const date=new Date(typeof value==='number'?value*1000:value);
  return Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'';
}
export function trajectoryHTML(job){
  const stages=[['提交','submit'],...(job.datasets?.length||job.state==='PREPARING_DATA'?[['准备数据','prepare']]:[]),['排队','queue'],['启动','start'],['运行','run'],['结束','end']];
  const key=endedJob(job)?'end':({PREPARING_DATA:'prepare',PENDING:'queue',QUEUED:'queue',STARTING:'start',RUNNING:'run',SUBMITTING:'submit'})[job.state];
  const current=stages.findIndex(([,value])=>value===key),times={submit:job.createdAt,run:job.latestAttempt?.startedAt,end:job.latestAttempt?.finishedAt};
  return `<ol class="tl wb-trajectory" aria-label="任务轨迹">${stages.map(([label,value],index)=>`<li class="${index===current?'now':current>=0&&index<current?'done':''}"><span class="d" aria-hidden="true"></span><span class="n">${label}</span>${shortTime(times[value])?`<time class="t">${escapeUI(shortTime(times[value]))}</time>`:''}</li>`).join('')}</ol>`;
}
export function jobFacts(job){
  const indices=job.assignedIndices?.length?'GPU '+job.assignedIndices.join(' · '):Number.isSafeInteger(job.cards)?job.cards+' 张':'卡数未确认';
  const allocation=job.elastic?`弹性 ${job.elastic.minCards}–${job.cards} 张 · 当前 ${Number.isSafeInteger(job.actualCards)?job.actualCards:job.assignedIndices?.length||'未确认'} 张`:indices;
  const placement=job.placement,placementText=placement?`${placement.shared?'共享':'固定'} GPU ${placement.gpuIndices.join(',')}${placement.shared?' · 预算 '+placement.vramMiB+' MiB':''}${placement.hami?' · HAMi SM '+placement.smPercent+'%':''}`:'';
  return [job.machine||'服务器未确认',allocation,placementText,job.state==='PREPARING_DATA'?'不占 GPU 额度':job.queueReason||job.latestAttempt?.failureReason||job.error||job.description||'暂无调度说明',job.latestAttempt?.exitCode!==null&&job.latestAttempt?.exitCode!==undefined?'退出码：'+job.latestAttempt.exitCode:'',job.schedulerState||job.state].filter(Boolean).map(escapeUI).join(' · ');
}
export function workbenchCards(jobs,{actions=()=>'',focusId,maintenance}={}){
  const active=jobs.filter(job=>!endedJob(job));
  const focal=active.find(job=>job.id===focusId&&job.state==='RUNNING'&&!job.cancelRequested)||active.find(job=>job.state==='RUNNING'&&!job.cancelRequested)||active.find(job=>job.id===focusId)||active.find(job=>job.state==='UNKNOWN')||[...jobs].reverse().find(job=>job.state==='FAILED')||active[0]||jobs.at(-1);
  const attention=jobs.filter(job=>job.state==='FAILED'&&job.id!==focal?.id),completed=jobs.filter(job=>endedJob(job)&&job.state!=='FAILED'&&job.id!==focal?.id);
  const heading=job=>`<div class="job-top"><div class="wb-job-heading">${stateHTML(job)}<button type="button" class="wb-job-name" data-job-detail="${escapeUI(job.id)}">${escapeUI(job.name||'训练')}</button></div><span class="mono wb-job-id">${escapeUI(job.id)}</span></div>`;
  const compact=job=>`<article class="job compact-job" data-workbench-job="${escapeUI(job.id)}">${heading(job)}<p class="subline">${jobFacts(job)}</p>${trajectoryHTML(job)}<div class="job-acts">${actions(job)}</div></article>`;
  let hero='';
  if(focal){
    const running=focal.state==='RUNNING'&&!focal.cancelRequested,readout=trainingReadout(focal);
    const label=['FAILED','UNKNOWN'].includes(focal.state)?'需要处理的训练':endedJob(focal)?'最近一次训练':'当前训练';
    hero=`<article class="job hero-frame wb-focal ${running?'':'wb-focus-state'}" data-workbench-job="${escapeUI(focal.id)}"><span class="hero-label">${label}</span>${heading(focal)}<p class="subline">${jobFacts(focal)}</p>${running?`<div class="wb-progress-hero"><div><span class="label">训练上报</span><div class="wb-progress-number ${readout.fresh?'':'unknown'}">${readout.percent===null?'—':readout.percent+'%'}</div></div><div class="wb-progress-meta">${readout.epoch?`<span>${escapeUI(readout.epoch)}</span>`:''}${readout.eta?`<span class="mono">${escapeUI(readout.eta)}</span>`:''}<span>${escapeUI(readout.fresh?'完成状态以调度器确认为准。':readout.description)}</span></div></div>${readout.percent===null?'':`<progress class="wb-progress-line" max="100" value="${readout.percent}" aria-label="${escapeUI(focal.name)} 的训练上报进度"></progress>`}`:''}${trajectoryHTML(focal)}${running&&readout.metrics.length?`<div class="wb-metrics">${readout.metrics.map(([key,value])=>`<div><span class="label">${escapeUI(key)}</span><strong class="mono">${escapeUI(Number(value).toPrecision(5))}</strong></div>`).join('')}</div>`:''}<div class="job-acts">${actions(focal)}</div></article>`;
  }
  const others=active.filter(job=>job.id!==focal?.id).sort((a,b)=>Number(['FAILED','UNKNOWN'].includes(b.state))-Number(['FAILED','UNKNOWN'].includes(a.state)));
  const list=(rows,label)=>`<div class="wb-scroll-list" tabindex="0" role="region" aria-label="${label}">${rows.map(compact).join('')}</div>`;
  return hero+(attention.length?`<details class="wb-attention" open><summary><span class="st st-err"><span class="g" aria-hidden="true"></span>需要处理 · ${attention.length} 项</span></summary>${list([...attention].reverse(),'需要处理的训练')}</details>`:'')+(others.length?`<div class="wb-list-title"><h2>其他进行中的训练</h2><span class="mono">${others.length} 项</span></div>`+list(others,'其他进行中的训练'):'')+(completed.length?`<details class="wb-ended"><summary>已结束的训练 · ${completed.length} 项</summary>${list([...completed].reverse(),'已结束的训练')}</details>`:'')+(!jobs.length&&maintenanceActive(maintenance)?'<section class="wb-empty hero-frame"><span class="hero-label">我的训练任务</span><h2>暂无训练任务</h2><p>维护不会自动停止运行任务；新任务等待管理员明确恢复。</p></section>':!jobs.length?'<section class="wb-empty hero-frame"><span class="hero-label">开始一次训练</span><h2>准备好下一次实验</h2><p>选择服务器与项目，准备代码和环境，再提交训练。</p><ol><li>选择获授权服务器</li><li>创建项目或使用个人工作区</li><li>上传代码，在开发终端安装环境</li><li>结束开发终端，生成训练版本</li><li>确认数据与卡数，提交训练</li></ol></section>':'');
}
export function jobOverviewHTML(job,{owned=true,schedulingHTML=''}={}){
  const readout=trainingReadout(job);
  const command=Array.isArray(job.command)?job.command:job.argv;
  return `<section class="job-overview"><div class="job-overview-fact">${stateHTML(job)}<span>${escapeUI(job.machine||'服务器未确认')}</span><span>${Number.isSafeInteger(job.cards)?job.cards+' 张':'卡数未确认'}</span></div><p>${escapeUI(job.description||'未填写描述')}</p><dl class="job-overview-grid"><div><dt>完整任务 ID</dt><dd><code>${escapeUI(job.id)}</code><button class="button quiet" type="button" data-copy-job="${escapeUI(job.id)}">复制 ID</button></dd></div>${job.project?`<div><dt>项目 / 训练版本</dt><dd>${escapeUI(job.project)}<code>${escapeUI(job.release||'版本未提供')}</code></dd></div>`:''}<div><dt>调度说明</dt><dd>${escapeUI(job.queueReason||'暂无调度说明')}</dd></div><div><dt>最近核对</dt><dd>${escapeUI(shortTime(job.schedulerCheckedAt||job.checkedAt)||'未提供')}</dd></div></dl>${trajectoryHTML(job)}<p class="muted">${escapeUI(readout.description)}</p>${owned&&command?.length?`<details class="job-command"><summary>训练命令</summary><pre>${escapeUI(command.join(' '))}</pre></details>`:''}${schedulingHTML?`<details class="job-command"><summary>卡数与调度策略</summary><div class="job-scheduling-facts">${schedulingHTML}</div></details>`:''}${job.latestAttempt?`<details class="job-command"><summary>最近运行记录</summary><dl><dt>运行 ID</dt><dd>${escapeUI(job.latestAttempt.id||'未记录')}</dd><dt>退出码</dt><dd>${escapeUI(job.latestAttempt.exitCode??'未记录')}</dd><dt>原因</dt><dd>${escapeUI(job.latestAttempt.failureReason||'未记录')}</dd></dl></details>`:''}<h3>主日志</h3><pre id="job-log-preview">正在读取主日志…</pre></section>`;
}
