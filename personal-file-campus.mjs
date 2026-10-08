import {createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {validateProjectFile,UUID} from './projects.mjs';

export const PERSONAL_FILE_PROTOCOL='personal-file-campus-v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const denied=(message,status=403)=>{throw Object.assign(Error(message),{status,code:'CAMPUS_FILE_REQUIRED'});};
const stamp=(service,user)=>JSON.stringify({user,maintenance:service.operationalMaintenance({userId:user.id,role:user.role}).revision});

// Short-lived capabilities are an in-memory authorization index, not another
// transfer queue. Restart invalidates them; original node upload journals stay.
export function installPersonalFileCampus(service){
  service.personalFileTickets=new Map();
  service.checkPersonalFileTicket=data=>{
    if(!data||Object.keys(data).join(',')!=='ticket'||typeof data.ticket!=='string'||data.ticket.length>4096)denied('文件授权无效。');
    const entry=service.personalFileTickets.get(hash(data.ticket));
    if(!entry||entry.expiresAt<=Date.now()/1000||service.closing)denied('校园文件授权已失效，请核对原操作。');
    const session=service.db.prepare('SELECT * FROM login_sessions WHERE token_hash=?').get(entry.sessionHash);
    const user=service.store.get(entry.principal.userId);
    if(!session||session.expires_at<=Date.now()||!user.enabled||session.user_id!==user.id||session.username!==user.username
      ||session.role!==entry.principal.role||user.role!==entry.principal.role||!user.limits[entry.args.machine]
      ||stamp(service,user)!==entry.policy||service.maintenanceFor(entry.args.machine))denied('账号、权限或维护状态已改变；原文件操作已暂停。');
    if(entry.args.area==='output'){
      const job=service.store.jobs.find(row=>row.id===entry.args.runId);
      if(!job||job.userId!==user.id||job.machine!==entry.args.machine||job.project!==entry.args.project
        ||hash(JSON.stringify(job.spec))!==entry.jobSpec)denied('任务输出归属已改变。');
    }
    return {allowed:true,protocol:PERSONAL_FILE_PROTOCOL};
  };
}

export async function personalFileTicket(service,token,args){
  const principal=service.principal(token),user=service.store.get(principal.userId);
  const allowed=['machine','project','area','runId','path','action',...(args?.action==='put'?['uploadId','totalSize','sha256']:['fingerprint'])];
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!allowed.includes(key)))denied('校园文件参数无效。',400);
  if(!MACHINES.some(machine=>machine.id===args.machine)||!user.enabled||!user.limits[args.machine])denied('这台机器未授权。');
  const context=validateProjectFile(args);
  if(!context.project)denied('校园文件传输须选择本人的个人项目。',400);
  if(!['put','get'].includes(args.action)||typeof args.path!=='string'||args.path.length>1024
    ||args.path.split('/').some(part=>!part||part==='.'||part==='..'||part.length>255)||/[\\\x00-\x1f\x7f]/.test(args.path))denied('文件身份无效。',400);
  if(args.action==='put'&&(context.area!=='code'||!UUID.test(args.uploadId||'')||!Number.isSafeInteger(args.totalSize)
    ||args.totalSize<0||! /^[a-f0-9]{64}$/.test(args.sha256||'')))denied('上传须保留原 UUID、精确大小和 SHA256。',400);
  if(args.fingerprint!==undefined&&! /^[a-f0-9]{64}$/.test(args.fingerprint))denied('下载来源身份无效。',400);
  let jobSpec=null;
  if(context.area==='output'){
    const job=service.store.jobs.find(row=>row.id===context.runId);
    if(!job||job.userId!==user.id||job.machine!==args.machine||job.project!==context.project)denied('任务输出不属于当前用户、项目或服务器。');
    jobSpec=hash(JSON.stringify(job.spec));
  }
  if(service.maintenanceFor(args.machine))denied('维护状态禁止校园文件字节传输。',503);
  if(!service.bridge)denied('节点执行桥尚未配置。',503);
  const policy=stamp(service,user),request={...args,...context};
  const before={...principal};
  const result=await service.bridge(args.machine,'files.direct.prepare',{...request,userId:user.id});
  const current=service.principal(token);
  if(current.userId!==before.userId||current.role!==before.role||stamp(service,service.store.get(user.id))!==policy
    ||service.maintenanceFor(args.machine))denied('授权核对期间账号或维护状态已改变；未开放字节传输。');
  if(!result||result.available!==true||result.protocol!==PERSONAL_FILE_PROTOCOL||result.machine!==args.machine
    ||result.kind!=='campus-direct'||result.routeId!=='primary'||result.chunkBytes!==1048576||!UUID.test(result.grantId||'')
    ||typeof result.ticket!=='string'||result.ticket.length>4096||!Number.isSafeInteger(result.expiresAt)
    ||result.expiresAt<=Date.now()/1000||result.expiresAt>Date.now()/1000+301)denied('节点未确认严格校园文件协议。',503);
  let endpoint;try{endpoint=new URL(result.endpoint);}catch{denied('节点校园入口无效。',503);}
  if(endpoint.protocol!=='https:'||endpoint.origin!==result.endpoint||endpoint.pathname!=='/'||endpoint.username||endpoint.password
    ||endpoint.search||endpoint.hash||! /^[a-f0-9]{64}$/.test(result.certificateSha256||'')||! /^[a-f0-9]{64}$/.test(result.revision||''))denied('节点校园入口身份无效。',503);
  for(const [key,entry] of service.personalFileTickets)if(entry.expiresAt<=Date.now()/1000)service.personalFileTickets.delete(key);
  if(service.personalFileTickets.size>=4096)denied('文件授权繁忙，请稍后核对原操作。',429);
  service.personalFileTickets.set(hash(result.ticket),{principal:before,sessionHash:hash(token),args:request,policy,jobSpec,expiresAt:result.expiresAt});
  return {result,principal:current};
}
