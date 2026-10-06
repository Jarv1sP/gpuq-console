import {datasetRemoveUI} from './dataset-remove-ui.js';
import {cacheAdminHTML,datasetCacheAdminUI} from './dataset-cache-admin.js';
import {cloudImportHTML,cloudImportUI} from './cloud-import-ui.js';
import {datasetInfoHTML} from './dataset-flow.js';
import {serverIdHTML} from './workbench-ui.js';
import {transferBytes} from './data-route.js';

const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,hash=/^[a-f0-9]{64}$/;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=value=>Number.isSafeInteger(value)&&value>=0?transferBytes(value):'—';
const states={READY:'已缓存',PREPARING:'取回中',REGISTERED:'未缓存',STAGING:'上传未完成',FAILED:'取回失败',UNKNOWN:'待确认',NOT_LOCAL:'未缓存'};

// Administrator listings are physical registrations. Never infer an owner
// ID, join aliases belonging to different people, or invent archive proof.
export function adminDatasetCatalog(machine,machines,listings,personal=null){
  if(!id.test(machine)||!Array.isArray(machines)||!Array.isArray(listings))throw TypeError('Invalid administrator catalog');
  const groups=new Map(),nodes=[];
  for(const host of machines){
    if(!id.test(host?.id))throw TypeError('Invalid machine');
    const reads=listings.filter(row=>row.machine===host.id),read=reads.length===1?reads[0]:null;
    const known=read?.state==='ok'&&Array.isArray(read.datasets);nodes.push({machine:host.id,state:known?'ok':'unavailable'});
    if(!known)continue;
    for(const item of read.datasets){
      if(!id.test(item?.dataset)||!Array.isArray(item.versions))throw TypeError('Invalid dataset registration');
      if(!groups.has(item.dataset))groups.set(item.dataset,{dataset:item.dataset,versions:new Map(),registrations:[]});
      const group=groups.get(item.dataset);group.registrations.push({machine:host.id,ownerLabel:typeof item.ownerLabel==='string'?item.ownerLabel:'所属用户：未知'});
      for(const value of item.versions){
        if(!hash.test(value?.version))throw TypeError('Invalid immutable version');
        if(!group.versions.has(value.version))group.versions.set(value.version,{version:value.version,locations:[],quantities:[]});
        const v=group.versions.get(value.version),proof=personal?.datasets?.flatMap(row=>row.versions||[]).filter(row=>row.version===value.version).flatMap(row=>row.locations||[]).find(row=>row.machine===host.id&&row.dataset===item.dataset);
        v.quantities.push(value);
        v.locations.push({machine:host.id,dataset:item.dataset,ownerLabel:typeof item.ownerLabel==='string'?item.ownerLabel:'所属用户：未知',state:Object.hasOwn(states,value.state)?value.state:'UNKNOWN',canPrepare:value.canPrepare===true,
          ...(value.deletionPermissions?{deletionPermissions:structuredClone(value.deletionPermissions)}:{}),
          ...(proof?.storage?{storage:structuredClone(proof.storage)}:{}),...(proof?.removalPending===true?{removalPending:true}:{}),...(proof?.removalGraceEligible===true?{removalGraceEligible:true}:{}),
          ...(typeof value.error==='string'?{error:value.error}:{})});
      }
    }
  }
  const quantity=(rows,key)=>{const values=rows.map(row=>row[key]).filter(value=>Number.isSafeInteger(value)&&value>=0);return values.length&&values.every(value=>value===values[0])?values[0]:null;};
  return {machine,machines:nodes,partial:nodes.some(row=>row.state!=='ok'),datasetDelete:personal?.datasetDelete===1?1:0,
    datasets:[...groups.values()].map(group=>({dataset:group.dataset,registrations:group.registrations,versions:[...group.versions.values()].map(v=>{
      const local=v.locations.find(row=>row.machine===machine),known=nodes.find(row=>row.machine===machine)?.state==='ok';
      return {version:v.version,bytes:quantity(v.quantities,'bytes'),files:quantity(v.quantities,'files'),locations:v.locations,state:local?.state||(known?'NOT_LOCAL':'UNKNOWN'),canPrepare:local?.canPrepare===true,ownerLabel:local?.ownerLabel||v.locations[0]?.ownerLabel||'所属用户：未知'};
    })}))};
}

// The registry is supplied by PR-K1. Keeping the registration separate lets
// this module retain all moved operations without editing the admin shell.
export function registerDatasetStorageAdmin(registerAdminSection){
  let mounted=null;
  return registerAdminSection({id:'storage',title:'数据与存储',order:20,
    mount(el,ctx){mounted=mountAdminDataStorage(el,ctx);},unmount(){mounted?.destroy();mounted=null;}});
}

export function mountAdminDataStorage(el,{store,toast=()=>{},signal}={}){
  const lifecycle=new AbortController();signal?.addEventListener('abort',()=>destroy(),{once:true});
  el.dataset.adminStorage='';el.classList.add('admin-data-storage');
  let catalog=null,epoch=0,busy=false,ownerFilter='',disposed=false,cloud=null,cache=null,removals=null;
  const actor=()=>JSON.stringify([store?.principal?.userId,store?.principal?.role,store?.authGeneration]);
  const allowed=()=>!disposed&&!signal?.aborted&&el.isConnected&&!el.hidden&&store?.principal?.role==='admin'&&document.body.dataset.room==='admin';
  if(signal?.aborted||store?.principal?.role!=='admin'){el.textContent='需要管理员权限';return {destroy};}
  if(!document.querySelector('link[data-admin-storage-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/admin-data-storage.css';link.dataset.adminStorageStyle='';document.head.append(link);}
  el.innerHTML=`<header class="admin-storage-controls"><label class="field"><span>服务器</span><select name="dataset-machine" aria-label="管理服务器"></select></label><label class="field"><span>所属用户</span><select data-storage-owner aria-label="按所属用户筛选"><option value="">全部</option></select></label><button class="button" type="button" data-storage-refresh>刷新目录</button></header><p data-storage-status role="status"></p><div data-dataset-catalog id="admin-dataset-catalog"></div>${cacheAdminHTML(true)}<section class="admin-storage-cloud">${cloudImportHTML(true)}</section>`;
  const select=el.querySelector('[name=dataset-machine]');
  for(const machine of store.data?.machines||[]){const option=new Option(machine.id,machine.id);option.title=machine.id;select.add(option);}
  // Only connection administration moves here; the import workflow stays in
  // the user's upload drawer. Its existing controller retains QR semantics.
  const connection=el.querySelector('.admin-storage-cloud .cloud-import');
  for(const child of connection.children)if(child.id!=='cloud-admin')child.hidden=true;
  const summary=connection.querySelector('#cloud-admin>summary'),caption=document.createElement('span');caption.textContent='云盘连接';summary.firstChild.replaceWith(caption);
  cloud=cloudImportUI(store,el,toast);cache=datasetCacheAdminUI(store,el,toast,{room:'admin'});
  removals=datasetRemoveUI(store,el,toast,{reload:load,catalog:()=>catalog,readCatalog:read});
  async function read(machine){
    if(!allowed()||!store.production)throw Error('需要管理员权限');
    const expected=actor(),token=epoch,machines=(store.data?.machines||[]).map(row=>({...row})),listings=[];
    // The portal allows at most four concurrent directory reads. Three here
    // leave a slot for a read already in progress elsewhere in the shell.
    for(let i=0;i<machines.length;i+=3){
      const rows=await Promise.all(machines.slice(i,i+3).map(async row=>{try{const value=await store.call('datasets.list',{machine:row.id,includeEmpty:true});return {machine:row.id,state:'ok',datasets:value?.datasets};}catch{return {machine:row.id,state:'unavailable'};}}));
      if(!allowed()||expected!==actor()||token!==epoch)throw Error('账号或页面已改变');listings.push(...rows);
    }
    let personal=null;try{personal=await store.call('datasets.catalog',{machine});}catch{}
    if(!allowed()||expected!==actor()||token!==epoch)throw Error('账号或页面已改变');
    return adminDatasetCatalog(machine,machines,listings,personal);
  }
  function render(){
    if(!allowed())return;
    const machine=select.value,rows=(catalog?.datasets||[]),owners=[...new Set(rows.flatMap(row=>row.registrations.map(value=>value.ownerLabel)))].sort();
    const filter=el.querySelector('[data-storage-owner]');filter.replaceChildren(new Option('全部',''));
    for(const owner of owners)filter.add(new Option(owner,owner));filter.value=owners.includes(ownerFilter)?ownerFilter:'';ownerFilter=filter.value;
    const root=el.querySelector('[data-dataset-catalog]');root.innerHTML=rows.filter(item=>!ownerFilter||item.registrations.some(row=>row.ownerLabel===ownerFilter)).map(item=>{
      const versions=item.versions.filter(v=>v.locations.some(row=>row.machine===machine));
      if(!versions.length){const empty=item.registrations.find(row=>row.machine===machine);return empty?`<article class="admin-storage-empty"><h3>${esc(item.dataset)}</h3><span>${esc(empty.ownerLabel)}</span><span>尚未登记版本</span></article>`:'';}
      return versions.map(v=>{const local=v.locations.find(row=>row.machine===machine),state=states[local.state]||states.UNKNOWN;
        return `<article class="dataset-card admin-storage-row"><div class="admin-storage-identity"><h3><code title="${esc(item.dataset)}">${esc(item.dataset)}</code></h3><span title="${esc(local.ownerLabel)}">${esc(local.ownerLabel)}</span><code title="${esc(v.version)}">${esc(v.version.slice(0,12))}</code></div><div class="admin-storage-locations">${v.locations.map(row=>`<span class="st ${row.state==='READY'?'st-stop':row.state==='PREPARING'?'st-prep':row.state==='FAILED'?'st-err':'st-unk'}" title="${esc(row.machine+' · '+(states[row.state]||states.UNKNOWN))}"><span class="g" aria-hidden="true"></span>${serverIdHTML(row.machine)}</span>`).join('')}</div><div class="dataset-volume num">${amount(v.bytes)}<small>${v.files===null?'文件数未知':v.files.toLocaleString('zh-CN')+' 个文件'}</small></div><div class="admin-storage-actions"><span>${state}</span><span data-dataset-more-slot data-machine="${esc(machine)}" data-dataset="${esc(item.dataset)}" data-local-dataset="${esc(local.dataset)}" data-version="${esc(v.version)}" data-dataset-state="${esc(local.state)}"></span></div><details class="dataset-version-details"><summary><span>固定保留</span>${datasetInfoHTML('只解除当前账号创建的保留；其他账号的保留不会被修改。','固定保留')}</summary><div data-cache-pin-slot data-machine="${esc(machine)}" data-dataset="${esc(local.dataset)}" data-version="${esc(v.version)}"></div></details>${removals.canOpenFullDelete?.(item.dataset,v.version)===true?`<button class="button quiet" type="button" data-admin-full-delete="${esc(item.dataset)}" data-version="${esc(v.version)}">彻底删除…</button>`:''}</article>`;
      }).join('');
    }).join('')||`<div class="empty">${catalog?.partial?'部分目录待确认':ownerFilter?'没有匹配的数据集':'这台服务器还没有数据集'}</div>`;
    cache.render();cloud.controls();
  }
  async function load(){
    if(busy||!allowed()||!store.production||!select.value)return;
    busy=true;const expected=actor(),token=++epoch,machine=select.value,status=el.querySelector('[data-storage-status]');
    el.querySelector('[data-storage-refresh]').disabled=true;select.disabled=true;status.textContent='读取目录…';
    try{const value=await read(machine);if(!allowed()||expected!==actor()||token!==epoch)return;catalog=value;render();status.textContent=value.partial?'部分目录待确认':'';}
    catch(error){if(allowed()&&expected===actor()&&token===epoch){catalog=null;el.querySelector('[data-dataset-catalog]').replaceChildren();status.textContent=error.message;}}
    finally{if(allowed()&&expected===actor()&&token===epoch){busy=false;select.disabled=false;el.querySelector('[data-storage-refresh]').disabled=false;}}
  }
  el.addEventListener('change',event=>{if(event.target===select){cache.reset();cloud.reset();catalog=null;load();}if(event.target.hasAttribute('data-storage-owner')){ownerFilter=event.target.value;render();}},{signal:lifecycle.signal});
  el.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.hasAttribute('data-storage-refresh'))load();if(button.hasAttribute('data-admin-full-delete')&&removals.canOpenFullDelete?.(button.dataset.adminFullDelete,button.dataset.version)===true)removals.openFullDelete(button.dataset.adminFullDelete,button.dataset.version);},{signal:lifecycle.signal});
  function destroy(){if(disposed)return;disposed=true;epoch++;lifecycle.abort();removals?.sync(false);cache?.reset();cloud?.reset();el.querySelectorAll('dialog[open]').forEach(node=>node.close());el.replaceChildren();}
  // No administration happens until the privileged section is mounted.
  queueMicrotask(load);return {destroy,refresh:load};
}
