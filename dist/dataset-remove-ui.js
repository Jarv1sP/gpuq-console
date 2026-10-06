import {serverIdHTML} from './workbench-ui.js';
import {copyHelp} from './copy-help-ui.js';
import {fadeDialog} from './motion-ui.js';
import {maintenanceFor} from './maintenance-state.js';

const hash=/^[a-f0-9]{64}$/,datasetID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unresolved=row=>['SUBMITTING','UNREGISTERING','UNKNOWN'].includes(row.state);
const overlaps=(row,target)=>row.machine===target.machine&&row.dataset===target.dataset&&(!row.version||!target.version||row.version===target.version);
export const removalStorageKey=userId=>'stargate.dataset-removals.v1:'+encodeURIComponent(userId);
export function removalTarget(value){
  if(!value||typeof value.machine!=='string'||!value.machine||typeof value.dataset!=='string'||!datasetID.test(value.dataset)||value.version!=null&&(typeof value.version!=='string'||!hash.test(value.version)))throw Error('删除目标无效。');
  return {machine:value.machine,dataset:value.dataset,version:value.version??null,...(typeof value.catalogDataset==='string'&&datasetID.test(value.catalogDataset)?{catalogDataset:value.catalogDataset}:{})};
}

// Catalog facts are a preview only. The Portal repeats the proof from fresh
// trusted node reads under its durable deletion guard before any dispatch.
export function removalPreservation(target,versions,machines,{partial=false}={}){
  const known=new Set(machines.map(machine=>machine.id));
  const items=(versions||[]).map(version=>{
    const locations=version.locations||[],local=locations.find(row=>row.machine===target.machine),storage=local?.storage||version.storage;
    const pending=local?.removalPending===true;
    const archive=storage?.phase==='ARCHIVED'&&storage.originalRetained===true&&known.has(storage.archiveMachine)&&storage.archiveMachine!==target.machine&&
      !locations.some(row=>row.machine===storage.archiveMachine&&row.removalPending===true);
    const copies=[...new Set(locations.filter(row=>row.machine!==target.machine&&known.has(row.machine)&&row.state==='READY'&&row.removalPending!==true).map(row=>row.machine))];
    return {version:version.version,pending,kind:archive?'archive':copies.length?'replicas':'unproven',machines:archive?[storage.archiveMachine]:copies};
  });
  return {items,pending:items.some(item=>item.pending),allowed:!partial&&items.length>0&&items.every(item=>!item.pending&&item.kind!=='unproven')};
}

// Intent is persisted before dispatch. The node owns operationId; a missing
// receipt cannot be reconstructed from the target or treated as safe to retry.
export function createDatasetRemovals({principal,machines,call,storage,changed=()=>{},completed=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
  let owner=null,visible=false,timer=null,generation=0;
  const busy=new Set();
  const save=context=>{try{storage?.setItem(removalStorageKey(context.id),JSON.stringify(context.rows));context.saved=!!storage;}catch{context.saved=false;}};
  function stop(){if(timer!==null)clearTimer(timer);timer=null;}
  function sync(show=visible){
    visible=show;const who=principal(),id=who?.role==='admin'?who.userId:null;
    if(id!==owner?.id){
      stop();generation++;busy.clear();owner=null;
      if(id){let rows=[];try{rows=JSON.parse(storage?.getItem(removalStorageKey(id))||'[]');}catch{}
        owner={id,saved:!!storage,rows:Array.isArray(rows)?rows.filter(row=>{
          try{removalTarget(row);return typeof row.id==='string'&&(!row.operationId||hash.test(row.operationId))&&['SUBMITTING','UNREGISTERING','UNKNOWN','FAILED','BLOCKED','UNREGISTERED'].includes(row.state);}catch{return false;}
        }).map(row=>({...row,state:row.state==='SUBMITTING'?'UNKNOWN':row.state,nextAt:now()+2000,attempt:0,resumeCheck:!!row.operationId&&row.state==='UNKNOWN'})):[]};
      }
    }
    if(!visible)stop();else arm();return owner?.rows||[];
  }
  function active(context,stamp){return owner===context&&generation===stamp&&principal()?.role==='admin'&&principal()?.userId===context.id;}
  function notify(context){save(context);if(owner===context)changed();arm();}
  function arm(){
    stop();if(!visible||!owner||principal()?.role!=='admin')return;
    const rows=owner.rows.filter(row=>(row.state==='UNREGISTERING'||row.resumeCheck)&&row.operationId&&!busy.has(row));if(!rows.length)return;
    const delay=Math.max(0,Math.min(...rows.map(row=>row.nextAt))-now());
    timer=setTimer(()=>{timer=null;const due=owner?.rows.filter(row=>(row.state==='UNREGISTERING'||row.resumeCheck)&&row.nextAt<=now())||[];for(const row of due)query(row.id);},delay);
  }
  function accept(context,row,result){
    if(row.discarded)return;
    const matching=result&&hash.test(result.operationId)&&(!row.operationId||result.operationId===row.operationId)&&
      (result.dataset===undefined||result.dataset===row.dataset)&&(result.version===undefined||result.version===row.version);
    if(!matching){row.state='UNKNOWN';row.error='删除回执未能核对，请查询原操作编号。';return;}
    row.operationId=result.operationId;row.error=result.error||'';
    if(result.state==='UNREGISTERED'&&typeof result.unregistered==='boolean'){
      row.state='UNREGISTERED';row.unregistered=result.unregistered;
    }else if(result.state==='UNREGISTERING'){
      row.state='UNREGISTERING';row.nextAt=now()+[2000,5000,10000][Math.min(row.attempt||0,2)];row.attempt=(row.attempt||0)+1;
    }else row.state=result.state==='FAILED'?'FAILED':'UNKNOWN';
  }
  async function submit(value){
    sync();if(!owner)throw Error('只有管理员可以删除数据集。');const target=removalTarget(value),context=owner,stamp=generation;
    if(!machines().some(machine=>machine.id===target.machine))throw Error('这台服务器未授权。');
    if(context.rows.some(row=>unresolved(row)&&overlaps(row,target)))throw Error('这次删除尚未确认，请先查询原操作。');
    const row={...target,id:crypto.randomUUID(),operationId:null,state:'SUBMITTING',startedAt:now(),attempt:0,error:''};
    context.rows.push(row);busy.add(row);notify(context);
    try{accept(context,row,await call('datasets.unregister',{machine:target.machine,dataset:target.dataset,...(target.version?{version:target.version}:{})}));}
    // The portal can wrap a bridge timeout as HTTP 400. An HTTP error does not
    // prove the node rejected cleanup; only the local pre-dispatch gate does.
    catch(error){if(!row.discarded){row.state=['LAST_COPY_UNPROVEN','DATASET_REMOVAL_PENDING'].includes(error.code)&&error.status===409?'BLOCKED':error.code==='MAINTENANCE_ACTIVE'?'FAILED':'UNKNOWN';row.error=error.message;row.blockReason=row.state==='BLOCKED'?error.code:null;}}
    finally{busy.delete(row);save(context);if(active(context,stamp)&&!row.discarded){changed();if(row.state==='UNREGISTERED')completed({...row});arm();}}
    return {...row};
  }
  async function query(id,originalId){
    sync();const context=owner,row=context?.rows.find(row=>row.id===id),stamp=generation;if(!row||busy.has(row))return;
    if(originalId!==undefined){if(!hash.test(originalId)||row.operationId&&row.operationId!==originalId)throw Error('请填写 64 位原操作编号。');row.operationId=originalId;save(context);}
    if(!row.operationId)throw Error('请先在服务器操作记录里找到原编号。');
    row.resumeCheck=false;
    if(!machines().some(machine=>machine.id===row.machine)){row.state='UNKNOWN';row.error='服务器授权已改变，请先确认权限。';notify(context);return;}
    busy.add(row);if(active(context,stamp))changed();
    const wasComplete=row.state==='UNREGISTERED';
    try{accept(context,row,await call('datasets.status',{machine:row.machine,operationId:row.operationId}));}
    catch(error){row.state='UNKNOWN';row.error=error.message;}
    finally{busy.delete(row);save(context);if(active(context,stamp)&&!row.discarded){changed();if(!wasComplete&&row.state==='UNREGISTERED')completed({...row});arm();}}
    return {...row};
  }
  function abandon(id){sync();const row=owner?.rows.find(row=>row.id===id);if(!row||row.state!=='UNKNOWN'||busy.has(row))throw Error('这条记录现在不能放弃。');row.discarded=true;owner.rows.splice(owner.rows.indexOf(row),1);notify(owner);}
  function dismiss(id){sync();const row=owner?.rows.find(row=>row.id===id);if(!row||row.state!=='BLOCKED'||busy.has(row))throw Error('只有已确认未派发的记录可以移除。');owner.rows.splice(owner.rows.indexOf(row),1);notify(owner);}
  return {sync,submit,query,abandon,dismiss,stop,get rows(){return owner?.rows||[];},get saved(){return owner?.saved??true;},isBusy:id=>busy.has(owner?.rows.find(row=>row.id===id)),blocked:value=>owner?.rows.some(row=>unresolved(row)&&overlaps(row,value))||false};
}

export function datasetRemoveUI(store,section,toast,{reload}={}){
  let storage;try{storage=globalThis.localStorage;}catch{}
  let dialog=null,confirmation=null,serial=0,updating=false;
  const originals=new WeakMap();
  const resolving=new WeakSet();
  const localReferences=new Map();
  const api=createDatasetRemovals({principal:()=>store.principal,machines:()=>store.data?.machines||[],call:(...args)=>store.call(...args),storage,changed:update,completed:row=>{
    toast(row.unregistered?'已从 '+row.machine+' 删除':'这台服务器原本没有此登记。');if(document.body.dataset.room==='datasets')reload?.();
  }});
  if(!document.querySelector('link[data-dataset-remove-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/dataset-remove.css';link.dataset.datasetRemoveStyle='';document.head.append(link);}
  const admin=()=>store.principal?.role==='admin',currentMachine=()=>section.querySelector('[name=dataset-machine]')?.value;
  const targetFor=card=>{
    const slot=card.querySelector('[data-dataset-more-slot]'),action=card.querySelector('[data-use-dataset],[data-prepare-dataset]');if(!slot&&!action)return null;
    const logical=slot?.dataset.dataset||action.dataset.useDataset||action.dataset.prepareDataset,machine=slot?.dataset.machine||card.querySelector('.dataset-location.dataset-target')?.dataset.machine||currentMachine(),version=slot?.dataset.version||action.dataset.version;
    const known=localReferences.get(JSON.stringify([machine,logical,version]))||api.rows.find(row=>row.machine===machine&&row.catalogDataset===logical&&(!row.version||row.version===version))?.dataset;
    return removalTarget({machine,dataset:slot?.dataset.localDataset||known||logical,version,catalogDataset:logical});
  };
  async function resolveTarget(card,whole){
    const target=targetFor(card),identity=JSON.stringify([store.principal,store.authGeneration]);
    if(target.machine!==currentMachine())throw Error('请等所选服务器的目录更新后再删除。');
    // A catalog's logical training name may refer to a differently named local
    // registration. Revalidate the actual selected-node name before confirming.
    const catalog=await store.call('datasets.catalog',{machine:target.machine});
    if(identity!==JSON.stringify([store.principal,store.authGeneration])||currentMachine()!==target.machine||!card.isConnected)return null;
    const item=catalog.datasets?.find(item=>item.dataset===target.catalogDataset),versions=whole?item?.versions:item?.versions?.filter(row=>row.version===target.version);
    const references=[...new Set((versions||[]).flatMap(row=>(row.locations||[]).filter(location=>location.machine===target.machine).map(location=>location.dataset)).filter(value=>typeof value==='string'&&datasetID.test(value)))];
    if(references.length!==1)throw Error(references.length?'请先核对这台服务器的多个登记名称。':'这台服务器没有此登记，请刷新目录。');
    for(const version of versions||[])localReferences.set(JSON.stringify([target.machine,target.catalogDataset,version.version]),references[0]);
    const resolved={...target,dataset:references[0],version:whole?null:target.version};
    return {target:resolved,preservation:removalPreservation(resolved,(versions||[]).filter(version=>version.locations?.some(location=>location.machine===target.machine&&location.dataset===references[0])),store.data?.machines||[],{partial:catalog.partial===true})};
  }
  const label=row=>row.state==='SUBMITTING'||row.state==='UNREGISTERING'?'删除中':row.state==='FAILED'?'删除失败':row.state==='BLOCKED'?'暂不能删除':row.operationId?'删除结果未确认':'删除请求结果未确认';
  const stateHTML=row=>`<span class="st ${row.state==='SUBMITTING'||row.state==='UNREGISTERING'?'st-cancel':row.state==='FAILED'?'st-err':'st-unk'}"><span class="g" aria-hidden="true"></span>${label(row)}</span>`;
  function ensureDialog(){
    if(dialog?.isConnected)return;dialog=document.createElement('dialog');dialog.id='dataset-remove-dialog';dialog.className='modal dataset-remove-dialog';dialog.setAttribute('aria-labelledby','dataset-remove-title');section.append(dialog);
    dialog.addEventListener('close',()=>{confirmation=null;});
    dialog.addEventListener('input',()=>{const button=dialog.querySelector('[data-remove-confirm]');if(button)button.disabled=!confirmation?.preservation?.allowed||confirmation?.whole&&dialog.querySelector('[name=remove-name]')?.value!==(confirmation.target.catalogDataset||confirmation.target.dataset);});
    dialog.addEventListener('click',event=>{if(event.target.closest('[data-remove-close]'))dialog.close();});
    dialog.addEventListener('submit',async event=>{
      event.preventDefault();const intent=confirmation;if(!intent||!admin()||intent.userId!==store.principal.userId)return;
      if(intent.abandon){try{api.abandon(intent.id);dialog.close();}catch(error){toast(error.message);}return;}
      if(!intent.preservation?.allowed||api.blocked(intent.target))return;
      if(intent.whole&&dialog.querySelector('[name=remove-name]').value!==(intent.target.catalogDataset||intent.target.dataset))return;
      dialog.close();try{await api.submit(intent.target);}catch(error){toast(error.message);}update();
    });
  }
  function confirmRemove(target,whole,preservation){
    ensureDialog();confirmation={target:whole?{...target,version:null}:target,whole,preservation,userId:store.principal.userId};
    const retained=item=>item.kind==='archive'?`数据库原件（${serverIdHTML(item.machines[0])}）`:item.kind==='replicas'?`其他服务器上的完整副本：${item.machines.map(machine=>serverIdHTML(machine)).join('、')}`:'完整副本尚未确认';
    const facts=preservation.items.map(item=>`${whole?`<small title="${esc(item.version)}">${esc(item.version.slice(0,12))}</small>`:''}<span>${retained(item)}</span>`).join('');
    const blocked=!preservation.allowed?`<p class="dataset-remove-blocked">${preservation.pending?'这台服务器上的删除结果待确认':'这可能是最后一份完整数据，暂不能按机器删除'} ${copyHelp('暂不能删除',preservation.pending?'先查询原操作，不能重复发起删除。':'节点更新后可用「彻底删除」（7 天内可恢复）。')}</p>`:'';
    dialog.innerHTML=`<form><header class="modal-head"><div class="copy-caption"><h2 id="dataset-remove-title">${whole?'删除整个数据集？':'删除此版本？'}</h2>${copyHelp('删除范围','只删除所选服务器的缓存和登记。删除前会重新确认还有完整副本，正在训练或固定保留的版本会被拒绝。')}</div><button class="button quiet" type="button" data-remove-close aria-label="关闭删除确认">关闭</button></header><dl class="dataset-remove-facts"><div><dt>服务器</dt><dd>${serverIdHTML(target.machine)}</dd></div><div><dt>数据集</dt><dd><code>${esc(target.dataset)}</code>${whole?'<small>全部版本</small>':`<small title="${esc(target.version)}">${esc(target.version.slice(0,12))}</small>`}</dd></div><div><dt>删除</dt><dd>缓存和登记</dd></div><div><dt>保留</dt><dd>${facts}</dd></div></dl>${blocked}${whole?`<label class="field">输入数据集名称 <code>${esc(target.dataset)}</code><input name="remove-name" required autocomplete="off" spellcheck="false" aria-label="输入数据集名称"></label>`:''}<footer class="modal-actions"><button class="button" type="button" data-remove-close>取消</button><button class="button danger" type="submit" data-remove-confirm ${whole||!preservation.allowed?'disabled':''}>删除</button></footer></form>`;
    if(target.catalogDataset&&target.catalogDataset!==target.dataset){dialog.querySelector('.dataset-remove-facts>div:nth-child(2) dd').prepend(document.createTextNode(target.catalogDataset+' · 登记名 '));if(whole){const field=dialog.querySelector('.field');field.querySelector('code').textContent=target.catalogDataset;}}
    dialog.showModal();fadeDialog(dialog);
  }
  function confirmAbandon(id){
    ensureDialog();confirmation={abandon:true,id,userId:store.principal.userId};dialog.innerHTML='<form><header class="modal-head"><h2 id="dataset-remove-title">放弃未确认记录？</h2></header><p>先确认服务器没有这次操作；再次删除可能重复执行。</p><footer class="modal-actions"><button class="button" type="button" data-remove-close>保留记录</button><button class="button danger" type="submit">放弃记录</button></footer></form>';dialog.showModal();fadeDialog(dialog);
  }
  function update(){
    if(updating)return;updating=true;
    try{
      const visible=!document.hidden&&!section.hidden&&document.body.dataset.room==='datasets';api.sync(visible);
      if(section.hidden||document.body.dataset.room!=='datasets')dialog?.close();
      if(!admin()){dialog?.close();section.querySelectorAll('[data-remove-owned]').forEach(node=>node.remove());return;}
      const catalog=section.querySelector('#dataset-catalog');if(!catalog)return;
      for(const card of catalog.querySelectorAll('.dataset-card')){
        let target;try{target=targetFor(card);}catch{continue;}if(!target)continue;
        let more=card.querySelector('.dataset-remove-more');
        if(!more){
          const id='dataset-remove-menu-'+(++serial);more=document.createElement('div');more.className='dataset-remove-more';more.dataset.removeOwned='';
          more.innerHTML=`<button class="button quiet" type="button" data-remove-more popovertarget="${id}" aria-haspopup="menu">更多</button><div class="dataset-remove-options" id="${id}" popover="auto" role="menu"><button class="button danger" type="button" data-remove-version role="menuitem">从 ${serverIdHTML(target.machine)} 删除此版本</button><button class="button danger" type="button" data-remove-dataset role="menuitem">从 ${serverIdHTML(target.machine)} 删除整个数据集</button></div>`;
          (card.querySelector('[data-dataset-more-slot]')||card.querySelector('.dataset-card-heading')).append(more);
        }
        const blocked=api.blocked(target),maintenance=maintenanceFor(store.data?.operationalMaintenance,target.machine);
        for(const button of more.querySelectorAll('[data-remove-version],[data-remove-dataset]'))button.disabled=blocked||!!maintenance||resolving.has(card)||target.machine!==currentMachine()||api.blocked({...target,version:null})&&button.hasAttribute('data-remove-dataset');
        const actions=card.querySelector('.dataset-actions-cell.dataset-target');
        for(const button of actions?.querySelectorAll('[data-use-dataset],[data-prepare-dataset]')||[]){if(blocked){if(!originals.has(button))originals.set(button,button.disabled);button.disabled=true;}else if(originals.has(button)){button.disabled=originals.get(button)||!!maintenance||!!section.querySelector('#datasets-refresh')?.disabled;originals.delete(button);}}
        const pending=api.rows.find(row=>unresolved(row)&&overlaps(row,target))||api.rows.findLast(row=>['FAILED','BLOCKED'].includes(row.state)&&overlaps(row,target));let status=card.querySelector('.dataset-removal-state');
        if(pending){if(!status){status=document.createElement('div');status.className='dataset-removal-state';status.dataset.removeOwned='';(actions||card).append(status);}const html=stateHTML(pending);if(status.innerHTML!==html)status.innerHTML=html;}else status?.remove();
      }
      let panel=catalog.querySelector('#dataset-removal-records');const rows=api.rows.filter(row=>row.state!=='UNREGISTERED');
      if(!rows.length){panel?.remove();return;}if(!panel){panel=document.createElement('section');panel.id='dataset-removal-records';panel.dataset.removeOwned='';panel.setAttribute('aria-label','删除记录');catalog.append(panel);}
      const signature=JSON.stringify([rows,rows.map(row=>api.isBusy(row.id)),api.saved]);if(panel.dataset.signature===signature)return;panel.dataset.signature=signature;
      panel.innerHTML=`<h3>删除记录</h3>${rows.map(row=>`<article data-removal-record="${esc(row.id)}"><div class="dataset-removal-heading"><strong><code>${esc(row.dataset)}</code> · ${serverIdHTML(row.machine)}</strong>${stateHTML(row)}</div>${['FAILED','BLOCKED'].includes(row.state)&&row.error?`<p class="${row.state==='BLOCKED'?'dataset-remove-blocked':'form-error'}">${esc(row.error)}</p>`:''}${row.operationId?`<details><summary>操作编号</summary><code>${esc(row.operationId)}</code></details>`:row.state==='BLOCKED'?'':`<form data-removal-lookup="${esc(row.id)}"><label class="field"><span class="field-caption"><span>原操作编号</span>${copyHelp('查询原操作','先在服务器的操作记录里找到原编号再查询，不要重复删除。')}</span><input name="operationId" required pattern="[a-f0-9]{64}" minlength="64" maxlength="64" placeholder="64 位原编号" autocomplete="off" spellcheck="false"></label><button class="button" type="submit" ${api.isBusy(row.id)||row.state==='SUBMITTING'?'disabled':''}>重新查询</button></form>`}<div class="file-actions">${row.state==='BLOCKED'?`<button class="button" type="button" data-removal-dismiss="${esc(row.id)}">知道了</button>`:''}${row.operationId?`<button class="button" type="button" data-removal-query="${esc(row.id)}" ${api.isBusy(row.id)?'disabled':''}>重新查询</button>`:''}${row.state==='UNKNOWN'?`<button class="button quiet" type="button" data-removal-abandon="${esc(row.id)}" ${api.isBusy(row.id)?'disabled':''}>放弃这条未确认记录</button>`:''}</div>${!api.saved?'<p class="muted">这条记录未能保存，关闭前请保留原编号。</p>':''}</article>`).join('')}`;
    }finally{updating=false;}
  }
  section.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled||!admin())return;
    if(button.hasAttribute('data-remove-more')){const menu=button.parentElement.querySelector('.dataset-remove-options'),rect=button.getBoundingClientRect();menu.style.left=Math.max(16,Math.min(innerWidth-Math.min(320,innerWidth-32)-16,rect.left))+'px';menu.style.top=Math.min(innerHeight-180,rect.bottom+8)+'px';}
    if(button.matches('[data-remove-version],[data-remove-dataset]')){const card=button.closest('.dataset-card');if(resolving.has(card))return;button.closest('[popover]')?.hidePopover();resolving.add(card);update();try{const whole=button.hasAttribute('data-remove-dataset'),resolved=await resolveTarget(card,whole);if(resolved){if(api.blocked(resolved.target))throw Error('这台服务器上的删除结果待确认');confirmRemove(resolved.target,whole,resolved.preservation);}}catch(error){toast(error.message);}finally{resolving.delete(card);update();}}
    if(button.dataset.removalQuery)api.query(button.dataset.removalQuery).catch(error=>toast(error.message));
    if(button.dataset.removalAbandon)confirmAbandon(button.dataset.removalAbandon);
    if(button.dataset.removalDismiss)api.dismiss(button.dataset.removalDismiss);
  });
  section.addEventListener('submit',event=>{if(!event.target.matches('[data-removal-lookup]'))return;event.preventDefault();if(admin())api.query(event.target.dataset.removalLookup,new FormData(event.target).get('operationId')).catch(error=>toast(error.message));});
  section.addEventListener('change',update);
  new MutationObserver(update).observe(section,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});
  new MutationObserver(update).observe(document.body,{attributes:true,attributeFilter:['data-room']});
  document.addEventListener('visibilitychange',()=>{api.sync(!document.hidden&&!section.hidden&&document.body.dataset.room==='datasets');});
  document.addEventListener('gpuq-maintenance-state',update);
  store.onAuthChange?.(()=>{dialog?.close();localReferences.clear();api.sync(false);update();});
  update();return api;
}
