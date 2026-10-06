const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES=new Set(['PLANNED','RUNNING','REMOVING_CACHES','RETIRING_ORIGINAL','DELETED','BLOCKED','FAILED','UNKNOWN','WAITING_CONTINUE','CANCELING','CANCELED']);
const ACTIVE=new Set(['PLANNED','RUNNING','REMOVING_CACHES','RETIRING_ORIGINAL','CANCELING']);
export const fullDeleteStorageKey=userId=>'stargate.dataset-full-delete.v1:'+encodeURIComponent(userId);
export function fullDeleteTarget(dataset,version){
  if(typeof dataset!=='string'||!ID.test(dataset)||typeof version!=='string'||!HASH.test(version))throw Error('请选择数据集的完整版本。');
  return {dataset,version};
}
export function canFullDelete(principal,catalog,dataset,version){
  if(!principal?.userId||catalog?.datasetDelete!==1)return false;
  const selected=catalog.datasets?.find(item=>item.dataset===dataset)?.versions?.find(item=>item.version===version);
  if(!selected)return false;
  return principal.role==='admin'||principal.role==='member'&&selected.locations?.some(location=>location.deletionPermissions?.memberAllowed===true)===true;
}
export function fullDeleteActions(row,principal){
  if(principal?.role!=='admin'||!row?.confirmed||!UUID.test(row.operationId)||row.state==='UNKNOWN'||row.pendingAction)return [];
  const steps=row.task?.steps||[],recovering=steps.some(step=>step.restoreState);
  const actions=[];
  if(!recovering&&(row.state==='WAITING_CONTINUE'&&row.task.canContinue===true||['FAILED','BLOCKED'].includes(row.state)))actions.push('continue');
  if(!recovering&&!['DELETED','CANCELED','CANCELING'].includes(row.state))actions.push('cancel');
  if(['DELETED','FAILED','BLOCKED'].includes(row.state)&&steps.some(step=>step.complete===true&&step.retainUntil))actions.push('restore');
  return actions;
}

// Local storage is a recovery reference, never a completion or permission proof.
// Every write is bound to the original account, target and key before dispatch.
export function createDatasetFullDeletion({principal,catalog,call,storage,session=()=>0,changed=()=>{},completed=()=>{},now=Date.now,makeKey=()=>crypto.randomUUID(),setTimer=setTimeout,clearTimer=clearTimeout}){
  let owner=null,visible=false,timer=null,generation=0;
  const busy=new Set(),copy=value=>structuredClone(value);
  function stop(){if(timer!==null)clearTimer(timer);timer=null;}
  function save(context){
    try{if(!storage)throw Error('no storage');storage.setItem(fullDeleteStorageKey(context.id),JSON.stringify(context.rows));context.saved=true;return true;}
    catch{context.saved=false;return false;}
  }
  function sync(show=visible){
    visible=show;const who=principal(),signature=who?.userId&&['admin','member'].includes(who.role)?JSON.stringify([who.userId,who.role,session()]):null;
    if(signature!==owner?.signature){
      stop();generation++;owner=null;busy.clear();
      if(signature){
        let rows=[];try{rows=JSON.parse(storage?.getItem(fullDeleteStorageKey(who.userId))||'[]');}catch{}
        owner={id:who.userId,signature,saved:!!storage,rows:Array.isArray(rows)?rows.filter(row=>{
          try{fullDeleteTarget(row.dataset,row.version);return UUID.test(row.key)&&(!row.operationId||UUID.test(row.operationId))&&(STATES.has(row.state)||row.state==='SUBMITTING');}catch{return false;}
        }).map(row=>({...row,state:'UNKNOWN',confirmed:false,pendingAction:null,error:'请按原请求编号重新查询。'})):[]};
      }
    }
    if(!visible)stop();else arm();return owner?.rows||[];
  }
  function active(context,stamp){return owner===context&&generation===stamp&&JSON.stringify([principal()?.userId,principal()?.role,session()])===context.signature;}
  function notify(context){save(context);if(owner===context)changed();arm();}
  function arm(){
    stop();if(!visible||!owner)return;
    const rows=owner.rows.filter(row=>ACTIVE.has(row.state)&&row.confirmed&&!busy.has(row.key));if(!rows.length)return;
    timer=setTimer(()=>{timer=null;const due=owner?.rows.filter(row=>ACTIVE.has(row.state)&&row.nextAt<=now())||[];for(const row of due)query(row.key);},Math.max(0,Math.min(...rows.map(row=>row.nextAt))-now()));
  }
  function unknown(row,message){row.state='UNKNOWN';row.confirmed=false;row.error=message||'删除结果未确认，请重新查询。';}
  function accept(row,result){
    const valid=result&&result.key===row.key&&UUID.test(result.operationId)&&(!row.operationId||row.operationId===result.operationId)&&
      result.dataset===row.dataset&&result.version===row.version&&STATES.has(result.state)&&Array.isArray(result.steps)&&Array.isArray(result.events)&&
      result.steps.every(step=>typeof step.machine==='string'&&step.machine&&ID.test(step.dataset)&&UUID.test(step.operationId)&&typeof step.phase==='string'&&typeof step.state==='string');
    if(!valid){unknown(row,'删除回执与原请求不符，请重新查询。');return false;}
    row.operationId=result.operationId;row.task=copy(result);row.state=result.state;row.confirmed=true;row.error=typeof result.error==='string'?result.error:'';
    if(result.steps.some(step=>['DISPATCHING','UNKNOWN'].includes(step.restoreState))){unknown(row,row.error||'恢复结果待确认，请重新查询。');}
    row.nextAt=now()+[2000,5000,10000][Math.min(row.attempt||0,2)];row.attempt=(row.attempt||0)+1;
    return true;
  }
  async function read(context,row,stamp){
    try{const result=await call('datasets.delete.status',{key:row.key});if(active(context,stamp))accept(row,result);}
    catch(error){if(active(context,stamp))unknown(row,error.message);}
  }
  async function submit(dataset,version){
    sync();const target=fullDeleteTarget(dataset,version),context=owner,stamp=generation;
    if(!context||!canFullDelete(principal(),catalog(),dataset,version))throw Error('这份数据当前不能彻底删除。');
    const prior=context.rows.findLast(row=>row.dataset===dataset&&row.version===version);if(prior)return copy(prior);
    const key=makeKey();if(!UUID.test(key))throw Error('删除请求编号未能生成。');
    const row={...target,key,operationId:null,state:'SUBMITTING',confirmed:false,startedAt:now(),error:'',attempt:0};
    context.rows.push(row);
    if(!save(context)){context.rows.pop();throw Error('无法保存删除请求编号，暂不发送。请允许此网站保存本地记录后重试。');}
    busy.add(key);changed();
    try{
      const result=await call('datasets.delete',{...target,key});
      if(active(context,stamp)&&!accept(row,result))await read(context,row,stamp);
    }catch(error){
      if(active(context,stamp)){
        unknown(row,error.message);
        if(error.status===403||error.status===409&&error.code==='DATASET_DELETE_UNSUPPORTED')row.state='BLOCKED';
        else await read(context,row,stamp);
      }
    }finally{
      busy.delete(key);if(active(context,stamp)){notify(context);if(row.confirmed&&row.state==='DELETED')completed(copy(row));}
    }
    return copy(row);
  }
  async function query(key){
    sync();const context=owner,row=context?.rows.find(row=>row.key===key),stamp=generation;if(!row||busy.has(key))return;
    const wasDeleted=row.confirmed&&row.state==='DELETED';busy.add(key);changed();
    try{await read(context,row,stamp);}
    finally{busy.delete(key);if(active(context,stamp)){notify(context);if(!wasDeleted&&row.confirmed&&row.state==='DELETED')completed(copy(row));}}
    return copy(row);
  }
  async function act(key,action,machine){
    sync();const context=owner,row=context?.rows.find(row=>row.key===key),stamp=generation;
    if(!row||busy.has(key)||!fullDeleteActions(row,principal()).includes(action))throw Error(principal()?.role!=='admin'?'需要管理员处理。':'请先查询并确认原删除任务。');
    if(catalog()?.datasetDelete!==1)throw Error('服务器暂不支持这项操作，请刷新目录。');
    const sources=(row.task?.steps||[]).filter(step=>step.machine===machine&&step.complete===true&&step.retainUntil);
    if(action==='restore'&&sources.length!==1)throw Error('请选择已确认的完整保留副本。');
    row.pendingAction=action;if(!save(context)){row.pendingAction=null;throw Error('无法保存操作记录，暂不发送。');}
    busy.add(key);changed();
    try{
      const result=await call('datasets.delete.'+action,{operationId:row.operationId,...(action==='restore'?{machine}:{})});
      if(active(context,stamp)){
        if(action!=='restore'||result?.key)accept(row,result);
        else if(result?.operationId!==row.operationId||result.machine!==machine||result.version!==row.version||result.dataset!==undefined&&result.dataset!==sources[0].dataset||!['RESTORED','FAILED','UNKNOWN'].includes(result.state))unknown(row,'恢复回执与原请求不符，请重新查询。');
        else{
          row.lastAction={action,machine,state:result.state};unknown(row,result.error||'正在核对恢复后的删除记录。');
          await read(context,row,stamp);
        }
      }
    }catch(error){if(active(context,stamp))unknown(row,error.message);}
    finally{busy.delete(key);if(active(context,stamp)){row.pendingAction=null;notify(context);}}
    return copy(row);
  }
  return {sync,submit,query,act,stop,canOpen:(dataset,version)=>canFullDelete(principal(),catalog(),dataset,version),
    find(dataset,version){sync();const row=owner?.rows.findLast(row=>row.dataset===dataset&&row.version===version);return row?copy(row):null;},
    get rows(){return copy(owner?.rows||[]);},get saved(){return owner?.saved??true;},isBusy:key=>busy.has(key)};
}
