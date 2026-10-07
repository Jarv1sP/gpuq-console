import {serverIdHTML} from './workbench-ui.js';
import {copyHelp} from './copy-help-ui.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const hostCommandId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const hostCommandTerminal=new Set(['SUCCEEDED','FAILED','CANCELED','TIMED_OUT']);
export const hostDiagnosticPresets=Object.freeze([
  Object.freeze({id:'gpu',title:'GPU 状态',argv:Object.freeze(['nvidia-smi'])}),
  Object.freeze({id:'disk',title:'数据盘用量',argv:Object.freeze(['df','-h','/data2'])}),
]);
const labels={SUBMITTING:'请求已发出',RUNNING:'进行中',CANCELING:'正在停止',SUCCEEDED:'已完成',FAILED:'执行未完成',CANCELED:'已停止',TIMED_OUT:'已超时',UNKNOWN:'结果待确认'};
export function hostDiagnosticAvailability(data,machine){
  const host=data?.gpuq?.hosts?.find(row=>row.id===machine);
  if(data?.gpuq?.stale!==false)return '采集状态未更新，请先刷新。';
  if(host?.reachable!==true)return '服务器是否可达尚未确认。';
  if(host?.hostCommand?.version!==1||host.hostCommand.available!==true)return '这台服务器未开启只读诊断。';
  return '';
}
export const rootQueueHint='ROOT 不能直接查询调度队列，请用平台任务视图';
export const rootQueueForbidden=text=>/FORBIDDEN: peer uid is not allowed|"code"\s*:\s*"FORBIDDEN"[\s\S]{0,160}"message"\s*:\s*"peer uid is not allowed/.test(text);
export function hostCommandOutput(receipt){
  const visible=value=>String(value??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>['\n','\t'].includes(c)?c:'\\u{'+c.codePointAt(0).toString(16).padStart(4,'0')+'}');
  const stdout=visible(receipt?.stdout),stderr=visible(receipt?.stderr);
  return [stdout,stderr?'错误输出\n'+stderr:''].filter(Boolean).join('\n\n');
}

// The node helper binds id === key before launch (admin-command.py).
// Persist the key before dispatch; recovery only reads this handle, never exec.
export function hostDiagnosticsUI(store,{toast=()=>{}}={}){
  const root=document.createElement('section');root.id='admin-host-diagnostics';root.className='host-diagnostics';
  let ctx=null,machine='',selected=null,receipt=null,error='',checking=false,writing=false,timer=null,serial=0,confirmation=null;
  const active=stamp=>!!stamp&&stamp===ctx&&!stamp.signal.aborted&&!store.authPending&&
    store.principal?.role==='admin'&&store.principal.userId===stamp.principal.userId;
  const storageKey=(actor,target)=>'stargate.host-commands.v1:'+actor+':'+target;
  function records(actor,target){
    try{const value=JSON.parse(localStorage.getItem(storageKey(actor,target))||'[]');return Array.isArray(value)?value.filter(row=>hostCommandId.test(row.id)&&row.key===row.id&&typeof row.title==='string'):[];}catch{return [];}
  }
  function save(actor,target,record){
    const rows=records(actor,target),index=rows.findIndex(row=>row.id===record.id);
    if(index<0)rows.unshift(record);else rows[index]=record;
    localStorage.setItem(storageKey(actor,target),JSON.stringify(rows));
  }
  function updateRecord(actor,target,record){
    try{save(actor,target,record);return '';}catch{return '本地记录未更新，原请求编号仍已保存。';}
  }
  const available=()=>active(ctx)?hostDiagnosticAvailability(store.data,machine):'需要管理员权限。';
  const stop=()=>{clearTimeout(timer);timer=null;};
  const current=(stamp,target,id,turn)=>active(stamp)&&machine===target&&selected?.id===id&&turn===serial;
  function paint(){
    if(!active(ctx))return;
    const reason=available(),q=selector=>root.querySelector(selector),rows=records(ctx.principal.userId,machine);
    q('[data-host-unavailable]').textContent=reason;q('[data-host-unavailable]').hidden=!reason;
    for(const button of root.querySelectorAll('[data-host-preset],[data-host-query],[data-host-recent],#maintenance-host-form [type=submit]'))button.disabled=!!reason||writing||checking;
    q('[data-host-machine]').value=machine;q('[data-host-machine]').title=machine;q('[data-host-machine]').disabled=writing;
    q('[data-host-error]').textContent=error;
    q('[data-host-state]').textContent=rootQueueForbidden([receipt?.stdout,receipt?.stderr].join('\n'))?'请用平台任务视图':selected?(labels[selected.state]||'结果待确认'):'选择一项只读诊断';
    q('[data-host-reference]').hidden=!selected;
    q('[data-host-reference] code').textContent=selected?selected.id.slice(0,8)+'…'+selected.id.slice(-4):'';
    q('[data-host-reference] code').title=selected?.id||'';
    const cancel=q('[data-host-cancel]');cancel.hidden=!selected||hostCommandTerminal.has(selected.state);cancel.disabled=!!reason||writing||checking||selected?.cancelRequested===true;
    q('[data-host-query]').hidden=!selected;
    const output=hostCommandOutput(receipt),pre=q('[data-host-receipt]');pre.textContent=output||'尚无输出';
    q('[data-host-copy-output]').disabled=!output;
    q('[data-host-output-note]').textContent=receipt?.truncated?.stdout||receipt?.truncated?.stderr?'节点已截断输出，每路最多 64 KiB。':'';
    q('[data-host-exit]').textContent=Number.isInteger(receipt?.exitCode)?'退出码 '+receipt.exitCode:'';
    q('[data-host-native-note]').hidden=!rootQueueForbidden([receipt?.stdout,receipt?.stderr].join('\n'));
    const list=q('[data-host-recent-list]'),signature=JSON.stringify(rows.map(row=>[row.id,row.title,row.state]));
    if(list.dataset.rows!==signature){list.dataset.rows=signature;list.innerHTML=rows.map(row=>`<button type="button" class="button quiet host-recent-operation" data-host-recent="${esc(row.id)}" ${reason||checking||writing?'disabled':''}><span>${esc(row.title)}</span><span>${esc(labels[row.state]||'结果待确认')}</span><code title="${esc(row.id)}">${esc(row.id.slice(0,8))}</code></button>`).join('')||'<p class="muted">本浏览器尚无操作记录。</p>';}
  }
  function poll(){
    stop();if(!active(ctx)||!selected||hostCommandTerminal.has(selected.state)||available())return;
    timer=setTimeout(()=>query(selected.id),selected.state==='UNKNOWN'?4000:1500);
  }
  function accept(value,id){
    if(value?.id!==id||value.key!==undefined&&value.key!==id||typeof value.state!=='string')throw Error('命令回执不匹配，结果待确认。');
    return value;
  }
  async function query(id){
    if(!active(ctx)||checking||writing||available()||!hostCommandId.test(id))return;
    stop();const stamp=ctx,target=machine,turn=++serial,actor=stamp.principal.userId;
    const known=records(actor,target).find(row=>row.id===id);
    if(selected?.id!==id)receipt=null;
    selected=known||{id,key:id,title:'按编号查询',state:'UNKNOWN'};error='';checking=true;paint();
    try{
      const value=accept(await store.call('host.status',{machine:target,id},{signal:stamp.signal}),id);
      if(!current(stamp,target,id,turn))return;
      selected={...selected,state:value.state,cancelRequested:value.cancelRequested===true};receipt=value;
      if(known)error=updateRecord(actor,target,selected);
      if(value.state==='UNKNOWN')error='结果待确认，请继续查询原编号；命令不会自动重发。';
    }catch(e){if(current(stamp,target,id,turn))error=e.status===404?'节点已无法查询此编号；未重新执行命令。':e.message;}
    finally{if(current(stamp,target,id,turn)){checking=false;paint();poll();}}
  }
  async function execute(preset){
    if(!active(ctx)||writing||checking||available())return;
    stop();const stamp=ctx,target=machine,actor=stamp.principal.userId,id=crypto.randomUUID(),turn=++serial;
    const record={id,key:id,title:preset.title,argv:[...preset.argv],createdAt:new Date().toISOString(),state:'SUBMITTING'};
    try{save(actor,target,record);}catch{error='无法保存请求编号，未执行诊断。请允许本地存储后重试。';paint();return;}
    selected=record;receipt=null;writing=true;error='';paint();
    try{
      const value=accept(await store.call('host.exec',{machine:target,key:id,argv:[...preset.argv],cwd:'/root',timeoutSec:60},{signal:stamp.signal}),id);
      const confirmed={...record,state:value.state,cancelRequested:value.cancelRequested===true},storageError=updateRecord(actor,target,confirmed);
      if(current(stamp,target,id,turn)){selected=confirmed;receipt=value;error=storageError;}
    }catch(e){
      const unknown={...record,state:'UNKNOWN'};updateRecord(actor,target,unknown);
      if(current(stamp,target,id,turn)){selected=unknown;error='请求回执未确认，仅查询原编号。'+e.message;}
    }finally{
      if(current(stamp,target,id,turn)){writing=false;paint();if(selected.state==='UNKNOWN')await query(id);else poll();}
    }
  }
  async function cancel(){
    if(!active(ctx)||!selected||writing||checking||available()||selected.cancelRequested||hostCommandTerminal.has(selected.state))return;
    stop();const stamp=ctx,target=machine,id=selected.id,turn=++serial,actor=stamp.principal.userId;
    writing=true;error='';paint();
    try{
      const value=accept(await store.call('host.cancel',{machine:target,id},{signal:stamp.signal}),id);
      if(!current(stamp,target,id,turn))return;
      selected={...selected,state:value.state,cancelRequested:value.cancelRequested===true};receipt=value;
      if(records(actor,target).some(row=>row.id===id))error=updateRecord(actor,target,selected);
    }catch(e){if(current(stamp,target,id,turn))error='停止结果待确认；请查询原编号。'+e.message;}
    finally{if(current(stamp,target,id,turn)){writing=false;paint();poll();}}
  }
  function confirm(title,content,action){
    if(!active(ctx)||writing||checking||available())return;
    const stamp=ctx,target=machine;confirmation={stamp,target,action};
    const dialog=root.querySelector('#host-command-confirm');
    dialog.querySelector('h2').textContent=title;dialog.querySelector('[data-host-confirm-machine]').innerHTML=serverIdHTML(machine);
    dialog.querySelector('pre').textContent=content;dialog.showModal();
  }
  function select(target){
    if(!active(ctx)||writing)return;
    if(!target){stop();machine='';selected=null;receipt=null;paint();return;}
    if(!store.data?.machines?.some(row=>row.id===target))return;
    stop();serial++;checking=false;machine=target;receipt=null;error='';
    selected=records(ctx.principal.userId,machine)[0]||null;paint();if(selected&&!available())query(selected.id);
  }
  function mount(el,context){
    ctx=context;el.append(root);
    root.innerHTML=`<div class="host-diagnostics-heading"><div class="copy-caption"><h3>主机诊断</h3>${copyHelp('只读诊断','由管理员确认后执行固定命令，节点保存并审计请求。回执未确认时只查询原编号，不会自动重复执行。')}</div><label>服务器<select data-host-machine></select></label></div><p role="status" data-host-unavailable></p><div class="host-diagnostic-presets">${hostDiagnosticPresets.map(preset=>`<button type="button" class="button" data-host-preset="${preset.id}">${preset.title}</button>`).join('')}</div><div class="host-command-result"><div class="host-command-status"><strong data-host-state></strong><span data-host-exit></span><span data-host-reference hidden><code></code><button type="button" class="button quiet" data-host-copy-id>复制编号</button></span></div><p class="form-error" role="alert" data-host-error></p><pre tabindex="0" aria-label="诊断输出" data-host-receipt></pre><p class="muted" data-host-output-note></p><p class="host-native-note" role="status" data-host-native-note hidden>${rootQueueHint}</p><div class="host-command-actions"><button type="button" class="button quiet" data-host-copy-output disabled>复制结果</button><button type="button" class="button" data-host-query hidden>重新查询</button><button type="button" class="button danger" data-host-cancel hidden>停止诊断</button></div></div><details class="host-recent"><summary>最近的操作 ${copyHelp('最近操作','只列出本浏览器中由当前管理员发起的操作。换账号不会读取旧账号的编号。')}</summary><div data-host-recent-list></div></details><details class="host-lookup"><summary>按编号查询</summary><form id="maintenance-host-form"><label>命令编号<input name="commandId" required spellcheck="false" autocomplete="off" pattern="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}" placeholder="完整 UUID"></label><button type="submit" class="button">查询命令状态</button></form></details><dialog id="host-command-confirm" class="modal" aria-labelledby="host-command-confirm-title"><h2 id="host-command-confirm-title"></h2><div data-host-confirm-machine></div><pre aria-label="确认命令原文"></pre><div class="modal-actions"><button type="button" class="button" data-host-confirm-close>取消</button><button type="button" class="button primary" data-host-confirm-apply>确认执行</button></div></dialog>`;
    const q=selector=>root.querySelector(selector),dialog=q('#host-command-confirm');
    root.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button||button.disabled||!active(ctx))return;
      if(button.dataset.hostPreset){const preset=hostDiagnosticPresets.find(row=>row.id===button.dataset.hostPreset);if(preset)confirm('确认只读诊断',preset.argv.join(' '),()=>execute(preset));}
      else if(button.hasAttribute('data-host-confirm-close')){confirmation=null;dialog.close();}
      else if(button.hasAttribute('data-host-confirm-apply')){const pending=confirmation;confirmation=null;dialog.close();if(pending&&active(pending.stamp)&&pending.target===machine)await pending.action();}
      else if(button.dataset.hostRecent)await query(button.dataset.hostRecent);
      else if(button.hasAttribute('data-host-query'))await query(selected?.id);
      else if(button.hasAttribute('data-host-cancel'))confirm('停止这次诊断？','停止 '+(selected?.title||'原编号诊断')+'；不会重新执行命令。',cancel);
      else if(button.hasAttribute('data-host-copy-id')||button.hasAttribute('data-host-copy-output')){
        try{await navigator.clipboard.writeText(button.hasAttribute('data-host-copy-id')?selected.id:hostCommandOutput(receipt));if(active(ctx))toast('已复制');}catch{if(active(ctx))toast('复制未完成，请选中文字复制。');}
      }
    },{signal:context.signal});
    q('[data-host-machine]').addEventListener('change',event=>select(event.target.value),{signal:context.signal});
    q('#maintenance-host-form').addEventListener('submit',event=>{event.preventDefault();query(event.target.elements.commandId.value);},{signal:context.signal});
    dialog.addEventListener('cancel',()=>{confirmation=null;},{signal:context.signal});
    context.subscribe(()=>{
      if(!active(context))return;
      const machines=store.data?.machines||[],selector=q('[data-host-machine]'),signature=JSON.stringify(machines.map(row=>row.id));
      if(selector.dataset.rows!==signature){selector.dataset.rows=signature;selector.innerHTML=machines.map(row=>`<option value="${esc(row.id)}">${esc(row.id)}</option>`).join('');}
      if(!machines.some(row=>row.id===machine))select(machines[0]?.id||'');else{paint();if(!timer&&!checking&&!writing)poll();}
    });
  }
  function unmount(){stop();serial++;ctx=null;confirmation=null;root.querySelector('dialog')?.close();root.replaceChildren();root.remove();machine='';selected=null;receipt=null;error='';writing=false;checking=false;}
  return {mount,unmount,select};
}
