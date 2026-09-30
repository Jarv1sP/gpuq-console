import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {DemoClient} from '../dist/client.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const request=(more={})=>({machine:'gpu-1',id:randomUUID(),clientId:randomUUID(),writerToken:randomUUID(),offset:0,input:'YQ==',...more});
const output={data:'cHJpdmF0ZS1lY2hv',offset:12,exited:false};

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-terminal-api-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Only-Test-Password-Long-2026'}));
  const calls=[];let dispatch=async()=>output;
  const service=await PortalService.open(join(dir,'state.sqlite'),bootstrap,undefined,(machine,operation,args)=>{
    calls.push({machine,operation,args});return dispatch(machine,operation,args);
  });
  clearInterval(service.executionTimer);
  for(const [userId,username,role] of [['member','alice','member'],['operator','operator','admin']])
    service.store.users.push({id:userId,username,name:username,role,enabled:true,limits:{'gpu-1':1},total:1,policyVersion:0});
  for(const [token,userId,username,role] of [['admin-token','builtin-admin','admin','admin'],['member-token','member','alice','member'],['operator-token','operator','operator','admin']])
    service.sessions.set(token,{userId,username,role,expires:Date.now()+3600000});
  return {service,calls,setDispatch:value=>dispatch=value,
    exchange:(args=request(),token='member-token')=>service.invoke(token,'terminal.exchange',args),
    close:async()=>{service.close();await rm(dir,{recursive:true,force:true});}};
}

test('terminal exchange bypasses a slow data request and returns only compact authorized output',async()=>{
  const f=await fixture(),slow=deferred();let data,exchange;
  try{
    f.setDispatch((machine,operation)=>operation==='files.list'?slow.promise:output);
    data=f.service.invoke('member-token','files.list',{machine:'gpu-1'});
    await tick();assert.equal(f.calls[0].operation,'files.list');
    let terminal;
    exchange=f.exchange().then(result=>{terminal=result;});
    await tick();
    assert.equal(f.calls[1]?.operation,'terminal.exchange','terminal must dispatch while the data request is still blocked');
    await exchange;
    assert.deepEqual(terminal,{result:output,principal:{userId:'member',username:'alice',role:'member'}});
    assert.equal(Object.hasOwn(terminal,'state'),false);
    assert.equal(f.service.pending,1,'the existing data request still owns the durable queue');
  }finally{slow.resolve({files:[]});await Promise.allSettled([data,exchange]);await f.close();}
});

test('browser client consumes compact terminal responses without replacing its cached application state',async()=>{
  const f=await fixture();try{
    const client=new DemoClient();client.service=f.service;client.remote=false;client.token='member-token';
    client.principal={userId:'member',username:'alice',role:'member'};
    const cached={users:[{id:'member'}],jobs:[],draft:'keep-local-state'};client.data=cached;
    assert.deepEqual(await client.call('terminal.exchange',request()),output);
    assert.equal(client.data,cached);assert.deepEqual(client.principal,{userId:'member',username:'alice',role:'member'});
    assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('same-session exchanges preserve FIFO while independent sessions proceed',async()=>{
  const f=await fixture(),slow=deferred(),args=request();const pending=[];
  try{
    f.setDispatch((machine,operation,fields)=>fields.input==='YQ=='?slow.promise:output);
    pending.push(f.exchange(args));await tick();
    pending.push(f.exchange({...args,input:'Yg=='}));
    const independent=f.exchange(request({input:'Yw=='}));pending.push(independent);
    await tick();assert.deepEqual(f.calls.map(call=>call.args.input),['YQ==','Yw==']);
    await independent;slow.resolve(output);await Promise.all(pending);
    assert.deepEqual(f.calls.map(call=>call.args.input),['YQ==','Yw==','Yg==']);
    assert.equal(f.service.terminalPending,0);assert.equal(f.service.terminalLanes.size,0);
  }finally{slow.resolve(output);await Promise.allSettled(pending);await f.close();}
});

test('fast lane retains trusted argument validation and refuses unauthorized dispatch',async()=>{
  const f=await fixture();
  try{
    for(const [args,token,pattern] of [
      [request(),'missing-token',/登录/],
      [request({machine:'gpu-2'}),'member-token',/未授权/],
      [request({hostAdmin:true}),'member-token',/管理员/],
      [request({hostAdmin:true,project:'demo'}),'operator-token',/分开/],
      [request({userId:'builtin-admin'}),'member-token',/参数/],
      [request({writerToken:undefined}),'member-token',/凭据/],
      [request({id:'not-a-session'}),'member-token',/会话/],
      [request({input:'x'.repeat(13000)}),'member-token',/输入过长/],
    ])await assert.rejects(f.exchange(args,token),pattern);
    const member=f.service.store.users.find(user=>user.id==='member');member.enabled=false;
    await assert.rejects(f.exchange(),error=>error.status===403);
    member.enabled=true;member.role='admin';
    await assert.rejects(f.exchange(),error=>error.status===403);
    assert.equal(f.calls.length,0);assert.equal(f.service.terminalPending,0);assert.equal(f.service.terminalLanes.size,0);
  }finally{await f.close();}
});

test('grant revocation rejects in-flight output and queued input before another dispatch',async()=>{
  const f=await fixture(),slow=deferred(),args=request();const checks=[];
  try{
    f.setDispatch(()=>slow.promise);
    checks.push(assert.rejects(f.exchange(args),error=>error.status===403));await tick();
    checks.push(assert.rejects(f.exchange({...args,input:'Yg=='}),error=>error.status===403));
    await f.service.invoke('admin-token','policy.save',{userId:'member',policyVersion:0,total:0,limits:{}});
    slow.resolve(output);await Promise.all(checks);
    assert.equal(f.calls.length,1,'queued bytes must not reach the bridge after revocation');
    assert.equal(f.service.terminalPending,0);
  }finally{slow.resolve(output);await Promise.allSettled(checks);await f.close();}
});

test('logout, suspension, role change and token expiry suppress delayed private output',async t=>{
  for(const change of ['logout','suspension','role','expiry'])await t.test(change,async()=>{
    const f=await fixture(),slow=deferred();let check;
    try{
      f.setDispatch(()=>slow.promise);
      const token=change==='role'?'operator-token':'member-token';
      check=assert.rejects(f.exchange(request({hostAdmin:change==='role'}),token),error=>[401,403].includes(error.status));
      await tick();assert.equal(f.calls.length,1);
      if(change==='logout')await f.service.invoke(token,'logout');
      if(change==='suspension')await f.service.invoke('admin-token','users.enabled',{userId:'member',enabled:false});
      if(change==='role')await f.service.invoke('admin-token','users.role',{userId:'operator',role:'member'});
      if(change==='expiry')f.service.sessions.get(token).expires=Date.now()-1;
      slow.resolve(output);await check;
      assert.equal(f.calls.length,1);
    }finally{slow.resolve(output);if(check)await check;await f.close();}
  });
});

test('terminal lanes bound outstanding requests globally and per session without filling the mutation queue',async()=>{
  const f=await fixture(),slow=deferred(),args=request(),pending=[];
  try{
    f.setDispatch(()=>slow.promise);
    for(let index=0;index<4;index++)pending.push(f.exchange(args));
    await assert.rejects(f.exchange(args),error=>error.status===429);
    for(let index=0;index<20;index++)pending.push(f.exchange());
    await assert.rejects(f.exchange(),error=>error.status===429);
    await tick();assert.equal(f.calls.length,21);assert.equal(f.service.terminalPending,24);assert.equal(f.service.pending,0);
    slow.resolve(output);await Promise.all(pending);
    assert.equal(f.calls.length,24);assert.equal(f.service.terminalPending,0);assert.equal(f.service.terminalLanes.size,0);
    await f.exchange();assert.equal(f.calls.length,25,'capacity is released after completion');
  }finally{slow.resolve(output);await Promise.allSettled(pending);await f.close();}
});

test('an ambiguous bridge failure is never retried and does not poison the session lane',async()=>{
  const f=await fixture(),slow=deferred(),args=request();let failed,next;
  try{
    f.setDispatch((machine,operation,fields)=>fields.input==='YQ=='?slow.promise:output);
    failed=assert.rejects(f.exchange(args),/lost reply/);await tick();
    next=f.exchange({...args,input:'Yg=='});
    slow.reject(Error('lost reply'));await failed;await next;
    assert.deepEqual(f.calls.map(call=>call.args.input),['YQ==','Yg==']);
    assert.equal(f.service.terminalPending,0);assert.equal(f.service.terminalLanes.size,0);
  }finally{slow.resolve(output);await Promise.allSettled([failed,next]);await f.close();}
});

test('revocation suppresses private node error details as well as successful output',async()=>{
  const f=await fixture(),slow=deferred();let check;
  try{
    f.setDispatch(()=>slow.promise);
    check=assert.rejects(f.exchange(),error=>error.status===401&&!error.message.includes('private-node-context'));
    await tick();await f.service.invoke('member-token','logout');
    slow.reject(Error('private-node-context'));await check;
    assert.equal(f.calls.length,1);assert.equal(f.service.terminalPending,0);
  }finally{slow.resolve(output);if(check)await check;await f.close();}
});
