import {endedJob,escapeUI as esc,stateHTML,stateClass,stateWord,trainingReadout,trajectoryHTML} from './workbench-ui.js';
import {captureObject,dismissReveal} from './motion-ui.js';

const finite=value=>Number.isSafeInteger(value)&&value>=0;
const activeData=new Set(['NEW','HASHING','RECEIVING_MANIFEST','SEALING','UPLOADING','PUBLISHING','QUEUED','RUNNING','IMPORTING','DOWNLOADING','EXTRACTING','VERIFYING','PREPARING','COPYING','ARCHIVING']);
const failedData=new Set(['FAILED','UNKNOWN','PARTIAL','UNCONFIRMED']);
export function controlSnapshot(store,{sessions=[],activities=[],activitiesComplete=false,focusJobId}={}){
  const principal=store.principal,user=store.users.find(row=>row.id===principal?.userId);
  if(!principal)return {jobs:[],active:[],attention:[],servers:[],sessions:[],activities:[],focal:null,quota:null,usage:null,dataCount:null};
  const jobs=store.jobs.filter(row=>row.userId===principal.userId),active=jobs.filter(row=>!endedJob(row));
  const focal=active.find(row=>row.id===focusJobId&&row.state==='RUNNING'&&!row.cancelRequested)||active.find(row=>row.state==='RUNNING'&&!row.cancelRequested)||null;
  const ownedSessions=sessions.filter(row=>row.userId===principal.userId&&(!row.hostAdmin||principal.role==='admin'));
  const ownedActivities=[...new Map(activities.filter(row=>row.userId===principal.userId&&typeof row.id==='string').map(row=>[row.id,row])).values()];
  const attention=jobs.filter(row=>['FAILED','UNKNOWN'].includes(row.state)).map(row=>({id:'job:'+row.id,name:row.name||'训练',fact:row.error||row.latestAttempt?.failureReason||stateWord(row),action:row.state==='FAILED'?'查看诊断':'刷新核对',jobId:row.id,state:row.state}));
  for(const row of ownedActivities.filter(row=>failedData.has(row.state)))attention.push({id:'data:'+row.id,name:row.name||row.kind||'后台数据任务',fact:row.error||row.state,action:'查看数据任务',activityId:row.id});
  if(principal.role==='admin')for(const row of store.users.filter(row=>row.enabled&&row.role!=='admin'&&!row.approvedAt&&row.total===0))attention.push({id:'user:'+row.id,name:row.name||row.username,fact:'待审批 · 额度 0 张',action:'去审批',userId:row.id});
  const hosts=new Map((store.data?.gpuq?.hosts||[]).map(host=>[host.id,host]));
  const servers=(store.data?.machines||[]).filter(machine=>principal.role==='admin'||user?.limits?.[machine.id]>0).map(machine=>{
    // Reachability alone is not a confirmed scheduler observation. Never paint
    // missing/failed collection as online or infer that unknown cards are free.
    const host=hosts.get(machine.id),fresh=store.production===true&&store.data?.gpuq?.stale===false&&host?.reachable===true&&host.gpuq?.connected===true&&host.gpuq?.health==='ok';
    const state=!fresh?'unknown':host.gpuq?.observeOnly?'observe':'online';
    const available=Array.isArray(host?.gpus)&&host.gpus.length===machine.cards&&new Set(host.gpus.map(gpu=>gpu.index)).size===machine.cards&&host.gpus.every(gpu=>Number.isSafeInteger(gpu.index)&&gpu.index>=0&&gpu.index<machine.cards&&gpu.processesAvailable===true&&Array.isArray(gpu.processes));
    const busy=fresh&&available?host.gpus.filter(gpu=>gpu.processes?.length>0).length:null;
    return {...machine,host,fresh,available,state,busy,quota:finite(user?.limits?.[machine.id])?user.limits[machine.id]:null};
  });
  return {jobs,active,attention,servers,sessions:ownedSessions,activities:ownedActivities,focal,quota:finite(user?.total)?user.total:null,usage:user&&typeof store.usage==='function'?store.usage(user.id):null,dataCount:activitiesComplete?ownedActivities.filter(row=>activeData.has(row.state)).length:null};
}
function sessionName(session){return session.hostAdmin?'ROOT 运维终端':session.dataWorkspace?'数据终端':'开发终端';}
export function sessionStatus(session){return session.connectionState==='connecting'?'连接中':session.connectionState==='unknown'?'连接待核对':session.detached?'已断开 · 可重连':'已连接';}
function monitorDot(server){return `<span class="cs-dot ${server.state==='online'?'':server.state}" aria-hidden="true"></span>`;}
function serverHint(server){return server.id+' · '+(server.busy===null?'计算进程占用未确认':`${server.busy}/${server.cards} 张有计算进程`)+(server.host?.checkedAt?' · 采集 '+new Date(server.host.checkedAt).toLocaleTimeString('zh-CN',{hour12:false}):'')+(server.state==='observe'?' · 仅观察':server.state==='unknown'?' · 暂时无法采集':'');}
function stateCounts(jobs){return ['st-run','st-start','st-queue','st-prep','st-cancel','st-unk'].map(type=>({type,count:jobs.filter(job=>stateClass(job)===type).length,label:({'st-run':'运行中','st-start':'启动中','st-queue':'排队中','st-prep':'准备数据','st-cancel':'正在取消','st-unk':'状态待核对'})[type]})).filter(row=>row.count>0);}
function stripHTML(snapshot){
  const focal=snapshot.focal,r=focal?trainingReadout(focal):null,session=snapshot.sessions.at(-1);
  const counts=stateCounts(snapshot.active);
  return (focal?`<button type="button" class="cs-seg cs-focal" data-control-job="${esc(focal.id)}" aria-label="打开 ${esc(focal.name)} 任务详情">${stateHTML(focal,false)}<span class="cs-job"><span class="cs-name">${esc(focal.name||'训练')}</span>${r.percent===null?'':`<span class="cs-value">${r.percent}%</span>`}<span class="cs-meta">${r.percent===null?esc(r.description):`<progress class="cs-progress" max="100" value="${r.percent}" aria-label="训练上报进度"></progress>`}${esc(r.eta)}</span></span></button>`:'')+
    (counts.length||snapshot.attention.length?`<div class="cs-seg cs-counts">${counts.length?`<button type="button" class="cs-count-link" data-control-section="jobs" aria-label="查看进行中的训练"><span>任务</span>${counts.map(row=>`<span class="st ${row.type}" role="img" aria-label="${row.count} 项${row.label}"><span class="g" aria-hidden="true"></span>${row.count}</span>`).join('')}</button>`:''}${snapshot.attention.length?`<button type="button" class="cs-attention" data-control-section="attention" aria-label="${snapshot.attention.length} 项需要处理">${stateHTML({state:'FAILED'},false)}需处理 ${snapshot.attention.length}</button>`:''}</div>`:'')+
    (session?`<button type="button" class="cs-seg" data-control-session="${esc(session.id)}"><span class="cs-dot ${session.detached?'observe':''}" aria-hidden="true"></span><span class="cs-small">${sessionName(session)}<small>${esc(session.id.slice(0,6))} · ${sessionStatus(session)}</small></span></button>`:'')+
    (snapshot.activities.length?`<button type="button" class="cs-seg" data-control-section="sessions"><span class="cs-small">后台数据${snapshot.dataCount===null?'':` · ${snapshot.dataCount} 项进行中`}<small>${snapshot.dataCount===null?'已读取的任务':'已确认状态'}</small></span></button>`:'')+
    (snapshot.servers.length?`<button type="button" class="cs-seg cs-server-list" data-control-section="servers" aria-label="我的服务器"><span class="cs-server-label">我的服务器</span>${snapshot.servers.map(server=>`<span class="cs-server" title="${esc(serverHint(server))}">${monitorDot(server)}<span class="cs-server-id">${esc(server.id)}</span></span>`).join('')}</button>`:'')+
    '<button type="button" class="cs-seg cs-command" data-control-section="command" aria-label="总控与命令输入">⌘K</button>';
}
function overviewHTML(snapshot){
  const states=['online','observe','unknown'].map(state=>({state,count:snapshot.servers.filter(server=>server.state===state).length,label:{online:'在线',observe:'仅观察',unknown:'无法采集'}[state]})).filter(row=>row.count);
  return `<div class="mc-overview"><div class="mc-meter"><span class="mc-meter-label">额度占用 / 上限</span><div class="mc-meter-value">${snapshot.usage??'—'} / ${snapshot.quota??'—'}<small>张</small></div></div><div class="mc-meter"><span class="mc-meter-label">进行中训练</span><div class="mc-meter-value">${snapshot.active.length}</div></div><div class="mc-meter ${snapshot.attention.length?'mc-meter-alert':''}"><span class="mc-meter-label">需处理</span><div class="mc-meter-value">${snapshot.attention.length}</div></div><div class="mc-meter"><span class="mc-meter-label">我的服务器</span><div class="mc-meter-value">${snapshot.servers.length}<small>台</small></div><div class="mc-monitor">${states.map(row=>`<span class="mc-monitor-state" role="img" aria-label="${row.count} 台${row.label}"><span class="cs-dot ${row.state==='online'?'':row.state}" aria-hidden="true"></span>${row.count}<span class="mc-monitor-word">${row.label}</span></span>`).join('')}</div></div></div>`;
}
export function serverSlotsHTML(server){
  const gpus=new Map((server.host?.gpus||[]).map(gpu=>[gpu.index,gpu]));
  return `<div class="slots" aria-label="${esc(server.id)} 的 ${server.cards} 张显卡">${Array.from({length:finite(server.cards)?server.cards:0},(_,index)=>{
    const gpu=gpus.get(index),known=server.fresh&&server.available===true&&gpu?.processesAvailable===true&&Array.isArray(gpu.processes)&&Number.isFinite(gpu.memoryUsedMiB)&&gpu.memoryUsedMiB>=0&&Number.isFinite(gpu.memoryTotalMiB)&&gpu.memoryTotalMiB>0;
    return `<span class="slot ${known?(gpu.processes.length?'used':'free'):'unknown hatch'}" aria-label="GPU ${index} · ${known?gpu.processes.length+' 个计算进程 · 显存 '+gpu.memoryUsedMiB+' / '+gpu.memoryTotalMiB+' MiB':'占用未确认'}">${known?`<progress class="slot-vram" aria-label="GPU ${index} 已用显存" max="${gpu.memoryTotalMiB}" value="${Math.max(0,Math.min(gpu.memoryUsedMiB,gpu.memoryTotalMiB))}"></progress>`:''}<span>${index}</span></span>`;
  }).join('')}</div>`;
}

export function controlUI(store,{navigate,getPage,toast,openSubmit,openJob}){
  const strip=document.querySelector('#control-strip'),pill=document.querySelector('#live-pill'),mobile=document.querySelector('#mobile-control'),dialog=document.querySelector('#mission-control'),content=document.querySelector('#mission-control-content');
  let sessions=[],activities=[],activitiesComplete=false,focusJobId=null,actor=null,snapshot=controlSnapshot(store),expanded=false,source='command',commands=[],recent=[],cursor=0,closing=null,returnFocus=null,gPending=0,lastStrip='',previousJobs=new Map(),liveStates=new Set();
  const stripPlace=document.createComment('persistent control strip');strip.before(stripPlace);
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function actionButton(id,label,code='',run){return {id,label,code,run};}
  function makeCommands(){
    const machine=document.querySelector('[name=workspace-machine]')?.value,project=document.querySelector('[name=workspace-project]')?.value;
    const rows=[actionButton('work','工作台','gpuctl jobs',()=>navigate('work')),actionButton('resources','算力总览','gpuctl state',()=>navigate('resources')),actionButton('datasets','数据集','gpuctl data list',()=>navigate('datasets')),actionButton('community','协作区','',()=>navigate('community'))];
    if(machine&&document.querySelector('#train-form'))rows.unshift(actionButton('submit','提交训练'+(project?' · '+project:''),'gpuctl run '+machine,openSubmit));
    const terminal=document.querySelector('#terminal-open');if(terminal&&!terminal.disabled&&machine)rows.push(actionButton('terminal','打开开发终端','gpuctl ssh '+machine,()=>terminal.click()));
    const publish=document.querySelector('#project-publish');if(publish&&!publish.disabled&&project)rows.push(actionButton('publish','生成训练版本 · '+project,'gpuctl project publish --machine '+machine+' --project '+project,()=>publish.click()));
    for(const job of snapshot.active)rows.push(actionButton('job:'+job.id,'查看任务 · '+job.name,'gpuctl watch '+job.id,()=>openJob(job.id)));
    if(store.principal?.role==='admin')rows.push(actionButton('users','成员授权','',()=>navigate('users')));
    return rows;
  }
  function updateCommands(){
    const input=dialog.querySelector('#control-command'),search=input?.value.trim().toLocaleLowerCase()||'';
    const ordered=[...recent.map(id=>commands.find(row=>row.id===id)).filter(Boolean),...commands.filter(row=>!recent.includes(row.id))];
    const visible=ordered.filter(row=>(row.label+' '+row.code).toLocaleLowerCase().includes(search)).slice(0,expanded||search?24:3);cursor=Math.min(cursor,Math.max(0,visible.length-1));
    const root=dialog.querySelector('#control-suggestions');root.className=expanded||search?'mc-suggestions':'mc-recent';root.innerHTML=visible.length?visible.map((row,index)=>`<button type="button" id="control-option-${index}" class="${expanded||search?'mc-suggestion':'button quiet mc-recent-action'} ${cursor===index?'selected':''}" data-command-id="${esc(row.id)}" role="option" aria-selected="${cursor===index}"><span>${esc(row.label)}</span>${expanded||search?`<code>${esc(row.code)}</code>`:''}</button>`).join(''):'<p class="mc-command-empty">未找到匹配操作</p>';
    input?.setAttribute('aria-activedescendant',visible.length?'control-option-'+cursor:'');
  }
  function panelHTML(){
    return `<div class="mc-head glass"><div class="sr-only" id="mission-control-title">总控</div><input class="mc-input" id="control-command" aria-label="输入操作或跳转" role="combobox" aria-autocomplete="list" aria-controls="control-suggestions" aria-expanded="true" autocomplete="off" placeholder="输入操作或跳转…"><button type="button" class="button quiet mc-close" data-control-close aria-label="关闭总控">关闭</button></div>${overviewHTML(snapshot)}<div class="mc-body"><div id="control-suggestions" role="listbox" aria-label="可执行的操作"></div>${snapshot.attention.length?`<section id="control-attention" aria-labelledby="control-attention-title"><h2 class="control-section-title" id="control-attention-title">需要处理 · ${snapshot.attention.length}</h2><div class="mc-attention">${snapshot.attention.map(row=>`<article class="mc-attention-item"><div class="mc-attention-title">${stateHTML({state:'FAILED'},false)}<strong>${esc(row.name)}</strong></div><small>${esc(row.fact)}</small><button type="button" class="button quiet" data-control-attention="${esc(row.id)}">${row.action}</button></article>`).join('')}</div></section>`:''}<div class="mc-cols"><section class="mc-col" id="control-jobs"><h3>我的训练</h3>${snapshot.active.map(job=>`<article class="mc-row"><button type="button" class="mc-row-name" data-control-job="${esc(job.id)}">${stateHTML(job,false)}${esc(job.name||'训练')}</button><p class="mc-row-fact">${esc(job.machine)} · ${Number.isSafeInteger(job.cards)?job.cards+' 张':'卡数未确认'} · ${esc(job.queueReason||stateWord(job))}</p>${trajectoryHTML(job)}<div class="mc-row-actions"><button type="button" class="button quiet" data-control-job="${esc(job.id)}">详情</button><button type="button" class="button quiet" data-control-logs="${esc(job.id)}">日志</button>${job.project?`<button type="button" class="button quiet" data-control-output="${esc(job.id)}">输出</button>`:''}<button type="button" class="button danger" data-control-cancel="${esc(job.id)}" ${job.cancelRequested?'disabled':''}>取消</button></div></article>`).join('')||'<p class="mc-row-fact">没有进行中的训练。</p>'}</section><section class="mc-col" id="control-sessions"><h3>会话与数据</h3>${snapshot.sessions.map(session=>`<article class="mc-row"><button type="button" class="mc-row-name" data-control-session="${esc(session.id)}">${esc(sessionName(session))} · ${esc(session.machine)}</button><p class="mc-row-fact">${esc(sessionStatus(session))}${session.project?' · '+esc(session.project):''}</p><code class="control-full-id">${esc(session.id)}</code><div class="mc-row-actions"><button type="button" class="button quiet" data-copy-session="${esc(session.id)}">复制 ID</button><button type="button" class="button quiet" data-control-session="${esc(session.id)}">${session.detached?'重连':'展开'}</button></div></article>`).join('')}${snapshot.activities.map(row=>`<article class="mc-row"><span class="mc-row-name">${esc(row.name||row.kind||'后台数据任务')}</span><p class="mc-row-fact">${esc(row.machine||'')} · ${esc(row.state)}</p><button type="button" class="button quiet" data-control-activity="${esc(row.id)}">查看任务</button></article>`).join('')}${!snapshot.sessions.length&&!snapshot.activities.length?'<p class="mc-row-fact">暂无已确认的会话或后台数据任务。</p>':''}</section><section class="mc-col" id="control-servers"><h3>我的服务器</h3>${snapshot.servers.map(server=>`<article class="mc-server"><div class="mc-server-head"><strong title="${esc(server.id)}">${esc(server.id)}</strong><span>${{online:'监控在线',observe:'仅观察',unknown:'暂时无法采集'}[server.state]}</span></div>${serverSlotsHTML(server)}<p class="mc-row-fact">额度 ${server.quota??'—'} 张 · ${esc(serverHint(server))}</p><button type="button" class="button quiet" data-control-machine="${esc(server.id)}">查看逐卡</button></article>`).join('')||'<p class="mc-row-fact">暂无已授权服务器。</p>'}</section></div></div><footer class="mc-footer"><span>⌘K 命令</span><span>G W 工作台 · G C 算力 · G D 数据集 · G X 协作</span><span>Esc 关闭</span></footer>`;
  }
  function close(immediate=false){
    if(!dialog.open)return;
    const finish=()=>{dialog.close();stripPlace.after(strip);closing=null;markOpen();returnFocus?.focus({preventScroll:true});};
    if(immediate){closing?.cancel();finish();return;}
    if(closing)return;
    closing=dismissReveal(dialog,content);stripPlace.after(strip);markOpen();returnFocus?.focus({preventScroll:true});
    closing?.finished.then(()=>{closing=null;},()=>{});
  }
  function open(section='command'){
    if(!store.principal)return;
    closing?.cancel();closing=null;source=section;expanded=section==='command';commands=makeCommands();cursor=0;
    const showing=dialog.open;if(!showing){returnFocus=document.activeElement;content.innerHTML=panelHTML();dialog.append(strip);dialog.showModal();content.animate(reduced()?[{opacity:0},{opacity:1}]:[{clipPath:'inset(100% 0 0 0)'},{clipPath:'inset(0 0 0 0)'}],{duration:reduced()?150:320,easing:'cubic-bezier(.2,.8,.2,1)'});}
    updateCommands();dialog.querySelector('#control-command').focus({preventScroll:true});
    if(section!=='command')requestAnimationFrame(()=>{const target=dialog.querySelector('#control-'+section),body=dialog.querySelector('.mc-body');if(target&&body){const top=target.getBoundingClientRect().top-body.getBoundingClientRect().top;if(top<0||top>body.clientHeight-60)body.scrollTop+=top-12;target.animate([{borderTopColor:'var(--ink-3)'},{borderTopColor:'var(--line)'}],{duration:reduced()?150:220});}});
    markOpen();
  }
  function markOpen(){for(const segment of strip.querySelectorAll('[data-control-section]'))segment.classList.toggle('is-open',dialog.open&&segment.dataset.controlSection===source);}
  function runCommand(id){const row=commands.find(row=>row.id===id);if(!row)return;recent=[id,...recent.filter(value=>value!==id)].slice(0,3);close(true);row.run();}
  function triggerJob(id,attribute='jobDetail',origin=null){const saved=captureObject(origin);close(true);if(attribute==='jobDetail')return openJob(id,'overview',saved);const button=[...document.querySelectorAll('button')].find(element=>element.dataset[attribute]===id);button?.click();}
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.controlSection){if(dialog.open&&source===button.dataset.controlSection)close();else open(button.dataset.controlSection);}
    if(button.dataset.shellAction==='control')open('jobs');
    if(button.hasAttribute('data-control-close'))close();
    if(button.dataset.commandId)runCommand(button.dataset.commandId);
    if(button.dataset.controlJob)triggerJob(button.dataset.controlJob,'jobDetail',button);
    for(const [key,attribute] of [['controlLogs','jobLogs'],['controlOutput','jobOutput'],['controlCancel','jobCancel']])if(button.dataset[key])triggerJob(button.dataset[key],attribute);
    if(button.dataset.copySession)navigator.clipboard.writeText(button.dataset.copySession).then(()=>toast('完整会话 ID 已复制。'),()=>toast('复制失败，请选中完整会话 ID 复制。'));
    if(button.dataset.controlSession){const session=snapshot.sessions.find(row=>row.id===button.dataset.controlSession);if(session){close(true);document.dispatchEvent(new CustomEvent('gpuq-terminal-reveal',{detail:{id:session.id,userId:store.principal.userId}}));}}
    if(button.dataset.controlMachine){close(true);navigate('resources');document.querySelector(`[data-resource-machine="${CSS.escape(button.dataset.controlMachine)}"]`)?.scrollIntoView({block:'start',behavior:'instant'});}
    if(button.dataset.controlActivity){close(true);navigate('transfers');document.dispatchEvent(new CustomEvent('gpuq-reveal-data-activity',{detail:{id:button.dataset.controlActivity}}));}
    if(button.dataset.controlAttention){const row=snapshot.attention.find(item=>item.id===button.dataset.controlAttention);if(!row)return;close(true);if(row.userId){navigate('users');document.querySelector(`[data-user="${CSS.escape(row.userId)}"]`)?.click();}else if(row.jobId){if(row.state==='UNKNOWN')document.querySelector('#refresh-state').click();else openJob(row.jobId,'diagnostics');}else {navigate('transfers');document.dispatchEvent(new CustomEvent('gpuq-reveal-data-activity',{detail:{id:row.activityId}}));}}
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}});
  dialog.addEventListener('input',event=>{if(event.target.id==='control-command'){cursor=0;updateCommands();}});
  document.addEventListener('keydown',event=>{
    const editing=event.target.closest('input,textarea,select,[contenteditable=true]');
    if([...document.querySelectorAll('dialog[open]')].some(layer=>layer!==dialog))return;
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!(event.ctrlKey&&event.target.closest('.terminal-dialog'))){event.preventDefault();open('command');return;}
    if(event.target.id==='control-command'&&['ArrowDown','ArrowUp','Enter'].includes(event.key)){event.preventDefault();const rows=[...dialog.querySelectorAll('[data-command-id]')];if(!rows.length)return;if(event.key==='Enter')return runCommand(rows[cursor].dataset.commandId);cursor=(cursor+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length;updateCommands();return;}
    if(editing||event.metaKey||event.ctrlKey||event.altKey)return;
    if(event.key==='.'||event.key==='?'){event.preventDefault();open('command');return;}
    if(event.key.toLowerCase()==='g'){gPending=Date.now();return;}
    if(Date.now()-gPending<1500){gPending=0;const route={w:'work',c:'resources',d:'datasets',x:'community',m:'users'}[event.key.toLowerCase()];if(route&&(route!=='users'||store.principal?.role==='admin')){event.preventDefault();close(true);navigate(route);}}
    if(event.key==='Escape')document.querySelector('#account-menu').open=false;
  });
  document.addEventListener('gpuq-terminal-state',event=>{sessions=event.detail.sessions||[];update();});
  document.addEventListener('gpuq-data-activities',event=>{if(event.detail.userId!==store.principal?.userId)return;activities=Array.isArray(event.detail.items)?event.detail.items.map(row=>({...row,userId:event.detail.userId})):[];activitiesComplete=event.detail.complete===true;update();});
  document.addEventListener('gpuq-focused-job',event=>{if(store.jobs.some(job=>job.id===event.detail.id&&job.userId===store.principal?.userId)){focusJobId=event.detail.id;update();}});
  store.onAuthChange(()=>{close(true);sessions=[];activities=[];activitiesComplete=false;recent=[];focusJobId=null;actor=null;lastStrip='';previousJobs.clear();liveStates.clear();strip.replaceChildren();pill.replaceChildren();content.replaceChildren();strip.hidden=true;mobile.hidden=true;});
  function update(){
    if(actor!==store.principal?.userId){actor=store.principal?.userId;focusJobId=null;recent=[];}
    snapshot=controlSnapshot(store,{sessions,activities,activitiesComplete,focusJobId});
    for(const job of snapshot.jobs){const previous=previousJobs.get(job.id),percent=trainingReadout(job).percent;if(previous&&(previous.state!==job.state||previous.percent!==percent))liveStates.add(stateClass(job));}previousJobs=new Map(snapshot.jobs.map(job=>[job.id,{state:job.state,percent:trainingReadout(job).percent}]));
    strip.hidden=!store.principal;const html=stripHTML(snapshot);if(lastStrip!==html){lastStrip=html;strip.innerHTML=html;}markOpen();for(const glyph of strip.querySelectorAll('.st'))glyph.classList.toggle('is-live',liveStates.has([...glyph.classList].find(value=>value.startsWith('st-'))));
    const r=snapshot.focal?trainingReadout(snapshot.focal):null;pill.hidden=!store.principal||getPage()==='work'||!snapshot.focal&&!snapshot.attention.length;mobile.hidden=!store.principal||pill.hidden&&!mobile.querySelector('#open-submit');pill.innerHTML=(snapshot.focal?`${stateHTML(snapshot.focal,false)}<span class="cs-name">${esc(snapshot.focal.name)}</span>${r.percent===null?'':`<span>${r.percent}%</span>`}`:'总控')+(snapshot.attention.length?`<span class="cs-attention">需处理 ${snapshot.attention.length}</span>`:'');
    dialog.classList.toggle('m-full',matchMedia('(max-width:759px)').matches);
    if(dialog.open){const template=document.createElement('template');template.innerHTML=panelHTML();dialog.querySelector('.mc-overview').replaceWith(template.content.querySelector('.mc-overview'));const body=dialog.querySelector('.mc-body'),top=body.scrollTop;body.replaceChildren(...template.content.querySelector('.mc-body').childNodes);commands=makeCommands();updateCommands();body.scrollTop=top;}
  }
  return {update,open,close,snapshot:()=>snapshot};
}
