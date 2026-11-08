import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { normalizeReplicaRoot } from './SyncProtocol';

export class ReplicaAsset {
  key: string = '';
  sha256: string = '';
  size: number = 0;
  mimeType: string = 'application/octet-stream';
}
class AssetReply { code: number = 0; headers: Record<string, string> = {}; bytes: ArrayBuffer = new ArrayBuffer(0); }
const CHUNK: number = 1024 * 1024;
const MAX_ASSET: number = 256 * 1024 * 1024;

export class ReplicaAssets {
  private context: common.Context;
  private root: string;
  private deviceId: string;
  private token: string;

  constructor(context: common.Context, root: string, deviceId: string, token: string) {
    this.context = context; this.root = normalizeReplicaRoot(root); this.deviceId = deviceId; this.token = token;
  }

  static valid(asset: ReplicaAsset): boolean {
    return /^[a-f0-9]{64}$/.test(asset.sha256) && Number.isSafeInteger(asset.size) && asset.size >= 0 && asset.size <= MAX_ASSET;
  }

  static async digest(path: string): Promise<string> {
    const stat = fileIo.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET) throw new Error('同步附件不是安全的普通文件或超过 256 MB');
    const source = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
    const digest = cryptoFramework.createMd('SHA256');
    let offset = 0;
    try {
      while (offset < stat.size) {
        const buffer = new ArrayBuffer(Math.min(CHUNK, stat.size - offset));
        if (fileIo.readSync(source.fd, buffer) !== buffer.byteLength) throw new Error('附件校验读取不完整');
        await digest.update({ data: new Uint8Array(buffer) }); offset += buffer.byteLength;
      }
    } finally { fileIo.closeSync(source); }
    const bytes = (await digest.digest()).data; let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0'); return hex;
  }

  async upload(path: string, key: string, mimeType: string): Promise<ReplicaAsset> {
    const prefix = this.context.filesDir + '/';
    if (!path.startsWith(prefix)) throw new Error('同步附件必须来自本机应用文件目录');
    const parts = path.substring(prefix.length).split('/'); let current = this.context.filesDir;
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === '.' || parts[i] === '..') throw new Error('同步附件路径不安全');
      current += '/' + parts[i];
      if (fileIo.lstatSync(current).isSymbolicLink()) throw new Error('同步附件路径包含符号链接');
    }
    const descriptor = new ReplicaAsset(); descriptor.key = key; descriptor.mimeType = mimeType;
    descriptor.size = fileIo.lstatSync(path).size; descriptor.sha256 = await ReplicaAssets.digest(path);
    const endpoint = '/sync/v1/assets/' + descriptor.sha256;
    const head = await this.request(endpoint, 'HEAD');
    if (head.code === 200 && head.headers['x-asset-complete'] === 'true') {
      if (Number(head.headers['upload-length']) !== descriptor.size) throw new Error('远端附件长度与哈希描述不一致');
      return descriptor;
    }
    if (head.code !== 200 && head.code !== 404) throw new Error(`查询附件失败 HTTP ${head.code}`);
    let offset = head.code === 200 ? Number(head.headers['upload-offset'] ?? 0) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > descriptor.size) throw new Error('附件上传偏移无效');
    if (head.code === 200 && head.headers['upload-length'] && Number(head.headers['upload-length']) !== descriptor.size) offset = 0;
    const source = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
    try {
      if (descriptor.size === 0) {
        const empty = await this.request(endpoint, 'PUT', new ArrayBuffer(0), { 'Content-Range': 'bytes */0' });
        if (empty.code < 200 || empty.code >= 300) throw new Error(`空附件上传失败 HTTP ${empty.code}`);
      }
      while (offset < descriptor.size) {
        const buffer = new ArrayBuffer(Math.min(CHUNK, descriptor.size - offset));
        fileIo.lseek(source.fd, offset, fileIo.WhenceType.SEEK_SET);
        if (fileIo.readSync(source.fd, buffer) !== buffer.byteLength) throw new Error('附件分片读取不完整');
        const headers: Record<string, string> = { 'Content-Range': `bytes ${offset}-${offset + buffer.byteLength - 1}/${descriptor.size}` };
        if (offset === 0) headers['Upload-Reset'] = 'true';
        const reply = await this.request(endpoint, 'PUT', buffer, headers);
        if (reply.code < 200 || reply.code >= 300) throw new Error(`附件分片上传失败 HTTP ${reply.code}`);
        const receipt = JSON.parse(new util.TextDecoder('utf-8').decodeWithStream(new Uint8Array(reply.bytes))) as Record<string, Object>;
        const received = Number(receipt['offset'] ?? receipt['received'] ?? reply.headers['upload-offset']);
        if (!Number.isSafeInteger(received) || received !== offset + buffer.byteLength) throw new Error('附件分片回执偏移不一致');
        offset = received;
      }
    } finally { fileIo.closeSync(source); }
    if (await ReplicaAssets.digest(path) !== descriptor.sha256) throw new Error('上传期间附件已变化，请重试');
    const completed = await this.request(endpoint, 'HEAD');
    if (completed.code !== 200 || completed.headers['x-asset-complete'] !== 'true' || Number(completed.headers['upload-length']) !== descriptor.size) throw new Error('远端尚未确认附件完整');
    return descriptor;
  }

  async download(asset: ReplicaAsset): Promise<string> {
    if (!ReplicaAssets.valid(asset)) throw new Error('附件哈希或大小无效');
    const directory = this.context.filesDir + '/sync-assets';
    if (!fileIo.accessSync(directory)) fileIo.mkdirSync(directory);
    const dir = fileIo.lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('附件缓存目录不安全');
    const final = directory + '/' + asset.sha256;
    if (fileIo.accessSync(final) && fileIo.lstatSync(final).size === asset.size && await ReplicaAssets.digest(final) === asset.sha256) return final;
    const partial = final + '.partial';
    let offset = 0;
    if (fileIo.accessSync(partial)) {
      const stat = fileIo.lstatSync(partial); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > asset.size) throw new Error('附件断点文件无效'); offset = stat.size;
    }
    const target = fileIo.openSync(partial, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
    try {
      while (offset < asset.size) {
        const end = Math.min(offset + CHUNK, asset.size) - 1;
        const reply = await this.request('/sync/v1/assets/' + asset.sha256, 'GET', undefined, { 'Range': `bytes=${offset}-${end}` });
        if (reply.code !== 206 || reply.bytes.byteLength !== end - offset + 1 || reply.headers['content-range'] !== `bytes ${offset}-${end}/${asset.size}`) throw new Error('附件下载范围回执无效');
        fileIo.lseek(target.fd, offset, fileIo.WhenceType.SEEK_SET);
        if (fileIo.writeSync(target.fd, reply.bytes) !== reply.bytes.byteLength) throw new Error('附件分片写入不完整');
        fileIo.fsyncSync(target.fd); offset += reply.bytes.byteLength;
      }
    } finally { fileIo.closeSync(target); }
    if (await ReplicaAssets.digest(partial) !== asset.sha256) { fileIo.unlinkSync(partial); throw new Error('附件完整性校验失败，已清除损坏断点'); }
    fileIo.renameSync(partial, final); return final;
  }

  private async request(path: string, method: string, body?: ArrayBuffer, extra: Record<string, string> = {}): Promise<AssetReply> {
    if (!/^\/sync\/v1\/assets\/[a-f0-9]{64}$/.test(path)) throw new Error('附件请求路径无效');
    const request = http.createHttp();
    try {
      const headers: Record<string, string> = { 'Authorization': `Bearer ${this.token}`, 'X-Leo-Device-ID': this.deviceId, 'Content-Type': 'application/octet-stream' };
      const names = Object.keys(extra); for (let i = 0; i < names.length; i++) headers[names[i]] = extra[names[i]];
      const response = await request.request(this.root + path, { method: method as http.RequestMethod, header: headers, extraData: body,
        expectDataType: http.HttpDataType.ARRAY_BUFFER, maxRedirects: 0, maxLimit: CHUNK + 4096, connectTimeout: 10000, readTimeout: 30000 });
      const reply = new AssetReply(); reply.code = response.responseCode;
      const raw = response.header as Record<string, Object>; const keys = Object.keys(raw);
      for (let i = 0; i < keys.length; i++) reply.headers[keys[i].toLowerCase()] = `${raw[keys[i]]}`;
      if (typeof response.result === 'string') {
        const bytes = new util.TextEncoder().encodeInto(response.result);
        reply.bytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } else reply.bytes = response.result as ArrayBuffer;
      return reply;
    } finally { request.destroy(); }
  }
}
