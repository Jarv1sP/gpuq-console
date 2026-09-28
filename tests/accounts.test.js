import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoService,DEMO_ADMIN,DEMO_MEMBER_PASSWORD} from '../dist/service.js';

test('Chinese login names retain identity and administrative authorization',async()=>{
  const service=await DemoService.create();const admin=await service.login(DEMO_ADMIN.username,DEMO_ADMIN.password);
  const created=await service.invoke(admin.token,'users.create',{username:'测试同学',password:'UnicodeTest!123',role:'admin'});
  const login=await service.login('测试同学','UnicodeTest!123');
  assert.equal(login.principal.userId,created.result.id);assert.equal(login.principal.role,'admin');
  for(const username of ['测\n试','测试$(id)','测试/同学','ＡＢ','1测试'])await assert.rejects(service.invoke(admin.token,'users.create',{username,password:'UnicodeTest!123'}));
});

test('password login, role isolation, reset invalidation and paused accounts',async()=>{
  const service=await DemoService.create();
  const admin=await service.login(DEMO_ADMIN.username,DEMO_ADMIN.password);
  await assert.rejects(service.login('admin','incorrect'),/用户名或密码错误/);
  await assert.rejects(service.login('missing','incorrect'),/用户名或密码错误/);
  await assert.rejects(service.invoke(admin.token,'users.create',{username:' admin ',password:'Testpass123'}),/已存在/);
  await assert.rejects(service.invoke(admin.token,'users.create',{username:'alice',password:'short'}),/8–128/);
  const created=await service.invoke(admin.token,'users.create',{username:'alice',password:'Testpass123'});
  assert.equal(created.result.username,'alice');assert.deepEqual(created.result.limits,{});
  const member=await service.login('alice','Testpass123');
  assert.equal(member.state.users.length,1);
  assert.equal(member.state.users[0].username,'alice');
  assert.equal(JSON.stringify(member).includes('Testpass123'),false);
  await assert.rejects(service.invoke(member.token,'policy.save',{userId:created.result.id,limits:{'gpu-1':8},total:8}),/管理员/);
  await assert.rejects(service.invoke(member.token,'users.create',{username:'evil',password:'Testpass123'}),/管理员/);
  await assert.rejects(service.invoke(member.token,'request',{userId:'demo-chen',machine:'gpu-1',cards:1}),/其他用户/);
  await service.invoke(admin.token,'policy.save',{userId:created.result.id,limits:{'gpu-1':2},total:2});
  const job=await service.invoke(member.token,'request',{machine:'gpu-1',cards:2});assert.equal(job.result.cards,2);
  await assert.rejects(service.invoke(member.token,'request',{machine:'gpu-1',cards:1}),/上限/);
  await service.invoke(admin.token,'users.reset',{userId:created.result.id,password:'Newpass123'});
  await assert.rejects(service.invoke(member.token,'state'),e=>e.status===401);
  await assert.rejects(service.login('alice','Testpass123'),/用户名或密码错误/);
  const renewed=await service.login('alice','Newpass123');
  await service.invoke(admin.token,'users.enabled',{userId:created.result.id,enabled:false});
  await assert.rejects(service.invoke(renewed.token,'state'),e=>e.status===401);
  await assert.rejects(service.login('alice','Newpass123'),/已暂停/);
  assert.equal(service.store.jobs.length,1); // Pausing never kills an existing job.
  await service.invoke(admin.token,'release',{jobId:job.result.id,userId:created.result.id});
  assert.equal(service.store.jobs.length,0);
});

test('login throttling and independent salted password records',async()=>{
  const service=await DemoService.create();
  assert.notDeepEqual(service.credentials.get('chen-research').hash,service.credentials.get('lin-vision').hash);
  for(let i=0;i<5;i++)await assert.rejects(service.login('chen-research','wrong'),/用户名或密码错误/);
  await assert.rejects(service.login('chen-research',DEMO_MEMBER_PASSWORD),/一分钟/);
  service.failures.get('chen-research').until=Date.now()-1;
  const member=await service.login('chen-research',DEMO_MEMBER_PASSWORD);
  await service.invoke(member.token,'logout');await assert.rejects(service.invoke(member.token,'state'),/重新登录/);
});

test('administrators have full platform access; promotion and demotion invalidate sessions',async()=>{
  const service=await DemoService.create();const owner=await service.login(DEMO_ADMIN.username,DEMO_ADMIN.password);
  assert.equal(owner.state.users[0].role,'admin');assert.equal(owner.state.users[0].total,30);
  const full=await service.invoke(owner.token,'request',{machine:'gpu-4',cards:8,userId:'builtin-admin'});assert.equal(full.result.cards,8);
  await assert.rejects(service.invoke(owner.token,'request',{machine:'gpu-4',cards:1,userId:'builtin-admin'}),/上限/);
  await assert.rejects(service.invoke(owner.token,'users.enabled',{userId:'builtin-admin',enabled:false}),/不能暂停/);
  await assert.rejects(service.invoke(owner.token,'users.role',{userId:'builtin-admin',role:'member'}),/不能降级/);
  const member=await service.login('chen-research',DEMO_MEMBER_PASSWORD);
  await assert.rejects(service.invoke(member.token,'users.role',{userId:'demo-chen',role:'admin'}),/管理员/);
  const promoted=await service.invoke(owner.token,'users.role',{userId:'demo-chen',role:'admin'});
  assert.equal(promoted.result.total,30);assert.equal(Object.keys(promoted.result.limits).length,4);
  await assert.rejects(service.invoke(member.token,'state'),e=>e.status===401);
  const elevated=await service.login('chen-research',DEMO_MEMBER_PASSWORD);assert.equal(elevated.principal.role,'admin');
  assert.equal(elevated.state.users.length,4);
  const extra=await service.invoke(elevated.token,'users.create',{username:'second-admin',password:'AdminTwo123',role:'admin'});
  assert.equal(extra.result.role,'admin');assert.equal(extra.result.total,30);
  await assert.rejects(service.invoke(elevated.token,'policy.save',{userId:'demo-chen',limits:{},total:0}),/无需配置/);
  await service.invoke(owner.token,'users.role',{userId:'demo-chen',role:'member'});
  await assert.rejects(service.invoke(elevated.token,'state'),e=>e.status===401);
  const normal=await service.login('chen-research',DEMO_MEMBER_PASSWORD);assert.equal(normal.state.users[0].total,4);assert.equal(normal.state.users.length,1);
});
