import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetFilesCall} from '../dataset-files.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id,version='a'.repeat(64),principal={userId:'demo-user-1',role:'member'};
const args={dataset:'sample',version};
function fixture(){
  const user={id:principal.userId,username:'alice',role:'member',enabled:true,limits:{[machine]:1}},calls=[];
  const f={user,calls,owners:[user.id],capability:1,state:'READY',entries:[{name:'data.txt',path:'data.txt',type:'file',bytes:12}],nextCursor:null};
  f.service={store:{users:[user,{id:'demo-user-2',username:'bob'}],get:id=>id===user.id?structuredClone(user):null},bridge:async(node,operation,request)=>{
    calls.push({machine:node,operation,args:request});
    if(operation==='datasets.list'){
      assert.deepEqual(request,{userId:'builtin-admin',hostAdmin:true});
      return {datasets:node===machine?[{dataset:'sample',ownerIds:f.owners,versions:[{version,state:f.state,...(f.warehouseReady===undefined?{}:{warehouseReady:f.warehouseReady}),bytes:12,files:1}]}]:[]};
    }
    assert.equal(node,machine);assert.equal(request.userId,user.id);assert.equal(request.hostAdmin,false);
    if(operation==='datasets.capacity')return {datasetFileList:f.capability};
    assert.equal(operation,'datasets.files.list');assert.equal(request.dataset,'sample');assert.equal(request.version,version);
    return {protocol:'dataset-files-list-v1',available:true,machine:node,dataset:'sample',version,path:request.path,entries:f.entries,nextCursor:f.nextCursor,...f.override};
  }};
  f.call=(request=args,who=principal)=>datasetFilesCall(f.service,who,request);
  return f;
}

test('owned fixed version lists only bounded metadata with member identity and no mutation',async()=>{
  const f=fixture();const value=await f.call();
  assert.deepEqual(value,{protocol:'dataset-files-list-v1',available:true,dataset:'sample',version,path:'',entries:f.entries,nextCursor:null});
  assert.equal(f.calls.filter(row=>row.operation==='datasets.files.list').length,1);
  assert.ok(f.calls.every(row=>['datasets.list','datasets.capacity','datasets.files.list'].includes(row.operation)));
  assert.doesNotMatch(JSON.stringify(value),/userId|ownerIds|machine|hostAdmin/);
  f.service.db={prepare:sql=>{assert.match(sql,/^SELECT/);return {get:()=>null};}};
  await f.call(args,{...principal,role:'admin'});
});

test('metadata visibility and administrator role do not grant foreign content or zero-quota cache reads',async()=>{
  for(const role of ['member','admin']){
    const f=fixture();f.owners=['demo-user-2'];
    await assert.rejects(f.call(args,{...principal,role}),error=>error.status===403);
    assert.ok(f.calls.every(row=>row.operation==='datasets.list'));
  }
  const f=fixture();f.user.limits={};
  await assert.rejects(f.call(),error=>error.status===403);
  assert.ok(f.calls.every(row=>row.operation==='datasets.list'));
});

test('warehouse source authorization still requires the exact owned READY original',async()=>{
  const f=fixture();f.user.limits={};f.service.archiveSourceAllowed=(owner,node,ref)=>owner===f.user.id&&node===machine&&ref.dataset==='sample'&&ref.version===version;f.warehouseReady=true;f.state='REGISTERED';
  assert.equal((await f.call()).available,true);
  f.warehouseReady=false;
  await assert.rejects(f.call(),error=>error.status===403||error.code==='DATASET_FILES_SOURCE_UNCONFIRMED');
});

test('unknown node capability is explicitly unavailable, never an empty listing or bare old-node read',async()=>{
  const f=fixture();f.capability=undefined;
  const value=await f.call();assert.deepEqual(value,{protocol:'dataset-files-list-v1',available:false,dataset:'sample',version,path:'',reason:'DATASET_FILES_NODE_UNAVAILABLE'});
  assert.equal(value.entries,undefined);assert.ok(f.calls.every(row=>row.operation!=='datasets.files.list'));
  const original=f.service.bridge;f.service.bridge=(node,op,a)=>op==='datasets.capacity'?Promise.reject(Error('private /host path')):original(node,op,a);
  assert.deepEqual(await f.call(),value);
});

test('invalid fixed identity, traversal, owner injection and disabled accounts reject before I/O',async()=>{
  const f=fixture();
  for(const request of [null,[],{}, {...args,dataset:123},{...args,version:'latest'}, {...args,path:null}, {...args,path:'/data'}, {...args,path:'a/../b'}, {...args,path:'a\\b'}, {...args,path:'a\u0000b'}, {...args,path:'a//b'}, {...args,path:'x'.repeat(4097)}, {...args,path:'\uD800'}, {...args,hostAdmin:true}, {...args,machine}, {...args,userId:'demo-user-2'}, {...args,cursor:''}])
    await assert.rejects(f.call(request),error=>error.status===400);
  await assert.rejects(f.call(args,null),error=>error.status===403);
  f.user.enabled=false;await assert.rejects(f.call(),error=>error.status===403);
  assert.equal(f.calls.length,0);
});

test('pagination is bound to original actor, version, relative directory and exact physical source',async()=>{
  const f=fixture();f.nextCursor='opaque-fixed-node-cursor';
  const first=await f.call();assert.ok(first.nextCursor);assert.doesNotMatch(first.nextCursor,/demo-user/);
  f.nextCursor=null;await f.call({...args,cursor:first.nextCursor});
  assert.equal(f.calls.at(-1).args.cursor,'opaque-fixed-node-cursor');
  for(const request of [{...args,path:'other',cursor:first.nextCursor},{...args,version:'b'.repeat(64),cursor:first.nextCursor},{...args,cursor:first.nextCursor+'='},{...args,cursor:'not-json'}])
    await assert.rejects(f.call(request),error=>error.status===400);
  f.state='REGISTERED';
  await assert.rejects(f.call({...args,cursor:first.nextCursor}),error=>error.code==='DATASET_FILES_SOURCE_UNCONFIRMED');
  assert.equal(f.calls.filter(row=>row.operation==='datasets.files.list').length,2);
});

test('unconfirmed reads never replay, replace sources or disclose raw errors',async()=>{
  const f=fixture(),bridge=f.service.bridge;let reads=0;
  f.service.bridge=(node,operation,request)=>operation==='datasets.files.list'?(reads++,Promise.reject(Error('private /root/token'))):bridge(node,operation,request);
  await assert.rejects(f.call(),error=>error.status===503&&error.code==='DATASET_FILES_UNCONFIRMED'&&!/private|token|root/.test(error.message));
  assert.equal(reads,1);
});

test('malformed node replies fail closed with response and entry byte bounds',async()=>{
  const f=fixture();
  for(const override of [{version:'b'.repeat(64)},{machine:MACHINES[1].id},{dataset:'other'},{path:'other'},{protocol:'old'},{available:false},{entries:Array.from({length:201},(_,i)=>({name:String(i),path:String(i),type:'file',bytes:1}))},{entries:[{name:'link',path:'link',type:'symlink',bytes:null}]},{entries:[{name:'bad',path:'../bad',type:'file',bytes:1}]},{entries:[{name:'dir',path:'dir',type:'directory',bytes:0}]},{entries:[{name:'a',path:'a',type:'file',bytes:1},{name:'a',path:'a',type:'file',bytes:1}]},{entries:[],nextCursor:'nonempty'},{entries:[{name:'a',path:'a',type:'file',bytes:Number.MAX_SAFE_INTEGER+1}]}]){
    f.override=override;await assert.rejects(f.call(),error=>error.status===502);
  }
  f.override={entries:Array.from({length:20},(_,i)=>{const name=String(i)+'x'.repeat(4000);return {name,path:name,type:'file',bytes:1};})};
  await assert.rejects(f.call(),error=>error.status===502);
});

test('revocation during either capacity or listing drops the complete result',async()=>{
  for(const target of ['datasets.capacity','datasets.files.list']){
    const f=fixture(),bridge=f.service.bridge;
    f.service.bridge=async(...request)=>{const value=await bridge(...request);if(request[1]===target)f.user.enabled=false;return value;};
    await assert.rejects(f.call(),error=>error.status===403);
  }
});
