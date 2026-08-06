/**
 * github-client listPullRequestReviewThreads —— 回归测试(PR #558 follow-up)。
 *
 * github-client 包本身无测试基建(零依赖、只有 build 脚本),故在 @cindy/mcps(已有
 * vitest 且依赖该 client)里通过 stub 全局 fetch 覆盖这个 GraphQL 方法的几处易错逻辑:
 *  - null-guard:不存在的 PR(pullRequest: null)抛 GithubApiError(status=404),
 *    让上层 toolCatch 归类成 NOT_FOUND(本次 follow-up 一并修的映射)。
 *  - pageInfo 透传(分页 hasNextPage / endCursor 原样带回)。
 *  - commentsTruncated(totalCount > 已取回条数时置 true)。
 *  - comment.id 取自可为 null 的 databaseId。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubClient, GithubApiError } from '@cindy/github-client';

function graphqlResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function client() {
  return new GithubClient({ token: 't', owner: 'makecindy', repo: 'cindy' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listPullRequestReviewThreads', () => {
  it('throws GithubApiError(404) when the PR does not exist (pullRequest: null)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse({ data: { repository: { pullRequest: null } } })));
    const err = await client()
      .listPullRequestReviewThreads(999999)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).status).toBe(404);
  });

  it('passes pageInfo (hasNextPage / endCursor) through verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        graphqlResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: 'CURSOR_XYZ' },
                  nodes: [],
                },
              },
            },
          },
        }),
      ),
    );
    const res = await client().listPullRequestReviewThreads(1, { first: 10, after: 'PREV' });
    expect(res.pageInfo).toEqual({ hasNextPage: true, endCursor: 'CURSOR_XYZ' });
    expect(res.threads).toEqual([]);
  });

  it('sets commentsTruncated when totalCount exceeds the returned comment count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        graphqlResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'PRRT_full',
                      isResolved: false,
                      isOutdated: false,
                      path: 'a.ts',
                      line: 1,
                      comments: {
                        totalCount: 1,
                        nodes: [{ databaseId: 111, body: 'x', createdAt: '2026-01-01', author: { login: 'a' } }],
                      },
                    },
                    {
                      id: 'PRRT_truncated',
                      isResolved: false,
                      isOutdated: false,
                      path: 'b.ts',
                      line: 2,
                      comments: {
                        totalCount: 80, // > 已取回的 1 条 → 截断
                        nodes: [{ databaseId: null, body: 'y', createdAt: '2026-01-02', author: null }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );
    const res = await client().listPullRequestReviewThreads(1);
    expect(res.threads[0].commentsTruncated).toBe(false);
    expect(res.threads[1].commentsTruncated).toBe(true);
    // databaseId 为 null 时 comment.id 应原样为 null,不崩。
    expect(res.threads[1].comments[0].id).toBeNull();
    expect(res.threads[1].comments[0].author).toBeNull();
  });

  it('fails fast when owner/repo are not configured (no GraphQL call)', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const bare = new GithubClient({ token: 't' });
    await expect(bare.listPullRequestReviewThreads(1)).rejects.toThrow(/owner and repo are required/);
    expect(spy).not.toHaveBeenCalled();
  });
});
