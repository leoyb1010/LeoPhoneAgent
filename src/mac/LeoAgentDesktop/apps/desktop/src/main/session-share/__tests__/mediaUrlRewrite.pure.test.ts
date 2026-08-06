import { describe, expect, it } from 'vitest';

import {
  buildLooseUrl,
  collectMediaUrls,
  extractLoosePath,
  parseImageUrl,
  rewriteMediaUrls,
} from '../mediaUrlRewrite.pure.js';

const IMAGE_URL = 'xdt-image://old-session-id/img-123.png';
const RESERVED_IMAGE_URL = 'xdt-image://lizi-art-media-images/file-9.png';
const VIDEO_URL = 'xdt-video://lizi-art-videos/vid-1.mp4';
const MODEL_URL = 'xdt-model://mivo-3d-cache/model-1.glb';
const FILE_URL = 'xdt-file://local/?path=%2FUsers%2Fa%2Fdoc%20name.pdf';
const AUDIO_URL = 'xdt-audio://local/?path=%2FUsers%2Fa%2Fsong.mp3';

describe('collectMediaUrls', () => {
  it('collects all five schemes from a JSON content string, deduped', () => {
    const content = JSON.stringify([
      { type: 'text', text: `看图 ${IMAGE_URL} 和视频 ${VIDEO_URL}` },
      { type: 'text', text: `模型 ${MODEL_URL} 文件 ${FILE_URL} 音频 ${AUDIO_URL}` },
      { type: 'text', text: `重复引用 ${IMAGE_URL}` },
    ]);
    const urls = collectMediaUrls(content);
    expect(urls.map((u) => u.url)).toEqual([IMAGE_URL, VIDEO_URL, MODEL_URL, FILE_URL, AUDIO_URL]);
    expect(urls.map((u) => u.scheme)).toEqual([
      'xdt-image',
      'xdt-video',
      'xdt-model',
      'xdt-file',
      'xdt-audio',
    ]);
  });

  it('returns empty for content without media urls', () => {
    expect(collectMediaUrls('{"text":"hello https://example.com"}')).toEqual([]);
  });

  it('stops at markdown/JSON boundary characters', () => {
    const content = `![img](${IMAGE_URL}) "quoted ${VIDEO_URL}"`;
    const urls = collectMediaUrls(content).map((u) => u.url);
    expect(urls).toEqual([IMAGE_URL, VIDEO_URL]);
  });
});

describe('parseImageUrl / extractLoosePath', () => {
  it('parses per-session image url host and filename', () => {
    expect(parseImageUrl(IMAGE_URL)).toEqual({ host: 'old-session-id', filename: 'img-123.png' });
    expect(parseImageUrl(RESERVED_IMAGE_URL)).toEqual({
      host: 'lizi-art-media-images',
      filename: 'file-9.png',
    });
    expect(parseImageUrl(VIDEO_URL)).toBeNull();
    expect(parseImageUrl('xdt-image://')).toBeNull();
  });

  it('returns null (not throws) for malformed percent sequences in image urls', () => {
    expect(parseImageUrl('xdt-image://a%2/f.png')).toBeNull();
    expect(parseImageUrl('xdt-image://host/%E0%A4%A.png')).toBeNull();
  });

  it('extracts percent-decoded absolute path from loose urls', () => {
    expect(extractLoosePath(FILE_URL)).toBe('/Users/a/doc name.pdf');
    expect(extractLoosePath(AUDIO_URL)).toBe('/Users/a/song.mp3');
    expect(extractLoosePath(IMAGE_URL)).toBeNull();
    expect(extractLoosePath('xdt-file://local/')).toBeNull();
  });

  it('buildLooseUrl roundtrips through extractLoosePath, including windows paths', () => {
    const winPath = 'C:\\Users\\b\\音频 file.mp3';
    const url = buildLooseUrl('xdt-audio', winPath);
    expect(extractLoosePath(url)).toBe(winPath);
  });

  it('buildLooseUrl escapes parens/quotes so collectMediaUrls sees the full url', () => {
    // encodeURIComponent 不转义 ()!'*,URL_PATTERN 又以括号/引号为边界——
    // 重建的 URL 必须整体落在安全字符集内,否则下次导出会被截断(bot 指出)。
    const trickyPath = "/Users/b/report (final) 'v2'!.pdf";
    const url = buildLooseUrl('xdt-file', trickyPath);
    expect(url).not.toMatch(/[()!'*]/);
    const collected = collectMediaUrls(`前缀 ${url} 后缀`);
    expect(collected).toHaveLength(1);
    expect(collected[0].url).toBe(url);
    expect(extractLoosePath(collected[0].url)).toBe(trickyPath);
  });
});

describe('rewriteMediaUrls', () => {
  it('rewrites per-session image host, leaves reserved hosts untouched', () => {
    const content = JSON.stringify({ a: IMAGE_URL, b: RESERVED_IMAGE_URL });
    const rewritten = rewriteMediaUrls(content, {
      imageSessionId: { from: 'old-session-id', to: 'new-session-id' },
    });
    expect(rewritten).toContain('xdt-image://new-session-id/img-123.png');
    expect(rewritten).toContain(RESERVED_IMAGE_URL);
    expect(rewritten).not.toContain('old-session-id');
  });

  it('rewrites loose urls via exact url map', () => {
    const newUrl = buildLooseUrl('xdt-file', '/Users/b/shared-media/new-id/doc name.pdf');
    const content = JSON.stringify({ text: `文件 ${FILE_URL} 结束` });
    const rewritten = rewriteMediaUrls(content, { urlMap: new Map([[FILE_URL, newUrl]]) });
    expect(rewritten).toContain(newUrl);
    expect(rewritten).not.toContain('%2FUsers%2Fa%2F');
  });

  it('no-op when rules do not match', () => {
    const content = JSON.stringify({ a: RESERVED_IMAGE_URL });
    expect(
      rewriteMediaUrls(content, {
        imageSessionId: { from: 'absent', to: 'x' },
        urlMap: new Map([['xdt-file://local/?path=%2Fnope', 'xdt-file://local/?path=%2Fnew']]),
      }),
    ).toBe(content);
  });

  it('prefix-colliding urls rewrite longest-first without corrupting each other', () => {
    const shortUrl = 'xdt-file://local/?path=%2FUsers%2Fa%2Fdoc';
    const longUrl = 'xdt-file://local/?path=%2FUsers%2Fa%2Fdoc2'; // shortUrl 是它的前缀
    const content = JSON.stringify({ a: shortUrl, b: longUrl });
    const rewritten = rewriteMediaUrls(content, {
      urlMap: new Map([
        [shortUrl, 'xdt-file://local/?path=%2Fnew%2Fdoc'],
        [longUrl, 'xdt-file://local/?path=%2Fnew%2Fdoc2'],
      ]),
    });
    expect(rewritten).toContain('xdt-file://local/?path=%2Fnew%2Fdoc2');
    expect(rewritten).toContain('"a":"xdt-file://local/?path=%2Fnew%2Fdoc"');
    // 长 URL 不应被短 URL 的替换撕成 `%2Fnew%2Fdoc` + 残尾 `2` 之外的错误形态
    expect(rewritten).not.toContain('%2FUsers%2Fa');
  });

  it('identical from/to is a no-op', () => {
    const content = JSON.stringify({ a: IMAGE_URL });
    expect(
      rewriteMediaUrls(content, { imageSessionId: { from: 'old-session-id', to: 'old-session-id' } }),
    ).toBe(content);
  });
});
