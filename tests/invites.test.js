import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';
const password='A-Local-Test-Password-2026';

async function setup(){const dir=await mkdtemp(join(tmpdir(),'amax-invites-'));const bootstrap=join(dir,'bootstrap.json'),database=join(dir,'state.sqlite');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));return {dir,database,bootstrap};}
test('role comes from invite, ordinary signup has zero grants, secrets are not persisted or exposed',async()=>{
  const data=await setup();let service;
  try{
    service=await PortalService.open(data.database,data.bootstrap);const admin=await service.login('admin',password);
    const {result:{code}}=await service.invoke(admin.token,'invites.rotate',{role:'member'});
    await assert.rejects(service.register({username:'bad-role',password,invite:code,role:'admin'}),/角色/);
    await assert.rejects(service.register({username:'bad-code',password,invite:'no'}),e=>e.status===403);
    await service.register({username:'first-user',password,invite:code});await service.register({username:'second-user',password,invite:code});
    const user=await service.login('first-user',password);assert.equal(user.principal.role,'member');assert.equal(user.state.users[0].total,0);assert.deepEqual(user.state.users[0].limits,{});assert.equal(user.state.invitations,undefined);
    await assert.rejects(service.invoke(user.token,'invites.list'),e=>e.status===403);await assert.rejects(service.invoke(user.token,'invites.rotate',{role:'admin'}),e=>e.status===403);
    const state=await service.invoke(admin.token,'state');assert.equal(JSON.stringify(state).includes(code),false);assert.equal(state.state.invitations[0].uses,2);
    assert.equal((await service.invoke(admin.token,'invites.list')).result.code,code);
    const db=service.db.prepare('SELECT * FROM invites').all();assert.equal(JSON.stringify(db).includes(code),false);assert.equal(db[0].digest.length,64);
    assert.equal(JSON.stringify(service.db.prepare('SELECT * FROM audit').all()).includes(code),false);
    const newCode=(await service.invoke(admin.token,'invites.rotate',{role:'member'})).result.code;
    await assert.rejects(service.register({username:'old-code',password,invite:code}),e=>e.status===403);
    await service.invoke(admin.token,'invites.disable',{role:'member'});
    await assert.rejects(service.register({username:'disabled-code',password,invite:newCode}),e=>e.status===403);
    assert.equal((await service.login('first-user',password)).principal.role,'member');
  }finally{service?.close();await rm(data.dir,{recursive:true,force:true});}
});

test('shared member code is atomic, cannot register admin, state survives restart',async()=>{
  const data=await setup();let service;
  try{
    service=await PortalService.open(data.database,data.bootstrap);const admin=await service.login('admin',password);
    await assert.rejects(service.invoke(admin.token,'invites.rotate',{role:'admin'}),/普通用户邀请码/);
    const code=(await service.invoke(admin.token,'invites.rotate',{role:'member'})).result.code;
    await assert.rejects(service.register({username:'admin',password,invite:code}),/已存在/);
    await assert.rejects(service.register({username:'short-password',password:'bad',invite:code}),/密码/);
    const results=await Promise.allSettled(['new-admin-one','new-admin-two'].map(username=>service.register({username,password,invite:code})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal(results.filter(r=>r.status==='rejected').length,0);
    const username=results.find(r=>r.status==='fulfilled').value.username;
    service.close();service=await PortalService.open(data.database);
    const signedIn=await service.login(username,password);assert.equal(signedIn.principal.role,'member');assert.equal(signedIn.state.users.find(u=>u.username===username).total,0);
    await service.register({username:'third-member',password,invite:code});
    const metadata=service.invitations().find(i=>i.role==='member');assert.equal(metadata.uses,3);assert.equal(metadata.available,true);
    assert.equal(service.invitations().some(i=>i.role==='admin'),false);
    assert.equal((await service.login('admin',password)).principal.role,'admin');
    const owner=await service.login('admin',password);assert.equal((await service.invoke(owner.token,'invites.list')).result.code,code);
  }finally{service?.close();await rm(data.dir,{recursive:true,force:true});}
});

test('public registration API and CLI use the same invitation authority, with origin and rate limits',async()=>{
  const data=await setup();let server;
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  try{
    ({server}=await createPortalServer({...data,origin,secure:false}));await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
    const post=(path,body,headers={})=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    const admin=await(await post('/api/login',{username:'admin',password})).json();
    const invitation=await(await post('/api/call',{operation:'invites.rotate',args:{role:'member'}},{Authorization:`Bearer ${admin.token}`})).json();
    const invite=invitation.result.code;
    assert.equal((await post('/api/register',{username:'foreign-origin',password,invite},{Origin:'https://foreign.invalid'})).status,403);
    const cli=(args,input)=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['cli.mjs',...args,'--url',origin,'--session-file',join(data.dir,'session.json'),'--json'],{cwd:new URL('..',import.meta.url),stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);child.on('error',reject);child.on('exit',code=>{try{assert.equal(code,0,stderr);resolve(JSON.parse(stdout));}catch(e){reject(e);}});child.stdin.end(input||'');
    });
    const registered=await cli(['register','cli-registered','--credentials-stdin'],JSON.stringify({invite,password}));assert.equal(registered.data.role,'member');
    await cli(['login','cli-registered','--password-stdin'],password);const state=await cli(['state']);assert.equal(state.data.users[0].total,0);assert.equal(state.data.invitations,undefined);
    await cli(['logout']);
    const normal=await post('/api/register',{username:'browser-registered',password,invite});assert.equal(normal.status,200);
    assert.equal((await normal.json()).token,undefined);
    for(let i=0;i<3;i++)await post('/api/register',{username:`invalid-code-${i}`,password,invite:'wrong'});
    assert.equal((await post('/api/register',{username:'rate-limit',password,invite})).status,429);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(data.dir,{recursive:true,force:true});}
});
