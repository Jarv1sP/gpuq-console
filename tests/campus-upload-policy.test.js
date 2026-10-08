import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCall} from '../execution.mjs';
import {putWorkspaceData} from '../client-data-upload.mjs';
const id='12345678-1234-4234-8234-123456789012';
const description={available:true,protocol:'dataset-upload-v1',machine:'gpu-1',revision:'a'.repeat(64),certificateSha256:'b'.repeat(64),routes:[
  {id:'primary',kind:'campus-direct',endpoint:'https://campus.example'},
  {id:'tail',kind:'tail-upload',endpoint:'https://tail.example'},
  {id:'campus-alt',kind:'campus-direct',endpoint:'https://campus-alt.example'}]};
function fixture(){
  const user={id:'demo-user-1',username:'member',enabled:true,limits:{'gpu-1':1}},calls=[];
  const service={store:{get:()=>user},audit(){},bridge:async(machine,operation,args)=>{
    calls.push({machine,operation,args});
    if(operation.endsWith('.routes'))return description;
    if(operation.endsWith('.direct-ticket'))return {available:true,kind:args.routeId==='tail'?'tail-upload':'campus-direct',machine,uploadId:id};
    return {state:'UPLOADING',uploadId:id,manifestOffset:7,uploadTransport:{directAvailable:true,relayAllowed:true,relayLimitBytes:268435456}};
  }};
  return {user,calls,service,call:(action,args)=>executionCall(service,{userId:user.id,username:user.username,role:'member'},'datasets.upload.'+action,{machine:'gpu-1',...args})};
}
test('legacy byte RPCs and relay consent reject before bridge, including zero-byte blocks',async()=>{
  const f=fixture();
  for(const [action,args] of [['manifest',{uploadId:id,offset:0,data:''}],['chunk',{uploadId:id,path:'a',offset:7,data:'eA=='}],['begin',{key:id,name:'mine',manifestBytes:8,manifestSha256:'a'.repeat(64),totalBytes:1,entries:1,allowRelay:true}]])
    await assert.rejects(f.call(action,args),e=>e.status===409&&e.code==='CAMPUS_DATA_PLANE_REQUIRED');
  assert.equal(f.calls.length,0);
});
test('authenticated route projection filters old Tail config without modifying the descriptor',async()=>{
  const f=fixture(),before=structuredClone(description),value=await f.call('routes',{});
  assert.deepEqual(value.routes.map(row=>row.id),['primary','campus-alt']);assert.equal(value.campusOnly,true);
  assert.deepEqual(description,before);assert.equal('ticket' in value,false);assert.equal(value.revision,before.revision);
  assert.deepEqual(f.calls[0].args,{userId:'demo-user-1',hostAdmin:false});
});
test('legacy Tail tickets cannot cross the Portal boundary, campus tickets retain the original UUID',async()=>{
  const f=fixture();await assert.rejects(f.call('direct-ticket',{uploadId:id,routeId:'tail'}),e=>e.status===502);
  const value=await f.call('direct-ticket',{uploadId:id,routeId:'primary'});
  assert.equal(value.kind,'campus-direct');assert.equal(value.uploadId,id);assert.ok(f.calls.every(row=>row.args.uploadId===id));
});
test('warehouse route and ticket projection validates the trusted physical writer, not the training selection',async()=>{
  const f=fixture(),storageMachine='gpu-4';
  f.service.datasetUploadIngress=async(principal,action)=>({...description,machine:storageMachine,storageMachine,
    ...(action==='direct-ticket'?{kind:'campus-direct',uploadId:id}:{})});
  const routes=await f.call('routes',{uploadId:id});assert.equal(routes.machine,storageMachine);
  assert.deepEqual(routes.routes.map(row=>row.id),['primary','campus-alt']);
  assert.equal((await f.call('direct-ticket',{uploadId:id})).machine,storageMachine);assert.equal(f.calls.length,0);
  f.service.datasetUploadIngress=async()=>({...description,storageMachine});
  await assert.rejects(f.call('routes',{uploadId:id}),e=>e.status===502);
});
test('filtering Tail never hides an unsafe or corrupt authenticated descriptor',async()=>{
  const f=fixture();
  for(const change of [{endpoint:'https://user:secret@tail.example'},{kind:'unknown'},{id:'primary'}]){
    const value=structuredClone(description);Object.assign(value.routes[1],change);
    f.service.bridge=async()=>value;await assert.rejects(f.call('routes',{}),e=>e.status===502);
  }
  assert.equal(f.calls.length,0);
});
test('begin projection cannot revive old relay consent and leaves the same offset and UUID',async()=>{
  const f=fixture(),value=await f.call('begin',{key:id,name:'mine',manifestBytes:8,manifestSha256:'a'.repeat(64),totalBytes:1,entries:1});
  assert.deepEqual(value.uploadTransport,{directAvailable:true,relayAllowed:false,relayLimitBytes:0,campusOnly:true});
  assert.equal(value.uploadId,id);assert.equal(value.manifestOffset,7);assert.equal(f.calls[0].args.key,id);
});
test('new policy never weakens account, machine or exact-field validation',async()=>{
  const f=fixture();
  await assert.rejects(f.call('chunk',{uploadId:id,path:'../a',offset:0,data:''}),e=>e.status===400);
  await assert.rejects(f.call('direct-ticket',{uploadId:id,endpoint:'https://untrusted.example'}),e=>e.status===400);
  f.user.limits['gpu-1']=0;await assert.rejects(f.call('chunk',{uploadId:id,path:'a',offset:0,data:''}),e=>e.status===403);
  f.user.limits['gpu-1']=1;f.user.enabled=false;await assert.rejects(f.call('routes',{}),e=>e.status===403);
  assert.equal(f.calls.length,0);
});
test('workspace put never reads even one local byte or calls a control endpoint',async()=>{
  for(const via of ['auto','direct','campus','relay','tail']){
    const calls=[];await assert.rejects(putWorkspaceData(()=>calls.push('rpc'),'gpu-1','unused.bin','incoming/a',true,{
      via,lstat:()=>calls.push('stat'),open:()=>calls.push('open')
    }),/no verified campus data plane/);assert.deepEqual(calls,[]);
  }
});
