/**
 * provider-upstream-error-observer 单测：
 *   - 成功响应 / 非 user 供应商流量 → null sink（成功路径零开销，规则 10）；
 *   - 4xx 错误体 tee → 分类 → 经注入 broadcaster 广播结构化事件；
 *   - 同 (providerId, code) 30s 节流；不同 code / 不同 provider 不互相压制；
 *   - gzip 错误体按 content-encoding 解压后再分类；
 *   - count_tokens 404 静默（上游未实现的良性缺失，如 Moonshot /anthropic），非 404 照常广播。
 */

import { gzipSync } from 'node:zlib';

import { describe, it, expect, afterEach } from 'vitest';

import type { ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

import {
  createProviderUpstreamErrorObserver,
  setProviderUpstreamErrorBroadcaster,
  type ProviderUpstreamErrorEvent,
} from '../provider-upstream-error-observer.js';

afterEach(() => {
  setProviderUpstreamErrorBroadcaster(() => {});
});

function ctx(over: Partial<ResponseObserverCtx> = {}): ResponseObserverCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://relay.example',
    status: 401,
    requestHeaders: { 'x-claude-code-session-id': 'sdk-1' },
    responseHeaders: {},
    requestBody: Buffer.alloc(0),
    ...over,
  };
}

/** 驱动一次完整观察：建 sink → 喂 body → end。返回 sink 是否存在。 */
function drive(observer: ReturnType<typeof createProviderUpstreamErrorObserver>, c: ResponseObserverCtx, body: Buffer): boolean {
  const sink = observer(c);
  if (!sink) return false;
  sink.onData?.(body);
  sink.onEnd?.();
  return true;
}

describe('createProviderUpstreamErrorObserver', () => {
  it('status < 400 → null sink（不 tee）', () => {
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
    });
    expect(observer(ctx({ status: 200 }))).toBeNull();
  });

  it('反解不到 user 供应商 → null sink（内置来源流量不广播）', () => {
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => null,
    });
    expect(observer(ctx({ status: 401 }))).toBeNull();
  });

  it('401 → 广播 AUTH_INVALID 结构化事件', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
      resolveUserProviderName: () => '测试网关',
    });
    drive(
      observer,
      ctx({ status: 401 }),
      Buffer.from('{"error":{"type":"authentication_error"},"Received API Key":"sk-live-123456789"}'),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'claude-code',
      providerId: 'my-relay',
      providerName: '测试网关',
      code: 'AUTH_INVALID',
      retryable: false,
      status: 401,
    });
    expect(events[0]?.detail).not.toContain('sk-live-123456789');
  });

  it('同 (providerId, code) 30s 内节流；不同 code / 不同 provider 不压制', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    let t = 1_000;
    const observer = createProviderUpstreamErrorObserver({
      agent: 'codex',
      resolveUserProviderId: (h) => h['x-provider'] ?? null,
      now: () => t,
    });
    const c = (provider: string, status: number) =>
      ctx({ status, requestHeaders: { 'x-provider': provider } });

    drive(observer, c('p1', 401), Buffer.from(''));
    t += 1_000;
    drive(observer, c('p1', 401), Buffer.from('')); // 节流
    t += 1_000;
    drive(observer, c('p1', 429), Buffer.from('')); // 不同 code → 放行
    drive(observer, c('p2', 401), Buffer.from('')); // 不同 provider → 放行
    t += 31_000;
    drive(observer, c('p1', 401), Buffer.from('')); // 窗口过 → 放行

    expect(events.map((e) => `${e.providerId}:${e.code}`)).toEqual([
      'p1:AUTH_INVALID',
      'p1:RATE_LIMITED',
      'p2:AUTH_INVALID',
      'p1:AUTH_INVALID',
    ]);
  });

  it('count_tokens 404 → null sink（上游未实现辅助端点，不弹「检查基础 URL」误报）', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'kimi-moonshot',
    });
    // Moonshot /anthropic 实测形态：CLI 带 ?beta=true 的 count_tokens 打到未实现端点回 404。
    expect(observer(ctx({ status: 404, url: '/v1/messages/count_tokens?beta=true' }))).toBeNull();
    expect(observer(ctx({ status: 404, url: '/v1/messages/count_tokens' }))).toBeNull();
    expect(events).toHaveLength(0);
    // 同路径非 404（如 401）仍是真信号 → 照常广播。
    drive(observer, ctx({ status: 401, url: '/v1/messages/count_tokens?beta=true' }), Buffer.from(''));
    expect(events.map((e) => e.code)).toEqual(['AUTH_INVALID']);
    // 主链路 /v1/messages 的 404 仍照常广播（真·端点配置问题不能被吞掉）。
    drive(observer, ctx({ status: 404, url: '/v1/messages?beta=true' }), Buffer.from('{"error":"url.not_found"}'));
    expect(events.map((e) => e.code)).toEqual(['AUTH_INVALID', 'ENDPOINT_NOT_FOUND']);
  });

  it('gzip 错误体按 content-encoding 解压后分类（400 模型不存在 → MODEL_NOT_FOUND）', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
    });
    const gz = gzipSync(Buffer.from('{"error":{"message":"model: glm-x not found"}}'));
    drive(observer, ctx({ status: 400, responseHeaders: { 'content-encoding': 'gzip' } }), gz);
    expect(events[0]?.code).toBe('MODEL_NOT_FOUND');
  });
});
