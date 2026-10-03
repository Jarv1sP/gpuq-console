// Real durable Portal/transfer routing with a lease-aware fake node boundary.
// Python storage-leases tests exercise the actual cache locks and filesystem.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const hash = 'a'.repeat(64);
const info = {state:'READY', manifestBytes:100, manifestSha256:hash, totalBytes:30, entries:2};
const enabled = {enabled:true, machine:MACHINES[1].id, authority:'hdd'};
const request = () => ({key:randomUUID(), kind:'download', machine:MACHINES[0].id, dataset:'shared', version:hash});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};

async function fixture(t, policy = enabled) {
  const dir = await mkdtemp(join(tmpdir(), 'gpuq-download-lifetime-'));
  const bootstrap = join(dir, 'bootstrap'), db = join(dir, 'db');
  const password = 'Fixture-Storage-Download-2026!';
  await writeFile(bootstrap, JSON.stringify({username:'admin', password}));
  const calls = [], holds = new Map();
  let service, login, hook, releaseCount = 0;
  const binding = (machine, args) => JSON.stringify([machine, args.id, args.userId, args.reference]);
  const node = async (machine, op, args) => {
    if (op.startsWith('storage.download.')) {
      assert.equal(Object.hasOwn(args, 'leaseId'), false);
      assert.equal(Object.hasOwn(args, 'hostAdmin'), false);
      const bound = binding(machine, args), prior = holds.get(args.id);
      if (prior && prior.binding !== bound) throw Error('Lease binding mismatch');
      if (op === 'storage.download.open') {
        if (prior && prior.state !== 'OPEN') throw Error('Permanent download fence');
        holds.set(args.id, {binding:bound, state:'OPEN'});
        return {id:args.id, state:'OPEN'};
      }
      if (op === 'storage.download.finish') {
        assert.ok(['COMPLETED', 'CANCELED'].includes(args.state));
        if (prior && prior.state !== 'OPEN' && prior.state !== args.state) throw Error('Terminal mismatch');
        if (prior?.state === 'OPEN') releaseCount++;
        holds.set(args.id, {binding:bound, state:args.state});
        return {id:args.id, state:args.state, released:true};
      }
      if (!prior || prior.state !== 'OPEN') throw Error('Persistent download lease missing or finalized');
      if (op === 'storage.download.info') return {...info};
      if (['storage.download.manifest', 'storage.download.get'].includes(op)) {
        return {offset:args.offset ?? 0, data:Buffer.from('fixture').toString('base64'), eof:true};
      }
    }
    if (op === 'datasets.snapshot.info') return {...info};
    if (['datasets.snapshot.manifest', 'datasets.snapshot.get'].includes(op)) return {offset:args.offset ?? 0, data:'', eof:true};
    throw Error('Unexpected fixture operation: ' + op);
  };
  const bridge = async (machine, op, args) => {
    calls.push({machine, op, args:structuredClone(args)});
    return hook ? hook(machine, op, args, () => node(machine, op, args)) : node(machine, op, args);
  };
  const open = async () => {
    service = await PortalService.open(db, bootstrap, undefined, bridge, undefined, policy);
    // These tests drive reconciliation explicitly, not by wall-clock timers.
    for (const timer of ['transferTimer', 'storageArchiveTimer', 'executionTimer', 'maintenanceTimer', 'notificationTimer']) clearInterval(service[timer]);
  };
  await open();
  t.after(async () => {service.close(); await rm(dir, {recursive:true, force:true});});
  const admin = await service.login('admin', password);
  const member = (await service.invoke(admin.token, 'users.create', {username:'alice', password})).result;
  await service.invoke(admin.token, 'policy.save', {userId:member.id, policyVersion:0, total:1,
    limits:{[MACHINES[0].id]:1, [MACHINES[1].id]:1}});
  login = await service.login('alice', password);
  return {
    calls, holds, member, admin,
    get service() {return service;},
    get releaseCount() {return releaseCount;},
    hook(value) {hook = value;},
    row(id) {const row = service.db.prepare('SELECT * FROM transfers WHERE id=?').get(id); return {...row, data:JSON.parse(row.data)};},
    async call(op, args) {return (await service.invoke(login.token, op, args)).result;},
    async restart(nextPolicy = policy) {service.close(); policy = nextPolicy; await open(); login = await service.login('alice', password);},
  };
}

test('feature-on download holds one durable identity across all reads and explicit completion', async t => {
  const f = await fixture(t), row = await f.call('transfers.create', request());
  assert.equal(row.state, 'WAITING_CLIENT');
  assert.deepEqual(row.downloadProtection, {protocol:1, state:'HELD'});
  assert.deepEqual(f.calls.map(c => c.op), ['storage.download.open', 'storage.download.info']);
  assert.equal(f.row(row.id).data.downloadProtection.state, 'HELD');
  for (const [action, extra] of [['info', {}], ['manifest', {offset:0}], ['get', {path:'train.bin', offset:0}]]) {
    await f.call('transfers.io', {id:row.id, action, ...extra});
    assert.equal(f.calls.at(-1).op, 'storage.download.' + action);
    assert.deepEqual(f.calls.at(-1).args, {userId:f.member.id, ...extra, id:row.id, reference:{dataset:'shared', version:hash}});
    assert.equal(f.holds.get(row.id).state, 'OPEN');
  }
  await f.call('transfers.progress', {id:row.id, bytes:15, complete:false});
  assert.equal(f.calls.some(c => c.op === 'storage.download.finish'), false);
  const completed = await f.call('transfers.progress', {id:row.id, bytes:30, complete:true});
  assert.equal(completed.state, 'SUCCEEDED');
  assert.equal(completed.downloadProtection.state, 'RELEASED');
  assert.equal(f.holds.get(row.id).state, 'COMPLETED');
  assert.equal(f.releaseCount, 1);
  assert.equal(f.calls.at(-1).args.state, 'COMPLETED');
  assert.equal(f.service.store.jobs.length, 0);
  await assert.rejects(f.call('transfers.io', {id:row.id, action:'info'}));
});

test('Portal restart and policy disable cannot remove protection from an existing download', async t => {
  const f = await fixture(t), args = request(), row = await f.call('transfers.create', args);
  await f.restart({enabled:false});
  await f.service.reconcileTransfers();
  const current = await f.call('transfers.status', {id:row.id});
  assert.equal(current.state, 'WAITING_CLIENT');
  assert.equal(current.downloadProtection.state, 'HELD');
  await f.call('transfers.io', {id:row.id, action:'get', path:'train.bin', offset:0});
  assert.equal(f.calls.at(-1).op, 'storage.download.get');
  assert.equal(f.calls.filter(c => c.op === 'storage.download.open').length, 1);
  assert.equal(f.calls.filter(c => c.op === 'storage.download.finish').length, 0);
  assert.equal(f.holds.size, 1);
  assert.equal((await f.call('transfers.progress', {id:row.id, bytes:30, complete:true})).downloadProtection.state, 'RELEASED');
});

test('accepted open with lost reply remains UNKNOWN and held until explicit same-ID retry', async t => {
  const f = await fixture(t), args = request();
  let lost = true;
  f.hook(async (_machine, op, _args, next) => {
    const result = await next();
    if (op === 'storage.download.open' && lost) {lost = false; throw Error('private open reply lost');}
    return result;
  });
  const row = await f.call('transfers.create', args);
  assert.equal(row.state, 'UNKNOWN');
  assert.equal(row.downloadProtection.state, 'UNCONFIRMED');
  assert.equal(f.holds.get(row.id).state, 'OPEN');
  assert.equal(JSON.stringify(row).includes('private open reply lost'), false);
  await f.restart();
  await f.service.reconcileTransfers();
  assert.equal((await f.call('transfers.status', {id:row.id})).state, 'UNKNOWN');
  assert.deepEqual(f.calls.map(c => c.op), ['storage.download.open']);
  const retried = await f.call('transfers.create', args);
  assert.equal(retried.id, row.id);
  assert.equal(retried.state, 'WAITING_CLIENT');
  assert.equal(f.holds.size, 1);
  assert.deepEqual(f.calls.filter(c => c.op === 'storage.download.open').map(c => c.args.id), [row.id, row.id]);
  await f.call('transfers.cancel', {id:row.id});
});

test('cancel with unknown release retains the lease and durable retry; same UUID never resumes', async t => {
  const f = await fixture(t), args = request(), row = await f.call('transfers.create', args);
  f.hook(async (_machine, op, _args, next) => {
    if (op === 'storage.download.finish') throw Error('release not reached');
    return next();
  });
  const canceled = await f.call('transfers.cancel', {id:row.id});
  assert.equal(canceled.state, 'CANCELED');
  assert.equal(canceled.downloadProtection.state, 'PENDING');
  assert.equal(f.row(row.id).data.cancelRequested, true);
  assert.equal(f.holds.get(row.id).state, 'OPEN');
  await assert.rejects(f.call('transfers.resume', {id:row.id}));
  await assert.rejects(f.call('transfers.io', {id:row.id, action:'get', path:'train.bin'}));
  assert.equal((await f.call('transfers.create', args)).state, 'CANCELED');
  assert.equal(f.calls.filter(c => c.op === 'storage.download.open').length, 1);
  await f.restart();
  assert.equal(f.row(row.id).data.downloadProtection.state, 'PENDING');
  f.hook(undefined);
  await f.service.reconcileTransfers();
  assert.equal(f.row(row.id).data.downloadProtection.state, 'RELEASED');
  assert.equal(f.holds.get(row.id).state, 'CANCELED');
  assert.equal(f.releaseCount, 1);
  assert.deepEqual(f.calls.filter(c => c.op === 'storage.download.finish').map(c => [c.args.id, c.args.state]), [[row.id, 'CANCELED'], [row.id, 'CANCELED']]);
});

test('lost accepted completion reply retries the permanent node fence after restart, not the open', async t => {
  const f = await fixture(t), args = request(), row = await f.call('transfers.create', args);
  let lost = true;
  f.hook(async (_machine, op, _args, next) => {
    const result = await next();
    if (op === 'storage.download.finish' && lost) {lost = false; throw Error('accepted finish reply lost');}
    return result;
  });
  const result = await f.call('transfers.progress', {id:row.id, bytes:30, complete:true});
  assert.equal(result.state, 'SUCCEEDED');
  assert.equal(result.downloadProtection.state, 'PENDING');
  assert.equal(f.holds.get(row.id).state, 'COMPLETED');
  assert.equal(f.releaseCount, 1);
  await f.restart();
  await f.service.reconcileTransfers();
  assert.equal(f.row(row.id).data.downloadProtection.state, 'RELEASED');
  assert.equal(f.releaseCount, 1);
  assert.equal(f.calls.filter(c => c.op === 'storage.download.finish').length, 2);
  assert.equal((await f.call('transfers.create', args)).state, 'SUCCEEDED');
  assert.equal(f.calls.filter(c => c.op === 'storage.download.open').length, 1);
});

test('missing or wrong node lease refuses every protected read without a legacy fallback', async t => {
  const f = await fixture(t);
  for (const fault of ['absent', 'wrong-owner', 'finalized']) {
    const row = await f.call('transfers.create', request());
    if (fault === 'absent') f.holds.delete(row.id);
    else if (fault === 'wrong-owner') f.holds.get(row.id).binding = 'different binding';
    else f.holds.get(row.id).state = 'COMPLETED';
    for (const action of ['info', 'manifest', 'get']) {
      await assert.rejects(f.call('transfers.io', {id:row.id, action, ...(action === 'get' ? {path:'train.bin'} : {})}), /lease|Lease/);
      assert.equal(f.calls.at(-1).op, 'storage.download.' + action);
    }
  }
  assert.equal(f.calls.some(c => c.op.startsWith('datasets.snapshot.')), false);
});

test('wrong open and release receipts never confirm a lease or mark cleanup done', async t => {
  const f = await fixture(t);
  for (const changed of [{id:randomUUID()}, {state:'HELD'}]) {
    f.hook(async (_machine, op, _args, next) => ({...await next(), ...(op === 'storage.download.open' ? changed : {})}));
    const row = await f.call('transfers.create', request());
    assert.equal(row.state, 'UNKNOWN');
    assert.equal(row.downloadProtection.state, 'UNCONFIRMED');
    assert.equal(f.calls.filter(c => c.args.id === row.id).some(c => c.op === 'storage.download.info'), false);
    f.hook(undefined);
    await f.call('transfers.cancel', {id:row.id});
  }
  for (const changed of [{id:randomUUID()}, {state:'CANCELED'}, {released:false}]) {
    const row = await f.call('transfers.create', request());
    f.hook(async (_machine, op, _args, next) => ({...await next(), ...(op === 'storage.download.finish' ? changed : {})}));
    assert.equal((await f.call('transfers.progress', {id:row.id, bytes:30, complete:true})).downloadProtection.state, 'PENDING');
    f.hook(undefined);
    await f.service.reconcileTransfers();
    assert.equal(f.row(row.id).data.downloadProtection.state, 'RELEASED');
  }
});

test('old downloads stay on their original protocol when archive policy is enabled later', async t => {
  const f = await fixture(t, {enabled:false}), args = request();
  const old = await f.call('transfers.create', args);
  assert.equal(old.downloadProtection, undefined);
  await f.restart(enabled);
  await f.call('transfers.io', {id:old.id, action:'get', path:'train.bin'});
  assert.equal(f.calls.at(-1).op, 'datasets.snapshot.get');
  assert.equal((await f.call('transfers.create', args)).downloadProtection, undefined);
  await f.call('transfers.progress', {id:old.id, bytes:30, complete:true});
  assert.equal(f.calls.some(c => c.op.startsWith('storage.download.')), false);
  const fresh = await f.call('transfers.create', request());
  assert.equal(fresh.downloadProtection.state, 'HELD');
  assert.equal(f.holds.size, 1);
  assert.equal(f.holds.has(old.id), false);
});

test('physical reference remains pinned and no client lease/owner/ref override crosses the bridge', async t => {
  const f = await fixture(t), args = request();
  f.service.datasetPhysicalReference = () => ({dataset:'physical-cache', version:hash});
  const row = await f.call('transfers.create', args);
  f.service.datasetPhysicalReference = () => ({dataset:'different-cache', version:hash});
  for (const injected of [{userId:'builtin-admin'}, {leaseId:randomUUID()}, {reference:{dataset:'other', version:hash}}, {dataset:'other'}, {machine:MACHINES[1].id}]) {
    const count = f.calls.length;
    await assert.rejects(f.call('transfers.io', {id:row.id, action:'get', path:'train.bin', ...injected}));
    assert.equal(f.calls.length, count);
  }
  await assert.rejects(f.service.invoke(f.admin.token, 'transfers.io', {id:row.id, action:'info'}), error => error.status === 404);
  await f.call('transfers.io', {id:row.id, action:'get', path:'train.bin'});
  await f.call('transfers.progress', {id:row.id, bytes:30, complete:true});
  assert.ok(f.calls.every(c => c.machine === args.machine && c.args.userId === f.member.id && c.args.reference.dataset === 'physical-cache'));
});

test('cancel intent fences an in-flight protected read, then releases only after that read exits', async t => {
  const f = await fixture(t), row = await f.call('transfers.create', request());
  const started = deferred(), gate = deferred();
  f.hook(async (_machine, op, _args, next) => {
    if (op === 'storage.download.get') {started.resolve(); await gate.promise;}
    return next();
  });
  const reading = f.call('transfers.io', {id:row.id, action:'get', path:'train.bin'});
  const rejected = assert.rejects(reading, error => error.status === 409);
  await started.promise;
  const canceling = f.call('transfers.cancel', {id:row.id});
  assert.equal(f.row(row.id).data.cancelRequested, true);
  assert.equal(f.calls.some(c => c.op === 'storage.download.finish'), false);
  assert.equal(f.holds.get(row.id).state, 'OPEN');
  gate.resolve();
  await rejected;
  assert.equal((await canceling).downloadProtection.state, 'RELEASED');
  assert.equal(f.holds.get(row.id).state, 'CANCELED');
});
