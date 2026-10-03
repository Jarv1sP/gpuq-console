// Node-local ordinary CD2 file I/O, NOT the share-import adapter or a VPS relay.
// Protocol: official https://www.clouddrive2.com/api/clouddrive.proto (v1.1.1).
// A trusted worker owns durable jobs, quota reservations, file descriptors and
// cancellation tombstones. This adapter never browses the scoped root, deletes
// cloud files, accepts host paths, or exposes URLs / API tokens to its caller.
import {createHash, createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const SAFE = Symbol('cloud-files-safe');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/, SHA1 = /^[a-f0-9]{40}$/;
const CHUNK = 256 * 1024, RPC_MS = 15000;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 255) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const fail = (message, status = 400, extra = {}) => { throw Object.assign(Error(message), {status, [SAFE]: true, ...extra}); };
function safe(error) {
  if (error?.[SAFE]) return error;
  const grpcCode = Number.isInteger(error?.code) ? error.code : undefined;
  return Object.assign(Error(grpcCode === 16 ? 'CloudDrive 节点授权失效。' : 'CloudDrive 节点文件操作未确认；保留任务与已有文件，不自动重试写入。'), {
    status: grpcCode === 16 ? 409 : 502, grpcCode, [SAFE]: true,
  });
}
const bytes = (value, max = Number.MAX_SAFE_INTEGER) => {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d{1,16}$/.test(value))) fail('文件大小无效。');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > max) fail('文件大小超出允许范围。');
  return result;
};
function ownerHash(ownerId) {
  if (!text(ownerId, 128)) fail('不可变账号标识无效。');
  return createHash('sha256').update(ownerId).digest('hex');
}
function requestInfo(value) {
  if (!plain(value) || Object.keys(value).some(key => !['ownerId', 'operationId', 'name', 'size', 'sha256'].includes(key)) || !UUID.test(value.operationId || '') || !text(value.name) || /[\\/]/.test(value.name) || ['.', '..'].includes(value.name) || !HASH.test(value.sha256 || '')) fail('云端上传必须使用固定任务、文件名、大小和 SHA256。');
  return {owner: ownerHash(value.ownerId), operationId: value.operationId, name: value.name, size: bytes(value.size), sha256: value.sha256};
}
function endpointURL(endpoint, allowInsecureLoopback) {
  let url; try { url = new URL(endpoint); } catch { fail('CD2 节点本地地址无效。'); }
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || url.protocol === 'http:' && !allowInsecureLoopback) fail('普通文件适配器仅允许明确批准的节点本地 CD2 回环地址。');
  return url;
}

// JSON form of the narrow official protobuf subset. No account enumeration,
// delete, share, mount, credentials-exchange or arbitrary command RPC exists.
const field = (type, id, extra = {}) => ({type, id, ...extra});
const message = fields => ({fields});
const types = {
  FindFileByPathRequest: message({parentPath: field('string', 1), path: field('string', 2)}),
  CreateFolderRequest: message({parentPath: field('string', 1), folderName: field('string', 2)}),
  CreateFolderResult: message({folderCreated: field('CloudDriveFile', 1), result: field('FileOperationResult', 2)}),
  CreateFileRequest: message({parentPath: field('string', 1), fileName: field('string', 2)}),
  CreateFileResult: message({fileHandle: field('uint64', 1)}),
  WriteFileRequest: message({fileHandle: field('uint64', 1), startPos: field('uint64', 2), length: field('uint64', 3), buffer: field('bytes', 4), closeFile: field('bool', 5), uploadImmediately: field('bool', 6)}),
  WriteFileResult: message({bytesWritten: field('uint64', 1)}),
  CloseFileRequest: message({fileHandle: field('uint64', 1), uploadImmediately: field('bool', 2)}),
  FileOperationResult: message({success: field('bool', 1), errorMessage: field('string', 2), resultFilePaths: field('string', 3, {rule: 'repeated'})}),
  ListSubFileRequest: message({path: field('string', 1), forceRefresh: field('bool', 2), checkExpires: field('bool', 3)}),
  SubFilesReply: message({subFiles: field('CloudDriveFile', 1, {rule: 'repeated'})}),
  GetDownloadUrlPathRequest: message({path: field('string', 1), preview: field('bool', 2), lazy_read: field('bool', 3), get_direct_url: field('bool', 4)}),
  DownloadUrlPathInfo: message({downloadUrlPath: field('string', 1), expiresIn: field('uint64', 2), directUrl: field('string', 3)}),
  CloudAPI: message({name: field('string', 1), userName: field('string', 2), isLocked: field('bool', 4), path: field('string', 10), readOnly: field('bool', 12)}),
  CloudDriveFile: message({id: field('string', 1), name: field('string', 2), fullPathName: field('string', 3), size: field('int64', 4), fileType: field('int32', 5), CloudAPI: field('CloudAPI', 9), isDirectory: field('bool', 30), isRoot: field('bool', 31), isCloudRoot: field('bool', 32), isCloudDirectory: field('bool', 33), isCloudFile: field('bool', 34), isSearchResult: field('bool', 35), isForbidden: field('bool', 36), isLocal: field('bool', 37), fileHashes: field('string', 70, {keyType: 'uint32'}), readOnly: field('bool', 80)}),
};
const methodTypes = {
  FindFileByPath: ['FindFileByPathRequest', 'CloudDriveFile'], CreateFolder: ['CreateFolderRequest', 'CreateFolderResult'],
  CreateFile: ['CreateFileRequest', 'CreateFileResult'], WriteToFile: ['WriteFileRequest', 'WriteFileResult'],
  CloseFile: ['CloseFileRequest', 'FileOperationResult'], GetSubFiles: ['ListSubFileRequest', 'SubFilesReply'],
  GetDownloadUrlPath: ['GetDownloadUrlPathRequest', 'DownloadUrlPathInfo'],
};
export function cloudDriveFilesDefinition() {
  const methods = Object.fromEntries(Object.entries(methodTypes).map(([name, [requestType, responseType]]) => [name, {requestType, responseType, ...(name === 'GetSubFiles' ? {responseStream: true} : {})}]));
  return protoLoader.fromJSON({nested: {clouddrive: {nested: {...types, CloudDriveFileSrv: {methods}}}}}, {keepCase: true, longs: String, defaults: true});
}

/** Constructing this transport makes no request; it must run on the CD2 node. */
export function createCloudDriveFilesTransport({endpoint, allowInsecureLoopback = false} = {}) {
  const url = endpointURL(endpoint, allowInsecureLoopback);
  const Service = grpc.loadPackageDefinition(cloudDriveFilesDefinition()).clouddrive.CloudDriveFileSrv;
  const client = new Service(url.host, url.protocol === 'https:' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
    'grpc.enable_http_proxy': 0, 'grpc.enable_retries': 0,
    'grpc.max_send_message_length': CHUNK + 65536, 'grpc.max_receive_message_length': 1024 * 1024,
  });
  return {
    endpoint: url.origin,
    close() { client.close(); },
    rpc(method, body, {token, signal} = {}) {
      if (!Object.hasOwn(methodTypes, method)) fail('CD2 RPC 不在普通文件白名单内。', 403);
      if (!text(token, 16384) || !/^[\x21-\x7e]+$/.test(token)) fail('CD2 节点授权未配置。', 409);
      if (method === 'WriteToFile' && (!Buffer.isBuffer(body.buffer) || body.buffer.length > CHUNK)) fail('CD2 写入分块过大。');
      if (signal?.aborted) fail('节点文件操作已请求取消。', 409);
      const metadata = new grpc.Metadata(); metadata.set('authorization', 'Bearer ' + token);
      return new Promise((resolve, reject) => {
        let call, done = false, total = 0, messages = 0; const subFiles = [];
        const finish = (error, value) => {
          if (done) return; done = true; signal?.removeEventListener('abort', abort);
          if (error) reject(safe(error)); else resolve(value);
        };
        const abort = () => { finish(Object.assign(Error(), {code: 1})); call?.cancel(); };
        try {
          const options = {deadline: new Date(Date.now() + RPC_MS)};
          if (method === 'GetSubFiles') {
            call = client[method](body, metadata, options);
            call.on('data', value => {
              if (done) return;
              total += Buffer.byteLength(JSON.stringify(value)); messages++;
              if (!Array.isArray(value?.subFiles) || total > 2 * 1024 ** 2 || messages > 64 || subFiles.length + value.subFiles.length > 256) { finish(Error()); call.cancel(); return; }
              subFiles.push(...value.subFiles);
            });
            call.on('error', error => finish(error)); call.on('end', () => finish(null, {subFiles}));
          } else call = client[method](body, metadata, options, finish);
          signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
        } catch (error) { finish(error); }
      });
    },
    // Internal only. No redirects or environmental HTTP proxies. No API token
    // is sent as an HTTP header; CD2's own signed static descriptor stays local.
    read(staticPath, {offset, signal} = {}) {
      const target = localStaticURL(staticPath, url, '');
      return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(target, {
          method: 'GET', signal, headers: offset ? {Range: `bytes=${offset}-`} : {},
        }, response => {
          response.on('error', () => {});
          resolve({status: response.statusCode, headers: response.headers, body: response, close: () => response.destroy()});
        });
        request.setTimeout(RPC_MS, () => request.destroy(Error('timeout')));
        request.on('error', error => reject(safe(error))); request.end();
      });
    },
  };
}

function localStaticURL(value, endpoint, token) {
  if (!text(value, 16384) || !value.startsWith('/static/') || value.startsWith('//') || /[\\\r\n]/.test(value)) fail('CD2 没有返回节点本地文件流。', 409);
  let decoded; try { decoded = decodeURIComponent(value); } catch { fail('CD2 文件流地址无效。', 502); }
  if (token && (value.includes(token) || decoded.includes(token)) || decoded.split(/[/?#]/).some(p => p === '.' || p === '..') || /%(?:2e|2f|5c)/i.test(decoded)) fail('CD2 文件流描述符未获允许。', 403);
  const expanded = value.replaceAll('{SCHEME}', endpoint.protocol.slice(0, -1)).replaceAll('{HOST}', endpoint.host).replaceAll('{PREVIEW}', 'false');
  const url = new URL(expanded, endpoint);
  if (url.origin !== endpoint.origin || !url.pathname.startsWith('/static/') || url.username || url.password || url.hash) fail('CD2 文件流地址越界。', 403);
  return url;
}

/**
 * Node worker adapter. Required trusted hooks:
 * authorize({ownerId, operationId, action}) -> true, rechecked around each I/O;
 * budget.reserve({ownerId, operationId, size}) -> {reserved:true, bytes:size}:
 *   atomically persist owner/global cloud budget and single-writer job lock;
 * budget.retain({...record, outcome}): persist retained bytes, NEVER release on
 *   cancel/error. Neither this adapter nor its token can delete cloud objects.
 * source({signal}) / sink(buffer,{offset,signal}) operate on caller-validated,
 * locked personal file FDs. No host path or arbitrary URL is accepted here.
 */
export class CloudDriveFiles {
  #config; #transport; #key; #active = new Map();
  constructor({enabled = false, capabilityVerified = false, runtimeRole, scopeId, cloud, receiptKey, getToken, transport, authorize, budget, maxBytes = 100 * 1024 ** 3, timeoutMs = 3600000} = {}) {
    this.#config = {enabled, capabilityVerified, runtimeRole, scopeId, cloud, getToken, authorize, budget, maxBytes, timeoutMs};
    this.#transport = transport; this.#key = Buffer.isBuffer(receiptKey) ? Buffer.from(receiptKey) : null;
    if (!enabled) return;
    if (runtimeRole !== 'node-local' || !text(scopeId, 128) || !plain(cloud) || !text(cloud.name, 128) || !text(cloud.userName, 512) || !this.#key || this.#key.length !== 32 || typeof getToken !== 'function' || typeof transport?.rpc !== 'function' || typeof transport?.read !== 'function' || typeof authorize !== 'function' || typeof budget?.reserve !== 'function' || typeof budget?.retain !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1024 ** 4 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) fail('CD2 普通文件节点配置不完整。');
    endpointURL(transport.endpoint, true);
  }
  configuration() { return {enabled: this.#config.enabled === true, capabilityVerified: this.#config.capabilityVerified === true, route: 'node-local-cd2-stream', vpsRelay: false}; }
  close() { this.#config.enabled = false; for (const controller of this.#active.values()) controller.abort(); this.#transport?.close?.(); }
  cancel(ownerId, operationId) {
    if (!UUID.test(operationId || '')) fail('任务编号无效。');
    const active = this.#active.get(ownerHash(ownerId) + ':' + operationId);
    active?.abort();
    return {operationId, cancelRequested: true, localOperationFound: Boolean(active), stopped: false, retained: true};
  }
  #seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from('gpuq-cloud-files-v1'));
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }
  #open(ownerId, receipt) {
    try {
      if (typeof receipt !== 'string' || receipt.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(receipt)) throw Error();
      const raw = Buffer.from(receipt, 'base64url'); if (raw.length < 29) throw Error();
      const cipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
      cipher.setAAD(Buffer.from('gpuq-cloud-files-v1')); cipher.setAuthTag(raw.subarray(-16));
      const data = JSON.parse(Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]).toString());
      if (data.v !== 1 || data.owner !== ownerHash(ownerId) || data.scope !== this.#scope() || !UUID.test(data.operationId || '') || !HASH.test(data.sha256 || '') || !SHA1.test(data.sha1 || '') || !text(data.name) || /[\\/]/.test(data.name)) throw Error();
      bytes(data.size, this.#config.maxBytes); return data;
    } catch { fail('云端文件回执无效或不属于当前账号／配置。', 404); }
  }
  #scope() { return createHash('sha256').update(JSON.stringify([this.#config.scopeId, this.#config.cloud.name, this.#config.cloud.userName])).digest('hex'); }
  #path(record) { return `/owner-${record.owner}/file-${record.operationId}`; }
  #public(record, receipt, state) { return {id: record.operationId, name: record.name, size: record.size, sha256: record.sha256, receipt, state, cloudColdReadVerified: false}; }
  #owned(file, path, directory = false) {
    const cloud = this.#config.cloud;
    if (!plain(file) || file.fullPathName !== path || file.name !== path.split('/').at(-1) || file.CloudAPI?.name !== cloud.name || file.CloudAPI?.userName !== cloud.userName || file.CloudAPI?.isLocked === true || file.isForbidden === true || file.isSearchResult === true || file.isRoot === true || file.isCloudRoot === true || directory && (file.isDirectory !== true || file.isCloudDirectory !== true || file.isLocal === true || file.readOnly === true || file.CloudAPI?.readOnly === true) || !directory && (file.isDirectory === true || ![1, 'File'].includes(file.fileType))) fail('CD2 返回对象不属于批准的个人目录。', 403);
    return file;
  }
  async #operation(ownerId, operationId, action, options, work) {
    const key = ownerHash(ownerId) + ':' + operationId, config = this.#config;
    if (!UUID.test(operationId || '')) fail('任务编号无效。');
    if (config.enabled !== true || config.capabilityVerified !== true) fail('CD2 普通文件能力尚未启用或验收。', 409);
    if (this.#active.has(key) || this.#active.size >= 2) fail('节点文件任务正在运行，请核对原任务。', 429);
    const controller = new AbortController(); this.#active.set(key, controller);
    const externalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', externalAbort, {once: true}); if (options.signal?.aborted) externalAbort();
    const timeout = setTimeout(externalAbort, config.timeoutMs); timeout.unref?.();
    const check = async () => {
      if (controller.signal.aborted || !config.enabled) fail('节点文件操作已请求取消；保留已有文件。', 409, {cancelRequested: true, retained: true});
      if (await config.authorize({ownerId, operationId, action}) !== true) fail('账号或文件任务授权已失效。', 403);
      if (controller.signal.aborted || !config.enabled) fail('节点文件操作已请求取消；保留已有文件。', 409, {cancelRequested: true, retained: true});
    };
    try {
      await check(); const token = await config.getToken(); await check();
      if (!text(token, 16384) || !/^[\x21-\x7e]+$/.test(token)) fail('CD2 节点授权未配置。', 409);
      const rpc = async (method, body) => {
        await check(); let value;
        try { value = await this.#transport.rpc(method, body, {token, signal: controller.signal}); }
        catch (error) { await check(); throw safe(error); }
        await check(); return value;
      };
      return await work({rpc, check, token, signal: controller.signal});
    } catch (error) { throw safe(error); }
    finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', externalAbort); this.#active.delete(key); }
  }
  async upload(request, source, options = {}) {
    const record = {...requestInfo(request), v: 1};
    bytes(record.size, this.#config.maxBytes);
    if (typeof source !== 'function') fail('上传来源须由节点工作进程提供。');
    return this.#operation(request.ownerId, record.operationId, 'upload', options, async ({rpc, check, signal, token}) => {
      const budgetRecord = {ownerId: request.ownerId, operationId: record.operationId, size: record.size};
      const reservation = await this.#config.budget.reserve(budgetRecord); await check();
      if (reservation?.reserved !== true || reservation.bytes !== record.size) fail('个人云端预算或任务写入锁未确认。', 409);
      record.scope = this.#scope(); const path = this.#path(record), parent = path.slice(0, path.lastIndexOf('/'));
      let handle, outcome = 'UNKNOWN', count = 0;
      try {
        let folder;
        try { folder = await rpc('FindFileByPath', {parentPath: '/', path: parent}); }
        catch (error) { if (error.grpcCode !== 5) throw error; const reply = await rpc('CreateFolder', {parentPath: '/', folderName: parent.slice(1)}); if (reply?.result?.success !== true) fail('CD2 无法确认个人目录。', 502); folder = reply.folderCreated; }
        this.#owned(folder, parent, true);
        try { await rpc('FindFileByPath', {parentPath: parent, path}); fail('任务对应云端对象已经存在；请核对原记录，不会覆盖。', 409); }
        catch (error) { if (error.grpcCode !== 5) throw error; }
        const created = await rpc('CreateFile', {parentPath: parent, fileName: path.split('/').at(-1)});
        if (!/^[1-9]\d{0,19}$/.test(String(created?.fileHandle || '')) || BigInt(created.fileHandle) > 18446744073709551615n) fail('CD2 未确认文件写入句柄。', 502);
        handle = String(created.fileHandle); const sha256 = createHash('sha256'), sha1 = createHash('sha1');
        const iterable = await source({signal}); await check();
        if (!iterable?.[Symbol.asyncIterator] && !iterable?.[Symbol.iterator]) fail('节点上传来源无效。');
        for await (const incoming of iterable) {
          await check(); if (!Buffer.isBuffer(incoming) || incoming.length > 1024 * 1024) fail('节点读取分块须不超过 1 MiB。');
          if (count + incoming.length > record.size) fail('源文件大小已变化。', 409);
          for (let i = 0; i < incoming.length; i += CHUNK) {
            // Pin bytes across the awaited RPC even if the source reuses its
            // read buffer. The worker also locks/revalidates the source FD.
            const part = Buffer.from(incoming.subarray(i, i + CHUNK));
            const written = await rpc('WriteToFile', {fileHandle: handle, startPos: String(count), length: String(part.length), buffer: part, closeFile: false, uploadImmediately: false});
            if (bytes(written?.bytesWritten) !== part.length) fail('CD2 未确认完整分块写入；不自动重试。', 502);
            sha256.update(part); sha1.update(part); count += part.length;
            await options.onProgress?.({operationId: record.operationId, bytes: count, totalBytes: record.size, stage: 'UPLOADING'}); await check();
          }
        }
        if (count !== record.size || sha256.digest('hex') !== record.sha256) fail('源文件内容或大小已变化；不会声明完成。', 409);
        record.sha1 = sha1.digest('hex');
        // Do not jump CD2's upload queue. A successful close is NOT cloud READY.
        const closed = await rpc('CloseFile', {fileHandle: handle, uploadImmediately: false});
        if (closed?.success !== true) fail('CD2 文件关闭状态未确认。', 502);
        handle = null; outcome = 'VERIFYING';
        return this.#public(record, this.#seal(record), outcome);
      } finally {
        // Best effort handle close, not deletion and not cancellation proof for
        // CD2's asynchronous cloud upload. Never continue writing after abort.
        if (handle) try { await this.#transport.rpc('CloseFile', {fileHandle: handle, uploadImmediately: false}, {token}); } catch {}
        await this.#config.budget.retain({...budgetRecord, bytesWritten: count, outcome});
      }
    });
  }
  async verify({ownerId, receipt}, options = {}) {
    const record = this.#open(ownerId, receipt);
    return this.#operation(ownerId, record.operationId, 'verify', options, async ({rpc}) => {
      const path = this.#path(record), parent = path.slice(0, path.lastIndexOf('/'));
      // Only this account's synthetic folder, never '/' or another owner.
      await rpc('GetSubFiles', {path: parent, forceRefresh: true, checkExpires: true});
      const file = this.#owned(await rpc('FindFileByPath', {parentPath: parent, path}), path);
      if (file.isLocal === true || file.isCloudFile !== true || !file.fileHashes?.['2']) return this.#public(record, receipt, 'VERIFYING');
      if (!text(file.id, 512) || bytes(file.size) !== record.size || file.fileHashes['2'].toLowerCase() !== record.sha1 || record.cloudId && record.cloudId !== file.id) fail('CD2 文件身份或校验值已变化。', 409);
      record.cloudId = file.id;
      return this.#public(record, this.#seal(record), 'VERIFIED');
    });
  }
  async download({ownerId, receipt, offset = 0}, sink, options = {}) {
    const record = this.#open(ownerId, receipt); offset = bytes(offset, record.size);
    if (!text(record.cloudId, 512) || typeof sink !== 'function' || offset && typeof options.readPrefix !== 'function') fail('下载须使用已验证回执及节点文件句柄；续传须校验已有前缀。', 409);
    return this.#operation(ownerId, record.operationId, 'download', options, async ({rpc, check, token, signal}) => {
      const path = this.#path(record), parent = path.slice(0, path.lastIndexOf('/'));
      const identity = async () => {
        const file = this.#owned(await rpc('FindFileByPath', {parentPath: parent, path}), path);
        if (file.id !== record.cloudId || file.isLocal === true || file.isCloudFile !== true || bytes(file.size) !== record.size || file.fileHashes?.['2']?.toLowerCase() !== record.sha1) fail('云端文件身份或内容已变化，不能续传。', 409);
      };
      await identity(); const sha256 = createHash('sha256'), sha1 = createHash('sha1'); let count = 0;
      if (offset) for await (const part of await options.readPrefix({signal, bytes: offset})) {
        await check(); if (!Buffer.isBuffer(part) || part.length > 1024 * 1024 || count + part.length > offset) fail('节点断点前缀无效。', 409);
        sha256.update(part); sha1.update(part); count += part.length;
      }
      if (count !== offset) fail('节点断点前缀不完整。', 409);
      if (offset < record.size) {
        const descriptor = await rpc('GetDownloadUrlPath', {path, preview: false, lazy_read: false, get_direct_url: false});
        const url = localStaticURL(descriptor?.downloadUrlPath, new URL(this.#transport.endpoint), token);
        await check(); const response = await this.#transport.read(url.pathname + url.search, {offset, signal});
        try {
          await check();
          const length = response?.headers?.['content-length'];
          if (response.status !== (offset ? 206 : 200) || length === undefined || bytes(length) !== record.size - offset || offset && response.headers?.['content-range'] !== `bytes ${offset}-${record.size - 1}/${record.size}` || response.headers?.['content-encoding'] && response.headers['content-encoding'] !== 'identity') fail('CD2 文件流状态、大小或 Range 不匹配；拒绝重定向。', 502);
          for await (const part of response.body) {
            await check(); if (!Buffer.isBuffer(part) || part.length > 1024 * 1024 || count + part.length > record.size) fail('CD2 文件流超出声明范围。', 502);
            await sink(part, {offset: count, signal}); await check();
            sha256.update(part); sha1.update(part); count += part.length;
            await options.onProgress?.({operationId: record.operationId, bytes: count, totalBytes: record.size, stage: 'DOWNLOADING'}); await check();
          }
        } finally { response?.close?.(); }
      }
      if (count !== record.size || sha256.digest('hex') !== record.sha256 || sha1.digest('hex') !== record.sha1) fail('下载完整内容校验失败，断点文件保留。', 409);
      await identity(); await check();
      return {id: record.operationId, state: 'VERIFIED', bytes: count, sha256: record.sha256, sha256Verified: true, cloudColdReadVerified: false, vpsRelay: false};
    });
  }
}
