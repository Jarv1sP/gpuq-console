import {MACHINES,validUsername} from './dist/model.js';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const STATES=new Set(['READY','REGISTERED','STAGING','PREPARING','FAILED','UNKNOWN']);
const OWNER_ID=/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

export const LAST_COPY_MESSAGE='这可能是这个版本的最后一份完整数据。为避免永久丢失，暂不能按机器删除；节点更新后可用「彻底删除」（7 天内可恢复）。';
const removalLanes=new WeakMap();
const lastCopy=()=>Object.assign(Error(LAST_COPY_MESSAGE),{status:409,code:'LAST_COPY_UNPROVEN'});
const complete=value=>value?.state==='READY'||value?.state===undefined&&value?.complete===true;
const pendingRemoval=()=>Object.assign(Error('这台服务器上的删除结果待确认'),{status:409,code:'DATASET_REMOVAL_PENDING'});

function removalPending(service,machine,dataset,version){
  if(!service.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dataset_removal_exclusions'").get())return false;
  return !!service.db.prepare('SELECT 1 FROM dataset_removal_exclusions WHERE machine=? AND dataset=? AND version=? LIMIT 1').get(machine,dataset,version);
}

// The old node accepts cleanup before its worker removes READY. A durable
// exclusion is therefore written BEFORE dispatch, and survives a Portal swap.
// Neither a failed HTTP response nor a missing operation ID proves no deletion.
export function createDatasetRemovalGuard(service,principal,{readTimeoutMs=32000}={}){
  const user=service.store.get(principal.userId),policy=JSON.stringify(user);
  const checkPolicy=()=>{
    const current=service.store.get(principal.userId);
    if(service.closing||principal.role!=='admin'||!current?.enabled||current.role!=='admin'||JSON.stringify(current)!==policy)
      fail('账号授权已改变，请刷新后重试。',403);
  };
  checkPolicy();
  if(!service.db||!service.bridge)throw lastCopy();
  service.db.exec(`CREATE TABLE IF NOT EXISTS dataset_removal_exclusions (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
    machine TEXT NOT NULL, dataset TEXT NOT NULL, version TEXT NOT NULL,
    scope_version TEXT, operation_id TEXT, user_id TEXT NOT NULL, started_at TEXT NOT NULL
  )`);
  async function read(machine,operation,args){
    let timer;
    try{
      return await Promise.race([service.bridge(machine,operation,args),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(lastCopy()),readTimeoutMs);timer.unref?.();
      })]);
    }catch{throw lastCopy();}finally{clearTimeout(timer);checkPolicy();}
  }
  async function listings(){
    const rows=await Promise.all(MACHINES.map(async machine=>{
      const result=await read(machine.id,'datasets.list',{userId:user.id,hostAdmin:true});
      if(!Array.isArray(result?.datasets)||result.datasets.some(item=>!ID.test(item?.dataset)||!Array.isArray(item.versions)||
        item.versions.some(value=>!HASH.test(value?.version))||item.ownerIds!==undefined&&(!Array.isArray(item.ownerIds)||item.ownerIds.some(owner=>typeof owner!=='string'||!OWNER_ID.test(owner)))))throw lastCopy();
      return {machine:machine.id,datasets:result.datasets};
    }));
    checkPolicy();return rows;
  }
  function names(machine,item,version){
    const values=new Set([item.dataset]);
    for(const owner of item.ownerIds||[]){
      if(typeof owner!=='string'||!OWNER_ID.test(owner))continue;
      const alias=service.datasetAliases?.(owner,machine)?.get(item.dataset+'@'+version);
      const archived=machine===service.storageArchivePolicy?.machine?service.archiveAliases?.(owner)?.get(item.dataset+'@'+version):null;
      for(const name of [alias,archived])if(typeof name==='string'&&ID.test(name))values.add(name);
    }
    return values;
  }
  const exclusionRows=()=>service.db.prepare('SELECT * FROM dataset_removal_exclusions').all();
  const hasCopy=(rows,pending)=>rows.find(row=>row.machine===pending.machine)?.datasets.some(item=>item.dataset===pending.dataset&&item.versions?.some(value=>value.version===pending.version&&complete(value)));
  const absent=(rows,pending)=>{
    const listing=rows.find(row=>row.machine===pending.machine);
    return !!listing&&!listing.datasets.some(item=>item.dataset===pending.dataset&&item.versions.some(value=>value.version===pending.version));
  };
  async function reconcile(rows,pending){
    const remove=service.db.prepare('DELETE FROM dataset_removal_exclusions WHERE id=?');
    // A confirmed absence releases only this missing-ID record, even when an
    // unrelated original receipt cannot be read. That failure still blocks dispatch.
    for(const row of pending)if(!row.operation_id&&absent(rows,row))remove.run(row.id);
    const receipts=new Map();
    for(const row of pending){
      if(!HASH.test(row.operation_id||''))continue;
      const key=JSON.stringify([row.machine,row.operation_id]);
      if(!receipts.has(key))receipts.set(key,await read(row.machine,'datasets.status',{operationId:row.operation_id,userId:row.user_id,hostAdmin:true}));
      const receipt=receipts.get(key);
      if(receipt?.operationId!==row.operation_id||receipt.dataset!==row.dataset||(receipt.version??null)!==row.scope_version)throw lastCopy();
    }
    // Read AFTER the original receipt. A pre-receipt READY can be the copy
    // that the just-finished worker removed, and must never release an exclusion.
    if(receipts.size)rows=await listings();
    for(const row of pending){
      const receipt=receipts.get(JSON.stringify([row.machine,row.operation_id]));
      if((receipt?.state==='UNREGISTERED'&&typeof receipt.unregistered==='boolean')||(receipt?.state==='FAILED'&&hasCopy(rows,row)))remove.run(row.id);
    }
    checkPolicy();return rows;
  }
  async function refreshExclusions(){
    const pending=exclusionRows();if(!pending.length)return;
    await reconcile(await listings(),pending);
  }
  async function snapshot(machine,dataset,version){
    checkPolicy();
    if(!MACHINES.some(row=>row.id===machine)||!ID.test(dataset)||version!=null&&!HASH.test(version))throw lastCopy();
    let rows=await listings();
    let target=rows.find(row=>row.machine===machine)?.datasets.find(item=>item.dataset===dataset);
    const versions=version==null?[...new Set([...(target?.versions||[]).map(value=>value.version),...exclusionRows().filter(row=>row.machine===machine&&row.dataset===dataset).map(row=>row.version)])]:[version];
    const pending=exclusionRows().filter(row=>versions.includes(row.version));
    rows=await reconcile(rows,pending);
    target=rows.find(row=>row.machine===machine)?.datasets.find(item=>item.dataset===dataset);
    if(version==null)versions.splice(0,versions.length,...new Set((target?.versions||[]).map(value=>value.version)));
    checkPolicy();
    const excluded=exclusionRows(),proof=[];
    if(excluded.some(row=>row.machine===machine&&row.dataset===dataset&&versions.includes(row.version)))throw pendingRemoval();
    if(!versions.length||!target||versions.some(id=>!target.versions.some(value=>value.version===id)))throw lastCopy();
    for(const id of versions){
      const targetNames=names(machine,target,id),copies=[];
      for(const row of rows){
        if(row.machine===machine)continue;
        for(const item of row.datasets){
          if(!ID.test(item?.dataset)||!Array.isArray(item.versions)||![...names(row.machine,item,id)].some(name=>targetNames.has(name)))continue;
          const value=item.versions.find(value=>value.version===id);
          if(!complete(value)||excluded.some(pending=>pending.machine===row.machine&&pending.dataset===item.dataset&&pending.version===id))continue;
          copies.push({machine:row.machine,dataset:item.dataset,version:id});
        }
      }
      // An ARCHIVED journal alone is historical. Its distinct authority must
      // also report this fixed version complete in the current node read.
      if(!copies.length)throw lastCopy();
      proof.push({version:id,copies});
    }
    return proof;
  }
  async function withProtectedRemoval(machine,dataset,version,dispatch){
    // A single removal lane also covers whole-dataset requests and differently
    // named archive aliases, without acquiring version locks in opposite orders.
    const prior=removalLanes.get(service)||Promise.resolve();
    const run=prior.then(async()=>{
      const proof=await snapshot(machine,dataset,version),requestId=crypto.randomUUID(),startedAt=new Date().toISOString();
      checkPolicy();
      const insert=service.db.prepare('INSERT INTO dataset_removal_exclusions(id,request_id,machine,dataset,version,scope_version,operation_id,user_id,started_at) VALUES(?,?,?,?,?,?,NULL,?,?)');
      service.db.exec('BEGIN IMMEDIATE');
      try{
        for(const row of proof)insert.run(crypto.randomUUID(),requestId,machine,dataset,row.version,version??null,user.id,startedAt);
        service.db.exec('COMMIT');
      }catch(error){service.db.exec('ROLLBACK');throw error;}
      checkPolicy();
      const result=await dispatch();
      if(HASH.test(result?.operationId||'')&&(result.dataset===undefined||result.dataset===dataset)&&(result.version===undefined||(result.version??null)===(version??null)))
        service.db.prepare('UPDATE dataset_removal_exclusions SET operation_id=? WHERE request_id=?').run(result.operationId,requestId);
      checkPolicy();return result;
    });
    const tail=run.catch(()=>{});removalLanes.set(service,tail);
    try{return await run;}finally{if(removalLanes.get(service)===tail)removalLanes.delete(service);}
  }
  return {assertAnotherCompleteCopy:snapshot,withProtectedRemoval,refreshExclusions};
}

// Node ACLs determine visibility first. Only usernames for those returned ACLs
// are projected from the trusted account store; IDs stay inside the portal.
function ownerView(item,users){
  const ids=item?.ownerIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>64||ids.some(id=>typeof id!=='string'||!OWNER_ID.test(id)))return {key:null,label:'所属用户：未知（授权信息未完整返回）'};
  const owners=[...new Set(ids)].sort(),names=owners.map(id=>users?.find(user=>user.id===id)?.username);
  const known=names.filter(validUsername),unknown=names.length-known.length;
  const label=owners.length===1?`所属用户：${unknown?'未知（账号已删除或未登记）':known[0]}`:
    `共享授权用户：${[...known,...(unknown?[`未知用户 ${unknown} 位（账号已删除或未登记）`]:[])].join('、')}`;
  return {key:JSON.stringify(owners),label};
}

// Do not forward arbitrary node metadata, owner IDs, paths or user records.
export function datasetListView(result,users,{includeEmpty=false,labelView,logicalName}={}){
  if(!Array.isArray(result?.datasets))fail('数据集目录暂时无法确认。',502);
  return {datasets:result.datasets.filter(item=>ID.test(item?.dataset)&&Array.isArray(item.versions)).map(item=>({
    dataset:item.dataset,ownerLabel:ownerView(item,users).label,
    ...(labelView?labelView(logicalName?.(item)||item.dataset):{}),
    versions:item.versions.filter(value=>HASH.test(value?.version)).map(value=>{
      const clean={version:value.version,state:STATES.has(value.state)?value.state:'UNKNOWN',canPrepare:value.canPrepare===true};
      for(const field of ['bytes','files'])if(Number.isSafeInteger(value[field])&&value[field]>=0)clean[field]=value[field];
      if(HASH.test(value.operationId))clean.operationId=value.operationId;
      if(value.recoveryConfigured===true)clean.recoveryConfigured=true;
      if(typeof value.error==='string')clean.error=value.error.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300);
      return clean;
    })
  })).filter(item=>includeEmpty||item.versions.length>0)};
}

function combinedOwnerLabel(locations,owners){
  const views=locations.map(location=>owners.get(location)),keys=new Set(views.map(view=>view.key).filter(key=>key!==null));
  if(keys.size>1)return '各机授权不同（见副本位置）';
  if(views.some(view=>view.key===null))return '所属用户：未知（部分节点授权信息未完整返回）';
  return views[0]?.label||'所属用户：未知';
}

// This is a permission-filtered view, not a second mutable source of truth.
// Each node authenticates the same owner before returning its immutable versions.
export async function datasetCatalogCall(service,principal,operation,args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='machine'))fail('数据集目录参数无效。');
  const user=service.store.get(principal.userId);
  if(!user.enabled||!MACHINES.some(m=>m.id===args.machine)||!user.limits[args.machine])fail('这台机器未授权。',403);
  const policy=JSON.stringify(user),checkPolicy=()=>{
    if(service.closing||JSON.stringify(service.store.get(principal.userId))!==policy)fail('账号授权已改变，请刷新后重试。',403);
  };
  if(!service.bridge)fail('节点执行桥尚未配置。',503);
  const owner={userId:user.id,hostAdmin:false};
  if(operation==='datasets.capacity'){
    const value=await service.bridge(args.machine,'datasets.capacity',owner);
    checkPolicy();
    const result={machine:args.machine,available:true};
    for(const key of ['filesystemBytes','availableBytes','reserveBytes','usableBytes']){
      if(!Number.isSafeInteger(value?.[key])||value[key]<0)fail('数据盘容量暂时无法确认。',502);
      result[key]=value[key];
    }
    for(const key of ['totalInodes','availableInodes']){
      if(value.inodeUsageKnown===true&&(!Number.isSafeInteger(value[key])||value[key]<0))fail('数据盘 inode 容量暂时无法确认。',502);
      result[key]=value.inodeUsageKnown===true?value[key]:null;
    }
    return {...result,inodeUsageKnown:value.inodeUsageKnown===true,guarded:value.guarded===true};
  }
  if(operation!=='datasets.catalog')fail('未知目录操作。');
  // An explicit administrator refresh may retire a proven terminal or absent
  // exclusion. It never dispatches cleanup or invents an operation identity.
  if(principal.role==='admin'&&service.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dataset_removal_exclusions'").get()){
    try{await createDatasetRemovalGuard(service,principal).refreshExclusions();}
    catch(error){if(error.code!=='LAST_COPY_UNPROVEN')throw error;}
  }
  // A known owner's archived version is data access, not a GPU/shell grant on
  // the storage host. Unrelated versions on that host remain invisible.
  const machines=MACHINES.filter(m=>user.limits[m.id]>0||service.archiveMachineVisible?.(user.id,m.id));
  const listings=await Promise.all(machines.map(async m=>{
    try{
      const result=await service.bridge(m.id,'datasets.list',owner);
      if(!Array.isArray(result?.datasets))throw Error('invalid catalog');
      return {machine:m.id,state:'ok',datasets:result.datasets};
    }catch{return {machine:m.id,state:'unavailable',datasets:[]};}
  }));
  let capabilities;
  try{capabilities=await service.transferCall?.({...principal,role:'member'},'transfers.capabilities',{machine:args.machine});}catch{}
  checkPolicy();
  const replicaSources=capabilities?.enabled===true&&Array.isArray(capabilities.sources)?capabilities.sources.filter(id=>machines.some(m=>m.id===id)):[];
  const datasets=new Map();
  const owners=new WeakMap();
  const aliases=new Map(listings.map(listing=>[listing.machine,service.datasetAliases?.(user.id,listing.machine)]));
  for(const listing of listings)for(const item of listing.datasets){
    if(!ID.test(item?.dataset)||!Array.isArray(item.versions))continue;
    for(const value of item.versions){
      if(!HASH.test(value?.version))continue;
      if(!user.limits[listing.machine]&&!service.archiveSourceAllowed?.(user.id,listing.machine,{dataset:item.dataset,version:value.version}))continue;
      const alias=aliases.get(listing.machine)?.get(item.dataset+'@'+value.version)||(listing.machine===service.storageArchivePolicy?.machine?service.archiveAliases?.(user.id)?.get(item.dataset+'@'+value.version):null);
      const name=typeof alias==='string'&&ID.test(alias)?alias:item.dataset;
      let dataset=datasets.get(name);
      if(!dataset){dataset={dataset:name,versions:new Map()};datasets.set(name,dataset);}
      let version=dataset.versions.get(value.version);
      if(!version){version={version:value.version,locations:[]};dataset.versions.set(value.version,version);}
      const owner=ownerView(item,service.store.users);
      const location={machine:listing.machine,dataset:item.dataset,ownerLabel:owner.label,state:STATES.has(value.state)?value.state:'UNKNOWN',canPrepare:value.canPrepare===true,
        ...(principal.role==='admin'&&removalPending(service,listing.machine,item.dataset,value.version)?{removalPending:true}:{}),
        ...(service.archiveState?.(user.id,listing.machine,{dataset:item.dataset,version:value.version})?{storage:service.archiveState(user.id,listing.machine,{dataset:item.dataset,version:value.version})}:{}),
        ...(listing.machine===args.machine&&typeof value.error==='string'?{error:value.error.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300)}:{})};
      owners.set(location,owner);version.locations.push(location);
      if(Number.isSafeInteger(value.bytes)&&value.bytes>=0)version.bytes=value.bytes;
      if(Number.isSafeInteger(value.files)&&value.files>=0)version.files=value.files;
    }
  }
  const localAvailable=listings.find(m=>m.machine===args.machine)?.state==='ok';
  return {machine:args.machine,partial:listings.some(m=>m.state!=='ok'),machines:listings.map(({machine,state})=>({machine,state})),
    datasets:[...datasets.values()].sort((a,b)=>a.dataset.localeCompare(b.dataset)).map(item=>({dataset:item.dataset,
      ...(service.datasetLabelView?.(user.id,item.dataset)||{}),versions:[...item.versions.values()].sort((a,b)=>a.version.localeCompare(b.version)).map(version=>{
      const local=version.locations.find(l=>l.machine===args.machine&&l.state==='READY')||version.locations.find(l=>l.machine===args.machine);
      const source=localAvailable&&local?.state!=='READY'&&!local?.canPrepare&&version.locations.find(l=>l.state==='READY'&&replicaSources.includes(l.machine));
      const transfer=service.datasetReplicaState?.(user.id,args.machine,{dataset:item.dataset,version:version.version});
      return {...version,ownerLabel:combinedOwnerLabel(version.locations,owners),state:local?.state==='READY'?'READY':transfer?.state||local?.state||(localAvailable?'NOT_LOCAL':'UNKNOWN'),canPrepare:local?.canPrepare===true||!!source,...(source?{sourceMachine:source.machine,sourceDataset:source.dataset}:{}),...(local?.state!=='READY'&&(transfer?.error||local?.error)?{error:transfer?.error||local?.error}:{})};
    })}))};
}
