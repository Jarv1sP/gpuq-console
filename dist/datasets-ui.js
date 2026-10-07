import {warehouseWorkspaceHTML,datasetWarehouseView} from './dataset-warehouse-view.js';
import {maintenanceFor,restoreMaintenanceControls,disableMaintenanceControls} from './maintenance-state.js';
import {scanBrowserDirectory,uploadBrowserDataset,confirmedDatasetUpload} from './dataset-upload.js';
import {dataWorkspaceHTML,dataWorkspaceUI} from './data-workspace.js';
import {transferUploadCall} from './transfer-upload.js';
import {cloudImportHTML,cloudImportUI} from './cloud-import-ui.js';
import {datasetRemoveUI} from './dataset-remove-ui.js';
import {serverIdHTML,serverSelectLabel} from './workbench-ui.js';
import {reducedMotion} from './motion-ui.js';
import {LARGE_RELAY_BYTES,transferBytes,uploadPhase} from './data-route.js';
import {cacheFact,cacheProgress,cacheIconHTML,databaseGroundHTML,databaseSummary,datasetFlowRoute,datasetFlowDetailHTML,uploadJourneyHTML,datasetInfoHTML as infoHTML,discloseDatasetInfo as discloseInfo} from './dataset-flow.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={READY:'已缓存',REGISTERED:'未缓存',STAGING:'未完成，可续传',PREPARING:'取回中',FAILED:'取回失败',NOT_LOCAL:'所选服务器未缓存',UNKNOWN:'缓存状态待确认'};
const bytesLabel=value=>Number.isFinite(value)&&value>=0?transferBytes(value):'未知';
export function archiveStatus(storage,expectedVersion=null,canRetry=true){
  if(!storage)return '';
  const matching=!expectedVersion||storage.version===expectedVersion;
  const saved=matching&&storage.phase==='ARCHIVED'&&storage.originalRetained===true&&typeof storage.archiveMachine==='string'&&storage.archiveMachine.length>0;
  const text=saved?`原件已保存 · ${storage.archiveMachine}`:matching?({QUEUED:'等待存入',COPYING:'存入中',PROVISIONING:'校验中',CERTIFYING:'检查恢复能力',FAILED:'存入仓库失败',BLOCKED:'待确认'}[storage.phase]||'待确认'):'待确认';
  return `<div class="dataset-storage" role="status"><span>${esc(text)}</span>${infoHTML(saved?'原件不会被释放。空闲缓存释放后，用时从仓库取回。':'存入仓库尚未确认，服务器缓存继续保留。只有确认可取回且没有训练在用的缓存才会释放。','仓库说明')}</div>${storage.error?`<p class="form-error">${esc(storage.error)}</p>`:''}${canRetry&&matching&&['FAILED','BLOCKED'].includes(storage.phase)?`<button class="button" data-retry-archive="${esc(storage.dataset)}" data-version="${esc(storage.version)}">重试存入仓库</button>`:''}`;
}
export function capacityText(capacity){
  if(!capacity||capacity.available!==true||!Number.isFinite(capacity.availableBytes)||capacity.availableBytes<0||!Number.isFinite(capacity.filesystemBytes)||capacity.filesystemBytes<0)return '容量待更新';
  return `可用 ${bytesLabel(capacity.availableBytes)} / 共 ${bytesLabel(capacity.filesystemBytes)}${Number.isFinite(capacity.usableBytes)&&capacity.usableBytes>=0?` · 可上传 ${bytesLabel(capacity.usableBytes)}`:''}${Number.isFinite(capacity.reserveBytes)&&capacity.reserveBytes>=0?` · 安全预留 ${bytesLabel(capacity.reserveBytes)}`:''}`;
}
const capacityNumber=value=>Number.isFinite(value)&&value>=0?(value>=1024**3?Number((value/1024**3).toFixed(2))+' GiB':bytesLabel(value)):'—';
export function catalogUpdatedText(catalog){
  const value=catalog?.checkedAt,date=value===undefined||value===null||value===''?null:new Date(typeof value==='number'?value*1000:value);
  return (date&&Number.isFinite(date.getTime())?'更新于 '+date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'更新时间未知')+(catalog?.partial?' · 部分目录待更新':'');
}
export function datasetCapacityHTML(capacity,machine){
  const known=capacity?.available===true&&Number.isFinite(capacity.availableBytes)&&capacity.availableBytes>=0&&Number.isFinite(capacity.filesystemBytes)&&capacity.filesystemBytes>=0;
  const usable=known&&Number.isFinite(capacity.usableBytes)&&capacity.usableBytes>=0?capacity.usableBytes:null;
  return `<div class="dataset-book"><div><span>可上传</span>${infoHTML(`来源：${machine||'所选服务器'} 共享数据盘，容量不是个人配额。${known?`可用 ${capacityNumber(capacity.availableBytes)}，${Number.isFinite(capacity.reserveBytes)&&capacity.reserveBytes>=0?'安全预留 '+capacityNumber(capacity.reserveBytes)+'；':''}可上传 ${capacityNumber(usable)}。`:'容量未确认，请刷新后再上传。'}`,'容量来源')}</div><strong class="mono">${capacityNumber(usable)}</strong><small>${known?'共 '+esc(capacityNumber(capacity.filesystemBytes)):capacityText(null)}</small></div>`;
}
const locationNames={READY:'已就绪',REGISTERED:'未缓存',STAGING:'未完成',PREPARING:'取回中',FAILED:'取回失败',NOT_LOCAL:'没有此版本',UNKNOWN:'目录未确认'};
export function datasetMachines(catalog){
  const result=new Map();
  for(const item of catalog?.machines||[])if(typeof item.machine==='string')result.set(item.machine,item);
  for(const dataset of catalog?.datasets||[])for(const version of dataset.versions||[])for(const location of version.locations||[])
    if(typeof location.machine==='string'&&!result.has(location.machine))result.set(location.machine,{machine:location.machine,state:'unavailable'});
  if(typeof catalog?.machine==='string'&&!result.has(catalog.machine))result.set(catalog.machine,{machine:catalog.machine,state:'unavailable'});
  return [...result.values()];
}
export function datasetLocation(version,machine,catalog){
  const local=(version.locations||[]).find(location=>location.machine===machine.machine);
  // An omitted cell is absence only after that node's catalog was confirmed.
  // The selected version state is already the server's local readiness view.
  const state=local?.state||(machine.machine===catalog.machine?version.state:null)||(machine.state==='ok'?'NOT_LOCAL':'UNKNOWN');
  return {state:Object.hasOwn(locationNames,state)?state:'UNKNOWN',label:locationNames[state]||locationNames.UNKNOWN};
}
export function datasetAccess(version,catalog,{machineAuthorized=true}={}){
  const local=version.locations?.find(row=>row.machine===catalog.machine&&row.canUse===true),state=version.state||'UNKNOWN';
  const target=typeof catalog.machine==='string'&&!!catalog.machine&&machineAuthorized;
  const localAllowed=target&&local?.canUse===true&&version.canUse===true;
  const ready=localAllowed&&state==='READY'&&local.state==='READY';
  const remote=typeof version.sourceMachine==='string'&&version.sourceMachine!==catalog.machine&&version.locations?.some(row=>row.machine===version.sourceMachine&&row.state==='READY'&&row.canUse===true);
  const canPrepare=target&&version.canUse===true&&version.canPrepare===true&&(localAllowed||remote===true);
  const prepare=canPrepare&&['REGISTERED','STAGING','FAILED','NOT_LOCAL'].includes(state);
  const selectable=ready||localAllowed&&state==='PREPARING'||canPrepare&&(['REGISTERED','STAGING','PREPARING'].includes(state)||state==='NOT_LOCAL'&&remote);
  const browseOnly=version.canUse!==true||!target||!localAllowed&&!canPrepare&&version.locations?.some(row=>row.machine===catalog.machine&&row.canUse!==true);
  return {state,ready,prepare,selectable,browseOnly,canPrepare,canRetry:localAllowed};
}
export function datasetAuthorizedMachines(store){
  const user=store.users?.find(row=>row.id===store.principal?.userId);
  return user?.enabled===true?(store.data?.machines||[]).filter(row=>user.limits?.[row.id]>0):[];
}
export function datasetCopyRoute(version,catalog){
  const source=version.sourceMachine,target=catalog.machine;
  if(version.state!=='NOT_LOCAL'||version.canUse!==true||version.canPrepare!==true||typeof source!=='string'||!source||source===target)return null;
  const machines=datasetMachines(catalog);
  if(!machines.some(row=>row.machine===source)||!machines.some(row=>row.machine===target&&row.state==='ok'))return null;
  if(!(version.locations||[]).some(row=>row.machine===source&&row.state==='READY'&&row.canUse===true))return null;
  return {source,target,bytes:Number.isFinite(version.bytes)&&version.bytes>=0?version.bytes:null};
}
export function datasetRows(catalog,options={}){
  const machines=datasetMachines(catalog),selected=machines.findIndex(row=>row.machine===catalog.machine);
  const rows=(catalog?.datasets||[]).flatMap(item=>(item.versions||[]).map(v=>{
    const access=datasetAccess(v,catalog,options),{state,selectable}=access,locations=Array.isArray(v.locations)?v.locations:[],route=access.canPrepare?datasetCopyRoute(v,catalog):null;
    const ownerLabel=typeof v.ownerLabel==='string'?v.ownerLabel:'所属用户：未知';
    const differentOwners=locations.some(location=>location.ownerLabel!==v.ownerLabel);
    const where=locations.length?`<p class="dataset-locations${differentOwners?'':' dataset-location-summary'}">副本位置：${locations.map(location=>`${esc(location.machine)} · ${esc(location.state==='READY'?'已就绪':labels[location.state]||'待确认')}${differentOwners?` · ${esc(location.ownerLabel||'所属用户：未知')}`:''}`).join('；')}</p>`:'';
    const storage=archiveStatus(locations.find(location=>location.machine===catalog.machine)?.storage,v.version,access.canRetry);
    const help=access.browseOnly?'仅浏览 · 未获使用授权':v.canPrepare===false&&!['READY','PREPARING'].includes(state)?(state==='NOT_LOCAL'?'没有可用复制来源':state==='UNKNOWN'?'缓存状态待更新':String(item.dataset).startsWith('w-')?'在服务器上整理后重新发布':'重新选择同一目录继续上传') : '';
    const cells=machines.map(machine=>{
      const location=datasetLocation(v,machine,catalog),target=machine.machine===catalog.machine,routeCell=route&&(target||machine.machine===route.source);
      const cache=cacheFact(v,machine.machine,catalog,location.state);
      const progress=cache.kind==='fetch'?cacheProgress(cache.progress):null,label=cache.label+(progress===null?'':' '+progress+'%');
      const content=`${serverIdHTML(machine.machine,'dataset-machine-label')}<span class="dataset-location-status" title="${esc(label)}">${cacheIconHTML(cache)}<span class="dataset-location-text">${esc(label)}</span></span>`;
      return `<div class="dataset-location${target?' dataset-target':''}" data-machine="${esc(machine.machine)}" data-location-state="${location.state}" data-cache-state="${cache.kind}" role="cell" aria-label="${esc(machine.machine+' · '+location.label)}">${routeCell?`<button type="button" class="dataset-location-fact dataset-route-cell" data-route-cell data-route-source="${esc(route.source)}" data-route-target="${esc(route.target)}" data-route-bytes="${route.bytes===null?'':route.bytes}" aria-label="${esc(route.source+' → '+route.target+'，缓存')}" title="缓存">${content}</button>`:`<div class="dataset-location-fact">${content}</div>`}${cache.kind==='fetch'?'<span class="dataset-cache-riser" aria-hidden="true"></span>':''}</div>`;
    }).join('');
    const versionHelp=route?'目录确认了复制来源，传输通道尚未返回。点击格子准备到所选服务器；数据就绪后才排显卡，准备期间不占额度。':selectable&&state!=='READY'?'数据准备完成后才排显卡。准备期间不占额度。':'';
    const files=Number.isSafeInteger(v.files)&&v.files>=0?v.files.toLocaleString('zh-CN')+' 个文件':'文件数未知';
    return `<article class="dataset-card" role="rowgroup"><div class="dataset-matrix-row${route?' dataset-route-row':''}" role="row"><div class="dataset-card-heading" role="rowheader"><h3>${esc(item.name||item.dataset)}</h3><p class="dataset-owner">${esc(ownerLabel)}</p><code class="dataset-short-version">${esc(String(v.version||'').slice(0,12))}</code></div>${cells}<div class="dataset-volume" role="cell">${esc(bytesLabel(v.bytes))}<small>${esc(files)}</small></div></div>${databaseGroundHTML(v)}${route?`<div class="dataset-mobile-route" aria-label="${esc(route.source+' → '+route.target)}">${serverIdHTML(route.source)}<span aria-hidden="true">→</span>${serverIdHTML(route.target)}${route.bytes===null?'':`<small>· ${esc(bytesLabel(route.bytes))}</small>`}</div>`:''}<div class="dataset-row-details dataset-matrix-row" role="row"><div class="dataset-details-cell copy-caption" role="cell"><details class="dataset-version-details"><summary><span class="dataset-version-caption">版本与路径</span></summary>${datasetFlowDetailHTML(item.dataset,v,catalog,access.canPrepare?(route||datasetFlowRoute(v,catalog)):null,{...options,trainingAllowed:access.ready})}<span data-state="${esc(state)}" class="dataset-readiness">${esc(labels[state]||state)}</span><label class="field">版本<input readonly value="${esc(item.dataset+'@'+v.version)}" aria-label="${esc(item.dataset)} 的版本" spellcheck="false"></label><p class="muted">训练路径：<code>/data2/${esc(item.dataset)}</code>（只读）</p>${where}${storage}</details>${versionHelp?infoHTML(versionHelp,'版本与准备说明'):''}${help?`<span class="dataset-guidance">${esc(help)}</span>`:''}${v.error?`<p class="form-error" role="status">${esc(v.error)}</p>`:''}<span class="dataset-more-slot" data-dataset-more-slot data-machine="${esc(catalog.machine)}" data-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" data-dataset-state="${esc(state)}"${locations.find(row=>row.machine===catalog.machine)?.dataset?` data-local-dataset="${esc(locations.find(row=>row.machine===catalog.machine).dataset)}"`:""}></span></div>${machines.map(machine=>`<div data-machine="${esc(machine.machine)}" class="dataset-actions-cell${machine.machine===catalog.machine?' dataset-target':''}" role="cell">${machine.machine===catalog.machine?`<div class="file-actions">${!access.canPrepare?'':`<button class="button" data-prepare-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${state==='READY'?'hidden':''} ${access.prepare?'':'disabled'}>缓存</button>`}<button class="button primary" data-use-dataset="${esc(item.dataset)}" data-version="${esc(v.version)}" ${selectable?'':'disabled'}>${'用于训练'}</button></div>`:''}</div>`).join('')}<div role="cell"></div></div></article>`;
  })).join('');
  if(!rows)return `<div class="empty">${catalog?.partial?'目录未确认，请刷新。':'还没有数据集，从“添加数据”开始。'}</div>`;
  return `<div class="dataset-matrix" data-machine-count="${machines.length}" data-selected-column="${selected}" role="table" tabindex="0" aria-label="数据版本的副本位置"><div class="dataset-matrix-row dataset-matrix-heading" role="row"><span role="columnheader">数据集 · 版本</span>${machines.map(machine=>`<span class="${machine.machine===catalog.machine?'dataset-target':''}" data-machine="${esc(machine.machine)}" title="${esc(machine.machine)}" tabindex="0" role="columnheader">${serverIdHTML(machine.machine)}${machine.machine===catalog.machine?'<small>所选服务器</small>':''}</span>`).join('')}<span role="columnheader">数据量</span></div>${rows}<div class="dataset-copy-route" hidden aria-hidden="true"><svg><path></path></svg><span></span></div></div>`;
}
export function uploadRouteHTML(route,machine,state){
  machine=route?.machine||machine;
  const direct=route?.kind==='campus-direct',tail=route?.kind==='tail-upload',relay=route?.kind==='vps-relay',known=direct||tail||relay;
  return `<div class="dataset-route-heading"><span class="st ${known?'st-prep':'st-unk'}"><span class="g" aria-hidden="true"></span>${direct?'直传到':tail?'Tail 备用上传':relay?'经门户中转':'通道未确认'}${(direct||tail)&&machine?' '+serverIdHTML(machine):''}</span><span class="dataset-route-path"><span>你的电脑</span>${relay?'<i aria-hidden="true">→</i><span>门户</span>':tail?'<i aria-hidden="true">→</i><span>专用 Tail 入口</span>':''}${known?'<i aria-hidden="true">→</i>'+serverIdHTML(machine||'所选服务器'):''}</span>${infoHTML(known?direct?'文件直接发送到已授权的服务器，门户只处理确认。':tail?'只改变本次上传入口，不改变默认路由。Tail 中继可能影响速度。':'文件经过门户发送到所选服务器。':'扫描目录后确认上传通道；发送文件前会显示实际路线。','实际上传路线')}</div>${uploadJourneyHTML(route,machine,state)}`;
}
export function datasetsUI(store,toast){
  const section=document.querySelector('#page-datasets');let identity='',generation=0,busy=false,uploadBusy=false,discardBusy=false,queryBusy=false,controller=null,active=null,machineIds='',uploadRoute=null,uploadState=null,lastScan=null,canRelay=false,catalog=null;
  let initialCatalog=true;
  const actionPlaces=new WeakMap();
  const account=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  const current=expected=>expected===account();
  const machineAllowed=machine=>datasetAuthorizedMachines(store).some(row=>row.id===machine);
  const human=transferBytes;
  const workspace=dataWorkspaceUI(store,section,toast,{onBusyChange:controls,refreshCatalog:load});
  const cloud=cloudImportUI(store,section,toast);
  const removeUI=datasetRemoveUI(store,section,toast,{reload:load,catalog:()=>catalog,management:false});
  const warehouse=datasetWarehouseView(store,section,toast,{refresh:load,removeUI,machineAllowed,authorizedMachines:()=>datasetAuthorizedMachines(store),access:datasetAccess});
  new MutationObserver(()=>{
    if(document.body.dataset.room!=='datasets')section.querySelector('#dataset-add-dialog')?.close();
  }).observe(document.body,{attributes:true,attributeFilter:['data-room']});
  function quota(){}
  function databaseLedger(){}
  function layoutMatrix(){
    const matrix=section.querySelector('.dataset-matrix');if(!matrix)return;
    const columns=Number(matrix.dataset.machineCount);
    matrix.style.setProperty('--dataset-columns',`minmax(120px,1.35fr) repeat(${columns},minmax(${columns>4?'132px':'0'},1fr)) minmax(80px,.65fr)`);
    matrix.style.setProperty('--dataset-min-width',columns>4?(180+columns*132+98)+'px':'0px');
    const phone=matchMedia('(max-width:759px)').matches,focused=matrix.contains(document.activeElement)?document.activeElement:null;
    matrix.setAttribute('role',phone?'list':'table');matrix.setAttribute('aria-label',phone?'数据集与服务器副本':'数据版本的副本位置');
    for(const card of matrix.querySelectorAll('.dataset-card')){
      card.setAttribute('role',phone?'listitem':'rowgroup');
      const rows=[...card.querySelectorAll('.dataset-matrix-row')],actions=[...card.querySelectorAll('.dataset-actions-cell')];
      for(const action of actions){
        let place=actionPlaces.get(action);if(!place){place=document.createComment('desktop dataset actions');action.before(place);actionPlaces.set(action,place);}
        const location=card.querySelector('.dataset-location[data-machine="'+CSS.escape(action.dataset.machine)+'"]');
        if(phone&&action.classList.contains('dataset-target')&&location){if(action.parentElement!==location)location.append(action);}else if(action.previousSibling!==place)place.after(action);
      }
      for(const row of rows)if(phone)row.removeAttribute('role');else row.setAttribute('role','row');
      const cells=[...card.querySelectorAll('.dataset-card-heading,.dataset-location,.dataset-volume,.dataset-details-cell,.dataset-actions-cell'),...card.querySelectorAll('.dataset-row-details>div:not([class])')];
      for(const cell of cells)if(phone){if(cell.classList.contains('dataset-location'))cell.setAttribute('role','group');else cell.removeAttribute('role');}else cell.setAttribute('role',cell.classList.contains('dataset-card-heading')?'rowheader':'cell');
    }
    if(focused?.isConnected&&document.activeElement!==focused)focused.focus({preventScroll:true});
  }
  function clearRoute(){const overlay=section.querySelector('.dataset-copy-route');if(overlay)overlay.hidden=true;}
  function showRoute(button){
    if(matchMedia('(max-width:759px)').matches){clearRoute();return;}
    if(!button||busy)return;const matrix=button.closest('.dataset-matrix'),row=button.closest('.dataset-matrix-row'),overlay=matrix?.querySelector('.dataset-copy-route');if(!row||!overlay)return;
    const source=[...row.querySelectorAll('[data-machine]')].find(cell=>cell.dataset.machine===button.dataset.routeSource),target=[...row.querySelectorAll('[data-machine]')].find(cell=>cell.dataset.machine===button.dataset.routeTarget);if(!source||!target)return;
    const bounds=matrix.getBoundingClientRect(),from=source.getBoundingClientRect(),to=target.getBoundingClientRect(),x1=from.left+from.width/2-bounds.left,x2=to.left+to.width/2-bounds.left;
    overlay.hidden=false;overlay.style.left=Math.min(x1,x2)+'px';overlay.style.top=(row.getBoundingClientRect().bottom-bounds.top-44)+'px';overlay.style.width=Math.max(1,Math.abs(x2-x1))+'px';
    const path=overlay.querySelector('path'),width=Math.max(1,Math.abs(x2-x1)),right=x2>x1;
    path.setAttribute('d',`M${right?0:width} 1 V10 H${right?width:0} M${right?width-5:5} 6 L${right?width:0} 10 L${right?width-5:5} 14`);
    const bytes=button.dataset.routeBytes;overlay.querySelector('span').textContent=button.dataset.routeSource+' → '+button.dataset.routeTarget+(bytes!==''?' · '+bytesLabel(Number(bytes)):'');
    for(const animation of path.getAnimations())animation.cancel();for(const animation of overlay.getAnimations())animation.cancel();
    if(reducedMotion())overlay.animate([{opacity:0},{opacity:1}],{duration:150,easing:'linear'});
    else{path.setAttribute('pathLength','1');path.animate([{strokeDasharray:1,strokeDashoffset:1},{strokeDasharray:1,strokeDashoffset:0}],{duration:320,easing:'cubic-bezier(.2,0,0,1)'});}
  }
  section.addEventListener('pointerover',event=>{const button=event.target.closest('[data-route-cell]');if(button&&!button.contains(event.relatedTarget))showRoute(button);});
  section.addEventListener('pointerout',event=>{const button=event.target.closest('[data-route-cell]');if(button&&!button.contains(event.relatedTarget))clearRoute();});
  section.addEventListener('focusin',event=>{if(event.target.matches('[data-route-cell]'))showRoute(event.target);});
  section.addEventListener('focusout',event=>{if(event.target.matches('[data-route-cell]'))clearRoute();});
  function focusColumn(machine){
    const matrix=section.querySelector('.dataset-matrix');if(!matrix)return;
    for(const node of matrix.querySelectorAll('.dataset-matrix-heading [data-machine],.dataset-location,.dataset-actions-cell'))node.style.opacity=!machine||node.dataset.machine===machine?'1':'.4';
  }
  section.addEventListener('pointerover',event=>{const header=event.target.closest('.dataset-matrix-heading [data-machine]');if(header)focusColumn(header.dataset.machine);});
  section.addEventListener('pointerout',event=>{const header=event.target.closest('.dataset-matrix-heading [data-machine]');if(header&&!header.contains(event.relatedTarget))focusColumn(null);});
  section.addEventListener('focusin',event=>{const header=event.target.closest('.dataset-matrix-heading [data-machine]');if(header)focusColumn(header.dataset.machine);});
  section.addEventListener('focusout',event=>{if(event.target.closest('.dataset-matrix-heading [data-machine]'))focusColumn(null);});
  section.addEventListener('click',event=>{const cell=event.target.closest('[data-route-cell]');if(!cell||busy)return;const button=cell.closest('.dataset-card')?.querySelector('[data-prepare-dataset]');if(button&&!button.disabled)button.click();});
  globalThis.addEventListener('resize',()=>{layoutMatrix();clearRoute();});
  function installAddSheet(){
    const entry=section.querySelector('#datasets-add'),dialog=section.querySelector('#dataset-add-dialog'),controls=section.querySelector('.datasets-controls'),capacity=section.querySelector('#datasets-capacity');
    const toolbar=document.createElement('div');toolbar.className='datasets-toolbar';controls.before(toolbar);toolbar.append(controls,entry);
    entry.addEventListener('toggle',()=>{
      if(!section.contains(entry))return;
      if(entry.open&&!machineAllowed(section.querySelector('[name=dataset-machine]')?.value)){entry.open=false;return;}
      if(entry.open&&!dialog.open){dialog.querySelector('.dataset-sheet-context').append(controls,capacity);dialog.showModal();dialog.querySelector('[data-dataset-panel]:not([hidden]) input:not([disabled])')?.focus();}
      else if(!entry.open&&dialog.open)dialog.close();
    });
    entry.querySelector('summary').addEventListener('click',event=>{if(!machineAllowed(section.querySelector('[name=dataset-machine]')?.value))event.preventDefault();});
    dialog.addEventListener('close',()=>{if(!section.contains(entry))return;entry.open=false;toolbar.prepend(controls);section.querySelector('#datasets-database').before(capacity);const focused=document.activeElement;if(focused===document.body||dialog.contains(focused)||!focused?.getClientRects().length)(document.querySelector('[data-v3-upload]')||entry.querySelector('summary')).focus({preventScroll:true});});
    dialog.addEventListener('click',event=>{if(event.target.closest('[data-dataset-add-close]'))dialog.close();});
  }
  function phase(state){
    uploadState=state||null;
    const current=uploadPhase(state);
    for(const [index,item] of [...section.querySelectorAll('[data-upload-phase]')].entries()){
      item.dataset.status=index===current?'current':index<current?'complete':'pending';
      if(index===current)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');
    }
    showUploadRoute();
  }
  function showUploadRoute(route=uploadRoute){
    uploadRoute=route;
    const node=section.querySelector('#dataset-upload-route'),machine=section.querySelector('[name=dataset-machine]')?.value;
    if(node)node.innerHTML=uploadRouteHTML(route,machine,uploadState);
  }
  function relayChoice(reset=false){
    const files=Array.from(section.querySelector('[name=dataset-directory]')?.files||[]),total=files.reduce((n,f)=>n+f.size,0),warning=section.querySelector('#dataset-relay-warning'),check=section.querySelector('[name=dataset-relay-consent]');
    if(!warning||!check)return;
    warning.hidden=total<=LARGE_RELAY_BYTES||section.querySelector('[name=dataset-via]')?.value==='direct';
    if(reset)check.checked=false;
    section.querySelector('#dataset-relay-size').textContent=human(total);
  }
  function source(next){
    if(!['directory','link','workspace'].includes(next))return;
    section.querySelector('#dataset-add-dialog')?.classList.toggle('v3-other',next!=='directory');
    for(const button of section.querySelectorAll('[data-dataset-source]')){const selected=button.dataset.datasetSource===next;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
    for(const panel of section.querySelectorAll('[data-dataset-panel]'))panel.hidden=panel.dataset.datasetPanel!==next;
    for(const help of section.querySelectorAll('[data-dataset-help-source]'))help.hidden=help.dataset.datasetHelpSource!==next;
  }
  function controls(){
    serverSelectLabel(section.querySelector('[name=dataset-machine]'));
    restoreMaintenanceControls(section);relayChoice();
    const browsing=store.production&&!!store.principal,enabled=browsing&&machineAllowed(section.querySelector('[name=dataset-machine]')?.value),blocked=busy||uploadBusy||discardBusy||queryBusy||workspace.busy;
    const refresh=section.querySelector('#datasets-refresh'),select=section.querySelector('[name=dataset-machine]'),add=section.querySelector('#datasets-add>summary');
    if(refresh)refresh.disabled=!browsing||blocked;if(select)select.disabled=!enabled||blocked;
    if(add){add.setAttribute('aria-disabled',String(!enabled));add.title=enabled?'':'暂无服务器使用授权，仅可浏览目录';}
    for(const selector of ['#dataset-upload-start','[name=dataset-name]','[name=dataset-directory]','[name=dataset-relay-consent]','[name=dataset-via]']){const node=section.querySelector(selector);if(node)node.disabled=!enabled||uploadBusy||discardBusy||queryBusy||workspace.busy||active?.state==='DISCARDING';}
    for(const node of section.querySelectorAll('[data-dataset-source],#dataset-organize-next'))node.disabled=!enabled||uploadBusy||discardBusy||queryBusy||workspace.busy;
    const pause=section.querySelector('#dataset-upload-pause'),discard=section.querySelector('#dataset-upload-discard');if(pause)pause.hidden=!uploadBusy;if(discard)discard.hidden=uploadBusy||!active?.uploadId||['READY','DISCARDED'].includes(active.state);
    for(const id of ['dataset-upload-query','dataset-upload-retry-direct','dataset-upload-relay']){const node=section.querySelector('#'+id);if(node){node.disabled=!enabled||blocked;node.hidden=id==='dataset-upload-query'?!active?.uploadId||active.state==='READY':id==='dataset-upload-relay'?!canRelay:!active?.directFailed;}}
    workspace.controls();
    cloud.controls();
    disableMaintenanceControls(section,'#dataset-upload-start,#dataset-upload-discard,#dataset-upload-retry-direct,#dataset-upload-relay,[data-prepare-dataset],[data-retry-archive]',maintenanceFor(store.data?.operationalMaintenance,section.querySelector('[name=dataset-machine]')?.value));
    warehouse.uploadControls({busy,uploadBusy,workspaceBusy:workspace.busy,discardBusy,queryBusy});
  }
  document.addEventListener('gpuq-maintenance-state',()=>{if(section.children.length)controls();});
  document.addEventListener('gpuq-workspace-context',event=>{
    if(event.detail?.userId!==store.principal?.userId||uploadBusy||discardBusy||queryBusy||active&&!['READY','DISCARDED'].includes(active.state))return;
    const select=section.querySelector('[name=dataset-machine]'),machine=event.detail.machine;
    if(select&&machine!==select.value&&machineAllowed(machine)){select.value=machine;select.dispatchEvent(new Event('change',{bubbles:true}));}
  });
  store.onAuthChange?.(()=>{catalog=null;warehouse.reset();cloud.reset();workspace.reset();controller?.abort();controller=null;uploadBusy=false;discardBusy=false;queryBusy=false;active=null;lastScan=null;uploadRoute=null;uploadState=null;canRelay=false;busy=false;generation++;identity='';machineIds='';section.replaceChildren();});
  async function load(){
    if(section.hidden){initialCatalog=true;return;}
    if(busy||uploadBusy||discardBusy||!store.principal)return;
    initialCatalog=false;
    const selected=section.querySelector('[name=dataset-machine]')?.value,machine=machineAllowed(selected)?selected:null;
    busy=true;const token=++generation,expected=account(),button=section.querySelector('#datasets-refresh'),select=section.querySelector('[name=dataset-machine]');button.disabled=true;select.disabled=true;
    const valid=()=>token===generation&&current(expected)&&(section.querySelector('[name=dataset-machine]')?.value||null)===machine&&(machine===null||machineAllowed(machine));
    const status=section.querySelector('#datasets-status'),capacity=section.querySelector('#datasets-capacity');catalog=null;capacity.hidden=!machine;status.textContent=status.dataset.reason==='policy-change'?'授权已更新，读取目录…':'加载中…';capacity.innerHTML=datasetCapacityHTML(null,machine);databaseLedger(null);section.querySelector('#dataset-catalog').replaceChildren();
    try{await Promise.all([
      store.call('datasets.catalog',{machine}).then(result=>{if(!valid())return;if(result.machine!==machine)throw Error('返回目录与所选服务器不符，请刷新。');catalog=result;warehouse.catalog(catalog);warehouse.capacitiesForOthers();warehouse.loadOverview();status.textContent=result.partial?'部分目录待确认':'';delete status.dataset.reason;}).catch(error=>{if(valid()){catalog=null;warehouse.catalogUnavailable();section.querySelector('#dataset-catalog').replaceChildren();status.textContent='目录未能确认：'+error.message;}}),
      ...(machine?[store.call('datasets.capacity',{machine}).then(result=>{if(valid()){capacity.innerHTML=datasetCapacityHTML(result,machine);warehouse.capacity(result,machine);}}).catch(()=>{if(valid()){capacity.innerHTML=datasetCapacityHTML(null,machine);warehouse.capacity(null,machine);}})]:[])
    ]);}
    finally{if(token===generation){busy=false;controls();}}
  }
  section.addEventListener('change',e=>{
    if(e.target.name==='dataset-machine'){
      generation++;busy=false;catalog=null;warehouse.catalogUnavailable();initialCatalog=true;
      section.querySelector('#dataset-catalog').replaceChildren();
      workspace.reset();document.dispatchEvent(new CustomEvent('gpuq-data-workspace-context'));active=null;lastScan=null;canRelay=false;showUploadRoute(null);relayChoice(true);phase();
      section.querySelector('#data-workspace-files-list').replaceChildren();section.querySelector('#data-workspace-status').textContent='已切换服务器';section.querySelector('#dataset-upload-status').textContent='选择一个目录。';controls();load();
    }
    if(e.target.name==='dataset-directory'){
      active=null;lastScan=null;canRelay=false;showUploadRoute(null);relayChoice(true);phase();
      const files=Array.from(section.querySelector('[name=dataset-directory]').files||[]),status=section.querySelector('#dataset-upload-status');
      section.querySelector('#dataset-directory-selection').textContent=files.length?`已选 ${files.length.toLocaleString('zh-CN')} 个文件 · 共 ${human(files.reduce((n,f)=>n+f.size,0))}`:'尚未选择';
      status.textContent=files.length?`已选择 ${files.length.toLocaleString('en-US')} 个文件 · ${human(files.reduce((n,f)=>n+f.size,0))}`:'请选择目录。';controls();
    }
    if(e.target.name==='dataset-via'){relayChoice(true);showUploadRoute(e.target.value==='relay'?{kind:'vps-relay'}:null);}
  });
  section.addEventListener('input',e=>{if(e.target.name==='dataset-name'){active=null;lastScan=null;canRelay=false;showUploadRoute(null);phase();controls();}});
  section.addEventListener('submit',async e=>{
    if(e.target.id!=='dataset-upload-form')return;e.preventDefault();if(uploadBusy||discardBusy||queryBusy||workspace.busy||!store.production||!store.principal)return;
    const form=e.target,machine=section.querySelector('[name=dataset-machine]').value,files=form.elements['dataset-directory'].files,expected=account(),userId=store.principal.userId;
    if(!machineAllowed(machine)){toast('暂无服务器使用授权，仅可浏览目录。');return;}
    uploadBusy=true;controls();
    try{await warehouse.prepareUpload();if(!current(expected)||machine!==section.querySelector('[name=dataset-machine]').value)return;}
    catch(error){if(current(expected))toast(error.message);return;}
    finally{if(current(expected)){uploadBusy=false;controls();}}
    if(!current(expected))return;
    const name=form.elements['dataset-name'].value.trim();
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)){toast('名称需为 1–40 位字母、数字、下划线或连字符。');return;}
    if(!files?.length){toast('请先选择包含文件的目录。');return;}
    const via=form.elements['dataset-via'].value==='automatic'?'auto':form.elements['dataset-via'].value,allowRelay=form.elements['dataset-relay-consent'].checked===true;
    if(via==='relay'&&Array.from(files).reduce((n,f)=>n+f.size,0)>LARGE_RELAY_BYTES&&!allowRelay){
      toast('请先确认大文件经门户中转。');form.elements['dataset-relay-consent'].focus();return;
    }
    controller=new AbortController();const signal=controller.signal;uploadBusy=true;canRelay=false;warehouse.uploading(true);controls();
    const status=section.querySelector('#dataset-upload-status'),progress=section.querySelector('#dataset-upload-progress');progress.hidden=false;progress.removeAttribute('value');
    const check=()=>{if(!current(expected)||signal.aborted)throw Error('上传已暂停；选择同一目录可继续。');};
    const report=value=>{check();if(value.uploadId)active={...value,machine,name,manifestSha256:lastScan?.manifestSha256,totalBytes:lastScan?.totalBytes,entries:lastScan?.entries};warehouse.uploadProgress(value);phase(value.state);const labels={HASHING:'计算文件校验值',RECEIVING_MANIFEST:'上传目录清单',SEALING:'校验目录清单',UPLOADING:'上传文件',PUBLISHING:'服务器完整校验',READY:'可用于训练',FAILED:'上传失败',UNKNOWN:'未确认'};status.dataset.state=value.state;status.textContent=`${labels[value.state]||'未确认'}${value.path?' · '+value.path:''}${value.bytes!==undefined?' · '+human(value.bytes)+' / '+human(value.totalBytes):''}`;if(value.bytes!==undefined&&value.totalBytes>0){progress.max=value.totalBytes;progress.value=value.bytes;}else progress.removeAttribute('value');};
    try{
      status.textContent=machine+' · 正在读取目录…';
      const scan=await scanBrowserDirectory(files,{signal,onProgress:report});check();lastScan=scan;
      const keyStore={getHandle:key=>{try{return JSON.parse(localStorage.getItem('gpuq.dataset-upload.handle.'+key));}catch{return null;}},setHandle:(key,value)=>{try{localStorage.setItem('gpuq.dataset-upload.handle.'+key,JSON.stringify(value));}catch{}},get:key=>{try{return localStorage.getItem('gpuq.dataset-upload.'+key);}catch{return null;}},set:(key,value)=>{try{localStorage.setItem('gpuq.dataset-upload.'+key,value);}catch{throw Error('浏览器无法保存续传编号，请允许本站本地存储。');}}};
      const directCall=async(operation,args)=>{check();const result=await store.call(operation,args);check();return result;};
      const call=store.data?.transfers?.version===1?transferUploadCall(directCall):directCall;
      const result=await uploadBrowserDataset({userId,machine,name,scan,signal,onProgress:report,keyStore,call,allowRelay,via,onRoute:route=>{check();showUploadRoute(route);warehouse.actualRoute(route);}});check();
      active={...result,machine};phase('READY');status.dataset.state='READY';status.textContent=`已缓存 · 可用于训练 · ${result.dataset}@${result.version.slice(0,12)}`;progress.value=progress.max=1;await warehouse.completed(result);check();toast('数据集上传并校验完成，可以用于训练。');
    }catch(error){if(current(expected)){status.dataset.state=signal.aborted?'PAUSED':'UNKNOWN';phase(status.dataset.state);status.textContent=error.message;warehouse.uploadFailure(error,{paused:signal.aborted});if(error.uploadId)active={...active,uploadId:error.uploadId,machine,name,manifestSha256:lastScan?.manifestSha256,totalBytes:lastScan?.totalBytes,entries:lastScan?.entries,state:'UNKNOWN',directFailed:error.code?.startsWith('DIRECT')===true};canRelay=error.canRelay===true;}}
    finally{if(current(expected)){uploadBusy=false;controller=null;warehouse.uploading(false);controls();if(active?.state==='READY')await load();}}
  });
  section.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.hasAttribute('data-copy-dataset-version')){
      const expected=account();b.disabled=true;try{await navigator.clipboard.writeText(b.dataset.copyDatasetVersion);if(!current(expected)||!b.isConnected)return;b.textContent='已复制';setTimeout(()=>{if(current(expected)&&b.isConnected)b.textContent='复制';},1200);}catch(error){if(current(expected))toast('未能复制，请手动选择完整版本。');}finally{if(current(expected)&&b.isConnected)b.disabled=false;}return;
    }
    if(b.dataset.datasetSource){source(b.dataset.datasetSource);return;}
    if(['terminal-data-open','terminal-data-reconnect'].includes(b.id))section.querySelector('#dataset-add-dialog')?.close();
    if(b.id==='dataset-organize-next'){source('workspace');section.querySelector('#dataset-source-workspace').focus();return;}
    if(b.id==='datasets-refresh'){load();return;}
    if(b.id==='dataset-upload-query'){
      const expected=account(),target={...active};if(!target.uploadId)return;
      if(queryBusy||uploadBusy)return;queryBusy=true;controls();
      try{
        const result=await store.call('datasets.upload.status',{machine:target.machine,uploadId:target.uploadId});if(!current(expected))return;
        const status=section.querySelector('#dataset-upload-status');
        if(result.state==='READY'){
          confirmedDatasetUpload(result,target);active={...target,...result};phase('READY');await warehouse.completed(result);status.dataset.state='READY';status.textContent=`可用于训练 · ${result.dataset}@${result.version.slice(0,12)}`;canRelay=false;toast('数据集上传并校验完成，可以用于训练。');
        }else{active={...target,state:result.state};warehouse.uploadProgress(active);phase(result.state);status.dataset.state=result.state;status.textContent=({PUBLISHING:'服务器完整校验中',SEALING:'校验目录清单中',UPLOADING:'上传未完成，可继续',RECEIVING_MANIFEST:'清单未传完，可继续',FAILED:'上传失败',DISCARDED:'上传已取消'}[result.state]||'未确认')+(result.error?' · '+result.error:'');}
      }catch(error){if(current(expected)){active={...target,state:'UNKNOWN'};warehouse.uploadFailure(error,active);phase('UNKNOWN');section.querySelector('#dataset-upload-status').dataset.state='UNKNOWN';section.querySelector('#dataset-upload-status').textContent=error.message;}}
      finally{if(current(expected)){queryBusy=false;controls();if(active?.state==='READY')await load();}}return;
    }
    if(b.id==='dataset-upload-retry-direct'){section.querySelector('[name=dataset-via]').value='direct';section.querySelector('#dataset-upload-form').requestSubmit();return;}
    if(b.id==='dataset-upload-relay'){
      const form=section.querySelector('#dataset-upload-form');form.elements['dataset-via'].value='relay';showUploadRoute({kind:'vps-relay'});relayChoice();
      if(Array.from(form.elements['dataset-directory'].files||[]).reduce((n,f)=>n+f.size,0)>LARGE_RELAY_BYTES&&!form.elements['dataset-relay-consent'].checked){form.elements['dataset-relay-consent'].focus();return;}
      form.requestSubmit();return;
    }
    if(b.id==='dataset-upload-pause'){controller?.abort();return;}
    if(b.id==='dataset-upload-discard'){
      if(!active?.uploadId||uploadBusy||discardBusy)return;const expected=account(),target={...active};discardBusy=true;b.disabled=true;controls();
      try{let result=await store.call('datasets.upload.discard',{machine:target.machine,uploadId:target.uploadId});if(!current(expected))return;active={...result,machine:target.machine};warehouse.uploadProgress(active);controls();while(result.state==='DISCARDING'){section.querySelector('#dataset-upload-status').textContent='正在取消未完成上传…';await new Promise(resolve=>setTimeout(resolve,1500));if(!current(expected))return;result=await store.call('datasets.upload.status',{machine:target.machine,uploadId:target.uploadId});if(!current(expected))return;active={...result,machine:target.machine};warehouse.uploadProgress(active);}section.querySelector('#dataset-upload-status').textContent=result.state==='DISCARDED'?'未完成上传已取消。':result.error||'取消结果尚未确认，请重新检查。';}
      catch(error){if(current(expected)){active={...target,state:'UNKNOWN'};warehouse.uploadFailure(error,active);toast(error.message);}}finally{if(current(expected)){discardBusy=false;b.disabled=false;controls();}}return;
    }
    const machine=section.querySelector('[name=dataset-machine]').value;
    if(b.dataset.retryArchive||b.dataset.prepareDataset){
      const name=b.dataset.prepareDataset||b.dataset.retryArchive;
      const version=catalog?.machine===machine&&catalog.datasets?.flatMap(item=>item.versions?.filter(row=>row.version===b.dataset.version&&(item.dataset===name||row.locations?.some(location=>location.machine===machine&&location.storage?.dataset===name)))||[])[0];
      const access=version?datasetAccess(version,catalog,{machineAuthorized:machineAllowed(machine)}):null;
      if(!access||b.dataset.prepareDataset&&!access.prepare||b.dataset.retryArchive&&!access.canRetry){toast('未获使用授权，或目录已改变，请刷新后再试。');return;}
    }
    if(b.dataset.retryArchive){const expected=account(),token=generation;b.disabled=true;try{await store.call('datasets.archive.retry',{machine,dataset:b.dataset.retryArchive,version:b.dataset.version});if(!current(expected)||token!==generation)return;toast('已安排重试存入仓库。');await load();}catch(error){if(current(expected)&&token===generation){toast(error.message);b.disabled=false;}}return;}
    if(b.dataset.prepareDataset){const expected=account(),token=generation;b.disabled=true;try{const result=await store.call('datasets.prepare',{machine,dataset:b.dataset.prepareDataset,version:b.dataset.version});if(!current(expected)||token!==generation)return;toast(result.state==='READY'?'数据已经就绪。':'已开始取回。');await load();}catch(error){if(current(expected)&&token===generation){toast(error.message);b.disabled=false;}}}
    if(b.dataset.useDataset){
      if(!warehouse.allowsTraining(b.dataset.useDataset,b.dataset.version))return;
      const datasetRef=b.dataset.useDataset+'@'+b.dataset.version;
      const origin=section.querySelector('[data-v3-select="'+CSS.escape(b.dataset.useDataset)+'"]');
      document.dispatchEvent(new CustomEvent('gpuq-open-submit',{detail:{machine,datasetRef,origin}}));
    }
  });
  section.addEventListener('keydown',event=>{
    const button=event.target.closest('[data-dataset-source]');if(!button||button.disabled)return;
    const buttons=[...section.querySelectorAll('[data-dataset-source]')],index=buttons.indexOf(button);let next;
    if(event.key==='ArrowRight')next=(index+1)%buttons.length;if(event.key==='ArrowLeft')next=(index+buttons.length-1)%buttons.length;if(event.key==='Home')next=0;if(event.key==='End')next=buttons.length-1;
    if(next!==undefined&&!buttons[next].disabled){event.preventDefault();source(buttons[next].dataset.datasetSource);buttons[next].focus();}
  });
  return ()=>{
    const machines=datasetAuthorizedMachines(store);
    const next=account(),ids=JSON.stringify(machines.map(m=>m.id));
    if(next!==identity){catalog=null;warehouse.reset();workspace.reset();controller?.abort();controller=null;uploadBusy=false;discardBusy=false;queryBusy=false;active=null;identity=next;generation++;busy=false;machineIds='';
      initialCatalog=true;section.classList.add('datasets-unified');
      section.innerHTML=`${warehouseWorkspaceHTML()}
        <details id="datasets-add" class="datasets-add"><summary class="button primary">添加数据 <span class="dataset-add-hint">从电脑上传，或让服务器直接下载</span></summary><dialog id="dataset-add-dialog" class="dataset-add-sheet" aria-labelledby="dataset-add-title"><header class="dataset-sheet-head"><div class="copy-caption"><h2 id="dataset-add-title">添加数据</h2></div><button class="button quiet" type="button" data-dataset-add-close aria-label="关闭添加数据">关闭</button></header><div class="dataset-sheet-context"></div>
        <div class="dataset-source-tabs" role="tablist" aria-label="添加数据的方式">
          <button type="button" role="tab" id="dataset-source-directory" data-dataset-source="directory" aria-controls="dataset-panel-directory" aria-selected="true"><span>电脑目录</span></button>
          <button type="button" role="tab" id="dataset-source-link" data-dataset-source="link" aria-controls="dataset-panel-link" aria-selected="false" tabindex="-1"><span>下载链接</span></button>
          <button type="button" role="tab" id="dataset-source-workspace" data-dataset-source="workspace" aria-controls="dataset-panel-workspace" aria-selected="false" tabindex="-1"><span>在服务器上整理</span></button>
        </div>
        <div id="dataset-panel-directory" data-dataset-panel="directory" role="tabpanel" aria-labelledby="dataset-source-directory">
        <form id="dataset-upload-form" aria-labelledby="dataset-upload-heading">
          <div class="dataset-upload-heading"><h3 id="dataset-upload-heading">上传一个数据集</h3><p class="muted">选择已整理好的目录。传输与校验完成后，即可用于训练。</p></div>
          <aside id="dataset-upload-route" class="dataset-route" aria-label="当前网页上传通道">${uploadRouteHTML(null)}</aside>
          <div class="field dataset-route-choice"><div class="dataset-field-label"><label for="dataset-via-input">上传通道</label>${infoHTML('自动优先使用已授权直传；直传连接失败不会自动中转。大于 256 MiB 的中转需要额外确认。','上传通道说明')}</div><select id="dataset-via-input" name="dataset-via"><option value="automatic">自动 · 优先直传</option><option value="direct">只用直传</option><option value="relay">经门户中转</option></select></div>
          <div class="dataset-upload-fields">
            <div class="field"><div class="dataset-field-label"><label for="dataset-name-input">数据集名称</label></div><input id="dataset-name-input" name="dataset-name" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,39}" placeholder="my-data" aria-describedby="dataset-name-help" required><small id="dataset-name-help">1–40 位字母、数字、下划线或连字符。</small></div>
            <div class="field"><div class="dataset-field-label"><label for="dataset-directory-input">电脑目录</label></div><div class="dataset-directory-control"><input id="dataset-directory-input" type="file" name="dataset-directory" webkitdirectory multiple aria-label="选择文件夹" aria-describedby="dataset-directory-help dataset-directory-selection"><label id="dataset-directory-picker" class="button" for="dataset-directory-input">选择文件夹</label><span id="dataset-directory-selection" aria-live="polite">尚未选择</span></div><small id="dataset-directory-help">选择整个目录；网页上传不包含空目录。</small></div>
          </div>
          <div id="dataset-relay-warning" class="dataset-relay-warning" hidden><label><input type="checkbox" name="dataset-relay-consent"><span>我确认经门户中转上传这 <strong id="dataset-relay-size"></strong> 数据</span></label>${infoHTML('中转带宽由所有用户共享，速度可能较慢。此确认不会开启直传，也不会在直传失败后自动切换。','大文件中转说明')}</div>
          <div class="file-actions dataset-upload-actions"><button class="button primary" type="submit" id="dataset-upload-start">上传 / 继续</button><button class="button" type="button" id="dataset-upload-pause" hidden>暂停传输</button><button class="button quiet" type="button" id="dataset-upload-query" hidden>重新查询</button><button class="button quiet" type="button" id="dataset-upload-retry-direct" hidden>重试直传</button><button class="button quiet" type="button" id="dataset-upload-relay" hidden>同意经门户中转</button><button class="button" type="button" id="dataset-upload-discard" hidden>取消未完成上传</button></div>
          <div class="dataset-upload-feedback"><ol class="dataset-upload-phases" aria-label="上传阶段"><li data-upload-phase="scan" data-status="pending">扫描</li><li data-upload-phase="transfer" data-status="pending">传输</li><li data-upload-phase="verify" data-status="pending">校验</li><li data-upload-phase="ready" data-status="pending">就绪</li></ol><progress id="dataset-upload-progress" aria-label="数据集上传进度" hidden></progress><p id="dataset-upload-status" role="status">选择一个目录。</p></div>
          <div class="dataset-upload-notes"><p class="muted">关闭页面会暂停传输；重新选择同一目录可继续。已开始的服务器校验不受影响。</p></div>
        </form></div>
        <div id="dataset-panel-link" data-dataset-panel="link" role="tabpanel" aria-labelledby="dataset-source-link" hidden>${cloudImportHTML(false)}<p class="datasets-next">下载完成只代表文件已到个人空间，尚未发布训练版本。</p><button class="button" type="button" id="dataset-organize-next">下一步：手动整理与发布</button></div>
        <div id="dataset-panel-workspace" data-dataset-panel="workspace" role="tabpanel" aria-labelledby="dataset-source-workspace" hidden>${dataWorkspaceHTML()}</div></dialog></details>`;
      installAddSheet();
      warehouse.install();
      for(const note of section.querySelectorAll('.dataset-upload-heading p,.dataset-upload-notes p,.dataset-route>p,.field>small,.data-workspace-card>p.muted,.data-workspace-terminal p.muted,#data-workspace-publish-form>p.muted,.data-workspace-footnote,.datasets-next,.cloud-import>p.muted'))discloseInfo(note,'数据操作说明');
      for(const field of section.querySelectorAll('.field')){
        const help=field.querySelector(':scope>.ui-info');if(!help)continue;
        let row=field.querySelector(':scope>.dataset-field-label');
        if(!row&&field.matches('label')){
          row=document.createElement('span');row.className='dataset-field-label field-caption';const caption=document.createElement('span');
          for(const node of [...field.childNodes]){if(node.nodeType===1&&node.matches('input,select,textarea'))break;if(node!==help)caption.append(node);}
          field.prepend(row);row.append(caption);
        }
        row?.append(help);
      }
      for(const help of section.querySelectorAll('.dataset-route>.ui-info'))help.parentElement.querySelector('.dataset-route-heading')?.append(help);
      const title=section.querySelector('.dataset-sheet-head>.copy-caption');
      const titleHelp=(help,tab)=>{if(!help)return;help.dataset.datasetHelpSource=tab;help.hidden=tab!=='directory';title.append(help);};
      for(const help of section.querySelectorAll('.data-workspace-card>.ui-info,.data-workspace-terminal>div>.ui-info,#data-workspace-publish-form>.ui-info')){
        const footnote=help.querySelector('.data-workspace-footnote');
        if(footnote){titleHelp(help,'workspace');continue;}
        const heading=help.parentElement.querySelector(':scope>header h3,:scope>h4');if(heading){const caption=document.createElement('span');caption.append(...heading.childNodes);heading.classList.add('dataset-help-heading');heading.append(caption,help);}
      }
      // Source-specific explanations share the title row; no empty footer or
      // help-only action row remains when a different source is selected.
      const notes=section.querySelector('.dataset-upload-notes');titleHelp(notes?.firstElementChild,'directory');notes?.remove();
      titleHelp(section.querySelector('#dataset-panel-link>.ui-info'),'link');
      for(const row of section.querySelectorAll('.field>span:has(>.copy-help),#cloud-admin>summary:has(>.copy-help)')){
        const help=row.querySelector(':scope>.copy-help'),caption=document.createElement('span');
        for(const node of [...row.childNodes])if(node!==help)caption.append(node);
        row.classList.add('dataset-help-heading');row.prepend(caption);
      }
      const relay=section.querySelector('#dataset-relay-warning'),relayHelp=relay.querySelector(':scope>.ui-info'),relayLabel=relay.querySelector(':scope>label');
      const relayRow=document.createElement('div');relayRow.className='copy-caption';relayLabel.before(relayRow);relayRow.append(relayLabel,relayHelp);
    }
    if(ids!==machineIds){
      const select=section.querySelector('[name=dataset-machine]'),selected=select.value,changed=machineIds!=='';
      select.innerHTML=machines.length?machines.map(m=>`<option value="${esc(m.id)}">${esc(m.id)}</option>`).join(''):'<option value="">仅浏览</option>';
      if(machines.some(m=>m.id===selected))select.value=selected;else if(!selected&&machines.some(m=>m.id===document.querySelector('[name=workspace-machine]')?.value))select.value=document.querySelector('[name=workspace-machine]').value;
      else if(selected){warehouse.reset();workspace.reset();cloud.reset(false);document.dispatchEvent(new CustomEvent('gpuq-data-workspace-context'));controller?.abort();active=null;section.querySelector('#data-workspace-files-list').replaceChildren();section.querySelector('#cloud-import-list').replaceChildren();section.querySelector('#data-workspace-status').textContent='服务器授权已改变；请重新确认当前机器。';section.querySelector('#cloud-import-status').textContent='服务器授权已改变；请刷新当前机器的导入进度。';}
      // The catalog spans all authorized machines: even removal of a different
      // machine must invalidate old rows and any in-flight aggregate response.
      if(changed){warehouse.reset();initialCatalog=true;generation++;busy=false;catalog=null;section.querySelector('#dataset-catalog').replaceChildren();section.querySelector('#datasets-capacity').innerHTML=datasetCapacityHTML(null,select.value);section.querySelector('#datasets-status').textContent=machines.length?'机器授权已更新，请重新加载目录。':'当前没有已授权机器。';section.querySelector('#datasets-status').dataset.reason='policy-change';}
      section.querySelector('#datasets-capacity').hidden=!machines.length;
      machineIds=ids;
    }
    if(!uploadRoute)showUploadRoute();quota();controls();warehouse.render();if(initialCatalog&&!section.hidden&&store.production&&store.principal){initialCatalog=false;queueMicrotask(load);}
  };
}
