import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {MACHINES} from './dist/model.js';

// Only this module may turn a persisted approval into a host.exec. Members
// never acquire host.* privileges; historical actor IDs are for status/cancel.
export const MAINTENANCE_LIMITS=Object.freeze({records:10000,pending:20,page:50,scriptBytes:8192,previewMs:120000,outputBytes:65536});
const DONE=new Set(['RETURNED','WITHDRAWN','SUCCEEDED','FAILED','CANCELED','TIMED_OUT']);
const NODE_STATES=new Set(['RUNNING','CANCELING','SUCCEEDED','FAILED','CANCELED','TIMED_OUT','UNKNOWN']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const argv=script=>['/bin/bash','--noprofile','--norc','-c',script];
function fields(args,names){if(Object.keys(args).some(k=>!names.includes(k)))fail('维护申请参数无效。');}
function uuid(value){if(typeof value!=='string'||!UUID.test(value))fail('需要完整 UUID 编号。');return value;}
function revision(value){if(!Number.isSafeInteger(value)||value<1)fail('需要当前申请版本号。');return value;}
function text(value,max,label){
  if(typeof value!=='string'||!value.isWellFormed()||value.length>max*2||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||[...value].length>max||!value.trim())fail(`${label}须为 1–${max} 字。`);
  return value.trim();
}
function admin(principal){if(principal.role!=='admin')fail('此操作仅管理员可用。',403);}
function user(service,principal){
  const current=service.store.users.find(u=>u.id===principal.userId);
  if(!current?.enabled||(current.role||'member')!==principal.role)fail('账号权限已改变，请重新登录。',403);
  return current;
}
function authorized(service,current,machine){
  if(!MACHINES.some(m=>m.id===machine)||!service.store.get(current.id).limits[machine])fail('这台机器未授权。',403);
}
function load(service,id){const row=service.db.prepare('SELECT * FROM maintenance_requests WHERE id=?').get(uuid(id));if(!row)fail('申请不存在或无权查看。',404);return row;}
function access(service,principal,row){
  const current=user(service,principal);
  if(principal.role!=='admin'&&row.owner_id!==current.id)fail('申请不存在或无权查看。',404);
  authorized(service,current,JSON.parse(row.data).payload.machine);
  return row;
}
function view(row,detail=true){
  const data=JSON.parse(row.data),{script,reason,...payload}=data.payload;
  return {id:row.id,...payload,owner:data.owner,state:row.state,revision:row.revision,
    createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),
    scriptSha256:data.scriptSha256,...(data.decision?{decision:data.decision}:{}),
    ...(detail?{script,reason,...(data.approver?{execution:{id:data.executionKey,approvedBy:data.approver}}:{}),...(data.result?{result:data.result}:{}),...(data.error?{error:data.error}:{})}:{})};
}
function transaction(service,fn){service.db.exec('BEGIN IMMEDIATE');try{const result=fn();service.db.exec('COMMIT');return result;}catch(error){service.db.exec('ROLLBACK');throw error;}}
function update(service,row,data,state,actor,operation){
  return transaction(service,()=>{
    const written=service.db.prepare('UPDATE maintenance_requests SET data=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(data),state,Date.now(),row.id,row.revision);
    if(written.changes!==1)fail('申请已改变，请刷新后重试。',409);
    // State polling must not grow an audit row every 15 seconds forever.
    if(operation!=='maintenance.sync'||state!==row.state)service.audit(actor,operation,row.id,JSON.stringify({state,digest:row.digest}));
    return load(service,row.id);
  });
}
function bounded(value){return typeof value==='string'?new TextDecoder().decode(Buffer.from(value).subarray(0,MAINTENANCE_LIMITS.outputBytes),{stream:true}):'';}
function resultValue(value,key){
  if(!value||value.id!==key||!NODE_STATES.has(value.state))throw Error('节点命令回执不匹配，需核对原操作。');
  // A node terminal state includes its existing control-group drain proof.
  return {state:value.state,stdout:bounded(value.stdout),stderr:bounded(value.stderr),
    exitCode:Number.isInteger(value.exitCode)?value.exitCode:null,signal:Number.isInteger(value.signal)?value.signal:null,
    timedOut:value.timedOut===true,cancelRequested:value.cancelRequested===true,
    truncated:{stdout:value.truncated?.stdout===true||Buffer.byteLength(value.stdout||'')>MAINTENANCE_LIMITS.outputBytes,
      stderr:value.truncated?.stderr===true||Buffer.byteLength(value.stderr||'')>MAINTENANCE_LIMITS.outputBytes},
    ...(typeof value.error==='string'?{error:value.error.slice(0,400)}:{}),checkedAt:new Date().toISOString()};
}
async function sync(service,row,operation='host.status',actor='maintenance-reconcile'){
  if(DONE.has(row.state))return row;
  const data=JSON.parse(row.data);if(!data.approver)return row;
  let state='UNKNOWN';
  try{
    const result=await service.bridge(data.payload.machine,operation,{id:data.executionKey,
      userId:data.approver.id,username:data.approver.username,hostAdmin:true});
    data.result=resultValue(result,data.executionKey);state=data.result.state;delete data.error;
  }catch{data.error='原操作结果尚未确认；只核对原机器和执行键，不会自动重跑。';}
  // Outside the bridge catch: failed persistence is NOT a successful sync and
  // must leave the prior durable DISPATCHING/UNKNOWN row recoverable.
  return update(service,row,data,state,actor,operation==='host.cancel'?'maintenance.cancel-result':'maintenance.sync');
}
function impact(service,machine){
  const snapshot=service.gpuq,host=snapshot?.hosts.find(h=>h.id===machine);
  if(snapshot?.stale!==false||host?.reachable!==true||host.hostCommand?.version!==1||host.hostCommand.available!==true)
    fail('机器状态过期或管理执行器尚未就绪，未批准也未执行。',503);
  const gpus=host.gpus.map(g=>({uuid:g.uuid,index:g.index,complete:g.processesAvailable===true,
    pids:g.processes.map(p=>p.pid).sort((a,b)=>a-b)})).sort((a,b)=>a.index-b.index);
  const jobs=(host.gpuq.jobs||[]).map(j=>({id:j.id||j.job_id||null,state:j.state||null})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const platformJobs=service.store.jobs.filter(j=>j.machine===machine&&!['SUCCEEDED','FAILED','CANCELED'].includes(j.state))
    .map(j=>({id:j.id,state:j.state})).sort((a,b)=>a.id.localeCompare(b.id));
  const complete=host.gpuq.connected===true&&gpus.length===MACHINES.find(m=>m.id===machine).cards&&gpus.every(g=>g.complete&&g.uuid)&&
    new Set(gpus.map(g=>g.uuid)).size===gpus.length&&new Set(gpus.map(g=>g.index)).size===gpus.length&&jobs.length<100&&jobs.every(j=>typeof j.id==='string'&&typeof j.state==='string');
  return {complete,checkedAt:snapshot.checkedAt,gpus,jobs,platformJobs};
}
const impactDigest=value=>hash({...value,checkedAt:undefined});
function sign(service,payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return body+'.'+createHmac('sha256',service.maintenanceSecret).update(body).digest('hex');}
function verify(service,token){
  if(typeof token!=='string'||token.length>2048)fail('请先获取有效审批预览。',409);
  const [body,signature,...extra]=token.split('.'),expected=createHmac('sha256',service.maintenanceSecret).update(body||'').digest();
  if(extra.length||!signature||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),expected))fail('预览已失效，请重新预览。',409);
  try{return JSON.parse(Buffer.from(body,'base64url'));}catch{fail('预览已失效，请重新预览。',409);}
}
export function installMaintenance(service){
  service.db.exec(`CREATE TABLE IF NOT EXISTS maintenance_requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,client_key TEXT NOT NULL,
    digest TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL,
    UNIQUE(owner_id,client_key));
    CREATE INDEX IF NOT EXISTS maintenance_owner ON maintenance_requests(owner_id,seq);
    CREATE INDEX IF NOT EXISTS maintenance_state ON maintenance_requests(state,updated_at);`);
  service.maintenanceSecret=randomBytes(32);
  service.maintenanceReconciling=false;
  service.reconcileMaintenance=async()=>{
    if(service.closing||!service.bridge||service.maintenanceReconciling)return;
    service.maintenanceReconciling=true;
    try{
      const rows=service.db.prepare("SELECT id FROM maintenance_requests WHERE state IN ('DISPATCHING','RUNNING','CANCELING','UNKNOWN') ORDER BY updated_at LIMIT 4").all();
      for(const {id} of rows){if(service.closing)break;await service.enqueue(async()=>{if(!service.closing)await sync(service,load(service,id));});}
    }finally{service.maintenanceReconciling=false;}
  };
  service.maintenanceTimer=setInterval(()=>service.reconcileMaintenance().catch(()=>{}),15000);service.maintenanceTimer.unref();
}
export async function maintenanceCall(service,principal,operation,args){
  const current=user(service,principal);
  if(operation==='maintenance.create'){
    fields(args,['key','machine','title','reason','script','cwd','timeoutSec','parentId']);
    authorized(service,current,args.machine);const key=uuid(args.key);
    const script=args.script;
    if(typeof script!=='string'||!script.isWellFormed()||!script.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(script)||Buffer.byteLength(script)>MAINTENANCE_LIMITS.scriptBytes||Buffer.byteLength(JSON.stringify(argv(script)))>12000)fail('脚本正文为空、格式无效或超过执行器大小上限（最多 8 KiB）。');
    const cwd=args.cwd??'/root',timeoutSec=args.timeoutSec??300;
    if(typeof cwd!=='string'||!cwd.isWellFormed()||!cwd.startsWith('/')||cwd.length>1024||/[\x00-\x1f\x7f]/.test(cwd))fail('工作目录必须是有效绝对路径。');
    if(!Number.isInteger(timeoutSec)||timeoutSec<1||timeoutSec>86400)fail('超时须为 1–86400 秒。');
    const payload={machine:args.machine,title:text(args.title,120,'标题'),reason:text(args.reason,2000,'申请原因'),script,cwd,timeoutSec};
    if(args.parentId!==undefined){const parent=access(service,principal,load(service,args.parentId));if(parent.owner_id!==current.id)fail('只能引用自己的旧申请。',403);payload.parentId=parent.id;}
    const digest=hash(payload),existing=service.db.prepare('SELECT * FROM maintenance_requests WHERE owner_id=? AND client_key=?').get(current.id,key);
    if(existing){if(existing.digest!==digest)fail('同一提交键不能用于不同申请。',409);return view(existing);}
    return transaction(service,()=>{
      if(service.db.prepare('SELECT count(*) AS n FROM maintenance_requests').get().n>=MAINTENANCE_LIMITS.records)fail('申请记录已满，请联系管理员归档。',507);
      const active=service.db.prepare("SELECT count(*) AS n FROM maintenance_requests WHERE owner_id=? AND state NOT IN ('RETURNED','WITHDRAWN','SUCCEEDED','FAILED','CANCELED','TIMED_OUT')").get(current.id).n;
      if(active>=MAINTENANCE_LIMITS.pending)fail('未完成申请达到 20 条，请先处理旧申请。',429);
      const id=randomUUID(),at=Date.now(),data={payload,owner:{id:current.id,username:current.username},scriptSha256:hash(script),executionKey:randomUUID()};
      service.db.prepare('INSERT INTO maintenance_requests(id,owner_id,client_key,digest,state,revision,created_at,updated_at,data) VALUES(?,?,?,?,?,1,?,?,?)').run(id,current.id,key,digest,'PENDING',at,at,JSON.stringify(data));
      service.audit(principal.username,operation,id,JSON.stringify({state:'PENDING',digest}));return view(load(service,id));
    });
  }
  if(operation==='maintenance.list'){
    fields(args,['cursor','limit']);const limit=args.limit??MAINTENANCE_LIMITS.page;
    if(!Number.isInteger(limit)||limit<1||limit>MAINTENANCE_LIMITS.page)fail('每页数量须为 1–50。');
    if(args.cursor!==undefined&&(typeof args.cursor!=='string'||!/^\d{1,15}$/.test(args.cursor)||!Number.isSafeInteger(Number(args.cursor))))fail('列表游标无效。');
    const machines=MACHINES.filter(m=>service.store.get(current.id).limits[m.id]).map(m=>m.id);
    if(!machines.length)return {items:[],nextCursor:null};
    const own=principal.role==='admin'?'':' AND owner_id=? AND json_extract(data,\'$.payload.machine\') IN ('+machines.map(()=>'?').join(',')+')';
    const rows=service.db.prepare('SELECT * FROM maintenance_requests WHERE seq<?'+own+' ORDER BY seq DESC LIMIT ?')
      .all(Number(args.cursor??Number.MAX_SAFE_INTEGER),...(principal.role==='admin'?[]:[current.id,...machines]),limit+1);
    return {items:rows.slice(0,limit).map(row=>view(row,false)),nextCursor:rows.length>limit?String(rows[limit-1].seq):null};
  }
  const allowed={get:['id'],preview:['id'],approve:['id','revision','previewToken','acknowledgeUnknown'],return:['id','revision','reason'],withdraw:['id','revision'],cancel:['id','revision']}[operation.slice('maintenance.'.length)];
  if(!allowed)fail('未知维护申请操作。');fields(args,allowed);
  let row=access(service,principal,load(service,args.id)),data=JSON.parse(row.data);
  if(operation==='maintenance.get'){if(data.approver&&!DONE.has(row.state))row=await sync(service,row);return view(row);}
  if(operation==='maintenance.withdraw'){
    if(row.owner_id!==current.id)fail('只能撤回自己的待确认申请。',403);
  }else admin(principal);
  if(operation==='maintenance.preview'){
    if(row.state!=='PENDING')fail('申请已不在待确认状态。',409);
    const owner=service.store.users.find(u=>u.id===row.owner_id);if(!owner?.enabled)fail('申请者账号已停用。',403);authorized(service,owner,data.payload.machine);
    if(!service.bridge)fail('管理执行桥未配置。',503);await service.refreshGPUQ();const snapshot=impact(service,data.payload.machine);
    const token=sign(service,{id:row.id,revision:row.revision,digest:row.digest,actor:current.id,impact:impactDigest(snapshot),expires:Date.now()+MAINTENANCE_LIMITS.previewMs});
    return {request:view(row),impact:snapshot,previewToken:token,expiresInSeconds:120};
  }
  revision(args.revision);
  if(operation==='maintenance.approve'&&data.approver){
    if(data.approver.id!==current.id||data.approvedRevision!==args.revision)fail('申请已由其他审批决定处理，请刷新。',409);
    // Same approval retry can only reconcile. No second exec, even after a crash.
    return view(await sync(service,row));
  }
  if(row.revision!==args.revision)fail('申请已改变，请刷新后重试。',409);
  if(operation==='maintenance.cancel'){
    if(!data.approver)fail('未确认的申请不能停止执行，请退回或撤回。',409);
    if(DONE.has(row.state))return view(row);
    row=update(service,row,{...data,cancelRequestedBy:{id:current.id,username:current.username}},'CANCELING',principal.username,operation);
    return view(await sync(service,row,'host.cancel',principal.username));
  }
  if(row.state!=='PENDING')fail('申请已不在待确认状态。',409);
  if(operation==='maintenance.return'||operation==='maintenance.withdraw'){
    data.decision={by:{id:current.id,username:current.username},at:new Date().toISOString(),reason:operation==='maintenance.return'?text(args.reason,2000,'退回理由'):null};
    return view(update(service,row,data,operation==='maintenance.return'?'RETURNED':'WITHDRAWN',principal.username,operation));
  }
  if(operation==='maintenance.approve'){
    const proof=verify(service,args.previewToken);
    if(proof.id!==row.id||proof.revision!==row.revision||proof.digest!==row.digest||proof.actor!==current.id||!Number.isFinite(proof.expires)||proof.expires<Date.now())fail('预览已失效，请重新预览并确认。',409);
    const owner=service.store.users.find(u=>u.id===row.owner_id);if(!owner?.enabled)fail('申请者账号已停用。',403);authorized(service,owner,data.payload.machine);
    if(!service.bridge)fail('管理执行桥未配置。',503);await service.refreshGPUQ();const snapshot=impact(service,data.payload.machine);
    if(proof.impact!==impactDigest(snapshot))fail('机器占用已变化，请重新预览并确认。',409);
    if(args.acknowledgeUnknown!==undefined&&typeof args.acknowledgeUnknown!=='boolean')fail('未知占用确认参数无效。');
    if(!snapshot.complete&&args.acknowledgeUnknown!==true)fail('占用信息不完整，须明确确认仍执行。',409);
    data.approver={id:current.id,username:current.username};data.approvedRevision=row.revision;
    data.decision={by:data.approver,at:new Date().toISOString(),reason:null};
    row=update(service,row,data,'DISPATCHING',principal.username,operation);
    let state='UNKNOWN';
    try{
      const result=await service.bridge(data.payload.machine,'host.exec',{key:data.executionKey,argv:argv(data.payload.script),cwd:data.payload.cwd,timeoutSec:data.payload.timeoutSec,userId:current.id,username:current.username,hostAdmin:true});
      data.result=resultValue(result,data.executionKey);state=data.result.state;delete data.error;
    }catch{data.error='派发结果尚未确认；只核对原机器和执行键，不会自动重跑。';}
    return view(update(service,row,data,state,principal.username,'maintenance.dispatch-result'));
  }
}
