import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise}};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'cloud-lane-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Cloud-Lane-Test-Password-2026'}));
  const calls=[];let bridge=async()=>({state:'QUEUED'});
  const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(...args)=>{calls.push(args);return bridge(...args)});
  clearInterval(service.executionTimer);
  service.store.users.push({id:'member',username:'member',name:'Member',role:'member',enabled:true,limits:{'gpu-1':1},total:1});
  for(const [token,userId,username,role] of [['owner','builtin-admin','admin','admin'],['member','member','member','member']])service.sessions.set(token,{userId,username,role,expires:Date.now()+60000});
  service.cloudProvider={connected:()=>true,clear(){},list:async()=>[{id:'file',size:4,name:'a.zip',driveId:'d'}],resolve:async()=> 'https://example.test/download'};
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true})});
  return {service,calls,bridge:fn=>bridge=fn,call:(op,args={},token='member')=>service.invoke(token,op,args)};
}
test('public invoke dispatches cloud operations and returns compact response',async t=>{
  const f=await fixture(t);assert.equal((await f.call('cloud.info')).result.nodeDirect,true);
  const args={machine:'gpu-1',key:randomUUID(),url:'https://example.test/f',path:'a.zip'};
  assert.equal((await f.call('cloud.import.start',args)).result.state,'QUEUED');
  assert.equal(f.calls[0][1],'datasets.import.start');assert.equal(f.calls[0][2].userId,'member');
  await assert.rejects(f.call('cloud.auth.begin'),e=>e.status===403);
});
test('slow share parsing does not block account mutation queue and revocation fences its result',async t=>{
  const f=await fixture(t),wait=deferred();f.service.cloudProvider.list=()=>wait.promise;
  const pending=f.call('cloud.inspect',{machine:'gpu-1',url:'https://www.alipan.com/s/abcd1234'});
  assert.equal(f.service.pending,0);assert.equal(f.service.cloudPending,1);
  let queued=false;await f.service.enqueue(async()=>{queued=true});assert.equal(queued,true);
  f.service.store.users.find(u=>u.id==='member').enabled=false;
  wait.resolve([{id:'file',size:4,name:'a.zip'}]);await assert.rejects(pending,e=>e.status===403);
  assert.equal(f.service.cloudInspections.size,0);assert.equal(f.service.cloudPending,0);
});
test('quota revocation during short-link resolution prevents node dispatch',async t=>{
  const f=await fixture(t),wait=deferred();const scan=(await f.call('cloud.inspect',{machine:'gpu-1',url:'https://www.alipan.com/s/abcd1234'})).result;
  f.service.cloudProvider.resolve=()=>wait.promise;
  const pending=f.call('cloud.import.start',{machine:'gpu-1',key:randomUUID(),path:'a.zip',inspectionId:scan.inspectionId,fileId:'file'});
  f.service.store.users.find(u=>u.id==='member').limits={};wait.resolve('https://example.test/f');
  await assert.rejects(pending,e=>e.status===403);assert.equal(f.calls.length,0);
});
test('same operation has one dispatcher and bounded cloud requests never queue indefinitely',async t=>{
  const f=await fixture(t),wait=deferred();f.bridge(()=>wait.promise);
  const args={machine:'gpu-1',key:randomUUID(),url:'https://example.test/f',path:'a.zip'};
  const first=f.call('cloud.import.start',args);await assert.rejects(f.call('cloud.import.start',args),e=>e.status===429);
  const second=f.call('cloud.import.list',{machine:'gpu-1'});await assert.rejects(f.call('cloud.info'),e=>e.status===429);
  wait.resolve({state:'QUEUED'});await Promise.all([first,second]);assert.equal(f.service.cloudPending,0);assert.equal(f.service.cloudKeys.size,0);
});
