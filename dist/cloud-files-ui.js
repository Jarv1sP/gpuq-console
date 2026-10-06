import {maintenanceFor,restoreMaintenanceControls,disableMaintenanceControls} from './maintenance-state.js';
import {copyHelp} from './copy-help-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label={QUEUED:'等待传输',RUNNING:'传输中',CANCELING:'正在停止',CANCELED:'已停止',PAUSED:'可续传',FAILED:'需检查',VERIFYING:'待云端确认',VERIFIED:'已在云端确认',READY:'已保存到数据空间'};
const shape={QUEUED:'st-queue',RUNNING:'st-run',CANCELING:'st-cancel',CANCELED:'st-stop',PAUSED:'st-queue',FAILED:'st-err',VERIFYING:'st-prep',VERIFIED:'st-done',READY:'st-done'};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identityChanged=row=>row.action==='download'&&row.state==='PAUSED'&&row.errorCode==='CLOUD_FILE_IDENTITY_CHANGED';
const amount=value=>Number.isFinite(value)&&value>=0?(value/1024**2).toFixed(1):'—';
const size=row=>Number.isFinite(row.totalBytes)&&row.totalBytes>=0?`<span class="mono">${row.state==='RUNNING'?amount(row.bytes)+' / ':''}${amount(row.totalBytes)} MiB</span>`:'';
const resumable=row=>row.action==='download'&&['PAUSED','FAILED','CANCELED'].includes(row.state)&&row.canResume===true&&!identityChanged(row)&&uuid.test(row.fileId||'')&&typeof row.path==='string';
export function cloudFilesRows(rows=[]){
  return rows.map(r=>`<li data-cloud-operation="${esc(r.operationId)}"><div class="cloud-file-heading"><code>${esc(r.name||r.path||'云端文件')}</code><span class="st ${shape[r.state]||'st-unk'}"><span class="g" aria-hidden="true"></span>${esc(identityChanged(r)?'文件已变化':r.state==='PAUSED'&&r.canResume!==true?'已暂停':label[r.state]||'状态未确认')}</span></div>${size(r)}<div class="file-actions">${r.action==='upload'&&['VERIFYING','VERIFIED'].includes(r.state)?`<button class="button" type="button" data-cloud-verify="${esc(r.operationId)}">${r.state==='VERIFIED'?'重新校验':'检查云端'}</button>`:''}${r.action==='upload'&&r.state==='VERIFIED'?`<button class="button" type="button" data-cloud-restore="${esc(r.operationId)}" data-cloud-name="${esc(r.name||'file')}">取回到数据空间</button>`:''}${resumable(r)?`<button class="button" type="button" data-cloud-resume="${esc(r.operationId)}">继续取回</button>`:''}${['QUEUED','RUNNING','CANCELING'].includes(r.state)?`<button class="button" type="button" data-cloud-cancel="${esc(r.operationId)}">停止</button>`:''}${identityChanged(r)?'':`<button class="button quiet" type="button" data-cloud-status="${esc(r.operationId)}">重新查询</button>`}</div>${identityChanged(r)?`<div class="cloud-file-error copy-caption"><span>云端文件已变化</span>${copyHelp('文件已变化','请先重新校验该文件，再取回到新的路径。原下载和已有文件会保留，不会自动续传。')}</div>`:r.error?`<p class="cloud-file-error">${esc(r.error)}</p>`:''}<details class="cloud-file-details"><summary><span class="dataset-disclosure-label">操作详情</span></summary><code>${esc(r.operationId)}</code>${r.path?`<p>保存位置 · <code>${esc(r.path)}</code></p>`:''}</details></li>`).join('')||'<li class="muted">还没有云文件。</li>';
}
export function cloudFilesHTML(){return `<details class="data-workspace-browser" id="cloud-files"><summary>云端副本</summary><p class="muted">把服务器上的个人文件存一份到云端。</p><form id="cloud-files-form"><label class="field"><span class="field-caption"><span>服务器上的文件</span>${copyHelp('云端副本','先结束数据终端，云端确认前保留原件。取回只保存到新路径，不会覆盖已有文件。')}</span><input name="cloud-files-path" placeholder="incoming/data.tar" required></label><div class="file-actions"><button class="button" type="submit">存到云端</button></div></form><div class="file-actions"><button class="button" id="cloud-files-refresh" type="button">重新查询</button><button class="button" id="cloud-files-retry" type="button" hidden>用同一请求重试</button></div><p id="cloud-files-status" role="status">先查询云端状态。</p><details id="cloud-files-pending" hidden><summary><span class="dataset-disclosure-label">未确认的操作编号</span></summary><code id="cloud-files-pending-key"></code></details><ul id="cloud-files-list"></ul></details>`;}
export function cloudFilesUI(store,section,toast){
  let busy=false,epoch=0,workspaceBlocked=false;const pending=new Map(),records=new Map(),enabled=new Map();
  const $=s=>section.querySelector(s),machine=()=>$('[name=dataset-machine]')?.value;
  const scope=()=>JSON.stringify([store.principal?.userId,machine()]);
  const context=()=>JSON.stringify([store.principal?.userId,store.authGeneration,machine(),epoch]);
  const report=text=>{const el=$('#cloud-files-status');if(el)el.textContent=text;};
  function controls(blocked){
    if(typeof blocked==='boolean')workspaceBlocked=blocked;
    const held=pending.get(scope()),retry=$('#cloud-files-retry'),receipt=$('#cloud-files-pending'),key=$('#cloud-files-pending-key');
    if(retry)retry.hidden=!held;if(receipt)receipt.hidden=!held;if(key)key.textContent=held?.key||'';
    const card=$('#cloud-files-form')?.closest('details');if(!card)return;restoreMaintenanceControls(card);
    const denied=workspaceBlocked||!store.production||!store.principal||!machine(),available=enabled.get(context());
    $('#cloud-files-form').hidden=available===false;
    for(const node of card.querySelectorAll('input,button:not([data-copy-help])'))node.disabled=denied||busy;
    for(const node of card.querySelectorAll('#cloud-files-form [type=submit],[data-cloud-verify],[data-cloud-restore],[data-cloud-resume],#cloud-files-retry'))node.disabled=denied||busy||available===false;
    for(const node of card.querySelectorAll('[data-cloud-verify],[data-cloud-restore],[data-cloud-resume]'))node.disabled||=!!held;
    disableMaintenanceControls(card,'#cloud-files-form [type=submit],[data-cloud-verify],[data-cloud-restore],[data-cloud-resume],#cloud-files-retry',maintenanceFor(store.data?.operationalMaintenance,machine()));
  }
  async function run(fn){
    if(busy||workspaceBlocked||!store.production||!store.principal||!machine())return;
    const owner=store.data?.users?.find(row=>row.id===store.principal.userId);
    if(owner&&(owner.enabled===false||!(owner.limits?.[machine()]>0))){report('这台服务器未授权。');return;}
    busy=true;controls();const expected=context();
    const current=()=>{if(expected!==context())throw Error('账号或服务器已改变。');};
    const call=async(op,args={})=>{current();const r=await store.call(op,{machine:machine(),...args});current();return r;};
    try{await fn(call,current);}catch(e){if(expected===context()){report(e.message);toast(e.message);}}finally{if(expected===context()){busy=false;controls();}}
  }
  function remember(row){
    const key=scope(),rows=records.get(key)||new Map();rows.set(row.operationId,row);records.set(key,rows);
    const list=$('#cloud-files-list');if(list)list.innerHTML=cloudFilesRows([...rows.values()]);
  }
  function receipt(result,key,request){
    if(result?.operationId!==key||result.action&&request&&result.action!==request.action||request&&Object.entries(request.args).some(([field,value])=>result[field]!==undefined&&result[field]!==value))throw Error('原操作回执未确认。请重新查询。');
    remember(result);return result;
  }
  function confirmed(row){return Object.hasOwn(label,row.state);}
  async function query(call,held){
    const row=receipt(await call('cloud.files.status',{operationId:held.key}),held.key,held);
    if(confirmed(row)){pending.delete(scope());report(label[row.state]);}
    else report('操作结果未确认，请重新查询。');
    return row;
  }
  async function refresh(call){
    const held=pending.get(scope());let unconfirmed=false;
    if(held){try{await query(call,held);}catch{unconfirmed=true;}}
    const info=await call('cloud.files.info',{});enabled.set(context(),typeof info.enabled==='boolean'?info.enabled:null);
    if(info.enabled===false){report('这台服务器未开启云端文件');records.delete(scope());$('#cloud-files-list')?.replaceChildren();controls();return;}
    if(info.enabled!==true)throw Error('云端文件是否开启未确认，请重新查询。');
    if(unconfirmed)throw Error('原操作 '+held.key+' 还未确认，请重新查询；不会另建任务。');
    const result=await call('cloud.files.list',{});if(!Array.isArray(result.files))throw Error('云文件列表未确认，请重新查询。');
    const rows=new Map(result.files.map(row=>[row.operationId,row]));records.set(scope(),rows);$('#cloud-files-list').innerHTML=cloudFilesRows(result.files);
    if(!pending.has(scope()))report(result.files.length?'云端状态已更新。':'还没有云文件。');
  }
  async function send(call,held){
    const ownScope=scope();pending.set(ownScope,held);controls();
    try{
      const row=receipt(await call('cloud.files.'+held.action,{key:held.key,...held.args}),held.key,held);
      if(confirmed(row))pending.delete(ownScope);
      if(confirmed(row))await refresh(call);
      const latest=records.get(scope())?.get(row.operationId)||row;
      report('已提交 · '+(label[latest.state]||'结果未确认，请重新查询。'));
    }catch(error){
      if(pending.get(ownScope)!==held)throw error;
      try{const row=await query(call,held);if(confirmed(row))return;}catch{ /* Preserve the original ID and request, including 401/403 replies. */ }
      throw Error('操作结果未确认：'+error.message+'。请重新查询，或用同一请求重试。');
    }
  }
  async function retry(call,held){
    try{await query(call,held);return;}catch(error){
      // Only an explicit retry after an authoritative "not found" can send
      // the frozen request again. Network/permission errors never replay it.
      if(error.status!==404)throw Error('原操作 '+held.key+' 还未确认，请重新查询。');
    }
    if(enabled.get(context())===false)throw Error('这台服务器未开启云端文件');
    await send(call,held);
  }
  async function start(call,action,args,key){
    if(enabled.get(context())===false)throw Error('这台服务器未开启云端文件');
    if(args.path!==undefined&&(typeof args.path!=='string'||!args.path||new TextEncoder().encode(args.path).length>1024||/[\\\x00-\x1f\x7f]/.test(args.path)||args.path.split('/').some(p=>!p||p==='.'||p==='..'||new TextEncoder().encode(p).length>255)))throw Error('请填写个人 /data2 内的相对文件路径。');
    const held=pending.get(scope());
    if(held){if(held.action!==action||JSON.stringify(held.args)!==JSON.stringify(args))throw Error('有未确认的云操作，请先重新查询原编号。');return retry(call,held);}
    await send(call,{key:key||crypto.randomUUID(),action,args:{...args}});
  }
  async function sourceConfirmed(call,fileId){
    const source=receipt(await call('cloud.files.status',{operationId:fileId}),fileId);
    if(source.action!=='upload'||source.state!=='VERIFIED')throw Error('云端副本尚未确认，请先检查云端。');
  }
  section.addEventListener('submit',e=>{if(e.target.id!=='cloud-files-form')return;e.preventDefault();run(call=>start(call,'upload',{path:$('[name=cloud-files-path]').value.trim()}));});
  section.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.id==='cloud-files-refresh')return run(refresh);
    if(b.id==='cloud-files-retry')return run(call=>{const held=pending.get(scope());if(held)return retry(call,held);});
    if(b.dataset.cloudStatus)return run(async call=>{const held=pending.get(scope());if(held)return refresh(call);const row=receipt(await call('cloud.files.status',{operationId:b.dataset.cloudStatus}),b.dataset.cloudStatus);report(label[row.state]||'状态未确认，请重新查询。');});
    if(b.dataset.cloudVerify)return run(call=>start(call,'verify',{fileId:b.dataset.cloudVerify}));
    if(b.dataset.cloudRestore)return run(async(call,current)=>{
      await sourceConfirmed(call,b.dataset.cloudRestore);
      const path=window.prompt('取回到个人数据空间的新路径，不会覆盖已有文件：','restored/'+b.dataset.cloudName);current();
      if(path)await start(call,'download',{fileId:b.dataset.cloudRestore,path:path.trim()});
    });
    if(b.dataset.cloudResume)return run(async call=>{
      const original=records.get(scope())?.get(b.dataset.cloudResume);if(!original||!resumable(original))throw Error('原下载身份未确认，请重新查询。');
      const row=receipt(await call('cloud.files.status',{operationId:original.operationId}),original.operationId,{action:'download',args:{fileId:original.fileId,path:original.path}});
      if(!resumable(row)){report(label[row.state]||'状态未确认，请重新查询。');return;}
      await sourceConfirmed(call,original.fileId);
      await start(call,'download',{fileId:original.fileId,path:original.path},original.operationId);
    });
    if(b.dataset.cloudCancel)return run(async call=>{
      try{const row=receipt(await call('cloud.files.cancel',{operationId:b.dataset.cloudCancel}),b.dataset.cloudCancel);report(label[row.state]||'停止结果未确认，请重新查询。');}
      catch{const row=receipt(await call('cloud.files.status',{operationId:b.dataset.cloudCancel}),b.dataset.cloudCancel);report(label[row.state]||'停止结果未确认，请重新查询。');}
      await refresh(call);
    });
  });
  section.addEventListener('toggle',e=>{if(e.target.id==='cloud-files'&&e.target.open)run(refresh);},{capture:true});
  section.addEventListener('change',e=>{if(e.target.name==='dataset-machine'){epoch++;busy=false;$('#cloud-files-list')?.replaceChildren();report('先查询这台服务器的云端状态。');controls();}});
  if(typeof document!=='undefined')document.addEventListener('gpuq-maintenance-state',controls);
  return {controls,reset(){epoch++;busy=false;enabled.clear();$('#cloud-files-list')?.replaceChildren();report('先查询云端状态。');}};
}
