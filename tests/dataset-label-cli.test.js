import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-label-cli-')),session=join(dir,'session'),calls=[];
  const state={demo:false,machines:[{id:'gpu-1'}],users:[],jobs:[]};let conflict=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});res.setHeader('content-type','application/json');
    if(operation==='state'){res.end(JSON.stringify({state}));return;}
    if(operation==='datasets.label.set'&&conflict){res.writeHead(409);res.end(JSON.stringify({error:'Label revision conflict'}));return;}
    const result={dataset:'logical-id',name:'logical-id',displayName:operation.endsWith('.set')?args.displayName:null,revision:operation.endsWith('.set')?3:2,ownerId:args.ownerId||'u',scope:'personal'};
    res.end(JSON.stringify({result}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  const save=role=>writeFile(session,JSON.stringify({url,token:'test-only',principal:{userId:'u',username:'alice',role},machine:'gpu-1'}));await save('member');
  const run=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--json','--session-file',session,'data','label','physical-id',...args]);let stdout='',stderr='';
    child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();
  });
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  return {run,calls,save,setConflict:()=>conflict=true};
}
test('display label reads current canonical identity then CAS writes one personal name',async t=>{
  const f=await fixture(t);const result=await f.run(['--display-name',' ZJU 人体数据 ']);assert.equal(result.code,0,result.stderr);
  assert.deepEqual(f.calls.slice(-2),[
    {operation:'datasets.label.get',args:{machine:'gpu-1',dataset:'physical-id'}},
    {operation:'datasets.label.set',args:{machine:'gpu-1',dataset:'logical-id',displayName:'ZJU 人体数据',revision:2}},
  ]);
  assert.equal((await f.run([])).code,0);assert.equal(f.calls.at(-1).operation,'datasets.label.get');
});
test('invalid labels, revision mismatch and member owner override never write',async t=>{
  const f=await fixture(t);
  for(const args of [['--display-name','x','--revision','1'],['--display-name','x','--owner-id','other'],['--display-name','a\nb'],['--display-name','x'.repeat(81)],['--revision','2']])assert.equal((await f.run(args)).code,1);
  assert.equal(f.calls.filter(x=>x.operation==='datasets.label.set').length,0);
});
test('administrator owner scope stays explicit and a concurrent conflict is never retried',async t=>{
  const f=await fixture(t);await f.save('admin');f.setConflict();
  const result=await f.run(['--display-name','正式数据','--owner-id','other','--revision','2']);assert.equal(result.code,1);assert.match(result.stderr,/revision conflict/);
  const writes=f.calls.filter(x=>x.operation==='datasets.label.set');assert.equal(writes.length,1);assert.equal(writes[0].args.ownerId,'other');
});
