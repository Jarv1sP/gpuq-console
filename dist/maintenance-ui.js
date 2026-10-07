import {maintenanceFor,maintenanceInfoHTML} from './maintenance-state.js';
import {copyHelp} from './copy-help-ui.js';
// Compatibility view for old bookmarks. It has no mutation controls.
const visible=v=>String(v??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>c==='\n'?c:'\\u{'+c.codePointAt(0).toString(16).padStart(4,'0')+'}');
const esc=v=>visible(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={PENDING:'未执行（流程已停用）',RETURNED:'已退回',WITHDRAWN:'已撤回',DISPATCHING:'原执行待核对',RUNNING:'原操作执行中',CANCELING:'原停止结果待核对',SUCCEEDED:'已完成',FAILED:'执行失败',CANCELED:'已停止',TIMED_OUT:'已超时',UNKNOWN:'原结果待核对'};
export function operationalMaintenanceHTML(value,machine,{unknown=false}={}){
  if(unknown||value?.version!==1)return '<aside class="maintenance-banner glass" role="status"><strong>维护状态未确认</strong></aside>';
  const entry=maintenanceFor(value,machine);if(!entry)return '';
  const scope=value.global?'全平台':machine;
  return `<aside class="maintenance-banner glass" role="status"><strong>${esc(scope)}维护中</strong><span class="maintenance-notice-reason" title="${esc(entry.reason)}">${esc(entry.reason)}</span><span>暂停训练提交、终端输入和数据写入</span>${maintenanceInfoHTML("仍可查看日志、下载和取消任务。维护不会自动结束已有任务；需管理员明确恢复。","维护限制")}</aside>`;
}
export function operationalMaintenanceUI(store,toast,onChange=()=>{},{host=document.querySelector('#operational-maintenance'),management=false,active=()=>true}={}){
  let identity=null,revision=-1,workspaceMachine=null;
  const render=()=>{
    if(!host)return;
    const value=store.data?.operationalMaintenance,actor=store.principal,admin=management&&actor?.role==='admin';
    if(!actor||!active()||management&&(!admin||store.maintenanceStatusUnknown||value?.version!==1)){host.replaceChildren();identity=null;revision=-1;return;}
    if(!management){const machine=document.querySelector('#context-machine')?.value||document.querySelector('[name=workspace-machine]')?.value||workspaceMachine;host.innerHTML=operationalMaintenanceHTML(value,machine,{unknown:store.maintenanceStatusUnknown});return;}
    const nextIdentity=actor.userId+':'+actor.role;
    if(identity!==nextIdentity){
      identity=nextIdentity;revision=-1;
      host.innerHTML=(management?'':'<div data-maintenance-banner></div>')+(admin?`<dialog id="maintenance-settings-dialog" class="modal maintenance-settings" aria-labelledby="maintenance-settings-title"><div class="modal-head"><div class="copy-caption"><h2 id="maintenance-settings-title">维护设置</h2>${copyHelp('维护设置','维护暂停新操作，已有任务不会自动停止。维修完成后需要明确恢复。')}</div><button type="button" class="button quiet" data-maintenance-settings-close>关闭</button></div><form><label>范围<select name="scope"><option value="all">全平台</option>${(store.data.machines||[]).map(m=>`<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('')}</select></label><div class="maintenance-reason-field"><div class="field-caption"><label for="maintenance-settings-reason">公开维护原因</label><span data-maintenance-public-reason></span></div><input id="maintenance-settings-reason" name="reason" maxlength="300" placeholder="例如：存储维护"></div><div><button class="button" type="submit">启用维护</button><button class="button" type="button" data-maintenance-resume>明确恢复此范围</button><button class="button" type="button" data-maintenance-refresh>刷新状态</button></div><p data-maintenance-error class="form-error" role="alert"></p></form></dialog>`:'');
      if(admin){
        const form=host.querySelector('form'),error=host.querySelector('[data-maintenance-error]'),stamp=store.authGeneration;
        host.querySelector('[data-maintenance-settings-close]').addEventListener('click',()=>host.querySelector('dialog').close());
        const current=()=>active()&&!store.authPending&&!store.maintenanceStatusUnknown&&stamp===store.authGeneration&&identity===nextIdentity&&host.contains(form)&&store.principal?.role==='admin';
        const select=()=>{const current=store.data.operationalMaintenance,scope=form.elements.scope.value;form.elements.reason.value=(scope==='all'?current.global:current.machines[scope])?.reason||'';form.dataset.revision=String(current.revision);form.querySelector('[data-maintenance-public-reason]').innerHTML=scope==='all'?copyHelp('全平台维护原因说明','全平台维护原因会公开显示在登录页，请勿写服务器名或内部信息。'):'';};
        form.elements.scope.addEventListener('change',select);
        const apply=async enabled=>{
          if(!current())return;
          const userId=store.principal?.userId;
          if(!enabled&&!globalThis.confirm('确认此范围的诊断维修已完成并恢复新操作？未取消的等待任务会继续；已取消或终态任务不会自动重跑。其他范围的维护状态不会改变。'))return;
          const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);error.textContent='';
          try{
            await store.call('maintenance.set',{scope:form.elements.scope.value,enabled,revision:Number(form.dataset.revision),...(enabled?{reason:form.elements.reason.value}:{})});
            if(store.principal?.userId!==userId||!current())return;
            select();if(!management)host.querySelector('[data-maintenance-banner]').innerHTML=operationalMaintenanceHTML(store.data.operationalMaintenance);onChange();toast(enabled?'维护已启用；已有任务不会自动结束':'已明确解除所选范围的维护');
          }catch(e){if(store.principal?.userId===userId&&current())error.textContent=e.message;}finally{if(current())buttons.forEach(b=>b.disabled=false);}
        };
        form.addEventListener('submit',event=>{event.preventDefault();apply(true);});
        form.querySelector('[data-maintenance-resume]').addEventListener('click',()=>{if(current())apply(false);});
        form.querySelector('[data-maintenance-refresh]').addEventListener('click',async()=>{if(!current())return;try{await store.refresh();if(!current())return;select();error.textContent='';if(!management)host.querySelector('[data-maintenance-banner]').innerHTML=operationalMaintenanceHTML(store.data.operationalMaintenance);onChange();}catch(e){if(current())error.textContent=e.message;}});
        select();
      }
    }
    if(revision!==value.revision){if(!management)host.querySelector('[data-maintenance-banner]').innerHTML=operationalMaintenanceHTML(value);revision=value.revision;}
  };
  if(!management){document.addEventListener('gpuq-workspace-context',event=>{workspaceMachine=event.detail?.userId===store.principal?.userId?event.detail.machine:null;render();});document.addEventListener('gpuq-maintenance-observation',render);store.onAuthChange(()=>{workspaceMachine=null;host?.replaceChildren();});}
  return render;
}
export function maintenanceUI(store){
  const host=document.querySelector('#page-maintenance');
  let identity=null,generation=0,selectionSerial=0,active=false,ready=false,loading=false,cursor=null;
  const same=stamp=>stamp===generation&&identity===store.principal?.userId;
  const q=selector=>host?.querySelector(selector);
  function reset(){generation++;selectionSerial++;identity=null;ready=false;loading=false;cursor=null;host?.replaceChildren();}
  store.onAuthChange(reset);
  function build(){
    host.innerHTML=`<section class="maintenance-history"><div class="maintenance-history-focus hero-frame"><span class="hero-label">只读历史</span><div class="maintenance-toolbar"><div class="copy-caption"><h2>历史申请与结果</h2>${copyHelp('只读历史','维护申请已停用，未批准的申请不会执行。历史脚本和结果仅供查阅，已开始的操作不会因此停止。','/guide/troubleshooting')}</div><button class="button" id="maintenance-refresh">刷新</button></div>
      <p id="maintenance-list-error" class="form-error" role="status"></p><div id="maintenance-list"></div><button class="button" id="maintenance-more" hidden>下一页</button><div id="maintenance-detail"></div></div></section>`;
    q('#maintenance-refresh').addEventListener('click',()=>load());q('#maintenance-more').addEventListener('click',()=>load(cursor));ready=true;
  }
  async function load(next){
    if(!ready||loading||!active)return;loading=true;const stamp=generation;
    try{
      const result=await store.call('maintenance.list',next?{cursor:next}:{});if(!same(stamp))return;
      cursor=result.nextCursor;q('#maintenance-more').hidden=!cursor;q('#maintenance-list-error').textContent='';
      q('#maintenance-list').innerHTML=result.items.map(r=>`<button class="maintenance-row" data-id="${esc(r.id)}"><strong title="${esc(r.title)}">${esc(r.title)}</strong><span class="maintenance-row-facts"><span class="maintenance-history-machine" title="${esc(r.machine)}">${esc(r.machine)}</span><span>${esc(labels[r.state]||r.state)}</span></span></button>`).join('')||'<p class="empty">暂无历史记录。</p>';
      for(const node of q('#maintenance-list').querySelectorAll('[data-id]'))node.addEventListener('click',()=>show(node.dataset.id));
    }catch(error){if(same(stamp))q('#maintenance-list-error').textContent=error.message;}
    finally{if(same(stamp))loading=false;}
  }
  async function show(id){
    const stamp=generation,sequence=++selectionSerial;
    try{
      const r=await store.call('maintenance.get',{id});if(!same(stamp)||sequence!==selectionSerial)return;
      q('#maintenance-detail').innerHTML=`<article class="maintenance-detail"><h3>${esc(r.title)}</h3><p>${esc(r.machine)} · ${esc(r.owner.username)} · ${esc(labels[r.state]||r.state)}</p>
        <p class="muted">${esc(r.id)}</p><p>原申请原因：${esc(r.reason)}</p><p>目录：${esc(r.cwd)} · 超时 ${esc(r.timeoutSec)}s</p><p class="maintenance-hash">脚本 SHA256：${esc(r.scriptSha256)}</p><pre tabindex="0">${esc(r.script)}</pre>
        ${r.execution?`<p class="maintenance-hash">原执行键：${esc(r.execution.id)}</p>`:''}
        ${r.decision?`<p>处理人：${esc(r.decision.by.username)}${r.decision.reason?' · '+esc(r.decision.reason):''}</p>`:''}${r.error?`<p role="status">${esc(r.error)}</p>`:''}
        ${r.result?`<p>上次回执：${esc(labels[r.result.state]||r.result.state)} · 退出码 ${esc(r.result.exitCode??'未确认')} · ${esc(r.result.checkedAt)}</p><h4>标准输出</h4><pre tabindex="0">${esc(r.result.stdout)}</pre><h4>错误输出</h4><pre tabindex="0">${esc(r.result.stderr)}</pre>${r.result.truncated?.stdout||r.result.truncated?.stderr?'<p>输出已截断，每路最多 64 KiB。</p>':''}`:''}</article>`;
    }catch(error){if(same(stamp))q('#maintenance-list-error').textContent=error.message;}
  }
  return selected=>{
    const enabled=store.production===true&&store.data?.maintenance?.version===1&&!!store.principal;
    const nav=document.querySelector('[data-nav=maintenance]');if(nav)nav.hidden=true;
    if(identity!==store.principal?.userId){reset();identity=store.principal?.userId;}
    active=selected&&enabled;if(!active||!host)return;
    if(!ready)build();load();
  };
}
