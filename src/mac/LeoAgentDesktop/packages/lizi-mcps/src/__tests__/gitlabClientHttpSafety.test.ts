/**
 * gitlab-client HTTP 安全加固回归测试(2026-07 对外安全评估 P2)。
 *
 * gitlab-client 包本身无测试基建,故在 @cindy/mcps(已有 vitest 且依赖该 client)覆盖:
 *  1. assertSafeBaseUrl:非 http(s) 协议 / userinfo / 不可解析一律拒绝;GitLab 侧
 *     允许 http(自建实例惯例)但 https / loopback 恒通过。
 *  2. fetchWithSafeRedirect:非 3xx 原样返回;同源 3xx 带凭据继续跟随;跨源 3xx
 *     fail-closed 抛错且**绝不**把 PRIVATE-TOKEN 重放到另一个 host;超跳数抛错。
 *  3. 端到端:GitlabClient.request() 遇跨 host 重定向时抛错,且 fetch 只打到原 host。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitlabClient,
  GitlabApiError,
  assertSafeBaseUrl,
  fetchWithSafeRedirect,
  isLoopbackHost,
} from '@cindy/gitlab-client';

type RequestFn = (method: string, path: string, body?: unknown) => Promise<unknown>;
function rawRequest(c: GitlabClient): RequestFn {
  return (c as unknown as { request: RequestFn }).request.bind(c);
}

/** 显式给 fetch mock 签名,让 spy.mock.calls[i] 是 [url, init] 元组(strict tsc)。 */
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assertSafeBaseUrl (gitlab, allowInsecureHttp)', () => {
  it('accepts https and loopback http', () => {
    expect(() => assertSafeBaseUrl('https://gitlab.example.com')).not.toThrow();
    expect(() => assertSafeBaseUrl('http://localhost:8080', { allowInsecureHttp: true })).not.toThrow();
    expect(() => assertSafeBaseUrl('http://127.0.0.1', { allowInsecureHttp: true })).not.toThrow();
    // loopback 即便不显式 allowInsecureHttp 也放行
    expect(() => assertSafeBaseUrl('http://localhost')).not.toThrow();
  });

  it('accepts non-loopback http only when allowInsecureHttp', () => {
    expect(() => assertSafeBaseUrl('http://git.internal.example', { allowInsecureHttp: true })).not.toThrow();
    // 默认(不放行)时非 loopback http 拒绝
    expect(() => assertSafeBaseUrl('http://git.internal.example')).toThrow(/https/);
  });

  it('rejects userinfo (phishing host rewrite)', () => {
    expect(() => assertSafeBaseUrl('https://gitlab.example.com@evil.example')).toThrow(/userinfo/);
    expect(() => assertSafeBaseUrl('https://user:pw@gitlab.example.com')).toThrow(/userinfo/);
  });

  it('rejects non-http(s) protocols and unparseable input', () => {
    expect(() => assertSafeBaseUrl('ftp://gitlab.example.com')).toThrow(/http/);
    expect(() => assertSafeBaseUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => assertSafeBaseUrl('not a url')).toThrow(/invalid baseUrl/);
    expect(() => assertSafeBaseUrl('')).toThrow(/invalid baseUrl/);
  });

  it('GitlabClient constructor rejects an unsafe baseUrl', () => {
    expect(() => new GitlabClient({ baseUrl: 'https://a@evil.example', token: 't' })).toThrow(/userinfo/);
    // 自建 http 实例仍可构造(allowInsecureHttp: true)
    expect(() => new GitlabClient({ baseUrl: 'http://git.internal.example', token: 't' })).not.toThrow();
  });
});

describe('isLoopbackHost', () => {
  it('recognizes loopback hosts incl. bracketed ipv6', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('foo.localhost')).toBe(true);
    expect(isLoopbackHost('gitlab.example.com')).toBe(false);
  });
});

describe('fetchWithSafeRedirect', () => {
  it('returns non-3xx responses unchanged', async () => {
    const spy = vi.fn<FetchImpl>(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const res = await fetchWithSafeRedirect('https://gitlab.example.com/api/v4/user', {
      headers: { 'PRIVATE-TOKEN': 'SECRET' },
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // 强制 redirect:'manual' 传给底层 fetch
    expect((spy.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
  });

  it('follows same-origin redirects and keeps credentials', async () => {
    const spy = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://gitlab.example.com/api/v4/moved' },
        }),
      )
      .mockResolvedValueOnce(new Response('final', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const res = await fetchWithSafeRedirect('https://gitlab.example.com/api/v4/user', {
      headers: { 'PRIVATE-TOKEN': 'SECRET' },
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    // 两跳都发到同一 host,且都带凭据
    for (const call of spy.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('SECRET');
    }
    expect(spy.mock.calls[1][0]).toBe('https://gitlab.example.com/api/v4/moved');
  });

  it('refuses cross-host redirects and never replays the token', async () => {
    const spy = vi.fn<FetchImpl>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/steal' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    await expect(
      fetchWithSafeRedirect('https://gitlab.example.com/api/v4/user', {
        headers: { 'PRIVATE-TOKEN': 'SECRET' },
      }),
    ).rejects.toThrow(/cross-host/);
    // 关键断言:只打到原 host 一次,绝不对 evil.example 再发一次(token 不外泄)
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('https://gitlab.example.com/api/v4/user');
  });

  it('throws on too many redirects with last 3xx status', async () => {
    const spy = vi.fn<FetchImpl>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://gitlab.example.com/loop' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    const err = await fetchWithSafeRedirect(
      'https://gitlab.example.com/api/v4/user', { headers: {} }, 2,
    ).catch(e => e);
    expect(err).toBeInstanceOf(GitlabApiError);
    expect(err.message).toMatch(/too many redirects/);
    expect(err.status).toBe(302); // last 3xx status, not 0
    expect(spy).toHaveBeenCalledTimes(3); // hop 0,1,2 then bail
  });

  it('follows HTTP→HTTPS same-host upgrade redirect (common nginx self-hosted pattern)', async () => {
    const spy = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://git.internal.example/api/v4/user' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const res = await fetchWithSafeRedirect('http://git.internal.example/api/v4/user', {
      headers: { 'PRIVATE-TOKEN': 'SECRET' },
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    // token still sent on upgraded HTTPS request
    expect((spy.mock.calls[1][1] as RequestInit & { headers: Record<string, string> }).headers['PRIVATE-TOKEN']).toBe('SECRET');
  });

  it('returns a 3xx without Location unchanged', async () => {
    const spy = vi.fn<FetchImpl>(async () => new Response(null, { status: 302 }));
    vi.stubGlobal('fetch', spy);
    const res = await fetchWithSafeRedirect('https://gitlab.example.com/api/v4/user', { headers: {} });
    expect(res.status).toBe(302);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('GitlabClient.request() end-to-end redirect safety', () => {
  it('throws GitlabApiError on cross-host redirect, token not sent to evil host', async () => {
    const spy = vi.fn<FetchImpl>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/steal' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    const client = new GitlabClient({
      token: 'SECRET-TOKEN',
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'grp/proj',
    });
    await expect(rawRequest(client)('GET', '/user')).rejects.toBeInstanceOf(GitlabApiError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('https://gitlab.example.com/api/v4/user');
  });
});
