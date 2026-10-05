import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';

const password='Only-A-Test-Password-2026!';
async function setup(){const dir=await mkdtemp(join(tmpdir(),'gpuq-portal-test-'));const bootstrap=join(dir,'bootstrap.json');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});return {dir,bootstrap,database:join(dir,'state.sqlite')};}
test('VPS accounts, policies and hashed login sessions survive restart, no default demo logins or raw tokens',async()=>{
  const data=await setup();let service;
  try{
    service=await PortalService.open(data.database,data.bootstrap);
    await assert.rejects(service.login('admin','AdminDemo!2026'),/用户名或密码错误/);
    const admin=await service.login('admin',password);assert.equal(admin.state.users.length,1);assert.equal(admin.state.demo,false);
    assert.equal(admin.state.gpuqConnected,false);
    const created=await service.invoke(admin.token,'users.create',{username:'persistent-user',password:'Test123456'});
    await service.invoke(admin.token,'policy.save',{userId:created.result.id,limits:{'gpu-1':2},total:2,policyVersion:0});
    const member=await service.login('persistent-user','Test123456');
    await assert.rejects(service.invoke(member.token,'request',{machine:'gpu-1',cards:1}),e=>e.status===503);
    const stored=service.db.prepare('SELECT data FROM portal_state').get().data;
    assert.equal(stored.includes(password),false);assert.equal(stored.includes('Test123456'),false);assert.equal(stored.includes(admin.token),false);
    assert.equal(service.credentials.get('persistent-user').iterations,600000);
    service.close();service=await PortalService.open(data.database); // Bootstrap intentionally absent.
    assert.equal((await service.invoke(member.token,'state')).state.users[0].id,created.result.id);
    const resumed=await service.login('persistent-user','Test123456');
    assert.equal(resumed.state.users[0].total,2);assert.equal(resumed.state.jobs.length,0);
    assert.ok(service.db.prepare('SELECT count(*) AS count FROM audit').get().count>=5);
    const owner=await service.login('admin',password);
    await service.invoke(owner.token,'users.reset',{userId:created.result.id,password:'Changed123'});
    service.close();service=await PortalService.open(data.database);
    await assert.rejects(service.login('persistent-user','Test123456'),/用户名或密码错误/);
    assert.equal((await service.login('persistent-user','Changed123')).principal.role,'member');
  }finally{service?.close();await rm(data.dir,{recursive:true,force:true});}
});

test('VPS HTTPS cookie boundary, CLI bearer API, private server files and production page',async()=>{
  const data=await setup();const origin='https://gpuq.example.test';let server;
  try{
    ({server}=await createPortalServer({...data,origin}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const fetchHost=(path,options={})=>new Promise((resolve,reject)=>{
      const req=request(base+path,{...options,headers:{Host:'gpuq.example.test',...options.headers}},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(Object.entries(res.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(', '):value])),text:async()=>body,json:async()=>JSON.parse(body)}));});
      req.on('error',reject);req.end(options.body);
    });
    const post=async(path,body,headers={})=>{const res=await fetchHost(path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {res,data:await res.json()};};
    const login=await post('/api/login',{username:'admin',password,client:'browser'},{Origin:origin});
    assert.equal(login.res.status,200);assert.equal(login.data.token,undefined);
    const setCookie=login.res.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);
    const cookie=setCookie.split(';')[0];
    assert.match(cookie,/^gpuq_session=/);
    const legacyCookie=cookie.replace('gpuq_session=','amax_session=');
    assert.equal((await post('/api/call',{operation:'state'},{Cookie:legacyCookie,Origin:origin})).res.status,200);
    assert.equal((await post('/api/call',{operation:'state'},{Cookie:cookie})).res.status,403);
    assert.equal((await post('/api/call',{operation:'state'},{Cookie:cookie,Origin:'https://evil.test'})).res.status,403);
    const state=await post('/api/call',{operation:'state'},{Cookie:cookie,Origin:origin});assert.equal(state.data.principal.role,'admin');
    const cli=await post('/api/login',{username:'admin',password});assert.equal(typeof cli.data.token,'string');
    assert.equal((await post('/api/call',{operation:'state'},{Authorization:`Bearer ${cli.data.token}`})).res.status,200);
    for(const path of ['/service.js','/portal.sqlite','/portal-service.mjs','/.git/config'])assert.equal((await fetchHost(path)).status,404);
    for(const path of ['/install.sh','/install.ps1','/gpuctl.mjs','/amaxctl.mjs','/guide/start']){
      const asset=await fetchHost(path);assert.equal(asset.status,200);const body=await asset.text();
      assert.ok(body.includes(origin));assert.equal(body.includes('__GPUQ_PUBLIC_ORIGIN__'),false);
    }
    assert.equal((await fetchHost('/machines.js')).status,200);
    for(const path of ['/guide/admin','/ADMIN_README.md','/docs/DEPLOYMENT.md'])assert.equal((await fetchHost(path)).status,404);
    const pageResponse=await fetchHost('/'),page=await pageResponse.text();
    assert.equal(page.includes('AMAX'),false);assert.match(page,/STARGATE/);
    assert.equal(page.includes('AdminDemo!2026'),false);assert.equal(page.includes('<script src="/runtime.js">'),true);
    const nonce=page.match(/name="gpuq-style-nonce" content="([^"]+)"/)[1];
    assert.ok(pageResponse.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
    assert.equal(pageResponse.headers.get('content-security-policy').includes('unsafe-inline'),false);
    const anotherPage=await(await fetchHost('/')).text();assert.notEqual(anotherPage.match(/name="gpuq-style-nonce" content="([^"]+)"/)[1],nonce);
    const logout=await post('/api/call',{operation:'logout'},{Cookie:cookie,Origin:origin});assert.match(logout.res.headers.get('set-cookie'),/Max-Age=0/);
    assert.match(logout.res.headers.get('set-cookie'),/amax_session=/);assert.match(logout.res.headers.get('set-cookie'),/gpuq_session=/);
    assert.equal((await post('/api/call',{operation:'state'},{Cookie:cookie,Origin:origin})).res.status,401);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(data.dir,{recursive:true,force:true});}
});
