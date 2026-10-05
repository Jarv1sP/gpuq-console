import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';

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
    assert.equal(login.res.headers.get('cache-control'),'private, no-store');
    const setCookie=login.res.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);
    const cookie=setCookie.split(';')[0];
    assert.match(cookie,/^gpuq_session=/);
    const legacyCookie=cookie.replace('gpuq_session=','amax_session=');
    assert.equal((await post('/api/call',{operation:'state'},{Cookie:legacyCookie,Origin:origin})).res.status,200);
    assert.equal((await post('/api/call',{operation:'state'},{Cookie:cookie})).res.status,403);
    assert.equal((await post('/api/call',{operation:'state'},{Cookie:cookie,Origin:'https://evil.test'})).res.status,403);
    const state=await post('/api/call',{operation:'state'},{Cookie:cookie,Origin:origin});assert.equal(state.data.principal.role,'admin');
    assert.equal(state.res.headers.get('cache-control'),'private, no-store');
    const cli=await post('/api/login',{username:'admin',password});assert.equal(typeof cli.data.token,'string');
    assert.equal((await post('/api/call',{operation:'state'},{Authorization:`Bearer ${cli.data.token}`})).res.status,200);
    for(const path of ['/service.js','/portal.sqlite','/portal-service.mjs','/.git/config'])assert.equal((await fetchHost(path)).status,404);
    for(const path of ['/install.sh','/install.ps1','/gpuctl.mjs','/amaxctl.mjs','/guide/start']){
      const asset=await fetchHost(path);assert.equal(asset.status,200);const body=await asset.text();
      assert.ok(body.includes(origin));assert.equal(body.includes('__GPUQ_PUBLIC_ORIGIN__'),false);
    }
    for(const method of ['GET','HEAD']){
      for(const headers of [{},{Cookie:'gpuq_session='+'0'.repeat(64)},{Cookie:'amax_session=malformed'},{Authorization:'Bearer '+'0'.repeat(64)},{Cookie:cookie,Authorization:'Bearer '+'0'.repeat(64)}]){
        const asset=await fetchHost('/machines.js?cache=inventory',{method,headers});
        assert.equal(asset.status,401);assert.equal(await asset.text(),'');
        assert.equal(asset.headers.get('cache-control'),'private, no-store');
        assert.equal(asset.headers.get('content-length'),'0');
        assert.equal(asset.headers.get('set-cookie'),null,'An inventory denial must not overwrite a newer login cookie');
      }
      for(const headers of [{Cookie:cookie},{Cookie:legacyCookie},{Authorization:`Bearer ${cli.data.token}`}]){
        const asset=await fetchHost('/machines.js',{method,headers});
        assert.equal(asset.status,200);assert.equal(asset.headers.get('cache-control'),'private, no-store');
        assert.match(asset.headers.get('content-type'),/^text\/javascript/);
        if(method==='GET')assert.equal(await asset.text(),await readFile(new URL('../dist/machines.js',import.meta.url),'utf8'));
        else assert.equal(await asset.text(),'');
      }
    }
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
    for(const method of ['GET','HEAD']){
      const asset=await fetchHost('/machines.js',{method,headers:{Cookie:cookie}});
      assert.equal(asset.status,401);assert.equal(await asset.text(),'');
    }
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(data.dir,{recursive:true,force:true});}
});

test('inventory requires a current enabled principal; public maintenance HTML exposes only the global reason',async()=>{
  const data=await setup();let server;
  try{
    const portal=await createPortalServer({...data,origin:'http://127.0.0.1:1',secure:false});server=portal.server;
    // Exercise host validation through an explicit public Host header.
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port,service=portal.service;
    const get=(path,token,method='GET')=>new Promise((resolve,reject)=>{
      const req=request(`http://127.0.0.1:${port}${path}`,{method,headers:{Host:'127.0.0.1:1',...(token?{Cookie:`gpuq_session=${token}`}:{})}},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();
    });
    const admin=await service.login('admin',password);
    const member=(await service.invoke(admin.token,'users.create',{username:'inventory-member',password})).result;
    const login=await service.login(member.username,password);
    assert.equal((await get('/machines.js',login.token)).status,200,'zero quota still permits the authenticated capacity directory');
    for(const change of [
      ()=>service.loginSessions.now=()=>Date.now()+31*86400_000,
      ()=>service.store.users.find(user=>user.id===member.id).enabled=false,
      ()=>service.store.users.find(user=>user.id===member.id).role='admin',
    ]){
      const actor=service.store.users.find(user=>user.id===member.id);actor.enabled=true;actor.role='member';service.loginSessions.now=()=>Date.now();
      const fresh=await service.login(member.username,password);change();
      for(const method of ['GET','HEAD']){
        const asset=await get('/machines.js',fresh.token,method);
        assert.equal(asset.status,401);assert.equal(asset.body,'');assert.equal(asset.headers['cache-control'],'private, no-store');
      }
    }
    service.loginSessions.now=()=>Date.now();
    const root=await service.login('admin',password),reason='存储检查 <script>原文 & 保留</script>';
    await service.invoke(root.token,'maintenance.set',{scope:MACHINES[0].id,enabled:true,reason:'单台维护私有原因',revision:0});
    let html=(await get('/')).body;assert.ok(!html.includes('单台维护私有原因'));
    await service.invoke(root.token,'maintenance.set',{scope:'all',enabled:true,reason,revision:1});
    for(const path of ['/','/index.html']){
      html=(await get(path)).body;assert.match(html,/存储检查 &lt;script&gt;原文 &amp; 保留&lt;\/script&gt;/);
      assert.ok(!html.includes(reason));assert.ok(!html.includes('单台维护私有原因'));
      for(const machine of MACHINES)assert.ok(!html.includes(machine.id));
      assert.ok(!html.includes('operationalMaintenance'));
    }
    assert.equal((await get('/guide')).status,200);
    const runtime=await get('/runtime.js');assert.equal(runtime.status,200);assert.match(runtime.body,/GPUQ_HAS_SESSION=false;/);
    assert.equal(runtime.headers['cache-control'],'private, no-store');
    assert.match((await get('/runtime.js',root.token)).body,/GPUQ_HAS_SESSION=true;/);
    const invalid=await get('/runtime.js','0'.repeat(64));assert.equal(invalid.status,200);assert.match(invalid.body,/GPUQ_HAS_SESSION=false;/);
    assert.equal(invalid.headers['set-cookie'],undefined);
  }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(data.dir,{recursive:true,force:true});}
});

test('late runtime hints from another tab never erase a newer login cookie',async()=>{
  const data=await setup(),origin='http://127.0.0.1:1',cookies=new Map();let server,release;
  try{
    ({server}=await createPortalServer({...data,origin,secure:false}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    // Two HTTP clients share the same browser cookie jar. Apply cookies when
    // headers actually arrive, not in the order the requests were submitted.
    const tab=(path,options={})=>new Promise((resolve,reject)=>{
      const req=request(base+path,{...options,headers:{Host:'127.0.0.1:1',Cookie:[...cookies].map(([name,value])=>`${name}=${value}`).join('; '),...options.headers}},res=>{
        for(const value of res.headers['set-cookie']||[]){
          const [pair]=value.split(';'),index=pair.indexOf('='),name=pair.slice(0,index);
          if(/(?:^|;)\s*Max-Age=0(?:;|$)/i.test(value))cookies.delete(name);else cookies.set(name,pair.slice(index+1));
        }
        let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);
        res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
      });req.on('error',reject);req.end(options.body);
    });
    let held;
    server.prependListener('request',(req,res)=>{
      if(!req.url.startsWith('/runtime.js?late='))return;
      const writeHead=res.writeHead.bind(res),end=res.end.bind(res);let head;
      res.writeHead=(...args)=>{head=args;return res;};
      res.end=(body)=>{held.ready();held.gate.then(()=>{writeHead(...head);end(body);});return res;};
    });
    for(const method of ['GET','HEAD']){
      let ready;const captured=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve);
      held={ready,gate};cookies.set('gpuq_session','0'.repeat(64));
      const old=tab(`/runtime.js?late=${method}`,{method});await captured;
      const login=await tab('/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password,client:'browser'})});
      assert.equal(login.status,200);const fresh=cookies.get('gpuq_session');assert.match(fresh,/^[a-f0-9]{64}$/);
      release();const late=await old;
      assert.equal(late.status,200);assert.equal(late.headers['set-cookie'],undefined,'A read-only hint must not delete another tab\'s newer login');
      assert.equal(cookies.get('gpuq_session'),fresh);
      if(method==='GET')assert.match(late.body,/GPUQ_HAS_SESSION=false;/);else assert.equal(late.body,'');
      const state=await tab('/api/call',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({operation:'state',args:{}})});
      assert.equal(state.status,200);assert.equal(JSON.parse(state.body).principal.role,'admin');
    }
    const logout=await tab('/api/call',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({operation:'logout',args:{}})});
    assert.equal(logout.status,200);assert.equal(cookies.has('gpuq_session'),false,'Explicit logout still clears the shared cookie');
    assert.ok(logout.headers['set-cookie'].every(value=>value.includes('Max-Age=0')));
  }finally{release?.();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(data.dir,{recursive:true,force:true});}
});
