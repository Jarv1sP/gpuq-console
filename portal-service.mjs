import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {DemoService,credential} from './dist/service.js';
import {readGPUQStatus,visibleGPUQStatus} from './gpuq-status.mjs';
import {installExecution,executionCall,publicJob,usage,priorityCapable,priorityRankCapable} from './execution.mjs';
import {MACHINES,validUsername} from './dist/model.js';
import {installCommunity,communityCall,maintainTaskNotes} from './community.mjs';
import {installMaintenance,maintenanceCall} from './maintenance.mjs';
import {installJobNotifications} from './job-notifications.mjs';
import {installTransfers,transferCall} from './transfers.mjs';
import {installCloudImports,cloudImportCall} from './cloud-import.mjs';

// One process owns this database. Serial transactions keep account changes atomic.
// Reservations are durable before the separate restricted executor dispatches GPUQ.
export class PortalService extends DemoService{
  static async open(path,bootstrapPath,statusPath,bridge,notificationConfig){
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const service=new PortalService();service.production=true;service.tail=Promise.resolve();service.pending=0;
    service.terminalLanes=new Map();service.terminalPending=0;
    service.cloudPending=0;service.cloudUsers=new Map();service.cloudKeys=new Set();
    service.datasetReadPending=0;
    service.db=new DatabaseSync(path);await chmod(path,0o600);
    service.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS portal_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, subject TEXT, outcome TEXT NOT NULL);');
    service.db.exec("CREATE TABLE IF NOT EXISTS invites (role TEXT PRIMARY KEY CHECK(role IN ('admin','member')), digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, created_at TEXT NOT NULL);");
    installCommunity(service);
    if(!service.db.prepare('PRAGMA table_info(invites)').all().some(c=>c.name==='code_cipher'))service.db.exec('ALTER TABLE invites ADD COLUMN code_cipher TEXT');
    const keyPath=path+'.invite-key';
    try{service.inviteKey=await readFile(keyPath);}catch(e){
      if(e.code!=='ENOENT')throw e;
      if(service.db.prepare('SELECT 1 FROM invites WHERE code_cipher IS NOT NULL LIMIT 1').get())throw Error('Invitation encryption key missing; restore it from the private backup.');
      for(const table of ['cloud_secrets','cloud_imports'])if(service.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&service.db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())throw Error('Cloud encryption key missing; restore the original private key backup.');
      await writeFile(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});service.inviteKey=await readFile(keyPath);
    }
    if(service.inviteKey.length!==32)throw Error('Invalid invitation encryption key');await chmod(keyPath,0o600);
    installCloudImports(service);
    const saved=service.db.prepare('SELECT data FROM portal_state WHERE id=1').get();
    if(saved)service.restore(JSON.parse(saved.data));
    else{
      if(!bootstrapPath)throw Error('Initial administrator credentials are required.');
      const initial=JSON.parse(await readFile(bootstrapPath,'utf8'));
      if(initial.username!=='admin'||typeof initial.password!=='string'||initial.password.length<20)throw Error('Bootstrap requires admin and a generated password of at least 20 characters.');
      service.store.users=[{id:'builtin-admin',name:'管理员',username:'admin',role:'admin',enabled:true,limits:{},total:0}];service.store.jobs=[];service.store.sequence=0;
      service.credentials=new Map([['admin',await credential(initial.password,600000)]]);service.save();
    }
    // Public registration never grants administrative authority.
    service.db.prepare("UPDATE invites SET enabled=0 WHERE role='admin'").run();
    for(const user of service.store.users)user.policyVersion??=0;
    maintainTaskNotes(service);
    service.statusPath=statusPath;await service.refreshGPUQ();installExecution(service,bridge);installJobNotifications(service,notificationConfig);installMaintenance(service);
    installTransfers(service);
    service.dummy=await credential(crypto.randomUUID(),600000);return service;
  }
  export(){return {schema:1,users:this.store.users,jobs:this.store.jobs,sequence:this.store.sequence,credentials:[...this.credentials].map(([name,r])=>[name,{salt:Buffer.from(r.salt).toString('base64'),hash:Buffer.from(r.hash).toString('base64'),iterations:r.iterations||210000}])};}
  restore(data){if(data.schema!==1)throw Error('Unsupported database version.');this.store.users=data.users;this.store.jobs=data.jobs;this.store.sequence=data.sequence;this.credentials=new Map(data.credentials.map(([name,r])=>[name,{salt:new Uint8Array(Buffer.from(r.salt,'base64')),hash:new Uint8Array(Buffer.from(r.hash,'base64')),iterations:r.iterations}]));}
  save(){this.db.prepare('INSERT INTO portal_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(this.export()));}
  audit(actor,operation,subject,outcome){this.db.prepare('INSERT INTO audit(time,actor,operation,subject,outcome) VALUES(?,?,?,?,?)').run(new Date().toISOString(),String(actor).slice(0,64),String(operation).slice(0,64),subject?String(subject).slice(0,64):null,outcome);}
  enqueue(fn){
    if(this.pending>=24){const e=Error('服务忙，请稍后重试。');e.status=429;return Promise.reject(e);}
    this.pending++;const run=this.tail.then(fn);this.tail=run.catch(()=>{}).finally(()=>this.pending--);return run;
  }
  terminalPrincipal(token,args){
    if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
    const {username,role,userId}=this.principal(token);
    const current=this.store.users.find(user=>user.id===userId);
    if(!current?.enabled||current.username!==username||(current.role||'member')!==role)
      throw Object.assign(Error('终端账号权限已改变，请重新登录。'),{status:403});
    const user=this.store.get(userId);
    if(!MACHINES.some(machine=>machine.id===args.machine)||!user.limits[args.machine])
      throw Object.assign(Error('这台机器未授权。'),{status:403});
    if(args.hostAdmin&&role!=='admin')throw Object.assign(Error('宿主机 root 终端仅管理员可用。'),{status:403});
    return {username,role,userId};
  }
  async terminalExchange(token,args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    // Only streaming exchanges bypass the durable mutation queue. The node
    // still validates ownership and fences every request with its writer lease.
    args={...args};const admitted=this.terminalPrincipal(token,args);
    const key=JSON.stringify([args.machine,args.id]);
    const lane=this.terminalLanes.get(key)||{tail:Promise.resolve(),pending:0};
    if(this.terminalPending>=24||lane.pending>=4)
      throw Object.assign(Error('终端请求过多，请等待当前请求完成。'),{status:429});
    this.terminalLanes.set(key,lane);this.terminalPending++;lane.pending++;
    const run=lane.tail.then(async()=>{
      const principal=this.terminalPrincipal(token,args);
      if(principal.userId!==admitted.userId||principal.role!==admitted.role||principal.username!==admitted.username)
        throw Object.assign(Error('终端登录身份已改变。'),{status:403});
      // executionCall retains the complete trusted field/context validation and
      // dispatches exactly once. Never retry input after an ambiguous failure.
      let result,current;
      try{result=await executionCall(this,principal,'terminal.exchange',args);}finally{
        // Recheck failed responses too: node errors can contain private context.
        current=this.terminalPrincipal(token,args);
        if(current.userId!==principal.userId||current.role!==principal.role||current.username!==principal.username)
          throw Object.assign(Error('终端登录身份已改变。'),{status:403});
      }
      // Do not send the entire GPU/account snapshot on every keystroke, or leak
      // a delayed terminal response after logout, suspension or grant revocation.
      return {result,principal:current};
    });
    lane.tail=run.catch(()=>{});
    try{return await run;}finally{
      this.terminalPending--;lane.pending--;
      if(!lane.pending)this.terminalLanes.delete(key);
    }
  }
  async cloudExchange(token,operation,args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    args=structuredClone(args);
    const admitted=this.principal(token);
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=this.principal(token),user=this.store.users.find(u=>u.id===current.userId);
      if(!user?.enabled||current.userId!==admitted.userId||current.role!==admitted.role||current.username!==admitted.username||(user.role||'member')!==current.role)
        throw Object.assign(Error('账号权限已改变，请重新登录。'),{status:403});
      if(args.machine&&(!MACHINES.some(m=>m.id===args.machine)||!this.store.get(current.userId).limits[args.machine]))
        throw Object.assign(Error('这台机器未授权。'),{status:403});
      return current;
    };
    check();
    const count=this.cloudUsers.get(admitted.userId)||0;
    const key=operation.startsWith('cloud.import.')&&(args.key||args.operationId)?JSON.stringify([admitted.userId,args.machine,args.key||args.operationId]):null;
    if(this.cloudPending>=8||count>=2||key&&this.cloudKeys.has(key))throw Object.assign(Error('导入请求正在处理，请稍后刷新或重试。'),{status:429});
    this.cloudPending++;this.cloudUsers.set(admitted.userId,count+1);if(key)this.cloudKeys.add(key);
    try{
      let result;try{result=await cloudImportCall(this,admitted,operation,args,check);}finally{check();}
      return {result,principal:check()};
    }finally{
      this.cloudPending--;const remaining=this.cloudUsers.get(admitted.userId)-1;
      if(remaining)this.cloudUsers.set(admitted.userId,remaining);else this.cloudUsers.delete(admitted.userId);
      if(key)this.cloudKeys.delete(key);
    }
  }
  async datasetRead(token,operation,args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    args=structuredClone(args);
    const admitted=this.principal(token),policy=JSON.stringify(this.store.get(admitted.userId));
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=this.principal(token);
      if(current.userId!==admitted.userId||current.role!==admitted.role||current.username!==admitted.username||JSON.stringify(this.store.get(current.userId))!==policy)
        throw Object.assign(Error('账号授权已改变，请重新加载数据集。'),{status:403});
      return current;
    };
    check();
    if(this.datasetReadPending>=4)throw Object.assign(Error('数据目录正在读取，请稍后刷新。'),{status:429});
    this.datasetReadPending++;
    try{let result;try{result=await executionCall(this,admitted,operation,args);}finally{check();}return {result,principal:check()};}
    finally{this.datasetReadPending--;}
  }
  login(username,password){return this.enqueue(async()=>{
    try{await this.refreshGPUQ();const result=await super.login(username,password);this.audit(username,'login',null,'ok');return result;}
    catch(e){this.audit(username,'login',null,'denied');throw e;}
  });}
  invitations(){return ['member'].map(role=>{
    const row=this.db.prepare('SELECT role,enabled,uses,max_uses,created_at FROM invites WHERE role=?').get(role);
    return row?{role,enabled:!!row.enabled,uses:row.uses,maxUses:row.max_uses,createdAt:row.created_at,available:!!row.enabled&&(row.max_uses===null||row.uses<row.max_uses)}:{role,enabled:false,uses:0,maxUses:role==='admin'?1:null,createdAt:null,available:false};
  });}
  // Immutable storage-format identifier: keep existing encrypted invitations valid.
  sealInvite(code){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.inviteKey,nonce);cipher.setAAD(Buffer.from('amax-invite-v1'));const data=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('base64');}
  currentInvite(){const row=this.db.prepare("SELECT enabled,code_cipher FROM invites WHERE role='member'").get();if(!row?.enabled||!row.code_cipher)return null;const data=Buffer.from(row.code_cipher,'base64'),decipher=createDecipheriv('aes-256-gcm',this.inviteKey,data.subarray(0,12));decipher.setAAD(Buffer.from('amax-invite-v1'));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');}
  register(args){return this.enqueue(async()=>{
    const before=structuredClone(this.export());let transaction=false;
    try{
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['username','password','invite','client','name'].includes(k)))throw Error('注册参数无效；角色由邀请码决定。');
      const {password,invite}=args,username=String(args.username??'').trim();
      if(!validUsername(username))throw Error('用户名须为 2–24 位，使用汉字或小写字母开头，可含数字、下划线和短横线。');
      if(typeof password!=='string'||password.length<8||password.length>128)throw Error('密码需为 8–128 个字符。');
      if(typeof invite!=='string'||invite.length>128){const e=Error('邀请码无效、已停用或已用完。');e.status=403;throw e;}
      const digest=createHash('sha256').update(invite.trim()).digest('hex');
      const code=this.db.prepare("SELECT * FROM invites WHERE role='member' AND digest=? AND enabled=1 AND (max_uses IS NULL OR uses<max_uses)").get(digest);
      if(!code){const e=Error('邀请码无效、已停用或已用完。');e.status=403;throw e;}
      if(this.store.users.some(u=>u.username===username))throw Error('这个用户名已存在，请换一个。');
      if(this.store.users.length>=1000)throw Error('注册名额已满，请联系管理员。');
      const record=await credential(password,600000);
      this.db.exec('BEGIN IMMEDIATE');transaction=true;
      const update=this.db.prepare('UPDATE invites SET uses=uses+1 WHERE role=? AND digest=? AND enabled=1 AND (max_uses IS NULL OR uses<max_uses)').run(code.role,digest);
      if(update.changes!==1)throw Error('邀请码已失效，请联系管理员。');
      const user=this.store.create(args.name??username,username);this.store.setRole(user.id,'member');this.store.users.find(u=>u.id===user.id).policyVersion=0;this.credentials.set(username,record);
      this.save();this.audit(username,'register',code.role,'ok');this.db.exec('COMMIT');transaction=false;
      return {registered:true,username,role:code.role};
    }catch(e){if(transaction)this.db.exec('ROLLBACK');this.restore(before);this.audit('guest','register',null,'denied');throw e;}
  });}
  manageInvites(principal,operation,args){
    if(principal.role!=='admin'){const e=Error('此操作需要管理员权限。');e.status=403;throw e;}
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    if(operation==='invites.list')return {invitations:this.invitations(),code:this.currentInvite()};
    const {role}=args;if(role!=='member'||!['invites.rotate','invites.disable'].includes(operation))throw Error('只开放普通用户邀请码；管理员权限不能通过注册获得。');
    let result;this.db.exec('BEGIN IMMEDIATE');
    try{
      if(operation==='invites.rotate'){
        const code=`GPUQ-${role==='admin'?'A':'U'}-${randomBytes(24).toString('base64url')}`;
        const digest=createHash('sha256').update(code).digest('hex');
        this.db.prepare('INSERT INTO invites(role,digest,enabled,uses,max_uses,created_at) VALUES(?,?,1,0,?,?) ON CONFLICT(role) DO UPDATE SET digest=excluded.digest,enabled=1,uses=0,max_uses=excluded.max_uses,created_at=excluded.created_at').run(role,digest,role==='admin'?1:null,new Date().toISOString());
        this.db.prepare('UPDATE invites SET code_cipher=? WHERE role=?').run(this.sealInvite(code),role);
        result={role,code,invitations:this.invitations()};
      }else{this.db.prepare('UPDATE invites SET enabled=0 WHERE role=?').run(role);result={role,disabled:true,invitations:this.invitations()};}
      this.audit(principal.username,operation,role,'ok');this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  invoke(token,operation,args={}){
    if(operation==='terminal.exchange')return this.terminalExchange(token,args);
    if(['datasets.catalog','datasets.capacity','datasets.list','datasets.status','datasets.prepare'].includes(operation))return this.datasetRead(token,operation,args);
    if(typeof operation==='string'&&operation.startsWith('transfers.')){
      const principal=this.principal(token);
      return transferCall(this,principal,operation,args,()=>this.principal(token)).then(result=>({result,principal:{username:principal.username,role:principal.role,userId:principal.userId}}));
    }
    // Remote cloud/DNS requests do not hold the account and scheduler queue.
    if(typeof operation==='string'&&operation.startsWith('cloud.')&&!operation.startsWith('cloud.auth.'))return this.cloudExchange(token,operation,args);
    return this.enqueue(async()=>{
    const principal=this.principal(token),actor=principal.username;
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    if(typeof operation==='string'&&operation.startsWith('cloud.auth.'))return {result:await cloudImportCall(this,principal,operation,args,()=>{if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});this.principal(token);}),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
    if(typeof operation==='string'&&operation.startsWith('maintenance.'))return {result:await maintenanceCall(this,principal,operation,args),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
    if(operation==='notifications.job')return {result:this.configureJobNotification(principal,args),state:this.state(principal)};
    if(typeof operation==='string'&&operation.startsWith('community.'))return {result:communityCall(this,principal,operation,args),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
    // Execution writes its durable reservation before external side effects. Never
    // restore an older snapshot after a dispatch timeout (that would lose quota).
    if(typeof operation==='string'&&(operation.startsWith('jobs.')||operation.startsWith('host.')||operation.startsWith('files.')||operation.startsWith('terminal.')||operation.startsWith('datasets.')||operation.startsWith('projects.'))){
      const result=await executionCall(this,principal,operation,args);
      return {result,state:this.state(principal),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
    }
    const before=structuredClone(this.export()),sessions=new Map(this.sessions);
    try{
      if(operation==='users.delete'){
        if(principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
        const user=this.store.get(args.userId);
    if(user.id===principal.userId||user.enabled||this.store.jobs.some(job=>job.userId===user.id&&!['SUCCEEDED','FAILED','CANCELED'].includes(job.state)))throw Error('只能删除已暂停且没有待完成任务的非当前账号。历史任务和文件保留。');
    if(this.db.prepare("SELECT 1 FROM transfers WHERE owner_id=? AND state NOT IN ('SUCCEEDED','FAILED','PAUSED','CANCELED') LIMIT 1").get(user.id))throw Error('请先确认这个账号的传输已结束，再删除账号。');
        if(user.role==='admin'&&!this.store.users.some(u=>u.id!==user.id&&u.enabled&&u.role==='admin'))throw Error('不能删除最后一名可登录管理员。');
        this.db.exec('BEGIN IMMEDIATE');
        try{this.invalidate(user.username);this.credentials.delete(user.username);this.store.users=this.store.users.filter(u=>u.id!==user.id);this.save();this.audit(actor,operation,user.id,'ok');this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
        return {result:{deleted:true},state:this.state(principal)};
      }
      if(typeof operation==='string'&&operation.startsWith('invites.'))return {result:this.manageInvites(principal,operation,args),state:this.state(principal),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
      if(operation==='request'||operation==='release'){const e=Error('真实 GPUQ 提交尚未开放；不会模拟占卡或启动训练。');e.status=503;throw e;}
      if(operation==='state')await this.refreshGPUQ();
      if(operation==='policy.full'){
        if(principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
        args={userId:args.userId,policyVersion:args.policyVersion,limits:Object.fromEntries(MACHINES.map(m=>[m.id,m.cards])),total:MACHINES.reduce((n,m)=>n+m.cards,0)};operation='policy.save';
      }
      if(operation==='policy.save'){
        if(principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
        const user=this.store.users.find(u=>u.id===args.userId);if(!user)throw Error('用户不存在。');
        if(args.policyVersion!==user.policyVersion)throw Object.assign(Error('权限已被其他窗口修改，请刷新后重试。'),{status:409});
        // Do not silently kill running experiments when lowering a policy.
        if(args.total<usage(this.store.jobs,user.id)||Object.entries(user.limits).some(([m])=>(args.limits?.[m]||0)<usage(this.store.jobs,user.id,m)))throw Object.assign(Error('新额度低于当前预留用卡数。请先取消相应任务并等待释放。'),{status:409});
      }
      const result=await super.invoke(token,operation,args);
      if(operation==='policy.save'){const u=this.store.users.find(u=>u.id===args.userId);u.policyVersion++;u.approvedBy=actor;u.approvedAt=new Date().toISOString();result.result=this.store.get(u.id);result.state=this.state(principal);}
      if(operation==='users.create'){this.store.users.find(u=>u.id===result.result.id).policyVersion=0;result.state=this.state(principal);}
      this.db.exec('BEGIN IMMEDIATE');
      try{if(operation!=='state'&&operation!=='logout')this.save();if(operation!=='state')this.audit(actor,operation,args?.userId||args?.jobId,'ok');this.db.exec('COMMIT');}
      catch(e){this.db.exec('ROLLBACK');throw e;}
      return {...result,principal:operation==='logout'?null:{username:principal.username,role:principal.role,userId:principal.userId}};
    }catch(e){this.restore(before);this.sessions=sessions;this.audit(actor,operation,args?.userId||args?.jobId,'denied');throw e;}
  });}
  async refreshGPUQ(){this.gpuq=await readGPUQStatus(this.statusPath);}
  state(principal){
    const state=super.state(principal);
    const gpuq=visibleGPUQStatus(this.gpuq||{checkedAt:null,stale:true,hosts:[]},principal,this.store.get(principal.userId).limits,{jobs:this.store.jobs,users:this.store.users});
    const capabilities=Object.fromEntries(gpuq.hosts.map(h=>[h.id,!gpuq.stale&&priorityCapable(h)===true]));
    return {...state,taskMetadata:{version:1},maintenance:{version:1,retired:true,readOnly:true},jobs:state.jobs.map(j=>({...publicJob(j,this.store.users),notifications:this.jobNotificationState(j,principal.userId),canSetPriority:principal.role==='admin'&&!gpuq.stale&&priorityRankCapable(gpuq.hosts.find(h=>h.id===j.machine))===true&&j.state==='PENDING'&&!j.cancelRequested&&j.priorityMutable===true&&(j.spec?.preemptIdleOnly===true||!!j.spec?.scheduling)})),
      demo:false,mode:'persistent',gpuqConnected:gpuq.hosts.some(h=>h.gpuq.connected),jobsSimulated:false,executionEnabled:this.executionEnabled===true,
      execution:{priorityCapabilities:capabilities},gpuq,transfers:{version:1},...(principal.role==='admin'?{invitations:this.invitations()}:{})};
  }
  close(){this.closing=true;this.cloudProvider?.clear();clearInterval(this.executionTimer);clearInterval(this.notificationTimer);clearInterval(this.maintenanceTimer);clearInterval(this.transferTimer);this.db.close();}
}
