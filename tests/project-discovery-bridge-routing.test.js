import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPortalServer} from '../portal-server.mjs';

const password='Project-Discovery-Bridge-Fixture-2026!';
const original='11111111-1111-4111-8111-111111111111';
const discovery=owner=>({protocol:1,state:'UNCONFIRMED',complete:false,sessions:[{id:original,userId:owner,state:'UNCONFIRMED',requiresStatus:true,attachmentState:'CLOSED',writerLeaseExpired:true,legacy:false}]});
const row=owner=>({project:'paper',state:'DRAFT',environmentMode:'oci',publicationProtocol:1,releases:[],latestReadyRelease:null,lifecycle:{state:'ACTIVE',revision:4},codeSync:{state:'CODE_READY'},developmentTerminals:discovery(owner)});
async function fixture(t,mode='paired'){
  const dir=await mkdtemp(join(tmpdir(),'project-discovery-route-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[],servers=[];let pending;
  t.after(async()=>{await Promise.all(servers.filter(server=>server.listening).map(server=>new Promise(resolve=>server.close(resolve))));await rm(dir,{recursive:true,force:true});});
  const listen=async(name,reply)=>{
    const path=join(dir,name),server=net.createServer({allowHalfOpen:true},socket=>{
      let raw='';socket.on('data',part=>{raw+=part;});socket.on('end',async()=>{
        const value=JSON.parse(raw);calls.push({socket:name,...value});
        try{socket.end(JSON.stringify({ok:true,result:await reply(value,raw)})+'\n');}
        catch(error){socket.end(JSON.stringify({ok:false,error:error.message,status:error.status||503})+'\n');}
      });
    });servers.push(server);await new Promise(resolve=>server.listen(path,resolve));return path;
  };
  const old=await listen('projects.sock',value=>value.operation==='projects.quota'?{owner:value.args.userId,enabled:false,enforcement:null,volumes:null}:value.operation==='projects.list'?{projects:[{project:'paper',state:'DRAFT'}],environmentModes:['oci']}:value.operation==='projects.status'?{project:'paper',state:'DRAFT'}:{entries:[],state:'UNKNOWN'});
  const forward=raw=>new Promise((resolve,reject)=>{const socket=net.createConnection(old);let reply='';socket.on('error',reject);socket.on('connect',()=>socket.end(raw));socket.on('data',part=>{reply+=part;});socket.on('end',()=>resolve(JSON.parse(reply).result));});
  const campus=mode==='paired'?await listen('campus-files.sock',async(value,raw)=>{
    if(pending)await pending(value);
    // The independent outer bridge owns machine selection and one legacy
    // fallback. Portal always dispatches one original frame to this socket.
    if(value.machine!=='gpu-1')return forward(raw);
    return value.operation==='projects.list'?{projects:[row(value.args.userId)],environmentModes:['oci'],discoverySource:'paired'}:row(value.args.userId);
  }):mode==='dead'?join(dir,'absent.sock'):undefined;
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridgeSocket:old,personalFileBridgeSocket:campus});
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password);
  const create=async username=>{const member=(await service.invoke(admin.token,'users.create',{username,password})).result;await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});return {member,login:await service.login(username,password)};};
  const alice=await create('alice'),bob=await create('bob'),zero=(await service.invoke(admin.token,'users.create',{username:'zero',password})).result,zeroLogin=await service.login('zero',password);
  const call=(operation,args={},token=alice.login.token)=>service.invoke(token,operation,{machine:'gpu-1',...args});
  const http=async(operation,args,token=alice.login.token)=>{const response=await fetch(origin+'/api/call',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({operation,args})});return {status:response.status,body:await response.json()};};
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {calls,service,admin,alice,bob,zero,zeroLogin,call,http,pending:value=>{pending=value;}};
}

test('normal HTTP project status and list preserve original discovery and all project fields through the paired bridge',async t=>{
  const f=await fixture(t);
  for(const operation of ['projects.status','projects.list']){
    const args={machine:'gpu-1',...(operation==='projects.status'?{project:'paper'}:{})},response=await f.http(operation,args);
    assert.equal(response.status,200);const result=response.body.result,actual=operation==='projects.list'?result.projects[0]:result;
    for(const [key,value] of Object.entries(row(f.alice.member.id)))assert.deepEqual(actual[key],value);
    assert.equal(actual.displayName,'paper');assert.equal(actual.developmentTerminals.sessions[0].id,original);
    if(operation==='projects.list'){assert.equal(result.discoverySource,'paired');assert.deepEqual(result.environmentModes,['oci']);}
  }
  assert.deepEqual(f.calls.map(value=>[value.socket,value.operation]),[['campus-files.sock','projects.status'],['campus-files.sock','projects.list']]);
  assert.deepEqual(f.calls.map(value=>value.args),[{project:'paper',userId:f.alice.member.id},{userId:f.alice.member.id}]);
  assert.equal(f.calls.some(value=>value.operation.startsWith('terminal.')||/publish|create|lease/.test(value.operation)),false);
});

test('catalog and owner presentation proof reads use paired discovery without widening identity or invoking terminal actions',async t=>{
  const f=await fixture(t),result=(await f.service.invoke(f.alice.login.token,'projects.catalog',{})).result;
  assert.equal(result.partial,false);assert.deepEqual(result.groups[0].instances[0].developmentTerminals,discovery(f.alice.member.id));
  await f.call('projects.label.get',{project:'paper'});
  const other=(await f.call('projects.status',{project:'paper'},f.bob.login.token)).result;
  assert.deepEqual(other.developmentTerminals,discovery(f.bob.member.id));assert.notEqual(f.bob.member.id,f.alice.member.id);
  assert.deepEqual(f.calls.map(value=>[value.socket,value.operation]),[['campus-files.sock','projects.list'],['campus-files.sock','projects.status'],['campus-files.sock','projects.status']]);
  const before=f.calls.length;
  for(const operation of ['projects.status','projects.list']){
    const args=operation==='projects.status'?{project:'paper'}:{};
    for(const extra of [{userId:f.bob.member.id},{hostAdmin:true},{machine:'gpu-2'}])await assert.rejects(f.call(operation,{...args,...extra}),error=>[400,403].includes(error.status));
    await assert.rejects(f.call(operation,args,f.zeroLogin.token),error=>error.status===403);
    await assert.rejects(f.call(operation,args,'invalid'),error=>error.status===401);
  }
  assert.equal(f.calls.length,before);
});

for(const mode of ['unset','dead'])test(mode+' paired bridge leaves original project queries unconfirmed and never uses the old socket',async t=>{
  const f=await fixture(t,mode);
  for(const operation of ['projects.status','projects.list']){
    const args={machine:'gpu-1',...(operation==='projects.status'?{project:'paper'}:{})},before=structuredClone(args),response=await f.http(operation,args);
    assert.equal(response.status,503);assert.equal(Object.hasOwn(response.body,'result'),false);assert.deepEqual(args,before);
  }
  const catalog=(await f.service.invoke(f.alice.login.token,'projects.catalog',{})).result;assert.equal(catalog.partial,true);assert.deepEqual(catalog.groups,[]);
  assert.deepEqual(f.calls,[]);
  await f.call('projects.quota');assert.deepEqual(f.calls.map(value=>[value.socket,value.operation]),[['projects.sock','projects.quota']]);
});

test('other machines are dispatched once to the paired bridge and the outer adapter forwards their exact owner frame once',async t=>{
  const f=await fixture(t);await f.service.invoke(f.admin.token,'policy.save',{userId:f.alice.member.id,policyVersion:1,total:1,limits:{'gpu-2':1}});
  for(const operation of ['projects.status','projects.list'])await f.call(operation,{machine:'gpu-2',...(operation==='projects.status'?{project:'paper'}:{})});
  assert.deepEqual(f.calls.map(value=>[value.socket,value.operation]),[['campus-files.sock','projects.status'],['projects.sock','projects.status'],['campus-files.sock','projects.list'],['projects.sock','projects.list']]);
  for(let index=0;index<f.calls.length;index+=2){const {socket,...a}=f.calls[index],{socket:ignored,...b}=f.calls[index+1];assert.deepEqual(a,b);assert.equal(a.args.userId,f.alice.member.id);assert.equal(a.machine,'gpu-2');}
});

for(const operation of ['projects.status','projects.list'])test(operation+' preserves the normal mutation queue and rejects queries after revocation',async t=>{
  const f=await fixture(t);let release,entered;
  const dispatched=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});f.pending(async()=>{entered();await gate;});
  const args=operation==='projects.status'?{project:'paper'}:{},query=f.call(operation,args);await dispatched;
  let revoked=false;const mutation=f.service.invoke(f.admin.token,'policy.save',{userId:f.alice.member.id,policyVersion:1,total:0,limits:{}}).then(()=>{revoked=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(revoked,false);release();await query;await mutation;assert.equal(revoked,true);
  assert.deepEqual(f.calls.map(value=>[value.socket,value.operation]),[['campus-files.sock',operation]]);
  await assert.rejects(f.call(operation,args),error=>error.status===403);assert.equal(f.calls.length,1);
});

test('unrelated read and control operations keep the old socket and personal relay guard stays closed',async t=>{
  const f=await fixture(t);
  for(const [operation,args] of [['projects.quota',{}],['files.list',{project:'paper',path:'.'}],['files.upload.status',{project:'paper',path:'weight.bin',totalSize:4,sha256:'a'.repeat(64)}],['projects.retire.plan',{project:'paper'}],['projects.local-import.status',{project:'paper',key:original}]])await f.call(operation,args);
  assert.equal(f.calls.length,5);assert.ok(f.calls.every(value=>value.socket==='projects.sock'));
  await assert.rejects(f.call('files.get',{project:'paper',path:'weight.bin'}),error=>error.status===410&&error.code==='CAMPUS_FILE_REQUIRED');assert.equal(f.calls.length,5);
});
