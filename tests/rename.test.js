import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash,createCipheriv} from 'node:crypto';
import {spawn} from 'node:child_process';
import {PortalService} from '../portal-service.mjs';
import {createServer} from '../server.mjs';
import {DEMO_ADMIN} from '../dist/service.js';

test('rename preserves legacy encrypted invitation and only explicit rotation changes it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-rename-')),db=join(dir,'db'),bootstrap=join(dir,'bootstrap'),password='Test-Only-Rename-Password';let service;
  try{
    await writeFile(bootstrap,JSON.stringify({username:'admin',password}));service=await PortalService.open(db,bootstrap);
    const code='AMAX-U-local-legacy-fixture-only',nonce=randomBytes(12),key=await readFile(db+'.invite-key');
    const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('amax-invite-v1'));const data=Buffer.concat([cipher.update(code),cipher.final()]);
    const encrypted=Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('base64');
    service.db.prepare('INSERT INTO invites(role,digest,enabled,uses,max_uses,created_at,code_cipher) VALUES(?,?,1,0,NULL,?,?)').run('member',createHash('sha256').update(code).digest('hex'),new Date().toISOString(),encrypted);
    service.close();service=await PortalService.open(db);
    const admin=await service.login('admin',password);assert.equal((await service.invoke(admin.token,'invites.list')).result.code,code);
    await service.register({username:'legacy-member',password,invite:code});
    const fresh=(await service.invoke(admin.token,'invites.rotate',{role:'member'})).result.code;assert.match(fresh,/^GPUQ-U-/);
    await assert.rejects(service.register({username:'old-code-user',password,invite:code}),e=>e.status===403);
    assert.equal((await service.login('legacy-member',password)).principal.role,'member');
  }finally{service?.close();await rm(dir,{recursive:true,force:true});}
});

test('gpuctl reuses old cache and selected machine; new environment names take precedence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-cli-rename-')),server=await createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  const legacy=join(dir,'.config/amax-demo/session.json'),fresh=join(dir,'.config/gpuq-console/session.json');
  const cli=(args,overrides={})=>new Promise((resolve,reject)=>{
    const env={...process.env,HOME:dir};for(const k of ['GPUQ_URL','AMAX_URL','GPUQ_SESSION_FILE','AMAX_SESSION_FILE'])delete env[k];Object.assign(env,overrides);
    const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--json',...args],{env});let out='',err='';
    child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.end();
  });
  try{
    const login=await(await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(DEMO_ADMIN)})).json();
    await mkdir(join(dir,'.config/amax-demo'),{recursive:true});await writeFile(legacy,JSON.stringify({url,token:login.token,principal:login.principal,machine:'gpu-1'}),{mode:0o600});
    const state=await cli(['state']);assert.equal(state.code,0,state.err);await assert.rejects(access(fresh));
    assert.equal((await cli(['use','2'])).code,0);assert.equal(JSON.parse(await readFile(legacy,'utf8')).machine,'gpu-2');
    const current=await cli(['state'],{GPUQ_URL:url,AMAX_URL:'https://unused.invalid',GPUQ_SESSION_FILE:legacy,AMAX_SESSION_FILE:join(dir,'absent')});assert.equal(current.code,0,current.err);
    const previous=await cli(['state'],{AMAX_URL:url,AMAX_SESSION_FILE:legacy});assert.equal(previous.code,0,previous.err);
    assert.equal((await cli(['logout'])).code,0);await assert.rejects(access(legacy));
  }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
