/**
 * annotationBurnIn — data: image 字节层大小上限回归测试。
 *
 * 背景:loadImageSourceBase64 对 xdt-file / http / cindy-remote-media 三条源都经
 * main 侧 IPC 强制了 100MB 上限,但 data: 源直接在 renderer 里解码,曾经没有
 * 同等保护——一条超大的 markdown data: 图片会在 Copy / Annotate / 发送到对话
 * 时被硬解进 canvas,冻住或崩掉 renderer(P2 review 发现)。这里只覆盖新加的
 * 上限校验本身,不重复测试整个模块。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadImageSourceBase64 } from '@/lib/annotationBurnIn';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ONE_MB = 1024 * 1024;

/** 生成一段解码后约为 targetBytes 的合法 base64 payload。 */
function makeBase64OfDecodedSize(targetBytes: number): string {
  return 'A'.repeat(Math.ceil((targetBytes * 4) / 3));
}

describe('loadImageSourceBase64 — data: base64 分支', () => {
  it('小图正常返回 base64 与 mimeType', async () => {
    const payload = makeBase64OfDecodedSize(1024);
    const result = await loadImageSourceBase64(`data:image/png;base64,${payload}`);
    expect(result.mimeType).toBe('image/png');
    expect(result.base64).toBe(payload);
  });

  it('超过 100MB 上限时拒绝,不去 canvas 解码', async () => {
    const oversized = makeBase64OfDecodedSize(101 * ONE_MB);
    await expect(
      loadImageSourceBase64(`data:image/png;base64,${oversized}`),
    ).rejects.toThrow();
  });
});

describe('loadImageSourceBase64 — data: 非 base64 / 带 MIME 参数分支', () => {
  it('URL 长度超过 100MB 保守估算上限时拒绝,不发起 fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const oversizedUrl = `data:image/svg+xml;charset=utf-8,${'a'.repeat(101 * ONE_MB)}`;
    await expect(loadImageSourceBase64(oversizedUrl)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
