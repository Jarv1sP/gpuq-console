import {readFile,stat} from 'node:fs/promises';
import {MACHINES} from './dist/model.js';

export async function readGPUQStatus(path,now=Date.now()){
  const empty={checkedAt:null,stale:true,hosts:[]};
  if(!path)return empty;
  try{
    if((await stat(path)).size>2_000_000)return empty;
    const data=JSON.parse(await readFile(path,'utf8'));
    const checked=Date.parse(data.checkedAt);
    if(data.version!==1||!Number.isFinite(checked)||!Array.isArray(data.hosts))return empty;
    const stale=now-checked>180000||checked-now>30000;
    return {checkedAt:data.checkedAt,stale,hosts:MACHINES.map(machine=>{
      const host=data.hosts.find(item=>item.id===machine.id);
      if(!host||stale)return {id:machine.id,reachable:false,gpus:[],gpuq:{connected:false,jobs:[]},error:stale?'状态已过期':'暂无状态'};
      return {...host,reachable:host.reachable===true,
        gpus:Array.isArray(host.gpus)?host.gpus.slice(0,machine.cards):[],
        gpuq:{...host.gpuq,connected:host.gpuq?.connected===true,
          jobs:Array.isArray(host.gpuq?.jobs)?host.gpuq.jobs.slice(0,100):[]}};
    })};
  }catch{return empty;}
}

export function visibleGPUQStatus(snapshot,principal,limits){
  const hosts=snapshot.hosts.filter(host=>principal.role==='admin'||limits[host.id]);
  return {...snapshot,hosts:hosts.map(host=>principal.role==='admin'?structuredClone(host):{
    id:host.id,reachable:host.reachable,gpus:host.gpus,
    gpuq:{connected:host.gpuq.connected,health:host.gpuq.health,
      observeOnly:host.gpuq.observeOnly,schedulableIndices:host.gpuq.schedulableIndices},
    ...(host.error?{error:host.error}:{})
  })};
}
