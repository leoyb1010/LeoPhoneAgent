import assert from 'node:assert/strict';
import test from 'node:test';

import { blockFor, providerMenuLines, quotaMenuSection, resetLabel, trayTitle } from './trayQuota.js';

test('tray title stays empty when nothing authoritative is readable', () => {
  // 菜单栏上恒为 0% 的假计量比没有更糟 —— 它看起来像"额度还很满"。
  assert.equal(trayTitle([]), '');
  assert.equal(trayTitle([{ authoritative: false, available: true, rolling: { tokens: 1 } }]), '');
  assert.equal(trayTitle([{ authoritative: true, available: false }]), '');
});

test('tray title shows one bar per authoritative provider and the worst percent', () => {
  const title = trayTitle([
    { authoritative: true, available: true, windows: [{ usedPercent: 73 }] },
    { authoritative: true, available: true, windows: [{ usedPercent: 12 }] },
  ]);
  assert.equal(title, `${blockFor(73)}${blockFor(12)} 73%`);
});

test('an un-onboarded provider is listed as 未接入 rather than hidden', () => {
  // 授权是陆续补的,菜单要能告诉你还差谁。
  const lines = providerMenuLines({ label: 'Cursor', available: false });
  assert.equal(lines.length, 1);
  assert.match(lines[0].label, /Cursor — 未接入/);
  assert.equal(lines[0].enabled, false);
});

test('local tallies are labelled so they are never read as official quota', () => {
  const lines = providerMenuLines({
    label: 'Claude Code',
    available: true,
    authoritative: false,
    rolling: { windowHours: 5, tokens: 42_000_000, requests: 108 },
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
  const at = (seconds) => Math.floor(now / 1000) + seconds;
  assert.equal(resetLabel(at(3 * 86400), now), '3 天后重置');
  assert.equal(resetLabel(at(5 * 3600), now), '5 小时后重置');
  assert.equal(resetLabel(at(120), now), '2 分钟后重置');
  assert.equal(resetLabel(at(-10), now), '已重置');
  assert.equal(resetLabel(null, now), '');
});
