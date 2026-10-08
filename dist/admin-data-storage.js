import {datasetRemoveUI} from './dataset-remove-ui.js';
import {datasetCacheAdminUI} from './dataset-cache-admin.js';
import {cloudImportHTML,cloudImportUI} from './cloud-import-ui.js';
import {datasetInfoHTML,cacheBudget,cacheGaugeHTML,cachePreviewHTML,hasDatabaseOriginal,storageCapacityDetailHTML,applyCapacityGeometry} from './dataset-flow.js';
import {adaptStorageOverview,readStorageOverview} from './dataset-catalog-model.js';
import {serverIdHTML} from './workbench-ui.js';
import {transferBytes} from './data-route.js';
import {mountArchiveEnrollment} from './archive-enrollment-ui.js';
import {mountAdminStorageMembers} from './admin-storage-members.js';
// The preview model imports the private inventory. Keep this validator pure;
// its username contract is checked against model.js by the storage tests.
const validUsername=value=>typeof value==='string'&&/^[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}$/u.test(value);

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
      const group=groups.get(item.dataset);group.registrations.push({machine:host.id,ownerLabel:typeof item.ownerLabel==='string'?item.ownerLabel:'所属用户：未知（授权信息未完整返回）'});
      for(const value of item.versions){
        if(!hash.test(value?.version))throw TypeError('Invalid immutable version');
        if(!group.versions.has(value.version))group.versions.set(value.version,{version:value.version,locations:[],quantities:[]});
        const v=group.versions.get(value.version),proof=personal?.datasets?.flatMap(row=>row.versions||[]).filter(row=>row.version===value.version).flatMap(row=>row.locations||[]).find(row=>row.machine===host.id&&row.dataset===item.dataset);
        v.quantities.push(value);
        v.locations.push({machine:host.id,dataset:item.dataset,ownerLabel:typeof item.ownerLabel==='string'?item.ownerLabel:'所属用户：未知（授权信息未完整返回）',state:Object.hasOwn(states,value.state)?value.state:'UNKNOWN',canPrepare:value.canPrepare===true,bytes:Number.isSafeInteger(value.bytes)&&value.bytes>=0?value.bytes:null,
          ...(value.deletionPermissions?{deletionPermissions:structuredClone(value.deletionPermissions)}:{}),
          ...(typeof value.warehouseReady==='boolean'&&Object.hasOwn(states,value.state)?{warehouseReady:value.warehouseReady}:{}),
          ...(proof?.storage?{storage:structuredClone(proof.storage)}:{}),...(proof?.removalPending===true?{removalPending:true}:{}),...(proof?.removalGraceEligible===true?{removalGraceEligible:true}:{}),
          ...(typeof value.error==='string'?{error:value.error}:{})});
      }
    }
  }
  const quantity=(rows,key)=>{const values=rows.map(row=>row[key]).filter(value=>Number.isSafeInteger(value)&&value>=0);return values.length&&values.every(value=>value===values[0])?values[0]:null;};
  return {machine,machines:nodes,partial:nodes.some(row=>row.state!=='ok'),datasetDelete:personal?.datasetDelete===1?1:0,datasetDeleteKnown:personal?.datasetDelete===1||personal?.datasetDelete===0,
    datasets:[...groups.values()].map(group=>({dataset:group.dataset,registrations:group.registrations,versions:[...group.versions.values()].map(v=>{
      const local=v.locations.find(row=>row.machine===machine),known=nodes.find(row=>row.machine===machine)?.state==='ok';
      return {version:v.version,bytes:quantity(v.quantities,'bytes'),files:quantity(v.quantities,'files'),locations:v.locations,state:local?.state||(known?'NOT_LOCAL':'UNKNOWN'),canPrepare:local?.canPrepare===true,ownerLabel:local?.ownerLabel||v.locations[0]?.ownerLabel||'所属用户：未知（授权信息未完整返回）'};
    })}))};
}

// The registry is supplied by PR-K1. Keeping the registration separate lets
// this module retain all moved operations without editing the admin shell.
export function registerDatasetStorageAdmin(registerAdminSection){
  let mounted=null;
  return registerAdminSection({id:'storage',title:'数据与存储',order:20,
    mount(el,ctx){mounted=mountAdminDataStorage(el,ctx);},unmount(){mounted?.destroy();mounted=null;}});
}

export function adminStorageSummary(status,plan){
  const budget=cacheBudget(status,plan),candidates=Array.isArray(plan?.candidates)?plan.candidates:null;
  const sizes=candidates?.map(row=>row.bytes),bytes=sizes?.every(value=>Number.isSafeInteger(value)&&value>=0)?sizes.reduce((a,b)=>a+b,0):null;
  return {budget,count:candidates?.length??null,bytes:Number.isSafeInteger(bytes)?bytes:null};
}

// Owner labels are the portal's trusted projection of node ACLs. Shared
// caches count for each named user; missing names/bytes are not allocated.
export function adminStorageUsers(catalog){
  const users=new Map();let excluded=0;
  for(const item of catalog?.datasets||[])for(const version of item.versions||[])for(const location of version.locations||[]){
    if(location.state!=='READY')continue;
    const label=location.ownerLabel,names=typeof label==='string'&&/^(所属用户：|共享授权用户：)/.test(label)?label.replace(/^(所属用户：|共享授权用户：)/,'').split('、').filter(validUsername):[];
    if(!names.length||!Number.isSafeInteger(version.bytes)||version.bytes<0||location.bytes!==version.bytes){excluded++;continue;}
    for(const name of new Set(names)){
      if(!users.has(name))users.set(name,{name,datasets:new Set(),bytes:0});
      const row=users.get(name);row.datasets.add(item.dataset);row.bytes+=version.bytes;
    }
  }
  return {rows:[...users.values()].map(row=>({name:row.name,datasets:row.datasets.size,bytes:Number.isSafeInteger(row.bytes)?row.bytes:null})).sort((a,b)=>(b.bytes??-1)-(a.bytes??-1)||a.name.localeCompare(b.name)),excluded,partial:catalog?.partial===true};
}

export function adminWarehouseMachines(catalog){
  const hosts=new Set();
  for(const item of catalog?.datasets||[])for(const version of item.versions||[])for(const location of version.locations||[])
    if(hasDatabaseOriginal({...version,locations:[location]}))hosts.add(location.storage?.archiveMachine||location.machine);
  return hosts;
}


export function mountAdminDataStorage(el,{store,toast=()=>{},signal}={}){
  const lifecycle=new AbortController();signal?.addEventListener('abort',()=>destroy(),{once:true});
  el.dataset.adminStorage='';el.classList.add('admin-data-storage');
  let catalog=null,overview=null,epoch=0,busy=false,disposed=false,cloud=null,cache=null,removals=null,fitting=null,fullTasks=null,enrollment=null,members=null;
  const telemetry=new Map(),pinStatus=new Map();
  const machines=()=>store.data?.machines||[];
  const actor=()=>JSON.stringify([store?.principal?.userId,store?.principal?.role,store?.authGeneration]);
  const allowed=()=>!disposed&&!signal?.aborted&&el.isConnected&&!el.hidden&&store?.principal?.role==='admin'&&document.body.dataset.room==='admin';
  if(signal?.aborted||store?.principal?.role!=='admin'){el.textContent='需要管理员权限';return {destroy};}
  if(!document.querySelector('link[data-admin-storage-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/admin-data-storage.css';link.dataset.adminStorageStyle='';document.head.append(link);}
  el.innerHTML=`<header class="admin-storage-controls"><h3>服务器存储</h3><button class="button" type="button" data-storage-refresh>刷新状态</button></header><select name="dataset-machine" aria-label="管理服务器" hidden></select><p data-storage-status role="status"></p><div class="storage-fleet" aria-label="服务器存储总览"></div><section class="storage-operations"><header class="storage-operations-head"><h3 data-storage-machine></h3><span>存储运维</span></header><div class="storage-policy"><header><h4>缓存策略</h4>${datasetInfoHTML('按已登记缓存估算，含元数据；不是磁盘实际占用。预览不会立即删除数据，已确认的仓库数据不参与释放。','缓存预算说明')}</header><div data-storage-policy></div></div><div class="storage-release" data-storage-preview></div><section class="storage-retention"><header><h4>固定保留</h4>${datasetInfoHTML('数量来自服务器；只解除当前账号创建的原保留，其他账号的保留不会被修改。','固定保留')}</header><div data-storage-retention></div></section><section class="storage-local"><header><h4>本机缓存</h4></header><div data-dataset-catalog id="admin-dataset-catalog"></div></section></section><section class="storage-users"><header><h3>按用户统计</h3>${datasetInfoHTML("只汇总已就绪缓存的已知大小；含各服务器副本。共享副本分别计入明确授权的用户，未知归属和大小不计入。","统计口径")}</header><div data-storage-users></div></section><section class="storage-delete-tasks"><header><h3>删除任务</h3>${datasetInfoHTML("仅显示当前浏览器为本账号保存的原请求；查看任务后按原编号查询，可继续、取消或恢复。","删除任务范围")}</header><p data-storage-delete-capability></p><div data-storage-delete-tasks></div><p data-storage-delete-empty>本浏览器没有保存的删除任务</p></section><section class="admin-storage-cloud">${cloudImportHTML(true)}</section>`;
  const select=el.querySelector('[name=dataset-machine]');
  const viewID='storage-view-'+crypto.randomUUID(),tabs=document.createElement('div');tabs.className='storage-view-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','存储统计方式');
  tabs.innerHTML=`<button type="button" class="button" role="tab" id="${viewID}-server-tab" aria-controls="${viewID}-servers" aria-selected="true" tabindex="0" data-storage-view="servers">服务器</button><button type="button" class="button" role="tab" id="${viewID}-members-tab" aria-controls="${viewID}-members" aria-selected="false" tabindex="-1" data-storage-view="members">按成员</button>`;el.querySelector('.admin-storage-controls').after(tabs);
  const servers=document.createElement('div');servers.id=viewID+'-servers';servers.setAttribute('role','tabpanel');servers.setAttribute('aria-labelledby',viewID+'-server-tab');el.querySelector('.storage-fleet').before(servers);
  for(const panel of el.querySelectorAll('.storage-fleet,.storage-operations,.storage-delete-tasks,.admin-storage-cloud'))servers.append(panel);
  const membersPanel=el.querySelector('.storage-users');membersPanel.classList.add('storage-members-view');membersPanel.id=viewID+'-members';membersPanel.setAttribute('role','tabpanel');membersPanel.setAttribute('aria-labelledby',viewID+'-members-tab');membersPanel.hidden=true;
  membersPanel.querySelector('header').innerHTML='<h3 class="sr-only">成员存储</h3><span class="storage-member-key"><i class="warehouse"></i>仓库</span><span class="storage-member-key"><i class="project"></i>容器</span><span class="storage-member-key"><i></i>缓存</span>';
  const membersHost=el.querySelector('[data-storage-users]');membersHost.classList.add('storage-members-panel');members=mountAdminStorageMembers(membersHost,{store,catalog:()=>catalog,signal:lifecycle.signal});
  if(!document.querySelector('link[data-storage-members-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/admin-storage-members.css';link.dataset.storageMembersStyle='';document.head.append(link);}
  const enrollHost=document.createElement('section');el.querySelector('.storage-operations').append(enrollHost);
  enrollment=mountArchiveEnrollment(enrollHost,{store,machine:()=>select.value,active:allowed,signal:lifecycle.signal,refresh:()=>load(false),toast});
  if(!document.querySelector('link[data-archive-enrollment-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/archive-enrollment.css';link.dataset.archiveEnrollmentStyle='';document.head.append(link);}
  for(const machine of machines()){const option=new Option(machine.id,machine.id);option.title=machine.id;select.add(option);}
  const connection=el.querySelector('.admin-storage-cloud .cloud-import');
  for(const child of connection.children)if(child.id!=='cloud-admin')child.hidden=true;
  const caption=document.createElement('span');caption.textContent='云盘连接';connection.querySelector('#cloud-admin>summary').firstChild.replaceWith(caption);
  cloud=cloudImportUI(store,el,toast);connection.querySelector('#cloud-admin').open=true;
  cache=datasetCacheAdminUI(store,el,toast,{room:'admin',onStatus(target,status){
    if(!allowed())return;
    pinStatus.set(JSON.stringify([target.machine,target.dataset,target.version]),status);renderCards();
  }});
  removals=datasetRemoveUI(store,el,toast,{reload:()=>load(false),catalog:()=>catalog,readCatalog:read,management:true});
  fullTasks=removals.mountFullDeleteTasks(el.querySelector('[data-storage-delete-tasks]'),{signal:lifecycle.signal,active:allowed});
  fitting=new ResizeObserver(fitNames);fitting.observe(el);
  function fitNames(){
    if(!allowed())return;
    for(const label of el.querySelectorAll('.storage-machine-id')){
      label.style.fontSize='48px';
      const width=label.parentElement.clientWidth;
      if(label.scrollWidth>width)label.style.fontSize=Math.max(14,48*width/label.scrollWidth-.5)+'px';
    }
  }
  document.fonts.ready.then(fitNames);
  async function read(machine){
    if(!allowed()||!store.production)throw Error('需要管理员权限');
    const expected=actor(),token=epoch,hosts=machines().map(row=>({...row})),listings=[];
    // Bounded reads leave one portal directory slot for another view.
    for(let i=0;i<hosts.length;i+=3){
      const rows=await Promise.all(hosts.slice(i,i+3).map(async row=>{try{const value=await store.call('datasets.list',{machine:row.id,includeEmpty:true},{signal:lifecycle.signal});return {machine:row.id,state:'ok',datasets:value?.datasets};}catch{return {machine:row.id,state:'unavailable'};}}));
      if(!allowed()||expected!==actor()||token!==epoch)throw Error('账号或页面已改变');listings.push(...rows);
    }
    let personal=null;try{personal=await store.call('datasets.catalog',{machine},{signal:lifecycle.signal});}catch{}
    if(!allowed()||expected!==actor()||token!==epoch)throw Error('账号或页面已改变');
    return adminDatasetCatalog(machine,hosts,listings,personal);
  }
  function localVersions(machine){
    return (catalog?.datasets||[]).flatMap(item=>item.versions.flatMap(v=>{
      const local=v.locations.find(row=>row.machine===machine);
      return local?[{item,v,local}]:[];
    }));
  }
  function retained(machine){
    if(!catalog||catalog.machines.find(row=>row.machine===machine)?.state!=='ok')return null;
    const rows=localVersions(machine),counts=rows.map(({local,v})=>{
      const result=pinStatus.get(JSON.stringify([machine,local.dataset,v.version])),value=result?.version;
      return value?.dataset===local.dataset&&value.version===v.version&&Number.isSafeInteger(value.pinCount)&&value.pinCount>=0?value.pinCount:null;
    });
    return counts.every(value=>value!==null)&&Number.isSafeInteger(counts.reduce((a,b)=>a+b,0))?counts.reduce((a,b)=>a+b,0):null;
  }
  function renderCards(){
    if(!allowed())return;
    el.querySelector('.storage-fleet').innerHTML=machines().map((host,index)=>{
      const row=telemetry.get(host.id),summary=adminStorageSummary(row?.status,row?.plan),pins=retained(host.id);
      const warehouse=adminWarehouseMachines(catalog).has(host.id)||overview?.warehouse.volumes.some(value=>value.machine===host.id);
      return `<article class="storage-server-card" data-selected="${host.id===select.value}"><button class="storage-server-select" type="button" data-storage-select="${esc(host.id)}" aria-pressed="${host.id===select.value}" title="${esc(host.id)}"><span class="storage-machine-id">${esc(host.id)}</span><span class="storage-server-context">服务器缓存${warehouse?'<span class="storage-warehouse-badge">仓库</span>':''}</span></button>${overview?storageCapacityDetailHTML(overview.caches.find(value=>value.machine===host.id)):cacheGaugeHTML(host.id,row?.status,row?.plan,index)}<div class="storage-server-facts"><span>${summary.count===null?'释放预览待确认':summary.count?'待释放 '+summary.count+' 项 · '+amount(summary.bytes):'待释放 0 项'}</span><span>${pins===null?'保留状态待确认':'固定保留 '+pins+' 项'}</span></div></article>`;
    }).join('');
    applyCapacityGeometry(el);fitNames();
  }
  function render(){
    if(!allowed())return;
    const machine=select.value,row=telemetry.get(machine),budget=cacheBudget(row?.status,row?.plan),known=['known','high'].includes(budget.kind);
    const name=el.querySelector('[data-storage-machine]');name.textContent=machine;name.title=machine;
    el.querySelector('[data-storage-policy]').innerHTML=`<span>${budget.kind==='disabled'?'自动释放未开启':known?'自动释放已开启':'策略状态待确认'}</span>${known?`<span class="num">低水位 ${Math.round(budget.lowWater*100)}% · 高水位 ${Math.round(budget.highWater*100)}%</span>`:''}`;
    el.querySelector('[data-storage-preview]').innerHTML=cachePreviewHTML(machine,row?.plan)||'<h4>释放预览</h4><p>未提供释放候选</p>';
    el.querySelector('[data-storage-retention]').innerHTML=localVersions(machine).map(({item,v,local})=>`<details class="dataset-version-details storage-pin-row"><summary><span title="${esc(item.dataset)}">${esc(item.dataset)}</span><code title="${esc(v.version)}">${v.version.slice(0,12)}</code></summary><div class="storage-pin-owner">${esc(local.ownerLabel)}</div><div data-cache-pin-slot data-machine="${esc(machine)}" data-dataset="${esc(local.dataset)}" data-version="${esc(v.version)}"></div></details>`).join('')||'<p>没有已登记的保留对象</p>';
    const root=el.querySelector('[data-dataset-catalog]');
    root.innerHTML=localVersions(machine).map(({item,v,local})=>`<article class="dataset-card admin-storage-row v3-server"><div class="admin-storage-identity"><h3><code title="${esc(item.dataset)}">${esc(item.dataset)}</code></h3><code title="${esc(v.version)}">${v.version.slice(0,12)}</code></div><div class="dataset-volume num">${amount(v.bytes)}<small>${v.files===null?'文件数未知':v.files.toLocaleString('zh-CN')+' 个文件'}</small></div><div class="admin-storage-actions"><span>${states[local.state]||states.UNKNOWN}</span><span data-dataset-more-slot data-machine="${esc(machine)}" data-dataset="${esc(item.dataset)}" data-local-dataset="${esc(local.dataset)}" data-version="${esc(v.version)}" data-dataset-state="${esc(local.state)}"></span>${removals.canOpenFullDelete?.(item.dataset,v.version)===true?`<button class="button quiet" type="button" data-admin-full-delete="${esc(item.dataset)}" data-version="${esc(v.version)}">彻底删除…</button>`:''}</div></article>`).join('')||`<div class="empty">${catalog?.partial?'缓存状态待确认':'这台服务器没有已登记缓存'}</div>`;
    cache.render();cloud.controls();enrollment.sync();renderCards();renderUsers();renderTasks();
  }
  function renderUsers(){
    if(!allowed())return;
    members.sync();
  }
  function renderTasks(){
    if(!allowed())return;
    const status=el.querySelector('[data-storage-delete-capability]');status.textContent=catalog?.datasetDelete===1?'':catalog?.datasetDeleteKnown?'节点未启用彻底删除':'删除能力待确认';
    fullTasks.render();
  }
  async function load(refreshTelemetry=true){
    if(busy||!allowed()||!store.production||!select.value)return;
    busy=true;const expected=actor(),token=++epoch,machine=select.value,status=el.querySelector('[data-storage-status]');
    const current=()=>allowed()&&expected===actor()&&token===epoch;
    if(refreshTelemetry)readStorageOverview(store,{signal:lifecycle.signal}).then(value=>{if(current()){overview=adaptStorageOverview(value);renderCards();}}).catch(()=>{if(current()){overview=null;renderCards();}});
    el.querySelector('[data-storage-refresh]').disabled=true;select.disabled=true;status.textContent='查询中…';
    try{
      if(refreshTelemetry){
        pinStatus.clear();cache.reset();
        const hosts=machines().map(row=>row.id);
        for(let i=0;i<hosts.length;i+=3){
          const results=await Promise.all(hosts.slice(i,i+3).map(async host=>{
            const values=await Promise.allSettled([store.call('datasets.storage.status',{machine:host},{signal:lifecycle.signal}),store.call('datasets.storage.plan',{machine:host},{signal:lifecycle.signal})]);
            return {machine:host,status:values[0].status==='fulfilled'?values[0].value:null,plan:values[1].status==='fulfilled'?values[1].value:null};
          }));
          if(!current())return;for(const value of results)telemetry.set(value.machine,value);renderCards();
        }
      }
      const value=await read(machine);if(!current())return;catalog=value;render();status.textContent=value.partial?'部分服务器状态待确认':'';
    }catch(error){if(current()){catalog=null;el.querySelector('[data-dataset-catalog]').replaceChildren();status.textContent=error.message;}}
    finally{if(current()){busy=false;select.disabled=false;el.querySelector('[data-storage-refresh]').disabled=false;}}
  }
  el.addEventListener('change',event=>{if(event.target===select){cache.reset();catalog=null;load(false);}},{signal:lifecycle.signal});
  el.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled||!allowed())return;
    if(button.hasAttribute('data-storage-view')){const showingMembers=button.dataset.storageView==='members';servers.hidden=showingMembers;membersPanel.hidden=!showingMembers;el.querySelector('.admin-storage-controls>h3').textContent=showingMembers?'成员存储':'服务器存储';for(const tab of tabs.querySelectorAll('[role=tab]')){tab.setAttribute('aria-selected',String(tab===button));tab.tabIndex=tab===button?0:-1;}members.sync();if(showingMembers)void members.load();return;}
    if(button.hasAttribute('data-storage-refresh'))load();
    if(button.hasAttribute('data-storage-select')&&!busy&&machines().some(row=>row.id===button.dataset.storageSelect)&&select.value!==button.dataset.storageSelect){select.value=button.dataset.storageSelect;cache.reset();load(false);}
    if(button.hasAttribute('data-admin-full-delete')&&removals.canOpenFullDelete?.(button.dataset.adminFullDelete,button.dataset.version)===true)removals.openFullDelete(button.dataset.adminFullDelete,button.dataset.version);
  },{signal:lifecycle.signal});
  tabs.addEventListener('keydown',event=>{const current=event.target.closest('[role=tab]');if(!current||!allowed()||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const options=[...tabs.querySelectorAll('[role=tab]')],index=options.indexOf(current),next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowRight'?1:-1)+options.length)%options.length;options[next].focus();options[next].click();},{signal:lifecycle.signal});
  function destroy(){if(disposed)return;disposed=true;epoch++;lifecycle.abort();members?.destroy();fullTasks?.destroy();fitting?.disconnect();removals?.sync(false);cache?.reset();cloud?.reset();el.querySelectorAll('dialog[open]').forEach(node=>node.close());el.replaceChildren();}
  queueMicrotask(load);return {destroy,refresh:load};
}
