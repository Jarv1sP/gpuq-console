import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';
import net from 'node:net';
const password='Campus-Files-Test-Long-Password-2026',context={machine:'gpu-1',project:'paper',area:'code',path:'weight.bin',action:'put',uploadId:'11111111-1111-4111-8111-111111111111',totalSize:4,sha256:'a'.repeat(64)};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'campus-file-api-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[];let proof;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args});if(proof)await proof();
    // Staged Portal keeps existing relay until the separately paired HTTPS node is released.
    if(['files.put','files.get'].includes(operation)){assert.equal(Object.hasOwn(args,'hostAdmin'),false);assert.equal(typeof args.userId,'string');return operation==='files.get'?{data:'eA==',eof:true}:{written:1};}
    assert.equal(operation,'files.direct.prepare');assert.equal(Object.hasOwn(args,'data')||Object.hasOwn(args,'bytes'),false);
    return {available:true,protocol:'personal-file-campus-v1',machine,kind:'campus-direct',routeId:'primary',endpoint:'https://campus.example.edu:18444',certificateSha256:'b'.repeat(64),revision:'c'.repeat(64),grantId:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576,ticket:'test-capability-'+randomUUID(),file:{path:args.path,protocol:2,fingerprint:'d'.repeat(64),size:4}};
  };
  const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);clearInterval(service.executionTimer);
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const login=await service.login('alice',password);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {service,admin,member,login,calls,proof:callback=>{proof=callback;},ticket:async args=>(await service.invoke(login.token,'files.direct-ticket',{...context,...args})).result};
}

test('personal campus ticket uses authenticated owner while staged old relay remains available until node pairing',async t=>{
  const f=await fixture(t),grant=await f.ticket();
  assert.equal(f.calls.at(-1).args.userId,f.member.id);assert.deepEqual(f.service.checkPersonalFileTicket({ticket:grant.ticket}),{allowed:true,protocol:'personal-file-campus-v1'});
  for(const operation of ['files.put','files.get']){const args={machine:context.machine,project:context.project,area:'code',path:context.path,offset:0,...(operation==='files.put'?{data:'eA==',uploadId:context.uploadId,totalSize:4,sha256:context.sha256,final:false}:{})};const result=await f.service.invoke(f.login.token,operation,args);assert.ok(result.result);assert.equal(f.calls.at(-1).operation,operation);assert.equal(f.calls.at(-1).args.userId,f.member.id);}
  const before=f.calls.length;
  for(const change of [{hostAdmin:true},{userId:'builtin-admin'},{machine:'gpu-2'},{project:undefined},{routeId:'tail'},{endpoint:'https://other.example'},{path:'../escape'},{totalSize:true},{area:'output',runId:randomUUID()}])await assert.rejects(f.ticket(change));
  assert.equal(f.calls.length,before);
});

test('live control authority rejects role, permission, logout and maintenance changes, including issued tickets',async t=>{
  for(const mutation of ['role','permission','logout','maintenance']){
    const f=await fixture(t),grant=await f.ticket();
    if(mutation==='role')f.service.store.users.find(user=>user.id===f.member.id).role='admin';
    if(mutation==='permission')await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:1,total:0,limits:{}});
    if(mutation==='logout')await f.service.invoke(f.login.token,'logout',{});
    if(mutation==='maintenance')await f.service.invoke(f.admin.token,'maintenance.set',{scope:'all',enabled:true,reason:'isolated fixture',revision:f.service.operationalMaintenance(f.admin.principal).revision});
    assert.throws(()=>f.service.checkPersonalFileTicket({ticket:grant.ticket}));
  }
});

test('an authorization change while node proof waits yields no usable campus ticket',async t=>{
  const f=await fixture(t);f.proof(()=>{f.service.store.setEnabled(f.member.id,false);});
  await assert.rejects(f.ticket(),error=>[401,403].includes(error.status));assert.equal(f.service.personalFileTickets.size,0);
});

test('output ticket remains bound to exact own run on actual executing machine, never administrator discovery',async t=>{
  const f=await fixture(t),runId=randomUUID();
  f.service.store.jobs.push({id:runId,userId:f.member.id,machine:'gpu-1',project:'paper',spec:{userId:f.member.id,project:'paper',release:'e'.repeat(64)}});
  const args={machine:'gpu-1',project:'paper',area:'output',runId,path:'result.bin',action:'get'};
  const grant=(await f.service.invoke(f.login.token,'files.direct-ticket',args)).result;
  assert.equal(f.service.checkPersonalFileTicket({ticket:grant.ticket}).allowed,true);
  await assert.rejects(f.service.invoke(f.admin.token,'files.direct-ticket',args),error=>error.status===403);
  f.service.store.jobs.at(-1).spec.release='f'.repeat(64);
  assert.throws(()=>f.service.checkPersonalFileTicket({ticket:grant.ticket}));
});

test('actual Portal HTTP control callback accepts only a current capability and never dispatches file bodies',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'campus-file-http-')),bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));const origin='http://127.0.0.1:'+port;
  const calls=[],descriptor={available:true,protocol:'personal-file-campus-v1',machine:'gpu-1',kind:'campus-direct',routeId:'primary',endpoint:'https://campus.example.edu:18444',certificateSha256:'b'.repeat(64),revision:'c'.repeat(64),grantId:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576,ticket:'test-capability-'+randomUUID(),file:{}};
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async(machine,operation,args)=>{calls.push({machine,operation,args});if(['files.put','files.get'].includes(operation))return operation==='files.get'?{data:'eA==',eof:true}:{written:1};assert.equal(operation,'files.direct.prepare');assert.equal(Object.hasOwn(args,'data'),false);return descriptor;}});
  clearInterval(service.executionTimer);service.store.users[0].limits={'gpu-1':1};await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const post=async(path,body,token)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const login=await post('/api/login',{username:'admin',password});assert.equal(login.status,200);const token=login.data.token;
  const ticket=await post('/api/call',{operation:'files.direct-ticket',args:context},token);assert.equal(ticket.status,200);assert.equal(Object.hasOwn(ticket.data,'state'),false);
  const check=await post('/api/files/direct-check',{ticket:descriptor.ticket});assert.deepEqual(check,{status:200,data:{allowed:true,protocol:'personal-file-campus-v1'}});
  assert.equal((await post('/api/files/direct-check',{ticket:descriptor.ticket,data:'forbidden'})).status,403);
  const before=calls.length;assert.equal((await post('/api/files/direct-check',{ticket:descriptor.ticket,padding:'x'.repeat(8192)})).status,413);assert.equal(calls.length,before);
  for(const operation of ['files.put','files.get']){const args={machine:context.machine,project:context.project,area:'code',path:context.path,offset:0,...(operation==='files.put'?{data:'eA==',uploadId:context.uploadId,totalSize:4,sha256:context.sha256,final:false}:{})};assert.equal((await post('/api/call',{operation,args},token)).status,200);}
  assert.equal(calls.length,3);await post('/api/call',{operation:'logout',args:{}},token);assert.equal((await post('/api/files/direct-check',{ticket:descriptor.ticket})).status,403);
});
