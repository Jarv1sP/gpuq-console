import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {buildClient} from '../scripts/build-client.mjs';

test('standalone downloaded CLI sends canonical scheduling and preserves argv after --',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-policy-cli-')),file=join(dir,'gpuctl.mjs'),session=join(dir,'session.json'),calls=[];
  await buildClient({outfile:file});
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);calls.push(data);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data.operation==='state'?{state:{machines:[{id:'gpu-1'}],jobs:[]}}:{result:{id:'job',state:'PENDING'}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(session,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'test-only',machine:'gpu-1',principal:{role:'member',username:'alice',userId:'alice'}}));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const run=args=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[file,'--session-file',session,'--json',...args]);let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));});
  const key=randomUUID(),args=['run','--rank','P1','--yield','save','--checkpointable','--restart-policy','on-preempt','--key',key,'--','python','train.py','--rank','123'];
  assert.equal((await run(args)).code,0);
  const submit=calls.find(x=>x.operation==='jobs.submit').args;
  assert.deepEqual(submit.scheduling,{rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true});
  assert.equal(submit.key,key);assert.equal(Object.hasOwn(submit,'priority'),false);
  assert.deepEqual(submit.argv,['python','train.py','--rank','123']);
  assert.equal((await run(args)).code,0);assert.equal(calls.filter(x=>x.operation==='jobs.submit').at(-1).args.key,key);
  const elasticArgs=['run','-g','8','--min-cards','1','--global-batch','256','--micro-batch','8','--auto-expand','--rank','P1','--yield','save','--checkpointable','--restart-policy','on-preempt','--mode','preempt1','--','python','train.py','--auto-expand'];
  assert.equal((await run(elasticArgs)).code,0);
  const elasticSubmit=calls.filter(x=>x.operation==='jobs.submit').at(-1).args;
  assert.deepEqual(elasticSubmit.elastic,{minCards:1,globalBatch:256,microBatch:8,autoExpand:true});
  assert.equal(elasticSubmit.scheduling.mode,'preempt-save');
  assert.deepEqual(elasticSubmit.argv,['python','train.py','--auto-expand']);
  assert.equal((await run(['run','--gpu','2,0','--','python','train.py'])).code,0);
  let selected=calls.filter(x=>x.operation==='jobs.submit').at(-1).args;
  assert.equal(selected.cards,2);assert.deepEqual(selected.placement,{gpuIndices:[0,2],shared:false});
  assert.equal((await run(['run','--gpu','3','--share','--vram-mib','4096','--hami','--sm-percent','50','--','python','small.py'])).code,0);
  selected=calls.filter(x=>x.operation==='jobs.submit').at(-1).args;
  assert.equal(selected.cards,1);assert.deepEqual(selected.placement,{gpuIndices:[3],shared:true,vramMiB:4096,hami:true,smPercent:50});
  for(const [mode,canonical] of [['queue',null],['preempt1','preempt-save'],['preempt2','preempt-now'],['preempt-save','preempt-save'],['preempt-now','preempt-now']]){
    assert.equal((await run(['run','--mode',mode,'--','python','urgent.py','--mode','literal-training-arg'])).code,0,mode);
    const request=calls.filter(x=>x.operation==='jobs.submit').at(-1).args;
    assert.deepEqual(request.argv,['python','urgent.py','--mode','literal-training-arg']);
    if(canonical)assert.equal(request.scheduling.mode,canonical);else assert.equal(Object.hasOwn(request.scheduling,'mode'),false);
  }
  const count=calls.length;
  for(const invalid of [['jobs','--gpu','3'],['jobs','--hami'],['jobs','--auto-expand'],['jobs','--min-cards','1'],['jobs','--rank','P1'],['run','--yield','save','--','python'],['run','--yield','now','--restart-policy','on-preempt','--','python'],['run','--rank','P1','--priority','idle','--','python'],['run','--mode','bad','--','python'],['jobs','--mode','queue']])assert.notEqual((await run(invalid)).code,0);
  assert.equal(calls.length,count,'invalid options fail before any request');
});
