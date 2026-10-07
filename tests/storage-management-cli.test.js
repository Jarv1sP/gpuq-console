import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const VERSION='a'.repeat(64),cliPath=fileURLToPath(new URL('../cli.mjs',import.meta.url));
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-storage-cli-')),session=join(dir,'session'),calls=[];
  let role='admin',failure=null,response={enabled:false,dryRun:true,candidates:[]};
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});res.setHeader('Content-Type','application/json');
    if(operation==='state')return res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[]}}));
    if(failure){res.statusCode=400;return res.end(JSON.stringify({error:failure}));}
    res.end(JSON.stringify({result:response}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  const save=()=>writeFile(session,JSON.stringify({url,token:'fixture-only',principal:{userId:role==='admin'?'builtin-admin':'demo-user-1',role},machine:'gpu-1'}));
  await save();
  const cli=(args,json=true)=>new Promise((resolve,reject)=>{
    const process=spawn(globalThis.process.execPath,[cliPath,'--url',url,'--session-file',session,...(json?['--json']:[]),...args]);
    let stdout='',stderr='';process.stdout.on('data',s=>stdout+=s);process.stderr.on('data',s=>stderr+=s);process.on('error',reject);
    process.on('close',code=>resolve({code,stdout,stderr,data:json&&stdout?JSON.parse(stdout).data:null}));process.stdin.end();
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {cli,calls,setRole:async value=>{role=value;await save();},respond:value=>response=value,fail:value=>failure=value};
}

test('storage CLI maps default status full status and plan while preserving JSON envelopes',async t=>{
  const f=await fixture(t);
  for(const [args,operation,request] of [
    [['data','storage'],'datasets.storage.status',{machine:'gpu-1'}],
    [['data','storage','status','sample@'+VERSION,'--machine','gpu-2'],'datasets.storage.status',{machine:'gpu-2',dataset:'sample',version:VERSION}],
    [['data','storage','plan'],'datasets.storage.plan',{machine:'gpu-1'}]]){
    const result=await f.cli(args);assert.equal(result.code,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).ok,true);assert.deepEqual(result.data,{enabled:false,dryRun:true,candidates:[],machine:request.machine});
    assert.deepEqual(f.calls.at(-1),{operation,args:request});
  }
});

test('storage CLI maps manual pin and unpin without user role identity or host paths',async t=>{
  const f=await fixture(t);
  for(const action of ['pin','unpin']){
    f.respond(action==='pin'?{pinned:true,pinId:'manual-job'}:{unpinned:true});
    const result=await f.cli(['data','storage',action,'sample@'+VERSION,'manual-job','--machine','gpu-2']);
    assert.equal(result.code,0,result.stderr);
    assert.deepEqual(f.calls.at(-1),{operation:'datasets.storage.'+action,args:{machine:'gpu-2',dataset:'sample',version:VERSION,pinId:'manual-job'}});
  }
});

test('storage CLI rejects members before management requests',async t=>{
  const f=await fixture(t);await f.setRole('member');
  for(const args of [['status'],['plan'],['pin','sample@'+VERSION,'p'],['unpin','sample@'+VERSION,'p']]){
    const result=await f.cli(['data','storage',...args]);assert.equal(result.code,1);assert.match(result.stderr,/administrator/);
  }
  assert.ok(f.calls.every(c=>c.operation==='state'));
});

test('members can request archive retry only for a fixed version on an authorized selected machine',async t=>{
  const f=await fixture(t);await f.setRole('member');f.respond({phase:'PROVISIONING'});
  const result=await f.cli(['data','archive-retry','mine@'+VERSION]);assert.equal(result.code,0,result.stderr);
  assert.deepEqual(f.calls.at(-1),{operation:'datasets.archive.retry',args:{machine:'gpu-1',dataset:'mine',version:VERSION}});
  for(const args of [['mine'],['mine@latest'],['mine@'+VERSION,'--root'],['mine@'+VERSION,'--machine','gpu-4']]){
    assert.equal((await f.cli(['data','archive-retry',...args])).code,1);
  }
  assert.equal(f.calls.filter(row=>row.operation==='datasets.archive.retry').length,1);
});

test('storage CLI rejects collection authority pin traversal role proof and unrelated options',async t=>{
  const f=await fixture(t);
  const rejected=[['collect'],['recover'],['enable'],['plan','extra'],['status','sample'],['status','sample@latest'],
    ['status','sample@'+VERSION+'@extra'],['pin','../sample@'+VERSION,'p'],['pin','sample@'+VERSION],
    ['pin','sample@'+VERSION,'authority-pinned'],['unpin','sample@'+VERSION,'authority-pinned'],
    ['unpin','sample@'+VERSION,'../bad'],['status','--root'],['status','--as','other'],
    ['status','--role','admin'],['status','--project','other'],['status','--data','sample@'+VERSION],
    ['status','--proof','{}'],['status','--machine','auto'],['status','--machine','gpu-4'],
    ['status','--machine','gpu-1','--machine','gpu-2'],['status','--','rm','-rf','/data2']];
  for(const args of rejected)assert.equal((await f.cli(['data','storage',...args])).code,1,args.join(' '));
  assert.ok(f.calls.every(c=>c.operation==='state'));
});

test('storage CLI errors do not retry writes or request cleanup and text output remains available',async t=>{
  const f=await fixture(t);f.fail('fixture timeout');
  const error=await f.cli(['data','storage','pin','sample@'+VERSION,'manual-job']);
  assert.equal(error.code,1);assert.match(error.stderr,/timeout/);
  assert.deepEqual(f.calls.filter(c=>c.operation!=='state').map(c=>c.operation),['datasets.storage.pin']);
  f.fail(null);const plain=await f.cli(['data','storage','status'],false);
  assert.equal(plain.code,0,plain.stderr);assert.match(plain.stdout,/enabled/);
  const help=await f.cli(['help','admin'],false);assert.match(help.stdout,/data storage status/);assert.match(help.stdout,/data storage plan/);
  const daily=await f.cli(['--help'],false);assert.doesNotMatch(daily.stdout,/data storage (?:plan|pin|unpin)/);
});
