// Data only: consume the portal's permission-filtered catalog. Do not guess
// ownership, a latest version, cache release, capacity or training admission.
import {databaseSummary} from './dataset-flow.js';
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
const same=values=>values.every(value=>value===values[0])?values[0]:null;
const knownNumber=(rows,key)=>{
  const values=rows.map(row=>number(row[key])).filter(value=>value!==null);
  return values.length?same(values):null;
};

function warehouse(version,locations){
  const result=databaseSummary({version,locations});
  return {state:result.kind==='none'?'unrecorded':result.kind,phase:result.phase,
    machine:result.machine,originalConfirmed:result.saved,
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
    error:location?text(location.error):null,storage:location?copy(location.storage):null,
    ...(!conflict&&['hdd','ssd'].includes(location?.storageTier)?{storageTier:location.storageTier}:{}),
    ...(!conflict&&location?.storageRole==='personal-original'?{storageRole:location.storageRole}:{})};
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
    checkedAt:copy(catalog.checkedAt),machines:[...machines].map(([machine,state])=>({machine,state})),
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
          return {version,bytes:knownNumber(observations,'bytes'),files:knownNumber(observations,'files'),
            canUse:observations.every(row=>row.canUse===true),
            ownerLabel:same(observations.map(row=>text(row.ownerLabel))),servers,
            selected:{machine:catalog.machine??null,state:selected.state,canPrepare:selected.canPrepare,canUse:selected.canUse===true,
              ...(selected.storageRole==='personal-original'?{storageRole:selected.storageRole}:{}),
              ...(['hdd','ssd'].includes(selected.storageTier)?{storageTier:selected.storageTier}:{}),
              sourceMachine,sourceDataset:sourceMachine?same(observations.map(row=>text(row.sourceDataset))):null,
              error:same(observations.map(row=>text(row.error)))},warehouse:warehouse(version,locations)};
        })};
    })};
}

// Contract pending finalization: a READY state alone is not warehouse proof.
// Keep this boundary small so a finalized proof field can be adopted here.
export function adaptOriginal(raw){
  const proof=raw?.proof;
  return {machine:identifier.test(raw?.machine||'')?raw.machine:null,
    dataset:identifier.test(raw?.dataset||'')?raw.dataset:null,
    canUse:raw?.canUse===true,
    state:text(raw?.state),confirmed:raw?.confirmed===true||
      !!proof&&typeof proof==='object'&&!Array.isArray(proof)&&Object.keys(proof).length>0};
}

export function adaptStorageOverview(raw){
  if(raw?.protocol!=='dataset-storage-overview-v1'||!Array.isArray(raw.warehouse?.volumes)||
    !Array.isArray(raw.caches)||!Array.isArray(raw.datasets))return null;
  const volume=value=>({id:text(value?.id),state:text(value?.state),checkedAt:copy(value?.checkedAt),
    ...Object.fromEntries(['totalBytes','usedBytes','availableBytes','reserveBytes','usableBytes'].map(key=>[key,number(value?.[key])])),
    readOnly:value?.readOnly===true,guarded:value?.guarded===true});
  const volumes=new Map();let unidentified=false;
  for(const row of raw.warehouse.volumes){
    if(!identifier.test(row?.machine||'')||!text(row?.volume?.id)){unidentified=true;continue;}
    const value={machine:row.machine,volume:volume(row.volume),contentBytes:number(row.originalContentBytes),warnings:list(row.warnings)},key=JSON.stringify([value.machine,value.volume.id]);
    if(volumes.has(key)&&JSON.stringify(volumes.get(key))!==JSON.stringify(value)){
      const previous=volumes.get(key);previous.contentBytes=null;
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
  const known=totalBytes!==null&&totalBytes>0&&usedBytes!==null&&usedBytes<=totalBytes&&availableBytes!==null&&usedBytes+availableBytes<=totalBytes&&contentBytes!==null&&contentBytes<=usedBytes;
  const caches=raw.caches.filter(row=>identifier.test(row?.machine||'')).map(row=>({machine:row.machine,state:text(row.state),volume:volume(row.volume),
    readyContentBytes:number(row.readyContentBytes),readyVersionCount:number(row.readyVersionCount),budgetBytes:number(row.budgetBytes),reserveBytes:number(row.reserveBytes),usageComplete:row.usageComplete===true,
    shared:!!text(row.volume?.id)&&volumes.has(JSON.stringify([row.machine,row.volume.id]))}));
  return {protocol:raw.protocol,checkedAt:copy(raw.checkedAt),partial:raw.partial===true,filePreviewAvailable:raw.filePreviewAvailable===true,
    warehouse:{volumes:rows,totalBytes,usedBytes,availableBytes,contentBytes,reserveBytes,known,
      warning:list(raw.warehouse.warnings).concat(rows.flatMap(row=>row.warnings)).some(row=>['WAREHOUSE_USAGE_HIGH','WAREHOUSE_FREE_SPACE_LOW'].includes(row?.code))||availableBytes!==null&&reserveBytes!==null&&availableBytes<=reserveBytes},
    caches,datasets:raw.datasets.filter(item=>identifier.test(item?.dataset||'')).map(item=>({dataset:item.dataset,displayName:text(item.displayName),
      versions:list(item.versions).filter(row=>hash.test(row?.version||'')).map(row=>({version:row.version,ownerLabel:text(row.ownerLabel),contentBytes:number(row.contentBytes),fileCount:number(row.fileCount),canUse:row.canUse===true,
        originals:list(row.originals).map(adaptOriginal),caches:list(row.caches).filter(cache=>identifier.test(cache?.machine||'')).map(cache=>({machine:cache.machine,dataset:identifier.test(cache.dataset||'')?cache.dataset:null,state:state(cache.state),canUse:cache.canUse===true,canPrepare:cache.canPrepare===true,ownerLabel:text(cache.ownerLabel)})),
        ...(Array.isArray(row.personalOriginals)?{personalOriginals:row.personalOriginals.filter(location=>identifier.test(location?.machine||'')&&identifier.test(location.dataset||'')&&location.storageRole==='personal-original'&&['hdd','ssd'].includes(location.storageTier)).map(location=>({machine:location.machine,dataset:location.dataset,state:state(location.state),canUse:location.canUse===true,canPrepare:false,storageRole:'personal-original',storageTier:location.storageTier}))}:{})}))}))};
}

// Overview and legacy catalog are observations, not action permissions. The
// overview owns its warehouse proof; keep legacy labels/revisions separately.
export function overviewDatasetCatalog(overview,machine,legacy=null){
  const machines=[...new Set(overview.caches.map(row=>row.machine).concat(overview.datasets.flatMap(item=>item.versions.flatMap(v=>v.originals.map(row=>row.machine).filter(Boolean)))))];
  const catalog={machine:machine||null,checkedAt:overview.checkedAt,partial:overview.partial,machines:machines.map(id=>({machine:id,state:['READY','ok'].includes(overview.caches.find(row=>row.machine===id)?.state)?'ok':'unavailable'})),
    datasets:overview.datasets.map(item=>{
      const old=legacy?.datasets?.find(row=>row.dataset===item.dataset);
      return {dataset:item.dataset,name:old?.name,labelScope:old?.labelScope,displayNameRevision:old?.displayNameRevision,
        versions:item.versions.map(v=>{const locations=[...v.caches,...(v.personalOriginals||[])],local=locations.find(row=>row.machine===machine),node=overview.caches.find(row=>row.machine===machine),known=node?.state==='READY'&&node.usageComplete===true;return {version:v.version,ownerLabel:v.ownerLabel,
          canUse:v.canUse===true||locations.some(row=>row.canUse===true)||v.originals.some(row=>row.canUse===true),bytes:v.contentBytes,files:v.fileCount,
          state:local?.state||(known?'NOT_LOCAL':'UNKNOWN'),canPrepare:local?.canPrepare===true,locations:locations.map(row=>({...row}))};})};
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
