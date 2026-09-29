import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const ID='11111111-2222-4333-8444-555555555555';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-host-cli-')),file=join(dir,'session.json'),calls=[];
  const state={demo:false,gpuqConnected:true,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[],
    gpuq:{stale:false,hosts:['gpu-1','gpu-2'].map(id=>({id,reachable:true,hostCommand:{version:1,available:true}}))}};
  const handlers=new Map();
  const completed={id:ID,state:'SUCCEEDED',stdout:'ok\n',stderr:'',exitCode:0,signal:null,truncated:{stdout:false,stderr:false}};
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});
      if(operation==='state'){res.end(JSON.stringify({state}));return;}
      const result=handlers.has(operation)?await handlers.get(operation)(args):{...completed,id:args.key||args.id||ID};
      res.end(JSON.stringify({result}));
    }catch(error){res.statusCode=503;res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  const save=extra=>writeFile(file,JSON.stringify({url,token:'test-token',principal:{userId:'builtin-admin',username:'admin',role:'admin'},machine:'gpu-1',...extra}),{mode:0o600});
  await save({});
  const cli=(args,{json=true}={})=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',file,...(json?['--json']:[]),...args]);
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr,data:json&&stdout?JSON.parse(stdout).data:null}));child.stdin.end();
  });
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {state,calls,handlers,completed,cli,save};
}

test('host exec is non-TTY, argv-exact, server-selected and separate from project terminals',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'private-project'}});
  const argv=['printf','literal;$(command) * "quoted"','--json'];
  const result=await f.cli(['exec','--key',ID,'--cwd','/root/a folder','--timeout','20','--',...argv]);
  assert.equal(result.code,0,result.stderr);assert.equal(result.data.stdout,'ok\n');
  assert.deepEqual(f.calls.at(-1),{operation:'host.exec',args:{machine:'gpu-1',key:ID,argv,timeoutSec:20,cwd:'/root/a folder'}});
  assert.equal(f.calls.some(c=>c.operation.startsWith('terminal.')||c.operation.startsWith('jobs.')),false);
  assert.equal((await f.cli(['exec','2','--','bash','-lc','printf x; printf y >&2'])).data.machine,'gpu-2');
  assert.deepEqual(f.calls.at(-1).args.argv,['bash','-lc','printf x; printf y >&2']);
});

test('host exec defaults to polling but detach returns its handle immediately',async t=>{
  const f=await fixture(t);
  f.handlers.set('host.exec',args=>({...f.completed,id:args.key,state:'RUNNING',exitCode:null,stdout:''}));
  const result=await f.cli(['exec','--key',ID,'--','id']);
  assert.equal(result.code,0,result.stderr);assert.equal(f.calls.filter(c=>c.operation==='host.status').length,1);
  f.calls.length=0;
  const detached=await f.cli(['exec','--detach','--key',ID,'--','sleep','60']);
  assert.equal(detached.code,0,detached.stderr);assert.equal(detached.data.id,ID);assert.equal(detached.data.state,'RUNNING');
  assert.equal(f.calls.some(c=>c.operation==='host.status'),false);
});

test('uninstalled or unverified host commands fail clearly before submission but do not block status/cancel',async t=>{
  const f=await fixture(t);
  for(const gpuq of [undefined,{stale:true,hosts:[]},{stale:false,hosts:[{id:'gpu-1',reachable:true}]}]){
    f.state.gpuq=gpuq;const response=await f.cli(['exec','--','id']);assert.equal(response.code,1);assert.match(response.stderr,/未提交命令/);
    assert.doesNotMatch(response.stderr,/state is unconfirmed/);
  }
  assert.equal(f.calls.some(c=>c.operation==='host.exec'),false);
  assert.equal((await f.cli(['exec','status',ID])).code,0);
  assert.equal((await f.cli(['exec','cancel',ID])).code,0);
  assert.equal(f.calls.filter(c=>c.operation==='host.status').length,1);assert.equal(f.calls.filter(c=>c.operation==='host.cancel').length,1);
});

test('stdout/stderr remain separate and CLI returns actual command exit code',async t=>{
  const f=await fixture(t);
  f.handlers.set('host.exec',()=>({...f.completed,state:'FAILED',exitCode:7,stdout:'out\n',stderr:'err\n'}));
  const result=await f.cli(['exec','--','false']);assert.equal(result.code,7);assert.equal(result.data.exitCode,7);
  assert.equal(result.data.stdout,'out\n');assert.equal(result.data.stderr,'err\n');
  const text=await f.cli(['exec','--','false'],{json:false});assert.equal(text.stdout,'out\n');assert.match(text.stderr,/err\n/);assert.match(text.stderr,/exit 7/);
  f.handlers.set('host.exec',()=>({...f.completed,state:'TIMED_OUT',exitCode:null,signal:15,timedOut:true}));
  assert.equal((await f.cli(['exec','--','sleep','90'])).code,124);
});

test('poll/cancel targets only explicit selected host and UNKNOWN is not retried',async t=>{
  const f=await fixture(t);
  f.handlers.set('host.status',()=>({...f.completed,state:'UNKNOWN',exitCode:null,error:'unconfirmed'}));
  const result=await f.cli(['exec','status',ID,'--machine','2']);assert.equal(result.code,3);assert.equal(result.data.state,'UNKNOWN');
  assert.deepEqual(f.calls.at(-1),{operation:'host.status',args:{machine:'gpu-2',id:ID}});
  f.handlers.set('host.cancel',()=>({...f.completed,state:'CANCELED',exitCode:null,cancelRequested:true}));
  assert.equal((await f.cli(['exec','cancel',ID])).code,130);
  assert.deepEqual(f.calls.at(-1),{operation:'host.cancel',args:{machine:'gpu-1',id:ID}});
  f.calls.length=0;f.handlers.set('host.exec',()=>{throw Error('node connection timeout');});
  const uncertain=await f.cli(['exec','--key',ID,'--','id']);assert.equal(uncertain.code,1);
  assert.match(uncertain.stderr,/not canceled/);assert.match(uncertain.stderr,/SAME --key/);
  assert.equal(f.calls.filter(c=>c.operation==='host.exec').length,1);
  assert.equal(f.calls.some(c=>c.operation==='host.cancel'),false);
});

test('missing target/member/ambiguous or malformed host options fail before execution',async t=>{
  const f=await fixture(t);await f.save({machine:null});
  assert.equal((await f.cli(['exec','--','id'])).code,1);
  f.state.machines=[{id:'gpu-1'}];assert.equal((await f.cli(['exec','--','id'])).code,1);
  await f.save({principal:{role:'member',userId:'demo-user-1',username:'member'}});
  assert.equal((await f.cli(['exec','--','id'])).code,1);
  await f.save({});
  for(const args of [
    ['exec','auto','--','id'], ['exec','--project','x','--','id'],
    ['exec','--timeout','0','--','id'], ['exec','--timeout','abc','--','id'],
    ['exec','--timeout','1','--timeout','2','--','id'], ['exec','--cwd','relative','--','id'],
    ['exec','--detach','--detach','--','id'], ['exec','--key','bad','--','id'],
    ['exec','gpu-1','--machine','gpu-1','--','id'], ['exec','--machine','gpu-1','--machine','gpu-1','--','id'],
    ['exec','status',ID,'--timeout','1'], ['exec','status',ID,'--','id'],
  ])assert.equal((await f.cli(args)).code,1,args.join(' '));
  assert.equal(f.calls.some(c=>c.operation.startsWith('host.')),false);
});

test('priority submission/change and human jobs surface scheduler information',async t=>{
  const f=await fixture(t);
  f.handlers.set('jobs.submit',args=>({id:ID,machine:args.machine,cards:args.cards,priority:args.priority,state:'PENDING'}));
  f.handlers.set('jobs.priority',args=>({id:args.jobId,priority:args.priority}));
  const result=await f.cli(['run','--priority','idle','--key',ID,'--','python','train.py']);
  assert.equal(result.code,0,result.stderr);assert.equal(f.calls.at(-1).args.priority,'idle');
  assert.equal((await f.cli(['priority',ID,'high'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'jobs.priority',args:{jobId:ID,priority:'high'}});
  for(const args of [['run','--priority','invalid','--','true'],['run','--priority','idle','--priority','high','--','true'],['priority',ID,'invalid'],['state','--priority','high']])assert.equal((await f.cli(args)).code,1);
  f.state.jobs=[{id:ID,state:'PENDING',machine:'gpu-1',cards:1,name:'train',priority:'idle',schedulerState:'QUEUED',queueReason:'waiting-for-free-gpu'},
    {id:'other',state:'CANCELED',machine:'gpu-1',cards:1,name:'old',priority:'idle',preempted:true}];
  const jobs=await f.cli(['jobs'],{json:false});assert.equal(jobs.code,0);assert.match(jobs.stdout,/优先级 idle/);assert.match(jobs.stdout,/QUEUED/);assert.match(jobs.stdout,/waiting-for-free-gpu/);assert.match(jobs.stdout,/让位中断/);
});
