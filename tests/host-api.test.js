import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';

const password='Host-Only-Test-Password-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-host-api-')),database=join(dir,'database'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const snapshot=async({capability={version:1,available:true},stale=false,reachable=true,connected=true}={})=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date(Date.now()-(stale?240000:0)).toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable,hostCommand:capability,gpus:[],gpuq:{connected,observeOnly:false,jobs:[]}}))}));
  await snapshot();
  const calls=[],receipts=new Map();let failure=null;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(failure)throw failure;
    const id=args.key||args.id,key=machine+':'+id;
    if(operation==='host.exec'){
      const digest=JSON.stringify([args.userId,args.argv,args.cwd||'/root',args.timeoutSec||300]);
      const previous=receipts.get(key);
      if(previous&&previous.digest!==digest)throw Error('The same command key cannot be reused for different arguments');
      if(!previous)receipts.set(key,{digest,userId:args.userId,result:{id,key:id,state:'RUNNING',stdout:'',stderr:'',exitCode:null,signal:null,timedOut:false,truncated:{stdout:false,stderr:false}}});
    }
    const receipt=receipts.get(key);
    if(!receipt||receipt.userId!==args.userId)throw Error('Command handle is not owned by this administrator');
    if(operation==='host.cancel')receipt.result={...receipt.result,state:'CANCELED',cancelRequested:true};
    return structuredClone(receipt.result);
  };
  let s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);
  let admin=await s.login('admin',password);
  const member=(await s.invoke(admin.token,'users.create',{username:'host-member',password})).result;
  let user=await s.login(member.username,password);
  await s.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true});});
  const exec=(more={},token=admin.token)=>s.invoke(token,'host.exec',{machine:'gpu-1',key:randomUUID(),argv:['id'],...more});
  return {get s(){return s},get admin(){return admin},get user(){return user},member,calls,receipts,exec,snapshot,fail:value=>failure=value,
    reopen:async()=>{s.close();s=await PortalService.open(database,undefined,status,bridge);clearInterval(s.executionTimer);admin=await s.login('admin',password);user=await s.login(member.username,password);}
  };
}

test('full GPU grants never allow host exec/status/cancel; authentication is enforced before bridge',async t=>{
  const f=await fixture(t);assert.equal(f.s.store.get(f.member.id).total,30);
  for(const operation of ['host.exec','host.status','host.cancel']){
    const args={machine:'gpu-1',...(operation==='host.exec'?{key:randomUUID(),argv:['id']}:{id:randomUUID()})};
    await assert.rejects(f.s.invoke(f.user.token,operation,args),error=>error.status===403);
    await assert.rejects(f.s.invoke('invalid-session',operation,args),error=>error.status===401);
  }
  assert.equal(f.calls.length,0);
});

test('host exec fails clearly before audit or dispatch on old, unsafe, stale or unreachable nodes',async t=>{
  const f=await fixture(t);
  for(const capability of [undefined,null,false,{},[],{version:1},{available:true},{version:2,available:true},{version:1,available:1},{version:1,available:false}]){
    await f.snapshot({capability:capability===undefined?null:capability});
    await assert.rejects(f.exec(),error=>error.status===503&&/未提交命令/.test(error.message));
  }
  for(const options of [{stale:true},{reachable:false}]){
    await f.snapshot(options);await assert.rejects(f.exec(),error=>error.status===503);
  }
  assert.equal(f.calls.length,0);assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='host.exec'").get().n,0);
  await f.snapshot({connected:false});await f.exec();assert.equal(f.calls.length,1,'Host repair commands do not depend on GPUQ being healthy');
});

test('host status and cancel remain usable when readiness cache expires or capability disappears',async t=>{
  const f=await fixture(t),key=randomUUID();await f.exec({key});
  for(const options of [{stale:true},{capability:null},{reachable:false}]){
    await f.snapshot(options);await f.s.refreshGPUQ();
    const status=await f.s.invoke(f.admin.token,'host.status',{machine:'gpu-1',id:key});assert.equal(status.result.id,key);
    const canceled=await f.s.invoke(f.admin.token,'host.cancel',{machine:'gpu-1',id:key});assert.equal(canceled.result.state,'CANCELED');
  }
  assert.equal(f.calls.filter(c=>c.operation==='host.status').length,3);assert.equal(f.calls.filter(c=>c.operation==='host.cancel').length,3);
});

test('host endpoints require explicit real machines, typed UUIDs and reject client identity/context injection',async t=>{
  const f=await fixture(t),id=randomUUID();
  for(const operation of ['host.exec','host.status','host.cancel']){
    const args={machine:'gpu-1',...(operation==='host.exec'?{key:id,argv:['id']}:{id})};
    for(const machine of [undefined,null,'','auto','unknown',['gpu-1'],{}])await assert.rejects(f.s.invoke(f.admin.token,operation,{...args,machine}),error=>error.status===403);
    for(const extra of [{userId:'builtin-admin'},{username:'someone'},{hostAdmin:true},{role:'admin'},{project:'x'},{release:'a'.repeat(64)},{env:{PATH:'/tmp'}},{shell:true}])await assert.rejects(f.s.invoke(f.admin.token,operation,{...args,...extra}),error=>error.status===400);
    for(const value of [undefined,null,42,{},[],[id],'not-a-uuid'])await assert.rejects(f.s.invoke(f.admin.token,operation,{...args,[operation==='host.exec'?'key':'id']:value}),error=>error.status===400);
  }
  assert.equal(f.calls.length,0);
});

test('invalid argv, byte size, cwd and timeout are rejected before any host side effect',async t=>{
  const f=await fixture(t);
  for(const argv of [undefined,null,'id',[],[''],['id',null],['id','a\0b'],Array(129).fill('x'),['x'.repeat(12001)],['中'.repeat(5000)]])await assert.rejects(f.exec({argv}),error=>error.status===400,JSON.stringify(argv)?.slice(0,80));
  for(const cwd of [null,123,[],{},'relative','/root\0x','/'+'x'.repeat(1024)])await assert.rejects(f.exec({cwd}),error=>error.status===400);
  for(const timeoutSec of [null,0,-1,86401,1.5,'30',true,{},[]])await assert.rejects(f.exec({timeoutSec}),error=>error.status===400);
  assert.equal(f.calls.length,0);assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='host.exec'").get().n,0);
});

test('host commands forward literal argv with server-owned identity and preserve bounded execution result fields',async t=>{
  const f=await fixture(t),key=randomUUID(),argv=['printf','literal;$(touch forbidden) * "quoted"'];
  const submitted=await f.exec({machine:'gpu-2',key,argv,cwd:'/root/dir with spaces',timeoutSec:3600});
  assert.deepEqual(f.calls.at(-1),{machine:'gpu-2',operation:'host.exec',args:{key,argv,cwd:'/root/dir with spaces',timeoutSec:3600,userId:'builtin-admin',username:'admin',hostAdmin:true}});
  assert.equal(submitted.result.id,key);assert.equal(submitted.result.state,'RUNNING');
  const receipt=f.receipts.get('gpu-2:'+key);receipt.result={...receipt.result,state:'FAILED',stdout:'out\n',stderr:'err\n',exitCode:7,signal:null,truncated:{stdout:true,stderr:false},outputLimitBytes:65536};
  const status=(await f.s.invoke(f.admin.token,'host.status',{machine:'gpu-2',id:key})).result;
  assert.deepEqual(status,receipt.result);assert.equal(f.calls.at(-1).args.hostAdmin,true);assert.equal(f.calls.at(-1).args.userId,'builtin-admin');
  const canceled=(await f.s.invoke(f.admin.token,'host.cancel',{machine:'gpu-2',id:key})).result;assert.equal(canceled.state,'CANCELED');
  assert.equal(f.s.store.jobs.length,0);assert.equal(usage(f.s.store.jobs,'builtin-admin'),0);
});

test('retries preserve the same idempotency key through restart; audit records identity/key but never command or output',async t=>{
  const f=await fixture(t),key=randomUUID(),secret='SENSITIVE-FIXTURE-DO-NOT-AUDIT',args={key,argv:['printf',secret],cwd:'/root/private-test'};
  const first=(await f.exec(args)).result;await f.exec(args);await f.reopen();const retried=(await f.exec(args)).result;
  assert.equal(first.id,retried.id);assert.equal(f.receipts.size,1);
  assert.ok(f.calls.every(c=>c.args.key===key&&c.args.argv[1]===secret));
  await assert.rejects(f.exec({...args,argv:['different']}),/same command key/);assert.equal(f.receipts.size,1);
  const rows=f.s.db.prepare("SELECT * FROM audit WHERE operation LIKE 'host.%'").all();assert.equal(rows.length,4);
  for(const row of rows){assert.equal(row.actor,'admin');assert.equal(row.subject,'gpu-1');assert.equal(row.outcome,key);}
  assert.equal(JSON.stringify(rows).includes(secret),false);assert.equal(JSON.stringify(rows).includes('/root/private-test'),false);
  assert.equal(f.s.db.prepare('SELECT data FROM portal_state').get().data.includes(secret),false);
});

test('RPC failure retains an audit intent, never retries/cancels implicitly, and audit failure blocks dispatch',async t=>{
  const f=await fixture(t),key=randomUUID();f.fail(Error('node timeout'));
  await assert.rejects(f.exec({key}),/node timeout/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'host.exec');
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='host.exec'").get().n,1);assert.equal(f.s.store.jobs.length,0);
  f.fail(Error('Host root commands require an administrator and enabled hostRoot'));
  await assert.rejects(f.exec(),/enabled hostRoot/);
  const audit=f.s.audit;f.s.audit=()=>{throw Error('audit disk full');};
  try{await assert.rejects(f.exec(),/audit disk full/);}finally{f.s.audit=audit;}
  assert.equal(f.calls.length,2);
});

test('handle ownership remains node-enforced with authenticated owner, and demotion revokes prior administrator session',async t=>{
  const f=await fixture(t),key=randomUUID();await f.exec({key});
  const second=(await f.s.invoke(f.admin.token,'users.create',{username:'second-admin',password,role:'admin'})).result;
  const other=await f.s.login(second.username,password);
  for(const operation of ['host.status','host.cancel'])await assert.rejects(f.s.invoke(other.token,operation,{machine:'gpu-1',id:key}),/not owned/);
  assert.equal(f.calls.at(-1).args.userId,second.id);assert.equal(f.calls.at(-1).args.username,second.username);
  await f.s.invoke(f.admin.token,'users.role',{userId:second.id,role:'member'});
  const before=f.calls.length;await assert.rejects(f.exec({},other.token),error=>error.status===401);
  const current=await f.s.login(second.username,password);await assert.rejects(f.exec({},current.token),error=>error.status===403);assert.equal(f.calls.length,before);
});
