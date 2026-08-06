/**
 * imageProbe.test.ts — 图片字节头部尺寸探测单测(纯函数,无 Electron)。
 * 覆盖:png/gif/webp(VP8/VP8L/VP8X)/jpeg 四格式解析、截断/垃圾字节
 * 一律 null 不抛。fixture 为手工构造的最小合法文件头。
 */

import { describe, expect, it } from 'vitest';

import { probeImageSize } from '../imageProbe';

/** 最小 PNG 头:签名 + IHDR(width=800, height=600)。 */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe('probeImageSize', () => {
  it('png:IHDR 大端宽高', () => {
    expect(probeImageSize(pngHeader(1024, 1536))).toEqual({ width: 1024, height: 1536 });
  });

  it('gif:小端逻辑屏幕宽高(87a/89a 都认)', () => {
    const b = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);
    expect(probeImageSize(b)).toEqual({ width: 800, height: 600 }); // 0x0320, 0x0258
  });

  it('webp VP8(有损):同步码后 14 位宽高', () => {
    const b = new Uint8Array(30);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    b.set([0x56, 0x50, 0x38, 0x20], 12); // 'VP8 '
    b.set([0x9d, 0x01, 0x2a], 23); // 同步码
    new DataView(b.buffer).setUint16(26, 640, true);
    new DataView(b.buffer).setUint16(28, 480, true);
    expect(probeImageSize(b)).toEqual({ width: 640, height: 480 });
  });

  it('webp VP8L(无损):28 位打包宽高', () => {
    const b = new Uint8Array(30);
    b.set([0x52, 0x49, 0x46, 0x46], 0);
    b.set([0x57, 0x45, 0x42, 0x50], 8);
    b.set([0x56, 0x50, 0x38, 0x4c], 12); // 'VP8L'
    b[20] = 0x2f;
    // width-1=1023 (低 14 位), height-1=767(接着 14 位)
    const packed = (1023 & 0x3fff) | ((767 & 0x3fff) << 14);
    b[21] = packed & 0xff;
    b[22] = (packed >> 8) & 0xff;
    b[23] = (packed >> 16) & 0xff;
    b[24] = (packed >> 24) & 0xff;
    expect(probeImageSize(b)).toEqual({ width: 1024, height: 768 });
  });

  it('webp VP8X(扩展):3 字节 canvas-1 宽高', () => {
    const b = new Uint8Array(30);
    b.set([0x52, 0x49, 0x46, 0x46], 0);
    b.set([0x57, 0x45, 0x42, 0x50], 8);
    b.set([0x56, 0x50, 0x38, 0x58], 12); // 'VP8X'
    b[24] = 0xff;
    b[25] = 0x03; // width-1 = 1023
    b[27] = 0xff;
    b[28] = 0x01; // height-1 = 511
    expect(probeImageSize(b)).toEqual({ width: 1024, height: 512 });
  });

  it('jpeg:跳过 APP0 段找 SOF0(先高后宽)', () => {
    const b = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0,len=4(含 2 字节自身)
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x02, 0x03, // SOF0: h=600,w=800
    ]);
    expect(probeImageSize(b)).toEqual({ width: 800, height: 600 });
  });

  it('垃圾/截断/视频字节一律 null,不抛异常', () => {
    expect(probeImageSize(new Uint8Array(0))).toBeNull();
    expect(probeImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(probeImageSize(pngHeader(800, 600).slice(0, 12))).toBeNull();
    // mp4 头(ftyp)不是图片
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
    expect(probeImageSize(mp4)).toBeNull();
    // jpeg 只有 SOI 没有 SOF
    expect(probeImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
