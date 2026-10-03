import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {LOGIN_POLICY} from '../login-sessions.mjs';
const password='Persistent-HTTP-Fixture-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-persistent-login-')),bootstrap=join(dir,'bootstrap'),database=join(dir,'db');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port;let server,service;
  const start=async()=>{({server,service}=await createPortalServer({database,bootstrap,origin,secure:false}));await new Promise(r=>server.listen(port,'127.0.0.1',r));};
  await start();t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const post=async(path,body,headers={})=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,data:await response.json(),headers:response.headers};};
  return {dir,origin,post,get service(){return service;},restart:async()=>{await new Promise(r=>server.close(r));await start();}};
}
test('browser cookie and unchanged standalone CLI cache survive nine hours and Portal restart',async t=>{
  const f=await fixture(t),web=await f.post('/api/login',{username:'admin',password,client:'browser'},{Origin:f.origin});
  assert.equal(web.data.token,undefined);const setCookie=web.headers.get('set-cookie'),cookie=setCookie.split(';')[0];
  assert.match(setCookie,new RegExp('Max-Age='+LOGIN_POLICY.cookieSeconds));assert.match(setCookie,/HttpOnly; SameSite=Strict/);
  const file=join(f.dir,'gpuctl.mjs'),session=join(f.dir,'session.json');await writeFile(file,await(await fetch(f.origin+'/gpuctl.mjs')).text());
  const cli=(...args)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[file,'--url',f.origin,'--session-file',session,'--json',...args]);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>resolve({code,out,err,data:out?JSON.parse(out).data:null}));child.stdin.end(args[0]==='login'?password+'\n':'');});
  const signed=await cli('login','admin','--password-stdin');assert.equal(signed.code,0,signed.err);const original=await readFile(session,'utf8');assert.ok(!original.includes(password));
  let clock=Date.now()+9*3600_000;f.service.loginSessions.now=()=>clock;
  const state=await f.post('/api/call',{operation:'state'},{Cookie:cookie,Origin:f.origin});assert.equal(state.status,200);assert.equal(state.headers.get('set-cookie'),null);
  assert.equal((await cli('state')).code,0);await f.restart();f.service.loginSessions.now=()=>clock;
  assert.equal((await f.post('/api/call',{operation:'state'},{Cookie:cookie,Origin:f.origin})).status,200);
  assert.equal((await cli('state')).code,0);assert.equal(await readFile(session,'utf8'),original);
  await f.post('/api/call',{operation:'logout'},{Cookie:cookie,Origin:f.origin});await f.restart();
  assert.equal((await f.post('/api/call',{operation:'state'},{Cookie:cookie,Origin:f.origin})).status,401);
  assert.equal((await cli('state')).code,0,'browser logout does not revoke a separate CLI credential');
  clock=Date.now()+LOGIN_POLICY.idleMs+10*3600_000;f.service.loginSessions.now=()=>clock;
  const expired=await cli('state');assert.equal(expired.code,1);assert.match(expired.err,/重新登录/);
});
test('password reset, role changes and suspension stay revoked after service restarts',async t=>{
  const f=await fixture(t),a=(await f.post('/api/login',{username:'admin',password})).data,call=async(token,operation,args={})=>f.post('/api/call',{operation,args},{Authorization:'Bearer '+token});
  const user=(await call(a.token,'users.create',{username:'member',password})).data.result,logins=[];
  for(let i=0;i<2;i++)logins.push((await f.post('/api/login',{username:'member',password})).data.token);
  await call(a.token,'users.reset',{userId:user.id,password:'Changed-Member-Pass-2026!'});await f.restart();
  for(const token of logins)assert.equal((await call(token,'state')).status,401);
  let member=(await f.post('/api/login',{username:'member',password:'Changed-Member-Pass-2026!'})).data;
  await call(a.token,'users.role',{userId:user.id,role:'admin'});assert.equal((await call(member.token,'state')).status,401);
  member=(await f.post('/api/login',{username:'member',password:'Changed-Member-Pass-2026!'})).data;
  await call(a.token,'users.role',{userId:user.id,role:'member'});await f.restart();assert.equal((await call(member.token,'state')).status,401);
  member=(await f.post('/api/login',{username:'member',password:'Changed-Member-Pass-2026!'})).data;
  await call(a.token,'users.enabled',{userId:user.id,enabled:false});await f.restart();assert.equal((await call(member.token,'state')).status,401);
  await call(a.token,'users.enabled',{userId:user.id,enabled:true});assert.equal((await call(member.token,'state')).status,401);
});
test('failed login audit never leaves an undisclosed live credential',async t=>{
  const f=await fixture(t);f.service.db.exec("CREATE TRIGGER fail_login_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  const login=await f.post('/api/login',{username:'admin',password});assert.equal(login.status,400);assert.equal(login.data.token,undefined);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM login_sessions').get().n,0);
});
