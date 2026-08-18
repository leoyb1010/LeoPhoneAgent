import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autoCredentialOrigin,
  credentialLabel,
  formatTimestamp,
  isCredentialProvider,
  providerTone,
  sortProviders,
  statusLabel,
  type QuotaCredentialStatus,
} from './quotaCredentialFormat';

/**
 * [T-quota-credentials] 这一页唯一的内容就是状态判断和文案,所以钉死的也是这两件事。
 * 最要紧的一条:**本机估算不许被说成"官方额度"** —— 那是这个面板最危险的谎。
 */

/** 假 t:把 key 和插值原样吐出来,断言看得见到底取了哪个 key。 */
const t = (key: string, options?: Record<string, unknown>): string => {
  const args = options ? Object.entries(options).map(([k, v]) => `${k}=${String(v)}`).join(',') : '';
  return args ? `${key}(${args})` : key;
};

const snap = (status: string, source: string) =>
  ({ status, source } as Parameters<typeof providerTone>[0]);

/* ------------------------------------------------------------- 状态分档 */

test('tone separates authoritative quota from local estimates', () => {
  assert.equal(providerTone(snap('ok', 'oauth')), 'ok');
  assert.equal(providerTone(snap('ok', 'api')), 'ok');
  assert.equal(providerTone(snap('ok', 'web')), 'ok');
  assert.equal(providerTone(snap('ok', 'cli')), 'ok');
  // 本机日志累加的估算,绝不能和官方额度同档。
  assert.equal(providerTone(snap('ok', 'local')), 'local');
  assert.equal(providerTone(snap('error', 'none')), 'error');
  assert.equal(providerTone(snap('unconfigured', 'none')), 'idle');
  assert.equal(providerTone(snap('loading', 'none')), 'idle');
});

test('status label always states where the number came from', () => {
  assert.equal(statusLabel(snap('ok', 'oauth'), t), 'quota.status.connected · quota.source.oauth');
  assert.equal(
    statusLabel(snap('ok', 'local'), t),
    'quota.status.connected · quota.source.local',
    '本机估算也要接上来路,否则用户会当成官方额度',
  );
  assert.equal(statusLabel(snap('unconfigured', 'none'), t), 'quota.status.notConnected');
  assert.equal(statusLabel(snap('error', 'none'), t), 'quota.status.error');
});

/* --------------------------------------------------------------- 凭据行 */

test('credential label reveals at most the last 4 chars', () => {
  const configured: QuotaCredentialStatus = { provider: 'grok', configured: true, last4: '1234', updatedAt: null };
  assert.equal(credentialLabel(configured, t), 'quota.credential.configuredWithTail(last4=1234)');

  const shortKey: QuotaCredentialStatus = { provider: 'grok', configured: true, last4: null, updatedAt: null };
  assert.equal(credentialLabel(shortKey, t), 'quota.credential.configured', '没有尾号就只说"配了"');

  const none: QuotaCredentialStatus = { provider: 'grok', configured: false, last4: null, updatedAt: null };
  assert.equal(credentialLabel(none, t), 'quota.credential.notConfigured');
  assert.equal(credentialLabel(undefined, t), 'quota.credential.notConfigured');
});

/* --------------------------------------------------------------- 时间戳 */

test('unparseable timestamps become null instead of a fake "just now"', () => {
  assert.equal(formatTimestamp(null), null);
  assert.equal(formatTimestamp(undefined), null);
  assert.equal(formatTimestamp(''), null);
  assert.equal(formatTimestamp('not a date'), null);
  assert.equal(formatTimestamp(Number.NaN), null);
  assert.ok(formatTimestamp('2026-08-18T10:00:00.000Z', 'en-US'));
  assert.ok(formatTimestamp(1_800_000_000_000, 'en-US'));
});

/* ----------------------------------------------------------- 其余小函数 */

test('auto credential origin is taken from the server detail rows', () => {
  assert.equal(autoCredentialOrigin({
    details: [{ title: '账户', rows: [{ label: '账号', value: 'a@b.c' }, { label: '凭据来源', value: '钥匙串' }] }],
  }), '钥匙串');
  assert.equal(autoCredentialOrigin(undefined), null);
  assert.equal(autoCredentialOrigin({ details: [] }), null);
  assert.equal(autoCredentialOrigin({}), null, 'details 缺席也不能炸');
});

test('providers sort into a stable reading order and unknown ones survive at the end', () => {
  const sorted = sortProviders([
    { id: 'opencode' }, { id: 'mystery' }, { id: 'claude' }, { id: 'grok' }, { id: 'codex' },
  ]);
  assert.deepEqual(sorted.map((p) => p.id), ['codex', 'claude', 'grok', 'opencode', 'mystery']);
});

test('only the four hand-entered providers count as credential providers', () => {
  for (const id of ['gemini', 'cursor', 'grok', 'opencode']) assert.ok(isCredentialProvider(id), id);
  for (const id of ['codex', 'claude', 'nope']) assert.ok(!isCredentialProvider(id), id);
});
