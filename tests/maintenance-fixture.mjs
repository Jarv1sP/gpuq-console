import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
export const password='Retired-Maintenance-Fixture-2026!';
export function seedLegacy(service,owner,{state='PENDING',approver,script='printf "old audit only\\n"',machine=MACHINES[0].id,title='历史系统维护',...rest}={}){
  const id=randomUUID(),at=Date.now(),data={payload:{machine,title,reason:'历史记录',script,cwd:'/root',timeoutSec:300},owner:{id:owner.id,username:owner.username},scriptSha256:createHash('sha256').update(script).digest('hex'),executionKey:randomUUID(),...rest};
  if(approver)data.approver=approver;
  service.db.prepare('INSERT INTO maintenance_requests(id,owner_id,client_key,digest,state,revision,created_at,updated_at,data) VALUES(?,?,?,?,?,1,?,?,?)').run(id,owner.id,randomUUID(),'historical-digest',state,at,at,JSON.stringify(data));
  service.audit(owner.username,'maintenance.create',id,'historical-audit');return {id,data};
}
export async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-maintenance-retired-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,hostCommand:{version:1,available:true},gpus:Array.from({length:m.cards},(_,index)=>({index,uuid:'GPU-'+index,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))}));
  const calls=[],receipts=new Map();let fault;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(fault)throw fault;
    if(operation==='host.exec')return {id:args.key,state:'SUCCEEDED',stdout:'fixture admin\n',stderr:'',exitCode:0};
    if(operation!=='host.status')throw Error('Unexpected mutation');
    if(!receipts.has(args.id))throw Error('No receipt');return structuredClone(receipts.get(args.id));
  };
  let service=await PortalService.open(database,bootstrap,status,bridge);clearInterval(service.executionTimer);
  let beforeCleanup=async()=>{};
  t.after(async()=>{try{await beforeCleanup();}finally{try{if(!service.closing)service.close();}finally{await rm(dir,{recursive:true,force:true});}}});
  let admin=await service.login('admin',password);
  const owner=(await service.invoke(admin.token,'users.create',{username:'archive-owner',password})).result;
  const other=(await service.invoke(admin.token,'users.create',{username:'archive-other',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:owner.id,policyVersion:0});
  await service.invoke(admin.token,'policy.full',{userId:other.id,policyVersion:0});
  let member=await service.login(owner.username,password),second=await service.login(other.username,password);
  const call=(operation,args={},token=member.token)=>service.invoke(token,'maintenance.'+operation,args).then(r=>r.result);
  return {dir,database,bootstrap,status,bridge,calls,receipts,owner,other,call,cleanupWith:fn=>beforeCleanup=fn,get service(){return service},get admin(){return admin},get member(){return member},get second(){return second},fault:value=>fault=value,
    reopen:async()=>{service.close();service=await PortalService.open(database,undefined,status,bridge);clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);admin=await service.login('admin',password);member=await service.login(owner.username,password);second=await service.login(other.username,password);}};
}
