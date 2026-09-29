// Owner-bound log/diagnostic viewer. Log evidence never rewrites task state.
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statusNames={STARTING:'正在启动采集',CAPTURING:'采集中',COMPLETE:'本轮快照已保存',PARTIAL:'部分可用',UNAVAILABLE:'没有可用采集'};
const shown=value=>value===null||value===undefined?'未知':String(value);
const timestamp=value=>{if(value===null||value===undefined||value==='')return '未记录';const date=new Date(typeof value==='number'?value*1000:value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'未记录';};
const bytes=value=>Number.isFinite(value)?(value/1024**3).toFixed(2)+' GiB':'未知';
export function diagnosticsHTML(bundle){
  const capture=bundle.captures?.[0],resources=capture?.resources||{},events=resources.counters?.['memory.events']||{},pids=resources.counters?.['pids.events']||{},peaks=resources.peaks||{};
  const logs=Array.isArray(capture?.logs)?capture.logs.slice(0,32):[],attempts=Array.isArray(bundle.attempts)?bundle.attempts.slice(0,16):[];
  return `<p class="diagnostic-summary"><strong>诊断：${esc(statusNames[bundle.state]||bundle.state||'未知')}</strong> · 调度状态：${esc(bundle.schedulerState||'UNKNOWN')}<br>${bundle.workerErrorEvidence?'检测到可能的 worker 错误线索（也可能来自正常退出日志），请结合退出码与调度状态查看。':'未发现已知错误特征，不代表所有 worker 健康。'} 日志线索不会自动判定任务失败。</p>
    <dl class="diagnostic-metrics"><div><dt>退出码 / 原因</dt><dd>${esc(shown(capture?.runnerExit?.exitCode))} / ${esc(capture?.unitExit?.Result||attempts[0]?.failure_reason||'未记录')}</dd></div><div><dt>内存${peaks['memory.peak']!==undefined?'内核峰值':'观测高水位'}</dt><dd>${esc(bytes(peaks['memory.peak']??peaks['memory.current']))}</dd></div><div><dt>进程 / 线程${peaks['pids.peak']!==undefined?'内核峰值':'观测高水位'}</dt><dd>${esc(shown(peaks['pids.peak']??peaks['pids.current']))}</dd></div><div><dt>OOM / OOM kill / PID 拒绝</dt><dd>${esc(shown(events.oom))} / ${esc(shown(events.oom_kill))} / ${esc(shown(pids.max))}</dd></div></dl>
    <p class="muted">${esc(capture?.error||bundle.note||'缺失数据为未知，不是零。')} 采集时间：${esc(timestamp(capture?.updatedAt))}。仅受管理 Ray 目录；自定义 /tmp 路径不在采集范围。分享前请检查尽力脱敏后的内容。</p>
    <h3>历史 GPU 分配</h3><p class="muted">以下为调度器各次运行记录；开始 / 结束时间不冒充精确设备分配 / 释放时刻。</p>
    <div class="diagnostic-history"><table><thead><tr><th>运行 / 状态</th><th>GPU index / UUID</th><th>开始 / 结束</th></tr></thead><tbody>${attempts.map(attempt=>`<tr><td>${esc(attempt.id)}<br>${esc(attempt.state||'未知')}</td><td>${esc((attempt.gpu_indices||[]).join(', ')||'未记录')}<br>${esc((attempt.gpu_uuids||[]).join('\n')||'未记录')}</td><td>${esc(timestamp(attempt.started_at))}<br>${esc(timestamp(attempt.finished_at))}</td></tr>`).join('')||'<tr><td colspan="3">尚无运行历史。</td></tr>'}</tbody></table></div>
    <h3>Worker / Ray 日志尾部</h3><p class="muted">最多 32 个白名单文件，每个最多 64 KiB；只呈现有限尾部，不保证覆盖所有错误。</p>${logs.map(item=>`<details class="diagnostic-log"><summary>${esc(item.source)}${item.truncated?' · 已截断':''}</summary><pre>${esc(item.text)}</pre></details>`).join('')||'<p class="muted">暂无受管理 worker 日志；旧任务或自定义临时目录可能没有留存。</p>'}`;
}

export function createJobDiagnostics(store,getDialog,toast){
  let generation=0,diagnosticsRequest=0,jobId=null,bundle=null,bundleIdentity=null,displayIdentity=null,view='logs',installed=false;
  const principal=()=>store.principal?`${store.principal.userId}:${store.principal.role}`:null;
  const element=selector=>getDialog()?.querySelector(selector);
  function reset(){generation++;diagnosticsRequest++;jobId=null;bundle=null;bundleIdentity=null;displayIdentity=null;view='logs';const dialog=getDialog();if(dialog){dialog.close();element('pre').textContent='';element('#job-diagnostic-view').innerHTML='';element('#job-view-status').textContent='';element('#job-diagnostic-download').disabled=true;}}
  function switchView(next){view=next;element('#job-main-log').hidden=next!=='logs';element('#job-diagnostic-view').hidden=next!=='diagnostics';element('#job-log-view').setAttribute('aria-pressed',String(next==='logs'));element('#job-diagnostic-open').setAttribute('aria-pressed',String(next==='diagnostics'));}
  async function loadDiagnostics(){
    const requested=jobId,identity=principal(),context=generation,request=++diagnosticsRequest;if(!requested||!identity)return;
    element('#job-view-status').textContent='正在读取持久诊断包…';element('#job-diagnostic-download').disabled=true;
    element('#job-diagnostic-view').textContent='正在读取诊断与历史分配…';switchView('diagnostics');bundle=null;bundleIdentity=null;
    try{
      const result=await store.call('jobs.diagnostics',{jobId:requested});
      if(generation!==context||diagnosticsRequest!==request||principal()!==identity||jobId!==requested)return;
      if(result?.jobId!==requested)throw Error('诊断包任务身份不匹配，未显示。');
      bundle=result;bundleIdentity=identity;element('#job-diagnostic-view').innerHTML=diagnosticsHTML(result);element('#job-diagnostic-download').disabled=false;element('#job-view-status').textContent='诊断已读取；不会因此更改任务状态。';
    }catch(error){if(generation===context&&diagnosticsRequest===request&&principal()===identity){bundle=null;element('#job-diagnostic-view').textContent='诊断暂不可用：'+error.message;element('#job-view-status').textContent='主日志仍可查看；未把采集失败当作训练结果。';toast(error.message);}}
  }
  function install(){
    if(installed)return;installed=true;const dialog=getDialog(),pre=element('pre');pre.id='job-main-log';
    if(!document.querySelector('#job-diagnostic-styles')){const style=document.createElement('link');style.id='job-diagnostic-styles';style.rel='stylesheet';style.href=new URL('./job-diagnostics.css',import.meta.url).href;document.head.append(style);}
    const tools=document.createElement('div');tools.className='diagnostic-tools';tools.innerHTML='<button class="button" id="job-log-view" aria-pressed="true">主日志</button><button class="button" id="job-diagnostic-open" aria-pressed="false">诊断包 / 历史分配</button><button class="button" id="job-diagnostic-download" disabled>下载诊断 JSON</button><p id="job-view-status" role="status" aria-live="polite"></p>';
    pre.before(tools);const body=document.createElement('section');body.id='job-diagnostic-view';body.hidden=true;pre.after(body);
    element('#job-log-view').addEventListener('click',()=>switchView('logs'));
    element('#job-diagnostic-open').addEventListener('click',loadDiagnostics);
    element('#job-diagnostic-download').addEventListener('click',()=>{
      if(!bundle||bundle.jobId!==jobId||principal()!==bundleIdentity)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='gpuq-diagnostics-'+jobId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    dialog.addEventListener('close',()=>{if(dialog.open)return;generation++;diagnosticsRequest++;bundle=null;bundleIdentity=null;displayIdentity=null;jobId=null;pre.textContent='';body.innerHTML='';element('#job-diagnostic-download').disabled=true;});
  }
  async function openLogs(id){
    install();const identity=principal(),request=++generation;diagnosticsRequest++;displayIdentity=identity;jobId=id;bundle=null;bundleIdentity=null;element('#job-diagnostic-download').disabled=true;element('#job-diagnostic-view').innerHTML='';switchView('logs');element('#job-main-log').textContent='正在读取主日志…';element('#job-view-status').textContent='诊断包中可查看 worker 错误、资源事件和历史分配。';
    const dialog=getDialog();if(!dialog.open)dialog.showModal();
    try{const result=await store.call('jobs.logs',{jobId:id});if(generation===request&&principal()===identity&&jobId===id)element('#job-main-log').textContent=result.text;}
    catch(error){if(generation===request&&principal()===identity&&jobId===id){element('#job-main-log').textContent='主日志暂不可用：'+error.message;toast(error.message);}}
  }
  return {install,openLogs,reset,sync(){if(displayIdentity!==null&&displayIdentity!==principal())reset();}};
}
