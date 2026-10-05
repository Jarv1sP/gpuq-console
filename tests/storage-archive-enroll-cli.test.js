import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

test('CLI enrollment sends only fixed owner/ref/key and rejects implicit or privileged options',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'archive-enroll-cli-')),session=join(dir,'session.json'),calls=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const request=JSON.parse(raw);calls.push(request);res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(request.operation==='state'?{state:{demo:false,gpuqConnected:true,machines:[{id:'amax-5090'}],users:[],jobs:[]}}:{result:{phase:'PROVISIONING'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const credential=role=>writeFile(session,JSON.stringify({url,token:'isolated-test-token',principal:{userId:'demo-user-3',username:'admin',role},machine:'amax-5090'}),{mode:0o600});
  await credential('admin');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const run=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,'--json',...args]);
    let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  const version='a'.repeat(64),key=randomUUID(),args=['data','archive-enroll','old-data@'+version,'--machine','amax-5090','--owner-id','demo-user-1','--key',key];
  const result=await run(args);assert.equal(result.code,0,result.stderr);
  assert.deepEqual(calls.filter(c=>c.operation!=='state'),[{operation:'datasets.archive.enroll',args:{machine:'amax-5090',dataset:'old-data',version,ownerId:'demo-user-1',key}}]);
  const count=()=>calls.filter(c=>c.operation==='datasets.archive.enroll').length;
  for(const bad of [args.slice(0,-2),args.filter((_,i)=>![3,4].includes(i)),[...args,'--root'],[...args,'--as','demo-user-2'],[...args,'--project','elsewhere']]){
    const failed=await run(bad);assert.equal(failed.code,1);assert.equal(count(),1);
  }
  await credential('member');assert.equal((await run(args)).code,1);assert.equal(count(),1);
});
