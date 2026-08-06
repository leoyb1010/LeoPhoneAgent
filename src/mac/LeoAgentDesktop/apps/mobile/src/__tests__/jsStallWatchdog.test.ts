import { describe, expect, it, vi } from 'vitest';

// jsStallWatchdog 顶层 import { AppState } from 'react-native':vitest node 环境
// 解析不了 RN 入口(flow 语法),按仓内惯例 mock 掉(本文件只测纯判定函数)。
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
}));

import {
  classifyJsStallGap,
  evaluateJsStallTick,
  JS_STALL_REPORT_THRESHOLD_MS,
  JS_STALL_SUSPEND_SUSPECT_MS,
  JS_STALL_TICK_MS,
} from '@/debug/jsStallWatchdog';

describe('evaluateJsStallTick', () => {
  it('正常心跳间隙(≈周期)不上报', () => {
    expect(evaluateJsStallTick(0, JS_STALL_TICK_MS)).toBeNull();
    expect(evaluateJsStallTick(0, JS_STALL_TICK_MS + 500)).toBeNull();
  });

  it('间隙超出周期达到阈值才上报,返回停摆时长', () => {
    const threshold = JS_STALL_TICK_MS + JS_STALL_REPORT_THRESHOLD_MS;
    expect(evaluateJsStallTick(0, threshold - 1)).toBeNull();
    expect(evaluateJsStallTick(0, threshold)).toBe(JS_STALL_REPORT_THRESHOLD_MS);
    // 长间隙同样如实返回时长(归类交给 classifyJsStallGap)
    expect(evaluateJsStallTick(0, JS_STALL_TICK_MS + 300_000)).toBe(300_000);
  });

  it('classifyJsStallGap:风暴量级归 stall,睡眠量级归 suspend-suspect', () => {
    expect(classifyJsStallGap(JS_STALL_REPORT_THRESHOLD_MS)).toBe('stall');
    expect(classifyJsStallGap(90_000)).toBe('stall'); // 实测最长真风暴 ~90s
    expect(classifyJsStallGap(JS_STALL_SUSPEND_SUSPECT_MS)).toBe('suspend-suspect');
    expect(classifyJsStallGap(1_000_000)).toBe('suspend-suspect'); // 整机睡眠假象实测量级
  });
});
