import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,password} from './maintenance-fixture.mjs';
import {MACHINES} from '../dist/model.js';
import {operationalMaintenanceHTML} from '../dist/maintenance-ui.js';

const [machine,other]=MACHINES.map(m=>m.id),active=e=>e.status===503&&e.code==='MAINTENANCE_ACTIVE';
const set=(f,scope='all',enabled=true,revision=0,reason='存储诊断维修')=>f.call('set',{scope,enabled,revision,...(enabled?{reason}:{})},f.admin.token);

test('operational state is independent, persistent, explicitly restored and revision fenced',async t=>{
  const f=await fixture(t),before=structuredClone(f.service.export());
  assert.deepEqual(await f.call('status'),{version:1,revision:0,global:null,machines:{}});
  await set(f,machine);await set(f,'all',true,1);
  assert.deepEqual(f.service.export(),before,'maintenance cannot change accounts or historical jobs');
  await f.reopen();const value=await f.call('status');assert.equal(value.global.reason,'存储诊断维修');assert.equal(value.machines[machine].reason,value.global.reason);
  await assert.rejects(set(f,'all',false,1),e=>e.status===409);
  await set(f,'all',false,2);assert.equal(f.service.maintenanceFor(other),null);assert.ok(f.service.maintenanceFor(machine));
  await set(f,machine,false,3);assert.equal(f.service.maintenanceFor(machine),null);assert.equal((await f.call('status')).revision,4);
  assert.deepEqual(f.calls,[]);
});
test('only current administrators can set bounded reasons; malformed requests and failed audit never unlock',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.call('set',{scope:'all',enabled:true,revision:0,reason:'repair'}),e=>e.status===403);
  for(const patch of [{scope:'ALL'},{scope:'__proto__'},{enabled:1},{revision:-1},{reason:''},{reason:'x'.repeat(301)},{reason:'bad\nreason'},{reason:'bad\u202e'},{hostAdmin:true}])
    await assert.rejects(f.call('set',{scope:'all',enabled:true,reason:'repair',revision:0,...patch},f.admin.token),e=>e.status===400);
  await set(f);
  f.service.db.exec("CREATE TRIGGER reject_maintenance_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  await assert.rejects(set(f,'all',false,1),/audit unavailable/);assert.equal((await f.call('status')).revision,1);assert.ok(f.service.maintenanceFor(machine));
  f.service.db.exec('DROP TRIGGER reject_maintenance_audit');
  await assert.rejects(f.service.invoke(f.admin.token,'users.enabled',{userId:f.admin.principal.userId,enabled:false}),/最后一名可登录管理员/);
  await assert.rejects(f.service.invoke(f.admin.token,'users.role',{userId:f.admin.principal.userId,role:'member'}),/最后一名可登录管理员/);
  const login=await f.service.login('admin',password);assert.equal(login.principal.role,'admin');
  await set(f,'all',false,1);assert.equal(f.service.maintenanceFor(machine),null);
});
test('corrupt durable state cannot silently become unlocked',async t=>{
  const f=await fixture(t);await set(f);const saved=f.service.db.prepare('SELECT data FROM operational_maintenance WHERE id=1').get().data;
  for(const data of ['{}','{"version":1,"revision":0,"global":null,"machines":{"unknown":null}}','{"version":1,"revision":0,"global":{"reason":"","since":"x"},"machines":{}}']){
    f.service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(data);
    assert.throws(()=>f.service.assertMaintenanceAllowed('files.put',{machine},f.member.principal),/维护状态损坏/);
  }
  f.service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(saved);assert.ok(f.service.maintenanceFor(machine));assert.deepEqual(f.calls,[]);
});
test('machine maintenance is scoped and its details follow current machine visibility',async t=>{
  const f=await fixture(t);await set(f,machine);
  await f.service.invoke(f.admin.token,'policy.save',{userId:f.owner.id,policyVersion:1,total:1,limits:{[other]:1}});
  const current=await f.service.login(f.owner.username,password);
  assert.deepEqual((await f.service.invoke(current.token,'maintenance.status')).result.machines,{});
  assert.ok((await f.call('status',{},f.admin.token)).machines[machine]);
  assert.doesNotThrow(()=>f.service.assertMaintenanceAllowed('files.put',{machine:other},current.principal));
  const hidden=e=>e.status===403&&!e.message.includes('存储诊断维修');
  assert.throws(()=>f.service.assertMaintenanceAllowed('transfers.create',{machine:other,from:machine},current.principal),hidden);
  await assert.rejects(f.service.invoke(current.token,'files.put',{machine,path:'x',data:'eA=='}),hidden);
  await assert.rejects(f.service.invoke(current.token,'transfers.create',{machine:other,from:machine,key:randomUUID(),kind:'copy'}),hidden);
  f.service.archiveMachineVisible=(owner,host)=>owner===f.owner.id&&host===machine;
  assert.throws(()=>f.service.assertMaintenanceAllowed('transfers.create',{machine:other,from:machine},current.principal),active);
});
test('all new execution/data entry points are blocked before bridge, with no implicit cleanup',async t=>{
  const f=await fixture(t);await set(f);
  for(const operation of ['jobs.submit','jobs.priority','terminal.open','files.put','projects.create','projects.publish','projects.sync.begin','projects.sync.chunk','projects.sync.finish','datasets.workspace.put','datasets.workspace.publish','datasets.prepare','datasets.register','datasets.unregister','datasets.evict','datasets.upload.begin','datasets.upload.manifest','datasets.upload.seal','datasets.upload.chunk','datasets.upload.commit','datasets.upload.direct-ticket','datasets.archive.retry','datasets.storage.pin','datasets.storage.unpin','cloud.import.start','cloud.auth.begin','cloud.inspect','transfers.create']){
    await assert.rejects(f.service.invoke(f.member.token,operation,{machine,key:randomUUID()}),active,operation);
  }
  await assert.rejects(f.service.invoke(f.member.token,'terminal.exchange',{machine,input:'rm file',hostAdmin:true,role:'admin'}),e=>e.status===403);
  assert.deepEqual(f.calls,[]);assert.equal(f.service.store.jobs.length,0);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM transfers').get().n,0);
});
test('personal terminal input is blocked but polling/stopping and trusted host operations survive',async t=>{
  const f=await fixture(t);await set(f);
  const args={machine,id:randomUUID(),clientId:randomUUID(),writerToken:randomUUID()};
  await assert.rejects(f.service.invoke(f.member.token,'terminal.exchange',{...args,input:'echo mutate'}),active);
  for(const operation of ['terminal.exchange','terminal.close','terminal.detach']){
    await assert.rejects(f.service.invoke(f.member.token,operation,args),/Unexpected mutation/);
    assert.equal(f.calls.at(-1).operation,operation);
  }
  const request={machine,key:randomUUID(),argv:['id']};
  await assert.rejects(f.service.invoke(f.member.token,'host.exec',request),active);
  const result=(await f.service.invoke(f.admin.token,'host.exec',request)).result;assert.equal(result.state,'SUCCEEDED');assert.equal(f.calls.at(-1).args.hostAdmin,true);
  for(const operation of ['jobs.cancel','jobs.logs','jobs.watch','jobs.diagnostics','terminal.close','terminal.detach','datasets.upload.pause','datasets.upload.direct-revoke','transfers.cancel','transfers.status','transfers.progress','transfers.confirm-source-release','transfers.release-source','storage.lease.cancel','storage.download.finish','cloud.import.cancel','host.status'])
    assert.doesNotThrow(()=>f.service.assertMaintenanceAllowed(operation,{machine},f.member.principal),operation);
  assert.throws(()=>f.service.assertMaintenanceAllowed('terminal.open',{machine,hostAdmin:true},{...f.member.principal,role:'admin'}),active);
  assert.throws(()=>f.service.bridge(machine,'terminal.open',{userId:f.owner.id,hostAdmin:true}),active);
});
test('background dispatch pauses durable queued/preparing work while cancel and terminal lease cleanup continue',async t=>{
  const f=await fixture(t);await set(f);
  const job=state=>({id:randomUUID(),userId:f.owner.id,machine,cards:1,state,spec:{id:randomUUID(),userId:f.owner.id,machine,argv:['true']}});
  const queued=job('SUBMITTING'),preparing=job('PREPARING_DATA'),canceling={...job('PENDING'),cancelRequested:true},finished={...job('CANCELED'),dataPreparationHold:{state:'HELD',spec:{id:randomUUID(),userId:f.owner.id}}};
  f.service.store.jobs.push(queued,preparing,canceling,finished);await f.service.reconcile();
  assert.equal(queued.state,'SUBMITTING');assert.equal(preparing.state,'PREPARING_DATA');
  assert.deepEqual(f.calls.map(c=>c.operation),['cancel','storage.lease.cancel']);
  assert.equal(finished.dataPreparationHold.state,'HELD','unknown cleanup must keep protection');
});
test('per-machine transfer resume resolves saved source/target, leaves previous upload intact and permits cancel',async t=>{
  const f=await fixture(t),id=randomUUID(),key=randomUUID(),data={kind:'upload',machine,uploadId:key,result:{state:'RECEIVING'}};
  f.service.db.prepare('INSERT INTO transfers(id,owner_id,client_key,digest,state,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)').run(id,f.owner.id,key,'fixed','WAITING_CLIENT',1,1,JSON.stringify(data));
  await set(f,machine);
  for(const [operation,args] of [['transfers.resume',{id}],['transfers.io',{id,action:'chunk',path:'fixture',offset:0,data:'eA=='}]])await assert.rejects(f.service.invoke(f.member.token,operation,args),active);
  assert.deepEqual(JSON.parse(f.service.db.prepare('SELECT data FROM transfers WHERE id=?').get(id).data),data);assert.deepEqual(f.calls,[]);
  await f.service.invoke(f.member.token,'transfers.cancel',{id});assert.equal(f.calls.at(-1).operation,'datasets.upload.pause');
  assert.equal(JSON.parse(f.service.db.prepare('SELECT data FROM transfers WHERE id=?').get(id).data).cancelRequested,true);
});
test('reason rendering is escaped and never implies running work was stopped',()=>{
  const html=operationalMaintenanceHTML({version:1,global:{reason:'<img src=x onerror=alert(1)>'},machines:{}});
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/不会自动结束已有任务/);assert.match(html,/需管理员明确恢复/);
  assert.equal(operationalMaintenanceHTML({version:1,global:null,machines:{}}),'');
});
