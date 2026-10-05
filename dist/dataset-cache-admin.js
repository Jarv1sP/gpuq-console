import {cacheGaugeHTML,cachePreviewHTML,cacheBudgetInfo} from './dataset-flow.js';
import {maintenanceFor} from './maintenance-state.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key=target=>JSON.stringify([target.machine,target.dataset,target.version]);
const count=(result,target)=>result?.version?.dataset===target.dataset&&result.version.version===target.version&&Number.isSafeInteger(result.version.pinCount)&&result.version.pinCount>=0?result.version.pinCount:null;

// No localStorage: only receipts for pins explicitly created in this session.
export function cacheRetentionSession({call,allowed,uuid=()=>crypto.randomUUID()}){
  const records=new Map(),observed=new Map(),busy=new Set();let generation=0;
  const state=target=>({record:records.get(key(target))||null,status:observed.get(key(target))||null,busy:busy.has(key(target))});
  async function run(target,action){
    const id=key(target),epoch=generation;let writeIssued=false;
    const check=()=>{if(epoch!==generation||!allowed(target))throw Error('账号或服务器授权已改变，请重新查询。');};
    check();if(busy.has(id))throw Error('请等待当前确认完成。');busy.add(id);
    const request=async(operation,args)=>{check();const result=await call(operation,args);check();return result;};
    const query=async()=>{observed.delete(id);const result=await request('datasets.storage.status',target);if(count(result,target)===null)throw Error('保留状态未确认。');observed.set(id,result);return result;};
    const confirm=result=>{
      const record=records.get(id);if(!record)return;
      const n=count(result,target);
      if(record.intent==='pin'&&record.receipt?.pinned===true&&record.receipt.pinId===record.pinId&&n>=record.before+1)record.phase='retained';
      else if(record.intent==='unpin'&&typeof record.receipt?.unpinned==='boolean'&&n<=record.before-1)record.phase='released';
      else record.phase='uncertain';
    };
    try{
      if(action==='query'){const result=await query();if(records.has(id))confirm(result);return state(target);}
      let record=records.get(id);
      if(action==='retry'){
        if(!record||record.phase!=='uncertain')throw Error('没有待确认的本次请求。');
      }else{
        const before=await query();
        if(action==='pin'){
          if(before.version.state!=='READY')throw Error('缓存就绪后才能固定保留。');
          if(record&&record.phase!=='released')throw Error('请先确认本次保留结果。');
          record={pinId:'manual-'+uuid(),intent:'pin',before:count(before,target),phase:'uncertain',receipt:null};
        }else if(action==='unpin'){
          if(!record||record.phase!=='retained'||count(before,target)<1)throw Error('只能解除本会话已确认的固定保留。');
          record={...record,intent:'unpin',before:count(before,target),phase:'uncertain',receipt:null};
        }else throw Error('未知操作。');
        records.set(id,record);
      }
      // Lost replies stay uncertain. An explicit retry reuses this exact ID.
      record.phase='uncertain';record.receipt=null;
      writeIssued=true;
      record.receipt=await request('datasets.storage.'+record.intent,{...target,pinId:record.pinId});
      confirm(await query());return state(target);
    }catch(error){
      if(epoch===generation){
        observed.delete(id);
        // Read the same immutable reference after an uncertain write; a count
        // never replaces a missing pin receipt. No write is automatically retried.
        if(writeIssued&&allowed(target))try{confirm(await query());if(records.get(id)?.phase!=='uncertain')return state(target);}catch{}
      }
      throw error;
    }
    finally{if(epoch===generation)busy.delete(id);}
  }
  return {state,query:target=>run(target,'query'),pin:target=>run(target,'pin'),unpin:target=>run(target,'unpin'),retry:target=>run(target,'retry'),reset(){generation++;records.clear();observed.clear();busy.clear();}};
}

export function cacheAdminHTML(admin){
  return admin?`<section class="dataset-cache-admin"><header><h3>缓存容量 <small>仅管理员</small></h3>${cacheBudgetInfo()}</header><details id="dataset-cache-admin"><summary class="button">查看缓存策略</summary><div class="dataset-cache-toolbar"><button class="button" type="button" data-cache-refresh>刷新缓存策略</button><span data-cache-policy-status role="status">展开后查询服务器</span></div><div class="dataset-cache-gauges"></div><div class="dataset-cache-previews"></div></details></section>`:'';
}
export function datasetCacheAdminUI(store,section,toast){
  let identity='',generation=0,policyBusy=false;
  const account=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  const admin=()=>store.principal?.role==='admin';
  const allowed=target=>admin()&&(store.data?.machines||[]).some(row=>row.id===target.machine);
  const retention=cacheRetentionSession({call:(operation,args)=>store.call(operation,args),allowed});
  const target=slot=>({machine:slot.dataset.machine,dataset:slot.dataset.dataset,version:slot.dataset.version});
  const valid=(expected,epoch,node)=>account()===expected&&generation===epoch&&node.isConnected&&admin();
  function renderSlot(slot,message=''){
    if(!admin()){slot.replaceChildren();return;}
    const item=target(slot),value=retention.state(item),n=count(value.status,item),known=n!==null,record=value.record;
    const ready=known&&value.status.version.state==='READY',readBlocked=value.busy||!allowed(item),blocked=readBlocked||!!maintenanceFor(store.data?.operationalMaintenance,item.machine);
    const uncertain=record?.phase==='uncertain';
    slot.innerHTML=`<div class="dataset-pin-status" role="status">${known?'已固定保留 '+n+' 处':'保留状态待确认'}${uncertain?' · '+(record.intent==='pin'?'固定保留':'解除保留')+'结果未确认':''}</div><div class="file-actions"><button class="button" type="button" data-cache-retention="query" ${readBlocked?'disabled':''}>重新查询</button>${!record||record.phase==='released'?`<button class="button" type="button" data-cache-retention="pin" ${!ready||blocked?'disabled':''}>固定保留</button>`:record.phase==='retained'?`<button class="button" type="button" data-cache-retention="unpin" ${!known||blocked?'disabled':''}>解除本次保留</button>`:`<button class="button" type="button" data-cache-retention="retry" ${blocked?'disabled':''}>用同一请求重试</button>`}</div>${message?`<p class="form-error" role="status">${esc(message)}</p>`:''}`;
  }
  async function querySlot(slot){
    if(!admin()||!slot.isConnected)return;
    const expected=account(),epoch=generation,item=target(slot);
    const pending=retention.query(item);renderSlot(slot);
    try{await pending;if(valid(expected,epoch,slot))renderSlot(slot);}catch(error){if(valid(expected,epoch,slot))renderSlot(slot,error.message);}
  }
  async function loadPolicy(){
    const panel=section.querySelector('#dataset-cache-admin');if(!admin()||!panel?.open||policyBusy)return;
    const expected=account(),epoch=generation,machines=(store.data?.machines||[]).map(row=>row.id),ids=JSON.stringify(machines);
    const current=()=>valid(expected,epoch,panel)&&JSON.stringify((store.data?.machines||[]).map(row=>row.id))===ids;
    policyBusy=true;panel.querySelector('[data-cache-refresh]').disabled=true;panel.querySelector('[data-cache-policy-status]').textContent='查询中…';panel.querySelector('.dataset-cache-gauges').replaceChildren();panel.querySelector('.dataset-cache-previews').replaceChildren();
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
    if(button.hasAttribute('data-cache-refresh')){loadPolicy();return;}
    const action=button.dataset.cacheRetention,slot=button.closest('[data-cache-pin-slot]');if(!['query','pin','unpin','retry'].includes(action)||!slot||!allowed(target(slot)))return;
    if(action==='unpin'&&!globalThis.confirm('解除本次固定保留？'))return;
    const expected=account(),epoch=generation;
    const pending=retention[action](target(slot));renderSlot(slot);
    try{await pending;if(valid(expected,epoch,slot))renderSlot(slot);}catch(error){if(valid(expected,epoch,slot)){renderSlot(slot,error.message);toast(error.message);}}
  });
  const reset=()=>{generation++;identity='';policyBusy=false;retention.reset();};
  store.onAuthChange?.(reset);
  return {reset,render(){const next=JSON.stringify([account(),(store.data?.machines||[]).map(row=>row.id)]);if(next!==identity){reset();identity=next;}for(const slot of section.querySelectorAll('[data-cache-pin-slot]')){if(!admin())slot.replaceChildren();else if(slot.closest('details')?.open)querySlot(slot);}const panel=section.querySelector('#dataset-cache-admin');if(panel?.open)loadPolicy();}};
}
