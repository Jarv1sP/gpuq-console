import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {MACHINES} from './dist/model.js';

// Independent from storageArchivePolicy: adding upload admission must never
// change the policy hash or reinterpret an existing archive/transfer journal.
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const USER=/^(builtin-admin|demo-user-[0-9]{1,18})$/;
const SPEC=['name','manifestBytes','manifestSha256','totalBytes','entries'];
const known=machine=>MACHINES.some(value=>value.id===machine);
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const specification=args=>Object.fromEntries(SPEC.map(key=>[key,args[key]]));
const validSpecification=value=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===SPEC.length&&SPEC.every(key=>Object.hasOwn(value,key))&&
  typeof value.name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value.name)&&
  Number.isSafeInteger(value.manifestBytes)&&value.manifestBytes>=1&&value.manifestBytes<=64*1024*1024&&
  typeof value.manifestSha256==='string'&&HASH.test(value.manifestSha256)&&
  Number.isSafeInteger(value.totalBytes)&&value.totalBytes>=0&&
  Number.isSafeInteger(value.entries)&&value.entries>=0&&value.entries<=500000;
const ADMISSION='dataset-upload-admission-v1';
const UPLOAD_STATES=new Set(['RECEIVING_MANIFEST','SEALING','UPLOADING','PUBLISHING','READY','FAILED','DISCARDING','DISCARDED']);

export function datasetIngressPolicy(input){
  if(input==null)return {enabled:false};
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.enabled!=='boolean'||
    Object.keys(input).some(key=>!['enabled','machine','authority','allowDuringMaintenance'].includes(key))||
    input.allowDuringMaintenance!==undefined&&typeof input.allowDuringMaintenance!=='boolean')fail('Invalid trusted dataset ingress policy');
  if(!input.enabled)return {enabled:false};
  if(!known(input.machine)||typeof input.authority!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.authority))
    fail('Unknown dataset warehouse or authority');
  return {enabled:true,machine:input.machine,authority:input.authority,
    ...(input.allowDuringMaintenance!==undefined?{allowDuringMaintenance:input.allowDuringMaintenance}:{})};
}

export async function loadDatasetIngressPolicy(path){
  if(!path)return {enabled:false};
  const raw=await readFile(path,'utf8');
  if(Buffer.byteLength(raw)>4096)fail('Dataset ingress configuration is too large');
  return datasetIngressPolicy(JSON.parse(raw));
}

export function installDatasetIngress(service,input){
  const policy=datasetIngressPolicy(input);
  if(policy.enabled&&(!service.storageArchivePolicy?.enabled||service.storageArchivePolicy.machine!==policy.machine||
    service.storageArchivePolicy.authority!==policy.authority))fail('Dataset ingress requires the existing fixed HDD authority');
  service.datasetIngressPolicy=Object.freeze(policy);
  service.db.exec('CREATE TABLE IF NOT EXISTS dataset_upload_placements (owner TEXT NOT NULL, upload_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,upload_id))');
  service.db.exec("CREATE INDEX IF NOT EXISTS dataset_upload_ready_source ON dataset_upload_placements(owner,json_extract(data,'$.storageMachine'),json_extract(data,'$.ready.dataset'),json_extract(data,'$.ready.version'))");
  service.db.exec('CREATE TABLE IF NOT EXISTS dataset_upload_admissions (owner TEXT NOT NULL, intent_key TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE, PRIMARY KEY(owner,intent_key))');
  const load=(owner,id)=>{
    const value=service.db.prepare('SELECT data FROM dataset_upload_placements WHERE owner=? AND upload_id=?').get(owner,id);
    if(!value)return null;
    const row=JSON.parse(value.data);
    if(row.protocol!==1||row.owner!==owner||row.uploadId!==id||!known(row.requestedMachine)||
      !['LOCATING','ISSUED','BOUND'].includes(row.phase)||!known(row.candidateMachine)||
      row.phase==='BOUND'&&!known(row.storageMachine)||
      row.specification&&hash(row.specification)!==row.specificationSha256)fail('Dataset upload placement journal is corrupt');
    if(row.admissionProtocol!==undefined||row.phase==='ISSUED'){
      const mapping=service.db.prepare('SELECT upload_id FROM dataset_upload_admissions WHERE owner=? AND intent_key=?').get(owner,row.admissionKey);
      if(row.admissionProtocol!==1||!UUID.test(row.admissionKey||'')||mapping?.upload_id!==id||
        row.phase==='LOCATING'||row.warehouse!==true||row.storageMachine!==row.candidateMachine||
        typeof row.authority!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.authority)||
        !validSpecification(row.specification)||hash(specification(row.specification))!==row.specificationSha256)
        fail('Dataset fresh admission journal is corrupt');
    }
    return row;
  };
  const save=row=>service.db.prepare('INSERT INTO dataset_upload_placements(owner,upload_id,data) VALUES(?,?,?) ON CONFLICT(owner,upload_id) DO UPDATE SET data=excluded.data')
    .run(row.owner,row.uploadId,JSON.stringify(row));
  const lanes=new Map();let pending=0;
  const fence=(principal,row,operation='datasets.upload.begin')=>{
    const user=service.store.get(principal.userId);
    if(service.closing||!user?.enabled||user.username!==principal.username||!user.limits?.[row.requestedMachine])
      fail('账号或所选训练服务器的授权已改变。',403);
    const maintenanceArgs={key:operation==='datasets.upload.admission.create'?row.admissionKey:row.uploadId,uploadId:row.uploadId};
    service.assertMaintenanceAllowed?.(operation,{...maintenanceArgs,machine:row.requestedMachine},principal);
    if(row.storageMachine&&operation!=='datasets.upload.admission.create')
      service.assertMaintenanceAllowed?.(operation,{...maintenanceArgs,machine:row.storageMachine},principal);
    return hash(user);
  };
  const call=async(principal,row,machine,operation,args,publicOperation=operation)=>{
    const snapshot=fence(principal,row,publicOperation);
    const result=await service.bridge(machine,operation,args);
    if(fence(principal,row,publicOperation)!==snapshot)fail('上传期间账号授权已改变。',403);
    return result;
  };
  const locate=async(principal,row,machine,publicOperation)=>{
    const result=await call(principal,row,machine,'storage.upload.locate',{userId:row.owner,uploadId:row.uploadId},publicOperation);
    if(!result||result.protocol!=='dataset-upload-location-v1'||result.machine!==machine||result.userId!==row.owner||
      result.uploadId!==row.uploadId||typeof result.present!=='boolean'||
      result.present&&(!result.specification||SPEC.some(key=>result.specification[key]===undefined)||
        Object.keys(result.specification).length!==SPEC.length))fail('旧上传位置未能确认；未创建其他副本。',502);
    return result;
  };
  const placement=row=>({placementProtocol:1,requestedMachine:row.requestedMachine,storageMachine:row.storageMachine,
    storageTier:row.warehouse?'hdd':'existing',legacyPlacement:!row.warehouse});
  const remember=(row,result)=>{
    if(result?.state==='READY'){
      const expected='u-'+createHash('sha256').update(row.owner).digest('hex').slice(0,16)+'-'+row.specification.name;
      if(result.uploadId!==row.uploadId||result.dataset!==expected||!HASH.test(result.version||'')||
        result.totalBytes!==row.specification.totalBytes||result.entries!==row.specification.entries)
        fail('仓库发布回执与上传身份不匹配。',502);
      row.ready={dataset:result.dataset,version:result.version};save(row);
    }else if(['DISCARDING','DISCARDED','FAILED'].includes(result?.state)&&row.ready){
      delete row.ready;save(row);
    }
    return {...result,...placement(row)};
  };
  const sourceRows=(owner,machine,ref)=>ref?
    service.db.prepare("SELECT data FROM dataset_upload_placements WHERE owner=? AND json_extract(data,'$.storageMachine')=? AND json_extract(data,'$.ready.dataset')=? AND json_extract(data,'$.ready.version')=?").all(owner,machine,ref.dataset,ref.version):
    service.db.prepare("SELECT data FROM dataset_upload_placements WHERE owner=? AND json_extract(data,'$.storageMachine')=? AND json_extract(data,'$.ready.dataset') IS NOT NULL").all(owner,machine);
  const sourceAllowed=(owner,machine,ref)=>{
    if(!USER.test(owner)||!known(machine)||!ref||!HASH.test(ref.version||''))return false;
    const user=service.store.get(owner);
    if(!user?.enabled)return false;
    return sourceRows(owner,machine,ref).some(value=>{
      const row=JSON.parse(value.data);
      return row.phase==='BOUND'&&row.warehouse===true&&row.storageMachine===machine&&user.limits?.[row.requestedMachine]&&
        row.ready?.dataset===ref.dataset&&row.ready.version===ref.version&&
        !service.datasetDeletionBlocked?.(machine,ref);
    });
  };
  service.datasetIngressSourceAllowed=sourceAllowed;
  // Visibility is only capability metadata. The actual copy request must
  // still prove the precise READY tuple through sourceAllowed above.
  service.datasetIngressMachineVisible=(owner,machine)=>USER.test(owner)&&known(machine)&&sourceRows(owner,machine).some(value=>{
    const row=JSON.parse(value.data);return row.ready&&sourceAllowed(owner,machine,row.ready);
  });

  const currentPolicy=row=>{
    if(!policy.enabled||policy.machine!==row.candidateMachine||policy.authority!==row.authority||
      service.storageArchivePolicy?.enabled!==true||service.storageArchivePolicy.machine!==row.candidateMachine||
      service.storageArchivePolicy.authority!==row.authority)
      fail('入库策略已改变；此待确认上传未派发，请联系管理员核对。');
  };
  // A protected operator policy may open only new HDD intake while compute
  // and old-data cleanup remain in maintenance. This never unlocks projects,
  // terminal input, SSD uploads, transfers, cache preparation or legacy keys.
  service.warehouseMaintenanceUploadAllowed=(operation,args,principal)=>{
    if(!policy.enabled||policy.allowDuringMaintenance!==true||!principal||!args||
      service.storageArchivePolicy?.enabled!==true||service.storageArchivePolicy.machine!==policy.machine||
      service.storageArchivePolicy.authority!==policy.authority)return false;
    const actor=service.store.get(principal.userId);
    if(!actor?.enabled||(actor.role||'member')!==principal.role)return false;
    if(operation==='datasets.upload.admission.create')
      return known(args.machine)&&Boolean(actor.limits?.[args.machine])&&UUID.test(args.key||'');
    if(!['storage.upload.admit','datasets.upload.begin','datasets.upload.manifest','datasets.upload.seal',
      'datasets.upload.chunk','datasets.upload.commit','datasets.upload.discard','datasets.upload.direct-ticket'].includes(operation))return false;
    const id=operation==='datasets.upload.begin'?args.key:args.uploadId;
    if(!UUID.test(id||''))return false;
    const row=load(principal.userId,id);
    if(row?.admissionProtocol!==1||row.warehouse!==true||row.storageMachine!==policy.machine||
      row.authority!==policy.authority||!actor.limits?.[row.requestedMachine]||
      ![row.requestedMachine,row.storageMachine].includes(args.machine))return false;
    if(operation==='storage.upload.admit'&&(args.intentKey!==row.admissionKey||args.protocol!==ADMISSION||
      args.requestedMachine!==row.requestedMachine||args.storageMachine!==row.storageMachine||
      args.authority!==row.authority||hash(args.specification)!==row.specificationSha256||
      args.specificationSha256!==row.specificationSha256))return false;
    return true;
  };
  const admissionView=row=>({protocol:ADMISSION,key:row.admissionKey,uploadId:row.uploadId,
    requestedMachine:row.requestedMachine,storageMachine:row.storageMachine,storageTier:'hdd',
    specification:structuredClone(row.specification),state:row.phase});
  const admission=async(principal,action,args)=>{
    const owner=principal.userId,key=args.key,operation='datasets.upload.'+action;
    if(!USER.test(owner)||!UUID.test(key||''))fail('无效的上传准入意图。',400);
    const lane='admission/'+owner+'/'+key;
    const write=action==='admission.create';
    if(write&&(lanes.has(lane)||pending>=8))fail('上传控制繁忙，请稍后重试。',429);
    if(write){lanes.set(lane,true);pending++;}
    try{
      const mapping=service.db.prepare('SELECT upload_id FROM dataset_upload_admissions WHERE owner=? AND intent_key=?').get(owner,key);
      if(mapping){
        const row=load(owner,mapping.upload_id);
        if(!row||row.admissionKey!==key)fail('Dataset fresh admission mapping is corrupt');
        if(row.requestedMachine!==args.machine)fail('此上传已绑定原先选择的服务器；请使用原服务器继续。');
        if(action==='admission.create'&&hash(specification(args))!==row.specificationSha256)fail('此上传意图已绑定另一份清单。');
        fence(principal,row,operation);
        if(action==='admission.create'&&row.phase==='ISSUED')currentPolicy(row);
        return admissionView(row);
      }
      fence(principal,{requestedMachine:args.machine,admissionKey:key},operation);
      if(service.db.prepare("SELECT upload_id FROM dataset_upload_placements WHERE owner=? AND json_extract(data,'$.admissionKey')=?").get(owner,key))
        fail('Dataset fresh admission mapping is corrupt');
      if(action==='admission.status')fail('没有这条上传准入意图；未分配其他编号。',404);
      if(!policy.enabled)fail('机械仓库新上传准入尚未启用。',503);
      const spec=specification(args);
      if(!validSpecification(spec))fail('上传准入清单无效。',400);
      const row={protocol:1,owner,uploadId:randomUUID(),requestedMachine:args.machine,
        candidateMachine:policy.machine,storageMachine:policy.machine,authority:policy.authority,
        phase:'ISSUED',warehouse:true,createdAt:Date.now(),admissionProtocol:1,admissionKey:key,
        specification:spec,specificationSha256:hash(spec)};
      currentPolicy(row);fence(principal,row,operation);
      // Both identities commit together, before even a warehouse RPC. The
      // caller's intent key is never used as the node's fresh upload ID.
      service.db.exec('BEGIN IMMEDIATE');
      try{
        if(service.db.prepare('SELECT count(*) AS count FROM dataset_upload_placements').get().count>=10000)
          fail('上传位置历史已达上限，请联系管理员归档。');
        if(row.uploadId===key||service.db.prepare('SELECT upload_id FROM dataset_upload_placements WHERE upload_id=?').get(row.uploadId))
          fail('新上传身份发生冲突；未派发，请联系管理员核对。');
        service.db.prepare('INSERT INTO dataset_upload_placements(owner,upload_id,data) VALUES(?,?,?)').run(owner,row.uploadId,JSON.stringify(row));
        service.db.prepare('INSERT INTO dataset_upload_admissions(owner,intent_key,upload_id) VALUES(?,?,?)').run(owner,key,row.uploadId);
        service.db.exec('COMMIT');
      }catch(error){service.db.exec('ROLLBACK');throw error;}
      return admissionView(row);
    }finally{if(write){lanes.delete(lane);pending--;}}
  };

  service.datasetUploadIngress=async(principal,action,args)=>{
    if(action==='admission.create'||action==='admission.status')return admission(principal,action,args);
    const owner=principal.userId,id=action==='begin'?args.key:args.uploadId;
    // Preflight has no upload identity yet and therefore cannot resume or
    // rebind a session. Its advertised machine is explicit, not transparent.
    if(action==='routes'&&id===undefined){
      const target=policy.enabled?policy.machine:args.machine;
      const row={owner,requestedMachine:args.machine,storageMachine:target};
      const value=await call(principal,row,target,'datasets.upload.routes',{userId:owner,hostAdmin:false});
      return {...value,requestedMachine:args.machine,storageMachine:target,storageTier:policy.enabled?'hdd':'existing',
        ...(policy.enabled?{placementProtocol:1,legacyPlacement:false}:{})};
    }
    if(!USER.test(owner)||!UUID.test(id||''))fail('无效的上传身份。',400);
    const lane=owner+'/'+id;
    if(lanes.has(lane))fail('该上传已有操作正在执行，请稍后重试。',429);
    if(pending>=8)fail('上传控制繁忙，请稍后重试。',429);
    lanes.set(lane,true);pending++;
    try{
      let row=load(owner,id);
      if(!row&&!policy.enabled)return service.bridge(args.machine,'datasets.upload.'+action,
        {...Object.fromEntries(Object.entries(args).filter(([key])=>key!=='machine'&&(action!=='routes'||key!=='uploadId'))),userId:owner,hostAdmin:false});
      if(row&&row.requestedMachine!==args.machine)fail('此上传已绑定原先选择的服务器；请使用原服务器继续。');
      if(action==='begin'&&row?.specificationSha256&&row.specificationSha256!==hash(specification(args)))
        fail('此上传编号已绑定另一份清单。');
      if(!row){
        row={protocol:1,owner,uploadId:id,requestedMachine:args.machine,candidateMachine:policy.machine,
          authority:policy.authority,phase:'LOCATING',createdAt:Date.now(),
          ...(action==='begin'?{specification:specification(args),specificationSha256:hash(specification(args))}:{})};
        if(service.db.prepare('SELECT count(*) AS count FROM dataset_upload_placements').get().count>=10000)
          fail('上传位置历史已达上限，请联系管理员归档。');
        if(action==='begin')save(row); // Intent is durable before any admission.
      }
      fence(principal,row,'datasets.upload.'+action);
      if(row.admissionProtocol===1){
        if(row.phase==='ISSUED'){
          if(action!=='begin')fail('此上传尚未向仓库准入；请按原意图核对并继续。');
          currentPolicy(row);
          // BOUND records the fixed dispatch attempt, not a successful node
          // admission. Unknown replies retain this route across restart.
          row.phase='BOUND';save(row);
        }
        if(action==='begin'){
          const result=await call(principal,row,row.storageMachine,'storage.upload.admit',{
            userId:owner,hostAdmin:false,protocol:ADMISSION,intentKey:row.admissionKey,
            uploadId:row.uploadId,requestedMachine:row.requestedMachine,storageMachine:row.storageMachine,
            authority:row.authority,specification:row.specification,specificationSha256:row.specificationSha256,
            ...(args.allowRelay!==undefined?{allowRelay:args.allowRelay}:{})},'datasets.upload.begin');
          if(!result||result.admissionProtocol!==1||result.admissionKey!==row.admissionKey||
            result.machine!==row.storageMachine||result.authority!==row.authority||result.uploadId!==row.uploadId||
            ['name','manifestBytes','totalBytes','entries'].some(key=>result[key]!==row.specification[key])||
            !UPLOAD_STATES.has(result.state)||!Number.isSafeInteger(result.manifestOffset)||
            result.manifestOffset<0||result.manifestOffset>row.specification.manifestBytes||
            result.chunkBytes!==1024*1024||result.uploadTransport?.protocol!=='dataset-upload-v1'||
            typeof result.uploadTransport.directAvailable!=='boolean')
            fail('机械仓库准入回执与固定上传意图不匹配；未改换编号或位置。',502);
          return remember(row,result);
        }
      }
      if(row.phase==='LOCATING'){
        // Exact owner/key observations only. Errors are never interpreted as
        // absence. Probe all configured nodes to prevent duplicate old keys.
        const found=await Promise.all(MACHINES.map(async machine=>({machine:machine.id,...await locate(principal,row,machine.id,'datasets.upload.'+action)})));
        const existing=found.filter(value=>value.present);
        if(existing.length>1)fail('同一上传编号存在于多台服务器；请联系管理员确认，未写入数据。');
        if(existing.length===1){
          const prior=existing[0];
          if(prior.machine!==row.requestedMachine)fail('旧上传存在于另一台服务器；请使用原来的服务器继续。');
          const priorSpec=specification(prior.specification);
          if(row.specificationSha256&&hash(priorSpec)!==row.specificationSha256)
            fail('旧上传的固定清单与本次上传不一致。');
          row.specification=priorSpec;row.specificationSha256=hash(priorSpec);
          row.storageMachine=prior.machine;row.warehouse=false;
        }else{
          if(action!=='begin')fail('上传不存在；恢复已有仓库上传需要原平台的位置记录。',404);
          // A caller-provided UUID is not evidence of an old session. Only
          // the server-issued admission path may create a fresh HDD upload.
          // Preserve this LOCATING journal: never silently rekey or relabel it.
          fail('原上传编号在所有节点均不存在；请升级 gpuctl 并使用数据仓库的新上传入口。',409);
        }
        row.phase='BOUND';save(row);
      }
      const {machine,uploadId,...request}=args;
      const payload={...request,...(action!=='begin'&&action!=='routes'?{uploadId}:{}),userId:owner,hostAdmin:false};
      const result=await call(principal,row,row.storageMachine,'datasets.upload.'+action,payload);
      return remember(row,result);
    }finally{lanes.delete(lane);pending--;}
  };
  return {policy,load};
}
