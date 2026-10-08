import {memberStorageGroups} from './member-storage-model.js';
import {transferBytes} from './data-route.js';
import {canCacheAction,mountCacheOperation} from './dataset-cache-operation.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=value=>value===null?'—':transferBytes(value);
export function mountMemberStorage(section,{store,catalog,machines,refresh,onViewChanged=()=>{}}){
 const host=section.querySelector('#member-storage'),warehouse=section.querySelector('.v3-split'),tabs=section.querySelector('.storage-view-tabs');
 let view='warehouse',projects=new Map(),caps=new Map(),reading=new Set(),controller=null,request=0,busy=false,partial=false,groups=[],dialog=null,operation=null,operationLifetime=null,template='';
 const identity=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
 const active=()=>view==='mine'&&store.production&&!!store.principal&&!section.hidden&&!document.hidden&&document.body.dataset.room==='datasets';
 const keyOf=row=>JSON.stringify([row.machine,row.dataset,row.version]);
 const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const row=groups.flatMap(group=>group.items).find(row=>row.kind==='cache'&&row.key===entry.target.dataset.storageCache);if(row)void capability(row);}});
 function close(){operationLifetime?.abort();operation?.destroy();operation=null;operationLifetime=null;dialog?.close();}
 function stop(){request++;controller?.abort();controller=null;busy=false;reading.clear();observer.disconnect();close();}
 function reset(){stop();projects.clear();caps.clear();partial=false;groups=[];template='';view='warehouse';syncView();render();}
 function syncView(){warehouse.hidden=view==='mine';host.hidden=view!=='mine';for(const tab of tabs.querySelectorAll('[data-storage-view]')){const selected=tab.dataset.storageView===view;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}onViewChanged(view);}
 function render(){
  if(!host?.isConnected)return;
  groups=memberStorageGroups({principal:store.principal,machines:machines(),catalog:catalog(),projects});
  const value=(busy?'<p class="storage-mine-status" role="status">读取中</p>':partial?'<p class="storage-mine-status" role="status">部分项目待确认 <button type="button" class="button quiet" data-storage-retry>重试</button></p>':'')+
   (groups.length?'<div class="storage-mine-key"><span><i class="project"></i>容器</span><span><i></i>数据集缓存</span></div>':'')+groups.map(group=>`<article class="storage-mine-machine" data-storage-machine="${esc(group.machine)}"><header><code title="${esc(group.machine)}">${esc(group.machine)}</code><span class="storage-mine-total"><b class="num">${esc(amount(group.totalBytes))}</b> 我的占用</span></header>${group.totalBytes!==null?`<div class="storage-mine-bar" aria-label="我的占用 ${esc(amount(group.totalBytes))}"><i class="project" style="width:${group.totalBytes?group.projectBytes/group.totalBytes*100:0}%"></i><i style="width:${group.totalBytes?group.cacheBytes/group.totalBytes*100:0}%"></i></div>`:''}<div class="storage-mine-rows">${group.items.map(row=>`<div class="storage-mine-row" ${row.kind==='cache'?`data-storage-cache="${esc(row.key)}"`:''}><i class="${row.kind==='project'?'project':''}" aria-hidden="true"></i><span class="storage-mine-name"><b title="${esc(row.name)}">${esc(row.name)}</b><small title="${esc(row.kind==='project'?row.project:row.version)}">${row.kind==='project'?'个人容器':esc(row.version.slice(0,12))}</small></span><span class="storage-mine-size num">${esc(amount(row.bytes))}</span><span class="storage-mine-action">${row.kind==='project'?`<button class="button quiet" type="button" data-storage-project="${esc(row.project)}" data-machine="${esc(row.machine)}" ${busy||!group.projectsConfirmed?'disabled':''}>打开</button>`:canCacheAction(caps.get(row.key),'release')?`<button class="button quiet" type="button" data-storage-release="${esc(row.key)}">释放</button>`:''}</span></div>`).join('')}</div></article>`).join('')+(!groups.length&&!busy&&!partial?'<p class="storage-mine-empty">暂无内容</p>':'');
  if(value!==template){const focused=host.contains(document.activeElement)?document.activeElement:null,project=focused?.dataset.storageProject,machine=focused?.dataset.machine,release=focused?.dataset.storageRelease;template=value;host.innerHTML=value;const next=project?[...host.querySelectorAll('[data-storage-project]')].find(node=>node.dataset.storageProject===project&&node.dataset.machine===machine):release?[...host.querySelectorAll('[data-storage-release]')].find(node=>node.dataset.storageRelease===release):null;next?.focus({preventScroll:true});}
  observer.disconnect();if(active())for(const node of host.querySelectorAll('[data-storage-cache]'))observer.observe(node);
 }
 async function load(){
  if(!active())return;stop();controller=new AbortController();const signal=controller.signal,expected=identity(),token=request;busy=true;partial=false;caps.clear();render();
  const valid=()=>!signal.aborted&&expected===identity()&&token===request&&active();
  for(const row of machines()){
   try{const result=await store.call('projects.list',{machine:row.id},{signal});if(!valid())return;if(!Array.isArray(result?.projects))throw Error('项目列表待确认');projects.set(row.id,{confirmed:true,projects:result.projects});}
   catch{if(!valid())return;partial=true;projects.set(row.id,{confirmed:false,projects:projects.get(row.id)?.projects||[]});}
   if(valid())render();
  }
  if(valid()){busy=false;render();}
 }
 async function capability(row,force=false){
  const key=keyOf(row);if(!active()||!controller||reading.has(key)||!force&&caps.has(key))return caps.get(key);
  const expected=identity(),token=request,signal=controller.signal;reading.add(key);
  try{const cap=await store.call('datasets.cache.capabilities',{machine:row.machine,dataset:row.dataset,version:row.version},{signal});if(signal.aborted||expected!==identity()||token!==request||!active())return;caps.set(key,cap);render();return cap;}
  catch{if(!signal.aborted&&expected===identity()&&token===request){caps.set(key,null);render();}}
  finally{if(token===request)reading.delete(key);}
 }
 async function release(key){
  const row=groups.flatMap(group=>group.items).find(row=>row.kind==='cache'&&row.key===key),expected=identity();if(!row||!active())return;
  const cap=await capability(row,true);if(!active()||expected!==identity()||!canCacheAction(cap,'release')||!groups.flatMap(group=>group.items).some(item=>item.key===key))return;
  close();if(!dialog){dialog=document.createElement('dialog');dialog.className='dataset-sheet storage-release-sheet';dialog.innerHTML='<header class="dataset-sheet-head"><h2>释放缓存</h2><button type="button" class="button quiet" data-storage-close>关闭</button></header><div data-storage-operation></div>';section.append(dialog);dialog.addEventListener('close',()=>{if(!dialog.open){operationLifetime?.abort();operation?.destroy();operation=null;operationLifetime=null;}});}
  dialog.querySelector('[data-storage-operation]').replaceChildren();operationLifetime=new AbortController();dialog.showModal();const observed=new Set();
  operation=mountCacheOperation(dialog.querySelector('[data-storage-operation]'),{store,action:'release',machine:row.machine,dataset:row.dataset,version:row.version,capabilities:cap,signal:operationLifetime.signal,explain:false,onChange:value=>{if(expected!==identity()||!active())return;const proof=JSON.stringify([value.operationId,value.state,value.receiptOnly,value.locationState]);if(value.confirmed&&!observed.has(proof)&&(['RELEASED','CANCELED','FAILED','BLOCKED'].includes(value.state)||value.receiptOnly||value.locationState==='NOT_OBSERVED')){observed.add(proof);refresh();}}});
 }
 function handleClick(event){const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.hasAttribute('data-storage-view')){const next=button.dataset.storageView;if(next===view)return;stop();view=next;syncView();render();if(view==='mine')void load();}
  if(button.hasAttribute('data-storage-retry'))void load();
  if(button.hasAttribute('data-storage-close'))close();
  if(button.hasAttribute('data-storage-release'))void release(button.dataset.storageRelease);
  if(button.hasAttribute('data-storage-project')&&active()&&groups.some(group=>group.machine===button.dataset.machine&&group.projectsConfirmed&&group.items.some(row=>row.project===button.dataset.storageProject)))document.dispatchEvent(new CustomEvent('gpuq-open-project',{detail:{machine:button.dataset.machine,project:button.dataset.storageProject,userId:store.principal.userId,authGeneration:store.authGeneration}}));
 }
 section.addEventListener('click',handleClick);
 const handleKeys=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...tabs.querySelectorAll('button')],target=event.key==='Home'?buttons[0]:event.key==='End'?buttons.at(-1):buttons.find(button=>button!==event.target);target?.click();target?.focus();};
 tabs.addEventListener('keydown',handleKeys);
 const sync=()=>{if(!active())stop();else if(!controller)void load();};
 const roomObserver=new MutationObserver(sync),sectionObserver=new MutationObserver(sync);
 roomObserver.observe(document.body,{attributes:true,attributeFilter:['data-room']});
 sectionObserver.observe(section,{attributes:true,attributeFilter:['hidden']});
 document.addEventListener('visibilitychange',sync);
 const unsubscribe=store.onAuthChange?.(reset);
 syncView();render();
 return {host,render,reset,destroy(){stop();observer.disconnect();roomObserver.disconnect();sectionObserver.disconnect();document.removeEventListener('visibilitychange',sync);section.removeEventListener('click',handleClick);tabs.removeEventListener('keydown',handleKeys);if(typeof unsubscribe==='function')unsubscribe();dialog?.remove();},get active(){return view==='mine';}};
}
