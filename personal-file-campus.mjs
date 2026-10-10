import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {validateProjectFile,UUID} from './projects.mjs';
import {jobOutputReadError} from './job-observation.mjs';

export const PERSONAL_FILE_PROTOCOL='personal-file-campus-v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const denied=(message,status=403)=>{throw Object.assign(Error(message),{status,code:'CAMPUS_FILE_REQUIRED'});};
const stamp=(service,user)=>JSON.stringify({user,maintenance:service.operationalMaintenance({userId:user.id,role:user.role}).revision});

function downloadScope(service,user,args){
  if(!UUID.test(args.downloadId||'')||args.action!=='get'||!['manifest','get'].includes(args.snapshotAction))denied('请保留原下载编号及固定来源。',400);
  const row=service.db.prepare('SELECT * FROM transfers WHERE id=?').get(args.downloadId);
  if(!row||row.owner_id!==user.id)denied('下载不存在或属于其他账号。',404);
  const data=JSON.parse(row.data);
  if(data.kind!=='download'||row.state!=='WAITING_CLIENT'||data.cancelRequested||data.machine!==args.machine
    ||data.owner?.id!==user.id||!data.reference||data.reference.kind!=='datasets'
    ||! /^[a-f0-9]{64}$/.test(data.reference.version||'')||! /^[a-f0-9]{64}$/.test(data.snapshot?.manifestSha256||'')
    ||data.downloadProtection&&!(data.downloadProtection.protocol===1&&data.downloadProtection.state==='HELD'))denied('原下载来源、状态或保护尚未确认。',409);
  if(args.snapshotAction==='manifest'&&args.path!=='@manifest')denied('清单读取身份无效。',400);
  const reference={dataset:data.reference.dataset,version:data.reference.version},leased=data.downloadProtection?.protocol===1;
  const binding=JSON.stringify({owner:row.owner_id,key:row.client_key,digest:row.digest,machine:data.machine,reference,snapshot:data.snapshot,leased});
  return {context:{area:'snapshot',downloadId:row.id,reference,snapshotAction:args.snapshotAction,leased},binding,manifestSha256:data.snapshot.manifestSha256};
}

// Keep only the hash of the node capability, never its bearer ticket. SQLite is
// owned by Portal's single writer and survives a drained rollout/restart. Every
// use still checks the current login, policy, maintenance and fixed source.
export function installPersonalFileCampus(service){
  service.db.exec('CREATE TABLE IF NOT EXISTS personal_file_authorizations (ticket_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS personal_file_authorizations_expiry ON personal_file_authorizations(expires_at);');
  service.db.prepare('DELETE FROM personal_file_authorizations WHERE expires_at<=?').run(Date.now()/1000);
  service.personalFileTickets=new Map(service.db.prepare('SELECT ticket_hash, expires_at, data FROM personal_file_authorizations').all().map(row=>{
    const entry=JSON.parse(row.data);
    if(!/^[a-f0-9]{64}$/.test(row.ticket_hash)||!Number.isSafeInteger(row.expires_at)||entry.expiresAt!==row.expires_at)throw Error('Invalid persisted personal-file authorization');
    return [row.ticket_hash,entry];
  }));
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
    if(entry.args.area==='snapshot'&&downloadScope(service,user,entry.args).binding!==entry.downloadBinding)denied('原下载内容或保护已改变。');
    return {allowed:true,protocol:PERSONAL_FILE_PROTOCOL};
  };
}

export function validatePersonalFileLanEndpoints(input){
  const value=typeof input==='string'?JSON.parse(input):input;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>16)denied('Invalid trusted personal-file LAN endpoints',503);
  for(const [machine,endpoint] of Object.entries(value)){
    let u;try{u=new URL(endpoint);}catch{denied('Invalid trusted personal-file LAN origin',503);}
    const [a,b]=u.hostname.split('.').map(Number);
    if(!MACHINES.some(m=>m.id===machine)||u.protocol!=='https:'||u.origin!==endpoint||u.username||u.password||u.search||u.hash||u.pathname!=='/'||isIP(u.hostname)!==4||!(a===10||a===172&&b>=16&&b<=31||a===192&&b===168))denied('Invalid trusted personal-file LAN origin',503);
  }
  return Object.freeze({...value});
}
export async function personalFileTicket(service,token,args){
  const principal=service.principal(token),user=service.store.get(principal.userId);
  const workspace=args?.area==='workspace';
  const snapshot=args?.area==='snapshot';
  const allowed=snapshot?['machine','area','path','action','maxChunkBytes','downloadId','snapshotAction','fingerprint']:
    ['machine','project','area','runId','path','action','maxChunkBytes',...(workspace?['overwrite']:[]),...(args?.action==='put'?['uploadId','totalSize','sha256']:['fingerprint'])];
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!allowed.includes(key)))denied('校园文件参数无效。',400);
  if(args.maxChunkBytes!==undefined&&![1048576,16*1048576].includes(args.maxChunkBytes))denied('校园文件分块边界无效。',400);
  if(!MACHINES.some(machine=>machine.id===args.machine)||!user.enabled||!user.limits[args.machine])denied('这台机器未授权。');
  if(workspace&&(args.action!=='put'||Object.hasOwn(args,'project')||Object.hasOwn(args,'runId')||args.overwrite!==undefined&&typeof args.overwrite!=='boolean'))denied('个人数据上传不可混用项目或任务身份。',400);
  const download=snapshot?downloadScope(service,user,args):null;
  const context=snapshot?download.context:workspace?{area:'workspace',overwrite:args.overwrite??false}:validateProjectFile(args);
  if(!workspace&&!snapshot&&!context.project)denied('校园文件传输须选择本人的个人项目。',400);
  if(!['put','get'].includes(args.action)||typeof args.path!=='string'||args.path.length>1024
    ||args.path.split('/').some(part=>!part||part==='.'||part==='..'||part.length>255)||/[\\\x00-\x1f\x7f]/.test(args.path))denied('文件身份无效。',400);
  if(args.action==='put'&&(!['code','workspace'].includes(context.area)||!UUID.test(args.uploadId||'')||!Number.isSafeInteger(args.totalSize)
    ||args.totalSize<0||! /^[a-f0-9]{64}$/.test(args.sha256||'')))denied('上传须保留原 UUID、精确大小和 SHA256。',400);
  if(args.fingerprint!==undefined&&! /^[a-f0-9]{64}$/.test(args.fingerprint))denied('下载来源身份无效。',400);
  let jobSpec=null,outputJob;
  if(context.area==='output'){
    const job=service.store.jobs.find(row=>row.id===context.runId);
    if(!job||job.userId!==user.id||job.machine!==args.machine||job.project!==context.project)denied('任务输出不属于当前用户、项目或服务器。');
    jobSpec=hash(JSON.stringify(job.spec));
    outputJob=job;
  }
  if(service.maintenanceFor(args.machine))denied('维护状态禁止校园文件字节传输。',503);
  if(!service.bridge)denied('节点执行桥尚未配置。',503);
  const policy=stamp(service,user),request={...args,...context};
  const before={...principal};
  let result;
  try{result=await service.bridge(args.machine,'files.direct.prepare',{...request,userId:user.id});}
  catch(error){
    const current=service.principal(token);
    if(current.userId!==before.userId||current.role!==before.role||stamp(service,service.store.get(user.id))!==policy
      ||service.maintenanceFor(args.machine))denied('授权核对期间账号或维护状态已改变；未开放字节传输。');
    throw jobOutputReadError(outputJob,error);
  }
  const current=service.principal(token);
  if(current.userId!==before.userId||current.role!==before.role||stamp(service,service.store.get(user.id))!==policy
    ||service.maintenanceFor(args.machine))denied('授权核对期间账号或维护状态已改变；未开放字节传输。');
  if(snapshot&&downloadScope(service,service.store.get(user.id),args).binding!==download.binding)denied('授权等待期间原下载已取消或改变。');
  if(!result||result.available!==true||result.protocol!==PERSONAL_FILE_PROTOCOL||result.machine!==args.machine
    ||result.kind!=='campus-direct'||result.routeId!=='primary'||result.chunkBytes!==(args.maxChunkBytes??1048576)
    ||result.maxChunkBytes!==undefined&&![1048576,16*1048576].includes(result.maxChunkBytes)
    ||result.chunkBytes===16*1048576&&result.maxChunkBytes!==16*1048576
    ||!UUID.test(result.grantId||'')
    ||typeof result.ticket!=='string'||result.ticket.length>4096||!Number.isSafeInteger(result.expiresAt)
    ||result.expiresAt<=Date.now()/1000||result.expiresAt>Date.now()/1000+301)denied('节点未确认严格校园文件协议。',503);
  let endpoint;try{endpoint=new URL(result.endpoint);}catch{denied('节点校园入口无效。',503);}
  if(endpoint.protocol!=='https:'||endpoint.origin!==result.endpoint||endpoint.pathname!=='/'||endpoint.username||endpoint.password
    ||endpoint.search||endpoint.hash||! /^[a-f0-9]{64}$/.test(result.certificateSha256||'')||! /^[a-f0-9]{64}$/.test(result.revision||''))denied('节点校园入口身份无效。',503);
  if(workspace&&(result.area!=='workspace'||result.file?.protocol!==2||result.file.path!==args.path
    ||!['ABSENT','UPLOADING','COMPLETE'].includes(result.file.state)))denied('节点未确认个人数据工作区的校园上传协议。',503);
  if(snapshot&&(result.area!=='snapshot'||result.file?.protocol!==2||result.file.path!==args.path
    ||! /^[a-f0-9]{64}$/.test(result.file.fingerprint||'')||!Number.isSafeInteger(result.file.size)||result.file.size<0
    ||result.file.manifestSha256!==download.manifestSha256))denied('节点未确认原下载的固定校园来源。',503);
  const now=Date.now()/1000;
  service.db.prepare('DELETE FROM personal_file_authorizations WHERE expires_at<=?').run(now);
  for(const [key,entry] of service.personalFileTickets)if(entry.expiresAt<=now)service.personalFileTickets.delete(key);
  if(service.personalFileTickets.size>=4096)denied('文件授权繁忙，请稍后核对原操作。',429);
  const key=hash(result.ticket),entry={principal:before,sessionHash:hash(token),args:request,policy,jobSpec,
    ...(snapshot?{downloadBinding:download.binding}:{}),expiresAt:result.expiresAt};
  service.db.prepare('INSERT INTO personal_file_authorizations(ticket_hash,expires_at,data) VALUES(?,?,?) ON CONFLICT(ticket_hash) DO UPDATE SET expires_at=excluded.expires_at,data=excluded.data').run(key,entry.expiresAt,JSON.stringify(entry));
  service.personalFileTickets.set(key,entry);
  const lan=service.personalFileLanEndpoints?.[args.machine];
  // Bound renewal by server TTL rather than a member's wall-clock offset.
  // Keep the node's exact expiry and bearer grant unchanged.
  const issuedAt=Math.floor(Date.now()/1000),ttl=Math.min(300,result.expiresAt-issuedAt);
  return {result:{...result,...(result.issuedAt===undefined&&result.ttl===undefined?{issuedAt,ttl}:{}),routes:[{id:'primary',kind:'campus-direct',endpoint:result.endpoint},
    ...(lan&&lan!==result.endpoint?[{id:'node-lan',kind:'campus-direct',endpoint:lan}]:[])]},principal:current};
}
