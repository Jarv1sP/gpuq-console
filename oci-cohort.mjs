// Private control-plane membership projection. Not an HTTP/CLI operation.
import {createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
const OWNER=/^(?:builtin-admin|demo-user-[0-9]+)$/;
const fail=message=>{throw Object.assign(Error(message),{status:503});};
export function cohortOwners(users,machine,getUser){
  if(!Array.isArray(users)||users.length>1000||typeof getUser!=='function')fail('容器成员授权未确认。');
  const owners=[];
  for(const raw of users){
    if(raw.enabled!==true)continue;
    if(!OWNER.test(raw.id||''))fail('容器成员身份未确认。');
    // Same trusted effective policy used by ordinary machine authorization;
    // never rewrite raw grants or invent a separate administrator bypass.
    const user=getUser(raw.id);
    if(user?.id!==raw.id||user.enabled!==true||!['admin','member'].includes(user.role||'member'))fail('容器成员身份未确认。');
    if(!Number.isSafeInteger(user.limits?.[machine])||user.limits[machine]<=0)continue;
    owners.push(user.id);
  }
  if(new Set(owners).size!==owners.length)fail('容器成员身份重复。');
  return owners.sort(); // Empty means nobody: never retain a revoked owner.
}
export function installOciCohort(service,machines=[]){
  if(!Array.isArray(machines)||machines.length>MACHINES.length||new Set(machines).size!==machines.length||machines.some(id=>!MACHINES.some(m=>m.id===id)))fail('自动容器成员配置无效。');
  const enabled=new Set(machines),lanes=new Map(),acknowledged=new Map(),events=new Map();
  const ownersFor=machine=>cohortOwners(service.store.users,machine,id=>service.store.get(id));
  if(enabled.size)service.db.exec('CREATE TABLE IF NOT EXISTS oci_cohort_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO oci_cohort_revision VALUES(1,0);');
  service.syncOciCohort=machine=>{
    if(!enabled.has(machine))return Promise.resolve({enabled:false});
    const prior=lanes.get(machine)||Promise.resolve();
    const call=prior.catch(()=>{}).then(async()=>{
      if(service.closing||!service.bridge)fail('容器成员同步暂不可用；未启用或回退环境。');
      // Derive inside the serialized lane, not when an older event is queued.
      const owners=ownersFor(machine),digest=createHash('sha256').update(JSON.stringify(owners)).digest('hex');
      if(acknowledged.get(machine)===digest)return {enabled:true,changed:false};
      const {revision}=service.db.prepare('UPDATE oci_cohort_revision SET revision=revision+1 WHERE id=1 RETURNING revision').get();
      if(!Number.isSafeInteger(revision)||revision<1)fail('容器成员版本无效。');
      const result=await service.bridge(machine,'projects.oci-cohort.sync',{hostAdmin:true,owners,revision});
      if(result?.enabled!==true||result.revision!==revision||result.ownersSHA256!==digest)fail('容器成员同步未确认；不会回退环境。');
      // A newer authorization event may have happened while the RPC ran.
      // Do not cache that stale membership for a following admission.
      if(JSON.stringify(ownersFor(machine))!==JSON.stringify(owners))fail('容器成员授权已改变；请重新确认。');
      acknowledged.set(machine,digest);
      return result;
    });
    lanes.set(machine,call);return call;
  };
  service.syncOciAccountEvent=()=>{
    // Account commits remain durable if a node is offline. First OCI access
    // must still pass sync; a failed event never grants a fallback container.
    for(const machine of enabled){
      const pending=events.get(machine);
      if(pending){pending.dirty=true;continue;}
      const state={dirty:true};events.set(machine,state);
      setImmediate(async()=>{
        try{
          // At most one active notification plus one coalesced new event per
          // host. No timer, polling, retry of a failed event or account wait.
          while(state.dirty&&!service.closing){
            state.dirty=false;
            try{await service.syncOciCohort(machine);}
            catch{try{service.audit('system','oci.cohort.sync',machine,'unconfirmed');}catch{}}
          }
        }finally{events.delete(machine);}
      });
    }
  };
  service.ociCohortAdmission=async(machine,userId)=>{
    if(!enabled.has(machine))return;
    const authorize=()=>{
      const raw=service.store.users.find(user=>user.id===userId);
      if(raw?.enabled!==true||!OWNER.test(raw.id))throw Object.assign(Error('账号或机器授权已改变。'),{status:403});
      const current=service.store.get(userId);
      if(current?.id!==raw.id||current.enabled!==true||!Number.isSafeInteger(current.limits?.[machine])||current.limits[machine]<=0)throw Object.assign(Error('账号或机器授权已改变。'),{status:403});
    };
    authorize();
    await service.syncOciCohort(machine);
    authorize();
  };
  service.ociProjectAdmission=async(machine,userId,project,{creatingOCI=false}={})=>{
    if(!enabled.has(machine))return;
    if(!creatingOCI){
      // The client cannot label an existing object as shared to bypass sync.
      // This response is obtained with the authenticated immutable owner ID.
      const metadata=await service.bridge(machine,'projects.status',{project,userId});
      if(metadata?.project!==project||!['shared','isolated','oci'].includes(metadata.environmentMode))fail('项目容器类型未确认。');
      if(metadata.environmentMode!=='oci')return;
    }
    await service.ociCohortAdmission(machine,userId);
  };
}
