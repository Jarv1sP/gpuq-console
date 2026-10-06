// Data only: consume the portal's permission-filtered catalog. Do not guess
// ownership, a latest version, cache release, capacity or training admission.
import {databaseSummary} from './dataset-flow.js';

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
    ownerLabel:location?text(location.ownerLabel):null,
    canPrepare:!conflict&&(machine===selectedMachine?
      observations.every(row=>row.canPrepare===true):location?.canPrepare===true),
    removalPending:rows.some(row=>row.removalPending===true),
    removalGraceEligible:!conflict&&location?.removalGraceEligible===true,
    error:location?text(location.error):null,storage:location?copy(location.storage):null};
}

export function aggregateDatasetCatalog(catalog){
  if(!catalog||!identifier.test(catalog.machine||'')||!Array.isArray(catalog.datasets)||!Array.isArray(catalog.machines))
    throw TypeError('A confirmed portal catalog and selected machine are required');
  const machines=new Map(),datasets=new Map();
  for(const row of catalog.machines){
    if(!identifier.test(row?.machine||''))throw TypeError('Invalid catalog machine');
    const value=row.state==='ok'?'ok':'unavailable';
    machines.set(row.machine,machines.has(row.machine)&&machines.get(row.machine)!==value?'unavailable':value);
  }
  if(!machines.has(catalog.machine))machines.set(catalog.machine,'unavailable');
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
  return {machine:catalog.machine,partial:catalog.partial===true||[...machines.values()].some(value=>value!=='ok'),
    // Preserve a supplied timestamp; never manufacture freshness on refresh.
    checkedAt:copy(catalog.checkedAt),machines:[...machines].map(([machine,state])=>({machine,state})),
    datasets:[...datasets].map(([dataset,group])=>{
      const names=group.items.map(row=>row.labelScope==='personal'?text(row.name):null);
      const revisions=group.items.map(row=>number(row.displayNameRevision));
      const name=same(names),revision=same(revisions),labelKnown=!!name&&revision!==null;
      return {dataset,displayName:labelKnown?name:dataset,
        displayNameRevision:labelKnown?revision:null,labelScope:labelKnown?'personal':null,
        versions:[...group.versions].map(([version,observations])=>{
          const locations=observations.flatMap(row=>row.locations),servers=[...machines].map(([machine,directory])=>
            server(machine,directory,locations,observations,catalog.machine));
          const selected=servers.find(row=>row.machine===catalog.machine);
          const sourceMachine=same(observations.map(row=>text(row.sourceMachine)));
          return {version,bytes:knownNumber(observations,'bytes'),files:knownNumber(observations,'files'),
            ownerLabel:same(observations.map(row=>text(row.ownerLabel))),servers,
            selected:{machine:catalog.machine,state:selected.state,canPrepare:selected.canPrepare,
              sourceMachine,sourceDataset:sourceMachine?same(observations.map(row=>text(row.sourceDataset))):null,
              error:same(observations.map(row=>text(row.error)))},warehouse:warehouse(version,locations)};
        })};
    })};
}
