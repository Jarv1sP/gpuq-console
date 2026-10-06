import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installDatasetDeletion} from '../dataset-deletion.mjs';
import {MACHINES} from '../dist/model.js';

export const hosts=MACHINES.map(m=>m.id),version='a'.repeat(64),snapshot='b'.repeat(64);
export const principal={userId:'demo-user-1',username:'alice',role:'member'};
export const admin={userId:'builtin-admin',username:'admin',role:'admin'};
export const request=()=>({dataset:'personal',version,key:randomUUID()});
export function fixture(t,{db,onlySource=true}={}){
  db??=new DatabaseSync(':memory:');
  const users=[{id:principal.userId,username:'alice',role:'member',enabled:true,limits:Object.fromEntries(hosts.map(h=>[h,1]))},
    {id:admin.userId,username:'admin',role:'admin',enabled:true,limits:Object.fromEntries(hosts.map(h=>[h,1]))}];
  const nodes=new Map(),calls=[],audits=[],f={cap:1,personal:true,missing:false,pending:false,unconfirmed:false,onlySource};
  const service={db,store:{get:id=>users.find(u=>u.id===id),users},
    assertMaintenanceAllowed:()=>{if(f.maintenance)throw Object.assign(Error('maintenance'),{status:503,code:'MAINTENANCE_ACTIVE'});},
    audit:(...args)=>{if(f.auditFailure)throw Error('audit full');audits.push(args);},
    bridge:async(host,op,args)=>{
      calls.push({host,op,args:structuredClone(args)});
      if(f.before)await f.before(host,op,args);
      const phase=op.replace('storage.dataset-delete.','');
      let value;
      if(op==='datasets.list')value={datasets:host===hosts[0]||!f.onlySource?[{dataset:'personal',versions:[{version,state:'READY'}]}]:[]};
      else if(phase==='capabilities')value={protocol:'dataset-delete-node-v1',machine:host,datasetDelete:f.cap};
      else if(phase==='locations')value={protocol:'dataset-delete-node-v1',machine:host,locations:[]};
      else if(phase==='plan'){
        const complete=(host===hosts[0]||!f.onlySource)&&!f.missing;
        const plan={protocol:'dataset-delete-node-v1',operationId:args.operationId,machine:host,dataset:args.dataset,version:args.version,
          state:'PLANNED',snapshotSha256:snapshot,owners:[principal.userId],memberAllowed:f.personal,
          complete,absent:!complete,authority:null,authorityReferences:[]};
        if(!complete)assert.ok(args.authorization,'private negative must carry authenticated complete source proof');
        nodes.set(args.operationId,{plan,phases:{},at:Date.now()});value=plan;
      }else if(phase==='status'){
        const node=nodes.get(args.operationId);
        if(!node)throw Error('no private node plan');
        value={...node.plan,state:node.state||'PLANNED',result:node.result||null,phases:structuredClone(node.phases),
          pendingPhases:f.pending?['fence','isolate']:[],unconfirmedPhases:f.unconfirmed?['fence','isolate']:[]};
      }else if(['fence','isolate','restore','release-absence'].includes(phase)){
        const node=nodes.get(args.operationId);assert.ok(node,'fixed node plan predates dispatch');
        if(phase==='fence'){
          node.at=Date.now();node.state='FENCED';node.phases.fence={ok:true,result:{protocol:'dataset-version-fence-v1',operationId:args.operationId,
            machine:host,dataset:node.plan.dataset,version,snapshotSha256:snapshot,generation:'c'.repeat(64),state:'FENCED',drained:true}};
        }else{
          const restored=phase!=='isolate';node.state=restored?'RESTORED':'ISOLATED';
          const receipt={protocol:'dataset-version-retirement-v1',operationId:args.operationId,machine:host,dataset:node.plan.dataset,version,
            state:node.state,isolated:!restored,complete:node.plan.complete,snapshotSha256:snapshot,generation:'c'.repeat(64),
            fenceState:restored?(node.plan.absent?'RELEASED':'RESTORED'):'ISOLATED',retainUntil:node.at/1000+7*86400,
            proofSha256:'d'.repeat(64),authorityReferences:structuredClone(node.plan.authorityReferences)};
          node.result=receipt;node.phases[phase]={ok:true,result:receipt};
        }
        value={protocol:'dataset-delete-node-v1',operationId:args.operationId,machine:host,state:'DISPATCHED',action:phase};
      }else throw Error('unexpected operation '+op);
      if(f.after)await f.after(host,op,args,value);
      return value;
    }};
  installDatasetDeletion(service,{pollMs:1,waitMs:30});
  t.after(async()=>{await service.waitDatasetDeletions();if(!db.isOpen)return;db.close();});
  return Object.assign(f,{service,nodes,calls,audits,users,
    call:(op,args,who=principal,current=()=>{})=>service.datasetDeletionCall(who,op,args,current),
    start:async(args=request(),who=principal)=>{const first=await service.datasetDeletionCall(who,'datasets.delete',args);await service.waitDatasetDeletions();return {first,result:(await service.datasetDeletionCall(who,'datasets.delete.status',{key:args.key})),args};}});
}
export const writes=f=>f.calls.filter(c=>/\.(fence|isolate|restore|release-absence)$/.test(c.op));
