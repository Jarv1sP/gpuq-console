// Same-node personal storage. No host paths, credentials or caller owner fields.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const copyStates=new Set(['QUEUED','RUNNING','VERIFYING','COMMITTING','SUCCEEDED','FAILED','CANCELED','UNKNOWN']);
function receipt(value,key){
  if(value?.protocol!=='personal-copy-v1'||!UUID.test(value.key||'')||key&&value.key!==key||!copyStates.has(value.state))fail('传输回执尚未确认，请查原 UUID。',503);
  const clean={protocol:value.protocol,key:value.key,state:value.state};
  for(const field of ['sourceTier','targetTier'])if(['hdd','ssd'].includes(value[field]))clean[field]=value[field];
  for(const field of ['sourcePath','targetPath','phase','error','errorClass'])if(typeof value[field]==='string')clean[field]=value[field].replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,1024);
  for(const field of ['bytes','totalBytes'])if(Number.isSafeInteger(value[field])&&value[field]>=0)clean[field]=value[field];
  if(Number.isFinite(value.updatedAt)&&value.updatedAt>=0)clean.updatedAt=value.updatedAt;
  if(typeof value.cancelRequested==='boolean')clean.cancelRequested=value.cancelRequested;
  return clean;
}
export async function personalStorageCall(service,principal,user,operation,args,authorizedMachine){
  if(!operation.startsWith('projects.storage.'))return undefined;
  const definitions={info:[],copy:['key','sourceTier','targetTier','sourcePath','targetPath'],
    'copy.status':['key'],'copy.cancel':['key'],'copy.resume':['key'],copies:[],
    publish:['tier','key','name','path'],'publish.status':['tier','key']};
  const action=operation.slice('projects.storage.'.length),fields=Object.hasOwn(definitions,action)?definitions[action]:null;
  if(!fields||Object.keys(args).some(k=>k!=='machine'&&!fields.includes(k)))fail('个人存储参数无效。');
  authorizedMachine(args.machine);
  if(!['info','copies'].includes(action)&&!UUID.test(args.key||''))fail('请使用原传输 UUID；响应不明时不要换编号。');
  if(action==='copy'){
    if(!['hdd','ssd'].includes(args.sourceTier)||!['hdd','ssd'].includes(args.targetTier)||args.sourceTier===args.targetTier)fail('请选择不同的来源盘和目标盘。');
    for(const key of ['sourcePath','targetPath']){
      const path=args[key];
      if(typeof path!=='string'||!path||path.length>1024||path.includes('\\')||/[\p{Cc}\p{Cf}]/u.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255))fail('只接受个人数据入口内的相对目录。');
    }
  }
  if(action.startsWith('publish')){
    if(!['hdd','ssd'].includes(args.tier))fail('请选择 hdd 或 ssd 数据区。');
    if(action==='publish'){
      if(typeof args.name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(args.name)||typeof args.path!=='string'||args.path.length>1024||args.path.includes('\\')||/[\p{Cc}\p{Cf}]/u.test(args.path)||args.path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255))fail('发布需提供个人数据区内的相对目录和有效名称。');
    }
  }
  const before=JSON.stringify(user),{machine,...request}=args;
  const result=await service.bridge(machine,operation,{...request,userId:user.id});
  if(JSON.stringify(service.store.get(user.id))!==before)fail('账号权限已改变；请重新查询原操作。',403);
  if(action==='info'){
    if(result?.protocol!=='personal-storage-v1'||typeof result.available!=='boolean')fail('节点存储能力尚未确认。',503);
    if(!result.available)return {protocol:result.protocol,available:false};
    const volumes={};
    for(const tier of ['hdd','ssd']){
      const v=result.volumes?.[tier];
      if(!v||v.mountPath!=='/data-'+tier||['availableBytes','filesystemBytes','reserveBytes','usableBytes'].some(k=>!Number.isSafeInteger(v[k])||v[k]<0)||v.usableBytes!==Math.max(0,v.availableBytes-v.reserveBytes))fail('磁盘容量尚未确认。',503);
      volumes[tier]=Object.fromEntries(['mountPath','availableBytes','filesystemBytes','reserveBytes','usableBytes'].map(k=>[k,v[k]]));
    }
    return {protocol:result.protocol,available:true,workspaceTier:'hdd',workspaceModes:['isolated','shared'],volumes};
  }
  if(action==='copies'){
    if(result?.protocol!=='personal-copies-v1'||!Array.isArray(result.copies)||result.copies.length>256)fail('传输列表尚未确认。',503);
    return {protocol:result.protocol,copies:result.copies.map(value=>receipt(value)),truncated:result.truncated===true};
  }
  if(action.startsWith('publish')){
    if(!result||result.operationId!==args.key||!['PUBLISHING','READY','FAILED','UNKNOWN','NOT_READY','UNREGISTERED','UNAVAILABLE'].includes(result.state))fail('发布结果尚未确认；请查询原编号。',503);
    const clean={operationId:args.key,state:result.state,storageTier:args.tier};
    for(const field of ['path','name','error'])if(typeof result[field]==='string')clean[field]=result[field].replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,1024);
    if(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result.dataset||''))clean.dataset=result.dataset;
    if(/^[a-f0-9]{64}$/.test(result.version||''))clean.version=result.version;
    for(const field of ['bytes','files'])if(Number.isSafeInteger(result[field])&&result[field]>=0)clean[field]=result[field];
    if(result.publicationState==='READY')clean.publicationState='READY';
    return clean;
  }
  const clean=receipt(result,args.key);
  if(['copy','copy.cancel','copy.resume'].includes(action))service.audit(principal.username,operation,machine,args.key);
  return clean;
}
