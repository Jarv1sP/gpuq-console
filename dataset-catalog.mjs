import {MACHINES,validUsername} from './dist/model.js';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const STATES=new Set(['READY','REGISTERED','STAGING','PREPARING','FAILED','UNKNOWN']);
const OWNER_ID=/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

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
