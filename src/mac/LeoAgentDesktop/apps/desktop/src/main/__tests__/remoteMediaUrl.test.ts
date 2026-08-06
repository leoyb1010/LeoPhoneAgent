/**
 * remoteMediaUrl.test.ts — 远程媒体 URL 编解码 + 改写契约。
 * ---------------------------------------------------------------------------
 * 钉死:
 *   - base64url 往返(含 CJK,UTF-8 安全)
 *   - originToken 线格式:device 裸串(URL 逐字节与 ssh 支持引入前一致)/
 *     ssh JSON 往返 / legacy 裸 deviceId 兼容 / 畸形 JSON 对象拒绝
 *   - build/parse 往返,且 **deviceId 大小写不被破坏**(放路径段而非 host 的核心原因)
 *   - parse 对畸形 / 非远程 / 错 host / 错段数 一律 null
 *   - isRewritableMediaUrl 只认 5 个本机媒体 scheme(4 个 xdt 系 + cindy-media)
 *   - ssh 白名单:仅 workdir 内带路径的 xdt-file / xdt-audio(cache-id / workdir
 *     外 / `..` 逃逸一律不改写)
 *   - rewriteToRemoteMedia(Origin):本地会话 / 已远程 / http(s) 一律不改写
 */
import { describe, it, expect } from 'vitest';
import {
  toBase64Url,
  fromBase64Url,
  encodeRemoteMediaOriginToken,
  decodeRemoteMediaOriginToken,
  extractMediaPathQuery,
  isSshRewritableMediaUrl,
  buildRemoteMediaUrl,
  parseRemoteMediaUrl,
  isRewritableMediaUrl,
  isRemoteMediaUrl,
  rewriteToRemoteMedia,
  rewriteToRemoteMediaOrigin,
  REMOTE_MEDIA_SCHEME,
  type RemoteMediaOrigin,
} from '../../shared/remoteMediaUrl';

const DEV: RemoteMediaOrigin = { kind: 'device', deviceId: 'dev-XYZ' };
const SSH: RemoteMediaOrigin = { kind: 'ssh', remoteHostId: 'host-1', workdir: '/home/u/proj' };

describe('base64url 往返', () => {
  it('ASCII / CJK / 特殊字符均无损', () => {
    for (const s of ['hello', 'xdt-image://abc/汉字 文件.png', 'a/b?c=1&d=2', '🎬视频']) {
      expect(fromBase64Url(toBase64Url(s))).toBe(s);
    }
  });
  it('产物只含 base64url 字母表(无 +/=)', () => {
    const enc = toBase64Url('xdt-video://s/汉字.mp4?x=1');
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('originToken 线格式', () => {
  it('device → 裸 deviceId(URL 形态与 ssh 支持引入前逐字节一致)', () => {
    expect(encodeRemoteMediaOriginToken(DEV)).toBe('dev-XYZ');
    // 线格式稳定性:整条 URL 与旧版 buildRemoteMediaUrl(deviceId, url) 的产物一致。
    const url = buildRemoteMediaUrl(DEV, 'xdt-image://s/x.png');
    expect(url).toBe(
      `${REMOTE_MEDIA_SCHEME}://m/${toBase64Url('dev-XYZ')}/${toBase64Url('xdt-image://s/x.png')}`,
    );
  });
  it('ssh → JSON 往返(携带 workdir)', () => {
    const token = encodeRemoteMediaOriginToken(SSH);
    expect(decodeRemoteMediaOriginToken(token)).toEqual(SSH);
  });
  it('legacy 裸 deviceId → device 来源(含非 JSON 的任意串)', () => {
    expect(decodeRemoteMediaOriginToken('dev-1')).toEqual({ kind: 'device', deviceId: 'dev-1' });
    expect(decodeRemoteMediaOriginToken('123')).toEqual({ kind: 'device', deviceId: '123' });
    expect(decodeRemoteMediaOriginToken('{not json')).toEqual({ kind: 'device', deviceId: '{not json' });
  });
  it('JSON 对象但判别不合法 → null(不误当 deviceId)', () => {
    expect(decodeRemoteMediaOriginToken('{"k":"ssh","id":"h"}')).toBeNull(); // 缺 wd
    expect(decodeRemoteMediaOriginToken('{"k":"nope","id":"x"}')).toBeNull();
    expect(decodeRemoteMediaOriginToken('{"k":"ssh","id":"","wd":"/w"}')).toBeNull();
    expect(decodeRemoteMediaOriginToken('')).toBeNull();
  });
});

describe('build / parse 往返', () => {
  it('还原 device origin + origUrl', () => {
    const orig = 'xdt-image://session-1/汉字.png';
    const url = buildRemoteMediaUrl(DEV, orig);
    expect(url.startsWith(`${REMOTE_MEDIA_SCHEME}://m/`)).toBe(true);
    expect(parseRemoteMediaUrl(url)).toEqual({ origin: DEV, origUrl: orig });
  });

  it('还原 ssh origin(remoteHostId + workdir)+ origUrl', () => {
    const orig = 'xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2Fa.png';
    const url = buildRemoteMediaUrl(SSH, orig);
    expect(parseRemoteMediaUrl(url)).toEqual({ origin: SSH, origUrl: orig });
  });

  it('deviceId 大小写被保留(放路径段、不放 host)', () => {
    const url = buildRemoteMediaUrl(
      { kind: 'device', deviceId: 'DeViCe-AbC123' },
      'xdt-file://local/?path=%2Ftmp%2Fx.pdf',
    );
    const parsed = parseRemoteMediaUrl(url);
    expect(parsed?.origin).toEqual({ kind: 'device', deviceId: 'DeViCe-AbC123' });
  });

  it('畸形 / 非远程 / 错 host / 错段数 → null', () => {
    expect(parseRemoteMediaUrl('xdt-image://s/x.png')).toBeNull();
    expect(parseRemoteMediaUrl('https://x/y')).toBeNull();
    expect(parseRemoteMediaUrl(`${REMOTE_MEDIA_SCHEME}://wronghost/a/b`)).toBeNull();
    expect(parseRemoteMediaUrl(`${REMOTE_MEDIA_SCHEME}://m/onlyoneseg`)).toBeNull();
    expect(parseRemoteMediaUrl(`${REMOTE_MEDIA_SCHEME}://m/a/b/c`)).toBeNull();
    // token 是合法 base64url 但解出畸形 JSON 对象 → null
    const badToken = toBase64Url('{"k":"ssh","id":"h"}');
    expect(parseRemoteMediaUrl(`${REMOTE_MEDIA_SCHEME}://m/${badToken}/${toBase64Url('x')}`)).toBeNull();
  });
});

describe('isRewritableMediaUrl', () => {
  it('只认 5 个本机媒体 scheme(4 个 xdt 系 + 媒体总仓 cindy-media)', () => {
    expect(isRewritableMediaUrl('xdt-image://s/x.png')).toBe(true);
    expect(isRewritableMediaUrl('xdt-video://s/x.mp4')).toBe(true);
    expect(isRewritableMediaUrl('xdt-file://local/?path=/x')).toBe(true);
    expect(isRewritableMediaUrl('xdt-audio://local/?path=/x')).toBe(true);
    expect(isRewritableMediaUrl('cindy-media://blobs/aa11bb22.png')).toBe(true);
    expect(isRewritableMediaUrl('xdt-model://s/x.glb')).toBe(false); // 3D 不在范围
    expect(isRewritableMediaUrl('https://x/y.png')).toBe(false);
    expect(isRewritableMediaUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isRewritableMediaUrl(42)).toBe(false);
  });
});

describe('extractMediaPathQuery / ssh 白名单', () => {
  it('提取 xdt-file / xdt-audio 的绝对路径;相对路径 / 无参数 / 其它 scheme → null', () => {
    expect(extractMediaPathQuery('xdt-file://local/?path=%2Fhome%2Fu%2Fa.png')).toBe('/home/u/a.png');
    expect(extractMediaPathQuery('xdt-audio://local/?path=%2Ftmp%2Fa.mp3')).toBe('/tmp/a.mp3');
    expect(extractMediaPathQuery('xdt-file://local/?path=C%3A%5Ctmp%5Cx.pdf')).toBe('C:\\tmp\\x.pdf');
    expect(extractMediaPathQuery('xdt-file://local/?path=rel%2Fx.png')).toBeNull();
    expect(extractMediaPathQuery('xdt-file://local/')).toBeNull();
    expect(extractMediaPathQuery('xdt-image://s/x.png')).toBeNull();
  });

  it('isSshRewritableMediaUrl:仅 workdir 内 POSIX 路径;cache-id / 外部 / `..` 一律否', () => {
    const wd = '/home/u/proj';
    expect(isSshRewritableMediaUrl('xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2Fout%2Fa.png', wd)).toBe(true);
    expect(isSshRewritableMediaUrl('xdt-audio://local/?path=%2Fhome%2Fu%2Fproj%2Fa.mp3', wd)).toBe(true);
    // workdir 外
    expect(isSshRewritableMediaUrl('xdt-file://local/?path=%2Ftmp%2Fa.png', wd)).toBe(false);
    // 前缀相似但不是子路径(/home/u/proj2)
    expect(isSshRewritableMediaUrl('xdt-file://local/?path=%2Fhome%2Fu%2Fproj2%2Fa.png', wd)).toBe(false);
    // `..` 逃逸
    expect(
      isSshRewritableMediaUrl('xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2F..%2Fsecret.png', wd),
    ).toBe(false);
    // cache-id 媒体(无路径语义)
    expect(isSshRewritableMediaUrl('xdt-image://sess/a.png', wd)).toBe(false);
    expect(isSshRewritableMediaUrl('xdt-video://sess/b.mp4', wd)).toBe(false);
    // workdir 自身 / 空 workdir
    expect(isSshRewritableMediaUrl('xdt-file://local/?path=%2Fhome%2Fu%2Fproj', wd)).toBe(false);
    expect(isSshRewritableMediaUrl('xdt-file://local/?path=%2Fa.png', '')).toBe(false);
  });
});

describe('rewriteToRemoteMedia(device 兼容入口)', () => {
  it('无 deviceId(本地会话)→ 原样', () => {
    expect(rewriteToRemoteMedia('xdt-image://s/x.png', undefined)).toBe('xdt-image://s/x.png');
    expect(rewriteToRemoteMedia('xdt-image://s/x.png', '')).toBe('xdt-image://s/x.png');
  });
  it('已是远程媒体 URL → 不二次包裹', () => {
    const already = rewriteToRemoteMedia('xdt-image://s/x.png', 'dev-1');
    expect(rewriteToRemoteMedia(already, 'dev-1')).toBe(already);
    expect(isRemoteMediaUrl(already)).toBe(true);
  });
  it('http(s)/data → 原样', () => {
    expect(rewriteToRemoteMedia('https://x/y.png', 'dev-1')).toBe('https://x/y.png');
    expect(rewriteToRemoteMedia('data:image/png;base64,AA', 'dev-1')).toBe('data:image/png;base64,AA');
  });
  it('本机媒体 scheme + deviceId → 改写且可往返', () => {
    const out = rewriteToRemoteMedia('xdt-video://s/clip.mp4', 'dev-1');
    expect(isRemoteMediaUrl(out)).toBe(true);
    expect(parseRemoteMediaUrl(out)).toEqual({
      origin: { kind: 'device', deviceId: 'dev-1' },
      origUrl: 'xdt-video://s/clip.mp4',
    });
  });
});

describe('rewriteToRemoteMediaOrigin(按来源白名单)', () => {
  it('device 来源:4 scheme 全量改写', () => {
    for (const u of [
      'xdt-image://s/x.png',
      'xdt-video://s/x.mp4',
      'xdt-file://local/?path=%2Fx.pdf',
      'xdt-audio://local/?path=%2Fx.mp3',
    ]) {
      expect(isRemoteMediaUrl(rewriteToRemoteMediaOrigin(u, DEV))).toBe(true);
    }
  });
  it('ssh 来源:仅 workdir 内 xdt-file / xdt-audio;cache-id 图/视频不改写', () => {
    const inWd = 'xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2Fa.png';
    const out = rewriteToRemoteMediaOrigin(inWd, SSH);
    expect(isRemoteMediaUrl(out)).toBe(true);
    expect(parseRemoteMediaUrl(out)).toEqual({ origin: SSH, origUrl: inWd });

    expect(rewriteToRemoteMediaOrigin('xdt-image://sess/a.png', SSH)).toBe('xdt-image://sess/a.png');
    expect(rewriteToRemoteMediaOrigin('xdt-video://sess/b.mp4', SSH)).toBe('xdt-video://sess/b.mp4');
    const outside = 'xdt-file://local/?path=%2Ftmp%2Fa.png';
    expect(rewriteToRemoteMediaOrigin(outside, SSH)).toBe(outside);
  });
  it('origin 为空 → 原样', () => {
    expect(rewriteToRemoteMediaOrigin('xdt-image://s/x.png', undefined)).toBe('xdt-image://s/x.png');
  });
});
