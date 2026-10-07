import {randomUUID} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {datasetCatalogCall} from './dataset-catalog.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,HASH=/^[a-f0-9]{64}$/;
const terminal=new Set(['READY','RELEASED','CANCELED','FAILED','BLOCKED']);
const states=new Set([...terminal,'DISPATCHING','RUNNING','CANCELING','UNKNOWN']);
const fail=(message,status=400,code='CACHE_ACTION_INVALID')=>{throw Object.assign(Error(message),{status,code});};
function fields(args,allowed){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!allowed.includes(key)))fail('缓存操作参数无效。');
}
function reference(args){
  if(!ID.test(args.dataset||'')||!HASH.test(args.version||''))fail('请选择数据集和完整版本。');
  return {dataset:args.dataset,version:args.version};
}
function uuid(value){if(typeof value!=='string'||!UUID.test(value))fail('缓存操作需要原请求 UUID。');return value;}
function view(row){
  const result=Object.fromEntries(['operationId','key','action','machine','dataset','version','state','phase','createdAt','updatedAt','canCancel','error','errorCode','transferId']
    .filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
  // Completed release/cancel/failure receipts describe this original action,
  // not the current location after somebody explicitly prepared another copy.
  result.receiptOnly=terminal.has(row.state)&&row.state!=='READY';
  if(result.receiptOnly)result.locationState='NOT_OBSERVED';
  return result;
}

// An identity/control index over the existing dataset worker and transfer
// service, not a second byte queue. Status never calls prepare or resume.
export function installDatasetCacheActions(service){
  service.db.exec('CREATE TABLE IF NOT EXISTS dataset_cache_actions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,client_key))');
  const lanes=new Map();
  const load=id=>{const found=service.db.prepare('SELECT data FROM dataset_cache_actions WHERE id=?').get(id);return found&&JSON.parse(found.data);};
  const byKey=(owner,key)=>{const found=service.db.prepare('SELECT data FROM dataset_cache_actions WHERE owner=? AND client_key=?').get(owner,key);return found&&JSON.parse(found.data);};
  const save=row=>{
    if(service.closing)fail('服务正在关闭，请稍后查询原操作。',503,'CACHE_SERVICE_CLOSING');
    const previous=load(row.operationId);
    if(previous?.cancelRequested){row.cancelRequested=true;if(!terminal.has(row.state)&&row.state!=='UNKNOWN')row.state='CANCELING';}
    row.updatedAt=Date.now();row.canCancel=row.action==='release'&&!terminal.has(row.state);
    service.db.prepare('INSERT INTO dataset_cache_actions(id,owner,client_key,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(row.operationId,row.owner,row.key,JSON.stringify(row));return row;
  };
  const authorize=(who,machine)=>{
    const user=service.store.get(who.userId);
    if(!user?.enabled||user.username!==who.username||(user.role||'member')!==who.role||!MACHINES.some(value=>value.id===machine)||!user.limits[machine])
      fail('账号或目标服务器未授权。',403,'CACHE_TARGET_UNAUTHORIZED');
    return user;
  };
  const bridge=(row,operation,args={})=>service.bridge(row.machine,'storage.cache-action.'+operation,{userId:row.owner,hostAdmin:false,...args});
  const physical=(who,machine,ref)=>service.datasetPhysicalReference?.(who.userId,machine,ref)||ref;
  const checkReceipt=(row,result)=>{
    if(!result||result.key!==row.key||result.dataset!==row.physical.dataset||result.version!==row.version||!states.has(result.state))
      fail('缓存操作回执不匹配。',502,'CACHE_RECEIPT_INVALID');
    return result;
  };
  const merge=(row,result)=>{
    checkReceipt(row,result);
    row.state=result.state;row.phase=typeof result.phase==='string'?result.phase:result.state;
    if(typeof result.errorCode==='string')row.errorCode=result.errorCode;else delete row.errorCode;
    if(typeof result.error==='string')row.error=result.error.slice(0,300);else delete row.error;
    return save(row);
  };
  async function capabilities(who,args,check){
    fields(args,['machine','dataset','version']);const ref=reference(args);authorize(who,args.machine);check();
    const catalog=await datasetCatalogCall(service,who,'datasets.catalog',{machine:args.machine});check();authorize(who,args.machine);
    const selected=catalog.datasets.find(value=>value.dataset===ref.dataset)?.versions.find(value=>value.version===ref.version);
    if(selected?.canUse!==true)return {protocol:0,prepare:false,release:false,reason:'DATASET_READ_UNAUTHORIZED'};
    let result;
    try{result=await service.bridge(args.machine,'storage.cache-action.capabilities',{userId:who.userId,hostAdmin:false,...physical(who,args.machine,ref)});}
    catch(error){check();authorize(who,args.machine);return {protocol:0,prepare:false,release:false,reason:'CACHE_NODE_UNAVAILABLE'};}
    check();authorize(who,args.machine);
    if(result?.protocol!==1||typeof result.prepare!=='boolean'||typeof result.release!=='boolean')
      return {protocol:0,prepare:false,release:false,reason:'CACHE_NODE_PROTOCOL_UNAVAILABLE'};
    return {protocol:1,prepare:result.prepare,release:result.release,prepareCancel:false,releaseCancel:true,...(typeof result.reason==='string'?{reason:result.reason}:{})};
  }
  async function observe(who,row,check){
    authorize(who,row.machine);check();
    if(row.owner!==who.userId)fail('缓存操作不属于当前账号。',403,'CACHE_ACTION_NOT_OWNED');
    if(terminal.has(row.state)&&row.state!=='READY')return view(row);
    try{
      if(row.transport==='node'){
        const result=await bridge(row,'status',{key:row.key});check();authorize(who,row.machine);
        return view(merge(row,result));
      }
      const replica=service.datasetReplicaState?.(row.owner,row.machine,{dataset:row.dataset,version:row.version});
      if(replica?.transferId){row.transferId=replica.transferId;save(row);}
      if(row.transferId){
        const result=await service.transferCall({...who,role:'member'},'transfers.status',{id:row.transferId});
        check();authorize(who,row.machine);
        if(result.id!==row.transferId)fail('原传输回执不匹配。',502,'CACHE_RECEIPT_INVALID');
        row.phase=result.state;
        if(['FAILED','PAUSED','CANCELED'].includes(result.state))row.state=result.state==='CANCELED'?'CANCELED':'FAILED';
        else row.state=row.cancelRequested?'CANCELING':'RUNNING';
      }
      const resolved=await service.resolveDataset(row.owner,row.machine,{dataset:row.dataset,version:row.version});
      check();authorize(who,row.machine);
      const bound=resolved.reference;
      const exactAlias=bound?.mountAs===row.dataset&&bound.version===row.version&&ID.test(bound.dataset||'')&&resolved.status?.dataset===bound.dataset;
      if((resolved.status?.dataset!==row.dataset&&!exactAlias)||resolved.status.version!==row.version)fail('本机缓存回执不匹配。',502,'CACHE_RECEIPT_INVALID');
      if(resolved.status.state==='READY')row.state='READY';
      else if(!row.transferId)row.state='UNKNOWN';
      return view(save(row));
    }catch(error){check();authorize(who,row.machine);row.state='UNKNOWN';row.errorCode=error.code||'CACHE_STATUS_UNCONFIRMED';row.error='原缓存操作尚未确认；请继续查询这个操作编号，不要重新创建。';return view(save(row));}
  }
  async function start(who,action,args,check){
    fields(args,['machine','dataset','version','key']);const ref=reference(args),key=uuid(args.key);authorize(who,args.machine);check();
    let row=byKey(who.userId,key);
    if(row){
      if(row.action!==action||row.machine!==args.machine||row.dataset!==ref.dataset||row.version!==ref.version)
        fail('同一请求 UUID 不可更换动作、服务器或版本。',409,'CACHE_ACTION_KEY_CONFLICT');
      return observe(who,row,check);
    }
    service.assertMaintenanceAllowed?.('datasets.cache.'+action,args,who);
    const caps=await capabilities(who,{machine:args.machine,...ref},check);
    if(caps.protocol!==1||caps[action]!==true)fail('该缓存动作尚不可用：'+(caps.reason||'CACHE_NODE_PROTOCOL_UNAVAILABLE'),409,caps.reason||'CACHE_ACTION_UNAVAILABLE');
    check();authorize(who,args.machine);
    service.assertMaintenanceAllowed?.('datasets.cache.'+action,args,who);
    service.assertDatasetNotDeleting?.(args.machine,ref);
    const fixed=physical(who,args.machine,ref);reference(fixed);
    // Audit and immutable operation identity are committed before dispatch.
    service.audit(who.username,'datasets.cache.'+action,args.machine,ref.dataset+'@'+ref.version);
    row={operationId:randomUUID(),key,owner:who.userId,action,machine:args.machine,...ref,physical:{dataset:fixed.dataset,version:fixed.version},transport:'node',state:'DISPATCHING',phase:'DISPATCHING',createdAt:Date.now()};
    if(action==='prepare'){
      let current;
      try{current=await service.bridge(args.machine,'datasets.status',{userId:who.userId,hostAdmin:false,...fixed});}catch(error){if(error.status===403)throw error;}
      check();authorize(who,args.machine);
      // Local HDD→SSD and fixed authority recovery stay in the existing
      // dataset worker. All cross-node copies remain existing transfers.
      if(current?.warehouseReady!==true&&current?.recoveryConfigured!==true&&current?.state!=='READY'){
        const catalog=await datasetCatalogCall(service,who,'datasets.catalog',{machine:args.machine});
        check();authorize(who,args.machine);
        const selected=catalog.datasets.find(item=>item.dataset===ref.dataset)?.versions.find(item=>item.version===ref.version);
        if(selected?.canUse!==true)fail('数据读取授权已改变。',403,'DATASET_READ_UNAUTHORIZED');
        if(selected.sourceMachine&&selected.sourceMachine!==args.machine)row.transport='replica';
      }
    }
    check();authorize(who,args.machine);
    service.assertMaintenanceAllowed?.('datasets.cache.'+action,args,who);
    save(row);
    try{
      if(row.transport==='node'){
        const result=await bridge(row,action,{key,...row.physical});check();authorize(who,row.machine);merge(row,result);
      }else{
        await service.prepareDataset(row.owner,row.machine,ref,{retry:false});check();authorize(who,row.machine);
        row.state='RUNNING';save(row);return observe(who,row,check);
      }
    }catch(error){
      check();authorize(who,row.machine);
      row.state='UNKNOWN';row.errorCode=error.code||'CACHE_DISPATCH_UNCONFIRMED';row.error='缓存请求回执未确认；请查询原操作编号，不要换 UUID 重试。';save(row);
    }
    return view(row);
  }
  async function cancel(who,row,check){
    authorize(who,row.machine);check();if(row.owner!==who.userId)fail('缓存操作不属于当前账号。',403,'CACHE_ACTION_NOT_OWNED');
    if(terminal.has(row.state))return view(row);
    // Dataset preparation is a shared deterministic worker/replica. Other
    // actions and training consumers can join it after this request starts.
    // Owner equality is not an exclusive consumer proof: never stop it here.
    if(row.action==='prepare'){
      row.errorCode='CACHE_SHARED_WORKER';row.error='缓存准备可能被其他准备或训练任务共用，不能在此单独停止；请继续查询原操作。';
      return view(save(row));
    }
    service.audit(who.username,'datasets.cache.cancel',row.operationId,'REQUESTED');
    row.cancelRequested=true;row.state='CANCELING';save(row);
    try{
      if(row.transport==='node'){
        const result=await bridge(row,'cancel',{key:row.key});check();authorize(who,row.machine);return view(merge(row,result));
      }
      const replica=service.datasetReplicaState?.(row.owner,row.machine,{dataset:row.dataset,version:row.version});
      if(replica?.transferId){row.transferId=replica.transferId;save(row);}
      if(!row.transferId)fail('原传输编号尚未确认。',409,'CACHE_TRANSFER_UNCONFIRMED');
      const result=await service.transferCall({...who,role:'member'},'transfers.cancel',{id:row.transferId});check();authorize(who,row.machine);
      if(result.id!==row.transferId)fail('取消回执不匹配。',502,'CACHE_RECEIPT_INVALID');
      row.phase=result.state;row.state=result.state==='CANCELED'?'CANCELED':result.state==='SUCCEEDED'?'UNKNOWN':result.state==='UNKNOWN'?'UNKNOWN':'CANCELING';
      return view(save(row));
    }catch(error){check();authorize(who,row.machine);row.state='UNKNOWN';row.errorCode='CACHE_CANCEL_UNCONFIRMED';row.error='原工作进程是否已停止尚未确认；请沿原编号查询或再次明确取消。';return view(save(row));}
  }
  service.datasetCacheActionsCall=async(who,operation,args,check=()=>{})=>{
    if(!service.bridge)fail('执行器未启用。',503,'CACHE_NODE_UNAVAILABLE');
    if(operation==='datasets.cache.capabilities')return capabilities(who,args,check);
    if(['datasets.cache.prepare','datasets.cache.release'].includes(operation)){
      fields(args,['machine','dataset','version','key']);const key=uuid(args.key),lane=who.userId+'@'+key;
      if(lanes.has(lane)){await lanes.get(lane);check();return start(who,operation.split('.').at(-1),args,check);}
      if(lanes.size>=4)fail('缓存操作繁忙，请稍后查询原请求。',429,'CACHE_ACTION_BUSY');
      const task=start(who,operation.split('.').at(-1),args,check);lanes.set(lane,task);
      try{return await task;}finally{if(lanes.get(lane)===task)lanes.delete(lane);}
    }
    if(['datasets.cache.status','datasets.cache.cancel'].includes(operation)){
      fields(args,['operationId','key']);if(Object.keys(args).length!==1)fail('只提供原 operationId 或原 key。');
      const row=args.operationId?load(uuid(args.operationId)):byKey(who.userId,uuid(args.key));
      if(!row)fail('原缓存操作不存在。',404,'CACHE_ACTION_NOT_FOUND');
      if(row.owner!==who.userId)fail('缓存操作不属于当前账号。',403,'CACHE_ACTION_NOT_OWNED');
      return operation==='datasets.cache.cancel'?cancel(who,row,check):observe(who,row,check);
    }
    fail('未知缓存操作。');
  };
}
