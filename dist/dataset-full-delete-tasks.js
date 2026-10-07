const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// The host owns where this panel sits. This adapter owns only local-account
// records and the existing confirmed action dialogs, never a new deletion.
export function mountFullDeleteTasks(host,{store,records,actions,status,isBusy,query,openRecord,openAction,subscribe,syncVisibility,updateVisibility,closeScope},{signal,active=()=>true}={}){
  const actor=JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  let disposed=false,busy=false;
  const allowed=()=>!disposed&&!signal?.aborted&&!store.authPending&&host.isConnected&&!host.parentElement?.closest('[hidden]')&&active()&&document.body.dataset.room==='admin'&&store.principal?.role==='admin'&&actor===JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  function render(){
    updateVisibility();
    if(!allowed()){host.replaceChildren();host.hidden=true;return;}
    const rows=records();host.hidden=!rows.length;if(!rows.length){host.replaceChildren();return;}
    host.classList.add('full-delete-tasks');
    const entries=rows.map(row=>`<article class="full-delete-task" data-delete-task="${esc(row.key)}"><div class="full-delete-task-heading"><strong><code title="${esc(row.dataset)}">${esc(row.dataset)}</code></strong>${status(row)}</div><code class="full-delete-task-version" title="${esc(row.version)}">${esc(row.version.slice(0,12))}</code>${row.error?`<p class="form-error" role="alert">${esc(row.error)}</p>`:''}<div class="full-delete-task-actions"><button class="button quiet" type="button" data-delete-task-query ${busy||isBusy(row.key)?'disabled':''}>重新查询</button><button class="button quiet" type="button" data-delete-task-details>查看步骤</button>${actions(row).map(action=>`<button class="button ${action==='continue'?'danger':'quiet'}" type="button" data-delete-task-action="${action}" ${busy||isBusy(row.key)?'disabled':''}>${{continue:'继续删除',cancel:'取消删除',restore:'恢复数据'}[action]}</button>`).join('')}</div></article>`).join('');
    host.innerHTML=`<div class="full-delete-task-controls"><span>本浏览器的删除记录</span><button class="button" type="button" data-delete-tasks-refresh ${busy?'disabled':''}>${busy?'正在查询…':'重新查询'}</button></div>${entries}`;
  }
  async function refresh(){
    if(!allowed()||busy)return;busy=true;render();
    try{for(const row of records()){if(!allowed())break;await query(row.key);}}
    finally{busy=false;if(allowed())render();}
  }
  const controller=new AbortController();
  host.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!allowed()||!button||button.disabled)return;
    if(button.hasAttribute('data-delete-tasks-refresh')){await refresh();return;}
    const key=button.closest('[data-delete-task]')?.dataset.deleteTask;if(!key)return;
    if(button.hasAttribute('data-delete-task-query'))await query(key);
    else if(button.hasAttribute('data-delete-task-details'))openRecord(key,allowed);
    else if(button.dataset.deleteTaskAction)openAction(key,button.dataset.deleteTaskAction,allowed);
    if(allowed())render();
  },{signal:controller.signal});
  const remove=subscribe(render),removeVisibility=syncVisibility(allowed);
  const visibility=new MutationObserver(render);
  visibility.observe(document.body,{attributes:true,attributeFilter:['data-room','hidden']});
  for(let parent=host.parentElement;parent;parent=parent.parentElement)if(parent!==document.body)visibility.observe(parent,{attributes:true,attributeFilter:['hidden']});
  function destroy(){if(disposed)return;disposed=true;controller.abort();visibility.disconnect();remove();removeVisibility();signal?.removeEventListener('abort',destroy);closeScope(allowed);host.replaceChildren();host.hidden=true;}
  if(signal?.aborted)destroy();else{signal?.addEventListener('abort',destroy,{once:true});render();}
  return {refresh,render,destroy};
}
