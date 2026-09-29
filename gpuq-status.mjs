import {readFile,stat} from 'node:fs/promises';
import {MACHINES} from './dist/model.js';

const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const text=(value,limit=120)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,limit):null;
function scheduling(value,admin=true){
  if(!value||!Number.isInteger(value.priority)||value.priority<0||value.priority>4)return undefined;
  return {priority:value.priority,...(admin?{jobId:text(value.jobId),yieldPolicy:['legacy','never','now','save'].includes(value.yieldPolicy)?value.yieldPolicy:null}:{})};
}
function gpuMetrics(gpu){
  const utilization=number(gpu.utilization);
  return {index:gpu.index,uuid:text(gpu.uuid),model:text(gpu.model),memoryTotalMiB:number(gpu.memoryTotalMiB),memoryUsedMiB:number(gpu.memoryUsedMiB),utilization:utilization!==null&&utilization<=100?utilization:null,temperatureC:number(gpu.temperatureC),powerDrawW:number(gpu.powerDrawW),powerLimitW:number(gpu.powerLimitW)};
}
function gpuStatus(gpu){
  const raw=Array.isArray(gpu.processes)?gpu.processes:[],valid=raw.filter(p=>p&&Number.isSafeInteger(p.pid)&&p.pid>0&&p.pid<=2147483647),incomplete=valid.length!==raw.length||valid.length>128;
  return {...gpuMetrics(gpu),processesAvailable:gpu.processesAvailable===true&&!incomplete,
    ...(incomplete?{processesError:'GPU process list incomplete'}:gpu.processesError?{processesError:text(gpu.processesError)}:{}),
    processes:valid.slice(0,128).map(p=>({pid:p.pid,name:text(p.name)?.split(/[\\/]/).pop()||null,owner:text(p.owner,80),memoryUsedMiB:number(p.memoryUsedMiB),type:'compute',...(scheduling(p.scheduling)?{scheduling:scheduling(p.scheduling)}:{})}))};
}

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
      if(!host||stale)return {id:machine.id,reachable:false,gpus:[],hostCommand:{version:1,available:false},gpuq:{connected:false,jobs:[]},error:stale?'状态已过期':'暂无状态'};
      return {...host,reachable:host.reachable===true,
        hostCommand:{version:1,available:host.reachable===true&&host.hostCommand?.version===1&&host.hostCommand?.available===true},
        gpus:Array.isArray(host.gpus)?host.gpus.filter(g=>g&&Number.isInteger(g.index)&&g.index>=0).slice(0,machine.cards).map(gpuStatus):[],
        gpuq:{...host.gpuq,connected:host.gpuq?.connected===true,
          jobs:Array.isArray(host.gpuq?.jobs)?host.gpuq.jobs.slice(0,100):[]}};
    })};
  }catch{return empty;}
}

export function visibleGPUQStatus(snapshot,principal,limits){
  const hosts=snapshot.hosts.filter(host=>principal.role==='admin'||limits[host.id]);
  return {...snapshot,hosts:hosts.map(host=>principal.role==='admin'?structuredClone(host):{
    id:host.id,reachable:host.reachable,gpus:host.gpus.map(gpu=>({...gpuMetrics(gpu),processesAvailable:gpu.processesAvailable===true,
      ...(gpu.processesError?{processesError:'进程列表暂不可用或不完整'}:{}),
      processes:(gpu.processes||[]).map(p=>({pid:p.pid,memoryUsedMiB:number(p.memoryUsedMiB),type:'compute',...(scheduling(p.scheduling,false)?{scheduling:scheduling(p.scheduling,false)}:{})}))})),
    gpuq:{connected:host.gpuq.connected,health:host.gpuq.health,capabilities:host.gpuq.capabilities,
      observeOnly:host.gpuq.observeOnly,schedulableIndices:host.gpuq.schedulableIndices},
    ...(host.error?{error:host.error}:{}),...(host.gpuError?{gpuError:'部分 GPU 指标暂不可用'}:{})
  })};
}
