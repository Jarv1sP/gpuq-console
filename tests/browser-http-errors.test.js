import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoClient} from '../dist/client.js';

const temporary='服务暂时不可用，稍后重试';
test('browser transport retains non-JSON gateway statuses without parsing errors or replaying writes',async()=>{
  const original=globalThis.fetch;
  try{
    for(const status of [502,503,504])for(const body of ['<html>private proxy diagnostic</html>','']){
      let sent=0;globalThis.fetch=async()=>{sent++;return new Response(body,{status});};
      const client=new DemoClient();client.remote=true;
      await assert.rejects(client.call('jobs.submit',{key:'fixed'}),error=>error.status===status&&error.message===temporary&&error.code===undefined);
      assert.equal(sent,1,'gateway failures never replay submissions');
    }
  }finally{globalThis.fetch=original;}
});
test('browser transport preserves explicit rejection reason and known codes, but not arbitrary codes',async()=>{
  const original=globalThis.fetch;
  try{
    for(const code of ['MAINTENANCE_ACTIVE','SUBMISSION_REJECTED','LAST_COPY_UNPROVEN','DATASET_REMOVAL_PENDING','DATASET_DELETE_UNSUPPORTED','UNTRUSTED']){
      globalThis.fetch=async()=>new Response(JSON.stringify({error:'明确拒绝 <script>plain text</script>',code}),{status:503});
      const client=new DemoClient();client.remote=true;
      await assert.rejects(client.call('jobs.submit',{}),error=>error.status===503&&error.message==='明确拒绝 <script>plain text</script>'&&error.code===(code==='UNTRUSTED'?undefined:code));
    }
  }finally{globalThis.fetch=original;}
});
test('malformed successful receipts remain unconfirmed and structured server errors retain their reason',async()=>{
  const original=globalThis.fetch;
  try{
    const client=new DemoClient();client.remote=true;
    globalThis.fetch=async()=>new Response('<html>broken success</html>');
    await assert.rejects(client.call('jobs.submit',{}),error=>error.status===200&&/无法确认/.test(error.message)&&!error.code);
    globalThis.fetch=async()=>new Response(JSON.stringify({error:'节点操作结果未确认'}),{status:503});
    await assert.rejects(client.call('terminal.exchange',{}),error=>error.status===503&&error.message==='节点操作结果未确认'&&!error.code);
  }finally{globalThis.fetch=original;}
});
