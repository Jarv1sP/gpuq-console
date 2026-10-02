import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import {CloudDriveShare, createCloudDriveTransport, cloudDriveToken, configuredCloudDriveProvider} from '../clouddrive-provider.mjs';

const ROOT = '/AliyunOpen/gpuq-intake';
const CLOUD = {name: 'AliyunOpen', userName: 'configured-account', path: '/AliyunOpen'};
const KEY = Buffer.alloc(32, 7), SOURCE = {shareId: 'approved-share', password: 'a123'};
const SHA1 = 'a'.repeat(40), DIRECT = {directUrl: 'https://cn.example.aliyundrive.net/archive?sig=PRIVATE', userAgent: 'CloudDrive/1.1.1', additionalHeaders: {Referer: 'https://www.alipan.com/'}};
const directory = path => ({id: path, name: path.split('/').at(-1), fullPathName: path, isDirectory: true, isCloudDirectory: true, canAddShareLink: true, fileType: 'Directory', CloudAPI: {...CLOUD}});
const regular = path => ({id: 'cloud-file-id', name: 'dataset.tar', fullPathName: path, size: '123', isDirectory: false, isCloudFile: true, fileType: 'File', CloudAPI: {...CLOUD}, fileHashes: {2: SHA1}});
function setup(config = {}, alter = (method, value) => value) {
  const calls = [];
  const transport = {hostname: '127.0.0.1', async rpc(method, body, options) {
    calls.push({method, body, options});
    let value;
    if (method === 'FindFileByPath') value = body.path === ROOT ? directory(ROOT) : regular(body.path);
    if (method === 'CreateFolder') value = {result: {success: true}, folderCreated: directory(body.parentPath + '/' + body.folderName)};
    if (method === 'AddSharedLink') value = {};
    if (method === 'GetSubFiles') value = {subFiles: body.path === ROOT ? [] : [regular(body.path + '/dataset.tar')]};
    if (method === 'GetDownloadUrlPath') value = {...DIRECT, additionalHeaders: {...DIRECT.additionalHeaders}};
    return alter(method, value, body, options);
  }};
  const options = {enabled: true, capabilityVerified: true, intakeRoot: ROOT, cloud: CLOUD, receiptKey: KEY, getToken: async () => 'SERVER_ONLY_TOKEN', transport, ...config};
  return {provider: new CloudDriveShare(options), calls, transport, options};
}
const rejects = (promise, status, pattern) => assert.rejects(promise, error => error.status === status && (!pattern || pattern.test(error.message)) && !/PRIVATE|SERVER_ONLY|RAW_SECRET/.test(error.message));

test('disabled and unverified gates make no RPC calls', async () => {
  for (const gate of [{enabled: false}, {capabilityVerified: false}, {capabilityVerified: 'true'}]) {
    const {provider, calls} = setup(gate);
    assert.equal(provider.connected(), false);
    await rejects(provider.list(SOURCE), 409); assert.equal(calls.length, 0);
  }
  await rejects(new CloudDriveShare().list(SOURCE), 409);
});

test('configuration forbids cloud/account root, unsafe paths and missing durable key', () => {
  for (const config of [{intakeRoot: '/AliyunOpen'}, {intakeRoot: '/Other/intake'}, {intakeRoot: ROOT + '/..'}, {intakeRoot: ROOT + '/%2e%2e'}, {receiptKey: Buffer.alloc(16)}, {downloadHosts: ['127.0.0.1']}, {maxIntakes: 1001}]) assert.throws(() => setup(config), {status: 400});
});

test('input is only parsed official share identity, never account paths or arbitrary URLs', async () => {
  const {provider, calls} = setup();
  for (const source of [null, {path: ROOT}, {...SOURCE, path: '/secret'}, {...SOURCE, url: 'https://attacker.example'}, {...SOURCE, shareId: '../../secret'}, {...SOURCE, password: 'a\n'}]) await rejects(provider.list(source), 400);
  assert.equal(calls.length, 0);
});

test('optional server share policy denies before authentication or RPC', async () => {
  const {provider, calls} = setup({approveShare: async () => false, getToken: () => { throw Error('RAW_SECRET'); }});
  await rejects(provider.list(SOURCE), 403); assert.equal(calls.length, 0);
});

test('list imports once into a random owned folder and returns opaque selection plus private receipt', async () => {
  const {provider, calls} = setup();
  const [file] = await provider.list(SOURCE);
  assert.deepEqual(Object.keys(file).sort(), ['cloudDriveReceipt', 'id', 'name', 'sha1', 'size']);
  assert.equal(file.name, 'dataset.tar'); assert.equal(file.size, 123); assert.equal(file.sha1, SHA1);
  assert.match(file.id, /^[a-f0-9-]{36}$/);
  const add = calls.find(call => call.method === 'AddSharedLink');
  assert.equal(add.body.sharedLinkUrl, 'https://www.alipan.com/s/approved-share');
  assert.equal(add.body.sharedPassword, SOURCE.password);
  assert.match(add.body.toFolder, /^\/AliyunOpen\/gpuq-intake\/gpuq-[a-f0-9-]{36}$/);
  assert.equal(calls.filter(call => call.method === 'AddSharedLink').length, 1);
  assert.ok(calls.every(call => call.options.token === 'SERVER_ONLY_TOKEN' && call.options.signal));
  assert.ok(calls.every(call => !['/', CLOUD.path].includes(call.body.path)));
});

test('canAddShareLink absent/false, other account/cloud, local or readonly intake fails closed', async () => {
  for (const mutation of [file => ({...file, canAddShareLink: false}), file => ({...file, canAddShareLink: undefined}), file => ({...file, CloudAPI: {...CLOUD, userName: 'other'}}), file => ({...file, CloudAPI: {...CLOUD, name: 'Other'}}), file => ({...file, isLocal: true}), file => ({...file, readOnly: true}), file => ({...file, fullPathName: '/PRIVATE'})]) {
    const {provider, calls} = setup({}, (method, value) => method === 'FindFileByPath' ? mutation(value) : value);
    await assert.rejects(provider.list(SOURCE));
    assert.equal(calls.some(call => ['CreateFolder', 'AddSharedLink'].includes(call.method)), false);
  }
});

test('persistent intake count blocks new cloud mutations', async () => {
  const {provider, calls} = setup({maxIntakes: 1}, (method, value) => method === 'GetSubFiles' ? {subFiles: [directory(ROOT + '/existing')]} : value);
  await rejects(provider.list(SOURCE), 409);
  assert.equal(calls.some(call => call.method === 'CreateFolder'), false);
});

test('unexpected create result cannot redirect AddSharedLink into another folder', async () => {
  const {provider, calls} = setup({}, (method, value) => method === 'CreateFolder' ? {...value, folderCreated: directory('/AliyunOpen/private')} : value);
  await rejects(provider.list(SOURCE), 403);
  assert.equal(calls.some(call => call.method === 'AddSharedLink'), false);
});

test('share import failure is sanitized and never retried or converted into account browsing', async () => {
  const {provider, calls} = setup({}, (method, value) => { if (method === 'AddSharedLink') throw Object.assign(Error('RAW_SECRET'), {code: 12}); return value; });
  await rejects(provider.list(SOURCE), 501);
  assert.equal(calls.filter(call => call.method === 'AddSharedLink').length, 1);
});

test('file listings reject traversal, unexpected ownership, duplicates and oversized identities', async () => {
  for (const change of [f => ({...f, name: '../secret'}), f => ({...f, fullPathName: '/AliyunOpen/private'}), f => ({...f, CloudAPI: {...CLOUD, userName: 'other'}}), f => ({...f, size: '9007199254740992'}), f => ({...f, fileHashes: {2: 'invalid'}}), f => ({...f, isLocal: true})]) {
    const {provider} = setup({}, (method, value, body) => method === 'GetSubFiles' && body.path !== ROOT ? {subFiles: value.subFiles.map(change)} : value);
    await assert.rejects(provider.list(SOURCE));
  }
  for (const count of [2, 501]) {
    const {provider} = setup({}, (method, value, body) => method === 'GetSubFiles' && body.path !== ROOT ? {subFiles: Array(count).fill(value.subFiles[0])} : value);
    await assert.rejects(provider.list(SOURCE));
  }
});

test('empty/asynchronously unavailable share fails, directories never recursively browsed', async () => {
  const {provider, calls} = setup({}, (method, value, body) => method === 'GetSubFiles' && body.path !== ROOT ? {subFiles: [directory(body.path + '/nested')]} : value);
  await rejects(provider.list(SOURCE), 409);
  assert.equal(calls.filter(call => call.method === 'GetSubFiles').length, 2);
});

test('receipt survives restart and obtains only official direct URL descriptor', async () => {
  const first = setup(), [file] = await first.provider.list(SOURCE);
  const second = setup({cloud: {path: CLOUD.path, name: CLOUD.name, userName: CLOUD.userName}});
  assert.deepEqual(await second.provider.resolve(SOURCE, JSON.parse(JSON.stringify(file))), {url: DIRECT.directUrl, userAgent: DIRECT.userAgent, additionalHeaders: DIRECT.additionalHeaders});
  assert.deepEqual(second.calls.map(call => call.method), ['FindFileByPath', 'GetDownloadUrlPath']);
  assert.deepEqual(second.calls.at(-1).body, {path: second.calls[0].body.path, preview: false, lazy_read: false, get_direct_url: true});
});

test('forged receipt, changed selection, another share, another key and another intake cannot resolve', async () => {
  const first = setup(), [file] = await first.provider.list(SOURCE);
  for (const changed of [{...file, cloudDriveReceipt: file.cloudDriveReceipt + 'x'}, {...file, id: 'changed'}, {...file, size: 124}, {...file, name: 'other'}, {...file, sha1: undefined}]) {
    const second = setup(); await rejects(second.provider.resolve(SOURCE, changed), 409); assert.equal(second.calls.length, 0);
  }
  for (const [source, config] of [[{...SOURCE, shareId: 'different'}, {}], [SOURCE, {receiptKey: Buffer.alloc(32, 9)}], [SOURCE, {intakeRoot: '/AliyunOpen/other'}]]) {
    const second = setup(config); await rejects(second.provider.resolve(source, file), 409); assert.equal(second.calls.length, 0);
  }
});

test('changed upstream file identity/size/hash aborts before obtaining a URL', async () => {
  const first = setup(), [file] = await first.provider.list(SOURCE);
  for (const mutation of [f => ({...f, id: 'changed'}), f => ({...f, size: 124}), f => ({...f, fileHashes: {2: 'b'.repeat(40)}})]) {
    const second = setup({}, (method, value) => method === 'FindFileByPath' ? mutation(value) : value);
    await rejects(second.provider.resolve(SOURCE, file), 409);
    assert.equal(second.calls.some(call => call.method === 'GetDownloadUrlPath'), false);
  }
});

test('CD2 proxy path, no direct URL, HTTP, credentials, IP, foreign host and deceptive suffix all fail', async () => {
  const first = setup(), [file] = await first.provider.list(SOURCE);
  for (const directUrl of [undefined, 'http://cdn.aliyundrive.net/x', 'https://secret@cdn.aliyundrive.net/x', 'https://127.0.0.1/x', 'https://cdn.aliyundrive.net:8443/x', 'https://cdn.aliyundrive.net.evil.example/x', 'https://evilaliyundrive.net/x', 'https://cdn.aliyundrive.net/x#secret']) {
    const second = setup({}, (method, value) => method === 'GetDownloadUrlPath' ? {downloadUrlPath: '/static/RAW_SECRET', directUrl} : value);
    await assert.rejects(second.provider.resolve(SOURCE, file), error => [403, 409].includes(error.status) && !error.message.includes('RAW_SECRET'));
  }
});

test('rejects credential, routing, control and unapproved download headers', async () => {
  const first = setup(), [file] = await first.provider.list(SOURCE);
  for (const additionalHeaders of [{Authorization: 'Bearer RAW_SECRET'}, {Cookie: 'RAW_SECRET'}, {Host: 'internal'}, {Range: 'bytes=0-'}, {'User-Agent': 'override'}, {Referer: 'https://evil.example/'}, {Origin: 'https://www.alipan.com/?token=RAW_SECRET'}, {Referer: 'https://www.alipan.com/\r\nHost: internal'}]) {
    const second = setup({}, (method, value) => method === 'GetDownloadUrlPath' ? {...value, additionalHeaders} : value);
    await assert.rejects(second.provider.resolve(SOURCE, file), error => !error.message.includes('RAW_SECRET'));
  }
  const second = setup({}, (method, value) => method === 'GetDownloadUrlPath' ? {...value, userAgent: 'CloudDrive\r\nAuthorization: RAW_SECRET'} : value);
  await rejects(second.provider.resolve(SOURCE, file), 502);
});

test('token failures, unknown thrown values and oversized upstream metadata are sanitized', async () => {
  for (const getToken of [async () => { throw Error('RAW_SECRET'); }, async () => null]) await assert.rejects(setup({getToken}).provider.list(SOURCE), error => !error.message.includes('RAW_SECRET'));
  for (const error of [null, Error('RAW_SECRET'), {code: 16, details: 'RAW_SECRET'}]) {
    const {provider} = setup({}, () => { throw error; }); await assert.rejects(provider.list(SOURCE), e => !e.message.includes('RAW_SECRET'));
  }
  const {provider} = setup({}, () => ({raw: 'RAW_SECRET' + 'x'.repeat(2 * 1024 * 1024)}));
  await rejects(provider.list(SOURCE), 502);
});

test('clear cancels in-flight results and cannot create a folder afterwards', async () => {
  let release, entered;
  const arrived = new Promise(resolve => { entered = resolve; });
  const {provider, calls} = setup({}, async (method, value) => { if (method === 'FindFileByPath') { entered(); await new Promise(resolve => { release = resolve; }); } return value; });
  const pending = provider.list(SOURCE); await arrived;
  await rejects(provider.list(SOURCE), 429);
  provider.clear(); release(); await assert.rejects(pending);
  assert.equal(provider.connected(), false); assert.equal(calls.some(call => call.method === 'CreateFolder'), false);
});

test('adapter caps requests per minute without retry loops', async () => {
  const {provider, calls} = setup({now: () => 123456}, (method, value) => method === 'FindFileByPath' ? {...value, canAddShareLink: false} : value);
  for (let i = 0; i < 30; i++) await rejects(provider.list(SOURCE), 409);
  await rejects(provider.list(SOURCE), 429); assert.equal(calls.length, 30);
});

test('transport endpoint requires TLS or explicitly permitted loopback', () => {
  for (const endpoint of ['http://example.com:19798', 'http://127.0.0.1:19798', 'https://user:pass@example.com', 'https://example.com/private', 'https://example.com?token=x']) assert.throws(() => createCloudDriveTransport({endpoint}), {status: 400});
});

test('credential exchange never returns provider errors or raw server credentials', async () => {
  let got;
  const token = await cloudDriveToken({async rpc(method, body) { got = {method, body}; return {success: true, token: 'issued-token'}; }}, {userName: 'admin', password: 'RAW_SECRET'});
  assert.equal(token, 'issued-token'); assert.equal(got.method, 'GetToken'); assert.equal(got.body.password, 'RAW_SECRET');
  await rejects(cloudDriveToken({async rpc() { return {success: false, errorMessage: 'RAW_SECRET'}; }}, {userName: 'admin', password: 'RAW_SECRET'}), 409);
});

test('real local gRPC transport uses official service/method paths, streaming, token and snake-case field', async t => {
  const definition = protoLoader.loadSync(fileURLToPath(new URL('../proto/clouddrive-pilot.proto', import.meta.url)), {keepCase: true, longs: String, enums: String, defaults: true});
  const Service = grpc.loadPackageDefinition(definition).clouddrive.CloudDriveFileSrv;
  const server = new grpc.Server(); let received;
  server.addService(Service.service, {
    GetToken(call, callback) { assert.equal(call.request.userName, 'admin'); callback(null, {success: true, token: 'issued-token'}); },
    GetSubFiles(call) { assert.equal(call.metadata.get('authorization')[0], 'Bearer PRIVATE_TOKEN'); call.write({subFiles: [regular(ROOT + '/a')]}); call.end(); },
    GetDownloadUrlPath(call, callback) { received = call.request; callback(null, DIRECT); },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
  const transport = createCloudDriveTransport({endpoint: 'http://127.0.0.1:' + port, allowInsecureLoopback: true});
  t.after(() => { transport.close(); server.forceShutdown(); });
  assert.equal(await cloudDriveToken(transport, {userName: 'admin', password: 'RAW_SECRET'}), 'issued-token');
  assert.equal((await transport.rpc('GetSubFiles', {path: ROOT}, {token: 'PRIVATE_TOKEN'})).subFiles[0].size, '123');
  assert.equal((await transport.rpc('GetDownloadUrlPath', {path: ROOT + '/file', get_direct_url: true}, {token: 'PRIVATE_TOKEN'})).directUrl, DIRECT.directUrl);
  assert.equal(received.get_direct_url, true);
  await rejects(transport.rpc('DeleteFile', {path: ROOT}, {token: 'PRIVATE_TOKEN'}), 403);
  assert.equal(Service.service.GetDownloadUrlPath.path, '/clouddrive.CloudDriveFileSrv/GetDownloadUrlPath');
});

test('configured provider opts out without an explicit file and accepts disabled private config', t => {
  assert.equal(configuredCloudDriveProvider({configPath: ''}), null);
  const folder = mkdtempSync(join(tmpdir(), 'gpuq-cd2-config-')); t.after(() => rmSync(folder, {recursive: true, force: true}));
  const path = join(folder, 'config.json'); writeFileSync(path, JSON.stringify({enabled: false}), {mode: 0o600});
  const provider = configuredCloudDriveProvider({configPath: path, receiptKey: KEY});
  assert.equal(provider.connected(), false); provider.close();
});

test('private config rejects symlinks, permissive modes, unknown fields, invalid JSON and large files', t => {
  const folder = mkdtempSync(join(tmpdir(), 'gpuq-cd2-config-')); t.after(() => rmSync(folder, {recursive: true, force: true}));
  const path = join(folder, 'config.json'), link = join(folder, 'link.json');
  writeFileSync(path, JSON.stringify({enabled: false}), {mode: 0o600}); symlinkSync(path, link);
  assert.throws(() => configuredCloudDriveProvider({configPath: link}), error => error.status === 400 && !error.message.includes(folder));
  chmodSync(path, 0o644); assert.throws(() => configuredCloudDriveProvider({configPath: path}), {status: 400}); chmodSync(path, 0o600);
  for (const data of ['RAW_SECRET', 'x'.repeat(32769), JSON.stringify({enabled: false, tokenInWrongField: 'RAW_SECRET'}), JSON.stringify({enabled: 'true'}), JSON.stringify({enabled: true, capabilityVerified: true, apiToken: 'RAW_SECRET'})]) {
    writeFileSync(path, data); assert.throws(() => configuredCloudDriveProvider({configPath: path}), error => error.status === 400 && !error.message.includes('RAW_SECRET'));
  }
  assert.throws(() => configuredCloudDriveProvider({configPath: folder}), {status: 400});
});

test('valid private configuration creates an inactive or configured transport without RPC', t => {
  const folder = mkdtempSync(join(tmpdir(), 'gpuq-cd2-config-')); t.after(() => rmSync(folder, {recursive: true, force: true}));
  const path = join(folder, 'config.json');
  const config = {enabled: true, capabilityVerified: false, endpoint: 'http://127.0.0.1:19798', allowInsecureLoopback: true, intakeRoot: ROOT, cloud: CLOUD, apiToken: 'SERVER_ONLY_TOKEN'};
  writeFileSync(path, JSON.stringify(config), {mode: 0o600});
  let provider = configuredCloudDriveProvider({configPath: path, receiptKey: KEY}); assert.equal(provider.connected(), false); provider.close();
  writeFileSync(path, JSON.stringify({...config, capabilityVerified: true}));
  provider = configuredCloudDriveProvider({configPath: path, receiptKey: KEY}); assert.equal(provider.connected(), true); provider.close();
});

test('portal QR methods explain external management and clear remains disabled', async () => {
  const {provider} = setup();
  await rejects(provider.begin(), 409, /专用后台/); await rejects(provider.poll({}), 409, /专用后台/);
  provider.clear(); await rejects(provider.list(SOURCE), 409);
});
