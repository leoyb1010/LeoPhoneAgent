/**
 * imageProbe.ts — 图片字节头部尺寸探测(纯函数,零依赖,不解码像素)。
 *
 * 用途:cindy 槽代办出图后把真实像素宽高随结果带回意识
 * (GhostPipeModelResult.width/height),意识供聊天卡片时据此精确声明
 * 卡高——首帧即最终高度,消灭"估计值 → 实测值"的可见收敛跳变。
 * 只读文件头几十字节,失败一律返回 null(best-effort,不抛不阻断代办)。
 *
 * 覆盖格式与净化器图片白名单一致:png / jpeg / webp / gif。
 */

export interface ProbedImageSize {
  width: number;
  height: number;
}

/** 从图片字节探测像素宽高;非图片 / 格式不识 / 头部截断一律 null。 */
export function probeImageSize(buf: Uint8Array): ProbedImageSize | null {
  try {
    const size = probePng(buf) ?? probeGif(buf) ?? probeWebp(buf) ?? probeJpeg(buf);
    if (!size) return null;
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
    if (size.width <= 0 || size.height <= 0) return null;
    return size;
  } catch {
    return null;
  }
}

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

/** PNG:8 字节签名 + IHDR 块,宽高为 offset 16/20 的大端 u32。 */
function probePng(b: Uint8Array): ProbedImageSize | null {
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  if (b[4] !== 0x0d || b[5] !== 0x0a || b[6] !== 0x1a || b[7] !== 0x0a) return null;
  // 首块必须是 IHDR(offset 12–15)。
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** GIF:'GIF87a'/'GIF89a' + 小端 u16 逻辑屏幕宽高。 */
function probeGif(b: Uint8Array): ProbedImageSize | null {
  if (b.length < 10) return null;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x38) return null;
  if ((b[4] !== 0x37 && b[4] !== 0x39) || b[5] !== 0x61) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

/** WebP:RIFF 容器,按首块类型分 VP8(有损)/ VP8L(无损)/ VP8X(扩展)。 */
function probeWebp(b: Uint8Array): ProbedImageSize | null {
  if (b.length < 30) return null;
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null; // 'RIFF'
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null; // 'WEBP'
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (tag === 'VP8 ') {
    // 有损:3 字节帧标签后是同步码 9D 01 2A,随后小端 u16 的 14 位宽高。
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (tag === 'VP8L') {
    // 无损:签名字节 0x2F 后 28 位打包的 (width-1, height-1)。
    if (b[20] !== 0x2f) return null;
    const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    return { width, height };
  }
  if (tag === 'VP8X') {
    // 扩展:4 字节 flags/保留位后是 3 字节小端的 (canvas-1) 宽高。
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height };
  }
  return null;
}

/** JPEG:FF D8 起,顺着 marker 链找 SOF0–SOF15(跳过 DHT/JPG/DAC),
 *  帧头里是大端 u16 的 height、width(注意顺序:先高后宽)。 */
function probeJpeg(b: Uint8Array): ProbedImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1; // 容忍 marker 间填充
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // 无载荷的独立 marker(RSTn / SOI / EOI 等)。
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS:没等到帧头
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 >= b.length) return null;
      return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    i += 2 + len;
  }
  return null;
}
