import {createDatasetFullDeletion,fullDeleteActions,fullDeleteTarget,fullDeleteStepLabel} from './dataset-full-delete-state.js';
import {serverIdHTML} from './workbench-ui.js';
import {copyHelp} from './copy-help-ui.js';
import {fadeDialog} from './motion-ui.js';
import {mountFullDeleteTasks} from './dataset-full-delete-tasks.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={SUBMITTING:'正在提交',PLANNED:'正在核对副本',RUNNING:'正在删除',REMOVING_CACHES:'正在删除缓存',RETIRING_ORIGINAL:'正在删除原件',DELETED:'已删除',BLOCKED:'暂不能删除',FAILED:'删除未完成',UNKNOWN:'删除结果待确认',WAITING_CONTINUE:'等待管理员继续',CANCELING:'正在取消并恢复',CANCELED:'已取消删除'};
let dialogSerial=0;
const stamp=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'时间未确认':date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});};
const shape=state=>state==='DELETED'?'st-done':state==='CANCELED'?'st-stop':['BLOCKED','FAILED'].includes(state)?'st-err':state==='UNKNOWN'?'st-unk':state==='WAITING_CONTINUE'?'st-stop':'st-busy';
const status=(state,label)=>`<span class="st ${shape(state)}"><span class="g" aria-hidden="true"></span>${esc(label||labels[state]||'状态待确认')}</span>`;

// The data-room owns the entry and catalog. This module owns only its dialog,
// original-key journal and status/action lifecycle; it does not add page layout.
export function datasetFullDeleteUI(store,{catalog=()=>null,reload=()=>{},storage,management=true}={}){
  if(storage===undefined)try{storage=globalThis.localStorage;}catch{}
  let dialog=null,target=null,view='confirm',action=null,opener=null,account=null,notice='',dialogScope=null;
  const listeners=new Set(),lists=new Set();
  const notify=()=>{render();for(const listener of listeners)listener();};
  const visible=()=>!document.hidden&&(!!dialog?.open&&current()||[...lists].some(allowed=>allowed()));
  const sync=()=>api.sync(visible());
  const api=createDatasetFullDeletion({principal:()=>store.principal,session:()=>store.authGeneration,catalog,management,call:(...args)=>store.call(...args),storage,changed:notify,completed:()=>{if(visible())reload();}});
  function ensureStyle(){
    if(!document.querySelector('link[data-dataset-remove-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/dataset-remove.css';link.dataset.datasetRemoveStyle='';document.head.append(link);}
  }
  function ensureDialog(){
    if(dialog?.isConnected)return;ensureStyle();
    const suffix=dialogSerial++?'-'+dialogSerial:'';
    dialog=document.createElement('dialog');dialog.className='modal dataset-full-delete-dialog';dialog.id='dataset-full-delete-dialog'+suffix;dialog.setAttribute('aria-labelledby','dataset-full-delete-title'+suffix);
    dialog.innerHTML=`<header class="modal-head"><h2 id="dataset-full-delete-title${suffix}">彻底删除数据集</h2><button class="button quiet" type="button" data-full-delete-close aria-label="关闭彻底删除对话框">关闭</button></header><div data-full-delete-content></div>`;
    document.body.append(dialog);
    dialog.addEventListener('close',()=>{if(dialog.open)return;target=null;action=null;notice='';dialogScope=null;sync();if(opener?.isConnected&&!opener.disabled)opener.focus();});
    dialog.addEventListener('input',event=>{if(event.target.name==='full-delete-name'){const button=dialog.querySelector('[data-full-delete-submit]');if(button)button.disabled=event.target.value!==target?.dataset;}});
    dialog.addEventListener('submit',async event=>{
      event.preventDefault();if(!current())return;
      if(view==='confirm'){
        if(dialog.querySelector('[name=full-delete-name]')?.value!==target.dataset)return;
        view='task';notice='';
        try{await api.submit(target.dataset,target.version);}catch(error){notice=error.message;view='confirm';}render();
      }else if(view==='action'){
        const row=api.find(target.dataset,target.version),intent=action;
        if(!row||!intent)return;const machine=dialog.querySelector('[name=full-delete-restore-machine]')?.value;
        view='task';action=null;notice='';
        try{await api.act(row.key,intent,machine);}catch(error){notice=error.message;}render();
      }
    });
    dialog.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.hasAttribute('data-full-delete-close')){dialog.close();return;}
      if(!current())return;
      if(button.dataset.fullDeleteCopy){
        try{await navigator.clipboard.writeText(button.dataset.fullDeleteCopy);button.textContent='已复制';}
        catch{notice='未能复制，请手动复制：'+button.dataset.fullDeleteCopy;render();}return;
      }
      if(button.hasAttribute('data-full-delete-back')){view='task';action=null;notice='';render();return;}
      const row=target&&api.find(target.dataset,target.version);
      if(button.hasAttribute('data-full-delete-query')&&row){notice='';await api.query(row.key);render();}
      if(button.dataset.fullDeleteAction&&row){view='action';action=button.dataset.fullDeleteAction;notice='';render();}
    });
  }
  function current(){return target&&(!dialogScope||dialogScope())&&account===JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);}
  function facts(){return `<dl class="full-delete-facts"><div><dt>数据集</dt><dd><code>${esc(target.dataset)}</code></dd></div><div><dt>版本</dt><dd><code title="${esc(target.version)}">${esc(target.version.slice(0,12))}</code></dd></div></dl>`;}
  function errorHTML(){return notice?`<p class="form-error" role="alert">${esc(notice)}</p>`:'';}
  function render(){
    if(!dialog?.open||!target)return;
    if(!current()){dialog.close();return;}
    const body=dialog.querySelector('[data-full-delete-content]'),row=api.find(target.dataset,target.version);
    if(view==='confirm'){
      // Status reads for another saved task must not erase a name being typed.
      if(body.querySelector('[name=full-delete-name]')&&!notice)return;
      body.innerHTML=`<form>${facts()}<p class="full-delete-warning">删除此版本的原件和缓存，7 天内可由管理员恢复。</p><p class="full-delete-notice">其他名称下的副本不受影响</p><label class="full-delete-name"><span class="copy-caption"><span>输入数据集名称</span>${copyHelp('彻底删除范围','所有服务器上此名称的选中版本都会删除，不删除其他版本或其他名称的副本。服务器会再次核对权限、使用情况和完整副本。')}</span><input name="full-delete-name" autocomplete="off" spellcheck="false" required aria-label="输入数据集名称" placeholder="${esc(target.dataset)}"></label>${errorHTML()}<footer class="modal-actions"><button class="button" type="button" data-full-delete-close>保留数据</button><button class="button danger" type="submit" data-full-delete-submit disabled>彻底删除</button></footer></form>`;
      return;
    }
    if(!row){view='confirm';render();return;}
    const busy=api.isBusy(row.key),actions=catalog()?.datasetDelete===1?fullDeleteActions(row,store.principal,management):[];
    if(view==='action'){
      if(!actions.includes(action)){view='task';action=null;render();return;}
      const sources=row.task.steps.filter(step=>step.complete===true&&step.retainUntil),machines=[...new Set(sources.map(step=>step.machine))].filter(machine=>sources.filter(step=>step.machine===machine).length===1);
      const text=action==='cancel'?'停止后续删除，并恢复已移入保留区的数据。':action==='restore'?'从保留的完整副本恢复，不覆盖已有同名数据。':'沿用原编号，继续服务器已确认可以重试的步骤。';
      const button={cancel:'取消删除并恢复',restore:'恢复数据',continue:'继续删除'}[action];
      body.innerHTML=`<form>${facts()}<h3>${esc(button)}？</h3><p class="full-delete-warning">${text}</p>${action==='cancel'?'<p class="full-delete-notice">正在执行的步骤会先完成，不会强制中断。</p>':''}${action==='restore'?`<label class="full-delete-name">完整副本所在服务器<select name="full-delete-restore-machine" aria-label="完整副本所在服务器">${machines.map(machine=>`<option value="${esc(machine)}">${esc(machine)}</option>`).join('')}</select></label>`:''}${errorHTML()}<footer class="modal-actions"><button class="button" type="button" data-full-delete-back>返回状态</button><button class="button ${action==='continue'?'danger':'primary'}" type="submit">${esc(button)}</button></footer></form>`;
      return;
    }
    const stepHTML=(row.task?.steps||[]).map(step=>`<li><div class="full-delete-step-name">${serverIdHTML(step.machine)}<span>${esc(fullDeleteStepLabel(step,row.copyRoles))}</span></div><span class="full-delete-step-state">${esc(step.restoreState==='RESTORED'?'已恢复':step.restoreState==='RELEASED'?'已解除保护':step.state==='ISOLATED'?'已移入保留区':step.state==='PURGED'?'保留数据已清理':step.state==='FAILED'?'失败':step.state==='UNKNOWN'?'待确认':step.state==='ABSENT'?'原本没有此版本':step.state==='PLANNED'?'待执行':step.state==='COMMITTED'?'已确认':step.state==='RESTORED'?'已恢复':step.state==='CANCELED'?'已取消':'进行中')}</span></li>`).join('');
    const ordinary=!management||store.principal?.role!=='admin',needsAdmin=ordinary&&['WAITING_CONTINUE','BLOCKED','UNKNOWN'].includes(row.state);
    const retained=row.confirmed&&row.state==='DELETED'?`${ordinary?`<p class="full-delete-notice full-delete-retention">如需恢复，请联系管理员（${row.task.retainUntil?'保留至 '+esc(stamp(row.task.retainUntil)):'保留期限未确认'}）</p>`:`<dl class="full-delete-facts full-delete-retention"><div><dt>可恢复至</dt><dd>${row.task.retainUntil?`<time datetime="${esc(row.task.retainUntil)}">${esc(stamp(row.task.retainUntil))}</time>`:'恢复期限未确认'}</dd></div></dl>`}<p class="full-delete-notice">其他名称下的副本不受影响</p>`:'';
    const reference=row.operationId?`<dl class="full-delete-facts full-delete-reference"><div><dt>请求编号</dt><dd><code title="${esc(row.operationId)}">${esc(row.operationId.slice(0,8)+'…'+row.operationId.slice(-4))}</code><button class="button quiet" type="button" data-full-delete-copy="${esc(row.operationId)}" aria-label="复制完整请求编号">复制</button></dd></div></dl>`:'';
    body.innerHTML=`${facts()}<div class="full-delete-status copy-caption" role="status">${status(row.state,row.pendingAction==='restore'?'正在恢复':row.pendingAction==='continue'?'正在请求继续':row.pendingAction==='cancel'?'正在请求取消':null)}${row.state==='UNKNOWN'?copyHelp('删除结果待确认','请求结果未确认，只会按原请求编号查询。请勿创建新编号或重复删除。'):''}</div>${row.error?`<p class="form-error" role="alert">${esc(row.error)}</p>`:''}${errorHTML()}${needsAdmin?'<p class="full-delete-notice">需要管理员处理</p>':''}${row.state==='WAITING_CONTINUE'&&row.task?.canContinue!==true?'<p class="full-delete-notice">服务器仍在处理原步骤，请先重新查询。</p>':''}${retained}${stepHTML?`<ol class="full-delete-steps" aria-label="删除步骤">${stepHTML}</ol>`:''}${reference}<footer class="modal-actions"><button class="button" type="button" data-full-delete-query ${busy?'disabled':''}>${busy?'正在查询…':'重新查询'}</button>${actions.map(item=>`<button class="button ${item==='continue'?'danger':'quiet'}" type="button" data-full-delete-action="${item}" ${busy?'disabled':''}>${{continue:'继续删除',cancel:'取消删除',restore:'恢复数据'}[item]}</button>`).join('')}</footer>`;
  }
  function present(dataset,version,recordOnly=false,scope=null){
    fullDeleteTarget(dataset,version);
    const record=api.find(dataset,version);
    if(recordOnly?!record:!api.canOpen(dataset,version))return false;
    if(dialog?.open)dialog.close();
    opener=document.activeElement;account=JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);target={dataset,version};dialogScope=scope;view=record?'task':'confirm';action=null;notice='';
    ensureDialog();dialog.querySelector('[data-full-delete-content]').replaceChildren();dialog.showModal();api.sync(true);render();fadeDialog(dialog);
    if(view==='confirm')dialog.querySelector('[name=full-delete-name]')?.focus();return true;
  }
  store.onAuthChange?.(()=>{dialog?.close();api.sync(false);notify();});
  document.addEventListener('visibilitychange',sync);
  const openRecord=(key,scope=null)=>{if(scope&&!scope())return false;const row=api.sync().find(item=>item.key===key);return row?present(row.dataset,row.version,true,scope):false;};
  const actions=row=>catalog()?.datasetDelete===1?fullDeleteActions(row,store.principal,management):[];
  return {canOpenFullDelete:(dataset,version)=>api.canOpen(dataset,version),openFullDelete:(dataset,version)=>present(dataset,version),
    openFullDeleteRecord:openRecord,
    mountTasks(host,options){
      if(!management)return {refresh:()=>{},render:()=>{},destroy:()=>{}};
      ensureStyle();return mountFullDeleteTasks(host,{store,records:()=>{sync();return api.rows;},actions,status:row=>status(row.state),isBusy:api.isBusy,query:api.query,openRecord,
        openAction(key,intent,scope){const row=api.sync().find(value=>value.key===key);if(!row||!actions(row).includes(intent)||!openRecord(key,scope))return false;view='action';action=intent;render();return true;},
        subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
        syncVisibility(allowed){lists.add(allowed);sync();return ()=>{lists.delete(allowed);sync();};},
        updateVisibility:sync,
        closeScope(scope){if(dialogScope===scope)dialog?.close();},
      },options);
    },
    get records(){api.sync();return api.rows;}};
}
