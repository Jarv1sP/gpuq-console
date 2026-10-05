import {maintenanceFor,maintenanceActive,maintenanceTime,maintenanceElapsed,maintenanceConsequence,recoveryConfirmation,recoveryChecks,recoveryPlan,executeRecovery,maintenanceInfoHTML as info,maintenanceClock} from './maintenance-state.js';
import {copyHelp} from './copy-help-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pause='<span class="maintenance-pause" aria-hidden="true"></span>';
const tag=()=>`<span class="maintenance-tag">${pause}维护中</span>`;
export function maintenanceExperienceUI(store,toast,{getPage,refresh}){
  const host=document.createElement('section');host.id='maintenance-experience';host.hidden=true;
  document.querySelector('#execution-host').before(host);
  const context=document.createElement('div');context.id='maintenance-context';context.hidden=true;context.setAttribute('role','status');document.querySelector('#shell-context').append(context);
  let actor=null,markup='',sessions=[],selected=new Set(),busy=false,plan=null;const folded=new Map(),foldedOrigins=new WeakMap();
  const dialog=document.createElement('dialog');dialog.id='maintenance-console-dialog';dialog.className='modal maintenance-console-dialog';dialog.setAttribute('aria-labelledby','maintenance-dialog-title');document.body.append(dialog);
  const current=stamp=>stamp===store.authGeneration&&store.principal?.userId===actor;
  const value=()=>store.data?.operationalMaintenance;
  const machines=()=>store.data?.machines||[];
  function foldCopy(active){
    for(const [node,wrapper] of folded)if(!active||!wrapper.isConnected||!node.textContent.trim()){const origin=foldedOrigins.get(node);if(origin?.isConnected){origin.replaceWith(node);wrapper.remove();foldedOrigins.delete(node);}else if(wrapper.isConnected)wrapper.replaceWith(node);folded.delete(node);}
    if(!active)return;
    const selectors='#page-description,.resource-explainer,.node-queue>p.muted:first-of-type,#workspace-mode-note,#terminal-mode-note,.wb-job-explanation,#environment-mode-note,#project-create>p,#project-detail>.muted,#priority-note,#custom-policy-note,#elastic-note,#placement-note,#work-submit .sheet-scroll>p,#work-submit label>small,#work-submit .submit-cli>p,#page-datasets p.muted,#page-datasets .dataset-upload-notes p,#page-datasets .data-workspace-footnote,#page-datasets .datasets-next,#transfer-copy .transfer-form-heading>p,#transfer-copy label>small,.maintenance-settings>p';
    for(const node of document.querySelectorAll(selectors)){if(folded.has(node)||node.closest('.maintenance-info')||node.classList.contains('form-error')||!node.textContent.trim())continue;const wrapper=document.createElement('div');wrapper.className='maintenance-info maintenance-copy-info';wrapper.innerHTML='<button type="button" data-maintenance-info aria-expanded="false" aria-label="操作说明">ⓘ</button><div class="maintenance-info-body" role="note"></div>';const summary=node.matches('.maintenance-settings>p')?node.parentElement.querySelector(':scope>summary'):null;if(summary){const origin=document.createComment('maintenance explanation');node.before(origin);foldedOrigins.set(node,origin);summary.append(wrapper);}else node.before(wrapper);wrapper.querySelector('.maintenance-info-body').append(node);folded.set(node,wrapper);}
  }
  function placeInfo(wrapper){const button=wrapper.querySelector('[data-maintenance-info]'),body=wrapper.querySelector('.maintenance-info-body');if(!body||!button)return;const anchor=button.getBoundingClientRect(),width=Math.min(280,innerWidth-32);body.style.width=width+'px';body.style.left=Math.max(16,Math.min(anchor.left,innerWidth-width-16))+'px';const height=Math.min(body.scrollHeight,innerHeight-32);body.style.top=Math.max(16,Math.min(anchor.bottom+6+height<=innerHeight-16?anchor.bottom+6:anchor.top-height-6,innerHeight-height-16))+'px';}
  document.addEventListener('click',event=>{const button=event.target.closest('[data-maintenance-info]');if(button){const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));const wrapper=button.closest('.maintenance-info');wrapper.classList.toggle('is-open',open);if(open)placeInfo(wrapper);}});
  document.addEventListener('pointerover',event=>{const button=event.target.closest('[data-maintenance-info]');if(button)placeInfo(button.closest('.maintenance-info'));});
  const placeOpenInfo=()=>{for(const wrapper of document.querySelectorAll('.maintenance-info.is-open'))placeInfo(wrapper);};
  addEventListener('resize',placeOpenInfo);document.addEventListener('scroll',placeOpenInfo,{capture:true,passive:true});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const button of document.querySelectorAll('[data-maintenance-info][aria-expanded=true]')){button.setAttribute('aria-expanded','false');button.closest('.maintenance-info').classList.remove('is-open');}});
  function close(){if(!busy){dialog.close();plan=null;}}
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  store.onAuthChange(()=>{foldCopy(false);dialog.close();dialog.replaceChildren();plan=null;selected.clear();sessions=[];actor=null;markup='';busy=false;host.hidden=true;host.replaceChildren();context.hidden=true;context.replaceChildren();});
  function updateContext(){
    const machine=document.querySelector('[name=workspace-machine]')?.value,entry=maintenanceFor(value(),machine);
    context.hidden=!store.principal||!entry;
    if(entry)context.innerHTML=`${tag()}<span><strong class="maintenance-context-id" title="${esc(value().global?'全平台':machine)}">${esc(value().global?'全平台':machine)}</strong>${!host.hidden&&getPage()==='work'?'':' · '+esc(entry.reason)}<small>自 ${esc(maintenanceClock(entry.since))}</small></span>${info('维护中，暂停新操作。日志、下载、取消任务仍可用。','维护限制')}`;
    const create=document.querySelector('[data-shell-action=new-project]');if(create){create.disabled=!!entry;create.title=entry?'维护中：新建项目暂停':'';}
    const submit=document.querySelector('#open-submit');if(submit){submit.textContent=entry?'提交前检查':'提交训练';submit.title=entry?'维护中：新任务暂停，可查看提交前检查':'';}
    if(!host.hidden&&getPage()==='work'){const admin=store.principal?.role==='admin';document.querySelector('#page-title').textContent=admin?'管理员工作台':'全平台维护';document.querySelector('#page-description').textContent='';}
  }
  function memberHTML(){
    const entry=value().global;
    return `<section class="maintenance-hero" aria-labelledby="maintenance-member-title"><p class="maintenance-eyebrow">${pause} 全平台</p><h2 id="maintenance-member-title">维护中</h2><p class="maintenance-reason">${esc(entry.reason)}</p><p class="maintenance-since">自 ${esc(maintenanceTime(entry.since))} <span>· ${esc(maintenanceElapsed(entry.since))}</span>${info('维护不会自动停止任务、终端、节点服务或 SSH。维修完成后，由管理员恢复新操作。','维护说明')}</p></section><div class="maintenance-permissions"><section><h3>已暂停</h3><ul><li>新任务</li><li>终端输入</li><li>数据写入</li><li>新建传输</li></ul></section><section><h3>仍然可以 ${info('已连接终端仍可断开或结束。运行任务继续，维护结束后由管理员恢复。','终端与任务')}</h3><ul><li>查看日志</li><li>查看监控</li><li>下载文件</li><li>取消任务</li></ul><a href="/guide" target="_blank" rel="noopener">使用指南 ↗</a></section></div>`;
  }
  function checksHTML(id){
    const facts=recoveryChecks(store.data,id,sessions);
    return `<ul class="maintenance-checks">${facts.checks.map(check=>`<li><div><strong>${esc(check.label)}</strong> ${info(check.detail,check.label)}</div><span class="maintenance-check-status" data-check-status="${esc(check.status)}">${esc(check.status)}</span></li>`).join('')}</ul>`;
  }
  function adminHTML(){
    const state=value(),active=machines().filter(machine=>maintenanceFor(state,machine.id)),chosen=[...selected].filter(id=>active.some(machine=>machine.id===id));
    return `<header class="maintenance-console-heading"><div><p class="maintenance-eyebrow">${pause} 管理员</p><div class="maintenance-title-row"><h2>维护控制台 ${info(maintenanceConsequence,'维护说明')}</h2><button type="button" class="button" data-console-refresh>刷新</button></div>${state.global?`<p class="maintenance-reason">${esc(state.global.reason)}</p>`:''}</div></header><div class="maintenance-console-rows" aria-label="服务器维护状态">${machines().map(machine=>{
      const entry=maintenanceFor(state,machine.id),facts=recoveryChecks(store.data,machine.id,sessions),independent=state.machines[machine.id];
      return `<article class="maintenance-server-row" data-maintenance-server="${esc(machine.id)}"><div class="maintenance-server-name"><label class="maintenance-select"><input type="checkbox" data-recovery-select="${esc(machine.id)}" aria-label="选择恢复 ${esc(machine.id)}" ${selected.has(machine.id)?'checked':''} ${!entry||!facts.ready||busy?'disabled':''}><strong class="maintenance-server-id" title="${esc(machine.id)}">${esc(machine.id)}</strong></label></div><div class="maintenance-server-state">${entry?tag():'<span>可以使用</span>'}${entry&&!state.global?`<p>${esc(entry.reason)}</p>`:''}${independent&&state.global?info(independent.reason,'单台维护原因'):''}${entry?`<small>自 ${esc(maintenanceClock(entry.since))}</small>`:''}</div><div class="maintenance-server-facts"><strong>${facts.host?.reachable===true?'在线':facts.host?.reachable===false?'离线':'待确认'}</strong><small>更新于 ${esc(maintenanceClock(facts.checkedAt))}${store.data?.gpuq?.stale?' · 已过期':''}</small><span>${facts.ready?`运行 ${facts.running.length} 项`:'运行待确认'} ${info(`平台记录：${facts.running.map(job=>job.name||job.id).join('、')||'本次未返回'}。等待 ${facts.queued.length} 项；本页面已知 ROOT ${facts.roots.length} 个。`,'任务与终端')}</span></div><div class="maintenance-server-actions"><button type="button" class="button" data-maintenance-root="${esc(machine.id)}">ROOT 终端</button>${facts.roots.length?`<button type="button" class="button quiet" data-maintenance-reconnect="${esc(machine.id)}">重连 ROOT</button>`:''}<button type="button" class="button quiet" data-maintenance-host="${esc(machine.id)}">主机状态</button><button type="button" class="button quiet" data-maintenance-check="${esc(machine.id)}">恢复前检查</button><button type="button" class="button quiet" data-maintenance-start="${esc(machine.id)}">开始维护</button></div></article>`;
    }).join('')}</div><div class="maintenance-recovery-bar"><p>${chosen.length?`恢复 ${esc(chosen.join('、'))}；${esc(active.filter(machine=>!selected.has(machine.id)).map(machine=>machine.id).join('、')||'无其他服务器')} ${active.length>chosen.length?'继续维护':'待恢复'}`:'选择服务器'} ${info('维护中，暂停提交与数据写入。ROOT 终端和主机状态仍可使用。','可用操作')}</p><div><button type="button" class="button" data-maintenance-start="all">全平台维护</button><button type="button" class="button primary" data-maintenance-stage ${!chosen.length||busy?'disabled':''}>分阶段恢复${chosen.length?' · '+chosen.length+' 台':''}</button></div></div>`;
  }
  function update(){
    const next=store.principal?.userId;if(actor!==next){actor=next;selected.clear();markup='';}
    const active=!!actor&&maintenanceActive(value()),admin=store.principal?.role==='admin';
    host.hidden=!active||!admin&&!value().global;
    document.body.classList.toggle('maintenance-focus',!host.hidden&&getPage()==='work');
    document.body.classList.toggle('maintenance-global',!!actor&&!!value()?.global);
    if(!host.hidden){const nextMarkup=admin?adminHTML():memberHTML();if(markup!==nextMarkup){const focused=document.activeElement,hook=host.contains(focused)?[...focused.attributes].find(attribute=>attribute.name.startsWith('data-')):null;markup=nextMarkup;host.innerHTML=markup;if(hook)for(const element of host.querySelectorAll(`[${hook.name}]`))if(element.getAttribute(hook.name)===hook.value){element.focus({preventScroll:true});break;}}}
    if(!host.hidden&&getPage()==='work')document.querySelector('#work-title-telemetry').hidden=true;
    if(active){const snapshot=store.data?.gpuq,monitor=document.querySelector('#monitor-status');if(monitor)monitor.innerHTML=`${store.production&&Number.isFinite(Date.parse(snapshot?.checkedAt))?'更新于 '+esc(maintenanceClock(snapshot.checkedAt))+(snapshot.stale?' · 已过期':''):'监控待确认'} ${info('页面每 15 秒同步，节点约每分钟采样。监控过期时不能推断 GPU 空闲。','监控时间')}`;}
    updateContext();foldCopy(active);document.dispatchEvent(new Event('gpuq-maintenance-state'));
  }
  function show(title,content,machine){dialog.innerHTML=`<div class="modal-head"><div class="maintenance-object-title"><h2 id="maintenance-dialog-title" title="${esc(title)}">${esc(title)}</h2>${machine?`<span class="server-id" title="${esc(machine)}">${esc(machine)}</span>`:''}</div><button type="button" class="button quiet" data-maintenance-dialog-close>关闭</button></div>${content}`;dialog.showModal();}
  async function refreshState(){const result=await store.call('maintenance.status');if(store.data)store.data.operationalMaintenance=result;await store.refresh();refresh();}
  async function start(scope){
    const revision=value().revision;
    show('开始维护',`<form id="maintenance-start-form" data-revision="${revision}"><label>维护范围<select name="scope"><option value="all">全平台</option>${machines().map(machine=>`<option value="${esc(machine.id)}">${esc(machine.id)}</option>`).join('')}</select></label><div class="maintenance-reason-field"><div class="field-caption"><label for="maintenance-start-reason">公开维护原因</label><span data-maintenance-public-reason></span></div><input id="maintenance-start-reason" name="reason" maxlength="300" required placeholder="例如：存储维护，预计今晚恢复"></div><p>暂停新提交；运行任务继续。 ${info(maintenanceConsequence,'维护影响')}</p><p class="form-error" role="alert" data-console-error></p><button class="button primary" type="submit">确认开始维护</button></form>`);
    dialog.querySelector('[name=scope]').value=scope;updateReasonHint(scope);dialog.querySelector('[name=reason]').focus();
  }
  function updateReasonHint(scope){
    dialog.querySelector('[data-maintenance-public-reason]').innerHTML=scope==='all'?copyHelp('全平台维护原因说明','全平台维护原因会公开显示在登录页，请勿写服务器名或内部信息。'):'';
  }
  function stage(){
    const ids=[...selected];if(ids.some(id=>!recoveryChecks(store.data,id,sessions).ready)){toast('有服务器尚未通过恢复前检查，请刷新核对。');return;}
    try{plan=recoveryPlan(value(),machines(),ids);}catch(error){toast(error.message);return;}
    show('确认分阶段恢复',`<p class="maintenance-plan">将恢复 <strong>${esc(plan.selected.join('、'))}</strong>；${plan.remaining.length?`${esc(plan.remaining.join('、'))} 继续维护，原因不变`:'全部所选服务器恢复准入'}。</p>${plan.selected.map(id=>`<h3>${esc(id)}</h3>${checksHTML(id)}`).join('')}<details><summary>将按以下顺序变更维护状态 · revision ${plan.revision}</summary><ol>${plan.steps.map(step=>`<li>${esc(step.scope==='all'?'全平台':step.scope)} · ${step.enabled?'保留维护':'明确恢复'}</li>`).join('')}</ol><p>每一步单独审计；有版本冲突立即停止，并显示已完成的步骤。</p></details><p>${recoveryConfirmation}</p><label class="maintenance-ack"><input type="checkbox" data-recovery-ack>我已完成维修，并核对待确认项。</label><p class="form-error" role="alert" data-console-error></p><ol data-recovery-applied aria-label="已完成的恢复步骤"></ol><div class="modal-actions"><button type="button" class="button" data-recovery-refresh>刷新后重新检查</button><button type="button" class="button primary" data-recovery-apply disabled>明确恢复所选服务器</button></div>`);
  }
  host.addEventListener('change',event=>{const id=event.target.dataset.recoverySelect;if(!id||busy)return;if(event.target.checked)selected.add(id);else selected.delete(id);markup='';update();});
  document.addEventListener('gpuq-terminal-state',event=>{sessions=(event.detail?.sessions||[]).filter(session=>session.userId===store.principal?.userId);update();});
  document.addEventListener('gpuq-workspace-rendered',()=>{updateContext();foldCopy(maintenanceActive(value()));});
  document.addEventListener('gpuq-workspace-context',()=>queueMicrotask(updateContext));
  document.addEventListener('gpuq-maintenance-restore',event=>{
    if(busy||dialog.open||store.principal?.role!=='admin'||event.detail?.userId!==actor)return;
    const ids=machines().map(machine=>machine.id).filter(id=>(event.detail.scope==='all'||id===event.detail.scope)&&maintenanceFor(value(),id)),unready=ids.filter(id=>!recoveryChecks(store.data,id,sessions).ready);
    if(!ids.length){toast('该范围没有已确认的维护状态，请刷新核对。');return;}
    if(unready.length){show('恢复前仍需核对',unready.map(id=>`<h3>${esc(id)}</h3>${checksHTML(id)}`).join(''));return;}
    selected=new Set(ids);stage();
  });
  host.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled||busy||store.principal?.role!=='admin')return;
    const id=button.dataset.maintenanceRoot||button.dataset.maintenanceReconnect;
    if(id){const known=sessions.find(session=>session.machine===id&&session.hostAdmin);document.dispatchEvent(new CustomEvent('gpuq-maintenance-root',{detail:{machine:id,...(button.dataset.maintenanceReconnect?{id:known?.id}:{}),userId:actor}}));return;}
    if(button.dataset.maintenanceStart){start(button.dataset.maintenanceStart);return;}
    if(button.hasAttribute('data-maintenance-stage')){stage();return;}
    if(button.dataset.maintenanceCheck){const id=button.dataset.maintenanceCheck,facts=recoveryChecks(store.data,id,sessions);show('恢复前检查',checksHTML(id)+`<p>${facts.ready?'检查通过':'请先处理待确认项'}</p><button type="button" class="button" data-select-checked="${esc(id)}" ${!maintenanceFor(value(),id)||!facts.ready?'disabled':''}>选择此服务器，返回控制台</button>`,id);return;}
    if(button.dataset.maintenanceHost){
      const id=button.dataset.maintenanceHost,facts=recoveryChecks(store.data,id,sessions);
      show('主机状态',`<p>${esc(facts.checkedAt?maintenanceTime(facts.checkedAt):'尚无采集时间')} · ${facts.host?.reachable===true?'采集器确认可达':'可达性未确认'}${store.data?.gpuq?.stale?' · 快照过期':''}</p><p>${facts.host?.gpus?.length??'—'} 张 GPU · 队列 ${facts.host?.gpuq?.connected===true?'已连接':'待确认'} ${info('查询已有 ROOT 命令的结果。不会新建或重跑命令。','命令状态')}</p><form id="maintenance-host-form" data-machine="${esc(id)}"><label>命令编号<input name="commandId" required spellcheck="false" pattern="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}" placeholder="完整 UUID"></label><button type="submit" class="button">查询命令状态</button><p role="alert" class="form-error" data-console-error></p><pre tabindex="0" data-host-receipt></pre></form>`,id);return;
    }
    if(button.hasAttribute('data-console-refresh')){button.disabled=true;try{await refreshState();}catch(error){toast(error.message);}finally{button.disabled=false;}}
  });
  dialog.addEventListener('change',event=>{if(event.target.form?.id==='maintenance-start-form'&&event.target.name==='scope')updateReasonHint(event.target.value);if(event.target.hasAttribute('data-recovery-ack'))dialog.querySelector('[data-recovery-apply]').disabled=!event.target.checked||!plan||busy;});
  dialog.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled||busy)return;
    if(button.hasAttribute('data-maintenance-dialog-close')){close();return;}
    if(button.dataset.selectChecked){const id=button.dataset.selectChecked;if(recoveryChecks(store.data,id,sessions).ready){selected.add(id);close();markup='';update();}return;}
    if(button.hasAttribute('data-recovery-refresh')){button.disabled=true;try{await refreshState();selected.clear();close();update();}catch(error){dialog.querySelector('[data-console-error]').textContent=error.message;}finally{button.disabled=false;}return;}
    if(!button.hasAttribute('data-recovery-apply')||!plan||store.principal?.role!=='admin')return;
    const pending=plan,stamp=store.authGeneration;busy=true;dialog.querySelectorAll('button,input').forEach(control=>control.disabled=true);
    const errorNode=dialog.querySelector('[data-console-error]'),appliedNode=dialog.querySelector('[data-recovery-applied]');errorNode.textContent='';
    try{const result=await executeRecovery(pending,(operation,args)=>store.call(operation,args),()=>current(stamp));if(!current(stamp))return;selected.clear();plan=null;busy=false;dialog.close();refresh();toast(`已明确恢复 ${pending.selected.join('、')}；${result.applied.length} 步已完成。`);}
    catch(error){if(!current(stamp))return;plan=null;selected.clear();errorNode.textContent=error.message+' 已停止后续恢复；请刷新核对，不会自动重试。';appliedNode.innerHTML=error.applied?.length?error.applied.map(step=>`<li>${esc(step.scope)} · ${step.enabled?'已启用维护':'已明确恢复'} · revision ${step.revision}</li>`).join(''):'<li>尚无已确认完成的步骤。</li>';try{await refreshState();}catch(refreshError){errorNode.textContent+=' 刷新失败：'+refreshError.message;}}
    finally{if(current(stamp)){busy=false;dialog.querySelectorAll('button,input').forEach(control=>control.disabled=false);dialog.querySelector('[data-recovery-apply]')?.setAttribute('disabled','');update();}}
  });
  dialog.addEventListener('submit',async event=>{
    const form=event.target;if(!['maintenance-start-form','maintenance-host-form'].includes(form.id))return;event.preventDefault();if(busy||store.principal?.role!=='admin')return;
    const stamp=store.authGeneration,errorNode=form.querySelector('[data-console-error]'),button=form.querySelector('[type=submit]');busy=true;button.disabled=true;errorNode.textContent='';
    try{
      if(form.id==='maintenance-start-form'){await store.call('maintenance.set',{scope:form.elements.scope.value,enabled:true,reason:form.elements.reason.value,revision:Number(form.dataset.revision)});if(current(stamp)){busy=false;dialog.close();selected.clear();refresh();toast('维护已开始；已有运行任务不会自动结束。');}}
      else{const result=await store.call('host.status',{machine:form.dataset.machine,id:form.elements.commandId.value});if(current(stamp))form.querySelector('[data-host-receipt]').textContent=JSON.stringify(result,null,2);}
    }catch(error){if(current(stamp))errorNode.textContent=error.message;}
    finally{if(current(stamp)){busy=false;button.disabled=false;}}
  });
  return update;
}
