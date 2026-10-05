import {priorityLabel,sampleTime,taskIdentityHTML,taskStateLabel} from './execution-ui.js';
import {revealSheet,dismissSheet,reducedMotion} from './motion-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const known=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const metric=(value,suffix='',digits=0)=>known(value)?`${value.toFixed(digits)}${suffix}`:'—';
const gib=value=>metric(known(value)?value/1024:null,'',1);
const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'暂无采集时间';
function bar(value,max,label){return known(value)&&known(max)&&max>0?`<progress class="gpu-meter" max="${max}" value="${Math.min(value,max)}" aria-label="${esc(label)}"></progress>`:'';}
function processPriority(process,admin){
  const s=process.scheduling;
  if(!s||!Number.isInteger(s.priority)||s.priority<0||s.priority>4)return '<span class="muted">未确认 / 未纳管</span>';
  return `${esc(priorityLabel(s.priority))}${admin&&s.jobId?`<small>${esc(s.jobId)}</small>`:''}`;
}
function processList(gpu,admin,key){
  const list=Array.isArray(gpu.processes)?gpu.processes:[],available=gpu.processesAvailable===true&&Array.isArray(gpu.processes);
  return `<details class="gpu-processes" data-resource-detail="${esc(key)}"><summary>${available?`${list.length} 个计算进程`:list.length?`${list.length} 个 · 列表不完整`:'采集不可用'}</summary><div class="process-content">${gpu.processesError?'<p class="monitor-warning">部分进程信息未采集到，不代表没有占用。</p>':''}${!list.length?`<p class="muted">${available?'当前未检测到 CUDA 计算进程，任务启动仍需调度。':'等待下一次成功采集。'}</p>`:`<table class="process-table"><thead><tr><th>PID</th><th>任务 / 提交者 / 描述</th>${admin?'<th>程序</th><th>系统用户</th>':''}<th>显存 MiB</th><th>调度优先级</th></tr></thead><tbody>${list.map(p=>`<tr><td>${esc(p.pid)}</td><td>${p.task?taskIdentityHTML(p.task):'<span class="muted">外部进程／未确认归属</span>'}</td>${admin?`<td>${esc(p.name||'—')}</td><td>${esc(p.owner||'—')}</td>`:''}<td>${metric(p.memoryUsedMiB)}</td><td>${processPriority(p,admin)}</td></tr>`).join('')}</tbody></table><p class="muted">平台任务只在节点确认进程所属任务后显示提交信息；不按卡号猜归属。外部或未关联任务不推断提交者。</p>`}</div></details>`;
}
function gpuTable(host,admin,machine){
  if(!host.gpus?.length)return '<div class="monitor-empty">逐卡状态暂不可用，请稍后刷新。</div>';
  return `<div class="gpu-table-scroll"><table class="gpu-table"><caption class="sr-only">${esc(machine.id)} 每张 GPU 的使用量与计算进程</caption><thead><tr><th>GPU</th><th>利用率</th><th>显存 GiB</th><th>温度 / 功耗</th><th>计算进程</th></tr></thead><tbody>${host.gpus.map(g=>`<tr data-gpu-index="${g.index}"><th scope="row"><span class="gpu-index">#${g.index}</span><small>${esc(g.model||machine.model)}</small></th><td><strong>${metric(g.utilization,'%')}</strong>${bar(g.utilization,100,'GPU 利用率')}</td><td><strong>${gib(g.memoryUsedMiB)} <span class="muted">/ ${gib(g.memoryTotalMiB)}</span></strong>${bar(g.memoryUsedMiB,g.memoryTotalMiB,'显存使用量')}</td><td>${metric(g.temperatureC,' °C')}<small>${metric(g.powerDrawW,' W')} / ${metric(g.powerLimitW,' W')}</small></td><td>${processList(g,admin,`${machine.id}:${g.index}`)}</td></tr>`).join('')}</tbody></table></div>`;
}
function queue(host,machine,checkedAt){
  if(Array.isArray(host.tasks))return taskQueue(host.tasks,machine,checkedAt);
  const jobs=host.gpuq?.jobs||[];
  return `<details class="node-queue" data-resource-detail="${esc(machine.id)}:queue"><summary>GPUQ 排队记录 · 本次采集 ${jobs.length} 条</summary><p class="muted">最近 100 条调度记录，只读。P0–P4 为服务器原始档位；当前占用请看上方逐卡指标。</p>${jobs.length?`<div class="gpu-table-scroll"><table class="process-table"><thead><tr><th>任务 / 用户</th><th>状态 / 优先级</th><th>调度说明</th><th>分配 GPU</th></tr></thead><tbody>${jobs.map(j=>`<tr><td>${esc(j.name||j.id)}<small>${esc(j.owner||'—')} · ${esc(j.id||'')}</small></td><td>${esc(j.state)}<small>${esc(priorityLabel(j.priority))}</small><small>让位策略：${esc(({never:'不自动中断',now:'允许直接中断',save:'保存后让位',legacy:'旧策略'})[j.yield_policy]||'未提供')}</small></td><td class="queue-reason">${esc(j.state_reason||'节点未提供说明')}<small>${j.updated_at?'状态更新时间':'采集时间'}：${esc(sampleTime(j.updated_at||checkedAt))}</small></td><td>${esc(Array.isArray(j.assigned_gpu_indices)&&j.assigned_gpu_indices.length?j.assigned_gpu_indices.join(', '):'—')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">本次未返回队列记录。</p>'}</details>`;
}
function taskQueue(tasks,machine,checkedAt){
  return `<details class="node-queue" data-resource-detail="${esc(machine.id)}:queue"><summary>任务队列与近期记录 · ${tasks.length} 条</summary><p class="muted">姓名、任务名和自行填写的描述对同机器授权成员可见；不开放训练命令、日志或他人任务操作。未关联平台的 GPUQ 记录单独标记。分配记录不代替当前 CUDA 进程证据。</p>${tasks.length?`<div class="gpu-table-scroll"><table class="process-table"><thead><tr><th>任务 / 提交者 / 描述</th><th>状态 / 优先级</th><th>分配 GPU</th><th>核对时间</th></tr></thead><tbody>${tasks.map(t=>`<tr><td>${taskIdentityHTML(t)}</td><td>${esc(taskStateLabel(t))}<small>${esc(priorityLabel(t.priority))}</small>${t.schedulerState&&t.schedulerState!==t.state?`<small>节点原始状态：${esc(t.schedulerState)}</small>`:''}</td><td>${esc(t.assignedGpuIndices?.length?t.assignedGpuIndices.join(', '):'—')}</td><td>${esc(sampleTime(t.updatedAt||checkedAt))}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">本次没有返回任务记录。</p>'}</details>`;
}
// Monitoring, process evidence and scheduler admission are independent. A
// measured memory level never proves that the scheduler can start a task.
export function resourceServerView(machine,{limits={},snapshot,admin=false,production=false}={}){
  const quota=known(limits[machine.id])?limits[machine.id]:0,authorized=admin||quota>0;
  const hosts=(snapshot?.hosts||[]).filter(host=>host.id===machine.id),host=hosts.length===1?hosts[0]:null;
  const fresh=authorized&&production===true&&snapshot?.stale===false&&host?.reachable===true;
  const count=Number.isSafeInteger(machine.cards)&&machine.cards>0&&machine.cards<=64?machine.cards:0;
  const raw=Array.isArray(host?.gpus)?host.gpus:[];
  const validInventory=count>0&&raw.every(gpu=>gpu&&Number.isSafeInteger(gpu.index)&&gpu.index>=0&&gpu.index<count)&&new Set(raw.map(gpu=>gpu.index)).size===raw.length;
  const gpus=fresh&&validInventory?[...raw].sort((a,b)=>a.index-b.index):[];
  const complete=validInventory&&gpus.length===count;
  const processesComplete=complete&&gpus.every(gpu=>gpu.processesAvailable===true&&Array.isArray(gpu.processes));
  const busy=processesComplete?gpus.filter(gpu=>gpu.processes.length>0).length:null;
  const status=!authorized?'未授权查看监控':!production?'本地演示，无真实采集':snapshot?.stale===true?'采集已过期':!fresh?'暂时无法采集':host.gpuq?.observeOnly===true?'仅观察':'监控在线';
  return {machine,quota,authorized,host,fresh,count,gpus,complete,validInventory,processesComplete,busy,status,checkedAt:host?.checkedAt||snapshot?.checkedAt};
}
function gpuLevel(gpu){return gpu&&known(gpu.memoryUsedMiB)&&known(gpu.memoryTotalMiB)&&gpu.memoryTotalMiB>0&&gpu.memoryUsedMiB<=gpu.memoryTotalMiB?gpu.memoryUsedMiB/gpu.memoryTotalMiB*100:null;}
function processEvidence(gpu,view){
  const list=Array.isArray(gpu?.processes)?gpu.processes:[];
  return list.length?`${list.length} 个已采集计算进程`:view.complete&&gpu?.processesAvailable===true&&Array.isArray(gpu.processes)?'未检测到计算进程':'计算进程占用未确认';
}
function cardState(gpu,view,mine){
  if(!view.authorized)return 'locked';
  if(!view.fresh||!view.complete||gpu?.processesAvailable!==true||!Array.isArray(gpu.processes)||gpuLevel(gpu)===null)return 'unknown';
  if(!gpu.processes.length)return 'free';
  return gpu.processes.every(process=>process.task&&mine.has(process.task.id))?'mine':'used';
}
function gpuTaskSummary(tasks,mine,gpu,view){
  if(!tasks.length)return processEvidence(gpu,view);
  const task=tasks[0],submitter=task.submitter?.name||task.submitter?.username||'未知提交者';
  return `<strong title="${esc(task.name)}">${esc(task.name)}</strong><span title="${esc(submitter)}">${esc(submitter)}${mine.has(task.id)?' · 我':''}</span>${tasks.length>1?`<span>另 ${tasks.length-1} 个任务 · 详见进程</span>`:''}`;
}
function towers(view,mine){
  const byIndex=new Map(view.gpus.map(gpu=>[gpu.index,gpu]));
  return `<div class="resource-towers" data-resource-towers="${esc(view.machine.id)}" data-resource-card-count="${view.count}" role="group" aria-label="${esc(view.machine.id)} 每张显卡的显存采集">${Array.from({length:view.count},(_,index)=>{
    const gpu=byIndex.get(index),state=cardState(gpu,view,mine),level=gpuLevel(gpu);
    const label=!view.authorized?'未授权查看':!gpu?'占用未确认':`显存 ${gib(gpu.memoryUsedMiB)} / ${gib(gpu.memoryTotalMiB)} GiB · 利用率 ${metric(gpu.utilization,'%')} · ${processEvidence(gpu,view)}`;
    return `<span class="resource-tower"><span class="resource-tower-index">${index}</span><span class="resource-tower-bar ${state}" role="img" aria-label="GPU ${index} · ${esc(label)}" title="GPU ${index} · ${esc(label)}">${level===null?'':`<i class="resource-fill" data-resource-level="${level}" data-resource-sample="${esc(view.checkedAt)}" data-resource-fill-key="${esc(view.machine.id)}:${index}" data-resource-confirmed="${state!=='unknown'}" aria-hidden="true"></i>`}</span></span>`;
  }).join('')}${view.authorized?'':'<span class="resource-tower-lock-label" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>未授权查看</span>'}</div>`;
}
function gpuTiles(view,mine){
  const byIndex=new Map(view.gpus.map(gpu=>[gpu.index,gpu]));
  return `<div class="resource-gpus" aria-label="${esc(view.machine.id)} 逐卡指标">${Array.from({length:view.count},(_,index)=>{
    const gpu=byIndex.get(index),level=gpuLevel(gpu),state=cardState(gpu,view,mine),tasks=[...new Map((Array.isArray(gpu?.processes)?gpu.processes:[]).filter(p=>p.task).map(p=>[p.task.id,p.task])).values()];
    return `<article class="resource-gpu ${state}" data-resource-gpu="${index}" tabindex="-1"><div class="resource-gpu-head"><span>GPU ${index}</span><span>${metric(gpu?.temperatureC,' °C')}</span></div><div class="resource-gpu-util" ${known(gpu?.utilization)&&state!=='unknown'?`data-resource-reading="${gpu.utilization}" data-resource-reading-key="${esc(view.machine.id)}:${index}" data-resource-sample="${esc(view.checkedAt)}"`:''}>${metric(gpu?.utilization,'%')}</div><p class="resource-gpu-memory">${gib(gpu?.memoryUsedMiB)} / ${gib(gpu?.memoryTotalMiB)} GiB</p>${level===null?'':`<progress class="resource-memory-meter" value="${level}" max="100" aria-label="GPU ${index} 显存使用量"></progress>`}<div class="resource-gpu-owner">${gpuTaskSummary(tasks,mine,gpu,view)}</div><p class="resource-gpu-power">${metric(gpu?.powerDrawW,' W')} / ${metric(gpu?.powerLimitW,' W')}</p></article>`;
  }).join('')}</div>`;
}
function allProcesses(view,admin){
  const rows=view.gpus.flatMap(gpu=>(Array.isArray(gpu.processes)?gpu.processes:[]).map(process=>({gpu,process})));
  const label=view.processesComplete?`${rows.length} 个计算进程`:`${rows.length} 个已采集进程 · 列表不完整`;
  return `<details class="resource-process-list" data-resource-detail="${esc(view.machine.id)}:processes" open><summary>计算进程 · ${label}<span>${admin?'程序与系统用户仅管理员可见':'同机器任务信息；不开放他人日志或操作'}</span></summary><div class="resource-process-scroll" tabindex="0" role="region" aria-label="${esc(view.machine.id)} 已采集计算进程">${rows.length?`<table class="process-table resource-process-table"><caption class="sr-only">${esc(view.machine.id)} 计算进程；程序与系统用户只向管理员展示</caption><thead><tr><th>GPU</th><th>PID</th><th>任务 / 提交者 / 描述</th>${admin?'<th>程序</th><th>系统用户</th>':''}<th>显存 MiB</th><th>调度优先级</th></tr></thead><tbody>${rows.map(({gpu,process:p})=>`<tr><td>${gpu.index}</td><td>${esc(p.pid)}</td><td>${p.task?taskIdentityHTML(p.task):'<span class="muted">外部进程／未确认归属</span>'}</td>${admin?`<td>${esc(p.name||'—')}</td><td>${esc(p.owner||'—')}</td>`:''}<td>${metric(p.memoryUsedMiB)}</td><td>${processPriority(p,admin)}</td></tr>`).join('')}</tbody></table>`:`<p class="muted">${view.processesComplete?'当前未检测到 CUDA 计算进程，任务启动仍需调度。':'进程采集未确认，不代表没有占用。'}</p>`}</div></details>`;
}
function selectedDetail(view,{admin,mine,production}){
  const m=view.machine,h=view.host;
  const content=!view.authorized?'<div class="monitor-empty">管理员分配此机器后，可查看逐卡占用并使用个人工作区。</div>':!production?'<div class="monitor-empty">本地演示，无真实采集。部署接通只读采集器后显示真实显存和计算进程。</div>':!view.fresh?'<div class="monitor-empty monitor-warning">当前状态未知，不代表 GPU 空闲。请稍后刷新或联系管理员检查采集服务。</div>':`${!view.validInventory?'<p class="monitor-warning">显卡编号重复或超出物理容量，逐卡状态未确认。</p>':!view.complete?`<p class="monitor-warning">采集到 ${view.gpus.length} / ${view.count} 张卡，请核对缺失的卡；完整占用未确认。</p>`:h.gpuError?'<p class="monitor-warning">部分 GPU 指标不可用。</p>':''}${gpuTiles(view,mine)}${allProcesses(view,admin)}<details class="resource-full-metrics" data-resource-detail="${esc(m.id)}:metrics"><summary>完整指标与逐卡进程<span>利用率 · 显存 · 温度 · 功耗 · 进程</span></summary>${gpuTable({...h,gpus:view.gpus},admin,m)}</details>`;
  const showQueue=view.authorized&&production&&(Array.isArray(h?.tasks)||admin&&view.fresh&&h?.gpuq?.connected);
  const scheduler=!view.authorized||!production?'':!view.fresh?'调度状态未确认':h.gpuq?.observeOnly?'仅观察模式 · 不接受新训练':h.gpuq?.connected!==true?'调度器不可用':h.gpuq.health==='ok'?'调度器已连接 · 启动仍由调度决定':'调度状态未确认';
  return `<section class="resource-detail" data-resource-selected="${esc(m.id)}" aria-labelledby="resource-selected-title"><header class="resource-detail-head"><div><span class="label">所选服务器</span><h2 id="resource-selected-title">${esc(m.id)}</h2><p class="resource-spec">${m.cards} × ${esc(m.model)} · ${esc(m.memory)} / 卡</p></div><div class="resource-detail-facts"><span class="st ${view.fresh?h.gpuq?.observeOnly?'resource-observe':'st-run':'st-unk'}"><i class="g" aria-hidden="true"></i>${view.status}</span><p>${view.fresh?'采集 '+time(view.checkedAt):'未知不代表空闲'}</p><p>${esc(scheduler)}</p></div></header><div class="resource-policy"><span>${admin?'管理员访问全部机器':`我的并发上限 <strong>${view.quota} 张</strong>`}</span><span>物理容量 <strong>${m.cards} 张</strong></span>${view.authorized?`<button type="button" class="button quiet" data-use-machine="${esc(m.id)}">在 ${esc(m.id)} 工作</button>`:''}${admin?`<button type="button" class="button quiet" data-resource-root="${esc(m.id)}">ROOT 运维入口</button>`:''}</div>${content}${showQueue?`${!view.fresh?'<p class="monitor-warning">以下是平台记录与上次核对状态，不代表当前空闲或任务已结束。</p>':''}${queue(h,m,view.checkedAt)}`:''}</section>`;
}
export function resourceCards({machines=[],limits={},snapshot,admin=false,production=false,selectedMachine,userId,jobs=[],usage}={}){
  const views=machines.map(machine=>resourceServerView(machine,{limits,snapshot,admin,production}));
  const selected=views.find(view=>view.machine.id===selectedMachine)||views.find(view=>view.authorized)||views[0];
  const mine=new Set(jobs.filter(job=>userId&&job.userId===userId).map(job=>job.id));
  return `<div class="resource-legend" aria-label="显卡状态图例"><span><i class="mine" aria-hidden="true"></i>我的任务</span><span><i class="used" aria-hidden="true"></i>有进程</span><span><i class="free" aria-hidden="true"></i>未检测到进程</span><span><i class="unknown" aria-hidden="true"></i>未知</span><span><i class="locked" aria-hidden="true"></i>未授权</span></div><section class="resource-fleet hero-frame" aria-label="服务器阵列"><span class="hero-label">服务器阵列 · 柱高 = 已用显存 / 每卡总量</span>${views.map(view=>{
    const m=view.machine,chosen=view===selected,used=typeof usage==='function'?usage(m.id):null;
    return `<article class="resource-card fleet-server ${chosen?'selected':''}" data-resource-machine="${esc(m.id)}" data-resource-card-count="${view.count}"><div class="resource-top"><span class="resource-fleet-state ${view.fresh?'':'faint'}">${view.status}</span><h2><button type="button" class="resource-select" data-resource-select="${esc(m.id)}" aria-pressed="${chosen}" aria-label="查看 ${esc(m.id)} 逐卡详情">${esc(m.id)}</button></h2></div>${towers(view,mine)}<div class="resource-fleet-quota">${admin?'管理员可访问':`我的额度 <b>${known(used)?used:'—'} / ${view.quota}</b><small>已占 / 上限 · 张</small>`}</div><p class="resource-spec">${m.cards} × ${esc(m.model)} · ${esc(m.memory)}</p><p class="resource-fleet-evidence">${!view.authorized?'未授权查看':view.busy===null?'计算进程占用未确认':`${view.busy} / ${m.cards} 张有计算进程`}</p><div class="resource-fleet-actions"><button type="button" class="button quiet" data-resource-select="${esc(m.id)}">逐卡 · 进程 · 记录</button><button type="button" class="button quiet" data-use-machine="${esc(m.id)}" ${view.authorized?'':'disabled'}>进入工作台</button></div></article>`;
  }).join('')}</section>${selected?selectedDetail(selected,{admin,mine,production}):'<div class="monitor-empty">尚无服务器容量配置，请联系管理员核对。</div>'}`;
}
export function monitorSummary(snapshot,production){
  if(!production)return '演示界面 · 不连接实际 GPU';
  if(!snapshot?.checkedAt)return '尚无监控数据，请稍后刷新';
  return `${snapshot.stale?'监控已过期，请检查采集服务':'最近采集'}：${time(snapshot.checkedAt)} · 页面每 15 秒同步，节点约每分钟采样`;
}

export function resourcesUI(store,{machines,getPage,navigate}){
  const grid=document.querySelector('#machine-grid'),phone=()=>matchMedia('(max-width:759px)').matches;
  const primary=document.createElement('button');primary.id='resource-primary';primary.type='button';primary.className='button primary';primary.hidden=true;document.querySelector('.heading-actions').prepend(primary);
  const sheet=document.createElement('dialog');sheet.className='work-sheet resource-sheet';sheet.id='resource-sheet';sheet.setAttribute('aria-labelledby','resource-sheet-title');
  sheet.innerHTML='<header class="sheet-header glass"><h2 id="resource-sheet-title">服务器详情</h2><button type="button" class="button quiet" data-resource-back>返回算力</button></header><div class="sheet-scroll"></div><footer class="sheet-footer glass"><button type="button" class="button primary" id="resource-sheet-work"></button></footer>';
  document.body.append(sheet);
  let actor=null,selected=null,levels=new Map(),readings=new Map();const expanded=new Map();
  const identity=()=>store.principal?store.principal.userId+'|'+store.principal.role:null;
  function restoreDetail(){const detail=sheet.querySelector('.resource-detail');if(detail)grid.append(detail);}
  function close(animate=true){
    if(!sheet.open)return;
    if(animate)dismissSheet(sheet,{drilldown:true});else sheet.close();
    restoreDetail();grid.querySelector(`[data-resource-select="${CSS.escape(selected||'')}"]`)?.focus({preventScroll:true});
  }
  function updatePrimary(button,view){
    delete button.dataset.useMachine;delete button.dataset.resourceContact;
    if(view?.authorized){button.dataset.useMachine=view.machine.id;button.textContent='在 '+view.machine.id+' 工作';}
    else{button.dataset.resourceContact='true';button.textContent='去协作区联系管理员';}
  }
  function applyMeasurements(){
    const nextLevels=new Map(),nextReadings=new Map(),visible=getPage()==='resources'&&!document.hidden;
    for(const root of [grid,sheet]){
      for(const towers of root.querySelectorAll('[data-resource-card-count]'))towers.style.setProperty('--gpu-count',String(Number(towers.dataset.resourceCardCount)||1));
      for(const fill of root.querySelectorAll('[data-resource-level]')){
        const value=Number(fill.dataset.resourceLevel),key=fill.dataset.resourceFillKey,sample=fill.dataset.resourceSample,confirmed=fill.dataset.resourceConfirmed==='true',previous=levels.get(key);
        fill.style.height=value+'%';nextLevels.set(key,{value,sample,confirmed});
        if(visible&&fill.getClientRects().length&&confirmed&&previous?.confirmed&&Number.isFinite(Date.parse(sample))&&sample!==previous.sample&&value!==previous.value)fill.animate(reducedMotion()?[{opacity:.6},{opacity:1}]:[{height:previous.value+'%'},{height:value+'%'}],{duration:reducedMotion()?150:480,easing:'cubic-bezier(.2,0,0,1)'});
      }
      for(const readout of root.querySelectorAll('[data-resource-reading]')){
        const value=Number(readout.dataset.resourceReading),key=readout.dataset.resourceReadingKey,sample=readout.dataset.resourceSample,previous=readings.get(key);nextReadings.set(key,{value,sample});
        if(visible&&readout.getClientRects().length&&previous&&Number.isFinite(Date.parse(sample))&&sample!==previous.sample&&value!==previous.value)readout.animate(reducedMotion()?[{opacity:.6},{opacity:1}]:[{opacity:.6,transform:`translateY(${value>previous.value?3:-3}px)`},{opacity:1,transform:'none'}],{duration:reducedMotion()?150:220,easing:'cubic-bezier(.2,0,0,1)'});
      }
    }
    levels=nextLevels;readings=nextReadings;
  }
  function render(){
    if(actor!==identity()){actor=identity();selected=null;levels.clear();readings.clear();expanded.clear();close(false);}
    if(sheet.open&&(!phone()||getPage()!=='resources'))close(false);
    const focused=document.activeElement,focusDetail=focused?.closest('details[data-resource-detail]')?.dataset.resourceDetail,focusSelect=focused?.dataset.resourceSelect,scrollPositions=new Map();
    for(const root of [grid,sheet])for(const region of root.querySelectorAll('.resource-process-scroll,.gpu-table-scroll,.process-content')){
      const key=region.closest('[data-resource-detail]')?.dataset.resourceDetail;
      if(key)scrollPositions.set(key,{top:region.scrollTop,left:region.scrollLeft});
    }
    for(const root of [grid,sheet])for(const detail of root.querySelectorAll('details[data-resource-detail]'))expanded.set(detail.dataset.resourceDetail,detail.open);
    const user=store.users.find(row=>row.id===store.principal?.userId),admin=store.principal?.role==='admin',options={limits:user?.limits||{},snapshot:store.data?.gpuq,admin,production:store.production};
    const views=machines.map(machine=>resourceServerView(machine,options));
    if(!views.some(view=>view.machine.id===selected))selected=(views.find(view=>view.authorized)||views[0])?.machine.id||null;
    const view=views.find(view=>view.machine.id===selected);
    grid.innerHTML=resourceCards({machines,...options,selectedMachine:selected,userId:store.principal?.userId,jobs:store.jobs,usage:id=>user?store.usage(user.id,id):null});
    if(sheet.open){sheet.querySelector('.sheet-scroll').replaceChildren(grid.querySelector('.resource-detail'));sheet.querySelector('#resource-sheet-title').textContent=selected;}
    primary.hidden=!store.principal||getPage()!=='resources';updatePrimary(primary,view);updatePrimary(sheet.querySelector('#resource-sheet-work'),view);
    for(const root of [grid,sheet])for(const detail of root.querySelectorAll('details[data-resource-detail]')){if(expanded.has(detail.dataset.resourceDetail))detail.open=expanded.get(detail.dataset.resourceDetail);if(focusDetail===detail.dataset.resourceDetail)detail.querySelector('summary')?.focus({preventScroll:true});}
    for(const root of [grid,sheet])for(const region of root.querySelectorAll('.resource-process-scroll,.gpu-table-scroll,.process-content')){
      const previous=scrollPositions.get(region.closest('[data-resource-detail]')?.dataset.resourceDetail);
      if(previous){region.scrollTop=previous.top;region.scrollLeft=previous.left;}
    }
    if(focusSelect)grid.querySelector(`[data-resource-select="${CSS.escape(focusSelect)}"]`)?.focus({preventScroll:true});
    applyMeasurements();
  }
  function select(id,drilldown=true){
    if(!store.principal||!machines.some(machine=>machine.id===id))return;
    selected=id;render();
    if(phone()&&drilldown&&!sheet.open){
      sheet.querySelector('.sheet-scroll').replaceChildren(grid.querySelector('.resource-detail'));sheet.querySelector('#resource-sheet-title').textContent=id;
      sheet.querySelector('.sheet-scroll').scrollTop=0;
      // A new foreground action replaces an unfinished visual-only exit.
      for(const ghost of document.querySelectorAll('.object-transition-layer'))ghost.remove();
      sheet.showModal();revealSheet(sheet,{drilldown:true});sheet.querySelector('[data-resource-back]').focus({preventScroll:true});
    }else if(!phone()&&drilldown){
      const detail=grid.querySelector('.resource-detail');detail?.scrollIntoView({block:'start',behavior:'instant'});
      const heading=detail?.querySelector('h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
    }
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.resourceSelect)select(button.dataset.resourceSelect);
    if(button.dataset.resourceContact)navigate('community');
    if(button.hasAttribute('data-resource-back'))close();
    if(button.dataset.resourceRoot&&store.principal?.role==='admin'){
      const id=button.dataset.resourceRoot;grid.querySelector(`[data-resource-machine="${CSS.escape(id)}"] [data-use-machine]`)?.click();
      if(getPage()==='work'&&document.querySelector('[name=workspace-machine]')?.value===id){const panel=document.querySelector('#host-maintenance');if(panel){panel.open=true;panel.scrollIntoView({block:'center',behavior:'instant'});panel.querySelector('#terminal-root-open')?.focus();}}
    }
  });
  sheet.addEventListener('cancel',event=>{event.preventDefault();close();});sheet.addEventListener('click',event=>{if(event.target===sheet)close();});
  document.addEventListener('gpuq-open-resource',event=>{if(event.detail?.userId!==store.principal?.userId||getPage()!=='resources')return;select(event.detail.machine);});
  store.onAuthChange(()=>{close(false);sheet.querySelector('.sheet-scroll').replaceChildren();grid.replaceChildren();primary.hidden=true;actor=null;selected=null;levels.clear();readings.clear();expanded.clear();});
  addEventListener('resize',()=>{if(sheet.open&&!phone())close(false);});
  return render;
}
