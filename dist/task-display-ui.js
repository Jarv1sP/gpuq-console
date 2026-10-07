// Existing task detail only; no submit/owner/command/lifecycle editing.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nativeId=/^J[a-f0-9]{12}$/,revision=/^[a-f0-9]{64}$/;
export function taskLabelEditorHTML(job,principal){
  if(!job||job.source==='native'||!nativeId.test(job.nodeJobId||'')||!(principal?.role==='admin'||principal?.userId===job.userId))return '';
  return `<details class="task-label-editor" data-task-label-editor data-machine="${esc(job.machine)}" data-node-job="${esc(job.nodeJobId)}"><summary>显示名称与描述</summary><p>只改显示信息，原命令、资源和训练状态不变。</p><button class="button quiet" type="button" data-task-label-read>读取当前标签</button><form data-task-label-form hidden><label>名称<input name="task-label-name" maxlength="64" required></label><label>描述<textarea name="task-label-description" maxlength="2000" rows="3"></textarea></label><button class="button" type="submit">保存标签</button></form><p role="status" aria-live="polite" data-task-label-status></p></details>`;
}
export function installTaskLabelEditor(store,{toast=()=>{},refresh=()=>store.refresh?.()}={}){
  const states=new WeakMap(),identity=()=>JSON.stringify([store.principal?.userId,store.principal?.role]);
  const context=root=>({machine:root.dataset.machine,nodeJobId:root.dataset.nodeJob});
  const active=(root,actor,entry)=>root.isConnected&&identity()===actor&&states.get(root)===entry;
  const valid=(value,ctx)=>value?.protocol==='task-display-edit-v1'&&value.nodeJobId===ctx.nodeJobId&&value.available===true&&revision.test(value.revision||'')&&typeof value.name==='string'&&typeof value.description==='string';
  const call=async(root,setting)=>{
    const actor=identity(),ctx=context(root),previous=states.get(root);
    if(previous?.busy)return;
    const status=root.querySelector('[data-task-label-status]'),form=root.querySelector('form'),read=root.querySelector('[data-task-label-read]');
    if(setting&&!previous?.revision){status.textContent='请先读取当前标签。';return;}
    const name=form.elements['task-label-name'].value,description=form.elements['task-label-description'].value;
    const entry={busy:true,revision:previous?.revision};states.set(root,entry);read.disabled=true;for(const item of form.elements)item.disabled=true;
    status.textContent=setting?'正在保存标签…':'正在读取当前标签…';
    try{
      const result=await store.call(setting?'tasks.display.set':'tasks.display.get',{...ctx,...(setting?{name,description,revision:entry.revision}:{})});
      if(!active(root,actor,entry))return;
      if(result?.available===false&&!setting){form.hidden=true;entry.revision=null;status.textContent='节点尚未确认安全编辑能力，暂不能修改。';return;}
      if(!valid(result,ctx))throw Error('标签结果未确认，请读取同一任务。');
      entry.revision=result.revision;form.hidden=false;form.elements['task-label-name'].value=result.name;form.elements['task-label-description'].value=result.description;
      status.textContent=setting?'标签已保存。':'已读取当前标签；修改后保存。';
      if(setting)await refresh();
    }catch(error){if(active(root,actor,entry)){entry.revision=null;status.textContent=error.message+' 请先重新读取原任务，不会自动重发保存。';toast(error.message);}}
    finally{if(active(root,actor,entry)){entry.busy=false;read.disabled=false;for(const item of form.elements)item.disabled=false;form.querySelector('[type=submit]').disabled=!entry.revision;}}
  };
  const click=event=>{const button=event.target.closest('[data-task-label-read]'),root=button?.closest('[data-task-label-editor]');if(root)call(root,false);};
  const submit=event=>{const form=event.target.closest('[data-task-label-form]'),root=form?.closest('[data-task-label-editor]');if(root){event.preventDefault();call(root,true);}};
  document.addEventListener('click',click);document.addEventListener('submit',submit);
  return ()=>{document.removeEventListener('click',click);document.removeEventListener('submit',submit);};
}
