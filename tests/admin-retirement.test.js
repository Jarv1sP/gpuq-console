import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
test('named administrator can retire bootstrap admin without losing administration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'amax-admin-')),db=join(dir,'db'),bootstrap=join(dir,'bootstrap'),password='A-Local-Test-Password-2026';let s;
 try{
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));s=await PortalService.open(db,bootstrap);const a=await s.login('admin',password);
  await assert.rejects(s.invoke(a.token,'users.enabled',{userId:a.principal.userId,enabled:false}),/最后一名/);
  const invite=(await s.invoke(a.token,'invites.rotate',{role:'member'})).result.code;
  await s.register({username:'测试管理员',password,invite});const m=await s.login('测试管理员',password);const id=m.principal.userId;
  await s.invoke(a.token,'users.role',{userId:id,role:'admin'});const owner=await s.login('测试管理员',password);
  await s.invoke(owner.token,'users.enabled',{userId:a.principal.userId,enabled:false});await assert.rejects(s.invoke(a.token,'state'),e=>e.status===401);
  await s.invoke(owner.token,'users.delete',{userId:a.principal.userId});await assert.rejects(s.login('admin',password));
  await assert.rejects(s.invoke(owner.token,'users.role',{userId:id,role:'member'}),/最后一名/);
  await assert.rejects(s.invoke(owner.token,'users.enabled',{userId:id,enabled:false}),/最后一名/);
  s.close();s=await PortalService.open(db);assert.equal((await s.login('测试管理员',password)).principal.role,'admin');assert.equal(s.store.users.some(u=>u.username==='admin'),false);
 }finally{s?.close();await rm(dir,{recursive:true,force:true});}
});
