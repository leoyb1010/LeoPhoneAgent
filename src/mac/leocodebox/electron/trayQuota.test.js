import assert from 'node:assert/strict';
import test from 'node:test';

import { blockFor, displayWindows, providerMenuLines, quotaMenuSection, resetLabel, trayTitle } from './trayQuota.js';

/** 契约见 server/modules/leocodebox/ai-quota.types.ts(ProviderSnapshot)。 */
const ok = (extra) => ({ status: 'ok', source: 'oauth', ...extra });

test('tray title stays empty when nothing authoritative is readable', () => {
  // 菜单栏上恒为 0% 的假计量比没有更糟 —— 它看起来像"额度还很满"。
  assert.equal(trayTitle([]), '');
  // 本机统计不是额度,不许上菜单栏计量。
  assert.equal(trayTitle([{ status: 'ok', source: 'local', primary: { usedPercent: 40 } }]), '');
  assert.equal(trayTitle([{ status: 'unconfigured', source: 'none' }]), '');
  assert.equal(trayTitle([{ status: 'error', source: 'none', error: 'boom' }]), '');
});

test('tray title shows one bar per authoritative provider and the worst percent', () => {
  const title = trayTitle([
    ok({ primary: { usedPercent: 73 } }),
    ok({ primary: { usedPercent: 12 } }),
  ]);
  assert.equal(title, `${blockFor(73)}${blockFor(12)} 73%`);
});

test('synthetic placeholder windows never reach the menu bar', () => {
  // Claude 的 five_hour 缺席时会补一个 0% 占位窗口。把它算进计量,
  // 菜单栏上就会出现一个凭空的 "0%",看起来像额度全新。
  const provider = ok({
    primary: { usedPercent: 0, windowMinutes: 300, resetsAt: null, isSyntheticPlaceholder: true },
    secondary: { usedPercent: 64, windowMinutes: 10080, resetsAt: Date.now() + 3600_000 },
  });
  assert.equal(displayWindows(provider).length, 1);
  assert.equal(trayTitle([provider]), `${blockFor(64)} 64%`);
});

test('an un-onboarded provider is listed with the reason rather than hidden', () => {
  // 授权是陆续补的,菜单要能告诉你还差谁、差什么。
  const lines = providerMenuLines({ label: 'Cursor', status: 'unconfigured', note: '缺浏览器会话 cookie' });
  assert.equal(lines.length, 1);
  assert.match(lines[0].label, /Cursor — 未接入/);
  assert.match(lines[0].label, /缺浏览器会话 cookie/);
  assert.equal(lines[0].enabled, false);
});

test('local tallies are labelled so they are never read as official quota', () => {
  const lines = providerMenuLines({
    label: 'Claude Code',
    status: 'ok',
    source: 'local',
    details: [{ title: '本机统计', rows: [{ label: '近 5 小时', value: '42000000 tokens', secondaryValue: '108 次请求' }] }],
  });
  assert.match(lines[0].label, /本机统计/);
  assert.match(lines[1].label, /近 5 小时/);
});

test('every tracked provider appears even when the snapshot is empty', () => {
  const items = quotaMenuSection(null);
  for (const name of ['Codex', 'Claude Code', 'Cursor', 'Grok', 'Gemini', 'OpenCode']) {
    assert.ok(items.some((item) => item.label?.startsWith(name)), `${name} missing from tray menu`);
  }
});

test('reset countdown degrades from days to minutes and reports a passed window', () => {
  const now = 1_800_000_000_000;
  // resetsAt 是 epoch 毫秒。
  const at = (seconds) => now + seconds * 1000;
  assert.equal(resetLabel(at(3 * 86400), now), '3 天后重置');
  assert.equal(resetLabel(at(5 * 3600), now), '5 小时后重置');
  assert.equal(resetLabel(at(120), now), '2 分钟后重置');
  assert.equal(resetLabel(at(-10), now), '已重置');
  assert.equal(resetLabel(null, now), '');
});
