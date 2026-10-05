import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import http from 'node:http';
import grpc from '@grpc/grpc-js';
import {CloudDriveFiles, createCloudDriveFilesTransport, cloudDriveFilesDefinition} from '../clouddrive-files.mjs';

const KEY = Buffer.alloc(32, 7), TOKEN = 'NODE_ONLY_SECRET_TOKEN';
const CLOUD = {name: 'TestCloud', userName: 'private-account'};
const digest = (buffer, algorithm = 'sha256') => createHash(algorithm).update(buffer).digest('hex');
const contents = Buffer.from('Synthetic node-local file, no real cloud account.');
const source = buffer => async function* () { yield buffer; };
function setup(overrides = {}, mutate = (method, value) => value) {
  const calls = [], objects = new Map(), retained = [], reservations = new Map(); let handle = 0;
  const handles = new Map();
  const file = (path, buffer, directory = false) => ({id: 'cloud-' + path, name: path.split('/').at(-1), fullPathName: path, size: buffer?.length || 0, fileType: directory ? 0 : 1, isDirectory: directory, isCloudDirectory: directory, isCloudFile: !directory, isLocal: false, CloudAPI: {...CLOUD}, fileHashes: directory ? {} : {2: digest(buffer, 'sha1')}, buffer});
  const transport = {endpoint: 'http://127.0.0.1:19798', close() {}, async rpc(method, body, options) {
    calls.push({method, body, options}); let result;
    if (method === 'FindFileByPath') { if (!objects.has(body.path)) throw Object.assign(Error('NOT_FOUND_SECRET'), {code: 5}); result = objects.get(body.path); }
    if (method === 'CreateFolder') { const path = '/' + body.folderName; const folder = file(path, null, true); objects.set(path, folder); result = {result: {success: true}, folderCreated: folder}; }
    if (method === 'CreateFile') { handles.set(String(++handle), {path: body.parentPath + '/' + body.fileName, buffer: Buffer.alloc(0)}); result = {fileHandle: String(handle)}; }
    if (method === 'WriteToFile') { const current = handles.get(body.fileHandle); assert.equal(Number(body.startPos), current.buffer.length); current.buffer = Buffer.concat([current.buffer, body.buffer]); result = {bytesWritten: String(body.buffer.length)}; }
    if (method === 'CloseFile') { const current = handles.get(body.fileHandle); if (current) objects.set(current.path, file(current.path, current.buffer)); handles.delete(body.fileHandle); result = {success: true}; }
    if (method === 'GetSubFiles') result = {subFiles: [...objects.values()].filter(f => f.fullPathName.startsWith(body.path + '/'))};
    if (method === 'GetDownloadUrlPath') result = {downloadUrlPath: '/static/{SCHEME}/{HOST}/{PREVIEW}/file?signature=PRIVATE_STREAM_ONLY'};
    return mutate(method, result, body, options);
  }, async read(path, {offset, signal}) {
    calls.push({method: 'read', body: {path, offset}, options: {signal}});
    const object = [...objects.values()].find(f => !f.isDirectory), buffer = object.buffer.subarray(offset);
    return mutate('read', {status: offset ? 206 : 200, headers: {'content-length': String(buffer.length), ...(offset ? {'content-range': `bytes ${offset}-${object.buffer.length - 1}/${object.buffer.length}`} : {})}, body: source(buffer)(), close() {}}, {path, offset});
  }};
  const budget = {async reserve(r) {
    if ([...reservations.values()].reduce((n, r) => n + r.size, 0) + r.size > 2 * 1024 * 1024) return {reserved: false};
    const key = r.ownerId + ':' + r.operationId; if (reservations.has(key)) return {reserved: false}; reservations.set(key, r); return {reserved: true, bytes: r.size};
  }, async retain(r) { retained.push(r); }};
  const config = {enabled: true, capabilityVerified: true, runtimeRole: 'node-local', scopeId: 'dedicated-test-scope', cloud: CLOUD, receiptKey: KEY, getToken: async () => TOKEN, transport, authorize: async () => true, budget, ...overrides};
  const adapter = new CloudDriveFiles(config);
  const request = {ownerId: 'user-one', operationId: randomUUID(), name: 'dataset.bin', size: contents.length, sha256: digest(contents)};
  return {adapter, request, transport, config, calls, objects, retained, reservations};
}
const safeReject = (promise, status) => assert.rejects(promise, e => (!status || e.status === status) && !/NODE_ONLY_SECRET|PRIVATE_STREAM|private-account|RAW_SECRET|NOT_FOUND_SECRET/.test(e.message));
async function ready(setup) {
  const uploaded = await setup.adapter.upload(setup.request, source(contents));
  return setup.adapter.verify({ownerId: setup.request.ownerId, receipt: uploaded.receipt});
}

test('disabled/unverified gates, node-only role and trusted budget requirements', async () => {
  for (const gate of [{enabled: false}, {capabilityVerified: false}]) { const s = setup(gate); await safeReject(s.adapter.upload(s.request, source(contents)), 409); assert.equal(s.calls.length, 0); }
  for (const config of [{runtimeRole: 'portal'}, {authorize: undefined}, {budget: undefined}, {receiptKey: Buffer.alloc(16)}, {scopeId: ''}]) assert.throws(() => setup(config), {status: 400});
  assert.throws(() => createCloudDriveFilesTransport({endpoint: 'http://192.0.2.1:19798', allowInsecureLoopback: true}), {status: 400});
  assert.throws(() => createCloudDriveFilesTransport({endpoint: 'http://127.0.0.1:19798'}), {status: 400});
});

test('ordinary upload is owner-scoped, hash-bound, chunked and explicitly VERIFYING', async () => {
  const s = setup(), progress = [];
  const result = await s.adapter.upload(s.request, source(contents), {onProgress: r => progress.push(r)});
  assert.equal(result.state, 'VERIFYING'); assert.equal(result.cloudColdReadVerified, false);
  const parent = '/owner-' + digest(Buffer.from(s.request.ownerId));
  const created = s.calls.find(c => c.method === 'CreateFile');
  assert.equal(created.body.parentPath, parent); assert.equal(created.body.fileName, 'file-' + s.request.operationId);
  assert.ok(s.calls.every(c => c.method !== 'GetSubFiles'));
  assert.ok(s.calls.filter(c => c.method === 'WriteToFile' || c.method === 'CloseFile').every(c => c.body.uploadImmediately === false));
  assert.equal(s.retained[0].outcome, 'VERIFYING'); assert.equal(s.retained[0].size, contents.length);
  const serialized = JSON.stringify(result);
  for (const secret of [TOKEN, 'private-account', parent, 'http:', 'cloud-']) assert.ok(!serialized.includes(secret));
  assert.equal(progress.at(-1).bytes, contents.length);
});

test('upload subdivides bounded node chunks without bypassing cloud queue', async () => {
  const s = setup(), buffer = Buffer.alloc(800000, 1); s.request.size = buffer.length; s.request.sha256 = digest(buffer);
  await s.adapter.upload(s.request, source(buffer));
  const writes = s.calls.filter(c => c.method === 'WriteToFile');
  assert.equal(writes.length, 4); assert.ok(writes.every(c => c.body.buffer.length <= 256 * 1024));
});

test('input rejects path injection, extra backend fields, wrong hashes and byte budgets before writes', async () => {
  for (const change of [{name: '../private'}, {name: 'a\n'}, {sha256: 'x'}, {url: 'http://127.0.0.1/'}, {ownerId: ''}, {operationId: '../x'}, {size: -1}]) {
    const s = setup(); await safeReject(s.adapter.upload({...s.request, ...change}, source(contents))); assert.equal(s.calls.length, 0);
  }
  const s = setup({maxBytes: 1}); await safeReject(s.adapter.upload(s.request, source(contents))); assert.equal(s.calls.length, 0);
  const denied = setup({budget: {reserve: async () => ({reserved: false}), retain: async () => {}}}); await safeReject(denied.adapter.upload(denied.request, source(contents)), 409); assert.equal(denied.calls.length, 0);
});

test('duplicate request and pre-existing cloud object cannot overwrite', async () => {
  const s = setup(); await ready(s);
  await safeReject(s.adapter.upload(s.request, source(contents)), 409);
  assert.equal(s.calls.filter(c => c.method === 'CreateFile').length, 1);
  s.reservations.clear();
  await safeReject(s.adapter.upload(s.request, source(contents)), 409);
  assert.equal(s.calls.filter(c => c.method === 'CreateFile').length, 1);
});

test('metadata mismatch and another cloud identity fail closed', async () => {
  for (const mutate of [f => ({...f, fullPathName: '/other'}), f => ({...f, CloudAPI: {...CLOUD, userName: 'other'}}), f => ({...f, readOnly: true})]) {
    const s = setup({}, (method, value) => method === 'CreateFolder' ? {...value, folderCreated: mutate(value.folderCreated)} : value);
    await safeReject(s.adapter.upload(s.request, source(contents)), 403);
    assert.equal(s.calls.some(c => c.method === 'CreateFile'), false);
  }
});

test('partial source, changing contents, oversized chunks and short writes retain budget and cloud partials', async () => {
  for (const buffer of [contents.subarray(1), Buffer.alloc(contents.length), Buffer.alloc(1024 * 1024 + 1)]) {
    const s = setup(); await safeReject(s.adapter.upload(s.request, source(buffer))); assert.equal(s.retained[0].outcome, 'UNKNOWN'); assert.equal(s.reservations.size, 1); assert.equal(s.calls.some(c => /Delete/.test(c.method)), false);
  }
  const s = setup({}, (method, value) => method === 'WriteToFile' ? {bytesWritten: '1'} : value);
  await safeReject(s.adapter.upload(s.request, source(contents)), 502);
  assert.equal(s.calls.filter(c => c.method === 'WriteToFile').length, 1); assert.equal(s.retained[0].outcome, 'UNKNOWN');
});

test('raw upstream errors never expose token, path or account and never retry file writes', async () => {
  const s = setup({}, (method, value) => { if (method === 'WriteToFile') throw Error('RAW_SECRET ' + TOKEN); return value; });
  await safeReject(s.adapter.upload(s.request, source(contents)), 502);
  assert.equal(s.calls.filter(c => c.method === 'WriteToFile').length, 1);
});

test('verify refreshes only owner folder; encrypted receipt survives adapter restart', async () => {
  const s = setup(), file = await ready(s);
  assert.equal(file.state, 'VERIFIED'); assert.equal(file.cloudColdReadVerified, false);
  const fresh = new CloudDriveFiles(s.config);
  assert.equal((await fresh.verify({ownerId: s.request.ownerId, receipt: file.receipt})).state, 'VERIFIED');
  const list = s.calls.filter(c => c.method === 'GetSubFiles'); assert.ok(list.every(c => c.body.path.startsWith('/owner-') && c.body.path !== '/'));
});

test('pending cloud metadata stays VERIFYING; hash or pinned identity changes are rejected', async () => {
  const s = setup(); const uploaded = await s.adapter.upload(s.request, source(contents));
  const object = [...s.objects.values()].find(o => !o.isDirectory); object.isLocal = true;
  assert.equal((await s.adapter.verify({ownerId: s.request.ownerId, receipt: uploaded.receipt})).state, 'VERIFYING');
  object.isLocal = false;
  const verified = await s.adapter.verify({ownerId: s.request.ownerId, receipt: uploaded.receipt}); object.id = 'replacement';
  await safeReject(s.adapter.verify({ownerId: s.request.ownerId, receipt: verified.receipt}), 409);
  object.fileHashes[2] = 'b'.repeat(40);
  await safeReject(s.adapter.verify({ownerId: s.request.ownerId, receipt: uploaded.receipt}), 409);
});

test('only explicit reverification binds a stable new ID; old sealed downloads still fail closed', async () => {
  const s = setup(), file = await ready(s), previous = file.receipt;
  const object = [...s.objects.values()].find(o => !o.isDirectory); object.id = 'new-cloud-id';
  await safeReject(s.adapter.verify({ownerId: s.request.ownerId, receipt: previous}), 409);
  const before = s.calls.length, waits = [];
  const next = await s.adapter.verify({ownerId: s.request.ownerId, receipt: previous}, {refreshIdentity: true, identityWait: async(ms, signal) => {signal.throwIfAborted(); waits.push(ms);}});
  assert.equal(next.state, 'VERIFIED'); assert.notEqual(next.receipt, previous);
  assert.deepEqual(waits, [1000]); assert.deepEqual(s.calls.slice(before).map(c => c.method), ['GetSubFiles', 'FindFileByPath', 'FindFileByPath']);
  const oldCalls = s.calls.length;
  await assert.rejects(s.adapter.download({ownerId: s.request.ownerId, receipt: previous}, () => assert.fail('old receipt must not write')),
    error => error.code === 'CLOUD_FILE_IDENTITY_CHANGED' && error.errorStage === 'IDENTITY_BEFORE_TRANSFER');
  assert.deepEqual(s.calls.slice(oldCalls).map(c => c.method), ['FindFileByPath']);
  const chunks = []; const result = await s.adapter.download({ownerId: s.request.ownerId, receipt: next.receipt}, b => chunks.push(b));
  assert.equal(result.sha256Verified, true); assert.deepEqual(Buffer.concat(chunks), contents); assert.equal(file.receipt, previous);
});

test('IDs changing between delayed observations remain VERIFYING with original receipt, not adopted', async () => {
  const s = setup(), uploaded = await s.adapter.upload(s.request, source(contents));
  const object = [...s.objects.values()].find(o => !o.isDirectory);
  const out = await s.adapter.verify({ownerId: s.request.ownerId, receipt: uploaded.receipt},
    {refreshIdentity: true, identityWait: async() => {object.id = 'changed-between-observations';}});
  assert.equal(out.state, 'VERIFYING'); assert.equal(out.receipt, uploaded.receipt);
  assert.equal(s.calls.some(c => c.method === 'GetDownloadUrlPath' || c.method === 'read'), false);
});

test('explicit reverification never accepts changed content, owner or scope', async () => {
  for(const mutate of [o => {o.size++;}, o => {o.fileHashes[2] = 'b'.repeat(40);}, o => {o.CloudAPI.userName = 'other';}, o => {o.fullPathName = '/other';}, o => {o.isDirectory = true;}]) {
    const s = setup(), uploaded = await s.adapter.upload(s.request, source(contents));
    const object = [...s.objects.values()].find(o => !o.isDirectory);
    await safeReject(s.adapter.verify({ownerId: s.request.ownerId, receipt: uploaded.receipt},
      {refreshIdentity: true, identityWait: async() => {mutate(object);}}));
    assert.equal(s.calls.some(c => c.method === 'GetDownloadUrlPath' || c.method === 'read'), false);
  }
});

test('reverification authorization or cancellation during wait stops before second query', async () => {
  for(const cancel of [false, true]) {
    let allowed = true; const controller = new AbortController();
    const s = setup({authorize: async() => allowed}), uploaded = await s.adapter.upload(s.request, source(contents));
    const before = s.calls.length;
    await safeReject(s.adapter.verify({ownerId: s.request.ownerId, receipt: uploaded.receipt},
      {refreshIdentity: true, signal: controller.signal, identityWait: async() => {if(cancel)controller.abort(); else allowed = false;}}), cancel ? 409 : 403);
    assert.deepEqual(s.calls.slice(before).map(c => c.method), ['GetSubFiles', 'FindFileByPath']);
  }
});

test('ID replacement after download bytes is diagnosed but never becomes verified success', async () => {
  const s = setup(), file = await ready(s), chunks = [];
  const object = [...s.objects.values()].find(o => !o.isDirectory);
  await assert.rejects(s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt}, part => {chunks.push(part); object.id = 'replacement-after-stream';}),
    error => error.code === 'CLOUD_FILE_IDENTITY_CHANGED' && error.errorStage === 'IDENTITY_AFTER_TRANSFER');
  assert.deepEqual(Buffer.concat(chunks), contents);
  assert.equal(s.reservations.size, 1); assert.equal(s.calls.some(c => /Delete/.test(c.method)), false);
});

test('receipt tamper, cross-account and cross-scope access make no calls', async () => {
  const s = setup(), file = await ready(s), before = s.calls.length;
  for (const params of [{ownerId: 'other', receipt: file.receipt}, {ownerId: s.request.ownerId, receipt: file.receipt + 'x'}]) await safeReject(s.adapter.verify(params), 404);
  const other = new CloudDriveFiles({...s.config, scopeId: 'other-scope'});
  await safeReject(other.verify({ownerId: s.request.ownerId, receipt: file.receipt}), 404); assert.equal(s.calls.length, before);
});

test('complete node download validates bytes and hashes without exposing local signed URL', async () => {
  const s = setup(), file = await ready(s), chunks = [];
  const result = await s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt}, part => chunks.push(part));
  assert.deepEqual(Buffer.concat(chunks), contents); assert.equal(result.sha256Verified, true); assert.equal(result.vpsRelay, false); assert.equal(result.cloudColdReadVerified, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_STREAM'));
  assert.equal(s.calls.find(c => c.method === 'GetDownloadUrlPath').body.get_direct_url, false);
});

test('resumed download hashes locked prefix and validates exact HTTP 206 Content-Range', async () => {
  const s = setup(), file = await ready(s), chunks = [contents.subarray(0, 10)];
  const result = await s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt, offset: 10}, part => chunks.push(part), {readPrefix: source(chunks[0])});
  assert.equal(result.sha256Verified, true); assert.deepEqual(Buffer.concat(chunks), contents);
  await safeReject(s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt, offset: 10}, () => {}), 409);
  await safeReject(s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt, offset: 10}, () => {}, {readPrefix: source(Buffer.alloc(10))}), 409);
});

test('bad local descriptors, unrelated backend-token reflections and redirects are refused', async () => {
  for (const descriptor of ['https://example.com/file', '//example.com/x', '/static/../private', '/static/%252e%252e/private', '/static/x?token=' + TOKEN]) {
    const s = setup({}, (method, value) => method === 'GetDownloadUrlPath' ? {downloadUrlPath: descriptor} : value), file = await ready(s);
    await safeReject(s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt}, () => {})); assert.equal(s.calls.some(c => c.method === 'read'), false);
  }
  for (const status of [302, 301, 307, 403]) {
    const s = setup({}, (method, value) => method === 'read' ? {...value, status} : value), file = await ready(s);
    await safeReject(s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt}, () => {}), 502);
  }
});

test('real CD2 scoped-token static descriptor only reads the fixed owner file on loopback', async () => {
  const descriptor = (body, query) => '/static/{SCHEME}/{HOST}/false/' + encodeURIComponent(body.path.slice(1)) + '?' + query;
  const s = setup({}, (method, value, body) => method === 'GetDownloadUrlPath'
    ? {downloadUrlPath: descriptor(body, new URLSearchParams({token: TOKEN, cloudname: 'TestCloud', membership: '1'}))} : value);
  const file = await ready(s), chunks = [];
  const result = await s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt}, b => chunks.push(b));
  assert.deepEqual(Buffer.concat(chunks), contents);
  assert.equal(result.sha256Verified, true);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  const read = s.calls.find(c => c.method === 'read');
  assert.ok(read.body.path.startsWith('/static/http/127.0.0.1:19798/false/'));
  for (const change of [
    body => descriptor({...body, path: '/another-file'}, 'token=' + TOKEN),
    body => descriptor(body, 'token=' + TOKEN + '&token=' + TOKEN),
    body => descriptor(body, 'token=WRONG'),
    body => descriptor(body, 'token=' + TOKEN + '&reflection=' + TOKEN),
  ]) {
    const negative = setup({}, (method, value, body) => method === 'GetDownloadUrlPath' ? {downloadUrlPath: change(body)} : value);
    const uploaded = await ready(negative);
    await safeReject(negative.adapter.download({ownerId: negative.request.ownerId, receipt: uploaded.receipt}, () => {}), 403);
    assert.equal(negative.calls.some(c => c.method === 'read'), false);
  }
});

test('response length/range/compression and final content mismatch are not success', async () => {
  for (const mutation of [v => ({...v, headers: {...v.headers, 'content-length': '1'}}), v => ({...v, headers: {...v.headers, 'content-encoding': 'gzip'}}), v => ({...v, body: source(Buffer.alloc(contents.length))()})]) {
    const s = setup({}, (method, value) => method === 'read' ? mutation(value) : value), file = await ready(s);
    await safeReject(s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt}, () => {}));
  }
  const s = setup({}, (method, value) => method === 'read' ? {...value, headers: {...value.headers, 'content-range': 'bytes 0-1/2'}} : value), file = await ready(s);
  await safeReject(s.adapter.download({ownerId: s.request.ownerId, receipt: file.receipt, offset: 10}, () => {}, {readPrefix: source(contents.subarray(0, 10))}), 502);
});

test('cancel is owner-bound, fences late writes and retains quota; no false stop confirmation', async () => {
  let resume, entered; const pending = new Promise(r => { entered = r; });
  const s = setup({}, async (method, value) => { if (method === 'WriteToFile') { entered(); await new Promise(r => { resume = r; }); } return value; });
  const running = s.adapter.upload(s.request, source(contents)); await pending;
  assert.equal(s.adapter.cancel('other', s.request.operationId).localOperationFound, false);
  const canceled = s.adapter.cancel(s.request.ownerId, s.request.operationId); assert.equal(canceled.stopped, false); assert.equal(canceled.retained, true);
  resume(); await safeReject(running, 409);
  assert.equal(s.calls.filter(c => c.method === 'WriteToFile').length, 1); assert.equal(s.retained[0].outcome, 'UNKNOWN'); assert.equal(s.reservations.size, 1);
});

test('authorization is checked after delayed RPC before next side effect', async () => {
  let allowed = true;
  const s = setup({authorize: async () => allowed}, (method, value) => { if (method === 'CreateFolder') allowed = false; return value; });
  await safeReject(s.adapter.upload(s.request, source(contents)), 403);
  assert.equal(s.calls.some(c => c.method === 'CreateFile'), false);
});

test('same operation and global concurrency are bounded without queuing unlimited work', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = setup({authorize: async () => { await gate; return true; }});
  const first = s.adapter.upload(s.request, source(contents));
  await safeReject(s.adapter.upload(s.request, source(contents)), 429);
  const second = s.adapter.upload({...s.request, operationId: randomUUID()}, source(contents));
  await safeReject(s.adapter.upload({...s.request, operationId: randomUUID()}, source(contents)), 429);
  release(); await Promise.all([first, second]);
});

test('real loopback gRPC serializes official write bytes with scoped auth and whitelist', async t => {
  const server = new grpc.Server(), Service = grpc.loadPackageDefinition(cloudDriveFilesDefinition()).clouddrive.CloudDriveFileSrv;
  let seen;
  server.addService(Service.service, {WriteToFile(call, callback) { seen = {request: call.request, auth: call.metadata.get('authorization')}; callback(null, {bytesWritten: call.request.buffer.length}); }});
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => err ? reject(err) : resolve(port)));
  const transport = createCloudDriveFilesTransport({endpoint: `http://127.0.0.1:${port}`, allowInsecureLoopback: true});
  t.after(() => { transport.close(); server.forceShutdown(); });
  const result = await transport.rpc('WriteToFile', {fileHandle: '23', startPos: '0', length: String(contents.length), buffer: contents, closeFile: false, uploadImmediately: false}, {token: TOKEN});
  assert.equal(Number(result.bytesWritten), contents.length); assert.deepEqual(seen.request.buffer, contents); assert.deepEqual(seen.auth, ['Bearer ' + TOKEN]);
  assert.throws(() => transport.rpc('AddSharedLink', {}, {token: TOKEN}), {status: 403});
});

test('real loopback HTTP transport sends Range but no authorization header and never follows redirects', async t => {
  let headers; const server = http.createServer((req, res) => { headers = req.headers; res.writeHead(302, {Location: 'https://example.com/private', 'Content-Length': '0'}); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = createCloudDriveFilesTransport({endpoint: `http://127.0.0.1:${server.address().port}`, allowInsecureLoopback: true});
  t.after(() => { transport.close(); server.close(); });
  const response = await transport.read('/static/test?signature=opaque', {offset: 10});
  assert.equal(response.status, 302); assert.equal(headers.range, 'bytes=10-'); assert.equal(headers.authorization, undefined); response.close();
});
