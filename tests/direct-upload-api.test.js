import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCall} from '../execution.mjs';

const uploadId='12345678-1234-4234-8234-123456789012';
function fixture(){
  const calls=[],audits=[];
  const user={id:'demo-user-1',username:'member',enabled:true,limits:{'gpu-1':1}};
  const service={store:{get:()=>user},audit:(...args)=>audits.push(args),bridge:async(...args)=>{
    calls.push(args);return {available:false,protocol:'dataset-upload-v1',reason:'not-configured',relayLimitBytes:268435456};
  }};
  const principal={userId:user.id,username:user.username,role:'member'};
  return {user,calls,audits,call:(action,args)=>executionCall(service,principal,'datasets.upload.'+action,args)};
}
test('direct ticket and revoke use authenticated personal identity and existing machine grant',async()=>{
  const f=fixture();
  for(const action of ['direct-ticket','direct-revoke']){
    await f.call(action,{machine:'gpu-1',uploadId});
    assert.deepEqual(f.calls.at(-1),['gpu-1','datasets.upload.'+action,{uploadId,userId:'demo-user-1',hostAdmin:false}]);
  }
  assert.equal(f.audits.length,2);
  for(const args of [{machine:'gpu-2',uploadId},{machine:'gpu-1',uploadId,userId:'other'},
    {machine:'gpu-1',uploadId,hostAdmin:true},{machine:'gpu-1',uploadId,endpoint:'https://evil'},
    {machine:'gpu-1',uploadId,expiresAt:99999999999}]){
    await assert.rejects(f.call('direct-ticket',args));
  }
  assert.equal(f.calls.length,2);
  f.user.enabled=false;
  await assert.rejects(f.call('direct-ticket',{machine:'gpu-1',uploadId}),/暂停/);
});
test('relay override is only an explicit boolean on authenticated begin',async()=>{
  const f=fixture();
  const args={machine:'gpu-1',key:uploadId,name:'sample',manifestBytes:200,manifestSha256:'a'.repeat(64),totalBytes:300*1024**2,entries:1};
  for(const allowRelay of [undefined,false,true]){
    await f.call('begin',{...args,...(allowRelay===undefined?{}:{allowRelay})});
    assert.equal(f.calls.at(-1)[2].allowRelay,allowRelay);
  }
  for(const allowRelay of ['true',1,null])await assert.rejects(f.call('begin',{...args,allowRelay}));
  assert.equal(f.calls.length,3);
});
