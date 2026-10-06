import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {MACHINES} from '../dist/model.js';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'deletion-cli-')),file=join(root,'session'),calls=[],id=randomUUID();
  const f={role:'admin',failure:null,response:{operationId:id,key:id,state:'PLANNED'},calls,id};
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const value=JSON.parse(raw);calls.push(value);res.setHeader('Content-Type','application/json');
    if(value.operation==='state'){res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:MACHINES,users:[],jobs:[]}}));return;}
    if(f.failure){res.statusCode=503;res.end(JSON.stringify({error:f.failure}));return;}
    res.end(JSON.stringify({result:f.response}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  f.cli=async args=>{
    await writeFile(file,JSON.stringify({url,token:'local-fixture',machine:MACHINES[0].id,principal:{userId:'builtin-admin',role:f.role}}),{mode:0o600});
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',file,'--json',...args]);
      let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);
      child.on('close',code=>resolve({code,stdout,stderr,data:stdout?JSON.parse(stdout).data:null}));child.stdin.end();
    });
  };
  return f;
}
test('delete prints and sends the same durable key; no machine/owner/path overrides',async t=>{
  const f=await fixture(t),version='a'.repeat(64);
  const r=await f.cli(['data','delete','personal@'+version,'--key',f.id]);assert.equal(r.code,0,r.stderr);assert.match(r.stderr,new RegExp(f.id));
  assert.deepEqual(f.calls.at(-1),{operation:'datasets.delete',args:{dataset:'personal',version,key:f.id}});
  for(const flags of [['--machine',MACHINES[0].id],['--root'],['--as','another'],['--key','invalid']])
    assert.equal((await f.cli(['data','delete','personal@'+version,...flags])).code,1);
  assert.equal(f.calls.filter(c=>c.operation==='datasets.delete').length,1);
});
test('timeout is unconfirmed and suggests only the original key query, no retry/cancel',async t=>{
  const f=await fixture(t);f.failure='node timeout';
  const r=await f.cli(['data','delete','personal@'+'a'.repeat(64),'--key',f.id]);assert.equal(r.code,1);
  assert.match(r.stderr,new RegExp('delete-status '+f.id));assert.equal(f.calls.filter(c=>c.operation==='datasets.delete').length,1);
  assert.ok(f.calls.every(c=>['state','datasets.delete'].includes(c.operation)));
});
test('key and operation queries are exact and preserve UNKNOWN exit code',async t=>{
  const f=await fixture(t);f.response.state='UNKNOWN';
  for(const [action,args] of [['delete-status',{key:f.id}],['retire-status',{operationId:f.id}]]){
    const r=await f.cli(['data',action,f.id]);assert.equal(r.code,3);assert.deepEqual(f.calls.at(-1),{operation:'datasets.delete.status',args});
  }
});
test('restore requires admin and explicit machine, never sends force or an owner',async t=>{
  const f=await fixture(t);f.response={operationId:f.id,state:'RESTORED'};
  const args=['data','retire-restore',f.id,'--machine',MACHINES[0].id];
  const r=await f.cli(args);assert.equal(r.code,0,r.stderr);assert.deepEqual(f.calls.at(-1),{operation:'datasets.delete.restore',args:{operationId:f.id,machine:MACHINES[0].id}});
  for(const value of [args.slice(0,3),[...args,'--root'],[...args,'--key',randomUUID()]])assert.equal((await f.cli(value)).code,1);
  f.role='member';assert.equal((await f.cli(args)).code,1);assert.equal(f.calls.filter(c=>c.operation==='datasets.delete.restore').length,1);
});

test('admin continue and cancel use original task ID once and never accept machine or member override',async t=>{
  const f=await fixture(t);
  for(const action of ['retire-continue','retire-cancel']){
    const op='datasets.delete.'+(action.endsWith('continue')?'continue':'cancel');
    const r=await f.cli(['data',action,f.id]);assert.equal(r.code,0,r.stderr);
    assert.deepEqual(f.calls.at(-1),{operation:op,args:{operationId:f.id}});
    assert.equal((await f.cli(['data',action,f.id,'--machine',MACHINES[0].id])).code,1);
    assert.equal((await f.cli(['data',action,f.id,'--key',randomUUID()])).code,1);
    f.role='member';assert.equal((await f.cli(['data',action,f.id])).code,1);f.role='admin';
    assert.equal(f.calls.filter(c=>c.operation===op).length,1);
  }
  f.failure='unknown result';const r=await f.cli(['data','retire-cancel',f.id]);assert.equal(r.code,1);
  assert.match(r.stderr,new RegExp('retire-status '+f.id));assert.equal(f.calls.filter(c=>c.operation==='datasets.delete.cancel').length,2);
});
