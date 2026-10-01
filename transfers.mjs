import {randomUUID,createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {executionCall} from './execution.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,hash=/^[a-f0-9]{64}$/;
const done=new Set(['SUCCEEDED','CANCELED']),states=new Set(['RUNNING','RETRYING','VERIFYING','CANCELING','UNKNOWN','SUCCEEDED','FAILED','PAUSED','CANCELED']);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const fields=(args,allowed)=>{if(Object.keys(args).some(k=>!allowed.includes(k)))fail('传输参数无效。');};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId=value=>{if(typeof value!=='string'||!uuid.test(value))fail('需提供完整传输 UUID。');return value;};
function info(value){
  if(value?.state!=='READY'||!hash.test(value.manifestSha256||'')||!Number.isSafeInteger(value.manifestBytes)||value.manifestBytes<1||value.manifestBytes>64*1024**2||!Number.isSafeInteger(value.totalBytes)||value.totalBytes<0||!Number.isSafeInteger(value.entries)||value.entries<0||value.entries>500000)fail('快照尚未就绪或清单无效。',409);
  return Object.fromEntries(['state','manifestBytes','manifestSha256','totalBytes','entries'].map(k=>[k,value[k]]));
}
function load(service,id){const row=service.db.prepare('SELECT * FROM transfers WHERE id=?').get(validId(id));if(!row)fail('传输不存在。',404);return {...row,data:JSON.parse(row.data)};}
function view(row){const {sourceTicket,...safe}=row.data;return {id:row.id,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at,...safe};}
function transaction(service,fn){service.db.exec('BEGIN IMMEDIATE');try{const result=fn();service.db.exec('COMMIT');return result;}catch(e){service.db.exec('ROLLBACK');throw e;}}
function save(service,row,state,actor,operation){
  transaction(service,()=>{service.db.prepare('UPDATE transfers SET state=?,data=?,updated_at=? WHERE id=?').run(state,JSON.stringify(row.data),Date.now(),row.id);if(state!==row.state||operation!=='transfers.sync')service.audit(actor,operation,row.id,state);});return load(service,row.id);
}
function authorized(service,user,machine){if(!MACHINES.some(m=>m.id===machine)||!service.store.get(user.id).limits[machine])fail('这台机器未授权。',403);}
function access(service,principal,row){
  if(row.owner_id!==principal.userId)fail('传输不存在或属于其他账号。',404);
  const user=service.store.users.find(u=>u.id===principal.userId);if(!user?.enabled)fail('账号已暂停。',403);
  for(const machine of [row.data.machine,row.data.from].filter(Boolean))authorized(service,user,machine);
}
async function sync(service,row,actor='transfer-reconcile'){
  if(done.has(row.state))return row;
  const data=row.data;let state=row.state;
  try{
    if(data.cancelRequested){
      // Reconcile the ORIGINAL cancellation, not a new execution. An early
      // CANCELING/UNKNOWN receipt must eventually become confirmed terminal.
      if(data.kind==='copy'){
        const result=await service.bridge(data.machine,'transfers.cancel',{id:row.id,userId:row.owner_id});
        if(result.id!==row.id||!states.has(result.state))throw Error('Cancel receipt mismatch');
        data.result=result;state=['CANCELED','SUCCEEDED'].includes(result.state)?result.state:result.state==='UNKNOWN'?'UNKNOWN':'CANCELING';
      }else if(data.kind==='upload'){
        const result=await service.bridge(data.machine,'datasets.upload.pause',{uploadId:data.uploadId||row.client_key,userId:row.owner_id,hostAdmin:false});
        data.result=result;state=result.state==='READY'?'SUCCEEDED':'CANCELED';
      }else state='CANCELED';
    }else if(data.kind==='copy'){
      const result=await service.bridge(data.machine,'transfers.status',{id:row.id,userId:row.owner_id});
      if(result.id!==row.id||!states.has(result.state))throw Error('Node receipt mismatch');
      data.result=result;state=result.state;
    }else if(data.kind==='upload'&&data.uploadId){
      const result=await service.bridge(data.machine,'datasets.upload.status',{uploadId:data.uploadId,userId:row.owner_id,hostAdmin:false});
      data.result=result;state=result.state==='READY'?'SUCCEEDED':result.state==='DISCARDED'?'CANCELED':['SEALING','PUBLISHING'].includes(result.state)?'VERIFYING':result.state==='FAILED'?'FAILED':'WAITING_CLIENT';
    }
    delete data.error;
  }catch{state='UNKNOWN';data.error='原节点回执未确认；不会自动改机器或重复启动。';}
  return save(service,row,state,actor,'transfers.sync');
}
async function dispatch(service,principal,row){
  const data=row.data,user=service.store.get(principal.userId);
  // Repeating create uses the SAME node ID / upload key. Never mint a second
  // execution after an ambiguous request. Source grant is durably saved first.
  if(data.kind==='copy'){
    if(!data.sourceTicket){
      const result=await service.bridge(data.from,'transfers.source.prepare',{id:row.id,reference:data.reference,userId:user.id,hostAdmin:principal.role==='admin',timeoutSec:data.timeoutSec});
      data.sourceTicket={id:row.id,token:result.token,...info(result)};
      row=save(service,row,'DISPATCHING',principal.username,'transfers.source-prepared');
    }
    const result=await service.bridge(data.machine,'transfers.start',{id:row.id,userId:user.id,sourceMachine:data.from,source:data.sourceTicket,reference:data.reference,name:data.name,timeoutSec:data.timeoutSec});
    if(result.id!==row.id||!states.has(result.state))fail('节点传输回执不匹配。',502);
    row.data.result=result;return save(service,row,result.state,principal.username,'transfers.dispatched');
  }
  if(data.kind==='upload'){
    const result=await executionCall(service,principal,'datasets.upload.begin',{machine:data.machine,key:row.client_key,name:data.name,...data.manifest});
    row.data.uploadId=validId(result.uploadId);row.data.result=result;
    return save(service,row,result.state==='READY'?'SUCCEEDED':'WAITING_CLIENT',principal.username,'transfers.upload-start');
  }
  row.data.snapshot=info(await executionCall(service,principal,'datasets.snapshot.info',{machine:data.machine,dataset:data.reference.dataset,version:data.reference.version}));
  return save(service,row,'WAITING_CLIENT',principal.username,'transfers.download-ready');
}
export function installTransfers(service){
  service.db.exec(`CREATE TABLE IF NOT EXISTS transfers(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,client_key TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(owner_id,client_key));CREATE INDEX IF NOT EXISTS transfers_state ON transfers(state,updated_at);`);
  service.transfersReconciling=false;
  service.reconcileTransfers=async()=>{
    if(service.closing||!service.bridge||service.transfersReconciling)return;service.transfersReconciling=true;
    try{const rows=service.db.prepare("SELECT id FROM transfers WHERE state NOT IN ('SUCCEEDED','CANCELED','PAUSED','FAILED') AND json_extract(data,'$.kind') != 'download' ORDER BY updated_at LIMIT 4").all();for(const {id} of rows)await service.enqueue(async()=>{if(!service.closing)await sync(service,load(service,id));});}finally{service.transfersReconciling=false;}
  };
  service.transferTimer=setInterval(()=>service.reconcileTransfers().catch(()=>{}),15000);service.transferTimer.unref();
}
export async function transferCall(service,principal,operation,args){
  if(!service.bridge)fail('节点执行桥尚未配置。',503);
  const user=service.store.get(principal.userId);if(!user.enabled)fail('账号已暂停。',403);
  if(operation==='transfers.list'){
    fields(args,['cursor','limit']);const cursor=args.cursor??0,limit=args.limit??25;
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>50)fail('传输分页参数无效。');
    const rows=service.db.prepare('SELECT * FROM transfers WHERE owner_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(user.id,cursor||Number.MAX_SAFE_INTEGER,limit+1);
    return {transfers:rows.slice(0,limit).map(r=>view({...r,data:JSON.parse(r.data)})),nextCursor:rows.length>limit?rows[limit-1].seq:null};
  }
  if(operation==='transfers.create'){
    fields(args,['key','kind','machine','from','dataset','version','name','timeoutSec','manifest']);validId(args.key);
    if(!['copy','upload','download'].includes(args.kind))fail('请选择 upload、download 或 copy。');authorized(service,user,args.machine);
    const payload={kind:args.kind,machine:args.machine};
    if(args.kind==='upload'){
      if(args.from!==undefined||args.dataset!==undefined||args.version!==undefined||args.timeoutSec!==undefined)fail('上传只接受本机固定清单。');
      const manifest=args.manifest;info({state:'READY',...manifest});fields(manifest,['manifestBytes','manifestSha256','totalBytes','entries']);payload.manifest=manifest;
    }else{
      if(args.manifest!==undefined||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.dataset||'')||!hash.test(args.version||''))fail('需固定完整数据集版本。');payload.reference={kind:'datasets',dataset:args.dataset,version:args.version};
    }
    if(args.kind==='copy'){
      authorized(service,user,args.from);if(args.from===args.machine)fail('源节点和目标节点应不同。');payload.from=args.from;payload.timeoutSec=args.timeoutSec??86400;
      if(!Number.isInteger(payload.timeoutSec)||payload.timeoutSec<1||payload.timeoutSec>604800)fail('传输期限为 1–604800 秒。');
    }else if(args.from!==undefined)fail('只在 copy 中使用 from。');
    if(args.kind!=='download'){
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(args.name||''))fail('目标名称需为 1–40 位字母、数字、短横线或下划线。');payload.name=args.name;
    }else if(args.name!==undefined||args.timeoutSec!==undefined)fail('下载不接受服务器任务参数。');
    let previous=service.db.prepare('SELECT id,digest FROM transfers WHERE owner_id=? AND client_key=?').get(user.id,args.key),row;
    if(previous){if(previous.digest!==digest(payload))fail('同一重试键不能修改传输内容。',409);row=load(service,previous.id);if(done.has(row.state)||row.data.cancelRequested)return view(row);}
    else{
      if(service.db.prepare('SELECT COUNT(*) n FROM transfers').get().n>=10000)fail('传输历史已达上限，请联系管理员归档。',429);
      if(service.db.prepare("SELECT COUNT(*) n FROM transfers WHERE owner_id=? AND state NOT IN ('SUCCEEDED','CANCELED','PAUSED','FAILED')").get(user.id).n>=20)fail('请先处理现有传输任务。',429);
      const id=randomUUID(),now=Date.now();transaction(service,()=>{service.db.prepare('INSERT INTO transfers(id,owner_id,client_key,digest,state,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)').run(id,user.id,args.key,digest(payload),'DISPATCHING',now,now,JSON.stringify({...payload,owner:{id:user.id,username:user.username,name:user.name}}));service.audit(principal.username,operation,id,'DISPATCHING');});row=load(service,id);
    }
    try{return view(await dispatch(service,principal,row));}catch(error){row=load(service,row.id);row.data.error=String(error.message).slice(0,300);return view(save(service,row,'UNKNOWN',principal.username,'transfers.dispatch-unknown'));}
  }
  const row=load(service,args.id);access(service,principal,row);
  if(operation==='transfers.status'){fields(args,['id']);return view(await sync(service,row,principal.username));}
  if(operation==='transfers.cancel'){
    fields(args,['id']);if(done.has(row.state))return view(row);
    row.data.cancelRequested=true;
    let current=save(service,row,'CANCELING',principal.username,operation);
    if(row.data.kind==='copy'){
      try{const result=await service.bridge(row.data.machine,'transfers.cancel',{id:row.id,userId:user.id});current.data.result=result;return view(save(service,current,result.state,principal.username,'transfers.cancel-result'));}catch{current.data.error='取消回执未确认；核对原传输，不会重启。';return view(save(service,current,'UNKNOWN',principal.username,'transfers.cancel-unknown'));}
    }
    if(row.data.kind==='upload'){
      try{if(!row.data.uploadId)current=await dispatch(service,principal,current);await service.bridge(row.data.machine,'datasets.upload.pause',{uploadId:current.data.uploadId,userId:user.id,hostAdmin:false});}catch{current.data.error='上传后台校验是否已停尚未确认；重试取消。';return view(save(service,current,'UNKNOWN',principal.username,'transfers.cancel-unknown'));}
    }
    return view(save(service,current,'CANCELED',principal.username,'transfers.canceled'));
  }
  if(operation==='transfers.resume'){
    fields(args,['id']);if(done.has(row.state)||row.data.cancelRequested)fail('完成或取消的传输不能恢复。',409);
    if(row.data.kind!=='copy')return view(save(service,row,'WAITING_CLIENT',principal.username,operation));
    const current=await sync(service,row,principal.username);
    if(!['PAUSED','FAILED'].includes(current.state))fail('先确认原任务已经停止；UNKNOWN 不会启动新尝试。',409);
    const ticket=await service.bridge(row.data.from,'transfers.source.prepare',{id:row.id,reference:row.data.reference,userId:user.id,hostAdmin:principal.role==='admin',timeoutSec:row.data.timeoutSec,renew:true});
    const source={id:row.id,token:ticket.token,...info(ticket)};
    if(Object.keys(current.data.sourceTicket).some(k=>k!=='token'&&current.data.sourceTicket[k]!==source[k]))fail('恢复只能读取原固定版本。',409);
    current.data.sourceTicket=source;const saved=save(service,current,'DISPATCHING',principal.username,'transfers.resume-intent');
    try{const result=await service.bridge(row.data.machine,'transfers.resume',{id:row.id,userId:user.id,source});saved.data.result=result;return view(save(service,saved,result.state,principal.username,operation));}
    catch{saved.data.error='恢复回执未确认；核对同一任务，不会重复启动。';return view(save(service,saved,'UNKNOWN',principal.username,'transfers.resume-unknown'));}
  }
  if(operation==='transfers.io'){
    fields(args,['id','action','path','offset','data']);if(done.has(row.state)||row.data.cancelRequested)fail('此传输已结束或正在取消。',409);
    let result;
    if(row.data.kind==='upload'){
      if(!row.data.uploadId)fail('上传初始化未确认，请重复原 create。',409);
      if(!['status','manifest','seal','chunk','commit'].includes(args.action))fail('上传操作无效。');
      const {id,action,...request}=args;result=await executionCall(service,principal,'datasets.upload.'+action,{machine:row.data.machine,uploadId:row.data.uploadId,...request});
      row.data.result=result;save(service,row,result.state==='READY'?'SUCCEEDED':['SEALING','PUBLISHING'].includes(result.state)?'VERIFYING':result.state==='FAILED'?'FAILED':'WAITING_CLIENT',principal.username,'transfers.sync');
    }else if(row.data.kind==='download'){
      if(!['info','manifest','get'].includes(args.action))fail('下载仅允许读取固定快照。');
      const {id,action,...request}=args;result=await executionCall(service,principal,'datasets.snapshot.'+action,{machine:row.data.machine,dataset:row.data.reference.dataset,version:row.data.reference.version,...request});
    }else fail('LAN 传输由节点后台执行，不通过客户端搬运。');
    return result;
  }
  if(operation==='transfers.progress'){
    fields(args,['id','bytes','complete']);if(row.data.kind!=='download'||done.has(row.state)||row.data.cancelRequested)fail('下载进度不可更新。');
    if(!Number.isSafeInteger(args.bytes)||args.bytes<0||args.bytes>row.data.snapshot?.totalBytes||typeof args.complete!=='boolean'||args.complete&&args.bytes!==row.data.snapshot.totalBytes)fail('下载进度无效。');
    row.data.result={bytes:args.bytes,totalBytes:row.data.snapshot.totalBytes,clientReported:true};
    return view(save(service,row,args.complete?'SUCCEEDED':'WAITING_CLIENT',principal.username,'transfers.sync'));
  }
  fail('未知传输操作。');
}
