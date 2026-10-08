import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm, stat, rename, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const principal={userId:'demo-user-1',username:'terminal-tester',role:'member'};
const original='11111111-2222-4333-8444-555555555555';
const entry=process.env.TERMINAL_RECOVERY_TEST_CLI||new URL('../cli.mjs',import.meta.url).pathname;

async function fixture(t,{open, drop=false, onState}={}){
  const dir=await mkdtemp(join(tmpdir(),'terminal-open-recovery-'));
  const session=join(dir,'session.json'), marker=join(dir,'raw-mode.jsonl'), preload=join(dir,'tty.mjs');
  const calls=[];let stderr='',atDispatch,loginPrincipal=principal;
  await writeFile(preload,`import {appendFileSync} from 'node:fs';
    Object.defineProperty(process.stdin,'isTTY',{value:true});
    process.stdin.setRawMode=value=>{appendFileSync(${JSON.stringify(marker)},JSON.stringify(value)+'\\n');return process.stdin;};`);
  const server=createServer(async(req,res)=>{
    try{
      let body='';for await(const chunk of req)body+=chunk;
      const {operation,args={}}=JSON.parse(body);
      res.setHeader('Content-Type','application/json');
      const state={demo:false,gpuqConnected:true,machines:[{id:'gpu-1'}],users:[],jobs:[]};
      if(req.url==='/api/login')return res.end(JSON.stringify({token:'test-login-token',principal:loginPrincipal,state}));
      calls.push({operation,args});
      if(operation==='state'){await onState?.(session);return res.end(JSON.stringify({state}));}
      if(operation==='terminal.open'){
        atDispatch={cache:JSON.parse(await readFile(session,'utf8')),stderr};
        if(drop){req.socket.destroy();return;}
        if(open)return res.end(JSON.stringify({result:{clientId:args.clientId,mode:args.mode,hostAdmin:args.hostAdmin,leaseExpiresAt:Date.now()/1000+30,...await open(args)}}));
        res.statusCode=503;return res.end(JSON.stringify({error:'node unavailable'}));
      }
      if(operation==='terminal.exchange')return res.end(JSON.stringify({result:{offset:0,data:'',exited:true}}));
      if(operation==='terminal.close')return res.end(JSON.stringify({result:{closed:true}}));
      throw Error('Unexpected operation: '+operation);
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  await writeFile(session,JSON.stringify({url,token:'test-only',principal,machine:'gpu-1',projectsByMachine:{'gpu-1':'alpha'}}),{mode:0o600});
  const cli=(argv,input='')=>new Promise((resolve,reject)=>{
    stderr='';let stdout='';
    const child=spawn(process.execPath,['--import',preload,entry,'--session-file',session,'--json',...argv]);
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);
  });
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {session,marker,calls,cli,dispatch:()=>atDispatch,setLoginPrincipal:value=>loginPrincipal=value};
}

function errorJSON(result){
  const line=result.stderr.trim().split(/\r?\n/).findLast(value=>value.startsWith('{'));
  assert.ok(line,'JSON errors remain machine-readable on stderr');return JSON.parse(line);
}

for(const {name,argv,scope,command} of [
  {name:'project',argv:['ssh'],scope:{machine:'gpu-1',hostAdmin:false,project:'alpha'},command:'--project alpha'},
  {name:'ROOT',argv:['ssh','--root'],scope:{machine:'gpu-1',hostAdmin:true},command:'--root'},
  {name:'data workspace',argv:['data','shell'],scope:{machine:'gpu-1',hostAdmin:false,dataWorkspace:true},command:'--data-workspace'},
  {name:'legacy workspace',argv:['ssh','--legacy'],scope:{machine:'gpu-1',hostAdmin:false},command:'--legacy'},
])test(`503 preserves the original ${name} UUID and scope before dispatch, without entering interaction`,async t=>{
  const f=await fixture(t),result=await f.cli(argv);
  assert.equal(result.code,1);
  const opened=f.calls.find(call=>call.operation==='terminal.open').args;
  assert.match(opened.key,UUID);
  const saved=f.dispatch().cache.terminalSessions?.[opened.key];
  assert.ok(saved,'The original UUID must be saved before terminal.open is dispatched');
  assert.equal(saved.id,opened.key);assert.equal(saved.userId,principal.userId);
  assert.equal(saved.state,'UNKNOWN');for(const [key,value] of Object.entries(scope))assert.equal(saved[key],value);
  assert.ok(f.dispatch().stderr.includes(opened.key),'The original UUID must be printed before dispatch');
  const error=errorJSON(result);
  assert.equal(error.status,503);
  assert.equal(error.ok,false);assert.equal(error.terminal.id,opened.key);
  assert.equal(error.terminal.state,'UNKNOWN');for(const [key,value] of Object.entries(scope))assert.equal(error.terminal[key],value);
  assert.equal(error.terminal.statusCommand,`gpuctl terminal status ${opened.key} --machine gpu-1 ${command}`);
  assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open'],'No retry, attach, exchange or close after an ambiguous open');
  assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
  assert.equal((await stat(f.session)).mode&0o777,0o600);
  assert.doesNotMatch(JSON.stringify(saved),/writerToken|clientId/);
});

test('a lost open response retains the original UUID instead of creating another session',async t=>{
  const f=await fixture(t,{drop:true}),result=await f.cli(['ssh']);
  assert.equal(result.code,1);
  const id=f.calls.find(call=>call.operation==='terminal.open').args.key;
  assert.equal(errorJSON(result).terminal.id,id);
  assert.equal(JSON.parse(await readFile(f.session,'utf8')).terminalSessions[id].state,'UNKNOWN');
  assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open']);
});

test('an uncertain reconnect retains the old session UUID, not the new request key',async t=>{
  const f=await fixture(t),result=await f.cli(['ssh','--reconnect',original]);
  const args=f.calls.find(call=>call.operation==='terminal.open').args;
  assert.notEqual(args.key,original);assert.equal(args.id,original);assert.equal(args.takeover,false);
  const error=errorJSON(result);assert.equal(error.terminal.id,original);
  assert.equal(error.terminal.statusCommand,`gpuctl terminal status ${original} --machine gpu-1 --project alpha`);
  assert.ok(f.dispatch().cache.terminalSessions[original]);
  assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open']);
});

test('a different ID with a valid writer token never receives input or TTY ownership',async t=>{
  const f=await fixture(t,{open:()=>({id:randomUUID(),writerToken:randomUUID()})}),result=await f.cli(['ssh']);
  assert.equal(result.code,1,'A mismatching session ID is not a successful open');
  assert.equal(errorJSON(result).terminal.state,'UNKNOWN');
  assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open']);
  assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

test('a matching ID without a write lease never enters interaction',async t=>{
  const f=await fixture(t,{open:args=>({id:args.key})}),result=await f.cli(['ssh']);
  assert.equal(result.code,1);assert.equal(errorJSON(result).terminal.state,'UNKNOWN');
  assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open']);
  assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

test('an expired writer lease never allows input even when the ID matches',async t=>{
  const f=await fixture(t,{open:args=>({id:args.key,writerToken:randomUUID(),leaseExpiresAt:Date.now()/1000-1})}),result=await f.cli(['ssh']);
  assert.equal(result.code,1);assert.equal(errorJSON(result).terminal.state,'UNKNOWN');
  assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open']);
  assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

test('only a matching original ID and writer lease allow interaction; the lease stays out of disk',async t=>{
  const token=randomUUID();
  const f=await fixture(t,{open:args=>({id:args.id||args.key,writerToken:token})}),result=await f.cli(['ssh']);
  assert.equal(result.code,0,result.stderr);
  const args=f.calls.find(call=>call.operation==='terminal.open').args;
  assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open','terminal.exchange','terminal.close']);
  assert.equal(f.calls[2].args.id,args.key);assert.equal(f.calls[2].args.writerToken,token);
  assert.equal(await readFile(f.marker,'utf8'),'true\nfalse\n');
  const cache=await readFile(f.session,'utf8');assert.doesNotMatch(cache,/writerToken|clientId/);assert.equal(cache.includes(token),false);
});

test('failure to save the original identity prevents dispatch and still prints its recovery command',async t=>{
  const f=await fixture(t,{onState:async session=>{await rename(session,session+'.saved');await mkdir(session);}});
  const result=await f.cli(['ssh']);assert.equal(result.code,1);
  assert.match(errorJSON(result).terminal.id,UUID);assert.equal(errorJSON(result).terminal.state,'UNKNOWN');
  assert.deepEqual(f.calls.map(call=>call.operation),['state']);
  assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

test('an account change during state lookup cannot dispatch or overwrite the new account cache',async t=>{
  const f=await fixture(t,{onState:async session=>{
    const value=JSON.parse(await readFile(session,'utf8'));
    await writeFile(session,JSON.stringify({...value,principal:{...principal,userId:'demo-user-2'}}));
  }});
  const result=await f.cli(['ssh']);assert.equal(result.code,1);
  assert.equal(errorJSON(result).terminal.state,'UNKNOWN');
  assert.deepEqual(f.calls.map(call=>call.operation),['state']);
  const cache=JSON.parse(await readFile(f.session,'utf8'));
  assert.equal(cache.principal.userId,'demo-user-2');assert.equal(cache.terminalSessions,undefined);
});

test('a reconnect in a different scope cannot replace the original saved recovery record',async t=>{
  const f=await fixture(t),cache=JSON.parse(await readFile(f.session,'utf8'));
  const saved={id:original,machine:'gpu-1',project:'original-project',hostAdmin:false,dataWorkspace:false,userId:principal.userId,state:'UNKNOWN'};
  await writeFile(f.session,JSON.stringify({...cache,terminalSessions:{[original]:saved}}));
  const result=await f.cli(['ssh','--reconnect',original]);assert.equal(result.code,1);
  assert.deepEqual(f.calls.map(call=>call.operation),['state']);
  assert.deepEqual(JSON.parse(await readFile(f.session,'utf8')).terminalSessions[original],saved);
});

test('same-account login retains recovery records; changing account clears them',async t=>{
  const f=await fixture(t);await f.cli(['ssh']);
  const saved=JSON.parse(await readFile(f.session,'utf8')).terminalSessions;
  const same=await f.cli(['login','terminal-tester','--password-stdin'],'test-password\n');assert.equal(same.code,0,same.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.session,'utf8')).terminalSessions,saved);
  f.setLoginPrincipal({...principal,userId:'demo-user-2'});
  const changed=await f.cli(['login','other','--password-stdin'],'test-password\n');assert.equal(changed.code,0,changed.stderr);
  assert.equal(JSON.parse(await readFile(f.session,'utf8')).terminalSessions,undefined);
});
