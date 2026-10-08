import {serverIdHTML} from './workbench-ui.js';
import {transferBytes} from './data-route.js';
import {hasDatabaseOriginal,capacityCollectedTitle,storageReadingSkeletonHTML} from './dataset-flow.js';
import {storageDisplayHistory} from './dataset-catalog-model.js';
import {adaptStorageUsage} from './member-storage-model.js';
const hash=/^[a-f0-9]{64}$/,id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const username=/^[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}$/u;
const unknown='\u0000unknown',number=value=>Number.isSafeInteger(value)&&value>=0;
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const amount=value=>number(value)?transferBytes(value):'—';

// Finalized protocol: use actual allocated bytes, never shared-layer estimates.
export function adaptProjectUsage(raw){return typeof raw?.bytes==='number'&&number(raw.bytes)?raw.bytes:null;}
function owners(label){
  if(typeof label!=='string'||!/^(所属用户：|共享授权用户：)/.test(label))return [unknown];
  const names=label.replace(/^(所属用户：|共享授权用户：)/,'').split('、'),known=names.filter(name=>username.test(name));
  return [...new Set([...known,...(known.length===names.length?[]:[unknown])])];
}
function fact(map,key,bytes){
  const value=number(bytes)?bytes:null;
  if(!map.has(key))map.set(key,value);else if(map.get(key)!==value)map.set(key,null);
}
function total(map){const values=[...map.values()],sum=values.reduce((value,row)=>value+(row??0),0);return values.every(number)&&number(sum)?sum:null;}
// Physical/empty registrations and modern warehouse observations have
// separate authorities. A missing catalog must never fall back to list.
export const warehouseCatalog=catalog=>catalog&&Object.hasOwn(catalog,'warehouseCatalog')?catalog.warehouseCatalog:catalog;
export function storageMemberRows(catalog,usage=null,users=[]){
  const hasCatalog=Array.isArray(catalog?.datasets),hasUsage=usage?.protocol===1&&Array.isArray(usage.users);
  if(!hasCatalog&&!hasUsage)return {rows:[],available:false,partial:true};
  const source=warehouseCatalog(catalog),hasWarehouse=Array.isArray(source?.datasets),warehousePartial=!hasWarehouse||source.partial===true;
  const rows=new Map(),partial=!hasCatalog||catalog.partial===true;
  const rowFor=name=>{
    if(!rows.has(name))rows.set(name,{key:name===unknown?'@unknown':name,name:name===unknown?'所属未知':name,warehouse:new Map(),cache:new Map(),warehouseNames:new Set(),cacheNames:new Set(),warehouseUnknown:false,cacheUnknown:false,machines:new Map()});
    return rows.get(name);
  };
  const machineFor=(row,machine)=>{if(!row.machines.has(machine))row.machines.set(machine,{machine,warehouse:new Map(),cache:new Map(),warehouseNames:new Set(),warehouseUnknown:false,cacheUnknown:false});return row.machines.get(machine);};
  for(const item of catalog?.datasets||[]){
    if(!id.test(item?.dataset)||!Array.isArray(item.versions))continue;
    for(const registration of item.registrations||[])for(const owner of owners(registration.ownerLabel))rowFor(owner);
    for(const version of item.versions){
      if(!hash.test(version?.version))continue;
      for(const location of version.locations||[]){
        if(!id.test(location?.machine))continue;
        for(const owner of owners(location.ownerLabel)){
          const row=rowFor(owner),machine=machineFor(row,location.machine);
          if(!['READY','PREPARING','REGISTERED','STAGING','FAILED','NOT_LOCAL'].includes(location.state)){row.cacheUnknown=true;machine.cacheUnknown=true;}
          if(location.state==='READY'){
            const key=JSON.stringify([location.machine,location.dataset||item.dataset,version.version]),bytes=location.bytes===version.bytes?version.bytes:null;
            fact(row.cache,key,bytes);fact(machine.cache,key,bytes);row.cacheNames.add(item.dataset);
          }
          if(source!==catalog&&typeof location.warehouseReady!=='boolean'&&!hasDatabaseOriginal({...version,locations:[location]})){row.warehouseUnknown=true;machine.warehouseUnknown=true;}
        }
      }
    }
  }
  for(const item of source?.datasets||[])for(const version of item.versions||[])for(const location of version.locations||[]){
    if(!id.test(item?.dataset)||!hash.test(version?.version)||!id.test(location?.machine))continue;
    const proof=Boolean(location.storage&&hasDatabaseOriginal({...version,locations:[location]})),warehouse=location.warehouseReady===true||proof;
    const warehouseMachine=proof?location.storage.archiveMachine:location.machine,warehouseDataset=proof?location.storage.dataset:item.dataset;
    const bytes=Object.hasOwn(location,'contentBytes')?location.contentBytes:version.bytes;
    for(const owner of owners(location.ownerLabel??version.ownerLabel)){
      const row=rowFor(owner),machine=machineFor(row,location.machine);
      if(warehouse&&id.test(warehouseMachine)&&id.test(warehouseDataset)){
        const key=JSON.stringify([warehouseDataset,version.version]),target=machineFor(row,warehouseMachine);
        fact(row.warehouse,key,bytes);fact(target.warehouse,key,bytes);row.warehouseNames.add(warehouseDataset);target.warehouseNames.add(warehouseDataset);
      }else if(location.warehouseReady!==false){row.warehouseUnknown=true;machine.warehouseUnknown=true;}
    }
  }
  const result={available:true,partial,rows:[...rows.values()].map(row=>({key:row.key,name:row.name,
    warehouseBytes:warehousePartial||row.warehouseUnknown?null:total(row.warehouse),warehouseDatasets:warehousePartial||row.warehouseUnknown?null:row.warehouseNames.size,containerBytes:null,
    cacheBytes:partial||row.cacheUnknown?null:total(row.cache),cacheDatasets:row.cacheNames.size,
    machines:[...row.machines.values()].sort((a,b)=>a.machine.localeCompare(b.machine)).map(machine=>({machine:machine.machine,containerBytes:null,cacheBytes:machine.cacheUnknown?null:total(machine.cache),warehouseBytes:!hasWarehouse||machine.warehouseUnknown?null:total(machine.warehouse),warehouseDatasets:!hasWarehouse||machine.warehouseUnknown?null:machine.warehouseNames.size}))
  })).sort((a,b)=>a.key==='@unknown'?1:b.key==='@unknown'?-1:(b.cacheBytes??-1)-(a.cacheBytes??-1)||a.name.localeCompare(b.name))};
  for(const user of hasUsage?usage.users:[]){
    if(typeof user?.userId!=='string'||!Array.isArray(user.machines))continue;
    const account=users.find(row=>row.id===user.userId),value=adaptStorageUsage({protocol:1,machines:user.machines});
    let row=account?.username?result.rows.find(row=>row.key===account.username):null;
    if(!row){row={key:'@user:'+user.userId,name:user.label||account?.name||account?.username||user.userId,warehouseBytes:!warehousePartial?0:null,warehouseDatasets:!warehousePartial?0:null,cacheBytes:hasCatalog&&!partial?0:null,cacheDatasets:0,containerBytes:null,machines:[]};result.rows.push(row);}
    const totals=user.machines.map(machine=>value.totals.get(machine.machine));
    row.containerBytes=totals.length&&totals.every(number)&&number(totals.reduce((n,bytes)=>n+bytes,0))?totals.reduce((n,bytes)=>n+bytes,0):null;
    for(const machine of user.machines){
      if(!id.test(machine?.machine||''))continue;
      let target=row.machines.find(value=>value.machine===machine.machine);
      if(!target){target={machine:machine.machine,warehouseBytes:!warehousePartial?0:null,warehouseDatasets:!warehousePartial?0:null,cacheBytes:hasCatalog&&!partial?0:null,containerBytes:null};row.machines.push(target);}
      target.containerBytes=value.totals.get(machine.machine)??null;
    }
  }
  return result;
}
function bar(row){
  const parts=[['warehouse',row.warehouseBytes],['project',row.containerBytes],['cache',row.cacheBytes]],sum=parts.reduce((value,[,bytes])=>value+(bytes??0),0);
  const label=`仓库 ${amount(row.warehouseBytes)} · 容器 ${amount(row.containerBytes)} · 缓存 ${amount(row.cacheBytes)}`;
  return `<span class="storage-member-bar" role="img" aria-label="${esc(label)}" title="${esc(label)}">${parts.filter(([,bytes])=>bytes!==null&&bytes>0).map(([type,bytes])=>`<i class="${type}" style="flex-grow:${bytes/sum}"></i>`).join('')}</span>`;
}
export function memberStorageHTML(model,expanded=new Set()){
  if(model.loading)return '<div class="storage-members-loading" aria-label="读取中">'+storageReadingSkeletonHTML+'</div>';
  if(!model.available)return '<p>未知</p>';
  if(!model.rows.length)return model.partial?'<p>未知</p>':'<p>暂无数据</p>';
  const warehouseAmount=value=>value===null?'待确认':amount(value);
  const warehouseSummary=row=>row.warehouseDatasets===null?'待确认':`${row.warehouseDatasets} 个数据集 · ${warehouseAmount(row.warehouseBytes)}`;
  return `<table class="storage-member-table storage-user-table" role="table" aria-label="成员存储"><thead><tr role="row"><th scope="col">成员</th><th scope="col" class="num">仓库</th><th scope="col" class="num storage-member-hide">容器</th><th scope="col" class="num storage-member-hide">缓存</th><th scope="col" class="storage-member-hide"><span class="sr-only">占用比例</span></th></tr></thead><tbody>${model.rows.map((row,index)=>{
    const open=expanded.has(row.key),detail='storage-member-detail-'+index;
    return `<tr role="row" data-storage-member-row="${esc(row.key)}" class="${open?'open':''} ${row.stale?'storage-reading-stale':''}" title="${esc(capacityCollectedTitle(row.collectedAt))}"><td><button type="button" data-storage-member="${esc(row.key)}" aria-expanded="${open}" aria-controls="${detail}" title="${esc(row.name)}"><span class="storage-member-avatar" aria-hidden="true">${esc([...row.name][0])}</span><span>${esc(row.name)}</span></button></td><td class="num" data-member-size="warehouse" data-label="仓库">${warehouseAmount(row.warehouseBytes)}</td><td class="num" data-member-size="container" data-label="容器">${amount(row.containerBytes)}</td><td class="num" data-member-size="cache" data-label="缓存" title="${row.cacheDatasets} 个数据集">${amount(row.cacheBytes)}</td><td class="storage-member-ratio">${bar(row)}</td></tr>${open?`<tr class="storage-member-detail" id="${detail}" role="row"><td colspan="5"><div class="storage-member-grid">${row.machines.map(machine=>`<div class="${machine.stale?'storage-reading-stale':''}" title="${esc(capacityCollectedTitle(machine.collectedAt))}"><b>${serverIdHTML(machine.machine)}</b><span>容器 ${amount(machine.containerBytes)} · 缓存 ${amount(machine.cacheBytes)}</span>${machine.warehouseDatasets||machine.warehouseDatasets===null?`<span>仓库 ${warehouseSummary(machine)}</span>`:''}</div>`).join('')}<div><b>仓库</b><span>${warehouseSummary(row)}</span></div></div></td></tr>`:''}`;
  }).join('')}</tbody></table>`;
}
export function mountAdminStorageMembers(host,{store,catalog,signal}={}){
  const identity=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]),owner=identity(),expanded=new Set();let html='',disposed=false,usage=null,lastCatalog,lastUsage,expiryTimer;
  const memory=()=>storageDisplayHistory(store),fields=['warehouseBytes','warehouseDatasets','cacheBytes','containerBytes'];
  const allowed=()=>!disposed&&!signal?.aborted&&store.principal?.role==='admin'&&owner===identity();
  const machineKey=(key,machine)=>JSON.stringify([key,machine]);
  function sync(){
    const history=memory();if(!allowed()){host.replaceChildren();return;}
    const source=catalog(),model=storageMemberRows(source,usage,store.users||[]);
    for(const row of model.rows)if(row.key.startsWith('@user:')){const account=store.users?.find(user=>user.id===row.key.slice(6));if(account?.username)row.key=account.username;}
    const catalogChanged=source!==lastCatalog,usageChanged=usage!==lastUsage;
    if(catalogChanged||usageChanged){
      if(!source&&lastCatalog!==undefined){history.fail('members');history.fail('member-machines');}
      for(const row of model.rows){
        const user=usage?.users?.find(user=>store.users?.find(account=>account.id===user.userId)?.username===row.key||row.key==='@user:'+user.userId);
        const dates=(user?.machines||[]).map(machine=>machine.collectedAt).filter(Boolean),collectedAt=dates.sort()[0]??null;
        if(catalogChanged)history.observe('members',row.key,row,fields.filter(field=>field!=='containerBytes'),warehouseCatalog(source)?.checkedAt??source?.checkedAt??null);
        if(usageChanged)history.observe('members',row.key,row,['containerBytes'],collectedAt);
        for(const machine of row.machines){
          const key=machineKey(row.key,machine.machine);
          if(catalogChanged)history.observe('member-machines',key,machine,fields.filter(field=>field!=='containerBytes'),warehouseCatalog(source)?.checkedAt??source?.checkedAt??null);
          if(usageChanged)history.observe('member-machines',key,machine,['containerBytes'],user?.machines.find(value=>value.machine===machine.machine)?.collectedAt??null);
        }
      }
      lastCatalog=source;lastUsage=usage;
    }
    for(const key of history.keys('members'))if(!model.rows.some(row=>row.key===key))model.rows.push(history.project('members',key,null,fields));
    model.rows=model.rows.map(row=>{
      const display=history.project('members',row.key,row,fields),machines=new Map((row.machines||[]).map(machine=>[machine.machine,machine]));
      for(const key of history.keys('member-machines')){const [member,machine]=JSON.parse(key);if(member===row.key&&!machines.has(machine))machines.set(machine,{machine});}
      display.machines=[...machines.values()].map(machine=>history.project('member-machines',machineKey(row.key,machine.machine),machine,fields));return display;
    });
    model.available ||= model.rows.length>0;model.loading=!model.available&&history.loading('members');
    const next=memberStorageHTML(model,expanded);if(html!==next){html=next;host.innerHTML=next;}
    clearTimeout(expiryTimer);const delay=history.nextExpiry();if(delay!==null){expiryTimer=setTimeout(sync,delay+1);expiryTimer?.unref?.();}
  }
  async function load(){if(!allowed()||!store.production)return;memory().begin('members');sync();try{const result=await store.call('storage.usage.users',{},{signal});if(allowed()){usage=result;sync();}}catch{if(allowed()){usage=null;memory().fail('members');memory().fail('member-machines');sync();}}}
  host.addEventListener('click',event=>{const row=event.target.closest('[data-storage-member-row]');if(!row||!host.contains(row)||!allowed())return;const key=row.dataset.storageMemberRow,focused=host.contains(document.activeElement)&&document.activeElement.hasAttribute('data-storage-member');expanded.has(key)?expanded.delete(key):expanded.add(key);sync();if(focused)[...host.querySelectorAll('[data-storage-member]')].find(node=>node.dataset.storageMember===key)?.focus();},{signal});
  const unsubscribe=store.onAuthChange?.(()=>{clearTimeout(expiryTimer);memory();expanded.clear();html='';host.replaceChildren();});
  function destroy(){if(disposed)return;disposed=true;clearTimeout(expiryTimer);unsubscribe?.();host.replaceChildren();}
  signal?.addEventListener('abort',destroy,{once:true});sync();return {sync,load,destroy};
}
