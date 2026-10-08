import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createPortalServer} from '../portal-server.mjs';

const machine='gpu-1',original='11111111-2222-4333-8444-555555555555';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const receipt=args=>({id:args.id||args.key,hostAdmin:args.hostAdmin,clientId:args.clientId,
  mode:args.mode,writerToken:randomUUID(),leaseExpiresAt:Date.now()/1000+30});
const errorJSON=value=>JSON.parse(value.stderr.trim().split(/\r?\n/).at(-1));
const handle=value=>{const line=value.stderr.split(/\r?\n/).find(line=>line.startsWith('Terminal: '));
  assert.ok(line,'Original terminal identity must be printed before the open request, including failures');return JSON.parse(line.slice(10));};

async function clientFixture(t){
  const directory=await mkdtemp(join(tmpdir(),'stargate-terminal-cli-')),cache=join(directory,'session.json'),preload=join(directory,'tty.mjs');
  const f={calls:[],sessions:new Map(),mode:'json-error',visibleBeforeRequest:false,stderr:'',machines:[{id:machine}]};
  await writeFile(preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=()=>process.stdin;');
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const {operation,args}=JSON.parse(raw);f.calls.push({operation,args});res.setHeader('Content-Type','application/json');
    if(operation==='state'){res.end(JSON.stringify({state:{demo:false,machines:f.machines,users:[],jobs:[]}}));return;}
    if(operation==='terminal.open'){
      const id=args.id||args.key;await new Promise(resolve=>setImmediate(resolve));
      f.visibleBeforeRequest=f.stderr.includes(id)&&f.stderr.includes(machine);
      f.sessions.set(id,{machine:args.machine,hostAdmin:args.hostAdmin,project:args.project,dataWorkspace:args.dataWorkspace});
      if(f.mode==='drop'){req.socket.destroy();return;}
      if(f.mode.endsWith('error')){res.statusCode=503;res.end(f.mode==='html-error'?'<html>not a JSON receipt</html>':JSON.stringify({error:'node outcome unconfirmed'}));return;}
      res.end(JSON.stringify({result:f.change?f.change(receipt(args),args):receipt(args)}));return;
    }
    if(operation==='terminal.status'){
      const scope=f.sessions.get(args.id);
      if(!scope||Object.keys(scope).some(key=>scope[key]!==args[key])){res.statusCode=403;res.end(JSON.stringify({error:'original scope differs'}));return;}
      res.end(JSON.stringify({result:{protocol:'terminal-session-status-v1',id:args.id,state:'ALIVE',evidence:{confirmed:true}}}));return;
    }
    if(operation==='terminal.exchange'){
      if(f.exchangeFailure&&args.input){res.statusCode=503;res.end(JSON.stringify({error:'input outcome unconfirmed'}));return;}
      res.end(JSON.stringify({result:{offset:0,data:'',exited:!f.exchangeFailure}}));return;
    }
    if(operation==='terminal.close'&&f.closeDrop){f.closedSession=args.id;req.socket.destroy();return;}
    res.end(JSON.stringify({result:{closed:operation==='terminal.close',detached:operation==='terminal.detach'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  await writeFile(cache,JSON.stringify({url,token:'isolated-fixture-token',principal:{userId:'demo-user-1',username:'local-member',role:'member'},machine,projectsByMachine:{[machine]:'alpha'}}),{mode:0o600});
  f.run=(args,{json=true,tty=true,entry=new URL('../cli.mjs',import.meta.url).pathname}={})=>new Promise((resolve,reject)=>{
    f.stderr='';const child=spawn(process.execPath,[...(tty?['--import',preload]:[]),entry,'--url',url,'--session-file',cache,...(json?['--json']:[]),...args]);
    let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>{stderr+=bytes;f.stderr=stderr;});
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();
  });
  f.cache=cache;f.preload=preload;f.directory=directory;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return f;
}

for(const mode of ['json-error','html-error','drop']){
  test('actual CLI prints original new UUID before '+mode+' and queries it without another open',async t=>{
    const f=await clientFixture(t);f.mode=mode;const before=await readFile(f.cache,'utf8');
    const value=await f.run(['ssh']);assert.equal(value.code,1);
    if(process.env.TERMINAL_HANDLE_REVIEW==='1')t.diagnostic(JSON.stringify({case:mode,openRequest:f.calls.find(call=>call.operation==='terminal.open').args,
      visibleBeforeRequest:f.visibleBeforeRequest,exitCode:value.code,stderr:value.stderr}));
    const open=f.calls.find(call=>call.operation==='terminal.open').args,identity=handle(value),failure=errorJSON(value);
    assert.equal(f.visibleBeforeRequest,true);assert.match(open.key,uuid);
    assert.deepEqual(identity,{id:open.key,machine,project:'alpha',dataWorkspace:false,hostAdmin:false,mode:'new',state:'UNKNOWN',
      statusCommand:'gpuctl terminal status '+open.key+' --machine '+machine+' --project alpha'});
    assert.deepEqual(failure.terminal,identity);assert.match(failure.error,/状态未确认/);assert.match(failure.error,new RegExp(open.key));
    if(mode!=='drop')assert.equal(failure.status,503);assert.equal('writerToken' in failure,false);
    assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open']);assert.equal(await readFile(f.cache,'utf8'),before);
    const status=await f.run(['terminal','status',identity.id,'--machine',identity.machine,'--project',identity.project],{tty:false});
    assert.equal(status.code,0,status.stderr);assert.equal(JSON.parse(status.stdout).data.id,open.key);
    assert.equal(f.calls.filter(call=>call.operation==='terminal.open').length,1);
    assert.equal(f.calls.some(call=>['terminal.exchange','terminal.close','terminal.detach'].includes(call.operation)),false);
  });
}

test('human errors preserve root, personal-data and legacy scopes even when selected project changes',async t=>{
  const f=await clientFixture(t);
  for(const [args,scope] of [[['ssh','--root'],{hostAdmin:true,project:null,dataWorkspace:false,option:'--root'}],
    [['data','shell'],{hostAdmin:false,project:null,dataWorkspace:true,option:'--data-workspace'}],
    [['ssh','--legacy'],{hostAdmin:false,project:null,dataWorkspace:false,option:'--legacy'}]]){
    const value=await f.run(args,{json:false}),identity=handle(value);
    assert.equal(value.code,1);assert.match(value.stderr,/状态未确认/);assert.equal(identity.hostAdmin,scope.hostAdmin);
    assert.equal(identity.project,scope.project);assert.equal(identity.dataWorkspace,scope.dataWorkspace);
    assert.equal(identity.statusCommand,'gpuctl terminal status '+identity.id+' --machine '+machine+' '+scope.option);
    const cache=JSON.parse(await readFile(f.cache,'utf8'));cache.projectsByMachine={[machine]:'changed-project'};
    await writeFile(f.cache,JSON.stringify(cache),{mode:0o600});
    const status=await f.run(['terminal','status',identity.id,'--machine',machine,scope.option],{tty:false});assert.equal(status.code,0,status.stderr);
  }
});

test('lost reconnect ACK reports the retained session ID, never its new attachment nonce',async t=>{
  const f=await clientFixture(t),value=await f.run(['ssh','--reconnect',original]);
  if(process.env.TERMINAL_HANDLE_REVIEW==='1')t.diagnostic(JSON.stringify({case:'reconnect-lost-ack',openRequest:f.calls.find(call=>call.operation==='terminal.open').args,
    visibleBeforeRequest:f.visibleBeforeRequest,exitCode:value.code,stderr:value.stderr}));
  const open=f.calls.find(call=>call.operation==='terminal.open').args,identity=handle(value);
  assert.equal(value.code,1);assert.equal(open.id,original);assert.notEqual(open.key,original);assert.equal(open.mode,'reconnect');
  assert.equal(identity.id,original);assert.equal(identity.mode,'reconnect');assert.equal(errorJSON(value).terminal.id,original);
  assert.equal(identity.statusCommand,'gpuctl terminal status '+original+' --machine '+machine+' --project alpha');
  assert.equal(f.calls.filter(call=>call.operation==='terminal.open').length,1);assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
});

test('only exact ID and complete writer receipt permit CLI exchange on new and reconnected sessions',async t=>{
  const f=await clientFixture(t);f.mode='success';
  for(const reconnect of [false,true]){
    f.calls.length=0;const value=await f.run(['ssh',...(reconnect?['--reconnect',original]:[])]);
    assert.equal(value.code,0,value.stderr);const identity=handle(value),open=f.calls.find(call=>call.operation==='terminal.open').args;
    assert.equal(identity.id,reconnect?original:open.key);assert.equal(f.visibleBeforeRequest,true);
    const calls=f.calls.filter(call=>call.operation.startsWith('terminal.'));
    assert.deepEqual(calls.map(call=>call.operation),['terminal.open','terminal.exchange','terminal.close']);
    assert.equal(calls[1].args.id,identity.id);assert.equal(calls[1].args.clientId,open.clientId);assert.match(calls[1].args.writerToken,uuid);
    assert.doesNotMatch(value.stderr,new RegExp(calls[1].args.writerToken));assert.doesNotMatch(await readFile(f.cache,'utf8'),new RegExp(calls[1].args.writerToken));
  }
});

test('wrong ID, client, mode, root, scope or writer receipt is UNKNOWN with zero input or cleanup',async t=>{
  const f=await clientFixture(t);f.mode='success';
  const changes=[{id:randomUUID()},{id:undefined},{clientId:randomUUID()},{clientId:undefined},{mode:'reconnect'},
    {hostAdmin:true},{writerToken:''},{writerToken:'wrong'},{writerToken:undefined},{leaseExpiresAt:undefined},
    {leaseExpiresAt:0},{leaseExpiresAt:'later'},{leaseExpiresAt:true},{leaseExpiresAt:-1},{leaseExpiresAt:253402300800},
    {leaseExpiresAt:Number.MAX_SAFE_INTEGER},{leaseExpiresAt:Number.MAX_VALUE},{leaseExpiresAt:Infinity},{leaseExpiresAt:NaN},
    {machine:'gpu-2'},{project:'foreign'},{dataWorkspace:true}];
  for(const changeset of changes){
    f.calls.length=0;f.change=value=>({...value,...changeset});const result=await f.run(['ssh']);
    assert.equal(result.code,1,JSON.stringify(changeset));assert.equal(errorJSON(result).terminal.state,'UNKNOWN');
    assert.equal(errorJSON(result).terminal.id,f.calls.find(call=>call.operation==='terminal.open').args.key);
    assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open']);
  }
  f.change=value=>({...value,id:randomUUID()});const reconnect=await f.run(['ssh','--reconnect',original]);
  assert.equal(reconnect.code,1);assert.equal(errorJSON(reconnect).terminal.id,original);
});

test('finite fractional lease timestamps are metadata, never compared with the client wall clock',async t=>{
  const f=await clientFixture(t);f.mode='success';
  for(const leaseExpiresAt of [1.25,253402300799.999]){
    f.change=value=>({...value,leaseExpiresAt});const result=await f.run(['ssh']);assert.equal(result.code,0,result.stderr);
  }
});

test('uncertain input retains original recovery identity and never replays or closes the terminal',async t=>{
  const f=await clientFixture(t);f.mode='success';f.exchangeFailure=true;
  await writeFile(f.preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=enabled=>{if(enabled)setTimeout(()=>process.stdin.emit("data",Buffer.from("echo fixture\\n")),10);return process.stdin;};');
  const result=await f.run(['ssh']);assert.equal(result.code,1);const identity=handle(result);
  const writes=f.calls.filter(call=>call.operation==='terminal.exchange'&&call.args.input);
  assert.equal(writes.length,1);assert.equal(Buffer.from(writes[0].args.input,'base64').toString(),'echo fixture\n');
  assert.equal(errorJSON(result).terminal.id,identity.id);assert.equal(f.calls.filter(call=>call.operation==='terminal.open').length,1);
  assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);assert.equal(f.calls.filter(call=>call.operation==='terminal.detach').length,1);
  assert.doesNotMatch(result.stderr,/终端继续运行/);assert.ok(result.stderr.includes('已断开。只读查询：'+identity.statusCommand));
  assert.ok(result.stderr.includes('重连：gpuctl ssh --machine '+machine+' --project alpha --reconnect '+identity.id));
});

test('lost close ACK retains UNKNOWN identity without claiming a running process or another close',async t=>{
  const f=await clientFixture(t);f.mode='success';f.closeDrop=true;
  const result=await f.run(['ssh']);assert.equal(result.code,1);const identity=handle(result);
  assert.equal(f.closedSession,identity.id);assert.equal(errorJSON(result).terminal.id,identity.id);
  assert.equal(errorJSON(result).terminal.state,'UNKNOWN');assert.doesNotMatch(result.stderr,/终端继续运行|此终端已结束/);
  assert.ok(result.stderr.includes('已断开。只读查询：'+identity.statusCommand));
  assert.ok(result.stderr.includes('重连：gpuctl ssh --machine '+machine+' --project alpha --reconnect '+identity.id));
  assert.deepEqual(f.calls.map(call=>call.operation),['state','terminal.open','terminal.exchange','terminal.close','terminal.detach']);
});

test('downloaded standalone client retains original handle on a lost open response',async t=>{
  const f=await clientFixture(t),value=await f.run(['ssh'],{entry:new URL('../build/gpuctl.mjs',import.meta.url).pathname});
  assert.equal(value.code,1);assert.equal(errorJSON(value).terminal.id,f.calls.find(call=>call.operation==='terminal.open').args.key);
});

test('normal Portal authorization rejects foreign original session and zero-grant or member ROOT opens',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'stargate-terminal-cli-auth-')),bootstrap=join(directory,'bootstrap.json'),password='Terminal-CLI-Isolated-Password-2026!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const url='http://127.0.0.1:'+port,calls=[],sessions=new Map();
  const {server,service}=await createPortalServer({database:join(directory,'portal.sqlite'),bootstrap,origin:url,secure:false,bridge:async(serverId,operation,args)=>{
    calls.push({serverId,operation,args});
    if(operation==='terminal.open'){sessions.set(args.key,args.userId);throw Object.assign(Error('node ACK lost'),{status:503});}
    if(operation==='terminal.status'){
      if(sessions.get(args.id)!==args.userId)throw Object.assign(Error('foreign session identity'),{status:403});
      return {protocol:'terminal-session-status-v1',id:args.id,state:'UNKNOWN',evidence:{confirmed:false}};
    }
    throw Error('unexpected node operation');
  }});
  for(const key of ['executionTimer','transferTimer','maintenanceTimer','storageArchiveTimer','projectCopyTimer','notificationTimer'])clearInterval(service[key]);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const post=async(path,body,token)=>{const response=await fetch(url+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
  const admin=await post('login',{username:'admin',password}),members=[];
  for(const username of ['cli-owner','cli-other','cli-zero']){
    await post('call',{operation:'users.create',args:{username,password}},admin.token);const member=await post('login',{username,password});members.push(member);
    if(username!=='cli-zero')await post('call',{operation:'policy.save',args:{userId:member.principal.userId,policyVersion:0,total:1,limits:{[machine]:1}}},admin.token);
  }
  const preload=join(directory,'tty.mjs');await writeFile(preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=()=>process.stdin;');
  const run=async(member,args)=>{
    const cache=join(directory,member.principal.userId+'.json');await writeFile(cache,JSON.stringify({url,token:member.token,principal:member.principal,machine}),{mode:0o600});
    return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import',preload,new URL('../cli.mjs',import.meta.url).pathname,'--json','--url',url,'--session-file',cache,...args]);let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();});
  };
  const opened=await run(members[0],['ssh','--machine',machine,'--legacy']),id=handle(opened).id;assert.equal(opened.code,1);assert.equal(calls.length,1);
  const foreign=await run(members[1],['terminal','status',id,'--machine',machine,'--legacy']);assert.equal(foreign.code,1);assert.match(foreign.stderr,/403/);
  assert.equal(calls.at(-1).args.userId,members[1].principal.userId);assert.equal(calls.at(-1).args.id,id);
  const count=calls.length;
  assert.equal((await run(members[2],['ssh','--machine',machine,'--legacy'])).code,1);
  const root=await run(members[0],['ssh','--machine',machine,'--root']);assert.equal(root.code,1);assert.match(root.stderr,/403/);
  assert.equal(calls.length,count);assert.equal(calls.some(call=>['terminal.exchange','terminal.close','terminal.detach'].includes(call.operation)),false);
});
