import {uploadKey} from './dataset-upload.js';
import {routePresentation,transferBytes} from './data-route.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const done=new Set(['SUCCEEDED','CANCELED']);
const stateNames={PENDING:'等待开始',QUEUED:'等待开始',STARTING:'正在连接',DISPATCHING:'正在连接',WAITING_CLIENT:'等待客户端',RUNNING:'传输中',RETRYING:'正在重试',VERIFYING:'正在校验',UNKNOWN:'状态待确认',PAUSED:'已暂停',FAILED:'需要处理',SUCCEEDED:'已完成',CANCELED:'已终止',CANCELING:'正在停止'};
const kindNames={upload:'上传',download:'下载',copy:'服务器间复制'};
export function transferCard(row){
  const r=row.result||{},bytes=r.bytes??(r.totalBytes!==undefined&&r.remainingBytes!==undefined?r.totalBytes-r.remainingBytes:null),total=r.totalBytes??row.snapshot?.totalBytes??row.manifest?.totalBytes;
  const route=routePresentation(row.lastConfirmedRoute||r.lastConfirmedRoute||row.route||r.route),known=Number.isFinite(bytes)&&bytes>=0&&Number.isFinite(total)&&total>0&&bytes<=total;
  const progress=known?`<progress max="${total}" value="${bytes}" aria-label="已传输 ${esc(transferBytes(bytes))}，共 ${esc(transferBytes(total))}"></progress>`:'';
  return `<div class="transfer-card-heading"><h3>${esc(row.name||row.reference?.dataset||'数据传输')}</h3><span class="transfer-state" data-state="${esc(row.state)}">${esc(stateNames[row.state]||'状态待确认')}</span></div>
    <p class="transfer-endpoints">${esc(row.from?row.from+' → '+row.machine:row.machine)}<span>${row.managedArchive===1?'长期原件保存':esc(kindNames[row.kind]||'传输')} · ${esc(row.owner?.name||row.owner?.username||'')}</span></p>
    <div class="transfer-meter"><span>${esc(transferBytes(bytes))}<small> / ${esc(transferBytes(total))}</small></span><span class="transfer-route" data-route="${esc(route.kind)}">${route.kind==='unknown'?'':'最近确认 · '}${esc(route.label)}</span></div>${progress}
    ${row.error||r.error?`<p class="transfer-error" role="status">${esc(row.error||r.error)}</p>`:r.path?`<p class="transfer-path">${esc(r.path)}</p>`:''}
    <div class="transfer-card-actions"><button type="button" data-transfer-action="status" data-id="${esc(row.id)}">核对状态</button>${!done.has(row.state)?`<button type="button" data-transfer-action="cancel" data-id="${esc(row.id)}">终止传输</button>`:''}${['FAILED','PAUSED'].includes(row.state)&&row.kind==='copy'&&!row.cancelRequested&&row.managedArchive!==1?`<button type="button" class="transfer-resume" data-transfer-action="resume" data-id="${esc(row.id)}">继续传输</button>`:''}</div>${row.managedArchive===1?'<p class="muted">失败时在“数据集”中重试长期保存；原件在确认前不会自动回收。</p>':''}
    <details class="transfer-details"><summary>任务详情</summary><p>任务编号 <code>${esc(row.id)}</code></p><p>后台状态 <code>${esc(row.state)}</code></p><p>${esc(route.note)}${['PAUSED','FAILED','CANCELED'].includes(row.state)?' 未完成文件保留；本机上传需在原客户端继续。':''}</p></details>`;
}
export function transfersUI(store,toast){
  const section=document.querySelector('#page-transfers');let identity='',busy=false,generation=0,cursor=0;
  store.onAuthChange?.(()=>{generation++;identity='';busy=false;section.replaceChildren();});
  async function load(next=false){
    if(busy||!store.principal||!store.production||store.data?.transfers?.version!==1)return;busy=true;const token=generation;
    try{const result=await store.call('transfers.list',{cursor:next?cursor:0});if(token!==generation)return;cursor=result.nextCursor;const list=section.querySelector('#transfer-list');if(!next)list.replaceChildren();for(const row of result.transfers){const node=document.createElement('article');node.className='panel transfer-card';node.innerHTML=transferCard(row);list.append(node);}section.querySelector('#transfer-more').hidden=!cursor;section.querySelector('#transfer-status').textContent=result.transfers.length?'状态已更新。服务器间复制会在后台继续。':'还没有传输任务。可从“数据集”上传数据，或在下方创建服务器间复制。';}
    catch(e){if(token===generation)section.querySelector('#transfer-status').textContent=e.message;}finally{if(token===generation)busy=false;}
  }
  section.addEventListener('submit',async e=>{
    if(e.target.id!=='transfer-copy-form')return;e.preventDefault();if(busy)return;
    const form=e.target,values=new FormData(form),ref=String(values.get('transfer-reference')).split('@'),payload={kind:'copy',from:values.get('transfer-from'),machine:values.get('transfer-machine'),dataset:ref[0],version:ref[1],name:values.get('transfer-name')},account=store.principal?.userId;
    if(ref.length!==2||!ref[0]||!/^[a-f0-9]{64}$/.test(ref[1])){toast('请选择完整的 DATASET_ID@64位版本。');return;}
    const requestKey=uploadKey(account,payload.from+'->'+payload.machine,payload.name,JSON.stringify([payload.dataset,payload.version]));e.submitter.disabled=true;const token=generation;
    try{const row=await store.call('transfers.create',{...payload,key:requestKey});if(token!==generation)return;toast('传输 '+row.id+' · '+row.state);await load();}catch(error){if(token===generation)toast(error.message);}finally{if(token===generation)e.submitter.disabled=false;}
  });
  section.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.id==='transfer-refresh')return load();if(b.id==='transfer-more')return load(true);if(!b.dataset.transferAction)return;if(b.dataset.transferAction==='cancel'&&!window.confirm('终止这一项传输？保留未完成文件，不会自动重启。'))return;b.disabled=true;const token=generation;try{await store.call('transfers.'+b.dataset.transferAction,{id:b.dataset.id});if(token===generation)await load();}catch(error){if(token===generation)toast(error.message);}finally{if(token===generation)b.disabled=false;}});
  return active=>{
    const next=store.principal?JSON.stringify([store.authGeneration,store.principal.userId,(store.data?.machines||[]).map(m=>m.id)]):'';
    if(next!==identity){identity=next;generation++;busy=false;const enabled=store.production&&store.data?.transfers?.version===1,options=(store.data?.machines||[]).map(m=>`<option value="${esc(m.id)}">${esc(m.name||m.id)}</option>`).join('');section.innerHTML=`<p>跟踪上传、下载和跨服务器复制。</p><div class="transfer-section-heading"><h3>传输记录</h3><button id="transfer-refresh" ${enabled?'':'disabled'}>刷新状态</button></div><p id="transfer-status" role="status">${enabled?'刷新可查看已有任务。':'当前为演示或旧后台，未启用真实传输。'}</p><div id="transfer-list"></div><button id="transfer-more" hidden>下一页</button><form id="transfer-copy-form" class="panel"><div class="transfer-form-heading"><span class="transfer-eyebrow">SERVER TO SERVER</span><h3>复制到另一台服务器</h3><p>复制一个已发布的数据集版本。关闭网页后，后台继续传输。</p></div><label>源服务器<select name="transfer-from">${options}</select></label><label>目标服务器<select name="transfer-machine">${options}</select></label><label>固定数据集版本<input name="transfer-reference" placeholder="数据集 ID@完整版本" required><small>从数据集卡片复制完整版本。</small></label><label>目标数据集名称<input name="transfer-name" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,39}" placeholder="my-data" required><small>1–40 位字母、数字、下划线或连字符。</small></label><button type="submit" ${enabled?'':'disabled'}>开始后台复制</button></form><details class="transfer-cli-help"><summary>在命令行中使用</summary><p>上传目录：<code>gpuctl data upload</code><br>传输操作：<code>gpuctl transfer --help</code></p></details>`;}
    if(active&&!busy)load();
  };
}
