import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { image } from '@kit.ImageKit';
import { http } from '@kit.NetworkKit';
import { url, util } from '@kit.ArkTS';

type MediaObject = Record<string, Object>;
const MAX_BYTES: number = 8 * 1024 * 1024;
const MAX_PIXELS: number = 24 * 1024 * 1024;
const MAX_BASE64: number = Math.ceil(MAX_BYTES / 3) * 4;
const MAX_EVENT: number = 64 * 1024 * 1024;
const MAX_ITEMS: number = 32;

export class GeneratedImageCandidate {
  base64: string = '';
  url: string = '';
  mime: string = '';
  sourceId: string = '';
  final: boolean = true;
}
export class GeneratedImage {
  path: string = '';
  mime: string = '';
  width: number = 0;
  height: number = 0;
  byteCount: number = 0;
  sourceId: string = '';
  contentHash: string = '';
}
export class GeneratedMediaError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function object(value: Object | undefined): MediaObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MediaObject : {};
}
function list(value: Object | undefined): MediaObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry: Object) => !!entry && typeof entry === 'object' && !Array.isArray(entry)) as MediaObject[];
}
function text(value: Object | undefined): string { return typeof value === 'string' ? value : ''; }
function mime(value: string): string {
  const normalized = value.trim().toLowerCase().split(';')[0];
  if (normalized === 'image/jpg' || normalized === 'jpeg' || normalized === 'jpg') return 'image/jpeg';
  if (normalized === 'png' || normalized === 'webp') return 'image/' + normalized;
  return normalized;
}
function sourceId(value: Object | undefined): string {
  const id = text(value);
  return id.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(id) && !/^https?:/i.test(id) ? id : '';
}
function active(isCurrent: () => boolean, expiresAt: number): void {
  if (!Number.isFinite(expiresAt) || expiresAt < 0) throw new GeneratedMediaError('expiry', '图片有效期无效');
  let current = false;
  try { current = isCurrent(); } catch (_error) { }
  if (!current) throw new GeneratedMediaError('cancelled', '生成图片任务已取消或已切换');
  if (expiresAt > 0 && Date.now() >= expiresAt) throw new GeneratedMediaError('expired', '此生成图片结果已过期');
}
function validateURL(raw: string): string {
  if (!raw || raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw)) throw new GeneratedMediaError('invalid_url', '生成图片预览地址无效');
  try {
    const address = new url.URL(raw);
    if (address.protocol !== 'https:' || !address.hostname || address.username || address.password || address.hash) throw new Error('invalid');
  } catch (_error) { throw new GeneratedMediaError('invalid_url', '生成图片预览需要有效的HTTPS地址'); }
  return raw;
}
function add(out: GeneratedImageCandidate[], value: string, hint: string, id: Object | undefined,
  final: boolean, encoded: boolean = false): void {
  if (!value) return;
  if (out.length >= MAX_ITEMS) throw new GeneratedMediaError('limit', '单个响应中的生成图片数量过多');
  const candidate = new GeneratedImageCandidate();
  candidate.mime = mime(hint);
  candidate.sourceId = sourceId(id);
  candidate.final = final;
  if (value.startsWith('data:')) {
    const separator = value.indexOf(',');
    const header = separator >= 0 ? value.substring(5, separator) : '';
    if (!/^image\/[A-Za-z0-9.+-]+;base64$/i.test(header)) throw new GeneratedMediaError('invalid_data', '生成图片Data URL格式无效');
    candidate.mime = mime(header.substring(0, header.indexOf(';')));
    candidate.base64 = value.substring(separator + 1);
  } else if (encoded) {
    candidate.base64 = value;
  } else {
    candidate.url = validateURL(value);
  }
  if (candidate.base64.length > MAX_BASE64 + 65536) throw new GeneratedMediaError('limit', '生成图片超过8MiB存储上限');
  out.push(candidate);
}
function imageItem(out: GeneratedImageCandidate[], item: MediaObject, final: boolean = true): void {
  const raw = text(item['b64_json']) || text(item['imageBytes']);
  const hint = text(item['mime_type']) || text(item['mimeType']) || text(item['output_format']);
  if (raw) { add(out, raw, hint, item['id'], final, true); return; }
  const imageURL = item['image_url'];
  const location = typeof imageURL === 'string' ? imageURL : text(object(imageURL)['url']);
  if (location || text(item['url'])) add(out, location || text(item['url']), hint, item['id'], final);
}
function responseItem(out: GeneratedImageCandidate[], item: MediaObject, eventId: Object | undefined,
  final: boolean): void {
  if (text(item['type']) !== 'image_generation_call') return;
  if (text(item['status']) === 'failed' || text(item['status']) === 'cancelled') return;
  const completed = final && text(item['status']) !== 'in_progress' && text(item['status']) !== 'generating';
  add(out, text(item['result']), text(item['output_format']), item['id'] ?? eventId, completed, true);
}
function consume(out: GeneratedImageCandidate[], event: MediaObject): void {
  const type = text(event['type']);
  if (type === 'response.image_generation_call.partial_image') {
    add(out, text(event['partial_image_b64']), text(event['output_format']), event['item_id'], false, true);
    return;
  }
  if (type === 'response.output_item.done' || type === 'response.output_item.added') {
    responseItem(out, object(event['item']), event['item_id'], type.endsWith('.done'));
  }
  if (type === 'image_generation_call') responseItem(out, event, undefined, true);
  list(event['output']).forEach((item: MediaObject) => responseItem(out, item, undefined, true));
  const response = object(event['response']);
  list(response['output']).forEach((item: MediaObject) => responseItem(out, item, undefined, type === 'response.completed' || text(response['status']) === 'completed'));
  list(event['data']).forEach((item: MediaObject) => imageItem(out, item));
  list(event['images']).forEach((item: MediaObject) => imageItem(out, item));
  list(event['choices']).forEach((choice: MediaObject) => {
    const message = Object.keys(object(choice['delta'])).length ? object(choice['delta']) : object(choice['message']);
    list(message['images']).forEach((item: MediaObject) => imageItem(out, item));
    list(message['content']).forEach((part: MediaObject) => {
      if (text(part['type']) === 'image_url' || text(part['type']) === 'output_image') imageItem(out, part);
    });
  });
  list(event['candidates']).forEach((candidate: MediaObject) => {
    const content = object(candidate['content']);
    if (text(content['role']) === 'user') return;
    list(content['parts']).forEach((part: MediaObject) => {
      const inline = object(part['inlineData'] ?? part['inline_data']);
      const type = text(inline['mimeType']) || text(inline['mime_type']);
      if (mime(type).startsWith('image/')) add(out, text(inline['data']), type, part['id'] ?? inline['id'], part['thought'] !== true, true);
    });
  });
}
function sniff(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
    bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
    bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
  throw new GeneratedMediaError('invalid_image', '生成图片需要有效的PNG、JPEG或WebP数据');
}
function dimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
    throw new GeneratedMediaError('dimensions', '生成图片像素超过24MiB像素上限');
  }
}
function decodeBase64(raw: string): Uint8Array {
  if (!raw || raw.length > MAX_BASE64 + 65536) throw new GeneratedMediaError('limit', '生成图片数据为空或超过8MiB');
  let normalized = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1 || normalized.length > MAX_BASE64) throw new GeneratedMediaError('invalid_base64', '生成图片Base64数据无效');
  if (normalized.indexOf('=') >= 0 && normalized.length % 4 !== 0) throw new GeneratedMediaError('invalid_base64', '生成图片Base64填充无效');
  normalized = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=');
  const bytes = new util.Base64Helper().decodeSync(normalized);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new GeneratedMediaError('limit', '生成图片数据超过8MiB');
  return bytes;
}

/** Provider output media is separate from user input and carries no provider credentials. */
export class GeneratedMedia {
  static parseEvent(raw: string): GeneratedImageCandidate[] {
    if (raw.length > MAX_EVENT) throw new GeneratedMediaError('limit', '生成图片响应超过单包上限');
    const data = raw.trim().startsWith('data:') ? raw.trim().substring(5).trim() : raw.trim();
    if (!data || data === '[DONE]') return [];
    let decoded: Object;
    try { decoded = JSON.parse(data) as Object; } catch (_error) { return []; }
    const output: GeneratedImageCandidate[] = [];
    if (Array.isArray(decoded)) list(decoded).forEach((event: MediaObject) => consume(output, event));
    else consume(output, object(decoded));
    return output;
  }
  private static async download(location: string, isCurrent: () => boolean, expiresAt: number): Promise<Uint8Array> {
    const address = validateURL(location);
    if (deviceInfo.sdkApiVersion < 23) throw new GeneratedMediaError('unsupported', '当前系统未开放安全的图片重定向控制');
    const request = http.createHttp();
    const timer = setInterval(() => {
      try { active(isCurrent, expiresAt); } catch (_error) { request.destroy(); }
    }, 100);
    try {
      active(isCurrent, expiresAt);
      const response = await request.request(address, {
        method: http.RequestMethod.GET, header: { 'Accept': 'image/png,image/jpeg,image/webp' },
        expectDataType: http.HttpDataType.ARRAY_BUFFER, usingCache: false, maxRedirects: 0,
        maxLimit: MAX_BYTES, connectTimeout: 15000, readTimeout: 60000
      });
      active(isCurrent, expiresAt);
      if (response.responseCode !== 200 || !(response.result instanceof ArrayBuffer)) throw new GeneratedMediaError('download', '生成图片预览下载未完成');
      const bytes = new Uint8Array(response.result);
      if (!bytes.length || bytes.length > MAX_BYTES) throw new GeneratedMediaError('limit', '生成图片下载数据超过8MiB');
      return bytes;
    } catch (_error) {
      active(isCurrent, expiresAt);
      // Signed URLs and native request error text never enter logs or returned diagnostics.
      throw new GeneratedMediaError('download', '生成图片预览暂时无法下载');
    } finally { clearInterval(timer); request.destroy(); }
  }
  static async save(context: common.Context, candidate: GeneratedImageCandidate, isCurrent: () => boolean,
    expiresAt: number = 0): Promise<GeneratedImage> {
    active(isCurrent, expiresAt);
    if (!candidate.final) throw new GeneratedMediaError('partial', '图片仍在生成，等待完整结果');
    let bytes = candidate.base64 ? decodeBase64(candidate.base64) : await GeneratedMedia.download(candidate.url, isCurrent, expiresAt);
    active(isCurrent, expiresAt);
    let actualMime = sniff(bytes);
    if (candidate.mime && mime(candidate.mime) !== actualMime) throw new GeneratedMediaError('mime', '生成图片声明格式与实际数据不一致');
    const source = image.createImageSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const result = new GeneratedImage();
    try {
      const info = await source.getImageInfo();
      active(isCurrent, expiresAt);
      dimensions(info.size.width, info.size.height);
      result.width = info.size.width; result.height = info.size.height;
      const preview = await source.createPixelMap({ desiredSize: { width: 1, height: 1 } });
      try { active(isCurrent, expiresAt); } finally { await preview.release(); }
      active(isCurrent, expiresAt);
      // Normalize WebP losslessly to the PNG/JPEG archive contract already supported by SessionStore.
      if (actualMime === 'image/webp') {
        const packer = image.createImagePacker();
        try {
          const packed = await packer.packing(source, { format: 'image/png', quality: 100 });
          active(isCurrent, expiresAt);
          bytes = new Uint8Array(packed);
          actualMime = 'image/png';
        } finally { await packer.release(); }
        active(isCurrent, expiresAt);
        if (!bytes.length || bytes.length > MAX_BYTES) throw new GeneratedMediaError('limit', '生成图片转换后为空或超过8MiB存储上限');
        if (sniff(bytes) !== 'image/png') throw new GeneratedMediaError('mime', '生成图片转换格式无效');
        const converted = image.createImageSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        try {
          const convertedInfo = await converted.getImageInfo();
          active(isCurrent, expiresAt);
          dimensions(convertedInfo.size.width, convertedInfo.size.height);
          result.width = convertedInfo.size.width; result.height = convertedInfo.size.height;
        } finally { await converted.release(); }
        active(isCurrent, expiresAt);
      }
    } catch (error) {
      if (error instanceof GeneratedMediaError) throw error;
      throw new GeneratedMediaError('decode', '生成图片无法完整解码');
    } finally { await source.release(); }
    active(isCurrent, expiresAt);
    const digest = cryptoFramework.createMd('SHA256');
    await digest.update({ data: bytes });
    active(isCurrent, expiresAt);
    const hash = (await digest.digest()).data;
    active(isCurrent, expiresAt);
    for (const byte of hash) result.contentHash += byte.toString(16).padStart(2, '0');
    result.sourceId = sourceId(candidate.sourceId) || 'image-' + result.contentHash;
    result.mime = actualMime; result.byteCount = bytes.byteLength;
    const directory = context.filesDir + '/chat-images';
    if (!fileIo.accessSync(directory)) fileIo.mkdirSync(directory);
    const status = fileIo.lstatSync(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new GeneratedMediaError('directory', '图片目录暂不可写');
    const name = 'generated-' + util.generateRandomUUID(false);
    const temporary = directory + '/.' + name + '.tmp';
    const destination = directory + '/' + name + (actualMime === 'image/png' ? '.png' : '.jpg');
    let renamed = false;
    try {
      active(isCurrent, expiresAt);
      const file = fileIo.openSync(temporary, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
      try {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (await fileIo.write(file.fd, buffer) !== bytes.byteLength) throw new GeneratedMediaError('write', '生成图片写入不完整');
        active(isCurrent, expiresAt);
        await fileIo.fsync(file.fd);
        active(isCurrent, expiresAt);
      } finally { await fileIo.close(file); }
      active(isCurrent, expiresAt);
      fileIo.renameSync(temporary, destination);
      renamed = true;
      const folder = fileIo.openSync(directory, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
      try { await fileIo.fsync(folder.fd); } finally { await fileIo.close(folder); }
      active(isCurrent, expiresAt);
      result.path = destination;
      return result;
    } finally {
      try { if (fileIo.accessSync(temporary)) fileIo.unlinkSync(temporary); } catch (_cleanupError) { }
      if (renamed && !result.path) {
        try { fileIo.unlinkSync(destination); } catch (_cleanupError) { }
      }
    }
  }
}
