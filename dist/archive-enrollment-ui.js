// First admission of an existing physical version. No owner inference or automatic write retry.
import {datasetInfoHTML} from './dataset-flow.js';
import {serverIdHTML} from './workbench-ui.js';
const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,hash=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,user=/^(builtin-admin|demo-user-[0-9]+)$/;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const phases={QUEUED:'等待归档',COPYING:'复制到仓库',PROVISIONING:'核验仓库数据',CERTIFYING:'确认缓存',ARCHIVED:'已存入仓库',FAILED:'归档失败',BLOCKED:'暂不能归档',UNKNOWN:'回执未确认'};
export const archiveEnrollmentKey=actor=>'stargate.archive-enrollment.v1:'+encodeURIComponent(actor);
export function archiveEnrollmentRequest(value){
 if(!value||Object.keys(value).some(k=>!['machine','dataset','version','ownerId','key','copyIfMissing'].includes(k))||!id.test(value.machine)||!id.test(value.dataset)||!hash.test(value.version)||!user.test(value.ownerId)||!uuid.test(value.key)||Object.hasOwn(value,'copyIfMissing')&&typeof value.copyIfMissing!=='boolean')throw Error('请选择服务器和所属账号，并填写数据集 ID 与完整版本。');
 return Object.freeze({...value});
}
export function archiveEnrollmentReceipt(request,value){
 if(!value||value.dataset!==request.dataset||value.version!==request.version||value.localMachine!==request.machine||!id.test(value.archiveMachine)||!Object.hasOwn(phases,value.phase)||value.phase==='UNKNOWN'||typeof value.originalRetained!=='boolean'||value.phase==='ARCHIVED'&&value.originalRetained!==true)throw Error('归档回执未确认。');
 return value;
}
export function mountArchiveEnrollment(host,{store,machine,active=()=>true,signal,refresh=()=>{},toast=()=>{}}){
 if(store.principal?.role!=='admin'||signal?.aborted){host.replaceChildren();return {sync(){},destroy(){}};}
 const lifecycle=new AbortController(),actor=()=>store.principal?.userId,session=()=>JSON.stringify([actor(),store.principal?.role,store.authGeneration,machine()]);
 const allowed=()=>!lifecycle.signal.aborted&&!signal?.aborted&&store.production&&store.principal?.role==='admin'&&active();
 host.classList.add('storage-archive-enrollment');
 host.innerHTML=`<header><h4>归档纳管</h4>${datasetInfoHTML('把已有版本交给仓库管理。缺少该版本时，只有勾选允许复制才会复制到仓库；受理不代表备份完成。','归档纳管')}<button class="button" type="button" data-enroll-open>纳管已有版本…</button></header><dialog class="archive-enroll-dialog"><form><header class="modal-head"><h2>归档纳管</h2><button class="icon-button" type="button" data-enroll-close aria-label="关闭">×</button></header><div data-enroll-machine></div><label class="field">所属账号<select name="ownerId" required></select></label><label class="field">数据集 ID<input name="dataset" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"></label><label class="field">完整版本<input name="version" required maxlength="64" pattern="[a-f0-9]{64}"></label><label class="archive-enroll-copy"><input type="checkbox" name="copyIfMissing"><span>仓库中没有该版本时，允许从这台服务器复制</span></label><p class="form-error" role="alert" data-enroll-error></p><p role="status" data-enroll-result></p><div class="modal-actions"><button class="button" type="button" data-enroll-close>关闭</button><button class="button" type="button" data-enroll-retry hidden>重试原请求</button><button class="button primary" type="submit">开始纳管</button></div><details class="archive-enroll-history"><summary>本浏览器的请求</summary><div data-enroll-history></div></details></form></dialog>`;
 const dialog=host.querySelector('dialog'),form=dialog.querySelector('form'),error=dialog.querySelector('[data-enroll-error]'),result=dialog.querySelector('[data-enroll-result]');
 let busy=false,pending=null,receipt=null,binding=session(),generation=0;
 function journal(owner){try{const rows=JSON.parse(localStorage.getItem(archiveEnrollmentKey(owner))||'[]');return Array.isArray(rows)?rows.filter(row=>{try{archiveEnrollmentRequest(row.request);return true;}catch{return false;}}):[];}catch{return [];}}
 function save(owner,row){const rows=journal(owner),index=rows.findIndex(old=>old.request.key===row.request.key);if(index<0)rows.push(row);else rows[index]=row;if(rows.length>200)throw Error('本浏览器保存的纳管请求已满，请先检查原请求。');localStorage.setItem(archiveEnrollmentKey(owner),JSON.stringify(rows));}
 function resetForm(){form.reset();pending=null;receipt=null;error.textContent='';result.textContent='';form.elements.ownerId.innerHTML='<option value="">选择所属账号</option>'+(store.users||[]).filter(row=>row.enabled===true&&user.test(row.id)).map(row=>`<option value="${esc(row.id)}">${esc(row.name||row.username)} · ${esc(row.username)}</option>`).join('');}
 function render(){
  if(!allowed()){if(dialog.open)dialog.close();host.hidden=true;return;}host.hidden=false;
  host.querySelector('[data-enroll-open]').disabled=busy||!id.test(machine());
  host.querySelector('[data-enroll-machine]').innerHTML=serverIdHTML(pending?.request.machine||machine());
  for(const field of form.querySelectorAll('input,select'))field.disabled=busy||!!pending;
  if(pending){for(const field of ['dataset','version','ownerId'])form.elements[field].value=pending.request[field];form.elements.copyIfMissing.checked=pending.request.copyIfMissing===true;}
  form.querySelector('[type=submit]').hidden=!!pending;form.querySelector('[type=submit]').disabled=busy;
  const retry=host.querySelector('[data-enroll-retry]');retry.hidden=!pending;retry.disabled=busy;
  result.textContent=pending?(busy?'正在确认原请求':receipt?phases[receipt.phase]+(receipt.phase==='ARCHIVED'?'':' · 尚未确认备份完成'):'回执未确认 · 请按原请求重试'):'';
  host.querySelector('[data-enroll-history]').innerHTML=journal(actor()).map(row=>`<button class="button quiet" type="button" data-enroll-history-key="${esc(row.request.key)}" ${busy?'disabled':''}>${esc(row.request.dataset)} · ${esc(row.request.version.slice(0,12))}<small title="${esc(row.request.machine)}">${esc(row.request.machine)}</small></button>`).join('')||'<p>没有保存的请求</p>';
 }
 async function dispatch(){
  if(!allowed()||busy||!pending)return;const expected=session(),token=generation,owner=actor(),intent=pending,current=()=>allowed()&&session()===expected&&generation===token;busy=true;receipt=null;error.textContent='';render();
  try{
   save(owner,{...intent,state:'UNKNOWN'});
   const value=archiveEnrollmentReceipt(intent.request,await store.call('datasets.archive.enroll',{...intent.request},{signal:lifecycle.signal}));
   save(owner,{...intent,state:value.phase});if(!current())return;
   receipt=value;error.textContent=value.error||'';if(value.phase==='ARCHIVED'){toast('已存入仓库');void Promise.resolve().then(()=>{if(current())return refresh();}).catch(()=>{});}
  }catch(cause){if(current())error.textContent=cause.message;}
  finally{if(generation===token){busy=false;if(current())render();}}
 }
 function sync(){if(binding!==session()){binding=session();generation++;if(dialog.open)dialog.close();pending=null;receipt=null;busy=false;}render();}
 host.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled||!allowed())return;
  if(button.hasAttribute('data-enroll-open')){resetForm();render();dialog.showModal();}
  if(button.hasAttribute('data-enroll-close'))dialog.close();
  if(button.hasAttribute('data-enroll-history-key')){const row=journal(actor()).find(row=>row.request.key===button.dataset.enrollHistoryKey);if(row){pending={request:archiveEnrollmentRequest(row.request)};receipt=null;error.textContent='';render();}}
  if(button.hasAttribute('data-enroll-retry')&&pending&&window.confirm('使用原编号重试这份冻结的纳管请求？若服务器已受理，只返回原回执；未受理时会提交原请求。'))void dispatch();
 },{signal:lifecycle.signal});
 form.addEventListener('submit',event=>{
  event.preventDefault();if(!allowed()||busy||pending)return;
  try{
   const request=archiveEnrollmentRequest({machine:machine(),dataset:form.elements.dataset.value.trim(),version:form.elements.version.value.trim(),ownerId:form.elements.ownerId.value,key:crypto.randomUUID(),...(form.elements.copyIfMissing.checked?{copyIfMissing:true}:{})});
   const prior=journal(actor()).find(row=>['machine','dataset','version','ownerId'].every(field=>row.request[field]===request[field]));
   if(prior&&(prior.request.copyIfMissing===true)!==(request.copyIfMissing===true))throw Error('这份版本已有原请求，复制选择不能更改。请从本浏览器的请求中选择它。');
   pending={request:prior?archiveEnrollmentRequest(prior.request):request};save(actor(),{...pending,state:'UNKNOWN'});void dispatch();
  }catch(cause){pending=null;error.textContent=cause.message;render();}
 },{signal:lifecycle.signal});
 signal?.addEventListener('abort',destroy,{once:true});
 function destroy(){lifecycle.abort();if(dialog.open)dialog.close();host.replaceChildren();}
 resetForm();render();return {sync,destroy};
}
