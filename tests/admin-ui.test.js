import test from 'node:test';
import assert from 'node:assert/strict';
import {ADMIN_SECTIONS,createAdminRegistry,adminSectionForRoute,adminHashForRoute} from '../dist/admin-ui.js';
import {pageForRoute} from '../dist/navigation.js';

test('admin deep links stay in the independent room without admitting malformed paths',()=>{
  for(const route of ['admin','#admin','admin/storage','#admin/maintenance'])assert.equal(pageForRoute(route),'admin');
  for(const route of ['#admin/','admin/storage/extra','admin/<script>','#admin/UPPER'])assert.equal(pageForRoute(route),null);
  assert.equal(adminSectionForRoute('#admin'),'tasks');
  assert.equal(adminSectionForRoute('#admin/storage'),'storage');
  assert.equal(adminHashForRoute('admin/storage'),'#admin/storage');
  assert.equal(adminHashForRoute('#admin'),'#admin');
});
test('section owners choose order; storage can mount with the agreed minimal registration',()=>{
  const registry=createAdminRegistry(),mount=()=>{};
  assert.deepEqual(registry.list(),[],'unregistered metadata slots are never navigation entries');
  registry.register({id:'storage',order:20,mount});
  assert.deepEqual(registry.list().map(({id,order})=>({id,order})),[{id:'storage',order:20}]);
  assert.equal(registry.get('storage').title,'数据与存储');
  assert.equal(registry.get('storage').mount,mount);
  registry.register({id:'audit',title:'操作记录',order:15,mount});
  assert.deepEqual(registry.list().map(row=>row.id),['audit','storage']);
});
test('registration changes notify once, unregister removes navigation and is idempotent',()=>{
  const registry=createAdminRegistry();let changes=0;
  const unsubscribe=registry.subscribe(()=>changes++);
  const remove=registry.register({id:'members',order:30,mount:()=>{}});
  assert.equal(changes,1);assert.ok(registry.get('members'));
  remove();remove();assert.equal(changes,2);assert.equal(registry.get('members'),undefined);
  assert.deepEqual(registry.list(),[],'unregistering the last owner cannot restore a placeholder');
  unsubscribe();registry.register({id:'storage',order:20,mount:()=>{}});assert.equal(changes,2);
});
test('invalid and duplicate registrations are rejected without replacing a live owner',()=>{
  const registry=createAdminRegistry();const section={id:'storage',order:20,mount:()=>{}};
  for(const invalid of [null,{}, {...section,id:'storage/other'}, {...section,order:NaN}, {...section,order:Infinity},
    {...section,mount:null},{...section,unmount:3},{...section,title:''},{...section,id:'other'}])
    assert.throws(()=>registry.register(invalid),TypeError);
  registry.register(section);assert.throws(()=>registry.register({...section,mount:()=>{}}),/已注册/);
  assert.equal(registry.get('storage').mount,section.mount);
});
