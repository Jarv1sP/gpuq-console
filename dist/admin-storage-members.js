import {serverIdHTML} from './workbench-ui.js';
import {transferBytes} from './data-route.js';
import {hasDatabaseOriginal} from './dataset-flow.js';
const hash=/^[a-f0-9]{64}$/,id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const username=/^[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}$/u;
const unknown='\u0000unknown',number=value=>Number.isSafeInteger(value)&&value>=0;
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const amount=value=>number(value)?transferBytes(value):'—';

// Contract pending: no inferred project size, owner, protocol or API request.
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
export function storageMemberRows(catalog){
  if(!Array.isArray(catalog?.datasets))return {rows:[],available:false,partial:true};
  const rows=new Map(),partial=catalog.partial===true;
  const rowFor=name=>{
    if(!rows.has(name))rows.set(name,{key:name===unknown?'@unknown':name,name:name===unknown?'所属未知':name,warehouse:new Map(),cache:new Map(),warehouseNames:new Set(),cacheNames:new Set(),warehouseUnknown:false,cacheUnknown:false,machines:new Map()});
    return rows.get(name);
  };
  const machineFor=(row,machine)=>{if(!row.machines.has(machine))row.machines.set(machine,{machine,warehouse:new Map(),cache:new Map(),warehouseNames:new Set(),warehouseUnknown:false,cacheUnknown:false});return row.machines.get(machine);};
  for(const item of catalog.datasets){
    if(!id.test(item?.dataset)||!Array.isArray(item.versions))continue;
    for(const registration of item.registrations||[])for(const owner of owners(registration.ownerLabel))rowFor(owner);
    for(const version of item.versions){
      if(!hash.test(version?.version))continue;
      for(const location of version.locations||[]){
        if(!id.test(location?.machine))continue;
        const proof=Boolean(location.storage&&hasDatabaseOriginal({...version,locations:[location]})),warehouse=location.warehouseReady===true||proof;
        const warehouseMachine=proof?location.storage.archiveMachine:location.machine,warehouseDataset=proof?location.storage.dataset:item.dataset;
        for(const owner of owners(location.ownerLabel)){
          const row=rowFor(owner),machine=machineFor(row,location.machine);
          if(!['READY','PREPARING','REGISTERED','STAGING','FAILED','NOT_LOCAL'].includes(location.state)){row.cacheUnknown=true;machine.cacheUnknown=true;}
          if(location.state==='READY'){
            const key=JSON.stringify([location.machine,location.dataset||item.dataset,version.version]),bytes=location.bytes===version.bytes?version.bytes:null;
            fact(row.cache,key,bytes);fact(machine.cache,key,bytes);row.cacheNames.add(item.dataset);
          }
          if(warehouse&&id.test(warehouseMachine)&&id.test(warehouseDataset)){
            const key=JSON.stringify([warehouseDataset,version.version]),target=machineFor(row,warehouseMachine);
            fact(row.warehouse,key,version.bytes);fact(target.warehouse,key,version.bytes);row.warehouseNames.add(warehouseDataset);target.warehouseNames.add(warehouseDataset);
          }else if(location.warehouseReady!==false){row.warehouseUnknown=true;machine.warehouseUnknown=true;}
        }
      }
    }
  }
  return {available:true,partial,rows:[...rows.values()].map(row=>({key:row.key,name:row.name,
    warehouseBytes:partial||row.warehouseUnknown?null:total(row.warehouse),warehouseDatasets:partial||row.warehouseUnknown?null:row.warehouseNames.size,containerBytes:null,
    cacheBytes:partial||row.cacheUnknown?null:total(row.cache),cacheDatasets:row.cacheNames.size,
    machines:[...row.machines.values()].sort((a,b)=>a.machine.localeCompare(b.machine)).map(machine=>({machine:machine.machine,containerBytes:null,cacheBytes:machine.cacheUnknown?null:total(machine.cache),warehouseBytes:machine.warehouseUnknown?null:total(machine.warehouse),warehouseDatasets:machine.warehouseUnknown?null:machine.warehouseNames.size}))
  })).sort((a,b)=>a.key==='@unknown'?1:b.key==='@unknown'?-1:(b.cacheBytes??-1)-(a.cacheBytes??-1)||a.name.localeCompare(b.name))};
}
function bar(row){
  const parts=[['warehouse',row.warehouseBytes],['project',row.containerBytes],['cache',row.cacheBytes]],sum=parts.reduce((value,[,bytes])=>value+(bytes??0),0);
  const label=`仓库 ${amount(row.warehouseBytes)} · 容器 ${amount(row.containerBytes)} · 缓存 ${amount(row.cacheBytes)}`;
  return `<span class="storage-member-bar" role="img" aria-label="${esc(label)}" title="${esc(label)}">${parts.map(([type,bytes])=>`<i class="${type}${bytes===null?' unknown':''}" ${bytes===null?'':`style="flex-grow:${sum?bytes/sum:0}"`}></i>`).join('')}</span>`;
}
export function memberStorageHTML(model,expanded=new Set()){
  if(!model.available)return '<p>未知</p>';
  if(!model.rows.length)return model.partial?'<p>未知</p>':'<p>暂无数据</p>';
  const counts=value=>value===null?'—':value;
  return `<table class="storage-member-table storage-user-table" role="table" aria-label="成员存储"><thead><tr role="row"><th scope="col">成员</th><th scope="col" class="num">仓库</th><th scope="col" class="num storage-member-hide">容器</th><th scope="col" class="num storage-member-hide">缓存</th><th scope="col" class="storage-member-hide"><span class="sr-only">占用比例</span></th></tr></thead><tbody>${model.rows.map((row,index)=>{
    const open=expanded.has(row.key),detail='storage-member-detail-'+index;
    return `<tr role="row" data-storage-member-row="${esc(row.key)}" class="${open?'open':''}"><td><button type="button" data-storage-member="${esc(row.key)}" aria-expanded="${open}" aria-controls="${detail}" title="${esc(row.name)}"><span class="storage-member-avatar" aria-hidden="true">${esc([...row.name][0])}</span><span>${esc(row.name)}</span></button></td><td class="num" data-member-size="warehouse" data-label="仓库">${amount(row.warehouseBytes)}</td><td class="num" data-member-size="container" data-label="容器">—</td><td class="num" data-member-size="cache" data-label="缓存" title="${row.cacheDatasets} 个数据集">${amount(row.cacheBytes)}</td><td class="storage-member-ratio">${bar(row)}</td></tr>${open?`<tr class="storage-member-detail" id="${detail}" role="row"><td colspan="5"><div class="storage-member-grid">${row.machines.map(machine=>`<div><b>${serverIdHTML(machine.machine)}</b><span>容器 — · 缓存 ${amount(machine.cacheBytes)}</span>${machine.warehouseDatasets||machine.warehouseDatasets===null?`<span>仓库 ${counts(machine.warehouseDatasets)} 个数据集 · ${amount(machine.warehouseBytes)}</span>`:''}</div>`).join('')}<div><b>仓库</b><span>${counts(row.warehouseDatasets)} 个数据集 · ${amount(row.warehouseBytes)}</span></div></div></td></tr>`:''}`;
  }).join('')}</tbody></table>`;
}
export function mountAdminStorageMembers(host,{store,catalog,signal}={}){
  const identity=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]),owner=identity(),expanded=new Set();let html='',disposed=false;
  const allowed=()=>!disposed&&!signal?.aborted&&store.principal?.role==='admin'&&owner===identity();
  function sync(){if(!allowed()){host.replaceChildren();return;}const model=storageMemberRows(catalog());const next=memberStorageHTML(model,expanded);if(html!==next){html=next;host.innerHTML=next;}}
  host.addEventListener('click',event=>{const row=event.target.closest('[data-storage-member-row]');if(!row||!host.contains(row)||!allowed())return;const key=row.dataset.storageMemberRow,focused=host.contains(document.activeElement)&&document.activeElement.hasAttribute('data-storage-member');expanded.has(key)?expanded.delete(key):expanded.add(key);sync();if(focused)[...host.querySelectorAll('[data-storage-member]')].find(node=>node.dataset.storageMember===key)?.focus();},{signal});
  const unsubscribe=store.onAuthChange?.(()=>{expanded.clear();html='';host.replaceChildren();});
  function destroy(){if(disposed)return;disposed=true;unsubscribe?.();host.replaceChildren();}
  signal?.addEventListener('abort',destroy,{once:true});sync();return {sync,destroy};
}
