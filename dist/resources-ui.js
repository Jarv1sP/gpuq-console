const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const known=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const metric=(value,suffix='',digits=0)=>known(value)?`${value.toFixed(digits)}${suffix}`:'—';
const gib=value=>metric(known(value)?value/1024:null,'',1);
const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'暂无采集时间';
function bar(value,max,label){return known(value)&&known(max)&&max>0?`<progress class="gpu-meter" max="${max}" value="${Math.min(value,max)}" aria-label="${esc(label)}"></progress>`:'';}
function processList(gpu,admin,key){
  const list=gpu.processes||[],available=gpu.processesAvailable===true;
  return `<details class="gpu-processes" data-resource-detail="${esc(key)}"><summary>${available?`${list.length} 个计算进程`:list.length?`${list.length} 个 · 列表不完整`:'采集不可用'}</summary><div class="process-content">${gpu.processesError?'<p class="monitor-warning">部分进程信息未采集到，不代表没有占用。</p>':''}${!list.length?`<p class="muted">${available?'当前未检测到 CUDA 计算进程；这不等于可以立即调度，也不包含图形进程。':'等待下一次成功采集。'}</p>`:`<table class="process-table"><thead><tr><th>PID</th>${admin?'<th>程序</th><th>系统用户</th>':''}<th>显存 MiB</th></tr></thead><tbody>${list.map(p=>`<tr><td>${esc(p.pid)}</td>${admin?`<td>${esc(p.name||'—')}</td><td>${esc(p.owner||'—')}</td>`:''}<td>${metric(p.memoryUsedMiB)}</td></tr>`).join('')}</tbody></table>`}${!admin?'<p class="muted">共享占用匿名显示，不暴露他人的用户名、命令或项目。</p>':''}</div></details>`;
}
function gpuTable(host,admin,machine){
  if(!host.gpus?.length)return '<div class="monitor-empty">没有可用的逐卡采集结果。此处不会把未知状态显示成空闲。</div>';
  return `<div class="gpu-table-scroll"><table class="gpu-table"><caption class="sr-only">${esc(machine.id)} 每张 GPU 的使用量与计算进程</caption><thead><tr><th>GPU</th><th>利用率</th><th>显存 GiB</th><th>温度 / 功耗</th><th>计算进程</th></tr></thead><tbody>${host.gpus.map(g=>`<tr data-gpu-index="${g.index}"><th scope="row"><span class="gpu-index">#${g.index}</span><small>${esc(g.model||machine.model)}</small></th><td><strong>${metric(g.utilization,'%')}</strong>${bar(g.utilization,100,'GPU 利用率')}</td><td><strong>${gib(g.memoryUsedMiB)} <span class="muted">/ ${gib(g.memoryTotalMiB)}</span></strong>${bar(g.memoryUsedMiB,g.memoryTotalMiB,'显存使用量')}</td><td>${metric(g.temperatureC,' °C')}<small>${metric(g.powerDrawW,' W')} / ${metric(g.powerLimitW,' W')}</small></td><td>${processList(g,admin,`${machine.id}:${g.index}`)}</td></tr>`).join('')}</tbody></table></div>`;
}
function queue(host,machine){
  const jobs=host.gpuq?.jobs||[];
  return `<details class="node-queue" data-resource-detail="${esc(machine.id)}:queue"><summary>原 GPUQ 队列 · 本次采集 ${jobs.length} 条</summary><p class="muted">包含旧 GPUQ 作业，最多显示最近 100 条；与操作系统中的实际进程是两种视角。</p>${jobs.length?`<div class="gpu-table-scroll"><table class="process-table"><thead><tr><th>任务</th><th>用户</th><th>状态</th><th>分配 GPU</th></tr></thead><tbody>${jobs.map(j=>`<tr><td>${esc(j.name||j.id)}</td><td>${esc(j.owner||'—')}</td><td>${esc(j.state)}</td><td>${esc(Array.isArray(j.assigned_gpu_indices)?j.assigned_gpu_indices.join(', '):'—')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">本次未返回队列记录。</p>'}</details>`;
}
export function resourceCards({machines,limits={},snapshot,admin=false,production=false}){
  const live=new Map((snapshot?.hosts||[]).map(h=>[h.id,h]));
  return machines.map(m=>{
    const max=limits[m.id]||0,authorized=admin||max>0,h=live.get(m.id),fresh=!snapshot?.stale&&h?.reachable;
    const status=!authorized?'未授权查看监控':!production?'本地演示，无真实采集':snapshot?.stale?'采集已过期':h?.reachable?'监控在线':'暂时无法采集';
    const content=!authorized?'<div class="monitor-empty">管理员分配此机器后，可查看逐卡占用并使用个人工作区。</div>':!production?'<div class="monitor-empty">真实部署连接只读采集器后，这里显示每张卡的利用率、显存和计算进程。</div>':!fresh?'<div class="monitor-empty monitor-warning">当前状态未知，请稍后刷新或联系管理员检查采集服务；不代表 GPU 空闲。</div>':`${h.gpuError?'<p class="monitor-warning">部分 GPU 指标不可用。</p>':''}${h.gpus?.length!==m.cards?`<p class="monitor-warning">采集到 ${h.gpus?.length||0} / ${m.cards} 张卡，请核对缺失的卡。</p>`:''}${gpuTable(h,admin,m)}`;
    return `<article class="resource-card" data-resource-machine="${esc(m.id)}"><div class="resource-top"><div><h2>${esc(m.id)}</h2><p class="muted resource-spec">${m.cards} × ${esc(m.model)} · ${esc(m.memory)} / 卡</p></div><span class="badge ${fresh&&authorized?'active':'pending'}">${status}</span></div><div class="resource-policy"><span>我的并发上限 <strong>${max} 张</strong></span><span>物理容量 <strong>${m.cards} 张</strong></span><button class="button" data-use-machine="${esc(m.id)}" ${max?'':'disabled'}>进入工作台</button></div>${content}<div class="resource-bottom"><span class="muted">${fresh?`采集时间 ${time(h.checkedAt||snapshot.checkedAt)} · GPUQ ${h.gpuq?.connected?'已连接':'不可用'}${h.gpuq?.observeOnly?' · 仅观察模式':''}`:status}</span></div>${admin&&fresh&&h.gpuq?.connected?queue(h,m):''}</article>`;
  }).join('');
}
export function monitorSummary(snapshot,production){
  if(!production)return '演示界面 · 不连接实际 GPU';
  if(!snapshot?.checkedAt)return '尚无监控数据 · 未知状态不会显示为空闲';
  return `${snapshot.stale?'监控已过期，请检查采集服务':'最近采集'}：${time(snapshot.checkedAt)} · 页面每 15 秒同步，节点约每分钟采样`;
}
