/**
 * claude-credentials-blob 纯逻辑单测。
 *
 * 这些函数承载本次修复的确定性核心(规则 9 / 14):
 *   - decideKeychainWriteMode:大 blob 必须改走 argv,否则 `security -i` 静默截断损坏值。
 *   - planClaudeAiOAuthClear:登出删 claudeAiOauth 时**不得**连带抹掉 cc 的 mcpOAuth 等字段。
 *   - blobRoundtrips:写后校验能识破截断 / 缺失 / 内容不符。
 */

import { describe, expect, it } from 'vitest';

import {
  KEYCHAIN_INTERACTIVE_LINE_LIMIT,
  blobRoundtrips,
  decideKeychainWriteMode,
  planClaudeAiOAuthClear,
} from '../claude-credentials-blob.js';

describe('decideKeychainWriteMode', () => {
  it('小 blob(不超阈值)走 stdin —— hex 不进 argv', () => {
    expect(decideKeychainWriteMode(100)).toBe('stdin');
    expect(decideKeychainWriteMode(KEYCHAIN_INTERACTIVE_LINE_LIMIT)).toBe('stdin');
  });

  it('超阈值走 argv —— 规避 security -i 输入行截断', () => {
    expect(decideKeychainWriteMode(KEYCHAIN_INTERACTIVE_LINE_LIMIT + 1)).toBe('argv');
    expect(decideKeychainWriteMode(8000)).toBe('argv');
  });

  it('阈值保守落在 security -i ~4096B 上限内', () => {
    // 实测 ~4041B 仍 OK、~4141B 截断;阈值须明显小于硬上限,留足余量。
    expect(KEYCHAIN_INTERACTIVE_LINE_LIMIT).toBeLessThan(4096);
  });
});

describe('planClaudeAiOAuthClear', () => {
  it('无 blob → noop', () => {
    expect(planClaudeAiOAuthClear(null)).toEqual({ action: 'noop' });
  });

  it('只有 claudeAiOauth → 删整条条目', () => {
    expect(planClaudeAiOAuthClear({ claudeAiOauth: { accessToken: 'x' } })).toEqual({
      action: 'delete',
    });
  });

  it('还有 mcpOAuth 等其它字段 → 写回裁剪块,保留它们(关键不变量:不抹掉 cc 的 MCP 登录)', () => {
    const blob = {
      claudeAiOauth: { accessToken: 'x' },
      mcpOAuth: { 'plugin:design:asana|abc': { token: 't' } },
      otherCcField: 1,
    };
    const plan = planClaudeAiOAuthClear(blob);
    expect(plan.action).toBe('write');
    if (plan.action !== 'write') throw new Error('unreachable');
    expect(plan.next).toEqual({
      mcpOAuth: { 'plugin:design:asana|abc': { token: 't' } },
      otherCcField: 1,
    });
    expect(plan.next.claudeAiOauth).toBeUndefined();
  });

  it('不修改入参(浅拷贝)', () => {
    const blob = { claudeAiOauth: { accessToken: 'x' }, mcpOAuth: { a: 1 } };
    planClaudeAiOAuthClear(blob);
    expect(blob.claudeAiOauth).toBeDefined();
  });
});

describe('blobRoundtrips', () => {
  const blob = { mcpOAuth: { a: 1 }, k: 'v' };
  const expectedJson = JSON.stringify(blob);

  it('keychain compact 存法逐字节一致 → true', () => {
    expect(blobRoundtrips(expectedJson, JSON.stringify(blob))).toBe(true);
  });

  it('文件 pretty 存法(2 空格)解析后等价 → true', () => {
    expect(blobRoundtrips(expectedJson, JSON.stringify(blob, null, 2))).toBe(true);
  });

  it('截断的非法 JSON → false(本 bug 的损坏签名)', () => {
    const truncated = JSON.stringify(blob).slice(0, 5);
    expect(blobRoundtrips(expectedJson, truncated)).toBe(false);
  });

  it('缺失(null)→ false', () => {
    expect(blobRoundtrips(expectedJson, null)).toBe(false);
  });

  it('合法但内容不符 → false', () => {
    expect(blobRoundtrips(expectedJson, JSON.stringify({ k: 'other' }))).toBe(false);
  });
});
