/**
 * gitlab-client —— 易错纯逻辑回归测试(PR #461 follow-up)。
 *
 * gitlab-client 包本身无测试基建,故在 @cindy/mcps(已有 vitest 且依赖该 client)里覆盖:
 *  1. request() 的空 body 短路四分支(304 / 204 / Content-Length:0 / 空文本)——
 *     必须返 undefined,绝不能让 res.json() 对空 body 抛 SyntaxError 误报 API 失败;
 *     非空 body 仍正常 JSON.parse。
 *  2. getRepositoryArchiveUrl:返回的 url 不含 token / private_token,header 是
 *     掩码占位符而非真实 token(防 token 流入 log / 下游)。
 *
 * (原第 3 组 stripVariableValues 用例已随 lizi_gitlab MCP 壳于 2026-07-14 退役
 * 删除——该函数属 MCP tools 层而非共享 client,GitLab 能力迁入内置意识
 * cindy-gitlab 后,CI/CD 变量脱敏在意识包内实现。)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitlabClient } from '@cindy/gitlab-client';

/** 用 as any 拿到私有 request(),直接断言四条空 body 分支的返回值。 */
type RequestFn = (method: string, path: string, body?: unknown) => Promise<unknown>;
function rawRequest(c: GitlabClient): RequestFn {
  return (c as unknown as { request: RequestFn }).request.bind(c);
}

function client() {
  return new GitlabClient({ token: 'SECRET-TOKEN', baseUrl: 'https://gitlab.example.com', projectPath: 'grp/proj' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request() empty-body short-circuit', () => {
  const emptyCases: Array<{ name: string; res: () => Response }> = [
    { name: '304 Not Modified', res: () => new Response(null, { status: 304 }) },
    { name: '204 No Content', res: () => new Response(null, { status: 204 }) },
    {
      name: 'Content-Length: 0',
      res: () => new Response('', { status: 200, headers: { 'content-length': '0' } }),
    },
    { name: 'empty text body', res: () => new Response('', { status: 200 }) },
  ];

  for (const { name, res } of emptyCases) {
    it(`returns undefined for ${name} (never JSON.parses an empty body)`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => res()));
      await expect(rawRequest(client())('GET', '/x')).resolves.toBeUndefined();
    });
  }

  it('parses a non-empty JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 7 }), { status: 200 })),
    );
    await expect(rawRequest(client())('GET', '/x')).resolves.toEqual({ id: 7 });
  });
});

describe('getRepositoryArchiveUrl', () => {
  it('builds a URL that never embeds the token, and masks the header', () => {
    const desc = client().getRepositoryArchiveUrl({ sha: 'abc123', format: 'tar.gz' });
    expect(desc.url).toContain('/api/v4/projects/grp%2Fproj/repository/archive.tar.gz');
    expect(desc.url).not.toContain('SECRET-TOKEN');
    expect(desc.url.toLowerCase()).not.toContain('private_token');
    expect(desc.url.toLowerCase()).not.toContain('token=');
    expect(desc.header['PRIVATE-TOKEN']).toBe('***');
    expect(desc.header['PRIVATE-TOKEN']).not.toBe('SECRET-TOKEN');
  });
});
