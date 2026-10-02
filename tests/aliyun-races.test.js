import test from 'node:test';
import assert from 'node:assert/strict';
import {AliyunShare} from '../aliyun-share.mjs';

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function json(value){return new Response(JSON.stringify(value));}
const login={content:{data:{codeContent:'https://www.alipan.com/login?request=example',ck:'private-ck',t:'1'}}};
const confirmed={content:{data:{qrCodeStatus:'CONFIRMED',bizExt:Buffer.from(JSON.stringify({pds_login_result:{refreshToken:'new-private-refresh-token'}})).toString('base64')}}};
const token={access_token:'private-access-token',refresh_token:'rotated-private-refresh-token',expires_in:3600};
function setup(request){let stored={refreshToken:'initial-private-refresh-token'};const writes=[];const provider=new AliyunShare({load:()=>stored,save:value=>{stored=value;writes.push(value);},request});return {provider,writes,get:()=>stored,replace:value=>{stored=value;}};}

test('QR result has a finite ten-minute local lifetime',async()=>{
  const now=1700000000000;
  const provider=new AliyunShare({load:()=>null,save:()=>assert.fail('Generating a QR must not save credentials'),request:async()=>json(login),now:()=>now});
  const qr=await provider.begin();
  assert.equal(qr.expiresAt,now+10*60*1000);
  assert.match(qr.image,/^data:image\/png;base64,/);
});

test('concurrent token requests share one rotation and persist before returning',async()=>{
  const gate=deferred();let requests=0;const {provider,writes}=setup(async()=>{requests++;return gate.promise;});
  const pending=Array.from({length:12},()=>provider.token());
  assert.equal(requests,1);gate.resolve(json(token));
  assert.deepEqual(await Promise.all(pending),Array(12).fill(token.access_token));
  assert.equal(writes.length,1);assert.equal(writes[0].refreshToken,token.refresh_token);
  assert.equal(await provider.token(),token.access_token);assert.equal(requests,1);
});

test('disconnect invalidates in-flight refresh instead of resurrecting credentials',async()=>{
  const gate=deferred();const {provider,writes,replace,get}=setup(async()=>gate.promise);
  const pending=provider.token();const rejected=assert.rejects(pending,e=>e.status===409);
  replace(null);provider.clear();gate.resolve(json(token));await rejected;
  assert.equal(get(),null);assert.equal(writes.length,0);assert.equal(provider.access,null);
});

test('a stale refresh cannot replace a newly connected account or its newer flight',async()=>{
  const first=deferred(),second=deferred();let requests=0;const {provider,writes,replace}=setup(async()=>++requests===1?first.promise:second.promise);
  const old=provider.token();const oldRejected=assert.rejects(old,e=>e.status===409);
  provider.clear();replace({refreshToken:'new-account-private-refresh'});
  const next=provider.token();first.resolve(json(token));await oldRejected;
  const third=provider.token();assert.equal(requests,2);
  second.resolve(json({...token,access_token:'new-account-access',refresh_token:'new-account-rotated'}));
  assert.equal(await next,'new-account-access');assert.equal(await third,'new-account-access');
  assert.equal(writes.length,1);assert.equal(writes[0].refreshToken,'new-account-rotated');
});

test('failed refresh releases its single-flight fence for a later retry',async()=>{
  let calls=0;const {provider}=setup(async()=>{if(++calls===1)throw Error('https://secret.example/?token=private');return json(token);});
  await assert.rejects(provider.token(),e=>!e.message.includes('private'));
  assert.equal(await provider.token(),token.access_token);assert.equal(calls,2);
});

test('disconnect while QR confirmation is pending prevents credential writes',async()=>{
  const gate=deferred();const {provider,writes,replace,get}=setup(async url=>url.includes('generate.do')?json(login):gate.promise);
  const qr=await provider.begin();const pending=provider.poll(qr.secret);const rejected=assert.rejects(pending,e=>e.status===409);
  replace(null);provider.clear();gate.resolve(json(confirmed));await rejected;
  assert.equal(writes.length,0);assert.equal(get(),null);
});

test('disconnect while QR is being generated invalidates the resulting login',async()=>{
  const gate=deferred();const {provider,writes}=setup(async()=>gate.promise);
  const pending=provider.begin();const rejected=assert.rejects(pending,e=>e.status===409);
  provider.clear();gate.resolve(json(login));await rejected;assert.equal(writes.length,0);
});

test('a new QR request invalidates an old in-flight confirmation',async()=>{
  const gate=deferred();let polls=0;const {provider,writes}=setup(async url=>url.includes('generate.do')?json(login):++polls===1?gate.promise:json(confirmed));
  const old=await provider.begin();const pending=provider.poll(old.secret);const rejected=assert.rejects(pending,e=>e.status===409);
  const current=await provider.begin();gate.resolve(json(confirmed));await rejected;
  assert.equal(writes.length,0);assert.equal((await provider.poll(current.secret)).state,'CONFIRMED');
  assert.equal(writes.length,1);
});

test('duplicate confirmation responses save one account exactly once',async()=>{
  const gate1=deferred(),gate2=deferred();let polls=0;
  const {provider,writes}=setup(async(url,options)=>{
    if(url.includes('generate.do'))return json(login);
    assert.doesNotMatch(options.body,/generation/i);
    return ++polls===1?gate1.promise:gate2.promise;
  });
  const qr=await provider.begin();const p1=provider.poll(qr.secret),p2=provider.poll(qr.secret);
  const rejected=assert.rejects(p2,e=>e.status===409);
  gate1.resolve(json(confirmed));assert.equal((await p1).state,'CONFIRMED');
  gate2.resolve(json(confirmed));await rejected;assert.equal(writes.length,1);
});

test('disconnect during share resolution discards the link and stops credential-bearing follow-up',async()=>{
  const gate=deferred();let downloadCalls=0;
  const {provider}=setup(async url=>{
    if(url.includes('/account/token'))return json(token);
    if(url.includes('get_share_token'))return gate.promise;
    downloadCalls++;return json({download_url:'https://cdn.example.com/file?signature=private'});
  });
  await provider.token();
  const pending=provider.resolve({shareId:'test',password:''},{id:'file',driveId:'drive'});
  const rejected=assert.rejects(pending,e=>e.status===409&&!e.message.includes('private'));
  await new Promise(resolve=>setImmediate(resolve));provider.clear();
  gate.resolve(json({share_token:'private-share-token'}));await rejected;
  assert.equal(downloadCalls,0);
});
