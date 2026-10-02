import test from 'node:test';
import assert from 'node:assert/strict';
import {AliyunShare} from '../aliyun-share.mjs';

test('share-download uses the upstream web-share canary header',async()=>{
  const calls=[];let saved={refreshToken:'private-refresh'};
  const p=new AliyunShare({load:()=>saved,save:v=>{saved=v;},request:async(url,options)=>{
    calls.push({url,options});
    const value=url.includes('/account/token')?{access_token:'private-access',refresh_token:'rotated',expires_in:3600}:url.includes('/get_share_token')?{share_token:'private-share'}:{download_url:'https://cdn.example/file?private=signed'};
    return Response.json(value);
  }});
  assert.equal(await p.resolve({shareId:'share',password:'pass'},{id:'file',driveId:'drive'}),'https://cdn.example/file?private=signed');
  const request=calls.at(-1);
  assert.equal(request.options.headers['X-Canary'],'client=web,app=share,version=v2.3.1');
  assert.equal(request.options.headers.Authorization,'Bearer private-access');
  assert.equal(request.options.headers['x-share-token'],'private-share');
  assert.equal(request.options.redirect,'error');
});

test('provider errors expose only fixed stage, status and allowlisted code',async()=>{
  for(const status of [200,403]){
    const p=new AliyunShare({load:()=>null,save:()=>{},request:async()=>Response.json({code:'AccessTokenInvalid',message:'SECRET_RAW_BODY',access_token:'SECRET_ACCESS'},{status})});
    await assert.rejects(p.json('https://api.alipan.com/v2/file/get_share_link_download_url?token=SECRET_QUERY',{}),e=>e.status===502&&e.message.includes('分享下载 HTTP '+status)&&e.message.includes('AccessTokenInvalid')&&!e.message.includes('SECRET'));
  }
  for(const code of ['SECRET_TOKEN','https://secret.example/token','AccessTokenInvalid\nSECRET']){
    const p=new AliyunShare({load:()=>null,save:()=>{},request:async()=>Response.json({code,message:'SECRET_MESSAGE'},{status:400})});
    await assert.rejects(p.json('https://auth.alipan.com/v2/account/token',{}),e=>e.message.includes('令牌刷新 HTTP 400')&&!e.message.includes(code)&&!e.message.includes('SECRET'));
  }
});

test('HTML failures, oversized bodies and thrown errors never expose raw upstream data',async()=>{
  const requests=[
    async()=>new Response('SECRET_HTML',{status:502}),
    async()=>new Response('SECRET'+'x'.repeat(1024*1024)),
    async()=>{throw Object.assign(Error('SECRET_URL'),{status:403});},
    async()=>{throw null;},
  ];
  for(const request of requests){
    const p=new AliyunShare({load:()=>null,save:()=>{},request});
    await assert.rejects(p.json('https://unknown.example/SECRET_PATH',{}),e=>e.status===502&&e.message.includes('云盘请求')&&!e.message.includes('SECRET'));
  }
});
