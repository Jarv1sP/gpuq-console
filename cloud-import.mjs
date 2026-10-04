import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {AliyunShare,shareReference} from './aliyun-share.mjs';
import {MACHINES} from './dist/model.js';
import {configuredCloudDriveProvider} from './clouddrive-provider.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
function fields(args,allowed){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k)))fail('导入参数无效。');}
export function importPath(path){if(typeof path!=='string'||!path||Buffer.byteLength(path)>1024||/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255))fail('保存位置请填写个人 /data2 内的相对文件名。');return path;}
function directURL(value){let u;try{u=new URL(value);}catch{fail('请输入完整 HTTPS 下载链接。');}if(typeof value!=='string'||value.length>16384||u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443')fail('仅接受不含账号密码的 HTTPS 下载链接。');return u.href;}
const backendOf=provider=>provider.backend==='clouddrive'?'clouddrive':'aliyun';
function downloadDescriptor(value){
  const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const header=value=>typeof value==='string'&&value.length>=1&&value.length<=512&&/^[\x20-\x7e]+$/.test(value);
  if(typeof value==='string'){try{return {url:directURL(value)};}catch{fail('云盘没有返回安全的 HTTPS 下载地址。',502);}}
  if(!plain(value)||Object.keys(value).some(key=>!['url','userAgent','additionalHeaders'].includes(key))||value.additionalHeaders!==undefined&&!plain(value.additionalHeaders))fail('云盘下载描述符无效。',502);
  let url;try{url=directURL(value.url);}catch{fail('云盘没有返回安全的 HTTPS 下载地址。',502);}
  const downloadHeaders={};
  if(value.userAgent!==undefined){if(!header(value.userAgent))fail('云盘下载 User-Agent 无效。',502);downloadHeaders['User-Agent']=value.userAgent;}
  for(const [name,content] of Object.entries(value.additionalHeaders||{})){
    if(!['Referer','Origin'].includes(name)||!header(content)||!/^https:\/\/www\.(?:alipan|aliyundrive)\.com\/?$/.test(content))fail('云盘下载请求头不受支持。',502);
    downloadHeaders[name]=content;
  }
  return {url,...(Object.keys(downloadHeaders).length?{downloadHeaders}:{})};
}
export function installCloudImports(service,{provider,request}={}){
  service.db.exec(`CREATE TABLE IF NOT EXISTS cloud_secrets(id TEXT PRIMARY KEY,cipher TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cloud_imports(user_id TEXT NOT NULL,machine TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,cipher TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,machine,id)); CREATE TABLE IF NOT EXISTS cloud_provider_settings(backend TEXT PRIMARY KEY,disabled INTEGER NOT NULL CHECK(disabled IN (0,1)));`);
  service.cloudSeal=(id,value)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',service.inviteKey,iv);c.setAAD(Buffer.from('gpuq-cloud:'+id));const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');};
  service.cloudOpen=(id,value)=>{const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',service.inviteKey,b.subarray(0,12));c.setAAD(Buffer.from('gpuq-cloud:'+id));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8'));};
  const load=()=>{const row=service.db.prepare("SELECT cipher FROM cloud_secrets WHERE id='aliyun'").get();return row?service.cloudOpen('aliyun',row.cipher):null;};
  const save=value=>service.db.prepare("INSERT INTO cloud_secrets VALUES('aliyun',?) ON CONFLICT(id) DO UPDATE SET cipher=excluded.cipher").run(service.cloudSeal('aliyun',value));
  service.cloudReloadProvider=provider?()=>provider:()=>configuredCloudDriveProvider({receiptKey:service.inviteKey});
  service.cloudProvider=provider||service.cloudReloadProvider()||new AliyunShare({load,save,request});
  service.cloudDisabled=()=>backendOf(service.cloudProvider)==='clouddrive'&&service.db.prepare("SELECT disabled FROM cloud_provider_settings WHERE backend='clouddrive'").get()?.disabled===1;
  if(service.cloudDisabled())service.cloudProvider.clear();
  service.cloudGeneration=(service.cloudGeneration||0)+1;service.cloudQR=new Map();service.cloudInspections=new Map();service.cloudRates=new Map();
}
function rate(service,user,kind,limit){const now=Date.now();for(const [key,v] of service.cloudRates)if(v.until<now)service.cloudRates.delete(key);const key=user+':'+kind,current=service.cloudRates.get(key)||{until:now+60000,n:0};if(++current.n>limit)fail('请求较多，请稍后重试。',429);service.cloudRates.set(key,current);}
function sweep(service){const now=Date.now();for(const map of [service.cloudQR,service.cloudInspections])for(const [key,v] of map)if(v.expiresAt<now)map.delete(key);}
function authorized(service,actor,machine){const user=service.store.get(actor.userId);if(!user.enabled||!MACHINES.some(m=>m.id===machine)||!user.limits[machine])fail('这台机器未授权。',403);if(!service.bridge)fail('节点执行桥未连接。',503);}
export async function cloudImportCall(service,actor,operation,args,assertCurrent=()=>{}){
  service.assertMaintenanceAllowed?.(operation,args,actor);
  const provider=service.cloudProvider,backend=backendOf(provider),generation=service.cloudGeneration;sweep(service);
  const current=()=>{assertCurrent();if(service.cloudProvider!==provider||service.cloudGeneration!==generation||service.cloudDisabled())fail('云盘连接已更改或停用，请重新操作。',409);};
  if(operation==='cloud.info'){
    fields(args,[]);const disabled=service.cloudDisabled(),managedExternally=backend==='clouddrive',configuration=managedExternally?provider.configuration():{};
    const status=managedExternally?(disabled?'disabled':!configuration.configurationEnabled?'configuration_disabled':!configuration.capabilityVerified?'capability_unverified':'configured'):(provider.connected()?'connected':'disconnected');
    return {version:1,aliyunConnected:!disabled&&provider.connected(),providers:['https','aliyun'],nodeDirect:true,backend,managedExternally,disabled,status,...configuration};
  }
  if(operation.startsWith('cloud.auth.')){
    if(actor.role!=='admin')fail('云盘连接仅管理员可管理。',403);
    if(backend==='clouddrive'&&['cloud.auth.begin','cloud.auth.poll'].includes(operation)){
      fields(args,operation==='cloud.auth.poll'?['id']:[]);fail('CloudDrive 授权由管理员在专用后台和私有配置中管理，门户不提供账号扫码。',409);
    }
    if(operation==='cloud.auth.begin'){
      fields(args,[]);rate(service,actor.userId,'auth',3);const login=await provider.begin(),id=randomUUID();assertCurrent();
      for(const [key,v] of service.cloudQR)if(v.userId===actor.userId)service.cloudQR.delete(key);
      if(service.cloudQR.size>=20)fail('授权会话较多，请稍后重试。',429);
      service.cloudQR.set(id,{...login,userId:actor.userId,nextPoll:0});service.audit(actor.username,operation,'aliyun','started');return {id,image:login.image,expiresAt:login.expiresAt};
    }
    if(operation==='cloud.auth.poll'){
      fields(args,['id']);const login=service.cloudQR.get(args.id);if(!login||login.userId!==actor.userId)fail('二维码已过期，请重新获取。',404);
      if(Date.now()<login.nextPoll)fail('请稍后检查扫码状态。',429);login.nextPoll=Date.now()+2500;
      const result=await provider.poll(login.secret);assertCurrent();if(['CONFIRMED','EXPIRED','CANCELED'].includes(result.state))service.cloudQR.delete(args.id);
      if(result.state==='CONFIRMED')service.audit(actor.username,operation,'aliyun','connected');return result;
    }
    if(operation==='cloud.auth.disconnect'){
      fields(args,[]);
      if(backend==='clouddrive')service.db.prepare("INSERT INTO cloud_provider_settings VALUES('clouddrive',1) ON CONFLICT(backend) DO UPDATE SET disabled=1").run();
      else service.db.prepare("DELETE FROM cloud_secrets WHERE id='aliyun'").run();
      service.cloudGeneration++;provider.clear();service.cloudQR.clear();service.cloudInspections.clear();service.audit(actor.username,operation,backend,'disconnected');return {disconnected:true,backend,persistent:true};
    }
    if(operation==='cloud.auth.reconnect'){
      fields(args,[]);if(backend!=='clouddrive')fail('此操作仅用于重新启用已配置的 CloudDrive 后台。',409);
      const candidate=service.cloudReloadProvider();
      if(!candidate||backendOf(candidate)!=='clouddrive')fail('CloudDrive 私有配置不存在，不能重新启用。',409);
      const configuration=candidate.configuration();
      if(!configuration.configurationEnabled||!configuration.capabilityVerified){if(candidate!==provider)candidate.close();fail('CloudDrive 私有配置尚未启用或分享能力未验收，不能重新启用。',409);}
      candidate.reconnect();
      try{service.db.prepare("INSERT INTO cloud_provider_settings VALUES('clouddrive',0) ON CONFLICT(backend) DO UPDATE SET disabled=0").run();}catch(error){candidate.clear();if(candidate!==provider)candidate.close();throw error;}
      service.cloudProvider=candidate;service.cloudGeneration++;if(candidate!==provider)provider.close();service.cloudQR.clear();service.cloudInspections.clear();service.audit(actor.username,operation,backend,'reconnected');return {reconnected:true,backend,managedExternally:true};
    }
    fail('未知云盘授权操作。');
  }
  if(operation==='cloud.inspect'){
    fields(args,['machine','url','password']);authorized(service,actor,args.machine);rate(service,actor.userId,'inspect',6);
    current();if(!provider.connected())fail(backend==='clouddrive'?'CloudDrive 后台配置未启用或分享能力尚未验收。':'管理员尚未连接阿里云盘。',409);const source=shareReference(args.url,args.password),files=await provider.list(source),id=randomUUID();current();
    if(service.cloudInspections.size>=200)fail('分享解析较多，请稍后重试。',429);
    service.cloudInspections.set(id,{userId:actor.userId,machine:args.machine,source,files,backend,expiresAt:Date.now()+3600000});
    return {inspectionId:id,files:files.map(({id,name,size})=>({id,name,size})),note:'仅列出分享根目录的文件；目录请先压缩后分享。'};
  }
  if(!operation.startsWith('cloud.import.'))fail('未知云盘操作。');
  authorized(service,actor,args.machine);const action=operation.slice(13);
  if(['list','status','cancel','discard'].includes(action)){
    fields(args,action==='list'?['machine']:['machine','operationId']);if(action!=='list'&&!UUID.test(args.operationId||''))fail('导入编号无效。');
    if(['cancel','discard'].includes(action))service.audit(actor.username,operation,args.machine,args.operationId);
    const result=await service.bridge(args.machine,'datasets.import.'+action,{userId:actor.userId,hostAdmin:false,...(action==='list'?{}:{operationId:args.operationId})});
    assertCurrent();
    if(action==='discard'){
      if(result?.discarded!==true||result.operationId!==args.operationId)fail('节点清理回执未确认，请刷新核对；导入源记录仍保留。',502);
      service.db.prepare('DELETE FROM cloud_imports WHERE user_id=? AND machine=? AND id=?').run(actor.userId,args.machine,args.operationId);
    }
    return result;
  }
  if(!['start','resume'].includes(action))fail('未知导入操作。');
  fields(args,action==='resume'?['machine','operationId','url']:['machine','key','url','path','sha256','expectedBytes','inspectionId','fileId']);
  const key=action==='resume'?args.operationId:args.key;if(!UUID.test(key||''))fail('导入需要有效 UUID 标识。');rate(service,actor.userId,'start',12);
  const identity=JSON.stringify([actor.userId,args.machine,key]);let row=service.db.prepare('SELECT * FROM cloud_imports WHERE user_id=? AND machine=? AND id=?').get(actor.userId,args.machine,key),source;
  if(action==='resume'){
    if(!row)fail('导入记录不存在。',404);source=service.cloudOpen(identity,row.cipher);
    if(args.url!==undefined){if(source.kind!=='https')fail('阿里云盘直链由后台刷新，不接受替换地址。');source.url=directURL(args.url);}
  }else{
    const path=importPath(args.path);
    if(args.inspectionId){
      if(args.url!==undefined||args.sha256!==undefined||args.expectedBytes!==undefined)fail('分享导入的文件身份由服务器确认。');
      const inspection=service.cloudInspections.get(args.inspectionId);if(!inspection||inspection.userId!==actor.userId||inspection.machine!==args.machine)fail('分享列表已过期，请重新读取。',409);
      if((inspection.backend||'aliyun')!==backend)fail('云盘后台已更改，请重新读取分享。',409);
      const file=inspection.files.find(f=>f.id===args.fileId);if(!file)fail('请从当前分享列表选择文件。');source={kind:'aliyun',path,reference:inspection.source,file,...(backend==='clouddrive'?{backend}:{})};
    }else{
      if(args.fileId!==undefined)fail('文件编号需要分享列表。');
      if(args.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(args.sha256)||args.expectedBytes!==undefined&&(!Number.isSafeInteger(args.expectedBytes)||args.expectedBytes<0))fail('文件校验值或大小无效。');
      source={kind:'https',path,url:directURL(args.url),...(args.sha256?{sha256:args.sha256}:{}),...(args.expectedBytes!==undefined?{expectedBytes:args.expectedBytes}:{})};
    }
    const digest=createHash('sha256').update(JSON.stringify(source)).digest('hex');
    if(row&&row.digest!==digest)fail('同一导入标识不能用于另一个文件。',409);
    if(!row){if(service.db.prepare('SELECT count(*) AS n FROM cloud_imports WHERE user_id=?').get(actor.userId).n>=1000)fail('导入历史已达上限，请联系管理员归档。',409);
      service.db.prepare('INSERT INTO cloud_imports VALUES(?,?,?,?,?,?)').run(actor.userId,args.machine,key,digest,service.cloudSeal(identity,source),Date.now());}
  }
  let url=source.url,downloadHeaders;
  if(source.kind==='aliyun'){
    current();if((source.backend||'aliyun')!==backend)fail('此导入属于另一云盘后台，不能切换解析或文件中转。',409);
    if(!provider.connected())fail('云盘连接已停用，请管理员检查。',409);
    const resolved=await provider.resolve(source.reference,source.file);
    current();({url,downloadHeaders}=downloadDescriptor(resolved));
  }
  assertCurrent();
  const node={userId:actor.userId,hostAdmin:false,key,path:source.path,url,sourceKind:source.kind,...(downloadHeaders?{downloadHeaders}:{}),...(source.kind==='aliyun'?{expectedBytes:source.file.size,...(source.file.sha1?{expectedSha1:source.file.sha1}:{})}:{...(source.sha256?{sha256:source.sha256}:{}),...(source.expectedBytes!==undefined?{expectedBytes:source.expectedBytes}:{})})};
  service.audit(actor.username,operation,args.machine,key);
  const result=await service.bridge(args.machine,'datasets.import.start',node);
  assertCurrent();
  if(action==='resume'&&source.kind==='https')service.db.prepare('UPDATE cloud_imports SET cipher=? WHERE user_id=? AND machine=? AND id=?').run(service.cloudSeal(identity,source),actor.userId,args.machine,key);
  return result;
}
