/**
 * gzipBase64 单测:renderer 侧 CompressionStream 编解码,与被控端 node:zlib
 * 的双向互操作(控制端压 → main 解;main 压 → 控制端解)。node ≥18 全局带
 * CompressionStream/Blob/Response/btoa,vitest node 环境可直跑。
 */

import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { gzipTextToBase64, gunzipBase64ToText } from '../lib/gzipBase64';

describe('gzipBase64', () => {
  it('roundtrips ASCII and CJK text', async () => {
    const samples = ['', 'hello world', '# 标题\n中文正文内容。\n'.repeat(1000)];
    for (const s of samples) {
      expect(await gunzipBase64ToText(await gzipTextToBase64(s))).toBe(s);
    }
  });

  it('interop: renderer-compressed payload decodes with node zlib (被控端解码路径)', async () => {
    const original = '远程写入 payload\n'.repeat(5000);
    const b64 = await gzipTextToBase64(original);
    expect(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')).toBe(original);
  });

  it('interop: node-zlib-compressed payload decodes in renderer helper (readFile 返回路径)', async () => {
    const original = '中'.repeat(100_000);
    const b64 = gzipSync(Buffer.from(original, 'utf8')).toString('base64');
    expect(await gunzipBase64ToText(b64)).toBe(original);
  });

  it('actually shrinks compressible text well below plaintext size', async () => {
    const original = '中'.repeat(700_000); // 2.1MB UTF-8
    const b64 = await gzipTextToBase64(original);
    expect(b64.length).toBeLessThan(100_000);
  });

  it('rejects on corrupted input instead of returning garbage', async () => {
    await expect(gunzipBase64ToText('bm90LWd6aXA=')).rejects.toThrow();
  });
});
