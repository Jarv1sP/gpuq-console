// Project identities are always derived from the authenticated account. A
// client chooses a node and an opaque project/release, never a host filesystem.
export const PROJECT=/^[a-z][a-z0-9_-]{0,47}$/;
export const RELEASE=/^[a-f0-9]{64}$/;
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function projectReference(args,{optional=true,release=false}={}){
  if(args.project===undefined){if(!optional||args.release!==undefined)fail('请先选择项目。');return {};}
  if(typeof args.project!=='string'||!PROJECT.test(args.project))fail('项目名称须以小写字母开头，仅用字母、数字、下划线或连字符，最长 48 位。');
  if(release&&(typeof args.release!=='string'||!RELEASE.test(args.release)))fail('训练必须使用已发布的完整项目版本。先发布代码和环境。');
  return {project:args.project,...(release?{release:args.release}:{})};
}
export async function projectCall(service,principal,user,operation,args,authorizedMachine){
  if(!['projects.list','projects.quota','projects.create','projects.status','projects.publish'].includes(operation))return undefined;
  authorizedMachine(args.machine);
  const ownerOnly=['projects.list','projects.quota'].includes(operation);
  const allowed=ownerOnly?['machine']:['machine','project'];
  if(operation==='projects.create')allowed.push('environmentMode');
  if(operation==='projects.publish')allowed.push('key');
  if(Object.keys(args).some(k=>!allowed.includes(k)))fail('项目参数无效。');
  if(args.key!==undefined&&(typeof args.key!=='string'||!UUID.test(args.key)))fail('发布标识必须是完整 UUID。');
  if(args.environmentMode!==undefined&&!['shared','isolated','oci'].includes(args.environmentMode))fail('环境模式只能是 shared、isolated 或 oci。');
  const reference=ownerOnly?{}:projectReference(args,{optional:false});
  const result=await service.bridge(args.machine,operation,{...reference,...(args.environmentMode!==undefined?{environmentMode:args.environmentMode}:{}),...(args.key!==undefined?{key:args.key}:{}),userId:user.id});
  if(operation==='projects.quota')return quotaStatus(result,user.id);
  if(['projects.create','projects.publish'].includes(operation))service.audit(principal.username,operation,args.machine,args.project);
  return result;
}
export function quotaStatus(value,owner){
  const unknown=()=>fail('磁盘硬配额用量未确认，请联系管理员；不会当作零用量。',503);
  if(!value||typeof value!=='object'||Array.isArray(value)||value.owner!==owner||typeof value.enabled!=='boolean')unknown();
  if(!value.enabled){
    const keys=Object.keys(value).sort().join(',');
    if(!['enabled,enforcement,owner,volumes','enabled,enforcement,owner,reason,volumes'].includes(keys)||value.enforcement!==null||value.volumes!==null||(keys.includes('reason')&&value.reason!=='OWNER_NOT_ACTIVATED'))unknown();
    return value;
  }
  if(Object.keys(value).sort().join(',')!=='enabled,enforcement,owner,projectId,volumes'||value.enforcement!=='kernel-project-quota'||!Number.isSafeInteger(value.projectId)||value.projectId<10000||value.projectId>=2**31||!Array.isArray(value.volumes)||!value.volumes.length||value.volumes.length>8)unknown();
  const seen=new Set();
  for(const row of value.volumes){
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='bytes,inodes,remainingBytes,remainingInodes,usedBytes,usedInodes,volume'||typeof row.volume!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(row.volume)||seen.has(row.volume))unknown();
    for(const key of ['bytes','inodes','usedBytes','usedInodes','remainingBytes','remainingInodes'])if(!Number.isSafeInteger(row[key])||row[key]<0)unknown();
    if(!row.bytes||!row.inodes||row.remainingBytes!==Math.max(0,row.bytes-row.usedBytes)||row.remainingInodes!==Math.max(0,row.inodes-row.usedInodes))unknown();
    seen.add(row.volume);
  }
  return value;
}
export function validateProjectFile(args){
  const reference=projectReference(args);
  if(!reference.project){
    if(['area','runId','uploadId','totalSize','sha256','final'].some(k=>args[k]!==undefined))fail('这些文件参数仅用于项目工作区。');
    return {};
  }
  if(args.area!==undefined&&!['code','output'].includes(args.area))fail('只能访问项目代码或本人的任务输出。');
  const area=args.area||'code';
  if(area==='output'&&(typeof args.runId!=='string'||!UUID.test(args.runId)))fail('下载输出时必须指定任务 ID。');
  if(area==='code'&&args.runId!==undefined)fail('代码工作区不能指定任务 ID。');
  return {...reference,area,...(area==='output'?{runId:args.runId}:{})};
}
