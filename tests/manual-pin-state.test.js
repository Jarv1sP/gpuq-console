import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheRetentionSession,retentionStorageKey} from '../dist/manual-pin-state.js';
const hash='a'.repeat(64),target={machine:'sample-node',dataset:'samples',version:hash};
function fixture(){
  const pins=new Map([['manual-foreign','other']]),calls=[],values=new Map();let owner='admin',authorized=true,mode='normal',gate,serial=0;
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{if(mode==='disk-full')throw Error();values.set(key,value);}};
  let tail=Promise.resolve();const lock=(_name,task)=>{const result=tail.then(task);tail=result.catch(()=>{});return result;};
  const create=()=>cacheRetentionSession({identity:()=>owner,allowed:()=>authorized,storage,lock,uuid:()=>String(++serial),call:async(operation,args)=>{
    const requestOwner=owner;calls.push({operation,args:structuredClone(args),owner});
    if(gate?.operation===operation)await gate.promise;
    if(operation.endsWith('.status')){
      if(mode==='status-failed')throw Error('Status failed');
      if(args.pinId&&pins.has(args.pinId)&&pins.get(args.pinId)!==owner)throw Error('Foreign pin');
      return {version:{...args,state:'READY',pinCount:pins.size,...(mode==='old-node'?{}:{manualPinProtocol:1}),...(args.pinId&&mode!=='missing-proof'?{manualPin:{pinId:mode==='wrong-id'?'manual-wrong':args.pinId,owner:mode==='wrong-owner'?'other':owner,present:pins.has(args.pinId)}}:{})}};
    }
    if(pins.has(args.pinId)&&pins.get(args.pinId)!==owner)throw Error('Foreign pin');
    if(operation.endsWith('.pin')){pins.set(args.pinId,requestOwner);if(mode==='lost'){mode='status-failed';throw Error('Reply lost');}return {pinned:true,pinId:args.pinId};}
    if(operation.endsWith('.unpin')){const unpinned=pins.delete(args.pinId);if(mode==='lost-unpin'){mode='normal';throw Error('Reply lost');}return {unpinned};}
    throw Error(operation);
  }});
  return {model:create(),create,storage,pins,calls,values,set owner(v){owner=v},set authorized(v){authorized=v},set mode(v){mode=v},set gate(v){gate=v}};
}
const writes=f=>f.calls.filter(row=>/\.(pin|unpin)$/.test(row.operation));
test('exact own proof, not pin count, authorizes release; fresh reload only reads the same ID',async()=>{
  const f=fixture();await f.model.query(target);await assert.rejects(f.model.unpin(target),/本人/);
  await f.model.pin(target);const record=f.model.state(target).record;assert.equal(record.phase,'retained');
  const restored=f.create();assert.equal(restored.state(target).record.phase,'uncertain');
  await assert.rejects(restored.unpin(target),/本人/);const n=writes(f).length;
  await restored.query(target);assert.equal(writes(f).length,n);assert.equal(restored.state(target).record.phase,'retained');
  assert.equal(f.calls.at(-1).args.pinId,record.pinId);
  await restored.unpin(target);assert.equal(restored.state(target).record.phase,'released');assert.deepEqual([...f.pins],[['manual-foreign','other']]);
});
test('lost reply journal survives reload; exact query settles it without replay or new ID',async()=>{
  const f=fixture();f.mode='lost';await assert.rejects(f.model.pin(target),/Reply lost/);const id=f.model.state(target).record.pinId;
  const restored=f.create();assert.equal(restored.state(target).record.phase,'uncertain');await assert.rejects(restored.pin(target),/原保留/);
  f.mode='normal';await restored.query(target);assert.equal(restored.state(target).record.phase,'retained');assert.equal(writes(f).length,1);assert.equal(restored.state(target).record.pinId,id);
  f.mode='lost-unpin';await restored.unpin(target);assert.equal(restored.state(target).record.phase,'released');assert.equal(writes(f).length,2);
});
test('externally removed pin stays uncertain; only explicit restore uses the original ID',async()=>{
  const f=fixture();await f.model.pin(target);const id=f.model.state(target).record.pinId;f.pins.delete(id);
  const restored=f.create();await restored.query(target);assert.equal(restored.state(target).record.phase,'uncertain');assert.equal(writes(f).length,1);
  await assert.rejects(restored.pin(target),/原保留/);await restored.retry(target);assert.equal(restored.state(target).record.phase,'retained');assert.equal(writes(f).at(-1).args.pinId,id);
});
test('identity, machine and full version isolate journals; logout and downgrade cannot reuse old intent',async()=>{
  const f=fixture();await f.model.pin(target);assert.equal(f.model.state({...target,machine:'other'}).record,null);assert.equal(f.model.state({...target,version:'b'.repeat(64)}).record,null);
  f.owner='other';assert.equal(f.model.state(target).record,null);await assert.rejects(f.model.unpin(target),/本人/);
  f.owner=null;f.authorized=false;await assert.rejects(f.model.query(target),/授权已改变/);
  f.owner='admin';f.authorized=true;assert.equal(f.model.state(target).record.phase,'uncertain');await f.model.query(target);assert.equal(f.model.state(target).record.phase,'retained');
});
test('foreign/local forged records, authority IDs, corrupt storage and storage failure fail closed',async()=>{
  for(const pinId of ['manual-foreign','authority-original']){
    const f=fixture();f.values.set(retentionStorageKey('admin'),JSON.stringify([{...target,owner:'admin',pinId,intent:'pin',phase:'retained'}]));
    await assert.rejects(f.model.query(target));await assert.rejects(f.model.retry(target));assert.equal(writes(f).length,0);assert.equal(f.pins.get('manual-foreign'),'other');
  }
  for(const raw of ['{broken',JSON.stringify([{...target,owner:'other',pinId:'manual-1',intent:'pin'}])]){
    const f=fixture();f.values.set(retentionStorageKey('admin'),raw);await assert.rejects(f.model.pin(target),/无法读取/);assert.equal(writes(f).length,0);
  }
  const f=fixture();f.mode='disk-full';await assert.rejects(f.model.pin(target),/持久保存/);assert.equal(writes(f).length,0);
});
test('old node, missing proof or wrong owner/ID never confirms, replays or unlocks a new pin',async()=>{
  for(const mode of ['old-node','missing-proof','wrong-id','wrong-owner','status-failed']){
    const f=fixture();await f.model.pin(target);f.mode=mode;const restored=f.create();
    await assert.rejects(restored.query(target));assert.equal(restored.state(target).record.phase,'uncertain');await assert.rejects(restored.pin(target),/原保留/);await assert.rejects(restored.retry(target));assert.equal(writes(f).length,1);
  }
  const f=fixture();f.mode='old-node';await assert.rejects(f.model.pin(target),/协议/);assert.equal(writes(f).length,0);
});
test('leaving page or changing identity during a write does not issue a follow-up RPC',async()=>{
  for(const logout of [true,false]){
    const f=fixture();let release;f.gate={operation:'datasets.storage.pin',promise:new Promise(resolve=>release=resolve)};
    const pending=f.model.pin(target);while(!writes(f).length)await new Promise(resolve=>setTimeout(resolve,0));
    const n=f.calls.length;f.authorized=false;if(logout)f.owner='other';f.model.reset();release();await assert.rejects(pending,/授权已改变/);assert.equal(f.calls.length,n);
    f.owner='admin';f.authorized=true;const restored=f.create();assert.equal(restored.state(target).record.phase,'uncertain');await restored.query(target);assert.equal(restored.state(target).record.phase,'retained');
  }
});
test('failed fresh query removes retained display; concurrent pin calls do not create two IDs',async()=>{
  const f=fixture();await f.model.pin(target);f.mode='status-failed';await assert.rejects(f.model.unpin(target),/Status failed/);assert.equal(f.model.state(target).record.phase,'uncertain');assert.equal(writes(f).length,1);
  const g=fixture();let release;g.gate={operation:'datasets.storage.status',promise:new Promise(resolve=>release=resolve)};const pending=g.model.pin(target);await assert.rejects(g.model.pin(target),/等待/);release();await pending;assert.equal(writes(g).length,1);
});
test('shared browser lock prevents two tabs creating pins or overwriting other immutable requests',async()=>{
  const f=fixture(),other=f.create();let release;f.gate={operation:'datasets.storage.pin',promise:new Promise(resolve=>release=resolve)};
  const first=f.model.pin(target);while(!writes(f).length)await new Promise(resolve=>setTimeout(resolve,0));
  const second=other.pin(target);release();await first;await assert.rejects(second,/原保留/);assert.equal(writes(f).length,1);
  f.gate=null;await other.query(target);await other.pin({...target,version:'b'.repeat(64)});
  const rows=JSON.parse(f.values.get(retentionStorageKey('admin')));assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.pinId)).size,2);
  assert.equal(f.model.state(target).record.phase,'uncertain','another tab invalidates old confirmation');await f.model.query(target);assert.equal(f.model.state(target).record.phase,'retained');
});
