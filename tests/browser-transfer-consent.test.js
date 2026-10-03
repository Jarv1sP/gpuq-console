import test from 'node:test';
import assert from 'node:assert/strict';
import {transferUploadCall} from '../dist/transfer-upload.js';
test('browser transfer wrapper forwards explicit relay consent outside the manifest',async()=>{
  const calls=[],call=transferUploadCall(async(operation,args)=>{calls.push({operation,args});return {id:'T1',uploadId:'u1',state:'WAITING_CLIENT',result:{uploadId:'u1',state:'UPLOADING'}};});
  const args={machine:'gpu-1',name:'fixture',key:'key',manifestBytes:100,manifestSha256:'a'.repeat(64),totalBytes:1024,entries:1};
  await call('datasets.upload.begin',{...args,allowRelay:true});
  assert.equal(calls[0].args.allowRelay,true);assert.equal('allowRelay' in calls[0].args.manifest,false);
  for(const allowRelay of [undefined,false,'true',1]){await call('datasets.upload.begin',{...args,allowRelay});assert.equal('allowRelay' in calls.at(-1).args,false);assert.equal('allowRelay' in calls.at(-1).args.manifest,false);}
});
