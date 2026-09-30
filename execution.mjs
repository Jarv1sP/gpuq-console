import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {maintainTaskNotes} from './community.mjs';
import {projectCall,projectReference,validateProjectFile} from './projects.mjs';

export const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);
export const PRIORITIES=new Set(['idle','normal','high']);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export const priorityCapable=host=>host?.reachable===true&&host.gpuq?.connected===true&&Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('priority-policy-v1')&&host.gpuq.capabilities.includes('preempt-idle-only-v1');
export const priorityRankCapable=host=>priorityCapable(host)&&host.gpuq.capabilities.includes('priority-rank-v1');
const RANKS={idle:0,normal:2,high:4,P0:0,P1:1,P2:2,P3:3,P4:4};
function rankValue(value){if(typeof value!=='string'||!Object.hasOwn(RANKS,value))fail('排队优先级必须为 P0–P4（或 idle/normal/high）。');return value;}
function priorityValue(value){if(!PRIORITIES.has(value))fail('优先级必须为 idle、normal 或 high。');return value;}
function schedulerResult(job,result){
  job.nodeJobId=result.nodeJobId||job.nodeJobId;
  job.state=['PENDING','STARTING','RUNNING','PREEMPTING',...TERMINAL].includes(result.state)?result.state:'UNKNOWN';
  job.assignedIndices=result.assignedIndices||[];job.error=result.error||null;job.checkedAt=new Date().toISOString();
  job.schedulerState=typeof result.schedulerState==='string'?result.schedulerState:result.state;
  job.queueReason=typeof result.queueReason==='string'?result.queueReason.slice(0,400):null;
  job.schedulerCheckedAt=job.checkedAt;
  job.schedulerPriority=Number.isInteger(result.schedulerPriority)?result.schedulerPriority:null;
  job.priority=typeof result.priority==='string'&&Object.hasOwn(RANKS,result.priority)?result.priority:null;
  job.schedulerPolicy=result.schedulerPolicy||null;
  job.priorityMutable=result.priorityMutable===true;
  job.preempted=result.preempted===true;
  if(TERMINAL.has(job.state))job.finishedAt||=job.checkedAt;
}
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
          const policyRevision=job.policyRevision||0;
          try{
            const action=job.cancelRequested?'cancel':'sync';
            const result=await bridge(job.machine,action,{job:job.spec});
            await service.enqueue(()=>{
              const current=service.store.jobs.find(j=>j.id===job.id);if(!current||service.closing||(current.policyRevision||0)!==policyRevision)return;
              // LOST/unknown remains nonterminal: retain quota until confirmed.
              schedulerResult(current,result);
              service.save();
              // Bodies live outside portal_state/audit. Delete only after a
              // confirmed terminal result has been persisted by reconciliation.
              maintainTaskNotes(service);
            });
          }catch(e){await service.enqueue(()=>{const current=service.store.jobs.find(j=>j.id===job.id);if(current&&!service.closing&&(current.policyRevision||0)===policyRevision){current.error=String(e.message).slice(0,200);current.checkedAt=new Date().toISOString();service.save();}});}
        }
      }));
    }finally{maintainTaskNotes(service);service.reconciling=false;}
  };
  if(bridge){service.executionTimer=setInterval(()=>service.reconcile().catch(()=>{}),15000);service.executionTimer.unref();}
}
export function usage(jobs,userId,machine){return jobs.filter(j=>j.userId===userId&&!TERMINAL.has(j.state)&&(!machine||j.machine===machine)).reduce((sum,j)=>sum+j.cards,0);}
export function publicJob(job){const {spec,digest,schedulerPolicy,...safe}=job;return {...safe,command:spec.argv,
  yieldPolicy:['legacy','never','now','save'].includes(schedulerPolicy?.yield_policy)?schedulerPolicy.yield_policy:null,
  restartPolicy:['never','on-preempt'].includes(schedulerPolicy?.restart_policy)?schedulerPolicy.restart_policy:null,
  dispatchMode:['queue','preempt-now','preempt-save'].includes(schedulerPolicy?.dispatch_mode)?schedulerPolicy.dispatch_mode:null};}
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
  if(['host.exec','host.status','host.cancel'].includes(operation)){
    if(principal.role!=='admin')fail('宿主机命令仅管理员可用。',403);
    authorizedMachine(args.machine);
    const allowed=operation==='host.exec'?['machine','key','argv','cwd','timeoutSec']:['machine','id'];
    if(Object.keys(args).some(k=>!allowed.includes(k)))fail('宿主机命令参数无效。');
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const handle=operation==='host.exec'?args.key:args.id;
    if(typeof handle!=='string'||!uuid.test(handle))fail('需提供有效 UUID 命令标识。');
    if(operation==='host.exec'){
      if(!Array.isArray(args.argv)||!args.argv.length||!args.argv[0]||args.argv.length>128||args.argv.some(a=>typeof a!=='string'||a.includes('\0'))||Buffer.byteLength(JSON.stringify(args.argv))>12000)fail('命令参数无效或过长。');
      if(args.cwd!==undefined&&(typeof args.cwd!=='string'||!args.cwd.startsWith('/')||args.cwd.includes('\0')||args.cwd.length>1024))fail('工作目录必须为绝对路径。');
      if(args.timeoutSec!==undefined&&(!Number.isInteger(args.timeoutSec)||args.timeoutSec<1||args.timeoutSec>86400))fail('超时时间必须为 1–86400 秒。');
      await service.refreshGPUQ();
      const host=service.gpuq?.hosts.find(h=>h.id===args.machine);
      if(service.gpuq?.stale!==false||host?.reachable!==true||host.hostCommand?.version!==1||host.hostCommand?.available!==true)
        fail('这台服务器尚未启用或尚未确认管理员非交互命令，未提交命令；请联系管理员。已有 ROOT 终端不受影响。',503);
    }
    const {machine,...request}=args;
    // Never audit argument contents: operators may pass a credential in argv.
    if(operation!=='host.status')service.audit(principal.username,operation,machine,request.key||request.id);
    return service.bridge(machine,operation,{...request,userId:user.id,username:user.username,hostAdmin:true});
  }
  if(operation.startsWith('projects.')){
    const result=await projectCall(service,principal,user,operation,args,authorizedMachine);
    if(result===undefined)fail('未知项目操作。');
    return result;
  }
  if(operation.startsWith('datasets.workspace.')){
    authorizedMachine(args.machine);
    const action=operation.slice('datasets.workspace.'.length);
    const fields={list:['path'],get:['path','offset'],put:['path','offset','data','truncate'],status:['operationId'],publish:['path','name','key']}[action];
    if(!fields||Object.keys(args).some(k=>!['machine',...fields].includes(k)))fail('个人数据目录参数无效。');
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if(action!=='status'){
      const path=args.path??(action==='list'?'.':undefined);
      if(typeof path!=='string'||!path||Buffer.byteLength(path)>1024||/[\\\x00-\x1f\x7f]/.test(path)||
          (path!=='.'&&path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255))||
          (path==='.'&&['put','get','publish'].includes(action)))fail('请使用个人 /data2 内的相对路径，不要填写宿主机路径。');
    }
    if(args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0||args.offset>100*1024**3))fail('文件偏移量无效。');
    if(action==='put'){
      if(!Number.isSafeInteger(args.offset)||args.truncate!==undefined&&typeof args.truncate!=='boolean'||args.truncate&&args.offset!==0)fail('上传偏移或覆盖参数无效。');
      if(typeof args.data!=='string'||args.data.length>1398104||args.data.length%4!==0||/[^A-Za-z0-9+/=]/.test(args.data)||Buffer.from(args.data,'base64').toString('base64')!==args.data||Buffer.from(args.data,'base64').length>1024*1024)fail('上传分块最多 1 MiB，且需使用规范 Base64。');
      if(args.offset+Buffer.from(args.data,'base64').length>100*1024**3)fail('单文件上限 100 GiB；更大文件请联系管理员本地导入。');
    }
    if(action==='publish'&&(!uuid.test(args.key||'')||typeof args.name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(args.name)))fail('发布需提供连接键和有效的数据集名称。');
    if(action==='status'&&args.operationId!==undefined&&!uuid.test(args.operationId))fail('发布操作编号无效。');
    const {machine,...request}=args;
    if(action==='publish')service.audit(principal.username,operation,machine,args.name);
    return service.bridge(machine,operation,{...request,userId:user.id,hostAdmin:false});
  }
  if(operation.startsWith('datasets.upload.')){
    authorizedMachine(args.machine);
    const fields={begin:['name','key','manifestBytes','manifestSha256','totalBytes','entries'],manifest:['uploadId','offset','data'],seal:['uploadId'],status:['uploadId','path'],chunk:['uploadId','path','offset','data'],commit:['uploadId'],discard:['uploadId']};
    const action=operation.slice('datasets.upload.'.length),allowed=fields[action];
    if(!allowed||Object.keys(args).some(k=>k!=='machine'&&!allowed.includes(k)))fail('个人数据集上传参数无效。');
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const id=action==='begin'?args.key:args.uploadId;
    if(typeof id!=='string'||!uuid.test(id))fail('上传编号必须为完整 UUID。');
    if(action==='begin'){
      if(typeof args.name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(args.name))fail('名称请用 1–40 位字母、数字、短横线或下划线。');
      if(!Number.isSafeInteger(args.manifestBytes)||args.manifestBytes<1||args.manifestBytes>64*1024*1024||typeof args.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(args.manifestSha256))fail('数据清单大小或校验值无效（上限 64 MiB）。');
      if(!Number.isSafeInteger(args.totalBytes)||args.totalBytes<0||!Number.isSafeInteger(args.entries)||args.entries<0||args.entries>500000)fail('数据容量或条目数无效（上限 50 万条）。');
    }
    if(action==='chunk'||Object.hasOwn(args,'path')){
      if(typeof args.path!=='string'||!args.path||Buffer.byteLength(args.path)>4096||/[\\\x00-\x1f\x7f]/.test(args.path)||args.path.split('/').some(p=>!p||p==='.'||p==='..'||['.ssh','.env','.git','.venv','anaconda3','miniconda3','.conda'].includes(p)))fail('只能上传数据目录内的安全相对路径。');
    }
    if(action==='manifest'||action==='chunk'){
      if(!Number.isSafeInteger(args.offset)||args.offset<0||typeof args.data!=='string'||args.data.length>1398104||args.data.length%4!==0||/[^A-Za-z0-9+/=]/.test(args.data))fail('上传分块参数无效。');
      const data=Buffer.from(args.data,'base64');
      if(data.length>1024*1024||data.toString('base64')!==args.data)fail('上传分块最多 1 MiB，且需使用规范 Base64。');
    }
    const {machine,...request}=args;
    // Every upload is personal, including uploads made by administrators. No
    // client-provided role, source mapping or filesystem path crosses the bridge.
    if(['begin','seal','commit','discard'].includes(action))service.audit(principal.username,operation,machine,id);
    return service.bridge(machine,operation,{...request,userId:user.id,hostAdmin:false});
  }
  if(['datasets.list','datasets.status','datasets.prepare','datasets.unregister'].includes(operation)){
    authorizedMachine(args.machine);
    if(operation==='datasets.unregister'&&principal.role!=='admin')fail('注销数据集仅管理员可用。',403);
    const byOperation=operation==='datasets.status'&&Object.hasOwn(args,'operationId');
    const allowed=operation==='datasets.list'?['machine']:byOperation?['machine','operationId']:['machine','dataset','version'];
    if(Object.keys(args).some(k=>!allowed.includes(k)))fail('数据集参数无效。');
    if(byOperation){
      if(typeof args.operationId!=='string'||!/^[a-f0-9]{64}$/.test(args.operationId))fail('数据集后台操作编号无效。');
    }else if(operation==='datasets.unregister'){
      if(typeof args.dataset!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.dataset))fail('数据集名称无效。');
      if(args.version!==undefined&&args.version!==null)datasetReferences([{dataset:args.dataset,version:args.version}]);
      // Persist intent before the node may begin destructive cache cleanup.
      service.audit(principal.username,operation,args.machine,args.dataset+(args.version?'@'+args.version:''));
    }else if(operation!=='datasets.list')datasetReferences([{dataset:args.dataset,version:args.version}]);
    // Identity comes only from the authenticated portal; node paths and roles
    // cannot be supplied by the client. Large copies run in a node-local worker.
    const {machine,...reference}=args;
    const result=await service.bridge(machine,operation,{...reference,userId:user.id,hostAdmin:principal.role==='admin'});
    if(operation==='datasets.prepare')service.audit(principal.username,operation,args.machine,args.dataset+'@'+args.version);
    return result;
  }
  if(['terminal.open','terminal.exchange','terminal.close','terminal.detach'].includes(operation)){
    authorizedMachine(args.machine);
    const opening=operation==='terminal.open',mode=args.mode||'new';
    const allowed=['machine','id','hostAdmin','project','dataWorkspace','clientId','writerToken',...(opening?['key','mode','takeover']:operation==='terminal.exchange'?['input','offset','rows','cols']:[])];
    if(Object.keys(args).some(k=>!allowed.includes(k)))fail('终端参数无效。');
    if(args.hostAdmin&&principal.role!=='admin')fail('宿主机 root 终端仅管理员可用。',403);
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if(typeof args.clientId!=='string'||!uuid.test(args.clientId))fail('请升级客户端或刷新网页：终端需要独立会话和单写租约。');
    if(opening){
      if(!['new','reconnect'].includes(mode)||typeof args.key!=='string'||!uuid.test(args.key))fail('需明确新建或重连，并提供 UUID 连接键。');
      if(args.takeover!==undefined&&typeof args.takeover!=='boolean'||args.takeover&&mode!=='reconnect')fail('仅显式重连可确认接管。');
      if(mode==='new'&&(args.id!==undefined||args.writerToken!==undefined))fail('新建终端不能携带旧会话。');
    }
    if((!opening||mode==='reconnect')&&(typeof args.id!=='string'||!uuid.test(args.id)))fail('需指定完整终端会话 ID。');
    if(args.writerToken!==undefined&&(typeof args.writerToken!=='string'||!uuid.test(args.writerToken)))fail('终端写入凭据无效。');
    if(!opening&&args.writerToken===undefined)fail('缺少终端写入凭据；请显式重连。');
    if(args.hostAdmin!==undefined&&typeof args.hostAdmin!=='boolean')fail('终端模式无效。');
    if(args.dataWorkspace!==undefined&&typeof args.dataWorkspace!=='boolean')fail('数据终端模式无效。');
    const project=projectReference(args);
    if(project.project&&args.hostAdmin)fail('项目终端与宿主机 root 维护入口分开使用。');
    if(args.dataWorkspace&&(project.project||args.hostAdmin))fail('个人数据终端与项目、ROOT 终端分开使用。');
    if(args.input&&(typeof args.input!=='string'||args.input.length>12000))fail('终端输入过长。');
    if(operation==='terminal.open')service.audit(principal.username,operation,args.machine,(args.hostAdmin?'host-root':args.dataWorkspace?'private-data':'private')+':'+mode+(args.takeover?':takeover':''));
    return service.bridge(args.machine,operation,{...args,userId:user.id,username:user.username,hostAdmin:args.hostAdmin===true});
  }
  if(operation==='jobs.submit'){
    if(Object.keys(args).some(k=>!['machine','cards','minVramGiB','argv','name','key','datasets','project','release','priority'].includes(k)))fail('提交参数无效。');
    const priority=priorityValue(args.priority===undefined?'normal':args.priority);
    if(priority==='high'&&principal.role!=='admin')fail('高优先级仅管理员可用。',403);
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
    const digest=createHash('sha256').update(JSON.stringify([args.machine,args.cards,min,args.argv,name,...(datasets.length?[datasets]:[]),...(project.project?[project]:[]),...(args.priority!==undefined?[{priority}]:[])])).digest('hex');
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
    const scheduling=priorityCapable(host);
    if(args.priority!==undefined&&!scheduling)fail('所选机器尚未确认安全优先级功能，未提交任务；请刷新或联系管理员升级。',503);
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
    const spec={id,userId:user.id,username:user.username,cards:args.cards,argv:args.argv,name,minVramGiB:min,...project,...(datasets.length?{datasets}: {}),...(scheduling?{priority,preemptIdleOnly:true}:{})};
    const job={id,key:args.key,digest,spec,userId:user.id,username:user.username,machine,cards:args.cards,name,...project,...(datasets.length?{datasets}:{}),priority:scheduling?priority:null,state:'SUBMITTING',createdAt:now,cancelRequested:false};
    service.db.exec('BEGIN IMMEDIATE');
    try{service.store.jobs.push(job);service.save();service.audit(principal.username,operation,id,'reserved');service.db.exec('COMMIT');}
    catch(e){service.db.exec('ROLLBACK');service.store.jobs=service.store.jobs.filter(j=>j.id!==id);throw e;}
    setImmediate(()=>service.reconcile().catch(()=>{}));return publicJob(job);
  }
  if(operation==='jobs.priority'){
    if(principal.role!=='admin')fail('调整排队优先级仅管理员可用。',403);
    if(Object.keys(args).some(k=>!['jobId','priority','expectedPriority'].includes(k)))fail('优先级参数无效。');
    const priority=rankValue(args.priority),job=jobById(args.jobId);
    authorizedMachine(job.machine);
    if(job.state!=='PENDING'||job.cancelRequested||!job.priorityMutable||!job.spec.preemptIdleOnly||!job.schedulerPolicy)fail('仅能调整已核验、尚未启动的新版平台任务；运行中或旧任务不变。',409);
    if(args.expectedPriority!==undefined&&args.expectedPriority!==job.priority)fail('优先级已变化，请刷新后重试。',409);
    await service.refreshGPUQ();
    if(service.gpuq?.stale||!priorityRankCapable(service.gpuq?.hosts.find(h=>h.id===job.machine)))fail('节点未确认只改优先级能力，未调整；不会回退到改变整套策略的接口。',503);
    // The immutable submit specification is never rewritten. The scheduler
    // changes the live policy atomically after checking PENDING + expected.
    job.policyRevision=(job.policyRevision||0)+1;service.save();
    service.audit(principal.username,operation,job.id,priority);
    try{
      const result=await service.bridge(job.machine,'priority',{job:job.spec,priority,rankOnly:true,expected:job.schedulerPolicy});
      job.policyRevision++;
      schedulerResult(job,result);service.save();maintainTaskNotes(service);return publicJob(job);
    }catch(error){
      job.policyRevision++;
      job.priorityMutable=false;job.error='优先级调整结果待核验，请刷新；不会重复提交任务。';service.save();
      setImmediate(()=>service.reconcile().catch(()=>{}));throw error;
    }
  }
  if(operation==='jobs.cancel'){
    const job=jobById(args.jobId);
    if(!TERMINAL.has(job.state)){
      const before=structuredClone(job);let transaction=false;
      try{
        service.db.exec('BEGIN IMMEDIATE');transaction=true;
        job.cancelRequested=true;
        service.save();service.audit(principal.username,operation,job.id,'requested');
        service.db.exec('COMMIT');transaction=false;
      }catch(error){
        try{if(transaction)service.db.exec('ROLLBACK');}
        finally{for(const key of Object.keys(job))delete job[key];Object.assign(job,before);}
        throw error;
      }
      setImmediate(()=>service.reconcile().catch(()=>{}));
    }
    return publicJob(job);
  }
  if(operation==='jobs.logs'){const job=jobById(args.jobId);return service.bridge(job.machine,'logs',{job:job.spec});}
  if(operation==='jobs.diagnostics'){
    if(Object.keys(args).some(k=>k!=='jobId'))fail('诊断参数无效。');
    const job=jobById(args.jobId);authorizedMachine(job.machine);
    return service.bridge(job.machine,'diagnostics',{job:job.spec});
  }
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
