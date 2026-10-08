import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPortalServer} from '../portal-server.mjs';

const password='Campus-Bridge-Routing-Fixture-2026!';
const request={machine:'gpu-1',project:'paper',area:'code',path:'weight.bin',action:'put',uploadId:'11111111-1111-4111-8111-111111111111',totalSize:4,sha256:'a'.repeat(64)};
async function fixture(t,mode='paired'){
  const dir=await mkdtemp(join(tmpdir(),'file-bridge-route-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[],servers=[];
  const listen=async(name,reply)=>{
    const path=join(dir,name),server=net.createServer(socket=>{
      let raw='';socket.on('data',part=>{raw+=part;});socket.on('end',()=>{
        const value=JSON.parse(raw);calls.push({socket:name,...value});socket.end(JSON.stringify({ok:true,result:reply(value)})+'\n');
      });
    });servers.push(server);await new Promise(resolve=>server.listen(path,resolve));return path;
  };
  const executor=await listen('projects.sock',()=>({entries:[],state:'COMPLETE'}));
  const fileSocket=mode==='paired'?await listen('campus-files.sock',value=>({available:true,protocol:'personal-file-campus-v1',machine:value.machine,
    kind:'campus-direct',routeId:'primary',endpoint:'https://campus.example.edu:18445',certificateSha256:'b'.repeat(64),revision:'c'.repeat(64),grantId:randomUUID(),
    expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576,ticket:'isolated-ticket-'+randomUUID(),file:{}})):mode==='dead'?join(dir,'missing.sock'):undefined;
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port,origins=['https://campus.example.edu:18441','https://campus.example.edu:18445'];
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridgeSocket:executor,personalFileBridgeSocket:fileSocket,directUploadOrigins:JSON.stringify(origins)});
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});const login=await service.login('alice',password);
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await Promise.all(servers.map(item=>new Promise(resolve=>item.close(resolve))));await rm(dir,{recursive:true,force:true});});
  return {calls,service,login,member,origin,origins};
}

test('normal Portal routes only personal prepare to the paired socket and keeps all other control on the original bridge',async t=>{
  const f=await fixture(t),args={...request};const result=await f.service.invoke(f.login.token,'files.direct-ticket',args);
  assert.equal(result.result.available,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].socket,'campus-files.sock');
  assert.equal(f.calls[0].operation,'files.direct.prepare');assert.equal(f.calls[0].args.userId,f.member.id);assert.equal(f.calls[0].args.uploadId,args.uploadId);
  assert.equal(Object.hasOwn(f.calls[0].args,'data'),false);assert.equal(Object.hasOwn(f.calls[0].args,'hostAdmin'),false);
  await f.service.invoke(f.login.token,'files.list',{machine:'gpu-1',project:'paper',path:'.'});
  await f.service.invoke(f.login.token,'files.upload.status',{machine:'gpu-1',project:'paper',path:'weight.bin',totalSize:4,sha256:request.sha256});
  assert.deepEqual(f.calls.map(row=>[row.socket,row.operation]),[['campus-files.sock','files.direct.prepare'],['projects.sock','files.list'],['projects.sock','files.upload.status']]);
  const before=f.calls.length;
  for(const operation of ['files.put','files.get']){
    await assert.rejects(f.service.invoke(f.login.token,operation,{machine:'gpu-1',path:'weight.bin',data:'eA=='}),e=>e.status===410&&e.code==='CAMPUS_FILE_REQUIRED');
    await assert.rejects(f.service.invoke('invalid',operation,{machine:'gpu-1'}),e=>e.status===401);
    await assert.rejects(f.service.invoke(f.login.token,operation,{machine:'gpu-2'}),e=>e.status===403);
  }
  await assert.rejects(f.service.invoke(f.login.token,'files.direct-ticket',{...args,userId:'other-account'}),e=>e.status===400);
  assert.equal(f.calls.length,before);
  const response=await fetch(f.origin),csp=response.headers.get('content-security-policy');assert.equal(response.status,200);
  const connect=csp.split(';').find(value=>value.trim().startsWith('connect-src')).trim();assert.equal(connect,"connect-src 'self' "+f.origins.join(' '));
});

for(const mode of ['unset','dead'])test('a '+mode+' personal bridge returns unknown/unavailable without a legacy bridge fallback or replay',async t=>{
  const f=await fixture(t,mode),args={...request};await assert.rejects(f.service.invoke(f.login.token,'files.direct-ticket',args),e=>e.status===503);
  assert.deepEqual(args,request);assert.deepEqual(f.calls,[]);assert.equal(f.service.personalFileTickets.size,0);
  await f.service.invoke(f.login.token,'files.list',{machine:'gpu-1',project:'paper',path:'.'});assert.deepEqual(f.calls.map(row=>row.operation),['files.list']);
});
