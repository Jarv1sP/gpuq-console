import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {MACHINES} from './dist/model.js';

// Durable control-plane orchestration only. Data bytes use the existing node
// transfer service. Private authority grants are never saved in portal rows.
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const USER=/^(builtin-admin|demo-user-[0-9]+)$/;
const key=(...parts)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fail=(message,status)=>{throw Object.assign(Error(message),status===undefined?{}:{status});};
const isRef=value=>value&&ID.test(value.dataset)&&HASH.test(value.version);
const safePhase=new Set(['QUEUED','COPYING','PROVISIONING','CERTIFYING','ARCHIVED','BLOCKED','FAILED']);

export function storageArchivePolicy(input){
  if(input==null)return {enabled:false};
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['enabled','machine','authority'].includes(k))||typeof input.enabled!=='boolean')fail('Invalid trusted archive policy');
  if(!input.enabled)return {enabled:false};
  if(!MACHINES.some(m=>m.id===input.machine)||!ID.test(input.authority))fail('Unknown trusted archive machine or authority');
  return {enabled:true,machine:input.machine,authority:input.authority};
}

export async function loadStorageArchivePolicy(path){
  if(!path)return {enabled:false};
  const raw=await readFile(path,'utf8');
  if(Buffer.byteLength(raw)>4096)fail('Archive configuration is too large');
  return storageArchivePolicy(JSON.parse(raw));
}

export function installStorageArchive(service,input,{clock=Date.now,startTimer=true}={}){
  const policy=storageArchivePolicy(input);
  service.storageArchivePolicy=Object.freeze(policy);
  service.db.exec('CREATE TABLE IF NOT EXISTS storage_archives (id TEXT PRIMARY KEY, owner TEXT NOT NULL, machine TEXT NOT NULL, data TEXT NOT NULL)');
  service.db.exec('CREATE TABLE IF NOT EXISTS storage_archive_lane (singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_id TEXT NOT NULL)');
  const policyKey=key(policy);
  let reconciling=false;
  const retiring=new Map();
  const load=id=>{const row=service.db.prepare('SELECT data FROM storage_archives WHERE id=?').get(id);return row?JSON.parse(row.data):null;};
  const rows=()=>service.db.prepare('SELECT data FROM storage_archives ORDER BY rowid').all().map(row=>JSON.parse(row.data));
  const save=row=>{
    if(service.closing)fail('Archive service is closing');
    // Copy only our defined journal fields. A grant/token/source ticket cannot
    // accidentally enter durable state through a spread of a remote response.
    const allowed=['id','kind','owner','machine','dataset','version','eventId','sourceMachine','sourceDataset','logicalDataset','phase','copyKey','transferId','grantId','certifyId','createdAt','updatedAt','nextCheckAt','failures','error','receiptSha256','eventAcknowledged','policyKey','retryRequested','transferState','failureStage','enrollment','retirement'];
    if(Object.keys(row).some(k=>!allowed.includes(k))||!safePhase.has(row.phase))fail('Invalid archive journal');
    row.updatedAt=clock();
    service.db.prepare('INSERT INTO storage_archives(id,owner,machine,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id,row.owner,row.machine,JSON.stringify(row));
  };
  const laneOwner=()=>service.db.prepare('SELECT archive_id FROM storage_archive_lane WHERE singleton=1').get()?.archive_id;
  const holdLane=row=>{
    service.db.prepare('INSERT OR IGNORE INTO storage_archive_lane(singleton,archive_id) VALUES(1,?)').run(row.id);
    return laneOwner()===row.id;
  };
  const releaseLane=row=>service.db.prepare('DELETE FROM storage_archive_lane WHERE singleton=1 AND archive_id=?').run(row.id);
  const currentPolicy=row=>row.policyKey===policyKey&&row.sourceMachine===policy.machine;
  const grantIdentity=row=>{
    if(!ID.test(row.sourceDataset||''))fail('Archive source identity is not confirmed');
    const value=key(row.owner,row.sourceMachine,row.sourceDataset,row.version,row.machine);
    // This is an idempotency identity, never the secret authority token.
    return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`;
  };
  const enabledUser=(owner,machine)=>{
    const user=service.store.get(owner);
    if(!user?.enabled||!user.limits?.[machine])fail('Archive owner or ingest-machine permission changed');
    return user;
  };
  const fence=(row,snapshot)=>{
    if(retiring.has(row.id)||load(row.id)?.failureStage==='retired')fail('Archive retirement fences this old intent');
    if(service.closing||!policy.enabled)fail('Archive service is unavailable');
    service.assertMaintenanceAllowed?.('storage.archive.advance',{machine:row.machine,from:policy.machine});
    if(!currentPolicy(row))fail('Archive policy changed; existing intent requires administrator review');
    const user=enabledUser(row.owner,row.machine);
    if(snapshot!==undefined&&JSON.stringify(user)!==snapshot)fail('Archive owner policy changed during operation');
    return JSON.stringify(user);
  };
  const call=async(row,snapshot,machine,operation,args)=>{
    fence(row,snapshot);
    try{return await service.bridge(machine,operation,args);}
    finally{fence(row,snapshot);}
  };
  const publicRow=row=>row?{
    dataset:row.logicalDataset||row.dataset,version:row.version,phase:row.phase,
    archiveMachine:policy.machine,localMachine:row.machine,
    originalRetained:row.phase==='ARCHIVED',
    ...(row.error?{error:row.error}:{}),
  }:null;

  service.archiveState=(owner,machine,ref)=>publicRow(rows().findLast(row=>row.owner===owner&&row.machine===machine&&(row.dataset===ref.dataset||row.logicalDataset===ref.dataset)&&row.version===ref.version));
  service.archiveSourceAllowed=(owner,machine,ref)=>policy.enabled&&machine===policy.machine&&isRef(ref)&&rows().some(row=>currentPolicy(row)&&row.owner===owner&&row.phase==='ARCHIVED'&&row.sourceMachine===machine&&row.sourceDataset===ref.dataset&&row.version===ref.version);
  service.archiveMachineVisible=(owner,machine)=>policy.enabled&&machine===policy.machine&&rows().some(row=>currentPolicy(row)&&row.owner===owner&&row.phase==='ARCHIVED'&&row.sourceMachine===machine);
  service.archiveAliases=owner=>new Map(rows().filter(row=>currentPolicy(row)&&row.owner===owner&&row.phase==='ARCHIVED'&&row.sourceDataset).map(row=>[row.sourceDataset+'@'+row.version,row.logicalDataset||row.dataset]));
  service.archiveIntentAllowed=(owner,args)=>{
    if(!policy.enabled||args.kind!=='copy'||args.machine!==policy.machine||args.from===args.machine||!UUID.test(args.key||'')||!isRef(args))return false;
    const row=rows().find(row=>row.owner===owner&&row.machine===args.from&&row.dataset===args.dataset&&row.version===args.version&&row.copyKey===args.key);
    return row?.kind==='ingest'&&currentPolicy(row)&&row.owner===owner&&row.copyKey===args.key&&args.name==='archive-'+key(owner,args.from,args.dataset).slice(0,24);
  };

  function enqueueEvent(machine,event){
    if(!policy.enabled||!MACHINES.some(m=>m.id===machine)||!event||event.state!=='READY'||!UUID.test(event.id)||!USER.test(event.userId)||!isRef(event))fail('Invalid immutable archive event');
    enabledUser(event.userId,machine);
    // A re-registration of the same content is a new immutable event. Keep
    // the older receipt for recovery; never silently reuse its target identity.
    const id=key(event.userId,machine,event.dataset,event.version,event.id),old=load(id);
    if(old){
      if(old.kind!=='ingest')fail('Archive intent identity conflict');
      return old;
    }
    if(rows().length>=10000)fail('Archive history limit reached');
    const archived=rows().findLast(row=>currentPolicy(row)&&row.owner===event.userId&&row.machine===machine&&row.dataset===event.dataset&&row.version===event.version&&row.phase==='ARCHIVED');
    const sourceDataset=machine===policy.machine?event.dataset:archived?.sourceDataset||null;
    const now=clock(),row={id,kind:'ingest',owner:event.userId,machine,dataset:event.dataset,version:event.version,eventId:event.id,
      logicalDataset:event.dataset,sourceMachine:policy.machine,sourceDataset,
      phase:sourceDataset?'PROVISIONING':'QUEUED',copyKey:randomUUID(),transferId:null,grantId:null,certifyId:randomUUID(),
      createdAt:now,updatedAt:now,nextCheckAt:now,failures:0,eventAcknowledged:false,policyKey};
    if(sourceDataset)row.grantId=grantIdentity(row);
    save(row);return row;
  }

  service.enqueueArchiveReplica=(owner,machine,logicalRef,physicalRef)=>{
    if(!policy.enabled)return null;
    if(!isRef(logicalRef)||!isRef(physicalRef)||logicalRef.version!==physicalRef.version)fail('Invalid fixed archive replica');
    enabledUser(owner,machine);
    const source=rows().findLast(row=>currentPolicy(row)&&row.owner===owner&&row.phase==='ARCHIVED'&&(row.logicalDataset||row.dataset)===logicalRef.dataset&&row.version===logicalRef.version);
    if(!source)return null;
    const id=key(owner,machine,physicalRef.dataset,physicalRef.version),old=load(id);
    if(old)return publicRow(old);
    if(rows().length>=10000)fail('Archive history limit reached');
    const now=clock(),row={id,kind:'replica',owner,machine,...physicalRef,logicalDataset:logicalRef.dataset,
      sourceMachine:source.sourceMachine,sourceDataset:source.sourceDataset,phase:'PROVISIONING',
      copyKey:randomUUID(),transferId:null,grantId:null,certifyId:randomUUID(),createdAt:now,updatedAt:now,nextCheckAt:now,failures:0,eventAcknowledged:true,policyKey};
    row.grantId=grantIdentity(row);
    save(row);return publicRow(row);
  };

  const enrolling=new Map();
  service.retireStorageArchive=(principal,args)=>{
    if(!args||Object.keys(args).sort().join(',')!=='dataset,eventId,machine,ownerId,recoveryId,version'||
      !USER.test(args.ownerId||'')||!UUID.test(args.eventId||'')||!isRef(args)||
      !/^unregister-[a-f0-9]{32}$/.test(args.recoveryId||'')||args.machine!==policy.machine)
      fail('Retirement requires the exact same-HDD event, owner, reference and normal unregister receipt.',400);
    const actor=service.store.get(principal.userId);
    if(!actor?.enabled||actor.role!=='admin')fail('Archive retirement requires a current administrator.',403);
    const snapshot=JSON.stringify(actor),ownerSnapshot=JSON.stringify(enabledUser(args.ownerId,args.machine));
    const check=()=>{
      if(service.closing||!policy.enabled||!service.bridge||key(service.storageArchivePolicy)!==policyKey)fail('Archive retirement is unavailable.');
      service.assertMaintenanceAllowed?.('storage.archive.advance',{machine:args.machine,from:policy.machine});
      if(JSON.stringify(service.store.get(principal.userId))!==snapshot||JSON.stringify(enabledUser(args.ownerId,args.machine))!==ownerSnapshot)
        fail('Archive retirement authorization changed.',403);
    };
    check();
    const id=key(args.ownerId,args.machine,args.dataset,args.version,args.eventId),row=load(id);
    if(!row||!currentPolicy(row)||row.kind!=='ingest'||row.sourceMachine!==row.machine||row.sourceDataset!==row.dataset||
      row.transferId!==null||row.grantId!==grantIdentity(row)||!UUID.test(row.certifyId||'')||
      row.eventAcknowledged||!['PROVISIONING','BLOCKED','FAILED'].includes(row.phase))
      fail('Only a never-dispatched same-HDD ingest can be retired.');
    const binding=key(args.ownerId,args.machine,args.dataset,args.version,args.eventId,args.recoveryId),prior=row.retirement;
    if(prior){if(prior.binding!==binding)fail('Retirement receipt cannot be changed.');return Promise.resolve(publicRow(row));}
    const pending=retiring.get(id);
    if(pending){if(pending.binding!==binding)fail('Retirement receipt cannot be changed.');return pending.task;}
    const task=Promise.resolve().then(async()=>{
      check();
      const proof=await service.bridge(policy.machine,'storage.archive.retire',{
        id:row.eventId,userId:row.owner,dataset:row.dataset,version:row.version,
        recoveryId:args.recoveryId,grantId:row.grantId,certifyId:row.certifyId});
      check();
      if(!proof||Object.keys(proof).sort().join(',')!=='dataset,id,neverDispatched,proofSha256,protocol,recoveryId,state,userId,version'||
        proof.protocol!==1||proof.id!==row.eventId||proof.userId!==row.owner||proof.dataset!==row.dataset||proof.version!==row.version||
        proof.recoveryId!==args.recoveryId||proof.state!=='RETIRED'||proof.neverDispatched!==true||!HASH.test(proof.proofSha256||''))
        fail('Exact normal retirement is not confirmed; archive lane is retained.');
      // Save the terminal proof before compare-and-delete; restart recovery is
      // permitted only for this known never-dispatched terminal state.
      row.phase='FAILED';row.failureStage='retired';row.retryRequested=false;row.failures=0;
      row.retirement={binding,recoveryId:args.recoveryId,proofSha256:proof.proofSha256,actor:principal.userId};
      row.error='原登记已由管理员正常注销，旧归档意图已退役；不会自动重建或重试。';
      save(row);releaseLane(row);
      service.audit(principal.username,'datasets.archive.retire',row.machine,row.owner+':'+row.dataset+'@'+row.version);
      return publicRow(row);
    }).finally(()=>{if(retiring.get(id)?.task===task)retiring.delete(id);});
    retiring.set(id,{binding,task});return task;
  };
  service.enrollStorageArchive=(principal,args)=>{
    if(!args||Object.keys(args).sort().join(',')!=='dataset,key,machine,ownerId,version'||
      !USER.test(args.ownerId||'')||!UUID.test(args.key||'')||!isRef(args)||
      !MACHINES.some(m=>m.id===args.machine)||args.machine===policy.machine)
      fail('Enrollment requires an exact owner, hot machine, version and UUID key.',400);
    const {ownerId:owner,machine,dataset,version,key:requestKey}=args;
    const admitted=service.store.get(principal.userId);
    if(!admitted?.enabled||admitted.role!=='admin')fail('Archive enrollment requires a current administrator.',403);
    const actorPolicy=JSON.stringify(admitted),ownerPolicy=JSON.stringify(enabledUser(owner,machine));
    const check=()=>{
      if(service.closing||!policy.enabled||!service.bridge||key(service.storageArchivePolicy)!==policyKey)fail('Archive enrollment is unavailable.');
      service.assertMaintenanceAllowed?.('storage.archive.advance',{machine,from:policy.machine});
      if(JSON.stringify(service.store.get(principal.userId))!==actorPolicy||
         JSON.stringify(enabledUser(owner,machine))!==ownerPolicy)fail('Archive enrollment authorization changed.',403);
    };
    check();
    const id=key('explicit-enrollment',principal.userId,requestKey),binding=key(owner,machine,dataset,version,policyKey);
    const prior=load(id);
    if(prior){
      if(prior.enrollment?.binding!==binding)fail('Enrollment key cannot change its owner or fixed reference.');
      return Promise.resolve(publicRow(prior));
    }
    const pending=enrolling.get(id);
    if(pending){if(pending.binding!==binding)fail('Enrollment key is already bound to another reference.');return pending.task;}
    const task=(async()=>{
      // No discovery scan, owners mutation, forged upload event, public grant,
      // or automatic copy fallback. Both registered versions must already exist.
      if(rows().some(row=>currentPolicy(row)&&row.owner===owner&&row.machine===machine&&row.dataset===dataset&&row.version===version))
        fail('An archive intent already exists; inspect or retry that intent.');
      const reference={userId:owner,dataset,version},proofs=[];
      for(const target of [machine,policy.machine]){
        const value=await service.bridge(target,'storage.archive.enrollment-check',reference);check();
        if(!value||Object.keys(value).sort().join(',')!=='dataset,machine,manifestBytes,manifestSha256,protocol,registration,role,state,userId,version'||
          value.protocol!==1||value.machine!==target||value.userId!==owner||value.dataset!==dataset||value.version!==version||
          value.state!=='READY'||value.role!=='protected'||value.manifestSha256!==version||
          !HASH.test(value.registration||'')||!Number.isSafeInteger(value.manifestBytes)||value.manifestBytes<1||value.manifestBytes>64*1024**2)
          fail('Existing original or replica is not confirmed; no enrollment was created.');
        proofs.push(value);
      }
      if(proofs[0].manifestBytes!==proofs[1].manifestBytes)fail('Complete immutable manifests do not match.');
      check();
      if(rows().some(row=>currentPolicy(row)&&row.owner===owner&&row.machine===machine&&row.dataset===dataset&&row.version===version))
        fail('An archive intent was created concurrently; inspect that intent.');
      if(rows().length>=10000)fail('Archive history limit reached');
      const now=clock(),row={id,kind:'replica',owner,machine,dataset,version,logicalDataset:dataset,
        sourceMachine:policy.machine,sourceDataset:dataset,phase:'PROVISIONING',copyKey:randomUUID(),transferId:null,
        grantId:null,certifyId:randomUUID(),createdAt:now,updatedAt:now,nextCheckAt:now,failures:0,eventAcknowledged:true,policyKey,
        enrollment:{binding,actor:principal.userId,key:requestKey,targetRegistration:proofs[0].registration,sourceRegistration:proofs[1].registration}};
      row.grantId=grantIdentity(row);save(row);
      service.audit(principal.username,'datasets.archive.enroll',machine,owner+':'+dataset+'@'+version);
      return publicRow(row);
    })().finally(()=>{if(enrolling.get(id)?.task===task)enrolling.delete(id);});
    enrolling.set(id,{binding,task});return task;
  };

  // Explicit authenticated intent, never an automatic retry or a new transfer.
  // The background lane alone consumes this flag after rechecking permission.
  service.retryStorageArchive=(owner,machine,ref)=>{
    if(!policy.enabled||!isRef(ref))fail('Invalid archive retry reference');
    enabledUser(owner,machine);
    const row=rows().findLast(value=>value.owner===owner&&value.machine===machine&&(value.dataset===ref.dataset||value.logicalDataset===ref.dataset)&&value.version===ref.version);
    if(!row)fail('Archive intent is unavailable');
    if(row.failureStage==='retired')fail('已注销的旧归档意图不能重试；重新登记必须使用新的发布事件。');
    fence(row);
    if(row.transferState==='CANCELED')fail('归档传输已永久取消；原件仍受保护，请联系管理员处理。');
    if(!['FAILED','BLOCKED'].includes(row.phase))return publicRow(row);
    row.retryRequested=true;row.nextCheckAt=clock();row.failures=0;
    row.phase=row.kind==='ingest'&&!row.sourceDataset?'COPYING':'PROVISIONING';
    delete row.error;save(row);return publicRow(row);
  };

  async function acknowledge(row,snapshot){
    if(row.eventAcknowledged||row.kind!=='ingest')return;
    const result=await call(row,snapshot,row.machine,'storage.archive.ack',{id:row.eventId,userId:row.owner,dataset:row.dataset,version:row.version});
    if(result?.acknowledged!==true||result.id!==row.eventId)fail('Archive event acknowledgement mismatch');
    row.eventAcknowledged=true;save(row);
  }

  async function advance(row){
    if(service.maintenanceFor?.(row.machine)||service.maintenanceFor?.(policy.machine))return;
    if(row.nextCheckAt>clock())return;
    if(row.phase==='FAILED'||row.phase==='BLOCKED'||row.nextCheckAt>clock())return;
    const snapshot=fence(row);
    if(!holdLane(row))return;
    if(row.phase==='ARCHIVED'){await acknowledge(row,snapshot);releaseLane(row);return;}
    if(row.phase==='QUEUED'||row.phase==='COPYING'){
      if(typeof service.archiveTransferCall!=='function')fail('Archive copy adapter is unavailable');
      // The copy key is durable before the first request; ambiguous replies
      // always resolve the same transfer, never a second destination/name.
      row.phase='COPYING';save(row);
      const result=await service.archiveTransferCall({userId:row.owner,username:service.store.get(row.owner).username,role:'member'},
        {key:row.copyKey,kind:'copy',from:row.machine,machine:policy.machine,dataset:row.dataset,version:row.version,name:'archive-'+key(row.owner,row.machine,row.dataset).slice(0,24)},
        {resume:row.retryRequested===true});
      fence(row,snapshot);
      if(!UUID.test(result?.id))fail('Archive transfer identity mismatch');
      if(row.transferId&&row.transferId!==result.id)fail('Archive transfer changed identity');
      row.transferId=result.id;
      row.transferState=result.state;
      if(result.state==='FAILED'||result.state==='PAUSED'||result.state==='CANCELED'){
        row.phase='FAILED';row.failureStage='copy';row.retryRequested=false;
        row.error=result.state==='CANCELED'?'归档传输已永久取消；原件仍受保护，请联系管理员处理。':'长期归档未完成，本机原件仍受保护。请检查传输后重试。';save(row);releaseLane(row);return;
      }
      row.retryRequested=false;
      if(result.state!=='SUCCEEDED'){save(row);return;}
      if(!isRef(result.result)||result.result.version!==row.version)fail('Archive copy returned a different version');
      row.sourceDataset=result.result.dataset;row.grantId=grantIdentity(row);row.phase='PROVISIONING';save(row);
    }
    if(row.machine===policy.machine){
      const result=await call(row,snapshot,policy.machine,'storage.archive.original',{userId:row.owner,dataset:row.dataset,version:row.version});
      if(result?.protected!==true||result.dataset!==row.dataset||result.version!==row.version)fail('Archive original is not protected');
      row.phase='ARCHIVED';delete row.error;save(row);await acknowledge(row,snapshot);releaseLane(row);return;
    }
    const request={opId:row.grantId,userId:row.owner,source:{dataset:row.sourceDataset,version:row.version},targetMachine:row.machine,
      ...(row.enrollment?{expectedRegistration:row.enrollment.sourceRegistration}:{}),...(row.retryRequested?{retry:true}:{})};
    const provision=await call(row,snapshot,policy.machine,'storage.archive.provision',request);
    if(provision?.opId!==row.grantId)fail('Archive provision identity mismatch');
    if(provision.state==='FAILED'){row.phase='FAILED';row.failureStage='provision';row.retryRequested=false;row.error='长期原件校验未完成，本机副本不会被清理。';save(row);releaseLane(row);return;}
    if(provision.state!=='READY'){row.phase='PROVISIONING';save(row);return;}
    if(!provision.grant||provision.grant.id!==row.grantId||provision.grant.sourceMachine!==policy.machine||provision.grant.targetMachine!==row.machine||provision.grant.dataset!==row.sourceDataset||provision.grant.version!==row.version||JSON.stringify(provision.grant.receipt?.owners)!==JSON.stringify([row.owner]))fail('Archive grant does not match the fixed owner/reference');
    row.phase='CERTIFYING';save(row);
    const certified=await call(row,snapshot,row.machine,'storage.archive.certify',{opId:row.certifyId,userId:row.owner,target:{dataset:row.dataset,version:row.version},grant:provision.grant,
      ...(row.enrollment?{expectedRegistration:row.enrollment.targetRegistration}:{}),...(row.retryRequested?{retry:true}:{})});
    if(certified?.opId===row.certifyId&&certified.state==='FAILED'){row.phase='FAILED';row.failureStage='certify';row.retryRequested=false;row.error='缓存认证未完成；本机副本仍受保护，请检查后重试。';save(row);releaseLane(row);return;}
    if(certified?.opId!==row.certifyId||certified.state!=='READY'||certified.dataset!==row.dataset||certified.version!==row.version||certified.role!=='cache'||!HASH.test(certified.receiptSha256||''))fail('Archive cache certification not confirmed');
    row.receiptSha256=certified.receiptSha256;row.phase='ARCHIVED';row.failures=0;row.retryRequested=false;delete row.error;save(row);
    await acknowledge(row,snapshot);
    releaseLane(row);
  }

  service.reconcileStorageArchive=async()=>{
    if(reconciling||service.closing||!policy.enabled||!service.bridge||service.maintenanceFor?.(policy.machine))return;
    reconciling=true;
    try{
      // Only post-enable publish intents are enumerated. No scan of old users,
      // datasets, disks or cloud accounts creates an archive job.
      for(const machine of MACHINES){
        if(service.closing)return;
        if(service.maintenanceFor?.(machine.id))continue;
        try{
          const value=await service.bridge(machine.id,'storage.archive.events',{limit:8});
          if(!Array.isArray(value?.events)||value.events.length>8)fail('Invalid archive outbox response');
          for(const event of value.events){try{enqueueEvent(machine.id,event);}catch{}}
        }catch{}
      }
      // A single HDD copy/seal lane bounds source pressure. Existing node
      // workers persist and continue through a portal restart.
      // A known stopped failure may have crashed between saving its receipt
      // and releasing the lane. Unknown replies and revocation retain it.
      let held=laneOwner(),heldRow=held&&load(held);
      const knownStoppedFailure=heldRow?.phase==='FAILED'&&(['copy','provision','certify'].includes(heldRow.failureStage)||
        heldRow.failureStage==='retired'&&HASH.test(heldRow.retirement?.proofSha256||''));
      if(heldRow&&(heldRow.phase==='ARCHIVED'&&heldRow.eventAcknowledged||knownStoppedFailure)){releaseLane(heldRow);held=null;}
      const pending=held?(heldRow?[heldRow]:[]):rows().filter(row=>row.nextCheckAt<=clock()&&(row.phase==='ARCHIVED'&&!row.eventAcknowledged||!['ARCHIVED','FAILED','BLOCKED'].includes(row.phase))).sort((a,b)=>a.updatedAt-b.updatedAt);
      for(const row of pending.slice(0,1)){
        try{await advance(row);}
        catch(error){
          if(service.closing)return;
          if(retiring.has(row.id)||load(row.id)?.failureStage==='retired')continue;
          if(error.code==='MAINTENANCE_ACTIVE')continue; // Retain the fixed intent/lane without automatic retry or cleanup.
          row.failures=(row.failures||0)+1;
          row.nextCheckAt=clock()+Math.min(300000,15000*2**Math.min(row.failures,5));
          row.error='归档状态暂未确认；保留本机数据，稍后自动核对。';
          try{enabledUser(row.owner,row.machine);}catch{row.phase='BLOCKED';row.error='账号或机器授权已改变；原件保持受保护，等待管理员核对。';}
          save(row);
        }
      }
    }finally{reconciling=false;}
  };
  if(policy.enabled&&startTimer){service.storageArchiveTimer=setInterval(()=>service.reconcileStorageArchive().catch(()=>{}),15000);service.storageArchiveTimer.unref();}
  return {enqueueEvent,load,rows,advance,policy};
}
