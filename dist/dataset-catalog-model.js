// Data only: consume the portal's permission-filtered catalog. Do not guess
// ownership, a latest version, cache release, capacity or training admission.
import {databaseSummary,projectLowerBoundFacts} from './dataset-flow.js';
import {defaultDatasetDisplayName} from './dataset-display-name.js';
export function datasetOwnerName(label){
  if(typeof label!=='string')return '未知';
  const name=label.trim().replace(/^(?:所属用户|共享授权用户)\s*[:：]\s*/, '').trim();
  return !name||name==='所属未知'?'未知':name;
}

// This is a main-view filter, not a grant. Backend reads/actions retain their
// own checks; the full model is still available to the storage admin console.
export function readableDatasetCatalog(model,principal){
  const username=typeof principal?.username==='string'?principal.username:null;
  const owns=label=>username&&typeof label==='string'&&/^(?:所属用户|共享授权用户)\s*[:：]/.test(label)&&
    datasetOwnerName(label).split('、').some(name=>name.trim()===username);
  return {...model,datasets:(model?.datasets||[]).flatMap(item=>{
    if(!principal?.userId)return [];
    const versions=principal.role==='admin'?item.versions:item.versions.filter(version=>
      version.canUse===true||owns(version.ownerLabel)||version.servers?.some(row=>owns(row.ownerLabel)));
    return versions.length?[{...item,versions}]:[];
  })};
}

const identifier=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const hash=/^[a-f0-9]{64}$/;
const states=new Set(['READY','REGISTERED','STAGING','PREPARING','FAILED','NOT_LOCAL','UNKNOWN']);
const state=value=>states.has(value)?value:'UNKNOWN';
const list=value=>Array.isArray(value)?value:[];
const text=value=>typeof value==='string'&&value?value:null;
const number=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const copy=value=>value===undefined?null:structuredClone(value);
export const STORAGE_READING_MAX_AGE_MS=10*60*1000;
// Display-only memory: it never contains ACLs, READY locations or capabilities.
export function createStorageDisplayHistory({now=Date.now}={}){
  let scope=null;const kinds=new Map(),warehouses=new Set();
  const group=kind=>{if(!kinds.has(kind))kinds.set(kind,new Map());return kinds.get(kind);};
  const entry=(kind,key)=>{const rows=group(kind);if(!rows.has(key))rows.set(key,{fields:new Map(),pending:true,completed:false,failed:false,meta:{}});return rows.get(key);};
  const get=(value,path)=>path.split('.').reduce((value,key)=>value?.[key],value);
  const put=(value,path,next)=>{const keys=path.split('.'),last=keys.pop();let target=value;for(const key of keys)target=target[key]??={};target[last]=next;};
  return {
    use(identity){if(identity!==scope){scope=identity;kinds.clear();warehouses.clear();}return this;},
    confirmWarehouse(machine){if(identifier.test(machine||''))warehouses.add(machine);},
    warehouses(){return [...warehouses];},
    forget(kind){kinds.delete(kind);},
    begin(kind,keys=[]){entry(kind,'@status').pending=true;for(const key of keys)entry(kind,key).pending=true;},
    fail(kind,key){for(const row of key===undefined?group(kind).values():[entry(kind,key)]){row.pending=false;row.completed=true;row.failed=true;for(const field of row.fields.values())field.failed=true;}entry(kind,'@status').pending=false;entry(kind,'@status').completed=true;},
    observe(kind,key,value,fields,collectedAt=null){
      const row=entry(kind,key);row.pending=false;row.completed=true;row.failed=false;row.meta=copy(value);entry(kind,'@status').pending=false;entry(kind,'@status').completed=true;
      for(const path of fields){
        const measured=number(get(value,path)),previous=row.fields.get(path);
        if(measured===null){if(previous)previous.failed=true;continue;}
        const signature=JSON.stringify([measured,collectedAt]);
        row.fields.set(path,{value:measured,collectedAt,at:previous?.signature===signature&&collectedAt!==null?previous.at:now(),signature,failed:false,context:row.meta});
      }
    },
    keys(kind){return [...group(kind).keys()].filter(key=>key!=='@status');},
    project(kind,key,current,fields){
      const row=entry(kind,key),value=copy(current??row.meta),used=[];let stale=false;
      for(const path of fields){
        const record=row.fields.get(path),recent=record&&(now()-record.at<STORAGE_READING_MAX_AGE_MS||['warehouse','training','catalog-list'].includes(kind));
        put(value,path,recent?record.value:!record&&!row.failed?number(get(current,path)):null);
        if(recent){used.push(record);stale ||= row.failed||record.failed||now()-record.at>=STORAGE_READING_MAX_AGE_MS;
          if(path.startsWith('volume.')){value.volume.collectedAt=record.context.volume?.collectedAt??record.collectedAt;value.volume.timestamp=record.context.volume?.timestamp??null;}
          if(['totalBytes','usedBytes','availableBytes'].includes(path))value.timestamp=record.context.timestamp??null;
          if(['contentBytes','datasetCount','readyContentBytes','readyVersionCount'].includes(path))value.catalogCollectedAt=record.collectedAt;
          if(['contentBytes','readyContentBytes'].includes(path))value.usageComplete=record.context.usageComplete;
        }
      }
      const times=used.map(row=>row.collectedAt).filter(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)));
      value.collectedAt=times.length?times.reduce((a,b)=>Date.parse(a)<Date.parse(b)?a:b):null;
      value.stale=stale||current?.stale===true;value.loading=!used.length&&(row.pending||['warehouse','training','catalog-list'].includes(kind)&&row.failed)&&fields.every(path=>number(get(value,path))===null);return value;
    },
    loading(kind){const row=entry(kind,'@status');return row.pending&&!row.completed;},
    nextExpiry(){const deadlines=[...kinds.values()].flatMap(rows=>[...rows.values()].flatMap(row=>[...row.fields.values()].map(value=>value.at+STORAGE_READING_MAX_AGE_MS))).filter(time=>time>now());return deadlines.length?Math.min(...deadlines)-now():null;}
  };
}
const displayHistories=new WeakMap();
export function storageDisplayHistory(store){
  if(!displayHistories.has(store))displayHistories.set(store,createStorageDisplayHistory());
  return displayHistories.get(store).use(JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]));
}
export const WAREHOUSE_READING_FIELDS=['totalBytes','usedBytes','availableBytes','reserveBytes','contentBytes','datasetCount'];
export const TRAINING_READING_FIELDS=['volume.totalBytes','volume.usedBytes','volume.availableBytes','volume.reserveBytes','volume.usableBytes','readyContentBytes','readyVersionCount','budgetBytes'];
export const STORAGE_OVERVIEW_TIMEOUT_MS=20000;
export async function readStorageOverview(store,{signal}={}){
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  let timer;
  try{return await Promise.race([
    store.call('datasets.overview',{},{signal:controller.signal}),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('存储总览超时'));},STORAGE_OVERVIEW_TIMEOUT_MS);})
  ]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
const same=values=>values.every(value=>value===values[0])?values[0]:null;
const knownNumber=(rows,key)=>{
  const values=rows.map(row=>number(row[key])).filter(value=>value!==null);
  return values.length?same(values):null;
};

function warehouse(version,locations){
  const result=databaseSummary({version,locations});
  const confirmed=locations.some(row=>row.warehouseReady===true);
  return {state:result.saved&&!confirmed?'unknown':result.kind==='none'?'unrecorded':result.kind,phase:result.phase,
    machine:result.machine,originalConfirmed:confirmed,
    locations:locations.filter(row=>row.warehouseReady===true).map(row=>({machine:row.machine,confirmed:true,state:'READY'})),
    records:locations.filter(row=>row.storage&&typeof row.storage==='object')
      .map(row=>({machine:row.machine,dataset:text(row.dataset),storage:copy(row.storage)}))};
}

function server(machine,directory,locations,observations,selectedMachine){
  const rows=locations.filter(row=>row.machine===machine);
  const unique=new Map(rows.map(row=>[JSON.stringify(row),row]));
  const conflict=unique.size>1,location=unique.size===1?[...unique.values()][0]:null;
  // Transfer state can exist before a local catalog row. Only a confirmed
  // node's selected-machine view may establish absence/preparation here.
  const selectedStates=observations.map(row=>state(row.state));
  const selectedState=selectedStates.length?same(selectedStates):null;
  let observedState=location?state(location.state):directory==='ok'?'NOT_LOCAL':'UNKNOWN';
  if(machine===selectedMachine&&directory==='ok'){
    // The portal overlays active transfers on a REGISTERED/NOT_LOCAL row.
    // READY still requires the same node's confirmed physical copy.
    observedState=selectedState==='READY'?
      location?.state==='READY'?'READY':'UNKNOWN':selectedState||'UNKNOWN';
  }
  return {machine,directoryState:directory,observed:rows.length>0,conflict,
    state:conflict?'UNKNOWN':observedState,dataset:location?text(location.dataset):null,
    canUse:!conflict&&observations.every(row=>row.canUse===true)&&location?.canUse===true,
    deletionPermissions:!conflict&&location?.deletionPermissions?copy(location.deletionPermissions):null,
    ownerLabel:location?text(location.ownerLabel):null,
    canPrepare:!conflict&&(machine===selectedMachine?
      observations.every(row=>row.canPrepare===true):location?.canPrepare===true),
    removalPending:rows.some(row=>row.removalPending===true),
    removalGraceEligible:!conflict&&location?.removalGraceEligible===true,
    error:location?text(location.error):null,storage:location?copy(location.storage):null};
}

export function aggregateDatasetCatalog(catalog){
  if(!catalog||catalog.machine!==null&&(typeof catalog.machine!=='string'||!identifier.test(catalog.machine))||!Array.isArray(catalog.datasets)||!Array.isArray(catalog.machines))
    throw TypeError('A confirmed portal catalog and selected machine are required');
  const machines=new Map(),datasets=new Map();
  for(const row of catalog.machines){
    if(!identifier.test(row?.machine||''))throw TypeError('Invalid catalog machine');
    const value=row.state==='ok'?'ok':'unavailable';
    machines.set(row.machine,machines.has(row.machine)&&machines.get(row.machine)!==value?'unavailable':value);
  }
  if(catalog.machine!=null&&!machines.has(catalog.machine))machines.set(catalog.machine,'unavailable');
  for(const item of catalog.datasets){
    if(!identifier.test(item?.dataset||'')||!Array.isArray(item.versions))throw TypeError('Invalid catalog dataset');
    if(!datasets.has(item.dataset))datasets.set(item.dataset,{items:[],versions:new Map()});
    const group=datasets.get(item.dataset);group.items.push(item);
    for(const version of item.versions){
      if(!hash.test(version?.version||'')||!Array.isArray(version.locations))throw TypeError('Invalid full dataset version');
      if(!group.versions.has(version.version))group.versions.set(version.version,[]);
      group.versions.get(version.version).push(version);
      for(const row of version.locations){
        if(!identifier.test(row?.machine||''))throw TypeError('Invalid version location');
        if(!machines.has(row.machine))machines.set(row.machine,'unavailable');
      }
    }
  }
  return {machine:catalog.machine??null,partial:catalog.partial===true||[...machines.values()].some(value=>value!=='ok'),
    // Preserve a supplied timestamp; never manufacture freshness on refresh.
    checkedAt:copy(catalog.checkedAt),loading:catalog.loading===true,stale:catalog.stale===true,machines:[...machines].map(([machine,state])=>({machine,state})),
    datasets:[...datasets].map(([dataset,group])=>{
      const names=group.items.map(row=>row.labelScope==='personal'?text(row.name):null);
      const revisions=group.items.map(row=>number(row.displayNameRevision));
      const name=same(names),revision=same(revisions),labelKnown=!!name&&revision!==null;
      return {dataset,displayName:labelKnown&&!(revision===0&&name===dataset)?name:defaultDatasetDisplayName(dataset),
        displayNameRevision:labelKnown?revision:null,labelScope:labelKnown?'personal':null,
        versions:[...group.versions].map(([version,observations])=>{
          const locations=observations.flatMap(row=>row.locations),servers=[...machines].map(([machine,directory])=>
            server(machine,directory,locations,observations,catalog.machine));
          const selected=servers.find(row=>row.machine===catalog.machine)||{machine:null,state:'UNKNOWN',canPrepare:false};
          const sourceMachine=same(observations.map(row=>text(row.sourceMachine)));
          return {dataset,version,bytes:knownNumber(observations,'bytes'),files:knownNumber(observations,'files'),
            canUse:observations.every(row=>row.canUse===true),
            ownerLabel:same(observations.map(row=>text(row.ownerLabel))),servers,
            selected:{machine:catalog.machine??null,state:selected.state,canPrepare:selected.canPrepare,canUse:selected.canUse===true,
              sourceMachine,sourceDataset:sourceMachine?same(observations.map(row=>text(row.sourceDataset))):null,
              error:same(observations.map(row=>text(row.error)))},warehouse:warehouse(version,locations)};
        })};
    })};
}

// Only the finalized explicit node fact proves this version is in a warehouse.
export function adaptOriginal(raw){
  return {machine:identifier.test(raw?.machine||'')?raw.machine:null,
    dataset:identifier.test(raw?.dataset||'')?raw.dataset:null,
    state:text(raw?.state),confirmed:raw?.warehouseReady===true,
    warehouseReady:raw?.warehouseReady===true,canUse:raw?.canUse===true};
}

// Originals belong to this exact logical dataset/full version. Physical
// presence alone is not a reading grant, and never proves a READY cache.
export function hasReadableLocalOriginal(version,machine){
  if(!identifier.test(version?.dataset||'')||!hash.test(version?.version||'')||
    !identifier.test(machine||'')||version.canUse!==true)return false;
  const rows=list(version.originals??version.warehouse?.originals).filter(row=>
    row.machine===machine&&row.dataset===version.dataset);
  return rows.length>0&&rows.every(row=>row.state==='READY'&&row.warehouseReady===true&&row.canUse===true);
}

export function adaptStorageOverview(raw){
  if(raw?.protocol!=='dataset-storage-overview-v1'||!Array.isArray(raw.warehouse?.volumes)||
    !Array.isArray(raw.caches)||!Array.isArray(raw.datasets))return null;
  const unconfirmed=new Map();
  for(const item of raw.datasets)for(const version of list(item.versions))for(const cache of list(version.caches)){
    if(state(cache.state)!=='UNKNOWN')continue;
    let versions=unconfirmed.get(cache.machine);
    if(!versions){versions=new Set();unconfirmed.set(cache.machine,versions);}
    versions.add(JSON.stringify([cache.dataset||item.dataset,version.version]));
  }
  const volume=value=>({id:text(value?.id),state:text(value?.state),checkedAt:copy(value?.checkedAt),collectedAt:copy(value?.collectedAt),timestamp:value?.timestamp==='rpc'?'rpc':null,
    ...Object.fromEntries(['totalBytes','usedBytes','availableBytes','reserveBytes','usableBytes'].map(key=>[key,number(value?.[key])])),
    readOnly:value?.readOnly===true,guarded:value?.guarded===true});
  const volumes=new Map();let unidentified=false;
  for(const row of raw.warehouse.volumes){
    if(!identifier.test(row?.machine||'')||!text(row?.volume?.id)){unidentified=true;continue;}
    const value={machine:row.machine,volume:volume(row.volume),contentBytes:number(row.originalContentBytes),datasetCount:number(row.datasetCount),usageComplete:row.usageComplete===true,loading:row.loading===true,stale:row.stale===true,catalogCollectedAt:copy(row.collectedAt),warnings:list(row.warnings)},key=JSON.stringify([value.machine,value.volume.id]);
    if(volumes.has(key)&&JSON.stringify(volumes.get(key))!==JSON.stringify(value)){
      const previous=volumes.get(key);previous.contentBytes=null;previous.datasetCount=null;
      for(const field of ['totalBytes','usedBytes','availableBytes','reserveBytes','usableBytes'])previous.volume[field]=null;
      previous.warnings.push(...value.warnings);
    }else volumes.set(key,value);
  }
  const rows=[...volumes.values()],sum=field=>{
    if(raw.warehouse.state!=='READY')return null;
    const values=rows.map(row=>field==='contentBytes'?row.contentBytes:row.volume[field]);
    const total=values.reduce((result,value)=>result+(value??0),0);
    return !unidentified&&values.length&&values.every(value=>value!==null)&&Number.isSafeInteger(total)?total:null;
  };
  const totalBytes=sum('totalBytes'),usedBytes=sum('usedBytes'),availableBytes=sum('availableBytes'),contentBytes=sum('contentBytes'),reserveBytes=sum('reserveBytes');
  const known=totalBytes!==null&&totalBytes>0&&usedBytes!==null&&usedBytes<=totalBytes&&availableBytes!==null&&usedBytes+availableBytes<=totalBytes&&contentBytes!==null;
  const caches=raw.caches.filter(row=>identifier.test(row?.machine||'')).map(row=>({machine:row.machine,state:text(row.state),reason:text(row.reason),volume:volume(row.volume),
    contentLoading:row.loading===true,stale:row.stale===true,catalogCollectedAt:copy(row.catalogCollectedAt),readyContentBytes:number(row.readyContentBytes),readyVersionCount:number(row.readyVersionCount),budgetBytes:number(row.budgetBytes),reserveBytes:number(row.reserveBytes),usageComplete:row.usageComplete===true,
    usageReason:row.usageComplete===true?null:unconfirmed.get(row.machine)?.size?unconfirmed.get(row.machine).size+' 个缓存版本尚未确认':'缓存目录或大小尚未完整确认',
    projectBytes:number(row.projectBytes),projectUsageComplete:typeof row.projectUsageComplete==='boolean'?row.projectUsageComplete:null,projectCollectedAt:copy(row.projectCollectedAt),
    projectUsageReason:text(row.projectUsageReason),budgetReason:text(row.budgetReason),warehouseState:text(row.warehouseState),warehouseReason:text(row.warehouseReason),
    ...projectLowerBoundFacts(row),
    shared:!!text(row.volume?.id)&&volumes.has(JSON.stringify([row.machine,row.volume.id]))}));
  return {protocol:raw.protocol,checkedAt:copy(raw.checkedAt),partial:raw.partial===true,loading:raw.loading===true,refreshing:raw.refreshing===true,stale:raw.stale===true,filePreviewAvailable:raw.filePreviewAvailable===true,
    warehouse:{volumes:rows,totalBytes,usedBytes,availableBytes,contentBytes,reserveBytes,known,
      warning:list(raw.warehouse.warnings).concat(rows.flatMap(row=>row.warnings)).some(row=>['WAREHOUSE_USAGE_HIGH','WAREHOUSE_FREE_SPACE_LOW'].includes(row?.code))||availableBytes!==null&&reserveBytes!==null&&availableBytes<=reserveBytes},
    caches,datasets:raw.datasets.filter(item=>identifier.test(item?.dataset||'')).map(item=>({dataset:item.dataset,displayName:text(item.displayName),
      versions:list(item.versions).filter(row=>hash.test(row?.version||'')).map(row=>({version:row.version,ownerLabel:text(row.ownerLabel),contentBytes:number(row.contentBytes),fileCount:number(row.fileCount),canUse:row.canUse===true,
        originals:list(row.originals).map(adaptOriginal),caches:list(row.caches).filter(cache=>identifier.test(cache?.machine||'')).map(cache=>({machine:cache.machine,dataset:identifier.test(cache.dataset||'')?cache.dataset:null,state:state(cache.state),canUse:cache.canUse===true,canPrepare:cache.canPrepare===true,ownerLabel:text(cache.ownerLabel)}))}))}))};
}

// Display facts from the existing, readable catalog and public capacity route.
// This fallback never creates an overview protocol, warehouse proof or action
// capability. A cache filesystem is not a warehouse volume or a cache budget.
export function displayStorageCapacity(overview,model,capacities=new Map(),machines=[]){
  const versions=list(model?.datasets).flatMap(item=>item.versions);
  const sum=values=>{
    if(values.some(value=>number(value)===null))return null;
    const total=values.reduce((result,value)=>result+value,0);
    return number(total);
  };
  const contentBytes=model?sum(versions.map(row=>row.bytes)):null;
  const emptyVolume=()=>({id:null,state:'UNKNOWN',checkedAt:null,totalBytes:null,usedBytes:null,
    availableBytes:null,reserveBytes:null,usableBytes:null,readOnly:null,guarded:false});
  const nodes=[...new Set(list(machines).map(row=>row.id).concat(list(model?.machines).map(row=>row.machine),list(overview?.caches).map(row=>row.machine)))].filter(id=>identifier.test(id||''));
  const caches=nodes.map(machine=>{
    const capacity=capacities.get(machine),total=number(capacity?.filesystemBytes),available=number(capacity?.availableBytes);
    const volume=capacity?.available===true&&total!==null&&available!==null&&available<=total?
      {...emptyVolume(),state:'READY',totalBytes:total,usedBytes:total-available,availableBytes:available,
        checkedAt:copy(capacity.checkedAt),collectedAt:copy(capacity.collectedAt),timestamp:capacity.timestamp==='rpc'?'rpc':null,
        reserveBytes:number(capacity.reserveBytes),usableBytes:number(capacity.usableBytes),guarded:capacity.guarded===true}:emptyVolume();
    const directory=list(model?.machines).find(row=>row.machine===machine)?.state==='ok';
    const ready=versions.filter(v=>v.servers.some(row=>row.machine===machine&&row.observed&&row.state==='READY'));
    const values=ready.map(v=>number(v.bytes)),complete=directory&&model?.capacityUsageComplete!==false&&values.every(value=>value!==null)&&
      !versions.some(v=>v.servers.some(row=>row.machine===machine&&row.state==='UNKNOWN'));
    const subtotal=ready.length&&values.every(value=>value===null)?null:sum(values.filter(value=>value!==null));
    const facts=capacity?.available===true&&capacity?.storageOverview?.protocol==='dataset-storage-node-v1'?capacity.storageOverview:null;
    const projectCollectedAt=typeof facts?.cache?.projectCollectedAt==='string'&&Number.isFinite(Date.parse(facts.cache.projectCollectedAt))?facts.cache.projectCollectedAt:null;
    const projectUsageComplete=facts?.cache?.projectUsageComplete===true&&number(facts.cache.projectBytes)!==null&&projectCollectedAt!==null;
    const fallback={machine,state:volume.state,volume,readyContentBytes:directory?subtotal:null,projectBytes:null,projectUsageComplete:null,projectCollectedAt:null,
      ...projectLowerBoundFacts(facts?.cache),
      readyVersionCount:directory?ready.length:null,budgetBytes:number(facts?.cache?.budgetBytes),reserveBytes:volume.reserveBytes,
      budgetReason:text(facts?.cache?.budgetReason),projectUsageReason:text(facts?.cache?.projectUsageReason),
      warehouseState:facts?.warehouse===null?'NOT_CONFIGURED':facts?.warehouse?.state==='READY'?'READY':'UNKNOWN',warehouseReason:text(facts?.warehouseReason),
      usageComplete:complete,shared:false};
    if(facts)Object.assign(fallback,{projectBytes:projectUsageComplete?facts.cache.projectBytes:null,projectUsageComplete,projectCollectedAt});
    const actual=overview?.caches.find(row=>row.machine===machine);
    if(!actual)return fallback;
    const result={...actual,volume:{...actual.volume}};
    if(actual.readyContentBytes===null){result.readyContentBytes=fallback.readyContentBytes;result.usageComplete=fallback.usageComplete;}
    else if(actual.usageComplete===false&&fallback.readyContentBytes!==null&&fallback.readyContentBytes>actual.readyContentBytes)result.readyContentBytes=fallback.readyContentBytes;
    if(actual.readyVersionCount===null)result.readyVersionCount=fallback.readyVersionCount;
    // A failed overview read cannot discard a newer successful public node read.
    if(actual.state==='UNKNOWN'&&facts){
      for(const field of ['budgetBytes','budgetReason','projectBytes','projectUsageComplete','projectCollectedAt','projectUsageReason','lowerBoundBytes','permissionDeniedCount','permissionDeniedClasses','warehouseState','warehouseReason'])result[field]=fallback[field];
    }
    const newer=Number.isFinite(Date.parse(volume.collectedAt))&&Date.parse(volume.collectedAt)>Date.parse(actual.volume.collectedAt);
    for(const field of ['totalBytes','usedBytes','availableBytes','reserveBytes','usableBytes'])if(result.volume[field]===null&&(!actual.volume.collectedAt||newer))result.volume[field]=volume[field];
    if(newer&&result.volume.totalBytes!==null){result.volume.collectedAt=volume.collectedAt;result.volume.checkedAt=volume.checkedAt;result.volume.timestamp=volume.timestamp;}
    return result;
  });
  const warehouse=overview?{...overview.warehouse}:{volumes:[],totalBytes:null,usedBytes:null,availableBytes:null,
    contentBytes:null,reserveBytes:null,known:false,warning:false};
  if(warehouse.contentBytes===null)warehouse.contentBytes=contentBytes;
  warehouse.known=warehouse.totalBytes>0&&warehouse.usedBytes!==null&&warehouse.usedBytes<=warehouse.totalBytes&&
    warehouse.availableBytes!==null&&warehouse.usedBytes+warehouse.availableBytes<=warehouse.totalBytes&&warehouse.contentBytes!==null;
  return {warehouse,caches,checkedAt:overview?.checkedAt??model?.checkedAt??null,partial:overview?.partial===true||model?.partial===true};
}

// Locations are metadata, not an action grant. Keep confirmation separate
// from a named warehouse so an unconfirmed observation stays hollow in UI.
export function datasetWarehouseMachines(version){
  const w=version?.warehouse;
  const nodes=list(w?.originals).filter(row=>row.confirmed===true).map(row=>row.machine)
    .concat(list(w?.locations).filter(row=>row.confirmed===true).map(row=>row.machine),w?.originalConfirmed?[w.machine]:[]);
  return [...new Set(nodes)].filter(machine=>identifier.test(machine||''));
}

// The policy target proves no node health, capacity or write permission.
export function adaptUploadTarget(admission){
  const target=admission?.targetMachine;
  return admission?.available===true&&typeof target==='string'&&target.trim()?target:null;
}

export function warehouseStorageCards(overview,model,capacities=new Map(),contentCatalog=model,admission=null){
  const content=new Map(list(contentCatalog?.datasets).flatMap(item=>item.versions.map(version=>
    [JSON.stringify([item.dataset,version.version]),number(version.bytes)])));
  const unconfirmed=new Set(list(model?.datasets).flatMap(item=>item.versions.flatMap(v=>
    list(v.warehouse?.records).filter(row=>row.storage?.originalRetained===true&&!datasetWarehouseMachines(v).includes(row.storage.archiveMachine)).map(row=>row.storage.archiveMachine))));
  const groups=new Map(),group=machine=>{
    if(!groups.has(machine))groups.set(machine,{machine,versions:new Map(),datasets:new Set(),volumes:[]});
    return groups.get(machine);
  };
  const uploadTarget=adaptUploadTarget(admission);
  if(uploadTarget)group(uploadTarget);
  for(const item of list(model?.datasets))for(const version of item.versions)for(const machine of datasetWarehouseMachines(version)){
    const row=group(machine),key=JSON.stringify([item.dataset,version.version]);row.datasets.add(item.dataset);row.versions.set(key,number(version.bytes)??content.get(key)??null);
  }
  for(const row of list(overview?.warehouse.volumes))group(row.machine).volumes.push(row);
  // Only the explicit warehouse-role projection can supply its physical
  // volume. Top-level datasets.capacity measures the training cache disk.
  for(const [machine,capacity] of capacities)if(capacity?.storageOverview?.protocol==='dataset-storage-node-v1'&&capacity.storageOverview.warehouse)
    group(machine);
  const fields=['totalBytes','usedBytes','availableBytes','reserveBytes'];
  const sum=values=>values.length&&values.every(value=>number(value)!==null)&&number(values.reduce((n,value)=>n+value,0))!==null?
    values.reduce((n,value)=>n+value,0):null;
  return [...groups.values()].map(row=>{
    const volumes=row.volumes;
    let totals=Object.fromEntries(fields.map(field=>[field,sum(volumes.map(v=>v.volume[field]))]));
    const raw=capacities.get(row.machine)?.storageOverview?.warehouse;
    if(!volumes.length&&raw?.state==='READY'&&raw.volume){
      const v=raw.volume;totals={totalBytes:number(v.filesystemBytes),usedBytes:number(v.usedBytes),
        availableBytes:number(v.availableBytes),reserveBytes:number(v.reserveBytes)};
    }
    const valid=totals.totalBytes>0&&totals.usedBytes!==null&&totals.availableBytes!==null&&
      totals.usedBytes<=totals.totalBytes&&totals.usedBytes+totals.availableBytes<=totals.totalBytes;
    if(!valid)totals=Object.fromEntries(fields.map(field=>[field,null]));
    const actual=sum(volumes.map(v=>v.contentBytes)),values=[...row.versions.values()];
    const fallback=values.length?sum(values):null;
    const contentBytes=actual??fallback;
    const checkedAt=volumes[0]?.volume.checkedAt??raw?.volume?.checkedAt??overview?.checkedAt??model?.checkedAt??null;
    const collectedAt=volumes[0]?.volume.collectedAt??raw?.volume?.collectedAt??null;
    return {machine:row.machine,uploadTarget:row.machine===uploadTarget,...totals,contentBytes,known:valid&&contentBytes!==null,collectedAt,timestamp:volumes[0]?.volume.timestamp??raw?.volume?.timestamp??null,
      datasetCount:sum(volumes.map(v=>v.datasetCount))??(model&&!unconfirmed.has(row.machine)&&model.machines.some(m=>m.machine===row.machine&&m.state==='ok')?row.datasets.size:row.datasets.size||null),checkedAt,
      usageComplete:volumes.length?volumes.every(v=>v.usageComplete):!unconfirmed.has(row.machine)&&model?.machines.some(m=>m.machine===row.machine&&m.state==='ok')===true,
      contentLoading:volumes.some(v=>v.loading)||!model,stale:volumes.some(v=>v.stale),catalogCollectedAt:volumes[0]?.catalogCollectedAt??model?.checkedAt??null,
      warning:volumes.some(v=>list(v.warnings).some(w=>['WAREHOUSE_USAGE_HIGH','WAREHOUSE_FREE_SPACE_LOW'].includes(w?.code)))||
        valid&&(totals.usedBytes/totals.totalBytes>=.9||totals.reserveBytes!==null&&totals.availableBytes<=totals.reserveBytes)};
  });
}

// Overview and legacy catalog are observations, not action permissions. The
// overview owns its warehouse proof; keep legacy labels/revisions separately.
export function overviewDatasetCatalog(overview,machine,legacy=null){
  const machines=[...new Set(overview.caches.map(row=>row.machine).concat(overview.datasets.flatMap(item=>item.versions.flatMap(v=>v.originals.map(row=>row.machine).filter(Boolean)))))];
  const catalog={machine:machine||null,checkedAt:overview.checkedAt,partial:overview.partial,machines:machines.map(id=>{
    const directory=legacy?.machines?.find(row=>row.machine===id),cache=overview.caches.find(row=>row.machine===id);
    // A failed disk measurement does not erase a successful directory read.
    // Without that independent read, require complete node usage evidence.
    return {machine:id,state:directory?directory.state==='ok'?'ok':'unavailable':
      ['READY','ok'].includes(cache?.state)&&cache.usageComplete===true?'ok':'unavailable'};
  }),
    datasets:overview.datasets.map(item=>{
      const old=legacy?.datasets?.find(row=>row.dataset===item.dataset);
      return {dataset:item.dataset,name:old?.name,labelScope:old?.labelScope,displayNameRevision:old?.displayNameRevision,
        versions:item.versions.map(v=>{
          const local=v.caches.find(row=>row.machine===machine),oldVersion=old?.versions?.find(row=>row.version===v.version);
          // The overview lists existing locations, not an absent row for
          // every node. Only a complete catalog observation proves absence;
          // a capacity reading alone cannot turn UNKNOWN into NOT_LOCAL.
          const absent=legacy?.machines?.some(row=>row.machine===machine&&row.state==='ok')&&oldVersion&&Array.isArray(oldVersion.locations)&&
            !oldVersion.locations.some(row=>row.machine===machine);
          const selectedState=local?.state||(absent?'NOT_LOCAL':'UNKNOWN');
          // Capacity observations omit selected-target action receipts. Retain
          // an explicit catalog receipt only for this target/full version and
          // a still-readable, currently READY source or local location.
          const receipt=legacy?.machine===machine&&oldVersion?.canUse===true&&v.canUse===true&&
            legacy.machines?.some(row=>row.machine===machine&&row.state==='ok')&&oldVersion.canPrepare===true&&
            ['REGISTERED','STAGING','PREPARING','FAILED','NOT_LOCAL'].includes(selectedState);
          const source=receipt&&v.caches.find(row=>row.machine===oldVersion.sourceMachine&&row.machine!==machine&&
            row.state==='READY'&&row.canUse===true&&legacy.machines?.some(node=>node.machine===row.machine&&node.state==='ok')&&
            (!oldVersion.sourceDataset||row.dataset===oldVersion.sourceDataset));
          const localReceipt=receipt&&local?.canUse===true&&oldVersion.locations?.some(row=>
            row.machine===machine&&row.dataset===local.dataset&&row.state===selectedState&&row.canUse===true);
          return {version:v.version,ownerLabel:v.ownerLabel,canUse:v.canUse,bytes:v.contentBytes,files:v.fileCount,
          state:selectedState,canPrepare:local?.canPrepare===true||!!source||!!localReceipt,
          ...(source?{sourceMachine:source.machine,sourceDataset:oldVersion.sourceDataset}:{}),locations:v.caches.map(row=>({...row}))};})};
    })};
  const result=aggregateDatasetCatalog(catalog);
  for(const item of result.datasets){
    const observation=overview.datasets.find(row=>row.dataset===item.dataset);if(observation.displayName)item.displayName=observation.displayName;
    for(const v of item.versions){const originals=observation.versions.find(row=>row.version===v.version).originals,nodes=[...new Set(originals.map(row=>row.machine).filter(Boolean))];
      v.warehouse={state:originals.some(row=>row.confirmed)?'saved':originals.length?'unknown':'unrecorded',originalConfirmed:originals.some(row=>row.confirmed),machine:nodes.length===1?nodes[0]:null,originals,records:[]};
    }
  }
  return result;
}
