// Prewired cache UI. No caller, capability, or receipt is supplied by a demo model.
import {serverIdHTML} from './workbench-ui.js';
import {copyHelp} from './copy-help-ui.js';
const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,hash=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const actions=['prepare','release'],finished=new Set(['READY','RELEASED','FAILED','BLOCKED','CANCELED']),states=new Set([...finished,'DISPATCHING','RUNNING','CANCELING','UNKNOWN']);
const labels={UNKNOWN:'未知',DISPATCHING:'正在派发',RUNNING:'进行中',CANCELING:'正在取消',CANCELED:'已取消',FAILED:'操作失败',BLOCKED:'暂不能执行',READY:'已缓存',RELEASED:'释放已确认'};
const phases={QUEUED:'等待',DISPATCHING:'派发',RUNNING:'进行中',PREPARING:'准备',COPYING:'复制',VERIFYING:'校验',CHECKING:'核对',RELEASING:'释放',STOPPING:'停止',CANCELING:'停止',CANCELLING:'停止'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const same=(a,b)=>['action','machine','dataset','version'].every(field=>a[field]===b[field]);
// The published protocol names each action explicitly. Neither a protocol
// alone nor the earlier provisional allowance is sufficient permission.
export function adaptCacheCapability(raw,action){
 const allowed=raw?.protocol===1&&actions.includes(action)&&raw[action]===true;
 return {allowed,reason:typeof raw?.reason==='string'?raw.reason:null,protocol:typeof raw?.protocol==='string'||Number.isSafeInteger(raw?.protocol)?raw.protocol:null};
}
export const canCacheAction=(capabilities,action)=>adaptCacheCapability(capabilities,action).allowed;
export const cacheOperationStorageKey=account=>'stargate.cache-operations.v1:'+encodeURIComponent(account);
function target(value){
 if(!value||!actions.includes(value.action)||typeof value.machine!=='string'||typeof value.dataset!=='string'||typeof value.version!=='string'||!id.test(value.machine)||!id.test(value.dataset)||!hash.test(value.version))throw Error('请选择服务器和固定版本。');
 return {action:value.action,machine:value.machine,dataset:value.dataset,version:value.version};
}
export function cacheOperationReceipt(request,value,operationId){
 if(!value||!same(request,value)||value.key!==request.key||!uuid.test(value.operationId||'')||operationId&&value.operationId!==operationId||!states.has(value.state)||typeof value.phase!=='string'||!value.phase||typeof value.canCancel!=='boolean'||value.state==='READY'&&request.action!=='prepare'||value.state==='RELEASED'&&request.action!=='release')throw Error('缓存操作回执未确认。');
 return value;
}
export function createCacheOperation({store,action,machine,dataset,version,capabilities,signal,storage=globalThis.localStorage,active=()=>true,changed=()=>{},onUnavailable=()=>{},schedule=setTimeout,clear=clearTimeout,delay=1500,newKey=()=>crypto.randomUUID()}){
 const scope=target({action,machine,dataset,version}),account=store.principal?.userId,binding=JSON.stringify([account,store.authGeneration]),lifetime=new AbortController();
 let row=null,busy=false,paused=false,timer=null,closed=false,errors=0,notice='',cap=capabilities,journalError=false;
 const live=()=>!closed&&!signal?.aborted&&store.production===true&&!!account&&store.principal?.enabled!==false&&JSON.stringify([store.principal?.userId,store.authGeneration])===binding;
 const capability=()=>adaptCacheCapability(cap,action);
 const available=()=>capability().allowed||!!capability().reason;
 function journal(){const value=JSON.parse(storage.getItem(cacheOperationStorageKey(account))||'[]');if(!Array.isArray(value))throw Error('原请求记录无法读取。');return value;}
 function restore(value){return value?{request:Object.freeze({...value.request}),operationId:uuid.test(value.operationId||'')?value.operationId:null,state:'UNKNOWN',phase:null,progress:null,error:null,canCancel:false,confirmed:false}:null;}
 function save(){
  const rows=journal(),index=rows.findIndex(value=>value.request?.key===row.request.key),value={request:row.request,operationId:row.operationId,state:row.state};
  if(index<0)rows.push(value);else rows[index]=value;
  if(rows.length>200)throw Error('本浏览器的缓存请求记录已满，请先确认原请求。');
  storage.setItem(cacheOperationStorageKey(account),JSON.stringify(rows));
 }
 function recent(){return journal().findLast(value=>value.request&&same(value.request,scope)&&uuid.test(value.request.key||''));}
 try{row=restore(recent());}catch{journalError=true;notice='原请求记录无法读取，暂不能发起操作。';}
 function snapshot(){
  if(!live())return {visible:false};
  return {visible:available(),allowed:capability().allowed,reason:capability().reason,busy,request:row?.request,operationId:row?.operationId,state:row?.state||'IDLE',phase:row?.phase,progress:row?.progress,error:notice||row?.error,confirmed:row?.confirmed===true,receiptOnly:row?.receiptOnly===true,locationState:row?.locationState,canCancel:action==='release'&&cap?.protocol===1&&cap.releaseCancel===true&&!!row?.confirmed&&row.canCancel===true&&!finished.has(row.state)&&!busy,
   canStart:!journalError&&!busy&&capability().allowed&&(!row||row.confirmed&&['FAILED','BLOCKED','CANCELED'].includes(row.state))};
 }
 function sync(){
  if(timer!==null){clear(timer);timer=null;}
  if(live()&&available()&&active()&&row?.operationId&&!finished.has(row.state)&&!busy&&!paused)timer=schedule(()=>{timer=null;void query();},Math.min(15000,delay*2**Math.min(errors,4)));
 }
 function emit(){changed(snapshot());sync();}
 function unknown(cause){row.state='UNKNOWN';row.confirmed=false;row.canCancel=false;row.progress=null;row.error=cause.message;errors++;paused=[401,403].includes(cause.status);try{save();}catch{notice='回执无法保存，请保留原操作编号。';}}
 function accept(value){
  // Preserve an ID from a partial reply, without treating that partial reply as completion.
  if(!row.operationId&&uuid.test(value?.operationId||'')&&['key','action','machine','dataset','version'].every(field=>value[field]==null||value[field]===row.request[field])){row.operationId=value.operationId;save();}
  const receipt=cacheOperationReceipt(row.request,value,row.operationId);
  row={...row,operationId:receipt.operationId,state:receipt.state,phase:receipt.phase,error:typeof receipt.error==='string'?receipt.error:null,canCancel:receipt.canCancel,confirmed:true,receiptOnly:receipt.receiptOnly===true,locationState:typeof receipt.locationState==='string'?receipt.locationState:null,
   progress:integer(receipt.bytes)&&integer(receipt.totalBytes)&&receipt.bytes<=receipt.totalBytes?{bytes:receipt.bytes,totalBytes:receipt.totalBytes}:null};
  errors=0;paused=false;notice='';save();
 }
 async function start(){
  if(!live()||!active()||!snapshot().canStart)return false;
  busy=true;notice='';emit();let sent=false;
  try{
   cap=await store.call('datasets.cache.capabilities',{machine,dataset,version},{signal:lifetime.signal});
   if(!live())return false;
   if(!canCacheAction(cap,action)){notice=capability().reason||'这项缓存操作暂不可用。';return false;}
   const latest=recent();
   if(latest&&latest.request.key!==row?.request.key){row=restore(latest);return false;}
   const prior=row;
   row={request:Object.freeze({...scope,key:newKey()}),operationId:null,state:'UNKNOWN',phase:null,progress:null,error:null,canCancel:false,confirmed:false};
   if(!uuid.test(row.request.key))throw Error('请求编号无效。');
   try{save();}catch(cause){row=prior;throw cause;}
   sent=true;emit();
   const args={machine,dataset,version,key:row.request.key};
   const value=await store.call('datasets.cache.'+action,args,{signal:lifetime.signal});
   if(live())accept(value);
   return true;
  }catch(cause){if(live()){if(sent)unknown(cause);else{notice=cause.message;if(cause.status===404||/unknown operation|未知操作/i.test(cause.message)){cap=null;onUnavailable(cause);}}}return false;}
  finally{busy=false;if(live())emit();}
 }
 async function query(originalId){
  if(!live()||!active()||busy||!row)return false;
  if(originalId){if(row.operationId&&row.operationId!==originalId||!uuid.test(originalId))throw Error('请填写原操作编号。');row.operationId=originalId;save();}
  if(!row.operationId)return false;
  busy=true;notice='';emit();
  try{const value=await store.call('datasets.cache.status',{operationId:row.operationId},{signal:lifetime.signal});if(live())accept(value);return true;}
  catch(cause){if(live())unknown(cause);return false;}
  finally{busy=false;if(live())emit();}
 }
 async function cancel(){
  if(!live()||!active()||!snapshot().canCancel||!row.operationId)return false;
  busy=true;notice='';emit();
  try{const value=await store.call('datasets.cache.cancel',{operationId:row.operationId},{signal:lifetime.signal});if(live())accept(value);return true;}
  catch(cause){if(live())unknown(cause);return false;}
  finally{busy=false;if(live())emit();}
 }
 async function check(){
  if(!live()||!active()||busy)return false;busy=true;notice='';emit();
  try{const value=await store.call('datasets.cache.capabilities',{machine,dataset,version},{signal:lifetime.signal});if(live())cap=value;return live()&&capability().allowed;}
  catch(cause){if(live()){notice=cause.message;if(cause.status===404||/unknown operation|未知操作/i.test(cause.message)){cap=null;onUnavailable(cause);}}return false;}
  finally{busy=false;if(live())emit();}
 }
 function destroy(){closed=true;lifetime.abort();if(timer!==null)clear(timer);timer=null;}
 signal?.addEventListener('abort',destroy,{once:true});
 return {snapshot,start,query,cancel,check,sync,destroy};
}
const bytes=value=>{const units=['B','KiB','MiB','GiB','TiB'];let index=0;while(value>=1024&&index<4){value/=1024;index++;}return value.toFixed(index?1:0)+' '+units[index];};
function style(){if(!document.querySelector('link[data-cache-operation-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/dataset-cache-operation.css';link.dataset.cacheOperationStyle='';document.head.append(link);}}
export function mountCacheOperation(host,options){
 try{target(options);}catch{return {start:async()=>false,query:async()=>false,cancel:async()=>false,check:async()=>false,snapshot:()=>({visible:false}),sync(){},destroy(){}};}
 const {store,action,machine,dataset,version,signal,onChange=()=>{},startLabel,explain=true}=options,lifetime=new AbortController();
 let root=null,api;
 const active=()=>host.isConnected&&!document.hidden&&host.checkVisibility?.({checkVisibilityCSS:true})!==false&&options.active?.()!==false;
 function render(value){
  if(!value.visible){root?.remove();root=null;onChange(value);return;}
  if(!root){style();root=document.createElement('section');root.className='cache-operation';host.append(root);}
  const reference=value.operationId?'<div class="cache-operation-id"><span>操作编号</span><code title="'+esc(value.operationId)+'">'+esc(value.operationId.slice(0,8)+'…'+value.operationId.slice(-4))+'</code><button class="button" type="button" data-cache-copy aria-label="复制完整操作编号">复制</button></div>':'';
  const missing=value.request&&!value.operationId?'<form data-cache-id-form><label>原操作编号<input name="operationId" placeholder="粘贴原 UUID" required aria-label="原操作编号"></label><button class="button" type="submit">查询原操作</button></form>':'';
  const displayState=value.state==='READY'&&(value.receiptOnly||value.locationState==='NOT_OBSERVED')?'UNKNOWN':value.state;
  const label=value.busy?'正在确认':value.request?labels[displayState]||'未知':value.allowed?'等待操作':'暂不能执行';
  root.innerHTML='<header><h4>'+esc(action==='prepare'?'准备缓存':'释放缓存')+'</h4>'+serverIdHTML(machine)+(explain?copyHelp('缓存操作','回执丢失后只查原编号；没有编号时，请管理员查服务器操作记录。'):'')+'</header><div class="cache-operation-facts"><code title="'+esc(dataset)+'">'+esc(dataset)+'</code><code title="'+esc(version)+'">'+esc(version.slice(0,12))+'</code></div><div class="cache-operation-reading"><span class="cache-operation-state" role="status" data-state="'+esc(displayState)+'" aria-label="'+esc(label)+'" title="'+esc(label+(value.phase?' · '+value.phase:''))+'"><span class="cache-operation-mark" aria-hidden="true"></span>'+(['UNKNOWN','RELEASED','BLOCKED'].includes(displayState)?esc(labels[displayState]):'')+'</span>'+
   (value.phase&&!finished.has(value.state)?'<span class="cache-operation-phase" title="'+esc(value.phase)+'">'+esc(phases[value.phase]||value.phase)+'</span>':'')+(value.progress&&!finished.has(value.state)?'<span class="cache-operation-progress">'+esc(bytes(value.progress.bytes)+' / '+bytes(value.progress.totalBytes))+'</span>':'')+'</div>'+
   (value.error||!value.allowed&&value.reason?'<p class="cache-operation-error" role="alert" title="'+esc(value.error||value.reason)+'">'+esc(value.error||value.reason)+'</p>':'')+reference+missing+
   '<footer>'+(value.canStart?'<button class="button '+(action==='release'?'danger':'primary')+'" type="button" data-cache-start>'+esc(startLabel||(value.request?'重新发起':action==='prepare'?'准备缓存':'释放缓存'))+'</button>':'')+
   (!value.allowed?'<button class="button" type="button" data-cache-check '+(value.busy?'disabled':'')+'>重新检查</button>':'')+
   (value.operationId?'<button class="button" type="button" data-cache-query '+(value.busy?'disabled':'')+'>重新查询</button>':'')+
   (value.canCancel?'<button class="button" type="button" data-cache-cancel>取消操作</button>':'')+'</footer>';
  onChange(value);
 }
 api=createCacheOperation({...options,active,signal:lifetime.signal,changed:render});
 host.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!root?.contains(button)||button.disabled)return;
  if(button.hasAttribute('data-cache-start')&&(action!=='release'||window.confirm('释放 '+machine+' 上 '+dataset+' @ '+version.slice(0,12)+' 的缓存？')))void api.start();
  if(button.hasAttribute('data-cache-query'))void api.query();
  if(button.hasAttribute('data-cache-check'))void api.check();
  if(button.hasAttribute('data-cache-cancel')&&window.confirm('取消这次缓存操作？'))void api.cancel();
  if(button.hasAttribute('data-cache-copy'))void navigator.clipboard.writeText(api.snapshot().operationId).then(()=>{button.textContent='已复制';}).catch(()=>{button.textContent='复制失败';});
 },{signal:lifetime.signal});
 host.addEventListener('submit',event=>{if(!root?.contains(event.target)||!event.target.matches('[data-cache-id-form]'))return;event.preventDefault();void api.query(event.target.elements.operationId.value.trim()).catch(cause=>{root.querySelector('[role=status]').textContent=cause.message;});},{signal:lifetime.signal});
 function sync(){render(api.snapshot());api.sync();}
 function destroy(){lifetime.abort();api.destroy();root?.remove();root=null;}
 document.addEventListener('visibilitychange',sync,{signal:lifetime.signal});
 const unsubscribe=store.onAuthChange?.(sync);
 lifetime.signal.addEventListener('abort',()=>{if(typeof unsubscribe==='function')unsubscribe();},{once:true});
 signal?.addEventListener('abort',destroy,{once:true});if(signal?.aborted)destroy();else sync();
 return {start:api.start,query:api.query,cancel:api.cancel,check:api.check,snapshot:api.snapshot,sync,destroy};
}
export function mountCacheTransfer(host,{store,source,targets,dataset,version,signal,onChange=()=>{}}){
 const choices=(targets||[]).filter(value=>typeof value.machine==='string'&&value.machine!==source&&id.test(value.machine)&&canCacheAction(value.capabilities,'prepare'));
 if(!choices.length||signal?.aborted||!store.principal?.userId||store.principal.enabled===false||store.production!==true)return {destroy(){},sync(){}};
 target({action:'release',machine:source,dataset,version});style();
 const lifetime=new AbortController(),binding=JSON.stringify([store.principal.userId,store.authGeneration]),root=document.createElement('section');root.className='cache-transfer';
 root.innerHTML='<div class="cache-transfer-heading"><button class="button" type="button" data-cache-transfer-open>转移到…</button>'+copyHelp('转移缓存','先准备目标副本，再单独确认释放来源；不会自动删除。')+'</div><div data-cache-transfer-body hidden><label>目标服务器<select aria-label="目标服务器">'+choices.map(value=>'<option value="'+esc(value.machine)+'">'+esc(value.machine)+'</option>').join('')+'</select></label><div data-cache-transfer-target></div><div data-cache-transfer-source></div></div>';host.append(root);
 let prepared=null,released=null,checked=null;
 const live=()=>!lifetime.signal.aborted&&binding===JSON.stringify([store.principal?.userId,store.authGeneration])&&!signal?.aborted;
 function sourceReason(slot,text){
  slot.replaceChildren();const reason=document.createElement('p');reason.className='cache-operation-error';reason.textContent=text;reason.title=text;slot.append(reason);
  const check=document.createElement('button');check.type='button';check.className='button';check.textContent='重新检查';check.addEventListener('click',()=>{checked=null;void sourceCapability(prepared.snapshot());},{signal:lifetime.signal});slot.append(check);
 }
 async function sourceCapability(receipt){
  if(!live()||document.hidden||root.checkVisibility?.({checkVisibilityCSS:true})===false||!receipt.confirmed||receipt.state!=='READY'||receipt.receiptOnly||receipt.locationState==='NOT_OBSERVED'||receipt.request?.machine!==root.querySelector('select').value||checked===receipt.operationId)return;
  checked=receipt.operationId;
  const slot=root.querySelector('[data-cache-transfer-source]');
  try{
   const capabilities=await store.call('datasets.cache.capabilities',{machine:source,dataset,version},{signal:lifetime.signal});
   const current=prepared?.snapshot();
   if(!live()||current?.operationId!==receipt.operationId||!current.confirmed||current.state!=='READY'||current.receiptOnly||current.locationState==='NOT_OBSERVED')return;
   if(canCacheAction(capabilities,'release'))released=mountCacheOperation(slot,{store,action:'release',machine:source,dataset,version,capabilities,signal:lifetime.signal,startLabel:'释放原服务器缓存',explain:false,onChange});
   else sourceReason(slot,adaptCacheCapability(capabilities,'release').reason||'未知');
  }catch(cause){if(live())sourceReason(slot,cause.message);}
 }
 function select(){
  prepared?.destroy();released?.destroy();checked=null;
  const choice=choices.find(value=>value.machine===root.querySelector('select').value);
  root.querySelector('[data-cache-transfer-source]').replaceChildren();
  prepared=mountCacheOperation(root.querySelector('[data-cache-transfer-target]'),{store,action:'prepare',machine:choice.machine,dataset,version,capabilities:choice.capabilities,signal:lifetime.signal,explain:false,onChange:value=>{
   if(!live())return;
   if((!value.confirmed||value.state!=='READY'||value.receiptOnly||value.locationState==='NOT_OBSERVED')&&!released?.snapshot().request){released?.destroy();released=null;checked=null;}
   root.querySelector('select').disabled=!!value.request&&!(value.confirmed&&['FAILED','BLOCKED','CANCELED'].includes(value.state));onChange(value);void sourceCapability(value);
  }});
 }
 root.querySelector('[data-cache-transfer-open]').addEventListener('click',()=>{root.querySelector('[data-cache-transfer-body]').hidden=false;if(!prepared)select();root.querySelector('select').focus();},{signal:lifetime.signal});
 root.querySelector('select').addEventListener('change',select,{signal:lifetime.signal});
 function destroy(){lifetime.abort();prepared?.destroy();released?.destroy();root.remove();}
 function sync(){if(!live()){destroy();return;}prepared?.sync();released?.sync();}
 const unsubscribe=store.onAuthChange?.(sync);lifetime.signal.addEventListener('abort',()=>{if(typeof unsubscribe==='function')unsubscribe();},{once:true});
 signal?.addEventListener('abort',destroy,{once:true});return {destroy,sync};
}
