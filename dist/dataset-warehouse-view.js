import {aggregateDatasetCatalog,readableDatasetCatalog,datasetOwnerName,adaptStorageOverview,overviewDatasetCatalog,displayStorageCapacity} from './dataset-catalog-model.js';
import {datasetLabelClient,normalizeDatasetDisplayName} from './dataset-label-client.js';
import {createUploadMeter} from './dataset-upload-metrics.js';
import {maintenanceFor} from './maintenance-state.js';
import {transferBytes} from './data-route.js';
import {selectUploadRoute,validateUploadRoutes,uploadStorageMachine} from './upload-routes.js';
import {probeBrowserUploadRoute} from './dataset-upload.js';
import {datasetInfoHTML as info,warehouseCapacityHTML,cacheCapacityRatio,cacheCapacityAmount,cacheCapacityTitle,cacheCapacityRailHTML,storageCapacityDetailHTML,applyCapacityGeometry} from './dataset-flow.js';
import {datasetCacheWatch} from './dataset-cache-watch.js';
import {mountCacheOperation,mountCacheTransfer,canCacheAction} from './dataset-cache-operation.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=value=>Number.isSafeInteger(value)&&value>=0?transferBytes(value):'—';
const glyph=value=>`<span class="v3-g ${value==='READY'?'ready':value==='PREPARING'?'fetch':value==='FAILED'?'fail':value==='UNKNOWN'?'unknown':'none'}" aria-hidden="true"></span>`;
const strata=state=>`<span class="v3-strata ${state==='pending'?'storing':state==='saved'?'':state==='failed'?'failed':'out'}" aria-hidden="true"><i></i><i></i><i></i></span>`;
const short=value=>String(value);
const words={READY:'已缓存',PREPARING:'取回中',FAILED:'取回失败',UNKNOWN:'待确认',STAGING:'上传未完成',REGISTERED:'未缓存',NOT_LOCAL:'未缓存'};
const chosen=item=>item.versions.find(row=>row.selected.state==='READY')||item.versions[0];

export function warehouseWorkspaceHTML(){
 return `<div class="warehouse-v3"><div id="warehouse-server-rail" class="v3-rail" role="group" aria-label="按缓存所在服务器筛选"></div><div class="v3-split"><section class="v3-list" aria-label="仓库"><header class="v3-list-head"><h2>${strata('saved')}仓库</h2><input id="warehouse-search" class="v3-search" type="search" placeholder="搜索名称或 ID" aria-label="搜索数据集"><button id="datasets-refresh" class="button quiet v3-refresh" type="button" aria-label="刷新仓库">↻</button></header><div id="warehouse-capacity"></div><div id="warehouse-machine-capacity"></div><div class="v3-cols" aria-hidden="true"><span></span><span>名称</span><span>所属</span><span>版本</span><span>大小</span><span>已缓存在</span></div><p id="datasets-status" role="status"></p><div id="dataset-catalog" role="listbox" aria-label="数据集"></div></section><aside id="warehouse-inspector" class="v3-inspector" aria-label="数据集详情"></aside></div><div class="v3-legacy-context" hidden><div class="terminal-controls datasets-controls"><label><span>上传到</span><select name="dataset-machine"></select></label></div><div id="datasets-capacity" hidden></div><div id="datasets-quota" hidden></div><div id="datasets-database" hidden></div></div></div>`;
}

export function datasetWarehouseView(store,section,toast,{refresh,removeUI,machineAllowed,authorizedMachines,access}){
 let model=null,selected=null,selectedVersion=null,filter=null,search='',capacities=new Map(),epoch=0,routeEpoch=0,route=null,routeAbort=null,selectedFiles=[],uploadName='',phoneDetail=false,installedObserver=null;
 let upload=null,uploadBusy=false,uploadLocked=false,uploadDisplay='',lastControls={};
 let overview=null,legacyCatalog=null,capacityCatalog=null,overviewRequest=0,overviewAbort=null;
 const cacheCapabilities=new Map();let capabilityScope=null,capabilityRequest=0,capabilityAbort=null,capabilityBusy=false,capabilityUnavailable=false,actionUI=null,actionLifetime=null,actionContext=null;
 const meter=createUploadMeter(),templates=new WeakMap();
 const account=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
 const machine=()=>section.querySelector('[name=dataset-machine]')?.value;
 const identity=()=>({userId:store.principal?.userId,role:store.principal?.role,authGeneration:store.authGeneration});
 const labels=datasetLabelClient({call:(operation,args)=>store.call(operation,args),identity});
 const current=(expected,token)=>account()===expected&&epoch===token;
 const authorized=machineAllowed;
 const cacheWatch=datasetCacheWatch({call:(operation,args)=>store.call(operation,args),identity:account,
  active:()=>store.production&&!!store.principal&&!section.hidden&&document.body.dataset.room==='datasets'&&!document.hidden,
  allowed:authorized,onChange:()=>{rows();inspector();},onReady:refresh});
 const cacheRow=(dataset,v,row)=>{const watch=cacheWatch.get({machine:row.machine,dataset,version:v.version});return watch?{...row,state:watch.state,error:watch.error,progress:watch.progress}:row;};
 const versionAccess=(v,target=machine())=>access({state:v.selected.state,canUse:v.canUse,canPrepare:v.selected.canPrepare,sourceMachine:v.selected.sourceMachine,locations:v.servers},{machine:target},{machineAuthorized:authorized(target)});
 const personalDelete=(dataset,version)=>removeUI?.canOpenFullDelete?.(dataset,version)===true&&model?.datasets.find(row=>row.dataset===dataset)?.versions.find(row=>row.version===version)?.servers.some(row=>row.deletionPermissions?.memberAllowed===true)===true;
 function allowsTraining(dataset,version){
  if(!authorized(machine())||lastControls.busy||maintenanceFor(store.data?.operationalMaintenance,machine()))return false;
  const v=model?.datasets.find(row=>row.dataset===dataset)?.versions.find(row=>row.version===version);
  if(v)return versionAccess(v).selectable;
  return upload?.state==='READY'&&upload.machine===machine()&&upload.dataset===dataset&&upload.version===version;
 }
 function reset(){epoch++;cacheWatch.reset();retireCacheActions();overviewRequest++;overviewAbort?.abort();overviewAbort=null;overview=null;legacyCatalog=null;capacityCatalog=null;routeEpoch++;routeAbort?.abort();routeAbort=null;route=null;model=null;selected=null;selectedVersion=null;capacities.clear();labels.reset();selectedFiles=[];uploadName='';uploadDisplay='';upload=null;uploadBusy=false;uploadLocked=false;meter.reset();phoneDetail=false;section.querySelector('.v3-label-dialog')?.close();capacityOverview();}
 function closeCacheAction(){actionLifetime?.abort();actionUI?.destroy();actionUI=null;actionLifetime=null;actionContext=null;section.querySelector('#warehouse-cache-action')?.close();}
 function retireCacheActions(close=true){capabilityRequest++;capabilityAbort?.abort();capabilityAbort=null;capabilityScope=null;capabilityBusy=false;capabilityUnavailable=false;cacheCapabilities.clear();if(close)closeCacheAction();}
 async function readCacheCapabilities(){
  if(!overview||!store.production||!store.principal||section.hidden||document.body.dataset.room!=='datasets'||capabilityBusy||capabilityUnavailable)return;
  const v=model?.datasets.find(item=>item.dataset===selected)?.versions.find(row=>row.version===selectedVersion);
  if(!v?.canUse)return;
  const expected=account(),token=epoch,scope=JSON.stringify([expected,selected,selectedVersion]),dataset=selected,version=selectedVersion;
  if(capabilityScope!==scope){retireCacheActions(false);capabilityScope=scope;}
  if(v.servers.every(row=>!authorized(row.machine)||cacheCapabilities.has(row.machine)))return;
  const request=capabilityRequest,controller=new AbortController();capabilityAbort=controller;capabilityBusy=true;
  const valid=()=>current(expected,token)&&request===capabilityRequest&&capabilityScope===scope&&!section.hidden&&document.body.dataset.room==='datasets';
  try{for(const row of v.servers){
   if(!authorized(row.machine)||cacheCapabilities.has(row.machine))continue;
   try{const raw=await store.call('datasets.cache.capabilities',{machine:row.machine,dataset,version},{signal:controller.signal});if(!valid())return;cacheCapabilities.set(row.machine,{raw});}
   catch(error){if(!valid())return;if(error.status===404||/unknown operation|未知操作/i.test(error.message)){capabilityUnavailable=true;cacheCapabilities.clear();break;}cacheCapabilities.set(row.machine,{reason:error.message});}
   if(valid())inspector();
  }}finally{if(valid()){capabilityBusy=false;inspector();}}
 }
 function openCacheAction(action,target){
  const item=model?.datasets.find(row=>row.dataset===selected),v=item?.versions.find(row=>row.version===selectedVersion),row=v?.servers.find(value=>value.machine===target),cap=cacheCapabilities.get(target)?.raw;
  if(!v?.canUse||!row||!authorized(target)||maintenanceFor(store.data?.operationalMaintenance,target)||!overview||lastControls.busy||capabilityScope!==JSON.stringify([account(),selected,selectedVersion]))return;
  const targets=v.servers.filter(value=>value.machine!==target&&authorized(value.machine)&&!maintenanceFor(store.data?.operationalMaintenance,value.machine)&&canCacheAction(cacheCapabilities.get(value.machine)?.raw,'prepare')).map(value=>({machine:value.machine,capabilities:cacheCapabilities.get(value.machine).raw}));
  if(action==='transfer'?(row.state!=='READY'||!targets.length):!canCacheAction(cap,action))return;
  closeCacheAction();let dialog=section.querySelector('#warehouse-cache-action');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='warehouse-cache-action';dialog.className='dataset-sheet v3-cache-sheet';dialog.innerHTML='<header class="dataset-sheet-head"><h2></h2><button class="button quiet" type="button" data-v3-cache-close aria-label="关闭">关闭</button></header><div data-v3-cache-host></div>';section.append(dialog);dialog.addEventListener('close',()=>{if(!dialog.open)closeCacheAction();});}
  dialog.querySelector('h2').textContent=action==='transfer'?'转移缓存':action==='release'?'释放缓存':'缓存';dialog.querySelector('[data-v3-cache-host]').replaceChildren();actionLifetime=new AbortController();actionContext=JSON.stringify([account(),selected,selectedVersion]);dialog.showModal();
  const expected=account(),token=epoch,observed=new Set(),options={store,dataset:item.dataset,version:v.version,signal:actionLifetime.signal,onChange:value=>{const key=JSON.stringify([value.operationId,value.state,value.receiptOnly,value.locationState]);if(current(expected,token)&&value.confirmed&&(['READY','RELEASED','CANCELED','FAILED','BLOCKED'].includes(value.state)||value.receiptOnly||value.locationState==='NOT_OBSERVED')&&!observed.has(key)){observed.add(key);refresh();}}};
  actionUI=action==='transfer'?mountCacheTransfer(dialog.querySelector('[data-v3-cache-host]'),{...options,source:target,targets}):mountCacheOperation(dialog.querySelector('[data-v3-cache-host]'),{...options,action,machine:target,capabilities:cap});
  if(action==='transfer')dialog.querySelector('[data-cache-transfer-open]')?.click();
 }
 function html(root,value){
  // A refresh clears the list while reading. An identical reply must restore
  // that DOM; the cached template alone does not prove it is still mounted.
  if(templates.get(root)===value&&(root.hasChildNodes()||value===''))return;
  const scroll=root.querySelector('.v3-detail-scroll'),position=scroll?.scrollTop||0;
  const folds=[...root.querySelectorAll('details[open]')].map(node=>node.id||node.className);
  const active=root.contains(document.activeElement)?document.activeElement:null;
  const focus=active?.id?'#'+CSS.escape(active.id):active?.hasAttribute('data-v3-version')?'[data-v3-version]':active?.hasAttribute('data-v3-filter')?'[data-v3-filter="'+CSS.escape(active.dataset.v3Filter)+'"]':active?.hasAttribute('data-v3-select')?'[data-v3-select="'+CSS.escape(active.dataset.v3Select)+'"]':active?.hasAttribute('data-use-dataset')?'[data-use-dataset="'+CSS.escape(active.dataset.useDataset)+'"]':null;
  templates.set(root,value);root.innerHTML=value;
  for(const node of root.querySelectorAll('[data-v3-percent]')){const percent=Number(node.dataset.v3Percent);if(Number.isFinite(percent)&&percent>=0&&percent<=100)node.style.width=percent+'%';}
  applyCapacityGeometry(root);
  for(const fold of root.querySelectorAll('details'))if(folds.includes(fold.id||fold.className))fold.open=true;
  const next=root.querySelector('.v3-detail-scroll');if(next)next.scrollTop=position;
  if(focus)root.querySelector(focus)?.focus({preventScroll:true});
 }
 function header(){
  const root=document.querySelector('#page-title');if(document.body.dataset.room!=='datasets'||section.hidden){document.querySelector('#warehouse-page-actions')?.remove();return;}
  if(root){root.querySelector('.v3-count')?.remove();root.querySelector('.v3-partial')?.remove();if(model){const count=document.createElement('span');count.className='v3-count';count.textContent=model.datasets.length+' 个';root.append(count);}if(overview?.partial===true||model?.partial===true){const marker=document.createElement('span');marker.className='v3-partial v3-flag warn';marker.textContent='部分';root.append(marker);}}
  const host=document.querySelector('.page-heading .heading-actions');if(host&&!host.querySelector('#warehouse-page-actions')){const actions=document.createElement('span');actions.id='warehouse-page-actions';actions.className='v3-head-actions';actions.innerHTML='<a class="button quiet" href="#datasets/transfers">传输记录</a><button class="button primary" type="button" data-v3-upload>＋ 上传数据</button>';host.prepend(actions);}
  const upload=document.querySelector('#warehouse-page-actions [data-v3-upload]');if(upload){upload.disabled=!store.production||!store.principal||!authorizedMachines().length;upload.title=upload.disabled?'暂无服务器使用授权，仅可浏览目录':'';}
 }
 function rail(){
  const root=section.querySelector('#warehouse-server-rail');if(!root)return;
  const rows=model?.machines||(store.data?.machines||[]).map(row=>({machine:row.id})),facts=capacityDisplay();
  html(root,`<button type="button" class="v3-server-chip v3-all" data-v3-filter="" aria-pressed="${!filter}">全部</button>`+rows.map(row=>{
   const cache=facts.caches.find(value=>value.machine===row.machine),ratio=cacheCapacityRatio(cache),pct=ratio===null?null:Math.round(ratio*100);
   return `<button type="button" class="v3-server-chip" data-v3-filter="${esc(row.machine)}" aria-pressed="${filter===row.machine}" title="${esc(row.machine+' · '+cacheCapacityTitle(cache))}"><span class="v3-server-name"><span>${row.machine===machine()?'<i class="v3-here" aria-label="所选服务器"></i>':''}${esc(row.machine)}</span><small class="num">${pct===null?cacheCapacityAmount(cache):pct+'%'+(cache.usageComplete===false?'+':'')}</small></span>${cacheCapacityRailHTML(cache)}</button>`;
  }).join(''));capacityOverview();
 }
 function capacityDisplay(){return displayStorageCapacity(overview,capacityCatalog||model,capacities,store.data?.machines||[]);}
 function capacityOverview(){
  const warehouse=section.querySelector('#warehouse-capacity'),detail=section.querySelector('#warehouse-machine-capacity');
  const facts=capacityDisplay(),target=filter||machine()||facts.caches[0]?.machine;
  if(warehouse)html(warehouse,warehouseCapacityHTML(facts.warehouse,facts.checkedAt));
  if(detail)html(detail,storageCapacityDetailHTML(facts.caches.find(row=>row.machine===target)));
 }
 function visible(){return (model?.datasets||[]).filter(item=>(!filter||item.versions.some(v=>v.servers.some(row=>row.machine===filter&&row.observed&&!['NOT_LOCAL','REGISTERED'].includes(row.state))))&&(!search||(item.displayName+' '+item.dataset).toLowerCase().includes(search)));}
 function rows(){
  const root=section.querySelector('#dataset-catalog');if(!root)return;const items=visible();
  const pending=upload&&!['READY','DISCARDED'].includes(upload.state),progress=meter.value,pct=progress?.percent;
  const flag=upload?.state==='PAUSED'?'已暂停':upload?.state==='UNKNOWN'?'待确认':upload?.state==='FAILED'?'上传失败':upload?.state==='UPLOADING'&&pct!==null&&pct!==undefined?'上传中 '+pct+'%':upload?.state==='PUBLISHING'?'校验中':'上传中';
  const pendingRow=pending?`<button class="v3-row v3-upload-row" type="button" role="option" aria-selected="false" data-v3-upload>${strata('unrecorded')}<span class="v3-name"><b>${esc(uploadDisplay||'上传数据')}</b><span class="v3-id">${esc(upload.dataset||upload.uploadId||'读取文件中')}</span></span><span class="v3-owner">我</span><span class="v3-versions">—</span><span class="v3-size num">${amount(progress?.totalBytes??selectedFiles.reduce((n,file)=>n+file.size,0))}</span><span class="v3-where"><span class="v3-flag fetch">${esc(flag)}</span></span>${upload.state==='UPLOADING'&&pct!==null&&pct!==undefined?`<span class="v3-row-progress" data-v3-percent="${pct}" aria-hidden="true"></span>`:''}</button>`:'';
  html(root,pendingRow+items.map(item=>{const v=chosen(item);if(!v)return '';const caches=v.servers.map(row=>cacheRow(item.dataset,v,row)).filter(row=>(row.observed||cacheWatch.get({machine:row.machine,dataset:item.dataset,version:v.version}))&&['READY','PREPARING','FAILED','UNKNOWN'].includes(row.state));
   const flags=(versionAccess(v).browseOnly?'<span class="v3-flag warn">仅浏览</span>':'')+(v.warehouse.state==='unrecorded'?'<span class="v3-flag warn">未存入仓库</span>':v.warehouse.state==='unknown'?'<span class="v3-flag warn">待确认</span>':v.warehouse.state==='failed'?'<span class="v3-flag bad">存入失败</span>':'');
   return `<button class="v3-row" type="button" role="option" aria-selected="${selected===item.dataset}" data-v3-select="${esc(item.dataset)}">${strata(v.warehouse.state)}<span class="v3-name"><b title="${esc(item.displayName)}">${esc(item.displayName)}</b><span class="v3-id" title="${esc(item.dataset)}">${esc(item.dataset)}</span></span><span class="v3-owner" title="所属 ${esc(datasetOwnerName(v.ownerLabel))}">${esc(datasetOwnerName(v.ownerLabel))}</span><span class="v3-versions num">${item.versions.length}</span><span class="v3-size num">${esc(amount(v.bytes))}</span><span class="v3-where">${caches.map(row=>`<span class="v3-pip" title="${esc(row.machine+' · '+words[row.state])}">${glyph(row.state)}<span class="v3-pip-id">${esc(short(row.machine))}</span></span>`).join('')}${flags}</span></button>`;
  }).join('')||(model?`<div class="v3-empty">${model.partial?'目录待确认':search?'没有匹配的数据集':filter?'这台服务器上还没有缓存':'仓库里还没有数据集'}${!search&&!filter&&!model.partial?'<button type="button" class="button primary" data-v3-upload>＋ 上传数据</button>':''}</div>`:''));
 }
 function inspector(){
  const root=section.querySelector('#warehouse-inspector'),item=model?.datasets.find(row=>row.dataset===selected);if(!root)return;
  if(!item){root.replaceChildren();closeCacheAction();return;}const v=item.versions.find(row=>row.version===selectedVersion)||chosen(item);if(!v){root.replaceChildren();closeCacheAction();return;}selectedVersion=v.version;
  if(actionContext&&actionContext!==JSON.stringify([account(),selected,selectedVersion]))closeCacheAction();
  if(capabilityScope&&capabilityScope!==JSON.stringify([account(),selected,selectedVersion]))retireCacheActions();
  const w=v.warehouse,storeWords={saved:'已存入仓库',pending:({QUEUED:'等待存入仓库',COPYING:'正在存入仓库',PROVISIONING:'校验中',CERTIFYING:'检查恢复能力'}[w.phase]||'仓库状态待确认'),unrecorded:'未存入仓库',unknown:'待确认',failed:'存入失败'};
  const warehouseRows=w.originals?w.originals.map(row=>`<div class="capacity-proof-row" title="${esc(row.state||'未知')}"><span class="capacity-proof ${row.confirmed?'confirmed':''}" role="img" aria-label="${row.confirmed?'已确认':'待确认'}"></span>${row.machine?`<code title="${esc(row.machine)}">${esc(row.machine)}</code>`:''}</div>`).join('')||'<div class="capacity-proof-row"><span class="capacity-proof" role="img" aria-label="待确认"></span><span>未知</span></div>':`<div class="v3-store" title="${esc(storeWords[w.state])}"><span class="capacity-proof ${w.originalConfirmed?'confirmed':''}" role="img" aria-label="${w.originalConfirmed?'已确认':'待确认'}"></span>${w.machine?`<code title="${esc(w.machine)}">${esc(w.machine)}</code>`:'<span>未知</span>'}</div>`;
  const versions=item.versions.length>1?`<select class="v3-version" data-v3-version aria-label="版本">${item.versions.map(row=>`<option value="${esc(row.version)}" title="${esc(row.version)}" ${row===v?'selected':''}>${esc(row.version.slice(0,12))}</option>`).join('')}</select><button type="button" class="v3-copy" data-v3-copy="${esc(v.version)}" aria-label="复制完整版本">复制</button>`:`<button type="button" class="v3-copy" data-v3-copy="${esc(v.version)}" title="${esc(v.version)}" aria-label="复制完整版本">${esc(v.version.slice(0,12))} · 复制</button>`;
  const canTrain=allowsTraining(item.dataset,v.version);
  html(root,`<div class="v3-detail-scroll"><button class="button quiet v3-back" type="button" data-v3-back>‹ 数据集</button><section><h2><span title="${esc(item.displayName)}">${esc(item.displayName)}</span><button type="button" class="v3-edit" data-v3-label="${esc(item.dataset)}" aria-label="修改显示名" ${v.canUse&&authorized(machine())?'':'disabled'}>✎</button></h2><div class="v3-idline"><code title="${esc(item.dataset)}">${esc(item.dataset)}</code><button type="button" class="v3-copy" data-v3-copy="${esc(item.dataset)}">复制</button></div><div class="v3-meta"><span>所属 ${esc(datasetOwnerName(v.ownerLabel))}</span><span class="num">${esc(amount(v.bytes))}</span>${v.files===null?'':`<span class="num">${v.files.toLocaleString('zh-CN')} 个文件</span>`}<span>${item.versions.length} 个版本</span></div></section><section><div class="v3-lab">仓库${versions}</div>${warehouseRows}${w.records.filter(row=>versionAccess(v).canRetry&&row.machine===machine()&&row.storage.version===v.version&&['FAILED','BLOCKED'].includes(row.storage.phase)).map(row=>`<button class="button" type="button" data-retry-archive="${esc(row.storage.dataset)}" data-version="${esc(v.version)}">重试</button>`).join('')}</section><section><div class="v3-lab copy-caption"><span>缓存</span>${v.selected.error?info(v.selected.error,'缓存结果'):""}</div>${v.servers.map(row=>{
   row=cacheRow(item.dataset,v,row);const source=v.warehouse.originalConfirmed||v.servers.some(server=>server.machine!==row.machine&&server.state==='READY'&&server.canUse);
   const mayCache=v.canUse&&!lastControls.busy&&authorized(row.machine)&&!maintenanceFor(store.data?.operationalMaintenance,row.machine)&&!['READY','PREPARING','UNKNOWN'].includes(row.state)&&row.directoryState==='ok'&&(row.canUse&&row.canPrepare||source);
   const cap=cacheCapabilities.get(row.machine),newActions=overview&&!capabilityUnavailable,enabled=v.canUse&&!lastControls.busy&&authorized(row.machine)&&!maintenanceFor(store.data?.operationalMaintenance,row.machine);
   const transferTargets=v.servers.some(target=>target.machine!==row.machine&&authorized(target.machine)&&canCacheAction(cacheCapabilities.get(target.machine)?.raw,'prepare'));
   const cacheAction=newActions?`<span class="v3-server-actions">${enabled&&canCacheAction(cap?.raw,'prepare')&&!['READY','PREPARING'].includes(row.state)?`<button class="button v3-outline v3-small" type="button" data-v3-cache-action="prepare" data-machine="${esc(row.machine)}">缓存</button>`:''}${enabled&&row.state==='READY'&&transferTargets?`<button class="button quiet v3-small" type="button" data-v3-cache-action="transfer" data-machine="${esc(row.machine)}">转移到…</button>`:''}${enabled&&canCacheAction(cap?.raw,'release')?`<button class="button quiet v3-small" type="button" data-v3-cache-action="release" data-machine="${esc(row.machine)}">释放缓存</button>`:''}</span>`:['READY','PREPARING'].includes(row.state)?'':`<button class="button ${row.state==='FAILED'?'quiet':'v3-outline'} v3-small" type="button" data-v3-cache="${esc(row.machine)}" data-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${mayCache?'':'disabled'}>${row.state==='FAILED'?'重试':'缓存'}</button>`;
   const status=(['NOT_LOCAL','REGISTERED','READY','UNKNOWN'].includes(row.state)?'':words[row.state])+(row.progress?' · '+amount(row.progress.bytes)+' / '+amount(row.progress.totalBytes):'');
   return `<article data-cache-context="${esc(machine())}" class="v3-server dataset-card ${row.machine===machine()?'cur':''}">${glyph(row.state)}<span class="v3-server-text"><b title="${esc(row.machine)}">${esc(row.machine)}</b><span title="${esc(status)}" ${cacheWatch.get({machine:row.machine,dataset:item.dataset,version:v.version})?'role="status"':''}>${esc(status)}${row.error?info(row.error,'缓存结果'):''}</span></span>${cacheAction}${newActions&&(cap?.reason||cap?.raw?.reason)?`<p class="v3-cache-reason" title="${esc(cap.reason||cap.raw.reason)}">${esc(cap.reason||cap.raw.reason)}</p>`:''}</article>`;
  }).join('')}</section>${personalDelete(item.dataset,v.version)?'<div class="v3-delete-row"><button class="button quiet v3-delete" type="button" data-v3-delete>删除数据集…</button></div>':''}</div><footer class="v3-train"><button class="button primary" type="button" data-use-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${canTrain?'':'disabled'}>用于训练</button><div class="v3-code"><code title="${esc('--data '+item.dataset+'@'+v.version)}">--data ${esc(item.dataset)}@${esc(v.version)}</code><button type="button" class="v3-copy" data-v3-copy="${esc('--data '+item.dataset+'@'+v.version)}">复制</button></div><div class="v3-code"><span>容器内</span><code>/data2/${esc(item.dataset)}</code><span class="v3-lock">只读</span></div></footer>`);
  section.querySelector('.warehouse-v3').classList.toggle('v3-phone-detail',phoneDetail);requestAnimationFrame(fitInspector);queueMicrotask(readCacheCapabilities);
 }
 function fitInspector(){
  const root=section.querySelector('#warehouse-inspector');if(!root?.isConnected||section.hidden)return;
  const scale=root.getBoundingClientRect().width/root.offsetWidth||1;
  const reserve=parseFloat(getComputedStyle(document.body).getPropertyValue('--bottom-reserve'))||0;
  root.classList.remove('v3-inspector-overflow');root.style.maxHeight='';
  if(matchMedia('(max-width:759px)').matches)return;
  // A sticky panel can move up as the page scrolls. Budget from its CSS
  // sticky offset, not its initial document position or the following footer.
  const top=parseFloat(getComputedStyle(root).top)||0,available=Math.max(240,Math.floor(innerHeight/scale-top-reserve));
  if(root.getBoundingClientRect().height/scale>available){root.classList.add('v3-inspector-overflow');root.style.maxHeight=available+'px';}
 }
 function render(){header();rail();rows();inspector();uploadUI();}
 function catalog(value){legacyCatalog=value;applyCatalog();}
 function applyCatalog(){
  if(!legacyCatalog&&!overview)return;
  const principal={...store.principal,username:store.principal?.username||store.users?.find(row=>row.id===store.principal?.userId)?.username};
  const rawLegacy=legacyCatalog?aggregateDatasetCatalog(legacyCatalog):null,legacy=rawLegacy?readableDatasetCatalog(rawLegacy,principal):null;
  model=overview&&(overview.datasets.length||!legacy?.datasets.length)?readableDatasetCatalog(overviewDatasetCatalog(overview,machine(),legacyCatalog),principal):legacy;
  capacityCatalog=legacy?{...legacy,datasets:legacy.datasets.flatMap(item=>{
   const visible=model.datasets.find(row=>row.dataset===item.dataset),versions=item.versions.filter(v=>visible?.versions.some(row=>row.version===v.version));
   return versions.length?[{...item,versions}]:[];
  })}:model;
  if(rawLegacy)capacityCatalog.capacityUsageComplete=capacityCatalog.datasets.reduce((n,item)=>n+item.versions.length,0)===rawLegacy.datasets.reduce((n,item)=>n+item.versions.length,0);
  cacheWatch.catalog(model.datasets.flatMap(item=>item.versions.flatMap(v=>v.servers.map(row=>({machine:row.machine,dataset:item.dataset,version:v.version,physicalDataset:row.dataset,state:row.state,canUse:v.canUse,totalBytes:v.bytes})))));
  if(!model.datasets.some(item=>item.dataset===selected)){selected=model.datasets[0]?.dataset||null;selectedVersion=null;}render();
 }
 function storageOverview(value){overview=adaptStorageOverview(value);retireCacheActions(false);capacityOverview();if(overview||legacyCatalog)applyCatalog();}
 async function loadOverview(){
  if(!store.production||!store.principal||section.hidden||document.body.dataset.room!=='datasets')return;
  const expected=account(),token=epoch,request=++overviewRequest;overviewAbort?.abort();const controller=new AbortController();overviewAbort=controller;
  try{const value=await store.call('datasets.overview',{},{signal:controller.signal});if(current(expected,token)&&request===overviewRequest&&!section.hidden&&document.body.dataset.room==='datasets')storageOverview(value);}
  catch{if(current(expected,token)&&request===overviewRequest){overview=null;capacityOverview();if(legacyCatalog)applyCatalog();}}
 }
 function catalogUnavailable(){retireCacheActions();overviewRequest++;overviewAbort?.abort();overview=null;legacyCatalog=null;capacityCatalog=null;model=null;selected=null;selectedVersion=null;capacityOverview();rows();inspector();}
 function capacity(value,id){capacities.set(id,value);rail();uploadCapacity();}
 async function capacitiesForOthers(){const expected=account(),token=epoch;for(const row of authorizedMachines()){if(row.id===machine()||capacities.has(row.id))continue;store.call('datasets.capacity',{machine:row.id}).then(value=>{if(current(expected,token))capacity(value,row.id);}).catch(()=>{if(current(expected,token)){capacities.set(row.id,null);rail();}});}}
 function uploadCapacity(){const node=section.querySelector('#v3-upload-capacity'),value=capacities.get(machine());if(node)node.textContent=route?.storageTier==='hdd'?'仓库':value?.available===true&&Number.isSafeInteger(value.usableBytes)&&value.usableBytes>=0?'可用 '+amount(value.usableBytes):'';}
 function uploadRoute(){const node=section.querySelector('#v3-upload-route');if(!node)return;const kind=route?.kind;
  node.className='v3-route '+(kind==='campus-direct'?'ok':kind==='tail-upload'?'alt':kind==='unreachable'?'cut':'');
  const caption=kind==='campus-direct'?'校园网直连':kind==='tail-upload'?'备用线路':['relay-choice','vps-relay'].includes(kind)?'平台中转':kind==='unreachable'?'没连上校园网':kind==='unconfirmed'?'路线待确认':'探测中';
  const destination=route?.machine||machine();
  node.setAttribute('aria-label','你的电脑 · '+caption+' · '+(destination||'未选择服务器'));
  node.innerHTML=`<span class="v3-route-end"><i></i>你的电脑</span><span class="v3-route-seg"></span><span class="v3-route-via">${caption}</span><span class="v3-route-seg"></span><span class="v3-route-end"><i></i><span title="${esc(destination)}">${esc(destination||'未选择服务器')}</span></span>`;
 }
 async function probe(){
  if(uploadBusy)return;
  const expected=account(),token=++routeEpoch,target=machine();if(!store.principal||!authorized(target))return;routeAbort?.abort();routeAbort=new AbortController();const signal=routeAbort.signal;route=null;uploadRoute();let probeable=false;
  try{const value=await store.call('datasets.upload.routes',{machine:target});if(token!==routeEpoch||expected!==account()||target!==machine()||signal.aborted)return;
   const storageMachine=uploadStorageMachine(value,target);validateUploadRoutes(value,storageMachine);probeable=true;
   const selected=await selectUploadRoute(value,storageMachine,candidate=>probeBrowserUploadRoute(candidate,{signal}),{signal});
   if(token!==routeEpoch||expected!==account()||target!==machine()||signal.aborted)return;route={...selected,...(value.placementProtocol===1?{requestedMachine:target,storageTier:value.storageTier}:{})};
  }catch(error){if(token!==routeEpoch||expected!==account()||signal.aborted)return;route={kind:!probeable?'unconfirmed':selectedFiles.length&&selectedFiles.reduce((n,file)=>n+file.size,0)<=256*1024**2?'relay-choice':'unreachable',error,probesExhausted:probeable};}
  uploadRoute();uploadCapacity();uploadUI();uploadControls(lastControls);
 }
 function uploadControls(value=lastControls){
  const catalogBusyChanged=!!lastControls.busy!==!!value.busy;
  lastControls=value;
  if(catalogBusyChanged&&model)inspector();
  const enabled=store.production&&store.principal&&authorized(machine());
  const blocked=!enabled||value.busy||value.uploadBusy||value.workspaceBusy||value.discardBusy||value.queryBusy||uploadBusy;
  const maintenance=maintenanceFor(store.data?.operationalMaintenance,machine());
  const live=upload&& !['READY','DISCARDED'].includes(upload.state);
  const start=section.querySelector('#dataset-upload-start');
  if(start){start.hidden=!!upload&&['READY','HASHING','RECEIVING_MANIFEST','SEALING','UPLOADING','PUBLISHING','UNKNOWN'].includes(upload.state);start.disabled=blocked||!!maintenance||!selectedFiles.length||section.querySelector('[name=dataset-via]')?.value!=='relay'&&!['campus-direct','tail-upload'].includes(route?.kind);}
  for(const node of section.querySelectorAll('#v3-upload-display,[data-v3-reselect],[data-v3-folder],[data-v3-files],[data-v3-source]'))node.disabled=blocked||!!live;
  for(const node of section.querySelectorAll('[data-v3-probe],[data-v3-explicit-relay],[data-v3-resume]'))node.disabled=blocked||!!maintenance||node.hasAttribute('data-v3-resume')&&!['campus-direct','tail-upload'].includes(route?.kind);
  const again=section.querySelector('[data-v3-again]');if(again)again.disabled=blocked;
 }
 function uploadUI(){
  const dialog=section.querySelector('#dataset-add-dialog'),root=section.querySelector('#v3-upload-state');if(!root)return;
  const state=upload?.state,progress=meter.value;
  const running=uploadBusy||['SEALING','PUBLISHING','DISCARDING'].includes(state);
  const complete=state==='READY',error=!running&&(state&& !complete&&state!=='DISCARDED'||['unreachable','unconfirmed','relay-choice'].includes(route?.kind));
  const mode=complete?'complete':running?'running':error?'error':'selection';
  dialog.dataset.v3UploadState=mode;dialog.classList.toggle('v3-picked',selectedFiles.length>0||!!upload);dialog.classList.toggle('v3-upload-locked',uploadLocked);
  const form=section.querySelector('#dataset-upload-form');form?.classList.toggle('v3-active',mode!=='selection');
  const label=uploadDisplay||section.querySelector('#v3-upload-display')?.value||'上传数据';
  const phases={HASHING:'读取文件',RECEIVING_MANIFEST:'发送清单',SEALING:'校验清单',PUBLISHING:'完整校验中',UPLOADING:'上传未完成',DISCARDING:'正在取消',PAUSED:'已暂停',UNKNOWN:'结果待确认',FAILED:'上传失败'};
  const errorReason=upload?.error||route?.error?.message;
  let content='';
  if(running){
   const pct=state==='UPLOADING'?progress?.percent:null;
   content=`<div class="v3-pct num">${pct===null||pct===undefined?esc(phases[state]||'上传中'):pct+'%'}</div><div class="v3-progress" role="progressbar" aria-label="已确认的文件字节" ${pct===null||pct===undefined?'':'aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'"'}><i data-v3-percent="${pct??0}"></i></div><div class="v3-stats num"><span>${progress?amount(progress.bytes)+' / '+amount(progress.totalBytes):'—'}</span><span>${progress?.speed?amount(Math.round(progress.speed))+'/s':'—'}</span><span>${progress?.seconds===null||progress?.seconds===undefined?'—':'约 '+(progress.seconds<60?progress.seconds+' 秒':Math.ceil(progress.seconds/60)+' 分钟')}</span></div>`;
  }else if(complete){
   const version=model?.datasets.find(row=>row.dataset===upload.dataset)?.versions.find(row=>row.version===upload.version);
   const warehouse=version?.warehouse;
   const words={saved:'已存入仓库',pending:'正在存入仓库',failed:'存入失败',unrecorded:'未存入仓库',unknown:'仓库状态待确认'};
   content=`<div class="v3-done"><span class="v3-tick" aria-hidden="true">✓</span><b>${esc(label)}</b><span class="v3-store">${strata(warehouse?.state||'unknown')}${words[warehouse?.state]||'仓库状态待确认'}</span>${upload.labelError?`<div class="copy-caption"><span>显示名待确认</span>${info(upload.labelError,'显示名')}<button class="button quiet" type="button" data-v3-label="${esc(upload.dataset)}">修改</button></div>`:''}</div><div class="v3-server cur">${glyph('READY')}<span class="v3-server-text"><b title="${esc(upload.machine)}">${esc(upload.machine)}</b><span>已缓存</span></span></div><div class="file-actions v3-complete-actions"><button class="button quiet" type="button" data-v3-again>再传一个</button><button class="button primary" type="button" data-use-dataset="${esc(upload.dataset)}" data-version="${esc(upload.version)}" ${allowsTraining(upload.dataset,upload.version)?'':'disabled'}>用于训练</button></div>`;
  }else if(error){
   content=`<div class="v3-error"><h3>${route?.kind==='unreachable'?'没连上校园网':phases[state]||'路线待确认'}</h3>${errorReason?`<div class="copy-caption"><span>${upload?'传输未完成':'路线未确认'}</span>${info(errorReason,'上传结果')}</div>`:''}<div class="v3-upload-choices"><button class="button v3-outline" type="button" data-v3-probe><span><b>连上校园网或 VPN 后重试</b><small>已传部分保留</small></span></button></div><div class="file-actions"><button class="button primary" type="button" data-v3-probe>重新探测</button>${upload?.uploadId?'<button class="button primary" type="button" data-v3-resume>继续上传</button>':''}${route?.kind==='relay-choice'?'<button class="button" type="button" data-v3-explicit-relay>同意平台中转</button>':''}</div></div>`;
  }
  html(root,content);root.hidden=!content;
  const relay=section.querySelector('#v3-relay-options');if(relay)relay.hidden=mode!=='error'||route?.kind==='relay-choice';
  if(complete){section.querySelector('#v3-upload-route').hidden=true;}else section.querySelector('#v3-upload-route').hidden=false;
  const close=dialog.querySelector('[data-dataset-add-close]');close.textContent=uploadBusy?'收起':'关闭';
  uploadControls();
 }
 async function prepareUpload(){
  const display=normalizeDatasetDisplayName(section.querySelector('#v3-upload-display').value);
  uploadDisplay=display;
  if(!uploadName){
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(display));
   uploadName='data-'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,24);
  }
  section.querySelector('[name=dataset-name]').value=uploadName||'data';
  const via=section.querySelector('[name=dataset-via]');
  if(via.value!=='relay'){
   if(!['campus-direct','tail-upload'].includes(route?.kind))throw Error('请先重新探测上传路线。');
   via.value='direct';
  }
 }
 function uploading(value){uploadBusy=value;if(value){meter.reset();upload={...upload,machine:machine(),state:'HASHING'};uploadLocked=true;routeEpoch++;routeAbort?.abort();}uploadUI();rows();}
 function uploadProgress(value){if(value.state==='DISCARDED')uploadLocked=false;if(value.uploadId||upload)upload={...upload,...value,machine:machine()};meter.report(value);uploadUI();rows();}
 function actualRoute(value){route=value;uploadRoute();uploadUI();}
 function uploadFailure(error,{paused=false}={}){upload={...upload,state:paused?'PAUSED':'UNKNOWN',error:error.message,machine:machine()};if(error.code?.startsWith('DIRECT'))route={kind:'unreachable'};uploadUI();uploadRoute();rows();}
 async function completed(value){
  const expected=account(),token=epoch;upload={...value,machine:machine()};uploadBusy=false;uploadUI();rows();
  if(!uploadDisplay)return;
  try{
   const snapshot=await labels.get({machine:upload.machine,dataset:value.dataset});if(!current(expected,token))return;
   const result=await labels.set(snapshot,uploadDisplay);if(!current(expected,token))return;
   if(result.status!=='SAVED')upload.labelError='名称已被修改，请确认最新名称后再保存。';
  }catch(error){if(current(expected,token))upload.labelError=error.message;}
  if(current(expected,token))uploadUI();
 }
 function selection(){
  selectedFiles=Array.from(section.querySelector('[name=dataset-directory]')?.files||[]);if(!selectedFiles.length)return;
  const path=selectedFiles[0].webkitRelativePath||selectedFiles[0].name,folder=path.includes('/')?path.split('/')[0]:selectedFiles.length===1?selectedFiles[0].name:'所选文件';
  uploadName='';upload=null;uploadDisplay='';uploadLocked=false;meter.reset();
  section.querySelector('#dataset-add-dialog').classList.remove('v3-other');
  section.querySelector('[name=dataset-name]').value='data';
  const display=section.querySelector('#v3-upload-display');if(display&&!display.value)display.value=folder;
  const file=section.querySelector('#v3-upload-file');if(file)file.innerHTML=`<span class="v3-folder" aria-hidden="true"></span><div><b title="${esc(folder)}">${esc(folder)}</b><span class="num">${selectedFiles.length.toLocaleString('zh-CN')} 个文件 · ${amount(selectedFiles.reduce((n,f)=>n+f.size,0))}</span></div><button type="button" class="button quiet" data-v3-reselect>更换</button>`;
  if(route?.probesExhausted)route.kind=selectedFiles.reduce((n,file)=>n+file.size,0)<=256*1024**2?'relay-choice':'unreachable';
  section.querySelector('#dataset-add-dialog').classList.add('v3-picked');section.querySelector('#dataset-panel-directory').hidden=false;uploadCapacity();uploadRoute();
  uploadUI();uploadControls();
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
  const body=document.createElement('div');body.className='v3-upload-opening';body.innerHTML='<div class="v3-drop" id="v3-drop"><div><span class="v3-tray" aria-hidden="true"><i></i></span><h3>拖入文件夹或文件</h3><div class="file-actions"><button class="button primary" type="button" data-v3-folder>选择文件夹</button><button class="button" type="button" data-v3-files>选择文件</button></div></div></div><div class="v3-other-sources"><button class="button v3-outline" type="button" data-v3-source="link">从链接下载</button><button class="button v3-outline" type="button" data-v3-source="aliyun">阿里云盘导入</button><button class="button v3-outline" type="button" data-v3-source="workspace">在服务器上整理</button></div><input id="v3-file-picker" type="file" multiple hidden>';
  dialog.querySelector('.dataset-sheet-context').before(body);
  // Public rooms keep the same entries for every role. Experimental cloud
  // components remain in code and cloud administration stays in #admin.
  body.querySelector('[data-v3-source="aliyun"]').hidden=true;
  const cloudOption=section.querySelector('[name=cloud-source] option[value="aliyun"]');if(cloudOption){cloudOption.hidden=true;cloudOption.disabled=true;}
  const cloudCopies=section.querySelector('#cloud-files');if(cloudCopies)cloudCopies.hidden=true;
  const touch=matchMedia('(pointer:coarse),(max-width:759px)').matches;
  if(touch)body.querySelector('h3').textContent='选择文件';
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1;
  body.querySelector('[data-v3-folder]').hidden=ios||!('webkitdirectory' in document.createElement('input'));
  const summary=document.createElement('div');summary.id='v3-upload-file';summary.className='v3-file';dialog.querySelector('#dataset-upload-form').prepend(summary);
  const field=document.createElement('div');field.className='field v3-display-field';field.innerHTML='<label for="v3-upload-display">名称</label><input id="v3-upload-display" maxlength="160" autocomplete="off"><span class="v3-raw-id">ID 上传完成后返回</span>';summary.after(field);
  const routeNode=document.createElement('div');routeNode.id='v3-upload-route';routeNode.className='v3-route';const context=dialog.querySelector('.dataset-sheet-context');field.after(context);context.after(routeNode);
  const state=document.createElement('div');state.id='v3-upload-state';state.setAttribute('aria-live','polite');routeNode.before(state);
  const relay=document.createElement('details');relay.id='v3-relay-options';relay.innerHTML='<summary>其他线路</summary><button class="button" type="button" data-v3-explicit-relay>同意平台中转</button>';routeNode.after(relay);relay.querySelector('summary').after(dialog.querySelector('#dataset-relay-warning'));
  const collapse=document.createElement('button');collapse.type='button';collapse.className='button';collapse.dataset.v3Collapse='';collapse.textContent='收起，后台继续';dialog.querySelector('.dataset-upload-actions').append(collapse);
  dialog.querySelector('#dataset-upload-pause').textContent='暂停';
  const caption=section.querySelector('[name=dataset-machine]').closest('label');caption.querySelector('span').textContent='上传到';const available=document.createElement('span');available.id='v3-upload-capacity';caption.prepend(available);
  dialog.addEventListener('close',()=>{if(!uploadBusy){routeEpoch++;routeAbort?.abort();}});
  installedObserver=new MutationObserver(()=>{if(dialog.open){dialog.querySelector('[data-dataset-source=directory]').click();dialog.classList.toggle('v3-picked',selectedFiles.length>0||!!upload);uploadUI();if(!uploadLocked)probe();}});installedObserver.observe(dialog,{attributes:true,attributeFilter:['open']});
  const drop=dialog.querySelector('#v3-drop');drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));
  drop.addEventListener('drop',async event=>{event.preventDefault();drop.classList.remove('dragging');const files=[];const expected=account(),token=epoch;
   async function walk(entry,path=''){if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));const selected=new File([file],file.name,{type:file.type,lastModified:file.lastModified});Object.defineProperty(selected,'webkitRelativePath',{value:path+file.name});files.push(selected);}else if(entry.isDirectory){const reader=entry.createReader();while(true){const entries=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!entries.length)break;for(const next of entries)await walk(next,path+entry.name+'/');}}}
   try{const entries=[...event.dataTransfer.items].map(item=>item.webkitGetAsEntry?.()).filter(Boolean);if(entries.length)for(const entry of entries)await walk(entry,entries.length>1?'selected/':'');else files.push(...event.dataTransfer.files);if(!current(expected,token))return;assignFiles(files);}catch(error){if(current(expected,token))toast(error.message);}
  });
  uploadCapacity();uploadRoute();uploadUI();
 }
 function assignFiles(files){if(uploadBusy||upload&& !['READY','DISCARDED'].includes(upload.state))return;const transfer=new DataTransfer();files.forEach(file=>transfer.items.add(file));const input=section.querySelector('[name=dataset-directory]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
 section.addEventListener('change',event=>{if(event.target.name==='dataset-directory')selection();if(event.target.id==='v3-file-picker')assignFiles([...event.target.files]);if(event.target.hasAttribute('data-v3-version')){selectedVersion=event.target.value;inspector();}if(event.target.name==='dataset-machine'){epoch++;cacheWatch.reset();upload=null;uploadBusy=false;uploadLocked=false;phoneDetail=false;meter.reset();labels.reset();model=null;selected=null;selectedVersion=null;section.querySelector('.v3-label-dialog')?.close();routeEpoch++;if(section.querySelector('#dataset-add-dialog')?.open)probe();render();}});
 section.addEventListener('input',event=>{if(event.target.id==='warehouse-search'){search=event.target.value.trim().toLowerCase();rows();}});
 section.addEventListener('keydown',event=>{
  const row=event.target.closest('[data-v3-select]');if(!row||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  const items=[...section.querySelectorAll('[data-v3-select]')],index=items.indexOf(row);
  const next=event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowDown'?1:-1)));
  if(!items[next])return;event.preventDefault();selected=items[next].dataset.v3Select;selectedVersion=null;rows();inspector();
  const target=section.querySelector('[data-v3-select="'+CSS.escape(selected)+'"]');target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',inline:'nearest'});
 });
 document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.hasAttribute('data-v3-upload')){if(store.production&&store.principal&&authorized(machine()))section.querySelector('#datasets-add').open=true;return;}
  if(!section.contains(button))return;
  if(button.hasAttribute('data-v3-cache-close')){closeCacheAction();return;}
  if(button.hasAttribute('data-v3-cache-action')){openCacheAction(button.dataset.v3CacheAction,button.dataset.machine);return;}
  if(button.hasAttribute('data-v3-probe')){await probe();return;}
  if(button.hasAttribute('data-v3-resume')){section.querySelector('[name=dataset-via]').value='direct';section.querySelector('#dataset-upload-form').requestSubmit();return;}
  if(button.hasAttribute('data-v3-explicit-relay')){const via=section.querySelector('[name=dataset-via]');via.value='relay';via.dispatchEvent(new Event('change',{bubbles:true}));section.querySelector('#dataset-upload-form').requestSubmit();return;}
  if(button.hasAttribute('data-v3-collapse')){section.querySelector('#dataset-add-dialog').close();return;}
  if(button.hasAttribute('data-v3-again')){upload=null;uploadName='';uploadDisplay='';uploadLocked=false;selectedFiles=[];meter.reset();section.querySelector('[name=dataset-directory]').value='';section.querySelector('#v3-file-picker').value='';section.querySelector('#v3-upload-display').value='';section.querySelector('#v3-upload-file').replaceChildren();section.querySelector('[name=dataset-via]').value='automatic';section.querySelector('[name=dataset-directory]').dispatchEvent(new Event('change',{bubbles:true}));section.querySelector('#dataset-add-dialog').classList.remove('v3-picked');uploadUI();rows();probe();return;}
  if(button.hasAttribute('data-v3-select')){selected=button.dataset.v3Select;selectedVersion=null;phoneDetail=matchMedia('(max-width:759px)').matches;rows();inspector();if(phoneDetail)section.scrollIntoView({block:'start'});return;}
  if(button.hasAttribute('data-v3-filter')){filter=button.dataset.v3Filter||null;rail();rows();return;}
  if(button.hasAttribute('data-v3-delete')){if(personalDelete(selected,selectedVersion))removeUI.openFullDelete(selected,selectedVersion);return;}
  if(button.hasAttribute('data-v3-back')){phoneDetail=false;section.querySelector('.warehouse-v3').classList.remove('v3-phone-detail');return;}
  if(button.hasAttribute('data-v3-label')){await editLabel(button.dataset.v3Label);return;}
  if(button.hasAttribute('data-v3-copy')){try{await navigator.clipboard.writeText(button.dataset.v3Copy);toast('已复制');}catch{toast('请手动选择后复制。');}return;}
  if(button.hasAttribute('data-v3-folder')||button.hasAttribute('data-v3-reselect')){section.querySelector('[name=dataset-directory]').click();return;}
  if(button.hasAttribute('data-v3-files')){section.querySelector('#v3-file-picker').click();return;}
  if(button.hasAttribute('data-v3-source')){const source=button.dataset.v3Source;section.querySelector('#dataset-add-dialog').classList.add('v3-other');section.querySelector('[data-dataset-source="'+(source==='aliyun'?'link':source)+'"]').click();if(source==='aliyun'){const select=section.querySelector('[name=cloud-source]');select.value='aliyun';select.dispatchEvent(new Event('change',{bubbles:true}));}return;}
  if(button.hasAttribute('data-v3-cache')){
   if(overview&&!capabilityUnavailable)return;
   const visibleVersion=model?.datasets.find(row=>row.dataset===button.dataset.dataset)?.versions.find(row=>row.version===button.dataset.version);
   if(!visibleVersion||visibleVersion.canUse!==true)return;
   const expected=account(),token=epoch,target=button.dataset.v3Cache,ref={machine:target,dataset:button.dataset.dataset,version:button.dataset.version};let watch;
   button.disabled=true;
   try{
    const value=await store.call('datasets.catalog',{machine:target});if(!current(expected,token)||!button.isConnected)return;
    const v=value.datasets?.find(row=>row.dataset===ref.dataset)?.versions?.find(row=>row.version===ref.version);
    if(!v||!access(v,value,{machineAuthorized:authorized(target)}).prepare)throw Error('缓存条件待确认，请刷新。');
    watch=cacheWatch.begin({...ref,totalBytes:v.bytes,physicalDataset:v.locations?.find(row=>row.machine===target)?.dataset},{dispatching:true});if(!watch)return;
    const result=await store.call('datasets.prepare',ref);if(current(expected,token))cacheWatch.settled(watch,result);
   }catch(error){if(current(expected,token)){if(watch)cacheWatch.settled(watch,null,error);toast(error.message);}}
   finally{if(button.isConnected)button.disabled=!!maintenanceFor(store.data?.operationalMaintenance,target);}
   return;
  }
 });
 new MutationObserver(()=>{header();cacheWatch.sync();if(document.body.dataset.room!=='datasets'){retireCacheActions();overviewRequest++;overviewAbort?.abort();section.querySelector('#dataset-add-dialog')?.close();}}).observe(document.body,{attributes:true,attributeFilter:['data-room']});
 document.addEventListener('visibilitychange',()=>cacheWatch.sync());
 new MutationObserver(()=>requestAnimationFrame(fitInspector)).observe(document.body,{attributes:true,attributeFilter:['style']});
 document.fonts?.ready.then(()=>requestAnimationFrame(fitInspector));
 store.onAuthChange?.(reset);
 globalThis.addEventListener('resize',()=>requestAnimationFrame(fitInspector));
 globalThis.addEventListener('scroll',()=>requestAnimationFrame(fitInspector),{passive:true});
 return {install,catalog,catalogUnavailable,capacity,storageOverview,loadOverview,render,reset,capacitiesForOthers,prepareUpload,uploading,uploadProgress,actualRoute,uploadFailure,completed,uploadControls,allowsTraining};
}
