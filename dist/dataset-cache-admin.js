import {cacheGaugeHTML,cachePreviewHTML,cacheBudgetInfo} from './dataset-flow.js';
import {maintenanceFor} from './maintenance-state.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key=target=>JSON.stringify([target.machine,target.dataset,target.version]);
const count=(result,target)=>result?.version?.dataset===target.dataset&&result.version.version===target.version&&Number.isSafeInteger(result.version.pinCount)&&result.version.pinCount>=0?result.version.pinCount:null;

import {cacheRetentionSession} from './manual-pin-state.js';
export {cacheRetentionSession} from './manual-pin-state.js';

export function cacheAdminHTML(admin){
  return admin?`<section class="dataset-cache-admin"><header><h3>缓存容量 <small>仅管理员</small></h3>${cacheBudgetInfo()}</header><details id="dataset-cache-admin"><summary class="button">查看缓存策略</summary><div class="dataset-cache-toolbar"><button class="button" type="button" data-cache-refresh>刷新缓存策略</button><span data-cache-policy-status role="status">展开后查询服务器</span></div><div class="dataset-cache-gauges"></div><div class="dataset-cache-previews"></div></details></section>`:'';
}
export function datasetCacheAdminUI(store,section,toast){
  let identity='',generation=0,policyBusy=false,policyLoaded=false;const queried=new Set();
  const account=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  const admin=()=>store.principal?.role==='admin';
  const visible=()=>!document.hidden&&!section.hidden&&(!document.body.dataset.room||document.body.dataset.room==='datasets');
  const allowed=target=>admin()&&visible()&&(store.data?.machines||[]).some(row=>row.id===target.machine);
  const retention=cacheRetentionSession({call:(operation,args)=>store.call(operation,args),allowed,identity:()=>admin()?store.principal.userId:null});
  const target=slot=>({machine:slot.dataset.machine,dataset:slot.dataset.dataset,version:slot.dataset.version});
  const valid=(expected,epoch,node)=>account()===expected&&generation===epoch&&node.isConnected&&admin()&&visible();
  function renderSlot(slot,message=''){
    if(!admin()){slot.replaceChildren();return;}
    const item=target(slot),value=retention.state(item),n=count(value.status,item),known=n!==null,record=value.record;
    const ready=known&&value.status.version.state==='READY'&&value.status.version.manualPinProtocol===1,readBlocked=value.busy||!allowed(item),blocked=readBlocked||!!value.error||!!maintenanceFor(store.data?.operationalMaintenance,item.machine);
    const uncertain=record?.phase==='uncertain',proof=value.status?.version.manualPin;
    const retryKnown=uncertain&&proof?.pinId===record.pinId&&proof.owner===store.principal.userId&&typeof proof.present==='boolean';
    slot.innerHTML=`<div class="dataset-pin-status" role="status">${known?'已固定保留 '+n+' 处':'保留状态待确认'}${uncertain?' · '+(record.intent==='pin'?'固定保留':'解除保留')+'结果未确认':''}</div><div class="file-actions"><button class="button" type="button" data-cache-retention="query" ${readBlocked?'disabled':''}>重新查询</button>${!record||record.phase==='released'?`<button class="button" type="button" data-cache-retention="pin" ${!ready||blocked?'disabled':''}>固定保留</button>`:record.phase==='retained'?`<button class="button" type="button" data-cache-retention="unpin" ${!known||blocked?'disabled':''}>解除本人保留</button>`:`<button class="button" type="button" data-cache-retention="retry" ${!retryKnown||blocked?'disabled':''}>${record.intent==='pin'?'恢复原请求保留':'用原请求解除保留'}</button>`}</div>${message||value.error?`<p class="form-error" role="status">${esc(message||value.error)}</p>`:''}`;
  }
  async function querySlot(slot,explicit=false){
    if(!admin()||!visible()||!slot.isConnected)return;
    const item=target(slot),id=key(item);if(retention.state(item).busy||!explicit&&queried.has(id))return;queried.add(id);
    const expected=account(),epoch=generation;
    const pending=retention.query(item);renderSlot(slot);
    try{await pending;if(valid(expected,epoch,slot))renderSlot(slot);}catch(error){if(valid(expected,epoch,slot))renderSlot(slot,error.message);}
  }
  async function loadPolicy(explicit=false){
    const panel=section.querySelector('#dataset-cache-admin');if(!admin()||!visible()||!panel?.open||policyBusy||!explicit&&policyLoaded)return;
    const expected=account(),epoch=generation,machines=(store.data?.machines||[]).map(row=>row.id),ids=JSON.stringify(machines);
    const current=()=>valid(expected,epoch,panel)&&JSON.stringify((store.data?.machines||[]).map(row=>row.id))===ids;
    policyBusy=true;policyLoaded=true;panel.querySelector('[data-cache-refresh]').disabled=true;panel.querySelector('[data-cache-policy-status]').textContent='查询中…';panel.querySelector('.dataset-cache-gauges').replaceChildren();panel.querySelector('.dataset-cache-previews').replaceChildren();
    try{
      const rows=await Promise.all(machines.map(async machine=>{const results=await Promise.allSettled([store.call('datasets.storage.status',{machine}),store.call('datasets.storage.plan',{machine})]);return {machine,status:results[0].status==='fulfilled'?results[0].value:null,plan:results[1].status==='fulfilled'?results[1].value:null};}));
      if(!current())return;
      panel.querySelector('.dataset-cache-gauges').innerHTML=rows.map((row,i)=>cacheGaugeHTML(row.machine,row.status,row.plan,i)).join('');
      panel.querySelector('.dataset-cache-previews').innerHTML=rows.map(row=>cachePreviewHTML(row.machine,row.plan)).join('');
      panel.querySelector('[data-cache-policy-status]').textContent=rows.some(row=>!row.status||!row.plan)?'部分状态待确认':machines.length?'已查询':'没有已授权服务器';
    }finally{if(current()){policyBusy=false;panel.querySelector('[data-cache-refresh]').disabled=false;}}
  }
  section.addEventListener('toggle',event=>{
    if(event.target.id==='dataset-cache-admin'&&event.target.open)loadPolicy();
    if(event.target.matches('.dataset-version-details')&&event.target.open){const slot=event.target.querySelector('[data-cache-pin-slot]');if(slot)querySlot(slot);}
  },true);
  section.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.hasAttribute('data-cache-refresh')){loadPolicy(true);return;}
    const action=button.dataset.cacheRetention,slot=button.closest('[data-cache-pin-slot]');if(!['query','pin','unpin','retry'].includes(action)||!slot||!allowed(target(slot)))return;
    if(action==='query'){querySlot(slot,true);return;}
    if(action==='unpin'&&!globalThis.confirm('解除当前账号的这次固定保留？'))return;
    if(action==='retry'&&!globalThis.confirm('按原请求再次执行？恢复保留可能重新创建已被解除的本人保留，不是只读查询。'))return;
    const expected=account(),epoch=generation;
    const pending=retention[action](target(slot));renderSlot(slot);
    try{await pending;if(valid(expected,epoch,slot))renderSlot(slot);}catch(error){if(valid(expected,epoch,slot)){renderSlot(slot,error.message);toast(error.message);}}
  });
  const reset=()=>{generation++;identity='';policyBusy=false;policyLoaded=false;queried.clear();retention.reset();};
  store.onAuthChange?.(reset);
  new MutationObserver(()=>{if(!visible())reset();}).observe(document.body,{attributes:true,attributeFilter:['data-room']});
  document.addEventListener('visibilitychange',()=>{if(!visible())reset();});
  return {reset,render(){const next=JSON.stringify([account(),(store.data?.machines||[]).map(row=>row.id)]);if(next!==identity){reset();identity=next;}for(const slot of section.querySelectorAll('[data-cache-pin-slot]')){renderSlot(slot);if(slot.closest('details')?.open)querySlot(slot);}const panel=section.querySelector('#dataset-cache-admin');if(panel?.open)loadPolicy();}};
}
