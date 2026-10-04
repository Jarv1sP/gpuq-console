// Runs only on the storage node. The Python controller opens the personal file
// using openat/O_NOFOLLOW and passes FD 3; no member-controlled host path enters
// this process. Stdout is bounded JSON-lines consumed privately by that parent.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {CloudDriveFiles, createCloudDriveFilesTransport} from './clouddrive-files.mjs';
import {pathToFileURL} from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OWNER = /^(builtin-admin|demo-user-[0-9]{1,18})$/;
const need = (ok, message) => { if (!ok) throw Error(message); };
const identity = s => [s.dev, s.ino, s.mode, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs].map(String);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CHUNK = 256 * 1024;

export function validateRequest(r) {
  need(r && typeof r === 'object' && !Array.isArray(r), 'Invalid cloud worker request');
  need(Object.keys(r).every(k => ['action', 'ownerId', 'operationId', 'fileId', 'name', 'size', 'receipt', 'offset'].includes(k)), 'Unexpected cloud worker field');
  need(['upload', 'verify', 'download'].includes(r.action) && OWNER.test(r.ownerId) && UUID.test(r.operationId), 'Invalid cloud worker identity');
  if (r.action === 'upload') {
    need(typeof r.name === 'string' && r.name.length > 0 && Buffer.byteLength(r.name) <= 255 && !/[\\/\x00-\x1f\x7f]/.test(r.name) && !['.', '..'].includes(r.name), 'Invalid file name');
    need(Number.isSafeInteger(r.size) && r.size >= 0 && r.size <= 1024 ** 4, 'Invalid file size');
    need(r.receipt === undefined && r.offset === undefined && r.fileId === undefined, 'Upload fields mismatch');
  } else {
    need(typeof r.receipt === 'string' && r.receipt.length <= 8192 && UUID.test(r.fileId), 'Verified cloud file receipt required');
    need(r.name === undefined && r.size === undefined, 'Download fields mismatch');
    if (r.action === 'download') need(Number.isSafeInteger(r.offset) && r.offset >= 0, 'Invalid download offset');
    else need(r.offset === undefined, 'Verify fields mismatch');
  }
  return r;
}

function fileStat(fd, privateFile = false) {
  const s = fs.fstatSync(fd, {bigint: true});
  need(s.isFile() && s.uid === BigInt(process.getuid()) && s.nlink === 1n && (s.mode & 0o022n) === 0n && (!privateFile || (s.mode & 0o077n) === 0n), 'Personal regular file required');
  // The controller additionally checks FD access mode and the directory lock.
  need(Number(s.size) <= 1024 ** 4, 'Personal file too large');
  return s;
}
async function* readBlocks(fd, size, signal, progress) {
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - offset));
    const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
    need(n === buffer.length, 'Source changed during read');
    offset += n; await progress?.(offset); yield buffer;
  }
}

/** All metadata, receipts and progress remain on the trusted control plane. */
export async function runCloudFileIO(request, {fd = 3, adapter, emit = () => {}, signal} = {}) {
  const r = validateRequest(request); need(adapter, 'Cloud adapter required');
  let last = 0;
  const progress = async (stage, bytes, totalBytes) => {
    const now = Date.now();
    if (now - last >= 1000 || bytes === totalBytes) { last = now; await emit({kind: 'progress', stage, bytes, totalBytes}); }
  };
  if (r.action === 'verify') {
    const result = await adapter.verify({ownerId: r.ownerId, receipt: r.receipt}, {signal});
    need(result.id === r.fileId, 'Cloud receipt identity mismatch');
    return result;
  }
  const before = fileStat(fd, r.action === 'download');
  if (r.action === 'upload') {
    need(Number(before.size) === r.size, 'Source size changed before hashing');
    const hash = createHash('sha256');
    for await (const part of readBlocks(fd, r.size, signal, n => progress('HASHING', n, r.size))) hash.update(part);
    need(same(identity(before), identity(fileStat(fd))), 'Source changed while hashing');
    const result = await adapter.upload({ownerId: r.ownerId, operationId: r.operationId, name: r.name, size: r.size, sha256: hash.digest('hex')},
      ({signal: active}) => readBlocks(fd, r.size, active),
      {signal, onProgress: p => progress(p.stage, p.bytes, p.totalBytes)});
    need(same(identity(before), identity(fileStat(fd))), 'Source changed while uploading');
    return result;
  }
  need(Number(before.size) === r.offset, 'Download prefix size changed');
  const result = await adapter.download({ownerId: r.ownerId, receipt: r.receipt, offset: r.offset}, async (part, {offset, signal: active}) => {
    active?.throwIfAborted();
    need(Number(fs.fstatSync(fd).size) === offset, 'Download file changed externally');
    let written = 0;
    while (written < part.length) {
      const n = fs.writeSync(fd, part, written, part.length - written, offset + written);
      need(n > 0, 'Download write incomplete'); written += n;
    }
  }, {signal, readPrefix: ({signal: active, bytes}) => readBlocks(fd, bytes, active), onProgress: p => progress(p.stage, p.bytes, p.totalBytes)});
  need(result.id === r.fileId, 'Cloud receipt identity mismatch');
  fs.fsyncSync(fd); need(Number(fileStat(fd).size) === result.bytes, 'Download final size mismatch');
  return result;
}

function privateRead(path, maximum) {
  need(typeof path === 'string' && path.startsWith('/') && !path.includes('\0'), 'Private configuration path required');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    need(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o077) === 0 && s.size <= maximum, 'Private configuration permissions invalid');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function workerAdapter(configPath, request, {emit = () => {}, signal} = {}) {
  const config = JSON.parse(privateRead(configPath, 65536));
  need(config.enabled === true && config.capabilityVerified === true && typeof config.tokenFile === 'string' && typeof config.receiptKeyFile === 'string', 'Cloud file service is not enabled');
  const original = createHash('sha256').update(privateRead(configPath, 65536)).digest('hex');
  const token = JSON.parse(privateRead(config.tokenFile, 65536));
  need(typeof token.apiToken === 'string' && token.apiToken.length > 0, 'Cloud node authorization unavailable');
  return new CloudDriveFiles({enabled: true, capabilityVerified: true, runtimeRole: 'node-local',
    scopeId: config.scopeId, cloud: config.cloud, maxBytes: config.maxBytes,
    timeoutMs: config.timeoutMs, receiptKey: privateRead(config.receiptKeyFile, 32),
    getToken: async () => token.apiToken,
    transport: createCloudDriveFilesTransport({endpoint: config.endpoint, allowInsecureLoopback: config.allowInsecureLoopback === true}),
    authorize: async ({ownerId, operationId}) => !signal?.aborted && ownerId === request.ownerId && operationId === (request.fileId || request.operationId)
      && createHash('sha256').update(privateRead(configPath, 65536)).digest('hex') === original,
    // Controller reserves the whole declared upload before launching this worker;
    // failure/cancellation retains that reservation because cloud deletion is not
    // authorized. The final frame is durable before controller reports success.
    budget: {reserve: async r => ({reserved: r.operationId === request.operationId && r.ownerId === request.ownerId && r.size === request.size, bytes: request.size}),
      retain: async r => emit({kind: 'retained', bytes: r.size, bytesWritten: r.bytesWritten, outcome: r.outcome})},
  });
}

async function main() {
  need(process.platform === 'linux' && process.argv.length === 3, 'Node-local worker required');
  let raw = Buffer.alloc(0); for await (const part of process.stdin) { raw = Buffer.concat([raw, part]); need(raw.length <= 16384, 'Worker request too large'); }
  const request = validateRequest(JSON.parse(raw)); const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  const emit = value => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n', e => e ? reject(e) : resolve()));
  const adapter = workerAdapter(process.argv[2], request, {emit, signal: controller.signal});
  const fd = Number(process.env.GPUQ_CLOUD_FILE_FD);
  need(request.action === 'verify' || Number.isSafeInteger(fd) && fd >= 3, 'Personal file descriptor required');
  try { const result = await runCloudFileIO(request, {fd, adapter, emit, signal: controller.signal}); await emit({kind: 'result', result}); }
  finally { adapter.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  // Never print raw gRPC errors, private paths, signed URLs, account IDs or keys.
  process.stdout.write(JSON.stringify({kind: 'error', error: '云文件传输未确认；已传内容保留，请查看任务状态。'}) + '\n');
  process.exitCode = 1;
});
