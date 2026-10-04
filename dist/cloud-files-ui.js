const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label={QUEUED:'等待传输',RUNNING:'传输中',CANCELING:'正在停止',CANCELED:'已停止',PAUSED:'可续传',FAILED:'需检查',VERIFYING:'待云端确认',VERIFIED:'已在云端确认',READY:'已保存到数据空间'};
export function cloudFilesRows(rows){
  return rows.map(r=>`<li><code>${esc(r.name||r.path||r.operationId)}</code><span>${esc(label[r.state]||r.state)}${r.totalBytes?` · ${(Number(r.bytes||0)/1024**2).toFixed(1)} / ${(Number(r.totalBytes)/1024**2).toFixed(1)} MiB`:''}</span><small>${esc(r.operationId)}</small><div class="file-actions">${r.action==='upload'&&r.state==='VERIFYING'?`<button class="button" type="button" data-cloud-verify="${esc(r.operationId)}">检查云端</button>`:''}${r.action==='upload'&&r.state==='VERIFIED'?`<button class="button" type="button" data-cloud-restore="${esc(r.operationId)}" data-cloud-name="${esc(r.name)}">取回到数据空间</button>`:''}${['QUEUED','RUNNING','CANCELING'].includes(r.state)?`<button class="button" type="button" data-cloud-cancel="${esc(r.operationId)}">停止</button>`:''}</div>${r.error?`<p>${esc(r.error)}</p>`:''}</li>`).join('')||'<li>还没有云文件。先将压缩包整理到个人数据空间。</li>';
}
export function cloudFilesHTML(){return `<details class="data-workspace-browser"><summary>云端副本</summary><p class="muted">把已整理的文件保存到平台云盘，或取回到个人数据空间。只有你能查看这些副本；不会向你提供管理员的网盘账号。此通道由存储节点直接传输，不经 VPS。</p><form id="cloud-files-form"><label class="field">个人 /data2 中的文件<input name="cloud-files-path" placeholder="incoming/data.tar" required></label><div class="file-actions"><button class="button" type="submit">存到云端</button><button class="button" id="cloud-files-refresh" type="button">刷新</button></div></form><p id="cloud-files-status" role="status">请先结束数据终端。云端确认前，务必保留本地原件。</p><ul id="cloud-files-list"></ul></details>`;}
export function cloudFilesUI(store,section,toast){
  let busy=false,epoch=0;const pending=new Map();const $=s=>section.querySelector(s),machine=()=>$('[name=dataset-machine]')?.value;
  const scope=()=>JSON.stringify([store.principal?.userId,machine()]);
  const context=()=>JSON.stringify([store.principal?.userId,store.authGeneration,machine(),epoch]);
  async function run(fn){if(busy||!store.production||!store.principal||!machine())return;busy=true;const expected=context();const current=()=>{if(expected!==context())throw Error('账号或服务器已改变。');};
    const call=async(op,args)=>{current();const r=await store.call(op,{machine:machine(),...args});current();return r;};
    try{await fn(call,current);}catch(e){if(expected===context()){$('#cloud-files-status').textContent=e.message;toast(e.message);}}finally{if(expected===context())busy=false;}}
  async function refresh(call){const info=await call('cloud.files.info',{});if(!info.enabled){$('#cloud-files-status').textContent='这台机器尚未开通云文件；请使用指定存储节点或校内直传。';$('#cloud-files-list').replaceChildren();return;}const held=pending.get(scope());if(held){try{const r=await call('cloud.files.status',{operationId:held.key});if(r.operationId!==held.key)throw Error('操作编号不匹配');pending.delete(scope());$('#cloud-files-status').textContent='已找到原操作 '+held.key+'，未重复提交。';}catch{throw Error('原操作 '+held.key+' 还未确认，请稍后刷新或联系管理员；暂不创建第二个上传。');}}const result=await call('cloud.files.list',{});$('#cloud-files-list').innerHTML=cloudFilesRows(result.files||[]);}
  async function start(call,action,args){
    if(args.path!==undefined&&(typeof args.path!=='string'||!args.path||args.path.length>1024||/[\\\x00-\x1f\x7f]/.test(args.path)||args.path.split('/').some(p=>!p||p==='.'||p==='..'||new TextEncoder().encode(p).length>255)))throw Error('请填写个人 /data2 内的相对文件路径。');
    const s=scope(),held=pending.get(s);
    if(held&&(held.action!==action||JSON.stringify(held.args)!==JSON.stringify(args)))throw Error('有未确认的云操作，请先核对原编号；不要另建上传。');
    const key=held?.key||crypto.randomUUID();pending.set(s,{key,action,args});$('#cloud-files-status').textContent='操作编号 '+key+'；响应中断后再次提交同一文件会使用原编号，不会另建上传。';
    const result=await call('cloud.files.'+action,{key,...args});
    if(result.operationId!==key)throw Error('节点没有确认原操作编号。');
    pending.delete(s);$('#cloud-files-status').textContent='已提交 '+result.operationId+'。可离开页面，稍后刷新。';await refresh(call);
  }
  section.addEventListener('submit',e=>{if(e.target.id!=='cloud-files-form')return;e.preventDefault();run(call=>start(call,'upload',{path:$('[name=cloud-files-path]').value.trim()}));});
  section.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.id==='cloud-files-refresh')return run(refresh);
    if(b.dataset.cloudVerify)return run(call=>start(call,'verify',{fileId:b.dataset.cloudVerify}));
    if(b.dataset.cloudRestore){const path=window.prompt('保存到个人 /data2 的相对路径；不会覆盖同名文件：','restored/'+b.dataset.cloudName);if(path)return run(call=>start(call,'download',{fileId:b.dataset.cloudRestore,path:path.trim()}));}
    if(b.dataset.cloudCancel)return run(async call=>{await call('cloud.files.cancel',{operationId:b.dataset.cloudCancel});await refresh(call);});});
  section.addEventListener('change',e=>{if(e.target.name==='dataset-machine'){epoch++;busy=false;$('#cloud-files-list')?.replaceChildren();}});
  return {reset(){epoch++;busy=false;$('#cloud-files-list')?.replaceChildren();}};
}
