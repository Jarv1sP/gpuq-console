import {MACHINES} from './dist/model.js';
import {datasetCatalogCall} from './dataset-catalog.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const byte=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const sum=values=>{
  let result=0;
  for(const value of values){if(value===null||!Number.isSafeInteger(result+value))return null;result+=value;}
  return result;
};
const consistent=(locations,key)=>{
  const values=locations.map(location=>byte(location[key]));
  return values.length&&values.every(value=>value!==null&&value===values[0])?values[0]:null;
};

function volumeView(machine,value){
  const unknown={id:null,state:'UNKNOWN',checkedAt:null,totalBytes:null,usedBytes:null,availableBytes:null,reserveBytes:null,usableBytes:null,readOnly:null,guarded:false};
  if(!value||typeof value!=='object'||Array.isArray(value))return unknown;
  const totalBytes=byte(value.filesystemBytes),usedBytes=byte(value.usedBytes),availableBytes=byte(value.availableBytes),reserveBytes=byte(value.reserveBytes),usableBytes=byte(value.usableBytes);
  if([totalBytes,usedBytes,availableBytes,reserveBytes,usableBytes].some(value=>value===null)||usedBytes>totalBytes||availableBytes>totalBytes||usedBytes+availableBytes>totalBytes||usableBytes!==Math.max(0,availableBytes-reserveBytes))return unknown;
  return {id:typeof value.volumeDeviceId==='string'&&/^[a-f0-9]{64}$/.test(value.volumeDeviceId)?machine+':'+value.volumeDeviceId:null,
    state:'READY',checkedAt:timestamp(value.checkedAt),totalBytes,usedBytes,availableBytes,reserveBytes,usableBytes,
    readOnly:typeof value.readOnly==='boolean'?value.readOnly:null,guarded:value.guarded===true};
}

function warning(machine,code){return {machine,code};}
function warehouseWarnings(machine,volume){
  if(volume.state!=='READY')return [warning(machine,'WAREHOUSE_CAPACITY_UNKNOWN')];
  const result=[];
  // Display-only watermarks, never per-user quotas or admission decisions.
  if(volume.totalBytes>0&&volume.usedBytes/volume.totalBytes>=0.9)result.push(warning(machine,'WAREHOUSE_USAGE_HIGH'));
  if(volume.availableBytes<=volume.reserveBytes)result.push(warning(machine,'WAREHOUSE_FREE_SPACE_LOW'));
  if(volume.readOnly===true)result.push(warning(machine,'WAREHOUSE_READ_ONLY'));
  return result;
}

/** Authenticated metadata projection; not a download/preview or mutation grant.
 * Existing node catalogs remain authoritative. No second registry, inventory
 * scanner, collector, allocation, lease mutation or user workspace is created.
 */
export async function datasetStorageOverviewCall(service,principal,args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)fail('存储总览不接受额外参数。');
  let user;try{user=service.store.get(principal?.userId);}catch{}
  if(user?.enabled!==true||user.id!==principal?.userId)fail('账号不存在或已停用。',403);
  if(!service.bridge)fail('节点执行桥尚未配置。',503);
  const policy=JSON.stringify(user),checkPolicy=()=>{
    let current;try{current=service.store.get(principal.userId);}catch{}
    if(service.closing||current?.enabled!==true||JSON.stringify(current)!==policy)fail('账号授权已改变，请刷新后重试。',403);
  };
  // Catalog's existing metadata-only service read preserves exact member ACLs.
  const catalog=await datasetCatalogCall(service,principal,'datasets.catalog',{},{refreshRemovalExclusions:false});
  checkPolicy();
  const nodes=await Promise.all(MACHINES.map(async({id:machine})=>{
    try{
      // Confinement to a fixed, literal capacity read, never a file operation.
      const value=await service.bridge(machine,'datasets.capacity',{userId:'builtin-admin',hostAdmin:true});
      const versioned=value?.storageOverview?.protocol==='dataset-storage-node-v1',facts=versioned?value.storageOverview:null;
      const volume=volumeView(machine,versioned?facts.cache?.volume:value);
      const budgetBytes=byte(versioned?facts.cache?.budgetBytes:value?.datasetBudgetBytes);
      let warehouse=null;
      if(versioned&&facts.warehouse!==null){
        const candidate=volumeView(machine,facts.warehouse?.volume);
        warehouse={machine,state:facts.warehouse?.state==='READY'&&candidate.state==='READY'?'READY':'UNAVAILABLE',volume:candidate};
      }
      return {machine,state:volume.state==='READY'?'READY':'UNKNOWN',volume,budgetBytes,warehouse,warehouseKnown:versioned};
    }catch{return {machine,state:'UNAVAILABLE',volume:volumeView(machine,null),budgetBytes:null,warehouse:null,warehouseKnown:false};}
  }));
  checkPolicy();
  const usage=new Map(nodes.map(node=>[node.machine,{sizes:[],versions:new Set(),complete:catalog.machines.find(row=>row.machine===node.machine)?.state==='ok'}]));
  const originals=new Map(nodes.filter(node=>node.warehouse).map(node=>[node.machine,{sizes:[],datasets:new Set(),versions:new Set(),complete:catalog.machines.find(row=>row.machine===node.machine)?.state==='ok'}]));
  const datasets=catalog.datasets.map(item=>({dataset:item.dataset,...(typeof item.displayName==='string'?{displayName:item.displayName}:{}),versions:item.versions.map(version=>{
    const contentBytes=consistent(version.locations,'contentBytes'),fileCount=consistent(version.locations,'fileCount');
    const originalLocations=[],cacheLocations=[],personalOriginals=[];
    for(const location of version.locations){
      if(location.storageRole==='personal-original'&&['hdd','ssd'].includes(location.storageTier)){
        personalOriginals.push({machine:location.machine,dataset:location.dataset,state:location.state,
          canUse:location.canUse&&location.state==='READY',canPrepare:false,storageTier:location.storageTier,storageRole:'personal-original'});
        continue; // Dedicated private roots are not on this managed cache volume.
      }
      const key=item.dataset+'@'+version.version,size=byte(location.contentBytes),cached=usage.get(location.machine);
      if(typeof location.warehouseReady==='boolean'){
        originalLocations.push({machine:location.machine,dataset:location.originalDataset,state:location.warehouseReady?'READY':'NOT_READY',confirmed:location.warehouseReady===true,canUse:location.canUse&&location.warehouseReady});
        const original=originals.get(location.machine);
        if(original&&location.state==='UNKNOWN')original.complete=false;
        if(original&&location.warehouseReady&&!original.versions.has(key)){
          original.sizes.push(size);original.datasets.add(item.dataset);original.versions.add(key);
        }
      }
      const state=location.warehouseReady===false?'UNKNOWN':location.state==='REGISTERED'&&location.warehouseReady===true?'NOT_LOCAL':location.state;
      if(cached&&state==='UNKNOWN')cached.complete=false;
      cacheLocations.push({machine:location.machine,dataset:location.dataset,state,canUse:location.canUse&&state==='READY',canPrepare:location.canPrepare===true});
      const cacheKey=location.dataset+'@'+version.version;
      if(cached&&state==='READY'&&!cached.versions.has(cacheKey)){cached.sizes.push(size);cached.versions.add(cacheKey);}
    }
    return {version:version.version,ownerLabel:version.ownerLabel,contentBytes,fileCount,canUse:version.canUse===true,originals:originalLocations,caches:cacheLocations,
      ...(personalOriginals.length?{personalOriginals}:{})};
  })}));
  const warehouses=nodes.filter(node=>node.warehouse).map(node=>{
    const counts=originals.get(node.machine),complete=counts.complete&&counts.sizes.every(value=>value!==null),warnings=warehouseWarnings(node.machine,node.warehouse.volume);
    if(node.volume.id!==null&&node.volume.id===node.warehouse.volume.id)warnings.push(warning(node.machine,'CACHE_WAREHOUSE_SHARED_VOLUME'));
    return {...node.warehouse,originalContentBytes:complete?sum(counts.sizes):null,datasetCount:counts.complete?counts.datasets.size:null,versionCount:counts.complete?counts.versions.size:null,usageComplete:complete,warnings};
  });
  const caches=nodes.map(node=>{
    const counts=usage.get(node.machine),complete=counts.complete&&counts.sizes.every(value=>value!==null);
    return {machine:node.machine,state:node.state,volume:node.volume,readyContentBytes:complete?sum(counts.sizes):null,
      readyVersionCount:counts.complete?counts.versions.size:null,budgetBytes:node.budgetBytes,reserveBytes:node.volume.reserveBytes,usageComplete:complete};
  });
  // Count logical original versions once even if the same immutable tuple has
  // several warehouse copies. Physical volume bytes are never summed from
  // dataset content, cache budgets, bind roots or workspace quota reports.
  const uniqueOriginals=new Map(),originalDatasets=new Set();
  for(const item of datasets)for(const version of item.versions)if(version.originals.some(row=>row.state==='READY')){
    uniqueOriginals.set(item.dataset+'@'+version.version,version.contentBytes);originalDatasets.add(item.dataset);
  }
  const warehouseKnown=nodes.every(node=>node.warehouseKnown),warehouseComplete=warehouseKnown&&warehouses.every(row=>row.state==='READY'&&row.usageComplete);
  const physicalVolumes=[],seen=new Set();
  for(const node of nodes)for(const volume of [node.volume,node.warehouse?.volume].filter(Boolean)){
    if(volume.id===null||seen.has(volume.id))continue;
    seen.add(volume.id);physicalVolumes.push({machine:node.machine,...volume});
  }
  return {protocol:'dataset-storage-overview-v1',checkedAt:new Date().toISOString(),partial:catalog.partial||nodes.some(node=>node.state!=='READY'||!node.warehouseKnown||node.warehouse&&node.warehouse.state!=='READY'),
    filePreviewAvailable:false,physicalVolumes,
    warehouse:{state:warehouses.length?(warehouseComplete?'READY':'UNKNOWN'):(warehouseKnown?'NOT_CONFIGURED':'UNKNOWN'),volumes:warehouses,
      originalContentBytes:warehouseComplete?sum([...uniqueOriginals.values()]):null,datasetCount:warehouseComplete?originalDatasets.size:null,versionCount:warehouseComplete?uniqueOriginals.size:null,
      warnings:[...warehouses.flatMap(row=>row.warnings),...nodes.filter(node=>!node.warehouseKnown).map(node=>warning(node.machine,'WAREHOUSE_FACTS_UNAVAILABLE'))]},caches,datasets};
}
