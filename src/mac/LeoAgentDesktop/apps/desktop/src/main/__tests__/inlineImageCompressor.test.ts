/**
 * inlineImageCompressor 单测:验证 inline(LLM-facing)图片副本被压到目标字节
 * 以内,以及小图 / 不可解码输入的降级路径。背景:tool-result stream-json 行
 * 超 256KiB 会被分块写、可能被同进程 stdout 日志插队损坏(详见实现文件头注释)。
 *
 * 依赖真实 sharp(desktop 直接依赖);加载失败时跳过压缩用例,只跑降级路径。
 */
import { describe, expect, it } from 'vitest';
import { compressInlineImage } from '../mcp-integrations/inlineImageCompressor.js';

let sharpAvailable = true;
let sharp: (typeof import('sharp'))['default'];
try {
  sharp = (await import('sharp')).default as unknown as (typeof import('sharp'))['default'];
} catch {
  sharpAvailable = false;
}

const TARGET = 140_000;

/** 生成一张噪声 PNG(高熵、体积大,逼近真实照片/AI 生成图的压缩难度)。 */
async function makeNoisePng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  // 确定性伪随机(xorshift32,Math.imul 避免 53-bit 精度丢失),保证测试可复现
  let seed = 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed = Math.imul(seed, 5) + 0x7f4a7c15;
    raw[i] = seed & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe('compressInlineImage', () => {
  it('under-target input → null (inline as-is)', async () => {
    const small = Buffer.alloc(10_000, 3);
    expect(await compressInlineImage(small, 'image/png', { targetBytes: TARGET })).toBeNull();
  });

  it.skipIf(!sharpAvailable)('oversized PNG → webp under target bytes', async () => {
    const big = await makeNoisePng(1376, 768);
    expect(big.byteLength).toBeGreaterThan(TARGET);
    const out = await compressInlineImage(big, 'image/png', { targetBytes: TARGET });
    expect(out).not.toBeNull();
    expect(out!.mime).toBe('image/webp');
    expect(out!.buffer.byteLength).toBeLessThanOrEqual(TARGET);
  });

  it.skipIf(!sharpAvailable)('undecodable oversized input → null, never throws', async () => {
    const garbage = Buffer.alloc(300_000, 0xab);
    expect(
      await compressInlineImage(garbage, 'image/png', { targetBytes: TARGET }),
    ).toBeNull();
  });
});
