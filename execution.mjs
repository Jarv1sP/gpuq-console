import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {projectCall,projectReference,validateProjectFile} from './projects.mjs';

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
export function datasetReferences(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>8)fail('每个任务最多关联 8 个数据集版本。');
  const names=new Set();
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='dataset,version'||
       typeof item.dataset!=='string'||typeof item.version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.dataset)||!/^[a-f0-9]{64}$/.test(item.version)||names.has(item.dataset))fail('数据集需指定唯一名称和完整版本哈希。');
    names.add(item.dataset);
  }
  return value.map(({dataset,version})=>({dataset,version}));
}
export async function executionCall(service,principal,operation,args){
  if(!service.bridge)fail('节点执行桥尚未配置，未启动训练。',503);
  const user=service.store.get(principal.userId);
  if(!user.enabled)fail('账号已暂停。',403);
  const authorizedMachine=machine=>{if(!MACHINES.some(m=>m.id===machine)||!user.limits[machine])fail('这台机器未授权。',403);};
  const jobById=id=>{const job=service.store.jobs.find(j=>j.id===id);if(!job||(principal.role!=='admin'&&job.userId!==user.id))fail('任务不存在或无权访问。',403);return job;};
  if(operation.startsWith('projects.')){
    const result=await projectCall(service,principal,user,operation,args,authorizedMachine);
    if(result===undefined)fail('未知项目操作。');
    return result;
  }
  if(['datasets.list','datasets.status','datasets.prepare'].includes(operation)){
    authorizedMachine(args.machine);
    const allowed=operation==='datasets.list'?['machine']:['machine','dataset','version'];
    if(Object.keys(args).some(k=>!allowed.includes(k)))fail('数据集参数无效。');
    if(operation!=='datasets.list')datasetReferences([{dataset:args.dataset,version:args.version}]);
    // Identity comes only from the authenticated portal; node paths and roles
    // cannot be supplied by the client. Large copies run in a node-local worker.
    const {machine,...reference}=args;
    const result=await service.bridge(machine,operation,{...reference,userId:user.id,hostAdmin:principal.role==='admin'});
    if(operation==='datasets.prepare')service.audit(principal.username,operation,args.machine,args.dataset+'@'+args.version);
    return result;
  }
  if(['terminal.open','terminal.exchange','terminal.close'].includes(operation)){
    authorizedMachine(args.machine);
    if(Object.keys(args).some(k=>!['machine','key','id','hostAdmin','input','offset','rows','cols','project'].includes(k)))fail('终端参数无效。');
    const project=projectReference(args);
    if(project.project&&args.hostAdmin)fail('项目终端与宿主机 root 维护入口分开使用。');
    if(args.hostAdmin&&principal.role!=='admin')fail('宿主机 root 终端仅管理员可用。',403);
    if(args.input&&(typeof args.input!=='string'||args.input.length>12000))fail('终端输入过长。');
    if(operation==='terminal.open')service.audit(principal.username,operation,args.machine,args.hostAdmin?'host-root':'private');
    return service.bridge(args.machine,operation,{...args,userId:user.id,username:user.username,hostAdmin:args.hostAdmin===true});
  }
  if(operation==='jobs.submit'){
    if(Object.keys(args).some(k=>!['machine','cards','minVramGiB','argv','name','key','datasets','project','release'].includes(k)))fail('提交参数无效。');
    // Placement is a user decision. The selected node still allocates its GPUs,
    // but a missing/auto/unknown target must never widen into a cluster search.
    if(!Object.hasOwn(args,'machine')||typeof args.machine!=='string'||args.machine==='auto'||!MACHINES.some(m=>m.id===args.machine))fail('请明确选择有效的服务器；不支持自动选机。');
    const datasets=datasetReferences(args.datasets);
    const project=projectReference(args,{release:true});
    if(typeof args.key!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.key))fail('需提供 UUID 提交键，重试必须复用。');
    if(!Array.isArray(args.argv)||!args.argv.length||args.argv.length>128||args.argv.some(a=>typeof a!=='string'||a.includes('\0'))||JSON.stringify(args.argv).length>12000)fail('训练命令无效或过长。');
    if(!Number.isInteger(args.cards)||args.cards<1||args.cards>Math.max(...MACHINES.map(m=>m.cards)))fail('申请卡数超出单机容量。');
    const min=args.minVramGiB??0;if(typeof min!=='number'||!Number.isFinite(min)||min<0||min>128)fail('最低显存参数无效。');
    const name=args.name||'train';if(typeof name!=='string'||name.length>64||/[\x00-\x1f]/.test(name))fail('任务名称无效。');
    // Preserve legacy idempotency hashes for jobs without dataset references.
    const digest=createHash('sha256').update(JSON.stringify([args.machine,args.cards,min,args.argv,name,...(datasets.length?[datasets]:[]),...(project.project?[project]:[])])).digest('hex');
    const previous=service.store.jobs.find(j=>j.userId===user.id&&j.key===args.key);
    if(previous){if(previous.digest!==digest)fail('同一提交键不能用于不同任务。',409);return publicJob(previous);}
    if(service.store.jobs.length>=5000)fail('任务历史达到归档上限，请联系管理员归档后提交。',503);
    if(usage(service.store.jobs,user.id)+args.cards>user.total)fail('超出跨机器用卡总额度（排队、运行和待核对任务均计入）。',409);
    authorizedMachine(args.machine);
    if(project.project){
      let prepared;
      try{prepared=await service.bridge(args.machine,'projects.verify',{...project,userId:user.id});}
      catch{fail('所选服务器的项目版本不可用或基础环境已改变；请先完成项目发布。未占用 GPU。',409);}
      if(prepared?.state!=='READY'||prepared.project!==project.project||prepared.release!==project.release)fail('项目版本尚未准备完成，未占用 GPU。',409);
    }
    if(usage(service.store.jobs,user.id,args.machine)+args.cards>user.limits[args.machine])fail('超出所选机器的用卡额度（排队、运行和待核对任务均计入）；不会自动切换服务器。',409);
    await service.refreshGPUQ();
    if(!service.gpuq||service.gpuq.stale)fail('机器状态已过期，暂不接受新任务。',503);
    const host=service.gpuq.hosts.find(h=>h.id===args.machine);
    if(!host?.reachable||!host.gpuq.connected||host.gpuq.observeOnly||host.gpus.filter(g=>g.memoryTotalMiB>=min*1024-512).length<args.cards)fail('所选机器当前无法执行，或不满足卡数/显存条件；不会自动切换服务器。',409);
    if(datasets.length){
      // Personal training uses the same owner-only Principal as node lease
      // acquisition. Only the explicitly selected node is queried; management
      // visibility and another node's READY copy cannot bypass this preflight.
      let states;
      try{states=await Promise.all(datasets.map(ref=>service.bridge(args.machine,'datasets.status',{...ref,userId:user.id,hostAdmin:false})));}
      catch(error){
        if(error?.message==='dataset owner authorization required')fail('当前账号没有数据集读取授权；管理员个人训练也必须列入数据集 owners。未占用 GPU。',403);
        fail('无法确认所选机器的数据授权或准备状态，未占用 GPU。请稍后重试或查看数据集状态。',503);
      }
      if(!states.every(s=>s.state==='READY'))fail('所选机器没有完整的本地数据副本。先用 gpuctl data prepare 数据集@版本 准备数据；此时未占用 GPU，不会自动切换服务器。',409);
    }
    const machine=args.machine,id=randomUUID(),now=new Date().toISOString();
    const spec={id,userId:user.id,username:user.username,cards:args.cards,argv:args.argv,name,minVramGiB:min,...project,...(datasets.length?{datasets}: {})};
    const job={id,key:args.key,digest,spec,userId:user.id,username:user.username,machine,cards:args.cards,name,...project,...(datasets.length?{datasets}:{}),state:'SUBMITTING',createdAt:now,cancelRequested:false};
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
    if(Object.keys(args).some(k=>!['machine','path','data','offset','truncate','project','area','runId','uploadId','totalSize','sha256','final'].includes(k)))fail('文件参数无效。');
    const project=validateProjectFile(args);
    if(project.area==='output'){
      const job=jobById(args.runId);
      // Admin resource inspection does not implicitly read somebody else's
      // personal output. Host-root maintenance is its own audited interface.
      if(job.userId!==user.id||job.machine!==args.machine||job.project!==args.project)fail('任务输出不属于当前用户、项目或服务器。',403);
      if(operation==='files.put')fail('不能通过上传覆盖训练输出。');
    }
    if(args.project&&operation==='files.put'&&args.truncate!==undefined)fail('项目上传须完整校验后原子提交，不接受 truncate。');
    return service.bridge(args.machine,operation,{...args,userId:user.id});
  }
  fail('未知执行操作。');
}
