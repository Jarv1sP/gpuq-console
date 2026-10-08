import {readableDatasetCatalog} from './dataset-catalog-model.js';
const bytes=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const sum=items=>items.some(value=>bytes(value)===null)?null:bytes(items.reduce((n,value)=>n+value,0));
// BACKEND_API_HANDOFF protocol 1: allocated bytes, never inferred OCI layers.
export const adaptProjectUsage=raw=>bytes(raw?.bytes);
export function adaptStorageUsage(raw){
 const usage=new Map(),totals=new Map();
 if(raw?.protocol!==1||!Array.isArray(raw.machines))return {usage,totals};
 for(const row of raw.machines){
  if(typeof row?.machine!=='string'||row.available!==true||!Array.isArray(row.projects))continue;
  totals.set(row.machine,row.complete===true&&typeof row.collectedAt==='string'?bytes(row.projectBytes):null);
  for(const project of row.projects)if(typeof project?.project==='string'&&/^[a-z0-9][a-z0-9_-]{0,47}$/.test(project.project))usage.set(JSON.stringify([row.machine,project.project]),{bytes:adaptProjectUsage(project)});
 }
 return {usage,totals};
}

export function memberStorageGroups({principal,machines=[],catalog,projects=new Map(),usage=new Map(),usageTotals=new Map()}){
 if(!principal?.userId)return [];
 const groups=new Map(machines.map(row=>[row.id,{machine:row.id,items:[],projectsConfirmed:projects.get(row.id)?.confirmed===true}]));
 for(const [machine,listing] of projects){
  const group=groups.get(machine);if(!group)continue;
  const seen=new Set();
  for(const info of listing.projects||[]){
   if(!info||info.environmentMode!=='oci'||typeof info.project!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(info.project)||seen.has(info.project)||info.userId&&info.userId!==principal.userId)continue;
   seen.add(info.project);group.items.push({kind:'project',machine,project:info.project,name:info.displayName||info.project,bytes:adaptProjectUsage(usage.get(JSON.stringify([machine,info.project])))});
  }
 }
 // The personal view does not inherit the administrator's metadata directory.
 const readable=readableDatasetCatalog(catalog,{...principal,role:'member'});
 const seen=new Set();
 for(const item of readable.datasets)for(const version of item.versions)for(const row of version.servers||[]){
  const group=groups.get(row.machine),key=JSON.stringify([row.machine,item.dataset,version.version]);
  if(!group||row.state!=='READY'||row.observed!==true||seen.has(key))continue;
  seen.add(key);group.items.push({kind:'cache',key,machine:row.machine,dataset:item.dataset,version:version.version,name:item.displayName||item.dataset,bytes:bytes(version.bytes)});
 }
 return [...groups.values()].filter(group=>group.items.length).map(group=>{
  const projectBytes=usageTotals.has(group.machine)?usageTotals.get(group.machine):sum(group.items.filter(row=>row.kind==='project').map(row=>row.bytes)),cacheBytes=sum(group.items.filter(row=>row.kind==='cache').map(row=>row.bytes));
  return {...group,projectBytes,cacheBytes,totalBytes:group.projectsConfirmed&&catalog&&catalog.partial!==true?sum([projectBytes,cacheBytes]):null};
 });
}
