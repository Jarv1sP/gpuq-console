import {serverIdHTML} from './workbench-ui.js';
import {copyHelp} from './copy-help-ui.js';
import {fadeDialog} from './motion-ui.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const hash=/^[a-f0-9]{64}$/,name=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const pending=row=>['SUBMITTING','UNREGISTERING','UNKNOWN'].includes(row.state);
const label=row=>row.state==='UNREGISTERED'?'已移除':row.state==='SUBMITTING'||row.state==='UNREGISTERING'?'正在移除':row.state==='FAILED'?'移除未完成':row.state==='BLOCKED'?'暂不能移除':'移除结果待确认';

// Personal v1 removal shares the existing receipt protocol, with a separate
// account journal and a permission projection from fresh node catalog facts.
export function personalDatasetRemovalUI(store,section,toast,{catalog,reload,createRemovals,preservation}){
 let storage;try{storage=globalThis.localStorage;}catch{}
 let dialog=null,panel=null,intent=null,verified=null,reading=false;
 const signature=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
 const visible=()=>!document.hidden&&!store.authPending&&section.isConnected&&!section.hidden&&document.body.dataset.room==='datasets'&&['admin','member'].includes(store.principal?.role);
 const current=()=>visible()&&intent?.actor===signature();
 const candidates=(value,dataset,version)=>{
  if(value?.datasetDelete!==1||value.partial===true||!store.principal?.userId||!hash.test(version))return [];
  const known=new Set((store.data?.machines||[]).map(machine=>machine.id));
  return value.datasets?.find(row=>row.dataset===dataset)?.versions?.find(row=>row.version===version)?.locations?.filter(row=>known.has(row.machine)&&row.state==='READY'&&row.deletionPermissions?.memberAllowed===true&&name.test(row.dataset))||[];
 };
 const api=createRemovals({principal:()=>store.principal,session:()=>store.authGeneration,machines:()=>store.data?.machines||[],call:(...args)=>store.call(...args),storage,personal:true,
  canRemove:(_who,target)=>current()&&catalog()?.datasetDelete===1&&candidates(verified,target.catalogDataset,target.version).some(row=>row.machine===target.machine&&row.dataset===target.dataset),
  changed:update,completed:()=>{if(visible())reload?.();},
 });
 function ensureDialog(){
  if(dialog?.isConnected)return;
  dialog=document.createElement('dialog');dialog.className='modal dataset-remove-dialog personal-remove-dialog';dialog.id='personal-remove-dialog';dialog.setAttribute('aria-labelledby','personal-remove-title');section.append(dialog);
  dialog.addEventListener('close',()=>{if(!dialog.open){intent=null;verified=null;}});
  dialog.addEventListener('click',event=>{if(event.target.closest('[data-personal-remove-close]'))dialog.close();});
  dialog.addEventListener('change',event=>{if(event.target.name==='personal-remove-machine'&&current()){intent.machine=event.target.value;render();}});
  dialog.addEventListener('submit',async event=>{
   event.preventDefault();if(!current()||reading)return;
   const row=candidates(verified,intent.dataset,intent.version).find(row=>row.machine===intent.machine);if(!row)return;
   const target={machine:row.machine,dataset:row.dataset,version:intent.version,catalogDataset:intent.dataset};
   const proof=preservation(target,verified.datasets.find(value=>value.dataset===intent.dataset).versions.filter(value=>value.version===intent.version),store.data?.machines||[],{partial:verified.partial===true});
   if(!proof.allowed||api.blocked(target))return;
   // Dispatch while the confirmed intent is still current, then close. The
   // controller freezes/persists the exact target synchronously before await.
   const request=api.submit(target);dialog.close();
   try{await request;}catch(error){if(visible())toast(error.message);}update();
  });
 }
 function render(){
  if(!dialog?.open||!intent)return;
  if(!current()){dialog.close();return;}
  if(reading){dialog.innerHTML='<header class="modal-head"><h2 id="personal-remove-title">移除服务器缓存</h2><button class="button quiet" type="button" data-personal-remove-close>关闭</button></header><p role="status">正在核对副本…</p>';return;}
  const rows=candidates(verified,intent.dataset,intent.version),row=rows.find(row=>row.machine===intent.machine);
  if(!row){dialog.innerHTML='<header class="modal-head"><h2 id="personal-remove-title">移除服务器缓存</h2><button class="button quiet" type="button" data-personal-remove-close>关闭</button></header><p role="status">这份数据当前不能按机器删除，请刷新目录。</p>';return;}
  const target={machine:row.machine,dataset:row.dataset,version:intent.version,catalogDataset:intent.dataset},proof=preservation(target,verified.datasets.find(value=>value.dataset===intent.dataset).versions.filter(value=>value.version===intent.version),store.data?.machines||[],{partial:verified.partial===true});
  const unresolved=api.blocked(target)||proof.pending,allowed=proof.allowed&&!unresolved;
  const copies=proof.items.map(item=>item.kind==='archive'?`仓库原件<span class="personal-remove-copies">${serverIdHTML(item.machines[0])}</span>`:item.kind==='replicas'?`其他服务器上的完整副本：<span class="personal-remove-copies">${item.machines.map(machine=>serverIdHTML(machine)).join('')}</span>`:'完整副本尚未确认').join('');
  dialog.innerHTML=`<form><header class="modal-head"><div class="copy-caption"><h2 id="personal-remove-title">移除服务器缓存</h2>${copyHelp('移除范围','仅移除所选服务器上本人这个版本的缓存和登记；训练占用、固定保留、仓库原件或副本不明时服务器会拒绝。')}</div><button class="button quiet" type="button" data-personal-remove-close aria-label="关闭移除确认">关闭</button></header><label class="field">服务器<select name="personal-remove-machine" aria-label="移除缓存的服务器">${rows.map(value=>`<option value="${esc(value.machine)}" ${value.machine===intent.machine?'selected':''}>${esc(value.machine)}</option>`).join('')}</select></label><dl class="dataset-remove-facts"><div><dt>数据集</dt><dd><code>${esc(intent.dataset)}</code>${row.dataset!==intent.dataset?`<small>登记名 ${esc(row.dataset)}</small>`:''}<small title="${esc(intent.version)}">${esc(intent.version.slice(0,12))}</small></dd></div><div><dt>删除</dt><dd>此服务器的缓存和登记</dd></div><div><dt>保留</dt><dd>${copies}</dd></div></dl>${allowed?'':`<p class="dataset-remove-blocked">${unresolved?'这台服务器上的移除结果待确认':'这可能是最后一份完整数据，暂不能<span class="dataset-remove-action-word">按机器删除</span>'}</p>`}<footer class="modal-actions"><button class="button" type="button" data-personal-remove-close>保留缓存</button><button class="button danger" type="submit" data-personal-remove-confirm ${allowed?'':'disabled'}>移除缓存</button></footer></form>`;
 }
 function update(){
  api.sync(visible());if(dialog?.open&&!current())dialog.close();
  if(!visible()){panel?.remove();panel=null;return;}
  const rows=api.rows.filter(row=>row.state!=='UNREGISTERED');if(!rows.length){panel?.remove();panel=null;return;}
  if(!panel){panel=document.createElement('section');panel.className='personal-removal-records';panel.setAttribute('aria-label','缓存移除记录');section.append(panel);}
  panel.innerHTML=`<h3>缓存移除记录</h3>${rows.map(row=>`<article data-personal-removal-record="${esc(row.id)}"><div class="dataset-removal-heading"><strong><code>${esc(row.catalogDataset||row.dataset)}</code> · ${serverIdHTML(row.machine)}</strong><span class="st ${pending(row)?'st-unk':row.state==='FAILED'?'st-err':'st-stop'}"><span class="g" aria-hidden="true"></span>${label(row)}</span></div>${row.error?`<p class="form-error" role="alert">${esc(row.error)}</p>`:''}<form data-personal-removal-query="${esc(row.id)}">${row.operationId?`<code title="${esc(row.operationId)}">${esc(row.operationId.slice(0,8)+'…'+row.operationId.slice(-4))}</code>`:`<label class="field"><span class="copy-caption"><span>原操作编号</span>${copyHelp('查询原操作','请联系管理员从服务器操作记录里找到原来的64位编号，再粘贴查询；不要重复移除。')}</span><input name="operationId" pattern="[a-f0-9]{64}" minlength="64" maxlength="64" required autocomplete="off" spellcheck="false" aria-label="原操作编号"></label>`}<button class="button" type="submit" ${api.isBusy(row.id)?'disabled':''}>重新查询</button></form></article>`).join('')}`;
 }
 section.addEventListener('submit',event=>{
  if(!event.target.matches('[data-personal-removal-query]'))return;event.preventDefault();if(!visible())return;
  const id=event.target.dataset.personalRemovalQuery,original=new FormData(event.target).get('operationId');
  api.query(id,original===null?undefined:original).catch(error=>{if(visible())toast(error.message);});
 });
 const visibility=new MutationObserver(update);visibility.observe(document.body,{attributes:true,attributeFilter:['data-room']});visibility.observe(section,{attributes:true,attributeFilter:['hidden']});
 document.addEventListener('visibilitychange',update);store.onAuthChange?.(()=>{dialog?.close();update();});update();
 return {
  canOpen:(dataset,version)=>visible()&&candidates(catalog(),dataset,version).length>0,
  async open(dataset,version){
   if(!visible())return false;const before=candidates(catalog(),dataset,version);if(!before.length)return false;
   if(dialog?.open)dialog.close();const selected=intent={actor:signature(),dataset,version,machine:before[0].machine};verified=null;reading=true;ensureDialog();dialog.showModal();render();fadeDialog(dialog);
   try{const result=await store.call('datasets.catalog',{machine:before[0].machine});if(intent!==selected||!current())return false;verified=result;}
   catch(error){if(intent===selected&&current()){toast(error.message);dialog.close();}return false;}
   finally{if(intent===selected){reading=false;if(current())render();}}
   return true;
  },
 };
}
