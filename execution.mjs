import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';

export const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function bridgeClient(socketPath){
  return (machine,operation,args)=>new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);let raw='';
    socket.setTimeout(32000,()=>socket.destroy(Error('节点响应超时；任务状态将自动核对。')));
    socket.on('connect',()=>socket.end(JSON.stringify({machine,operation,args})+'\n'));
    socket.on('data',part=>{raw+=part;if(Buffer.byteLength(raw)>2_000_000)socket.destroy(Error('节点响应过大'));});
    socket.on('error',reject);
    socket.on('end',()=>{try{const data=JSON.parse(raw);if(!data.ok)throw Error(data.error||'节点操作失败');resolve(data.result);}catch(e){reject(e);}});
  });
}
export function installExecution(service,bridge){
  service.bridge=bridge;service.executionEnabled=!!bridge;service.reconciling=false;
  service.reconcile=async()=>{
    if(!bridge||service.reconciling||service.closing)return;
    service.reconciling=true;
    try{
      const jobs=service.store.jobs.filter(j=>!TERMINAL.has(j.state));
      await Promise.all(MACHINES.map(async m=>{
        for(const job of jobs.filter(j=>j.machine===m.id)){
          try{
            const action=job.cancelRequested?'cancel':'sync';
            const result=await bridge(job.machine,action,{job:job.spec});
            await service.enqueue(()=>{
              const current=service.store.jobs.find(j=>j.id===job.id);if(!current||service.closing)return;
              current.nodeJobId=result.nodeJobId||current.nodeJobId;
              // LOST/unknown is deliberately NOT terminal: keep the quota reserved.
              current.state=['PENDING','STARTING','RUNNING','PREEMPTING',...TERMINAL].includes(result.state)?result.state:'UNKNOWN';
              current.assignedIndices=result.assignedIndices||[];current.error=result.error||null;current.checkedAt=new Date().toISOString();
              if(TERMINAL.has(current.state))current.finishedAt||=current.checkedAt;
              service.save();
            });
          }catch(e){await service.enqueue(()=>{const current=service.store.jobs.find(j=>j.id===job.id);if(current&&!service.closing){current.error=String(e.message).slice(0,200);current.checkedAt=new Date().toISOString();service.save();}});}
        }
      }));
    }finally{service.reconciling=false;}
  };
  if(bridge){service.executionTimer=setInterval(()=>service.reconcile().catch(()=>{}),15000);service.executionTimer.unref();}
}
export function usage(jobs,userId,machine){return jobs.filter(j=>j.userId===userId&&!TERMINAL.has(j.state)&&(!machine||j.machine===machine)).reduce((sum,j)=>sum+j.cards,0);}
export function publicJob(job){const {spec,digest,...safe}=job;return {...safe,command:spec.argv};}
export async function executionCall(service,principal,operation,args){
  if(!service.bridge)fail('节点执行桥尚未配置，未启动训练。',503);
  const user=service.store.get(principal.userId);
  if(!user.enabled)fail('账号已暂停。',403);
  const authorizedMachine=machine=>{if(!MACHINES.some(m=>m.id===machine)||!user.limits[machine])fail('这台机器未授权。',403);};
  const jobById=id=>{const job=service.store.jobs.find(j=>j.id===id);if(!job||(principal.role!=='admin'&&job.userId!==user.id))fail('任务不存在或无权访问。',403);return job;};
  if(['terminal.open','terminal.exchange','terminal.close'].includes(operation)){
    authorizedMachine(args.machine);
    if(Object.keys(args).some(k=>!['machine','key','id','hostAdmin','input','offset','rows','cols'].includes(k)))fail('终端参数无效。');
    if(args.hostAdmin&&principal.role!=='admin')fail('宿主机 root 终端仅管理员可用。',403);
    if(args.input&&(typeof args.input!=='string'||args.input.length>12000))fail('终端输入过长。');
    if(operation==='terminal.open')service.audit(principal.username,operation,args.machine,args.hostAdmin?'host-root':'private');
    return service.bridge(args.machine,operation,{...args,userId:user.id,username:user.username,hostAdmin:args.hostAdmin===true});
  }
  if(operation==='jobs.submit'){
    if(Object.keys(args).some(k=>!['machine','cards','minVramGiB','argv','name','key'].includes(k)))fail('提交参数无效。');
    if(typeof args.key!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.key))fail('需提供 UUID 提交键，重试必须复用。');
    if(!Array.isArray(args.argv)||!args.argv.length||args.argv.length>128||args.argv.some(a=>typeof a!=='string'||a.includes('\0'))||JSON.stringify(args.argv).length>12000)fail('训练命令无效或过长。');
    if(!Number.isInteger(args.cards)||args.cards<1||args.cards>Math.max(...MACHINES.map(m=>m.cards)))fail('申请卡数超出单机容量。');
    const min=args.minVramGiB??0;if(typeof min!=='number'||!Number.isFinite(min)||min<0||min>128)fail('最低显存参数无效。');
    const name=args.name||'train';if(typeof name!=='string'||name.length>64||/[\x00-\x1f]/.test(name))fail('任务名称无效。');
    const digest=createHash('sha256').update(JSON.stringify([args.machine||'auto',args.cards,min,args.argv,name])).digest('hex');
    const previous=service.store.jobs.find(j=>j.userId===user.id&&j.key===args.key);
    if(previous){if(previous.digest!==digest)fail('同一提交键不能用于不同任务。',409);return publicJob(previous);}
    if(service.store.jobs.length>=5000)fail('任务历史达到归档上限，请联系管理员归档后提交。',503);
    if(usage(service.store.jobs,user.id)+args.cards>user.total)fail('超出跨机器用卡总额度（排队、运行和待核对任务均计入）。',409);
    await service.refreshGPUQ();
    if(!service.gpuq||service.gpuq.stale)fail('机器状态已过期，暂不接受新任务。',503);
    let candidates=MACHINES.filter(m=>user.limits[m.id]&&(!args.machine||args.machine==='auto'||args.machine===m.id));
    if(args.machine&&args.machine!=='auto')authorizedMachine(args.machine);
    candidates=candidates.filter(m=>usage(service.store.jobs,user.id,m.id)+args.cards<=user.limits[m.id]);
    const eligible=candidates.map(m=>({m,h:service.gpuq?.hosts.find(h=>h.id===m.id)})).filter(({h})=>h?.reachable&&h.gpuq.connected&&!h.gpuq.observeOnly&&h.gpus.filter(g=>g.memoryTotalMiB>=min*1024-512).length>=args.cards);
    eligible.sort((a,b)=>(b.h.gpuq.schedulableIndices?.length||0)-(a.h.gpuq.schedulableIndices?.length||0));
    if(!eligible.length)fail('没有已授权、执行正常且满足卡数/显存条件的机器。',409);
    const machine=eligible[0].m.id,id=randomUUID(),now=new Date().toISOString();
    const spec={id,userId:user.id,username:user.username,cards:args.cards,argv:args.argv,name,minVramGiB:min};
    const job={id,key:args.key,digest,spec,userId:user.id,username:user.username,machine,cards:args.cards,name,state:'SUBMITTING',createdAt:now,cancelRequested:false};
    service.db.exec('BEGIN IMMEDIATE');
    try{service.store.jobs.push(job);service.save();service.audit(principal.username,operation,id,'reserved');service.db.exec('COMMIT');}
    catch(e){service.db.exec('ROLLBACK');service.store.jobs=service.store.jobs.filter(j=>j.id!==id);throw e;}
    setImmediate(()=>service.reconcile().catch(()=>{}));return publicJob(job);
  }
  if(operation==='jobs.cancel'){
    const job=jobById(args.jobId);if(!TERMINAL.has(job.state)){job.cancelRequested=true;service.save();service.audit(principal.username,operation,job.id,'requested');setImmediate(()=>service.reconcile().catch(()=>{}));}
    return publicJob(job);
  }
  if(operation==='jobs.logs'){const job=jobById(args.jobId);return service.bridge(job.machine,'logs',{job:job.spec});}
  if(operation==='files.list'||operation==='files.put'||operation==='files.get'){
    authorizedMachine(args.machine);
    if(Object.keys(args).some(k=>!['machine','path','data','offset','truncate'].includes(k)))fail('文件参数无效。');
    return service.bridge(args.machine,operation,{...args,userId:user.id});
  }
  fail('未知执行操作。');
}
