// Server-only adapter. API reference and rollout limits: docs/CLOUDDRIVE.md.
import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {constants, openSync, fstatSync, readSync, closeSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const SAFE = Symbol('clouddrive-safe-error');
const fail = (message, status = 502) => { throw Object.assign(Error(message), {status, [SAFE]: true}); };
const METHODS = new Set(['GetToken', 'FindFileByPath', 'CreateFolder', 'AddSharedLink', 'GetSubFiles', 'GetDownloadUrlPath']);
const MAX_BYTES = 2 * 1024 * 1024, MAX_FILES = 500, RPC_TIMEOUT = 8000;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
function safeError(error) {
  if (error?.[SAFE]) return error;
  const code = Number(error?.code);
  const message = code === 12 ? 'CloudDrive 不支持所需接口，未切换到文件中转。' : code === 16 ? 'CloudDrive 服务端授权失效，请管理员检查。' : 'CloudDrive 请求失败，请稍后重试；未切换到文件中转。';
  return Object.assign(Error(message), {status: code === 12 ? 501 : code === 16 ? 409 : code === 8 ? 429 : 502, [SAFE]: true});
}
function cloudPath(value) {
  if (!text(value, 2048) || !value.startsWith('/') || /[\\%]/.test(value) || value.slice(1).split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) fail('CloudDrive 专用目录配置或返回路径无效。', 400);
  return value;
}
function sourceReference(source) {
  if (!plain(source) || Object.keys(source).some(key => !['shareId', 'password'].includes(key)) || !/^[A-Za-z0-9_-]{4,128}$/.test(source.shareId || '') || typeof source.password !== 'string' || !/^[A-Za-z0-9]{0,16}$/.test(source.password)) fail('仅接受已解析的阿里云盘官方分享链接。', 400);
  return {shareId: source.shareId, password: source.password};
}
const sourceDigest = source => createHash('sha256').update(JSON.stringify(sourceReference(source))).digest('hex');
function integer(value) {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d{1,16}$/.test(value))) fail('CloudDrive 文件大小无效。');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail('CloudDrive 文件大小无效。');
  return number;
}

/** Real HTTP/2 gRPC transport; no fetch, proxy fallback, file-byte or generic RPC API. */
export function createCloudDriveTransport({endpoint, allowInsecureLoopback = false} = {}) {
  let url;
  try { url = new URL(endpoint); } catch { fail('CloudDrive 服务端地址配置无效。', 400); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) fail('CloudDrive 服务端地址配置无效。', 400);
  if (url.protocol === 'http:' && !(allowInsecureLoopback && ['127.0.0.1', '[::1]'].includes(url.hostname))) fail('CloudDrive 明文连接仅允许显式批准的回环隧道。', 400);
  const definition = protoLoader.loadSync(fileURLToPath(new URL('./proto/clouddrive-pilot.proto', import.meta.url)), {keepCase: true, longs: String, enums: String, defaults: true});
  const Service = grpc.loadPackageDefinition(definition).clouddrive.CloudDriveFileSrv;
  const client = new Service(url.host, url.protocol === 'https:' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
    'grpc.enable_http_proxy': 0, 'grpc.max_receive_message_length': 1024 * 1024, 'grpc.max_send_message_length': 65536,
    'grpc.enable_retries': 0,
  });
  return {
    hostname: url.hostname,
    close() { client.close(); },
    async rpc(method, request, {token, signal} = {}) {
      if (!METHODS.has(method)) fail('CloudDrive 接口未获允许。', 403);
      if (Buffer.byteLength(JSON.stringify(request)) > 65536) fail('CloudDrive 请求过大。', 400);
      const metadata = new grpc.Metadata();
      if (method !== 'GetToken') {
        if (!text(token, 16384) || !/^[\x21-\x7e]+$/.test(token)) fail('CloudDrive 服务端授权未配置。', 409);
        metadata.set('authorization', 'Bearer ' + token);
      }
      if (signal?.aborted) fail('CloudDrive 请求已取消。', 409);
      return new Promise((resolve, reject) => {
        let call, done = false, bytes = 0, messages = 0;
        const files = [];
        const finish = (error, value) => {
          if (done) return;
          done = true; signal?.removeEventListener('abort', abort);
          if (error) reject(safeError(error)); else resolve(value);
        };
        const abort = () => { finish(Object.assign(Error(), {code: 1})); call?.cancel(); };
        const options = {deadline: new Date(Date.now() + RPC_TIMEOUT)};
        try {
          if (method === 'GetSubFiles') {
            call = client[method](request, metadata, options);
            call.on('data', value => {
              if (done) return;
              try {
                bytes += Buffer.byteLength(JSON.stringify(value)); messages++;
                if (!Array.isArray(value?.subFiles) || bytes > MAX_BYTES || messages > 64 || files.length + value.subFiles.length > MAX_FILES) fail('CloudDrive 分享文件清单过大。', 400);
                files.push(...value.subFiles);
              } catch (error) { finish(error); call.cancel(); }
            });
            call.on('error', error => finish(error));
            call.on('end', () => finish(null, {subFiles: files}));
          } else call = client[method](request, metadata, options, (error, value) => finish(error, value));
          signal?.addEventListener('abort', abort, {once: true});
          if (signal?.aborted) abort();
        } catch (error) { finish(error); }
      });
    },
  };
}

/** Exchange server-held credentials only; prefer a scoped, expiring CD2 API token. */
export async function cloudDriveToken(transport, credentials, {signal} = {}) {
  if (!plain(credentials) || !text(credentials.userName, 512) || !text(credentials.password, 8192) || credentials.totpCode !== undefined && !/^\d{6}$/.test(credentials.totpCode)) fail('CloudDrive 服务端凭据无效。', 400);
  try {
    const reply = await transport.rpc('GetToken', {userName: credentials.userName, password: credentials.password, ...(credentials.totpCode ? {totpCode: credentials.totpCode} : {})}, {signal});
    if (reply?.success !== true || !text(reply.token, 16384) || !/^[\x21-\x7e]+$/.test(reply.token)) fail('CloudDrive 服务端授权失败，请管理员检查。', 409);
    return reply.token;
  } catch (error) { throw safeError(error); }
}

/** @typedef {{id:string, name:string, size:number, sha1?:string, cloudDriveReceipt:string}} CloudDriveSharedFile */
/** @typedef {{url:string, userAgent?:string, additionalHeaders:Record<string,string>}} CloudDriveDownload */

export class CloudDriveShare {
  #config; #transport; #getToken; #key; #configuredEnabled; #active = new Set(); #rates = []; #folderCount = 0; #intakeBusy = false;
  constructor({enabled = false, capabilityVerified = false, intakeRoot, cloud, receiptKey, getToken, transport, approveShare, downloadHosts = ['aliyundrive.net', 'aliyuncs.com'], now = Date.now, maxIntakes = 100} = {}) {
    this.#config = {enabled, capabilityVerified, intakeRoot, cloud, approveShare, downloadHosts, now, maxIntakes};
    this.#configuredEnabled = enabled === true;
    this.#transport = transport; this.#getToken = getToken;
    this.#key = Buffer.isBuffer(receiptKey) ? Buffer.from(receiptKey) : null;
    if (!enabled) return;
    cloudPath(intakeRoot);
    if (!plain(cloud) || !text(cloud.name, 128) || !text(cloud.userName, 512) || !intakeRoot.startsWith(cloudPath(cloud.path) + '/') || !this.#key || this.#key.length < 32 || typeof getToken !== 'function' || typeof transport?.rpc !== 'function' || approveShare !== undefined && typeof approveShare !== 'function' || !Number.isInteger(maxIntakes) || maxIntakes < 1 || maxIntakes > 1000) fail('CloudDrive 专用分享接入配置不完整。', 400);
    if (!Array.isArray(downloadHosts) || !downloadHosts.length || downloadHosts.length > 16 || downloadHosts.some(host => typeof host !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(host) || isIP(host))) fail('CloudDrive 下载域名白名单无效。', 400);
  }
  // Means configured/enabled, NOT that a real login or share transfer was tested.
  get backend() { return 'clouddrive'; }
  configuration() { return {configurationEnabled: this.#configuredEnabled, capabilityVerified: this.#config.capabilityVerified === true}; }
  connected() { return this.#config.enabled === true && this.#config.capabilityVerified === true; }
  async begin() { fail('CloudDrive 授权由管理员在专用后台管理，门户不提供账号扫码。', 409); }
  async poll() { fail('CloudDrive 授权由管理员在专用后台管理，门户不提供账号扫码。', 409); }
  clear() { this.#config.enabled = false; for (const controller of this.#active) controller.abort(); }
  reconnect() {
    if (!this.#configuredEnabled || this.#config.capabilityVerified !== true) fail('CloudDrive 私有配置尚未启用或分享能力未验收，不能重新启用。', 409);
    this.#config.enabled = true;
  }
  close() { this.clear(); this.#transport?.close?.(); }
  #assertEnabled() {
    if (this.#config.enabled !== true) fail('CloudDrive 分享接入尚未启用。', 409);
    if (this.#config.capabilityVerified !== true) fail('CloudDrive 阿里云盘分享能力尚未验收，接入保持关闭。', 409);
  }
  async #operation(source, work) {
    this.#assertEnabled(); const reference = sourceReference(source);
    const now = this.#config.now(); this.#rates = this.#rates.filter(value => value > now - 60000);
    if (this.#rates.length >= 30 || this.#active.size >= 2) fail('CloudDrive 请求较多，请稍后重试。', 429);
    this.#rates.push(now);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    this.#active.add(controller);
    try {
      const execute = async () => {
        if (this.#config.approveShare && await this.#config.approveShare(reference) !== true) fail('该分享未获接入策略允许。', 403);
        const token = await this.#getToken();
        if (!text(token, 16384)) fail('CloudDrive 服务端授权未配置。', 409);
        const rpc = async (method, body) => {
          this.#assertEnabled(); if (controller.signal.aborted) fail('CloudDrive 请求已取消。', 409);
          const value = await this.#transport.rpc(method, body, {token, signal: controller.signal});
          this.#assertEnabled(); if (controller.signal.aborted) fail('CloudDrive 请求已取消。', 409);
          if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail('CloudDrive 返回内容过大。');
          if (method === 'GetDownloadUrlPath') {
            const outgoing = [value?.directUrl, value?.userAgent, ...Object.values(plain(value?.additionalHeaders) ? value.additionalHeaders : {})];
            if (outgoing.some(item => {
              if (typeof item !== 'string') return false;
              if (item.includes(token)) return true;
              try { return decodeURIComponent(item).includes(token); } catch { return false; }
            })) fail('CloudDrive 下载描述符包含服务端凭据，已拒绝转交。', 403);
          }
          return value;
        };
        return work(reference, rpc);
      };
      return await Promise.race([execute(), new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(safeError({code: 1})), {once: true}))]);
    } catch (error) { throw safeError(error); }
    finally { clearTimeout(timeout); this.#active.delete(controller); }
  }
  #owned(file, path, directory = false) {
    const cloud = this.#config.cloud, api = file?.CloudAPI;
    if (!plain(file) || cloudPath(file.fullPathName) !== path || !plain(api) || api.name !== cloud.name || api.userName !== cloud.userName || api.path !== cloud.path || api.isLocked === true || file.isForbidden === true || file.isLocal === true || file.isSearchResult === true || file.isRoot === true || file.isCloudRoot === true || (directory ? file.isDirectory !== true || file.isCloudDirectory !== true : file.isDirectory === true || file.fileType !== 'File' || file.isCloudFile !== true)) fail('CloudDrive 返回对象不属于已批准的专用云盘目录。', 403);
    if (directory && (file.readOnly === true || api.readOnly === true)) fail('CloudDrive 接入目录不可写。', 409);
    return file;
  }
  #seal(value) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return body + '.' + createHmac('sha256', this.#key).update(body).digest('base64url');
  }
  #open(receipt) {
    if (typeof receipt !== 'string' || receipt.length > 16384) fail('CloudDrive 文件回执无效，请重新读取分享。', 409);
    const [body, signature, extra] = receipt.split('.');
    const expected = createHmac('sha256', this.#key).update(body || '').digest();
    const actual = Buffer.from(signature || '', 'base64url');
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('CloudDrive 文件回执无效，请重新读取分享。', 409);
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { fail('CloudDrive 文件回执无效，请重新读取分享。', 409); }
  }
  /** @returns {Promise<CloudDriveSharedFile[]>} */
  async list(source) {
    if (this.#intakeBusy) fail('CloudDrive 正在接入另一份分享，请稍后重试。', 429);
    this.#intakeBusy = true;
    try { return await this.#operation(source, async (reference, rpc) => {
      const root = this.#config.intakeRoot;
      const parent = this.#owned(await rpc('FindFileByPath', {parentPath: root.slice(0, root.lastIndexOf('/')), path: root}), root, true);
      if (parent.canAddShareLink !== true) fail('此 CloudDrive 云盘不支持分享接入；未浏览账号其他目录。', 409);
      // Only metadata in the dedicated intake root; cap accumulated folders across restarts.
      const existing = await rpc('GetSubFiles', {path: root, forceRefresh: true, checkExpires: true});
      if (!Array.isArray(existing?.subFiles) || existing.subFiles.length >= this.#config.maxIntakes || this.#folderCount >= this.#config.maxIntakes) fail('CloudDrive 专用接入目录已达上限，请管理员清理。', 409);
      this.#folderCount++;
      const folderName = 'gpuq-' + randomUUID(), folder = root + '/' + folderName;
      const created = await rpc('CreateFolder', {parentPath: root, folderName});
      if (created?.result?.success !== true) fail('CloudDrive 无法创建隔离分享目录。');
      this.#owned(created.folderCreated, folder, true);
      await rpc('AddSharedLink', {sharedLinkUrl: 'https://www.alipan.com/s/' + reference.shareId, sharedPassword: reference.password, toFolder: folder});
      const reply = await rpc('GetSubFiles', {path: folder, forceRefresh: true, checkExpires: true});
      if (!Array.isArray(reply?.subFiles) || reply.subFiles.length > MAX_FILES) fail('CloudDrive 分享文件清单过大或无效。', 400);
      const files = [], seen = new Set();
      for (const entry of reply.subFiles) {
        if (!text(entry?.name, 255) || /[\\/]/.test(entry.name) || ['.', '..'].includes(entry.name)) fail('CloudDrive 文件名无效。');
        const path = folder + '/' + entry.name;
        this.#owned(entry, path, entry.isDirectory === true);
        if (entry.isDirectory) continue;
        if (!text(entry.id, 256) || seen.has(entry.id) || seen.has(path)) fail('CloudDrive 文件身份无效。');
        seen.add(entry.id); seen.add(path);
        const id = randomUUID(), size = integer(entry.size), sha1 = entry.fileHashes?.['2'];
        if (sha1 !== undefined && !/^[a-f0-9]{40}$/i.test(sha1)) fail('CloudDrive 文件校验值无效。');
        const file = {id, name: entry.name, size, ...(sha1 ? {sha1: sha1.toLowerCase()} : {})};
        files.push({...file, cloudDriveReceipt: this.#seal({v: 1, source: sourceDigest(reference), root, cloud: this.#config.cloud, folder, path, cloudFileId: entry.id, file})});
      }
      if (!files.length) fail('CloudDrive 尚未提供分享根目录文件，请检查分享支持与导入状态。', 409);
      return files;
    }); } finally { this.#intakeBusy = false; }
  }
  /** @returns {Promise<CloudDriveDownload>} */
  async resolve(source, file) {
    return this.#operation(source, async (reference, rpc) => {
      const receipt = this.#open(file?.cloudDriveReceipt);
      if (receipt.v !== 1 || receipt.source !== sourceDigest(reference) || receipt.root !== this.#config.intakeRoot || ['name', 'userName', 'path'].some(key => receipt.cloud?.[key] !== this.#config.cloud[key]) || !/^gpuq-[a-f0-9-]{36}$/.test(receipt.folder?.slice(receipt.root.length + 1) || '') || receipt.folder !== receipt.root + '/' + receipt.folder.split('/').at(-1) || receipt.path !== receipt.folder + '/' + receipt.file?.name || ['id', 'name', 'size', 'sha1'].some(key => file[key] !== receipt.file[key])) fail('CloudDrive 分享或文件回执不匹配。', 409);
      cloudPath(receipt.path);
      const current = this.#owned(await rpc('FindFileByPath', {parentPath: receipt.folder, path: receipt.path}), receipt.path);
      if (current.id !== receipt.cloudFileId || integer(current.size) !== receipt.file.size || current.name !== receipt.file.name || receipt.file.sha1 && current.fileHashes?.['2']?.toLowerCase() !== receipt.file.sha1) fail('CloudDrive 分享文件已变化，请重新导入。', 409);
      const result = await rpc('GetDownloadUrlPath', {path: receipt.path, preview: false, lazy_read: false, get_direct_url: true});
      let url;
      try { url = new URL(result?.directUrl); } catch { fail('CloudDrive 未提供云盘直链；不会使用 CloudDrive 或 VPS 文件中转。', 409); }
      if (!text(result.directUrl, 16384) || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || isIP(url.hostname) || url.hostname === this.#transport.hostname || !this.#config.downloadHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) fail('CloudDrive 下载地址不在批准的 HTTPS 云盘域名内。', 403);
      const additionalHeaders = {};
      if (result.userAgent !== undefined && result.userAgent !== '' && (!text(result.userAgent, 512) || !/^[\x20-\x7e]+$/.test(result.userAgent))) fail('CloudDrive 下载 User-Agent 无效。');
      if (result.additionalHeaders !== undefined && !plain(result.additionalHeaders)) fail('CloudDrive 下载请求头无效。');
      for (const [name, value] of Object.entries(result.additionalHeaders || {})) {
        if (!['referer', 'origin'].includes(name.toLowerCase()) || !text(value, 512)) fail('CloudDrive 下载要求未批准的请求头。', 403);
        let header;
        try { header = new URL(value); } catch { fail('CloudDrive 下载请求头无效。'); }
        if (!['https://www.alipan.com', 'https://www.aliyundrive.com'].includes(header.origin) || header.username || header.password || header.search || header.hash || header.pathname !== '/') fail('CloudDrive 下载请求头未获允许。', 403);
        const key = name.toLowerCase() === 'referer' ? 'Referer' : 'Origin';
        if (additionalHeaders[key]) fail('CloudDrive 下载请求头重复。');
        additionalHeaders[key] = value;
      }
      return {url: url.href, ...(result.userAgent ? {userAgent: result.userAgent} : {}), additionalHeaders};
    });
  }
}

/** Load one server-owned private JSON file; absence of an explicit path opts out. */
export function configuredCloudDriveProvider({receiptKey, configPath = process.env.GPUQ_CLOUDDRIVE_CONFIG} = {}) {
  if (configPath === undefined || configPath === '') return null;
  let fd;
  try {
    if (typeof configPath !== 'string' || !isAbsolute(configPath) || !constants.O_NOFOLLOW) fail('CloudDrive 私有配置路径无效。', 400);
    fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 32768) fail('CloudDrive 配置须为当前服务用户持有的私有普通文件，且不超过 32 KiB。', 400);
    const buffer = Buffer.alloc(32769); let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > 32768) fail('CloudDrive 私有配置过大。', 400);
    let config;
    try { config = JSON.parse(buffer.subarray(0, count).toString('utf8')); }
    catch { fail('CloudDrive 私有配置不是有效 JSON。', 400); }
    const fields = new Set(['enabled', 'capabilityVerified', 'endpoint', 'allowInsecureLoopback', 'intakeRoot', 'cloud', 'apiToken', 'downloadHosts', 'maxIntakes']);
    if (!plain(config) || Object.keys(config).some(key => !fields.has(key)) || typeof config.enabled !== 'boolean' || config.capabilityVerified !== undefined && typeof config.capabilityVerified !== 'boolean' || config.allowInsecureLoopback !== undefined && typeof config.allowInsecureLoopback !== 'boolean') fail('CloudDrive 私有配置字段无效。', 400);
    if (!config.enabled) return new CloudDriveShare();
    if (typeof config.capabilityVerified !== 'boolean' || !plain(config.cloud) || Object.keys(config.cloud).some(key => !['name', 'userName', 'path'].includes(key)) || !text(config.apiToken, 16384) || !/^[\x21-\x7e]+$/.test(config.apiToken)) fail('CloudDrive 私有配置缺少已确认的云盘身份或 API 令牌。', 400);
    // Validate provider fields before constructing a channel; no RPC during loading.
    new CloudDriveShare({...config, receiptKey, getToken: async () => config.apiToken, transport: {rpc() {}}});
    const transport = createCloudDriveTransport({endpoint: config.endpoint, allowInsecureLoopback: config.allowInsecureLoopback});
    return new CloudDriveShare({...config, receiptKey, getToken: async () => config.apiToken, transport});
  } catch (error) {
    if (error?.[SAFE]) throw error;
    fail('无法安全读取 CloudDrive 私有配置，请管理员检查文件与权限。', 400);
  } finally { if (fd !== undefined) closeSync(fd); }
}
