import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoClient} from '../dist/client.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const state=name=>({token:name+'-token',principal:{userId:name},state:{users:[{id:name}],jobs:[]}});
function fixture(){
  const client=new DemoClient(),calls=[];client.token='old-token';client.principal={userId:'old'};client.data=state('old').state;
  client.service={invoke:(token,operation,args)=>{const response=deferred();calls.push({token,operation,args,...response});return response.promise;},login:(username)=>{const response=deferred();calls.push({operation:'login',username,...response});return response.promise;}};
  return {client,calls};
}
const stale=error=>error.code==='STALE_SESSION'&&error.status===undefined;
test('old successful calls cannot write data/principal or return results across logout and new login',async()=>{
  const {client,calls}=fixture();const old=client.call('state');const rejected=assert.rejects(old,stale);
  const logout=client.logout(),login=client.login('new','fixture');
  assert.equal(client.principal,null);assert.equal(client.data,null);assert.equal(client.token,null);
  await assert.rejects(client.call('jobs.submit',{}),stale);await tick();assert.equal(calls.length,1);
  calls[0].resolve({...state('old'),result:'old-secret'});await rejected;await tick();
  assert.equal(calls[1].operation,'logout');assert.equal(calls[1].token,'old-token');calls[1].resolve({result:{loggedOut:true}});await logout;await tick();
  assert.equal(calls[2].operation,'login');calls[2].resolve(state('new'));await login;
  assert.equal(client.token,'new-token');assert.equal(client.principal.userId,'new');assert.equal(client.users[0].id,'new');
});
test('old 401 becomes a stale error and is drained before a new cookie login',async()=>{
  const {client,calls}=fixture();const old=assert.rejects(client.call('state'),stale),login=client.login('new','fixture');
  calls[0].reject(Object.assign(Error('expired'),{status:401}));await old;await tick();assert.equal(calls[1].operation,'login');
  calls[1].resolve(state('new'));await login;assert.equal(client.principal.userId,'new');
});
test('overlapping logins serialize cookie writes and only the latest identity reaches memory',async()=>{
  const {client,calls}=fixture();const first=client.login('first','fixture'),rejected=assert.rejects(first,stale);await tick();
  const second=client.login('second','fixture');await tick();assert.equal(calls.length,1);
  calls[0].resolve(state('first'));await rejected;await tick();assert.equal(client.principal,null);assert.equal(calls[1].username,'second');
  calls[1].resolve(state('second'));await second;assert.equal(client.principal.userId,'second');assert.equal(client.token,'second-token');
});
test('logout queued behind a superseded login revokes the credential that actually completed',async()=>{
  const {client,calls}=fixture();const login=client.login('first','fixture'),rejected=assert.rejects(login,stale);await tick();const logout=client.logout();
  calls[0].resolve(state('first'));await rejected;await tick();assert.equal(calls[1].token,'first-token');assert.equal(calls[1].operation,'logout');
  calls[1].resolve({result:{loggedOut:true}});await logout;assert.equal(client.token,null);assert.equal(client.principal,null);
});
test('late terminal open is closed under captured old credentials before new login, without attaching',async()=>{
  const {client,calls}=fixture();let attached=false;
  const opened=client.call('terminal.open',{machine:'gpu-1',project:'vision'},{accept:()=>{attached=true;},onStale:(result,call)=>call('terminal.close',{machine:'gpu-1',project:'vision',id:result.id})});
  const rejected=assert.rejects(opened,stale),login=client.login('new','fixture');calls[0].resolve({result:{id:'old-terminal'}});await tick();
  assert.equal(calls[1].operation,'terminal.close');assert.equal(calls[1].token,'old-token');assert.equal(calls[1].args.project,'vision');assert.equal(calls[1].args.id,'old-terminal');assert.equal(calls.length,2);assert.equal(attached,false);
  calls[1].resolve({result:{closed:true}});await rejected;await tick();assert.equal(calls[2].operation,'login');calls[2].resolve(state('new'));await login;
});
test('failed old terminal cleanup gives a recovery warning but cannot prevent the next login',async()=>{
  const {client,calls}=fixture();const opened=client.call('terminal.open',{}, {onStale:(result,call)=>call('terminal.close',{id:result.id})});
  const rejected=assert.rejects(opened,error=>stale(error)&&/关闭未确认/.test(error.message)),login=client.login('new','fixture');calls[0].resolve({result:{id:'old'}});await tick();
  calls[1].reject(Error('unreachable'));await rejected;await tick();calls[2].resolve(state('new'));await login;assert.equal(client.principal.userId,'new');
});
test('accepted resources register within the fence and auth-change cleanup is part of the drain',async()=>{
  const {client,calls}=fixture();let resource;
  client.onAuthChange(async call=>{if(resource)await call('terminal.close',{id:resource.id});});
  const opened=client.call('terminal.open',{}, {accept:result=>{resource=result;}});calls[0].resolve({result:{id:'known'}});await opened;
  const login=client.login('new','fixture');await tick();assert.equal(calls[1].operation,'terminal.close');assert.equal(calls[1].token,'old-token');assert.equal(calls.length,2);
  calls[1].resolve({result:{closed:true}});await tick();calls[2].resolve(state('new'));await login;
});
test('hung fetch and body reads time out, abort, and unblock auth without adopting a late response',async()=>{
  const original=globalThis.fetch;const {client}=fixture();client.remote=true;client.requestTimeoutMs=25;const hung=deferred();let signal;const sent=[];
  globalThis.fetch=async(url,options)=>{sent.push({url,token:options.headers.Authorization});if(url.endsWith('/login'))return {ok:true,json:async()=>state('new')};signal=options.signal;return {ok:true,json:()=>hung.promise};};
  try{const old=assert.rejects(client.call('state'),stale),login=client.login('new','fixture');await old;await login;assert.equal(signal.aborted,true);assert.equal(sent[0].token,'Bearer old-token');assert.equal(sent[1].token,undefined);hung.resolve({...state('old'),result:'secret'});await tick();assert.equal(client.principal.userId,'new');}finally{globalThis.fetch=original;}
});
test('all production registration fetches also have a bound and do not leak a bearer token',async()=>{
  const original=globalThis.fetch;const {client}=fixture();client.remote=true;client.production=true;client.requestTimeoutMs=20;let signal,authorization;
  globalThis.fetch=async(_url,options)=>{signal=options.signal;authorization=options.headers.Authorization;return new Promise(()=>{});};
  try{await assert.rejects(client.register('fixture','fixture','fixture'),error=>error.code==='REQUEST_TIMEOUT');assert.equal(signal.aborted,true);assert.equal(authorization,undefined);}finally{globalThis.fetch=original;}
});
test('external cancellation aborts hung fetch/body reads, drains inflight and rejects late state',async()=>{
  const original=globalThis.fetch;
  try{
    for(const stage of ['fetch','body']){
      const {client}=fixture();client.remote=true;const controller=new AbortController(),hung=deferred();let signal,accepted=false;
      globalThis.fetch=async(_url,options)=>{signal=options.signal;return stage==='fetch'?hung.promise:{ok:true,json:()=>hung.promise};};
      const request=client.call('projects.status',{machine:'example-node',project:'vision'},{signal:controller.signal,accept:()=>{accepted=true;}});
      const rejected=assert.rejects(request,error=>error.name==='AbortError');await tick();assert.equal(client.inflight.size,1);
      controller.abort();await rejected;assert.equal(signal.aborted,true);assert.equal(client.inflight.size,0);
      const late={...state('obsolete'),result:{project:'vision',state:'READY'}};
      hung.resolve(stage==='fetch'?{ok:true,json:async()=>late}:late);await tick();
      assert.equal(accepted,false);assert.equal(client.principal.userId,'old');assert.equal(client.users[0].id,'old');
    }
  }finally{globalThis.fetch=original;}
});
test('cancelled project lookup cannot hold logout behind an unresolved body',async()=>{
  const original=globalThis.fetch;const {client}=fixture();client.remote=true;const controller=new AbortController(),hung=deferred(),sent=[];
  globalThis.fetch=async(url,options)=>{const request=JSON.parse(options.body);sent.push(request.operation);return {ok:true,json:()=>request.operation==='logout'?Promise.resolve({result:{loggedOut:true}}):hung.promise};};
  client.onAuthChange(()=>controller.abort());
  try{
    const old=assert.rejects(client.call('projects.status',{machine:'example-node',project:'vision'},{signal:controller.signal}),stale);
    await client.logout();await old;assert.deepEqual(sent,['projects.status','logout']);assert.equal(client.inflight.size,0);
    hung.resolve(state('obsolete'));await tick();assert.equal(client.principal,null);assert.equal(client.data,null);
  }finally{globalThis.fetch=original;}
});
test('a pre-cancelled request cannot send any network request',async()=>{
  const original=globalThis.fetch;const {client}=fixture();client.remote=true;const controller=new AbortController();controller.abort();let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('must not send');};
  try{await assert.rejects(client.call('projects.status',{}, {signal:controller.signal}),error=>error.name==='AbortError');assert.equal(calls,0);assert.equal(client.inflight.size,0);}finally{globalThis.fetch=original;}
});
