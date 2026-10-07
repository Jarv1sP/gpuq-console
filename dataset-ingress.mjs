import {createHash} from 'node:crypto';
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

export function datasetIngressPolicy(input){
  if(input==null)return {enabled:false};
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.enabled!=='boolean'||
    Object.keys(input).some(key=>!['enabled','machine','authority'].includes(key)))fail('Invalid trusted dataset ingress policy');
  if(!input.enabled)return {enabled:false};
  if(!known(input.machine)||typeof input.authority!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.authority))
    fail('Unknown dataset warehouse or authority');
  return {enabled:true,machine:input.machine,authority:input.authority};
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
  const load=(owner,id)=>{
    const value=service.db.prepare('SELECT data FROM dataset_upload_placements WHERE owner=? AND upload_id=?').get(owner,id);
    if(!value)return null;
    const row=JSON.parse(value.data);
    if(row.protocol!==1||row.owner!==owner||row.uploadId!==id||!known(row.requestedMachine)||
      !['LOCATING','BOUND'].includes(row.phase)||!known(row.candidateMachine)||
      row.phase==='BOUND'&&!known(row.storageMachine)||
      row.specification&&hash(row.specification)!==row.specificationSha256)fail('Dataset upload placement journal is corrupt');
    return row;
  };
  const save=row=>service.db.prepare('INSERT INTO dataset_upload_placements(owner,upload_id,data) VALUES(?,?,?) ON CONFLICT(owner,upload_id) DO UPDATE SET data=excluded.data')
    .run(row.owner,row.uploadId,JSON.stringify(row));
  const lanes=new Map();let pending=0;
  const fence=(principal,row,operation='datasets.upload.begin')=>{
    const user=service.store.get(principal.userId);
    if(service.closing||!user?.enabled||user.username!==principal.username||!user.limits?.[row.requestedMachine])
      fail('账号或所选训练服务器的授权已改变。',403);
    service.assertMaintenanceAllowed?.(operation,{machine:row.requestedMachine},principal);
    if(row.storageMachine)service.assertMaintenanceAllowed?.(operation,{machine:row.storageMachine},principal);
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

  service.datasetUploadIngress=async(principal,action,args)=>{
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
      if(row.phase==='LOCATING'){
        // Exact owner/key observations only. Errors are never interpreted as
        // absence. Probe all configured nodes to prevent duplicate old keys.
        const found=await Promise.all(MACHINES.map(async machine=>({machine:machine.id,...await locate(principal,row,machine.id,'datasets.upload.'+action)})));
        const existing=found.filter(value=>value.present);
        if(existing.length>1)fail('同一上传编号存在于多台服务器；请联系管理员确认，未写入数据。');
        if(existing.length===1){
          const prior=existing[0];
          if(prior.machine!==row.requestedMachine)fail('旧上传存在于另一台服务器；请使用原来的服务器继续。');
          if(row.specificationSha256&&hash(prior.specification)!==row.specificationSha256)
            fail('旧上传的固定清单与本次上传不一致。');
          row.specification=prior.specification;row.specificationSha256=hash(prior.specification);
          row.storageMachine=prior.machine;row.warehouse=false;
        }else{
          if(action!=='begin')fail('上传不存在；恢复已有仓库上传需要原平台的位置记录。',404);
          if(!policy.enabled||policy.machine!==row.candidateMachine||policy.authority!==row.authority)
            fail('入库策略已改变；此待确认上传未派发，请联系管理员核对。');
          const warehouse=found.find(value=>value.machine===row.candidateMachine);
          if(warehouse?.authority?.enabled!==true||warehouse.authority.machine!==row.candidateMachine||
            warehouse.authority.authority!==row.authority)fail('机械仓库未确认可用，未改为固态或其他服务器上传。',503);
          row.storageMachine=row.candidateMachine;row.warehouse=true;
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
