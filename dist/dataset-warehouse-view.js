import {aggregateDatasetCatalog} from './dataset-catalog-model.js';
import {datasetLabelClient} from './dataset-label-client.js';
import {transferBytes} from './data-route.js';
import {selectUploadRoute,validateUploadRoutes} from './upload-routes.js';
import {probeBrowserUploadRoute} from './dataset-upload.js';
import {datasetInfoHTML as info} from './dataset-flow.js';
import {cacheAdminHTML} from './dataset-cache-admin.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=value=>Number.isSafeInteger(value)&&value>=0?transferBytes(value):'—';
const glyph=value=>`<span class="v3-g ${value==='READY'?'ready':value==='PREPARING'?'fetch':value==='FAILED'?'fail':value==='UNKNOWN'?'unknown':'none'}" aria-hidden="true"></span>`;
const strata=state=>`<span class="v3-strata ${state==='pending'?'storing':state==='saved'?'':state==='failed'?'failed':'out'}" aria-hidden="true"><i></i><i></i><i></i></span>`;
const short=value=>String(value).replace(/^amax-/,'');
const words={READY:'已缓存',PREPARING:'取回中',FAILED:'取回失败',UNKNOWN:'待确认',STAGING:'上传未完成',REGISTERED:'未缓存',NOT_LOCAL:'未缓存'};
const chosen=item=>item.versions.find(row=>row.selected.state==='READY')||item.versions[0];
const usage=value=>value?.available===true&&Number.isSafeInteger(value.filesystemBytes)&&value.filesystemBytes>0&&Number.isSafeInteger(value.availableBytes)&&value.availableBytes>=0&&value.availableBytes<=value.filesystemBytes?Math.round((value.filesystemBytes-value.availableBytes)/value.filesystemBytes*100):null;

export function warehouseWorkspaceHTML(){
 return `<div class="warehouse-v3"><div id="warehouse-server-rail" class="v3-rail" role="group" aria-label="按缓存所在服务器筛选"></div><div class="v3-split"><section class="v3-list" aria-label="仓库"><header class="v3-list-head"><h2>${strata('saved')}仓库</h2><input id="warehouse-search" class="v3-search" type="search" placeholder="搜索名称或 ID" aria-label="搜索数据集"><button id="datasets-refresh" class="button quiet v3-refresh" type="button" aria-label="刷新仓库">↻</button></header><div class="v3-cols" aria-hidden="true"><span></span><span>名称</span><span>所属</span><span>版本</span><span>大小</span><span>已缓存在</span></div><p id="datasets-status" role="status"></p><div id="dataset-catalog" role="listbox" aria-label="数据集"></div></section><aside id="warehouse-inspector" class="v3-inspector" aria-label="数据集详情"></aside></div><div class="v3-legacy-context" hidden><div class="terminal-controls datasets-controls"><label><span>上传到</span><select name="dataset-machine"></select></label></div><div id="datasets-capacity" hidden></div><div id="datasets-quota" hidden></div><div id="datasets-database" hidden></div></div></div>`;
}

export function datasetWarehouseView(store,section,toast,{refresh,cacheAdmin}){
 let model=null,selected=null,selectedVersion=null,filter=null,search='',capacities=new Map(),epoch=0,routeEpoch=0,route=null,routeAbort=null,selectedFiles=[],uploadName='',phoneDetail=false,installedObserver=null;
 const account=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
 const machine=()=>section.querySelector('[name=dataset-machine]')?.value;
 const identity=()=>({userId:store.principal?.userId,role:store.principal?.role,authGeneration:store.authGeneration});
 const labels=datasetLabelClient({call:(operation,args)=>store.call(operation,args),identity});
 const current=(expected,token)=>account()===expected&&epoch===token;
 const admin=()=>store.principal?.role==='admin';
 const authorized=id=>(store.data?.machines||[]).some(row=>row.id===id);
 function reset(){epoch++;routeEpoch++;routeAbort?.abort();routeAbort=null;model=null;selected=null;selectedVersion=null;capacities.clear();labels.reset();selectedFiles=[];uploadName='';phoneDetail=false;section.querySelector('.v3-label-dialog')?.close();}
 function header(){
  const root=document.querySelector('#page-title');if(document.body.dataset.room!=='datasets'){document.querySelector('#warehouse-page-actions')?.remove();return;}
  if(root){root.querySelector('.v3-count')?.remove();if(model){const count=document.createElement('span');count.className='v3-count';count.textContent=model.datasets.length+' 个';root.append(count);}}
  const host=document.querySelector('.page-heading .heading-actions');if(host&&!host.querySelector('#warehouse-page-actions')){const actions=document.createElement('span');actions.id='warehouse-page-actions';actions.className='v3-head-actions';actions.innerHTML='<a class="button quiet" href="#datasets/transfers">传输记录</a><button class="button primary" type="button" data-v3-upload>＋ 上传数据</button>';host.prepend(actions);}
 }
 function rail(){
  const root=section.querySelector('#warehouse-server-rail');if(!root)return;
  const rows=model?.machines||(store.data?.machines||[]).map(row=>({machine:row.id}));
  root.innerHTML=`<button type="button" class="v3-server-chip v3-all" data-v3-filter="" aria-pressed="${!filter}">全部</button>`+rows.map(row=>{const pct=usage(capacities.get(row.machine));return `<button type="button" class="v3-server-chip" data-v3-filter="${esc(row.machine)}" aria-pressed="${filter===row.machine}" title="${esc(row.machine)}${pct===null?'':' · 共享数据盘已用 '+pct+'%'}"><span class="v3-server-name"><span>${row.machine===machine()?'<i class="v3-here" aria-label="所选服务器"></i>':''}${esc(row.machine)}</span>${pct===null?'':`<small class="num">${pct}%</small>`}</span>${pct===null?'':`<span class="v3-cap ${pct>=80?'hot':''}" aria-hidden="true"><i style="width:${pct}%"></i></span>`}</button>`;}).join('');
 }
 function visible(){return (model?.datasets||[]).filter(item=>(!filter||item.versions.some(v=>v.servers.some(row=>row.machine===filter&&row.observed&&!['NOT_LOCAL','REGISTERED'].includes(row.state))))&&(!search||(item.displayName+' '+item.dataset).toLowerCase().includes(search)));}
 function rows(){
  const root=section.querySelector('#dataset-catalog');if(!root)return;const items=visible();
  root.innerHTML=items.map(item=>{const v=chosen(item);if(!v)return '';const caches=v.servers.filter(row=>row.observed&&['READY','PREPARING','FAILED','UNKNOWN'].includes(row.state));
   const flags=v.warehouse.state==='unrecorded'?'<span class="v3-flag warn">未存入仓库</span>':v.warehouse.state==='unknown'?'<span class="v3-flag warn">待确认</span>':v.warehouse.state==='failed'?'<span class="v3-flag bad">存入失败</span>':'';
   return `<button class="v3-row" type="button" role="option" aria-selected="${selected===item.dataset}" data-v3-select="${esc(item.dataset)}">${strata(v.warehouse.state)}<span class="v3-name"><b title="${esc(item.displayName)}">${esc(item.displayName)}</b><span class="v3-id" title="${esc(item.dataset)}">${esc(item.dataset)}</span></span><span class="v3-owner" title="${esc(v.ownerLabel||'所属未知')}">${esc(v.ownerLabel||'未知')}</span><span class="v3-versions num">${item.versions.length}</span><span class="v3-size num">${esc(amount(v.bytes))}</span><span class="v3-where">${caches.map(row=>`<span class="v3-pip" title="${esc(row.machine+' · '+words[row.state])}">${glyph(row.state)}${esc(short(row.machine))}</span>`).join('')}${flags}</span></button>`;
  }).join('')||(model?`<div class="v3-empty">${model.partial?'目录待确认':search?'没有匹配的数据集':filter?'这台服务器上还没有缓存':'仓库里还没有数据集'}${!search&&!filter&&!model.partial?'<button type="button" class="button primary" data-v3-upload>＋ 上传数据</button>':''}</div>`:'');
 }
 function inspector(){
  const root=section.querySelector('#warehouse-inspector'),item=model?.datasets.find(row=>row.dataset===selected);if(!root)return;
  if(!item){root.replaceChildren();return;}const v=item.versions.find(row=>row.version===selectedVersion)||chosen(item);if(!v){root.replaceChildren();return;}selectedVersion=v.version;
  const w=v.warehouse,storeWords={saved:'已存入仓库',pending:'正在存入仓库',unrecorded:'未存入仓库',unknown:'待确认',failed:'存入失败'};
  const versions=item.versions.length>1?`<select class="v3-version" data-v3-version aria-label="版本">${item.versions.map(row=>`<option value="${esc(row.version)}" ${row===v?'selected':''}>${esc(row.version.slice(0,12))}</option>`).join('')}</select>`:`<button type="button" class="v3-copy" data-v3-copy="${esc(v.version)}" title="${esc(v.version)}">${esc(v.version.slice(0,12))} · 复制</button>`;
  const canTrain=v.selected.state==='READY'||v.selected.state==='PREPARING'||v.selected.canPrepare===true&&!['UNKNOWN','FAILED'].includes(v.selected.state);
  root.innerHTML=`<button class="button quiet v3-back" type="button" data-v3-back>‹ 数据集</button><section><h2><span title="${esc(item.displayName)}">${esc(item.displayName)}</span><button type="button" class="v3-edit" data-v3-label="${esc(item.dataset)}" aria-label="修改显示名">✎</button></h2><div class="v3-idline"><code title="${esc(item.dataset)}">${esc(item.dataset)}</code><button type="button" class="v3-copy" data-v3-copy="${esc(item.dataset)}">复制</button></div><div class="v3-meta"><span>${esc(v.ownerLabel||'所属未知')}</span><span class="num">${esc(amount(v.bytes))}</span>${v.files===null?'':`<span class="num">${v.files.toLocaleString('zh-CN')} 个文件</span>`}<span>${item.versions.length} 个版本</span></div></section><section><div class="v3-lab">仓库${versions}</div><div class="v3-store">${strata(w.state)}<span>${storeWords[w.state]}</span>${w.machine?`<code title="${esc(w.machine)}">${esc(w.machine)}</code>`:''}</div>${w.records.filter(row=>row.machine===machine()&&row.storage.version===v.version&&['FAILED','BLOCKED'].includes(row.storage.phase)).map(row=>`<button class="button" type="button" data-retry-archive="${esc(row.storage.dataset)}" data-version="${esc(v.version)}">重试</button>`).join('')}</section><section><div class="v3-lab copy-caption"><span>服务器</span>${admin()?info('移除前重新核对完整副本；最后副本、正在训练、固定保留或结果待确认时不可移除。','缓存操作'):''}</div>${v.servers.map(row=>{
   const mayCache=authorized(row.machine)&&!['READY','PREPARING','UNKNOWN'].includes(row.state)&&row.canPrepare;
   const cacheAction=row.state==='READY'?admin()?`<span class="dataset-more-slot" data-dataset-more-slot data-machine="${esc(row.machine)}" data-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" data-dataset-state="${esc(row.state)}" ${row.dataset?`data-local-dataset="${esc(row.dataset)}"`:''}></span>`:'':row.state==='PREPARING'?'':`<button class="button quiet v3-small" type="button" data-v3-cache="${esc(row.machine)}" data-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${mayCache?'':'disabled'}>${row.state==='FAILED'?'重试':'缓存'}</button>`;
   return `<article class="v3-server dataset-card ${row.machine===machine()?'cur':''}">${glyph(row.state)}<span class="v3-server-text"><b title="${esc(row.machine)}">${esc(row.machine)}</b><span>${row.state==='NOT_LOCAL'||row.state==='REGISTERED'?'':words[row.state]}</span></span>${cacheAction}</article>`;
  }).join('')}${admin()?`<details class="v3-policy"><summary>缓存策略与保留</summary><div class="v3-retention"><span>固定保留</span>${v.servers.filter(row=>row.machine===machine()&&row.dataset).map(row=>`<div class="dataset-pin-slot" data-cache-pin-slot data-machine="${esc(row.machine)}" data-dataset="${esc(row.dataset)}" data-version="${esc(v.version)}"></div>`).join('')}</div>${cacheAdminHTML(true)}</details>`:''}</section><section class="v3-train"><button class="button primary" type="button" data-use-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${canTrain?'':'disabled'}>用于训练</button><div class="v3-code"><code title="${esc('--data '+item.dataset+'@'+v.version)}">--data ${esc(item.dataset)}@${esc(v.version)}</code><button type="button" class="v3-copy" data-v3-copy="${esc('--data '+item.dataset+'@'+v.version)}">复制</button></div><div class="v3-code"><span>容器内</span><code>/data2/${esc(item.dataset)}</code><span class="v3-lock">只读</span></div></section>`;
  section.querySelector('.warehouse-v3').classList.toggle('v3-phone-detail',phoneDetail);cacheAdmin.render();requestAnimationFrame(fitInspector);
 }
 function fitInspector(){
  const root=section.querySelector('#warehouse-inspector');if(!root?.isConnected||section.hidden)return;
  if(matchMedia('(max-width:759px)').matches){root.style.removeProperty('max-height');return;}
  const dock=document.querySelector('#control-strip'),bottom=dock&&!dock.hidden&&dock.getClientRects().length?dock.getBoundingClientRect().top:innerHeight;
  root.style.maxHeight=Math.max(180,Math.floor(bottom-Math.max(120,root.getBoundingClientRect().top)-20))+'px';
 }
 function render(){header();rail();rows();inspector();}
 function catalog(value){model=aggregateDatasetCatalog(value);if(!model.datasets.some(item=>item.dataset===selected)){selected=model.datasets[0]?.dataset||null;selectedVersion=null;}render();}
 function capacity(value,id){capacities.set(id,value);rail();uploadCapacity();}
 async function capacitiesForOthers(){const expected=account(),token=epoch;for(const row of store.data?.machines||[]){if(row.id===machine()||capacities.has(row.id))continue;store.call('datasets.capacity',{machine:row.id}).then(value=>{if(current(expected,token))capacity(value,row.id);}).catch(()=>{if(current(expected,token)){capacities.set(row.id,null);rail();}});}}
 function uploadCapacity(){const node=section.querySelector('#v3-upload-capacity'),value=capacities.get(machine());if(node)node.textContent=value?.available===true&&Number.isSafeInteger(value.usableBytes)?'可用 '+amount(value.usableBytes):'';}
 function uploadRoute(){const node=section.querySelector('#v3-upload-route');if(!node)return;const kind=route?.kind;
  node.className='v3-route '+(kind==='campus-direct'?'ok':kind==='tail-upload'?'alt':kind==='unreachable'?'cut':'');
  const caption=kind==='campus-direct'?'校园网直连':kind==='tail-upload'?'备用线路':kind==='relay-choice'?'平台中转':kind==='unreachable'?'没连上校园网':kind==='unconfirmed'?'路线待确认':'探测中';
  node.setAttribute('aria-label','你的电脑 · '+caption+' · '+(machine()||'未选择服务器'));
  node.innerHTML=`<span class="v3-route-end"><i></i>你的电脑</span><span class="v3-route-seg"></span><span class="v3-route-via">${caption}</span><span class="v3-route-seg"></span><span class="v3-route-end"><i></i><span title="${esc(machine())}">${esc(machine()||'未选择服务器')}</span></span>`;
 }
 async function probe(){
  const expected=account(),token=++routeEpoch,target=machine();routeAbort?.abort();routeAbort=new AbortController();const signal=routeAbort.signal;route=null;uploadRoute();let probeable=false;
  try{const value=await store.call('datasets.upload.routes',{machine:target});if(token!==routeEpoch||expected!==account()||target!==machine()||signal.aborted)return;
   validateUploadRoutes(value,target);probeable=true;
   const selected=await selectUploadRoute(value,target,candidate=>probeBrowserUploadRoute(candidate,{signal}),{signal});
   if(token!==routeEpoch||expected!==account()||target!==machine()||signal.aborted)return;route=selected;
  }catch(error){if(token!==routeEpoch||expected!==account()||signal.aborted)return;route={kind:!probeable?'unconfirmed':selectedFiles.length&&selectedFiles.reduce((n,file)=>n+file.size,0)<=256*1024**2?'relay-choice':'unreachable',error};}
  uploadRoute();const start=section.querySelector('#dataset-upload-start');if(start)start.disabled=!['campus-direct','tail-upload'].includes(route?.kind);
 }
 function selection(){
  selectedFiles=Array.from(section.querySelector('[name=dataset-directory]')?.files||[]);if(!selectedFiles.length)return;
  const path=selectedFiles[0].webkitRelativePath||selectedFiles[0].name,folder=path.includes('/')?path.split('/')[0]:selectedFiles.length===1?selectedFiles[0].name:'所选文件';
  if(!uploadName)uploadName=/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(folder)?folder:'data-'+crypto.randomUUID().slice(0,8);
  section.querySelector('[name=dataset-name]').value=uploadName;
  const display=section.querySelector('#v3-upload-display');if(display&&!display.value)display.value=folder;
  const file=section.querySelector('#v3-upload-file');if(file)file.innerHTML=`<span class="v3-folder" aria-hidden="true"></span><div><b title="${esc(folder)}">${esc(folder)}</b><span class="num">${selectedFiles.length.toLocaleString('zh-CN')} 个文件 · ${amount(selectedFiles.reduce((n,f)=>n+f.size,0))}</span></div><button type="button" class="button quiet" data-v3-reselect>更换</button>`;
  section.querySelector('#dataset-add-dialog').classList.add('v3-picked');section.querySelector('#dataset-panel-directory').hidden=false;uploadCapacity();uploadRoute();
  section.querySelector('#dataset-upload-start').disabled=!['campus-direct','tail-upload'].includes(route?.kind);
 }
 async function editLabel(dataset){
  if(section.querySelector('.v3-label-dialog'))return;const expected=account(),token=epoch;let snapshot=null;
  const dialog=document.createElement('dialog');dialog.className='v3-label-dialog';dialog.innerHTML='<form><h2>修改显示名</h2><label class="field">名称<input name="displayName" required></label><p role="status">读取中…</p><div class="file-actions"><button class="button" type="button" data-v3-label-close>取消</button><button class="button primary" type="submit" disabled>保存</button></div></form>';section.append(dialog);dialog.showModal();
  const status=dialog.querySelector('[role=status]'),input=dialog.querySelector('input'),button=dialog.querySelector('[type=submit]'),valid=()=>current(expected,token)&&dialog.isConnected&&dialog.open;
  dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('[data-v3-label-close]').onclick=()=>dialog.close();
  try{snapshot=await labels.get({machine:machine(),dataset});if(!valid())return;input.value=snapshot.name;status.textContent='';button.disabled=false;}catch(error){if(valid())status.textContent=error.message;}
  dialog.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();if(!snapshot||button.disabled||!valid())return;button.disabled=true;try{const result=await labels.set(snapshot,input.value);if(!valid())return;if(result.status==='CONFLICT'){snapshot=result.label;status.textContent=result.label?'名称已被修改，请确认最新名称后再保存。':'最新名称未确认，请关闭后重新读取。';if(result.label)input.value=result.label.name;button.disabled=!snapshot;return;}dialog.close();await refresh();}catch(error){if(valid()){status.textContent=error.message;snapshot=null;}}});
 }
 function install(){
  epoch++;installedObserver?.disconnect();header();rail();
  const dialog=section.querySelector('#dataset-add-dialog');if(!dialog)return;
  section.append(dialog);
  dialog.classList.add('v3-upload');dialog.querySelector('h2').textContent='上传数据';
  dialog.querySelector('#dataset-upload-start').textContent='开始上传';
  const body=document.createElement('div');body.className='v3-upload-opening';body.innerHTML='<div class="v3-drop" id="v3-drop"><div><span class="v3-tray" aria-hidden="true"><i></i></span><h3>拖入文件夹或文件</h3><div class="file-actions"><button class="button primary" type="button" data-v3-folder>选择文件夹</button><button class="button" type="button" data-v3-files>选择文件</button></div></div></div><div class="v3-other-sources"><button class="button quiet" type="button" data-v3-source="link">从链接下载</button><button class="button quiet" type="button" data-v3-source="aliyun">阿里云盘导入</button><button class="button quiet" type="button" data-v3-source="workspace">在服务器上整理</button></div><input id="v3-file-picker" type="file" multiple hidden>';
  dialog.querySelector('.dataset-sheet-context').before(body);
  const summary=document.createElement('div');summary.id='v3-upload-file';summary.className='v3-file';dialog.querySelector('#dataset-upload-form').prepend(summary);
  const field=document.createElement('div');field.className='field v3-display-field';field.innerHTML='<label for="v3-upload-display">名称</label><input id="v3-upload-display" maxlength="160" autocomplete="off"><span class="v3-raw-id">ID 上传完成后返回</span>';summary.after(field);
  const routeNode=document.createElement('div');routeNode.id='v3-upload-route';routeNode.className='v3-route';const context=dialog.querySelector('.dataset-sheet-context');field.after(context);context.after(routeNode);
  const caption=section.querySelector('[name=dataset-machine]').closest('label');caption.querySelector('span').textContent='上传到';const available=document.createElement('span');available.id='v3-upload-capacity';caption.prepend(available);
  dialog.addEventListener('close',()=>{routeEpoch++;routeAbort?.abort();});
  installedObserver=new MutationObserver(()=>{if(dialog.open){dialog.querySelector('[data-dataset-source=directory]').click();dialog.classList.toggle('v3-picked',selectedFiles.length>0);probe();}});installedObserver.observe(dialog,{attributes:true,attributeFilter:['open']});
  const drop=dialog.querySelector('#v3-drop');drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));
  drop.addEventListener('drop',async event=>{event.preventDefault();drop.classList.remove('dragging');const files=[];const expected=account(),token=epoch;
   async function walk(entry,path=''){if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));const selected=new File([file],file.name,{type:file.type,lastModified:file.lastModified});Object.defineProperty(selected,'webkitRelativePath',{value:path+file.name});files.push(selected);}else if(entry.isDirectory){const reader=entry.createReader();while(true){const entries=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!entries.length)break;for(const next of entries)await walk(next,path+entry.name+'/');}}}
   try{const entries=[...event.dataTransfer.items].map(item=>item.webkitGetAsEntry?.()).filter(Boolean);if(entries.length)for(const entry of entries)await walk(entry);else files.push(...event.dataTransfer.files);if(!current(expected,token))return;assignFiles(files);}catch(error){if(current(expected,token))toast(error.message);}
  });
  uploadCapacity();uploadRoute();
 }
 function assignFiles(files){const transfer=new DataTransfer();files.forEach(file=>transfer.items.add(file));const input=section.querySelector('[name=dataset-directory]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
 section.addEventListener('change',event=>{if(event.target.name==='dataset-directory')selection();if(event.target.id==='v3-file-picker')assignFiles([...event.target.files]);if(event.target.hasAttribute('data-v3-version')){selectedVersion=event.target.value;inspector();}if(event.target.name==='dataset-machine'){epoch++;model=null;selected=null;selectedVersion=null;section.querySelector('.v3-label-dialog')?.close();routeEpoch++;if(section.querySelector('#dataset-add-dialog')?.open)probe();render();}});
 section.addEventListener('input',event=>{if(event.target.id==='warehouse-search'){search=event.target.value.trim().toLowerCase();rows();}});
 document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.hasAttribute('data-v3-upload')){section.querySelector('#datasets-add').open=true;return;}
  if(!section.contains(button))return;
  if(button.hasAttribute('data-v3-select')){selected=button.dataset.v3Select;selectedVersion=null;phoneDetail=matchMedia('(max-width:759px)').matches;rows();inspector();if(phoneDetail)section.scrollIntoView({block:'start'});return;}
  if(button.hasAttribute('data-v3-filter')){filter=button.dataset.v3Filter||null;rail();rows();return;}
  if(button.hasAttribute('data-v3-back')){phoneDetail=false;section.querySelector('.warehouse-v3').classList.remove('v3-phone-detail');return;}
  if(button.hasAttribute('data-v3-label')){await editLabel(button.dataset.v3Label);return;}
  if(button.hasAttribute('data-v3-copy')){try{await navigator.clipboard.writeText(button.dataset.v3Copy);toast('已复制');}catch{toast('请手动选择后复制。');}return;}
  if(button.hasAttribute('data-v3-folder')||button.hasAttribute('data-v3-reselect')){section.querySelector('[name=dataset-directory]').click();return;}
  if(button.hasAttribute('data-v3-files')){section.querySelector('#v3-file-picker').click();return;}
  if(button.hasAttribute('data-v3-source')){const source=button.dataset.v3Source;section.querySelector('#dataset-add-dialog').classList.add('v3-other');section.querySelector('[data-dataset-source="'+(source==='aliyun'?'link':source)+'"]').click();if(source==='aliyun'){const select=section.querySelector('[name=cloud-source]');select.value='aliyun';select.dispatchEvent(new Event('change',{bubbles:true}));}return;}
  if(button.hasAttribute('data-v3-cache')){const expected=account(),token=epoch,target=button.dataset.v3Cache;button.disabled=true;try{const value=await store.call('datasets.catalog',{machine:target});if(!current(expected,token)||!button.isConnected)return;const v=value.datasets?.find(row=>row.dataset===button.dataset.dataset)?.versions?.find(row=>row.version===button.dataset.version);if(v?.canPrepare!==true||['READY','PREPARING','UNKNOWN'].includes(v.state))throw Error('缓存条件待确认，请刷新。');await store.call('datasets.prepare',{machine:target,dataset:button.dataset.dataset,version:button.dataset.version});if(current(expected,token))await refresh();}catch(error){if(current(expected,token))toast(error.message);}finally{if(button.isConnected)button.disabled=false;}return;}
 });
 new MutationObserver(()=>{header();if(document.body.dataset.room!=='datasets'){section.querySelector('#dataset-add-dialog')?.close();}}).observe(document.body,{attributes:true,attributeFilter:['data-room']});
 store.onAuthChange?.(reset);
 globalThis.addEventListener('resize',()=>requestAnimationFrame(fitInspector));
 globalThis.addEventListener('scroll',()=>requestAnimationFrame(fitInspector),{passive:true});
 return {install,catalog,capacity,render,reset,capacitiesForOthers};
}
