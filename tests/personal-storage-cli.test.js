import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'personal-cli-')),session=join(dir,'session.json'),calls=[],key=randomUUID();
 const state={demo:false,executionEnabled:true,machines:[{id:'gpu-1',cards:8}],jobs:[],users:[]};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});
  const result=operation==='state'?null:operation==='projects.status'?{project:'project',latestReadyRelease:'a'.repeat(64),releases:[{release:'a'.repeat(64),state:'READY'}]}:
   operation==='projects.storage.info'?{protocol:'personal-storage-v1',available:false}:
   operation==='projects.storage.copies'?{protocol:'personal-copies-v1',copies:[]}:
   operation.startsWith('projects.storage.publish')?{state:'PUBLISHING',operationId:args.key}:
   operation==='jobs.submit'?{id:randomUUID(),state:'QUEUED',machine:'gpu-1',cards:1}:
   {protocol:'personal-copy-v1',key:args.key,state:'UNKNOWN'};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(operation==='state'?{state}:{result}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 await writeFile(session,JSON.stringify({url,token:'fixture-only',principal:{userId:'demo-user-1',username:'member',role:'member'},machine:'gpu-1',projectsByMachine:{'gpu-1':'project'}}),{mode:0o600});
 const cli=args=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[new URL('../build/gpuctl.mjs',import.meta.url).pathname,'--url',url,'--session-file',session,'--json',...args]);let stdout='',stderr='';
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();
 });t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});return {cli,calls,key};
}
test('downloaded CLI keeps personal storage copy key, tiers and relative paths without retry',async t=>{
 const f=await fixture(t);const result=await f.cli(['storage','copy','samples','hot','--from','hdd','--to','ssd','--key',f.key]);
 assert.equal(result.code,3,result.stderr);assert.match(result.stderr,new RegExp(f.key));
 assert.deepEqual(f.calls.at(-1),{operation:'projects.storage.copy',args:{machine:'gpu-1',key:f.key,sourceTier:'hdd',targetTier:'ssd',sourcePath:'samples',targetPath:'hot'}});
 assert.equal(f.calls.filter(c=>c.operation==='projects.storage.copy').length,1);
 for(const action of ['copy-status','copy-cancel','copy-resume']){assert.equal((await f.cli(['storage',action,f.key])).code,3);assert.equal(f.calls.at(-1).args.key,f.key);}
 assert.equal((await f.cli(['storage','copies'])).code,0);assert.equal(f.calls.at(-1).operation,'projects.storage.copies');
});
test('downloaded CLI publishes same-node drafts on explicit tier and carries selected workspace mode',async t=>{
 const f=await fixture(t);assert.equal((await f.cli(['storage','publish','processed','--tier','hdd','--name','data','--key',f.key])).code,0);
 assert.deepEqual(f.calls.at(-1),{operation:'projects.storage.publish',args:{machine:'gpu-1',key:f.key,tier:'hdd',name:'data',path:'processed'}});
 assert.equal((await f.cli(['run','--workspace-mode','shared','-g','1','--','python','train.py','--literal','value'])).code,0);
 assert.equal(f.calls.at(-1).args.workspaceMode,'shared');assert.deepEqual(f.calls.at(-1).args.argv,['python','train.py','--literal','value']);
});
test('wrong CLI scope and workspace mode are rejected before a storage mutation',async t=>{
 const f=await fixture(t);
 for(const args of [['jobs','--workspace-mode','shared'],['run','--workspace-mode','auto','--','x'],['storage','info','--from','hdd'],['storage','copies','--root']])assert.equal((await f.cli(args)).code,1);
 assert.equal(f.calls.some(c=>c.operation==='jobs.submit'||c.operation==='projects.storage.copy'),false);
});
