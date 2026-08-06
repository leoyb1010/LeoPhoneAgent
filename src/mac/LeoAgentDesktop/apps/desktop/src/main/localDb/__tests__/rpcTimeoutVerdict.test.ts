/**
 * rpcTimeoutVerdict.test.ts
 * ---------------------------------------------------------------------------
 * db worker RPC 超时判定的纯函数测试:预算语义是「清醒时间」,挂钟耗时远超
 * 预算(定时器横跨系统睡眠)时应重武装续等,而不是拒绝(2026-07-15 白屏根因)。
 */

import { describe, expect, it } from 'vitest';

import { evaluateRpcTimeout } from '../client/WorkerThreadTransport';

const BUDGET_MS = 30_000;

describe('evaluateRpcTimeout', () => {
  it('挂钟耗时 ≈ 预算(正常调度延迟内)→ 真超时,拒绝', () => {
    const verdict = evaluateRpcTimeout(0, BUDGET_MS + 200, BUDGET_MS);
    expect(verdict).toEqual({ kind: 'reject', wallElapsedMs: BUDGET_MS + 200 });
  });

  it('挂钟耗时略超预算但在睡眠判定余量内 → 仍视为真超时', () => {
    const verdict = evaluateRpcTimeout(0, BUDGET_MS + 4_999, BUDGET_MS);
    expect(verdict.kind).toBe('reject');
  });

  it('挂钟耗时远超预算(定时器跨睡眠)→ 重武装', () => {
    // 2026-07-15 实测值:30s 预算的请求挂钟走了 17 分钟
    const verdict = evaluateRpcTimeout(0, 1_035_825, BUDGET_MS);
    expect(verdict).toEqual({ kind: 'rearm', wallElapsedMs: 1_035_825 });
  });

  it('刚越过睡眠判定余量边界 → 重武装', () => {
    const verdict = evaluateRpcTimeout(0, BUDGET_MS + 5_001, BUDGET_MS);
    expect(verdict.kind).toBe('rearm');
  });
});
