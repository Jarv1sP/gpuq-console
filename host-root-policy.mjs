export const HOST_ROOT_DISABLED='ROOT 宿主命令已由平台负责人停用';

// Immutable account IDs in private server configuration; no account is trusted
// by default. A whitelist entry never grants an administrator role or a host.
export function parseHostRootAllowlist(raw='[]'){
  let ids;
  try{ids=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw Error('Invalid host ROOT allowlist');}
  if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(id)))throw Error('Invalid host ROOT allowlist');
  return new Set(ids);
}

export function assertHostRootAllowed(service,principal,operation,args){
  const root=operation==='host.exec'||['terminal.open','terminal.exchange'].includes(operation)&&!!args?.hostAdmin;
  if(!root)return;
  const user=service.store.users.find(user=>user.id===principal.userId);
  if(principal.role==='admin'&&user?.enabled===true&&user.role==='admin'&&user.username===principal.username&&service.hostRootAllowlist?.has(user.id))return;
  // Never include argv, terminal input, writer tokens or output in this record.
  service.audit(principal.username,operation,args?.machine,'DENIED:HOST_ROOT_DISABLED');
  throw Object.assign(Error(HOST_ROOT_DISABLED),{status:403,code:'HOST_ROOT_DISABLED'});
}

export function installHostRootPolicy(service){
  const bridge=service.bridge;
  if(bridge)service.bridge=(machine,operation,args,context)=>{
    const user=service.store.users.find(user=>user.id===args?.userId);
    assertHostRootAllowed(service,{userId:args?.userId,username:user?.username||'unknown',role:user?.role},operation,{...args,machine});
    return bridge(machine,operation,args,context);
  };
}
