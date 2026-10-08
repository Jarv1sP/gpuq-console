import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCampusNativeAgent,campusNativePersonalFileRequest} from '../client-campus-native.mjs';
import {mockCampusFiles} from './personal-file-campus-mock.mjs';

test('explicit native fixture retains real child framing, pinned HTTPS, raw bytes and stop after a failed write',async t=>{
  const calls=[];let reject=false;
  const campus=await mockCampusFiles(t,async(op,args)=>{calls.push({op,args});if(reject)throw Error('durable-write acknowledgement lost');return {complete:args.final,size:args.offset+Buffer.from(args.data,'base64').length};});
  const grant=await campus.ticket({machine:'node-fixture',project:'demo',path:'file',action:'put'});
  const folder=await mkdtemp(join(tmpdir(),'stargate-campus-'));
  let cleaned=0;
  const agent=createCampusNativeAgent(grant.certificateSha256,{extract:async()=>({path:join(folder,'campus-http'),cleanup:async()=>{cleaned++;await rm(folder,{recursive:true,force:true});}})});
  try{
    assert.deepEqual(await campusNativePersonalFileRequest(grant,agent,'put',{offset:0,final:false,bytes:Buffer.from('hello')}),{complete:false,size:5});
    assert.equal(calls[0].args.data,Buffer.from('hello').toString('base64'));
    reject=true;
    await assert.rejects(campusNativePersonalFileRequest(grant,agent,'put',{offset:5,final:true,bytes:Buffer.alloc(0)}),/FIXTURE_HTTPS_REJECTED/);
    await assert.rejects(campusNativePersonalFileRequest(grant,agent,'put',{offset:5,final:true,bytes:Buffer.alloc(0)}),/SESSION_STOPPED/);
    assert.equal(calls.length,2,'no implicit write replay after rejection');
  }finally{await agent.destroy();}
  assert.equal(cleaned,1);
});
