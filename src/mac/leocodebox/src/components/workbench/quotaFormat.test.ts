import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_WARNING_THRESHOLDS,
  dedupeWorkdayMarkers,
  displayPercent,
  formatMetaText,
  formatPercentLabel,
  formatResetText,
  formatWindowLabel,
  headerSubtitle,
  percentValueLabel,
  quotaTone,
  quotaTrust,
  renderedFillPercent,
  roundedRiskPercent,
  visibleMetrics,
  warningMarkerPercents,
  workdayMarkerPercents,
} from './quotaFormat';
import type { ProviderSnapshot, RateWindow, Translate, UsagePace } from './quotaFormat';

/**
 * 用**真实的** zh-CN / en 文案跑,不用手写假串:这些函数的产物就是用户唯一
 * 看得到的东西,拿一份自造的翻译表去测等于在测自己。
 */
function loadTranslate(language: string): Translate {
  const url = new URL(`../../i18n/locales/${language}/common.json`, import.meta.url);
  const bundle = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Record<string, unknown>;
  return (key, options) => {
    const value = key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      bundle,
    );
    if (typeof value !== 'string') throw new Error(`missing i18n key: ${key} (${language})`);
    return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
  };
}

const zh = loadTranslate('zh-CN');
const en = loadTranslate('en');

const window5h = (over: Partial<RateWindow> = {}): RateWindow => ({
  usedPercent: 28,
  windowMinutes: 300,
  resetsAt: null,
  ...over,
});

/* ------------------------------------------------------- 百分比标签 --- */

test('percentLabel: 默认给剩余,已用模式给已用', () => {
  assert.equal(percentValueLabel(28, 'left'), '72%');
  assert.equal(percentValueLabel(28, 'used'), '28%');
  assert.equal(formatPercentLabel(28, 'left', en), '72% left');
  assert.equal(formatPercentLabel(28, 'used', en), '28% used');
  assert.equal(formatPercentLabel(28, 'left', zh), '剩余 72%');
  assert.equal(formatPercentLabel(28, 'used', zh), '已用 28%');
});

test('percentLabel: (0,1) 区间显示 <1%,恰好 0 仍是 0%', () => {
  // 0.4% 余量四舍五入成 0% 会让人以为已经用光。
  assert.equal(percentValueLabel(99.6, 'left'), '<1%');
  assert.equal(formatPercentLabel(99.6, 'left', en), '<1% left');
  assert.equal(formatPercentLabel(99.6, 'left', zh), '剩余 <1%');
  // 反过来,0 就是 0,不能写成 <1%。
  assert.equal(percentValueLabel(100, 'left'), '0%');
  assert.equal(percentValueLabel(0, 'used'), '0%');
  // 小额已用同理。
  assert.equal(percentValueLabel(0.4, 'used'), '<1%');
});

test('percentLabel: 用量可以 >100,标签必须夹住', () => {
  assert.equal(percentValueLabel(137, 'used'), '100%');
  assert.equal(percentValueLabel(137, 'left'), '0%');
  assert.equal(displayPercent(137, 'left'), 0);
  assert.equal(displayPercent(-5, 'used'), 0);
});

test('进度条填充跟标签对齐:显示 0% 画空,显示 100% 画满,其余按真值', () => {
  assert.equal(renderedFillPercent(0.4), 0);
  assert.equal(renderedFillPercent(99.7), 100);
  assert.equal(renderedFillPercent(72.4), 72.4);
  assert.equal(renderedFillPercent(137), 100);
});

/* ------------------------------------------------------- 重置文案 --- */

const NOON = Date.UTC(2026, 7, 18, 4, 0, 0);

test('resetText: 三种形态', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0).getTime();

  // ① 已到点
  assert.equal(formatResetText(now, now, zh), '已重置');
  assert.equal(formatResetText(now - 60_000, now, en), 'Resets now');

  // ② 今天之内 → 相对倒计时
  const later = new Date(2026, 7, 18, 14, 15, 0).getTime();
  assert.equal(formatResetText(later, now, en), 'Resets in 2h 15m');
  assert.equal(formatResetText(later, now, zh), '2 小时 15 分后重置');

  // ③ 明天 → 绝对时刻
  const tomorrow = new Date(2026, 7, 19, 14, 30, 0).getTime();
  assert.equal(formatResetText(tomorrow, now, en), 'Resets tomorrow, 14:30');
  assert.equal(formatResetText(tomorrow, now, zh), '明天 14:30 重置');
});

test('resetText: 没有 resetsAt 时退回后端的说明文字', () => {
  assert.equal(formatResetText(null, NOON, zh), '');
  assert.equal(formatResetText(null, NOON, zh, { description: '  每月 1 日  ' }), '每月 1 日');
});

test('resetText: 更远的时间带星期', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0).getTime();
  const friday = new Date(2026, 7, 21, 9, 5, 0).getTime();
  const text = formatResetText(friday, now, en, { locale: 'en' });
  assert.match(text, /^Resets Fri, 09:05$/);
});

test('duration: 分钟向上取整、最多两级单位', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0).getTime();
  // 30 秒也算 1 分钟,不能显示 0 分。
  assert.equal(formatResetText(now + 30_000, now, en), 'Resets in 1m');
  assert.equal(formatResetText(now + 3_600_000, now, en), 'Resets in 1h');
});

/* --------------------------------------------------------- 配速 meta --- */

const pace = (over: Partial<UsagePace> = {}): UsagePace => ({
  stage: 'onTrack',
  deltaPercent: 0,
  expectedUsedPercent: 30,
  etaSeconds: null,
  willLastToReset: true,
  speedMultiplier: null,
  riskPercent: null,
  ...over,
});

test('metaText: 按计划 + 撑到重置', () => {
  assert.equal(formatMetaText(pace(), en), 'On pace · Lasts until reset');
  assert.equal(formatMetaText(pace(), zh), '按计划 · 可用到重置');
});

test('metaText: 透支 + 耗尽预计 + 风险', () => {
  const text = formatMetaText(
    pace({ stage: 'ahead', deltaPercent: 11, willLastToReset: false, etaSeconds: 3600 * 3 + 60 * 20, riskPercent: 25 }),
    en,
  );
  assert.equal(text, '11% in deficit · Runs out in 3h 20m (25% risk)');
  assert.equal(
    formatMetaText(
      pace({ stage: 'ahead', deltaPercent: 11, willLastToReset: false, etaSeconds: 3600 * 3 + 60 * 20, riskPercent: 25 }),
      zh,
    ),
    '超支 11% · 3 小时 20 分后耗尽 (25% 风险)',
  );
});

test('metaText: 结余 + 撑到重置', () => {
  assert.equal(
    formatMetaText(pace({ stage: 'behind', deltaPercent: -8 }), en),
    '8% in reserve · Lasts until reset',
  );
});

test('metaText: 余量提示只在 delta < -15 且倍率 ≥1.5 时出现', () => {
  const base = { stage: 'farBehind' as const, willLastToReset: true };
  assert.equal(
    formatMetaText(pace({ ...base, deltaPercent: -20, speedMultiplier: 1.5 }), en),
    '20% in reserve · Lasts until reset · 1.5× headroom',
  );
  // 倍率不够 → 不提。
  assert.equal(
    formatMetaText(pace({ ...base, deltaPercent: -20, speedMultiplier: 1.2 }), en),
    '20% in reserve · Lasts until reset',
  );
  // 偏差不够 → 不提。
  assert.equal(
    formatMetaText(pace({ stage: 'behind', deltaPercent: -10, speedMultiplier: 3 }), en),
    '10% in reserve · Lasts until reset',
  );
});

test('metaText: 偏差四舍五入到 0 时说"按计划",不说"超支 0%"', () => {
  assert.equal(formatMetaText(pace({ stage: 'slightlyAhead', deltaPercent: 0.3 }), en), 'On pace · Lasts until reset');
});

test('metaText: 没有 pace 就整行不出现', () => {
  assert.equal(formatMetaText(null, en), '');
  assert.equal(formatMetaText(undefined, zh), '');
});

test('风险百分比吸附到最近的 5,不给假精度', () => {
  assert.equal(roundedRiskPercent(23), 25);
  assert.equal(roundedRiskPercent(37), 35);
  assert.equal(roundedRiskPercent(-4), 0);
  assert.equal(roundedRiskPercent(180), 100);
});

/* --------------------------------------------------------- 状态色 --- */

test('状态色三档:剩余 ≤10% 红、≤50% 橙、其余品牌色', () => {
  assert.equal(quotaTone(0), 'normal');
  assert.equal(quotaTone(49.9), 'normal');
  // 剩余正好 50% → 橙(边界含等号)
  assert.equal(quotaTone(50), 'warning');
  assert.equal(quotaTone(89.9), 'warning');
  // 剩余正好 10% → 红
  assert.equal(quotaTone(90), 'critical');
  assert.equal(quotaTone(100), 'critical');
  // 超额同样是红,不能因为 >100 掉档
  assert.equal(quotaTone(137), 'critical');
});

/* ----------------------------------------------------------- 刻痕 --- */

test('阈值刻痕默认打在剩余 50% / 20%,显示"已用"时翻面', () => {
  assert.deepEqual(DEFAULT_WARNING_THRESHOLDS, [50, 20]);
  assert.deepEqual(warningMarkerPercents(undefined, 'left'), [50, 20]);
  assert.deepEqual(warningMarkerPercents(undefined, 'used'), [50, 80]);
  // 0 / 100 两端不画。
  assert.deepEqual(warningMarkerPercents([0, 100, 30], 'left'), [30]);
});

test('工作日刻度只在 7 天窗口出现,并让开阈值刻痕', () => {
  assert.deepEqual(workdayMarkerPercents(300), []);
  assert.deepEqual(workdayMarkerPercents(null), []);
  const week = workdayMarkerPercents(10_080);
  assert.equal(week.length, 6);
  assert.ok(Math.abs(week[0] - 100 / 7) < 1e-9);
  // 撞在阈值上的刻度要丢掉(5 天窗口下 40% / 20% 会撞 20%)。
  assert.deepEqual(dedupeWorkdayMarkers([20, 40, 60, 80], [50, 20]), [40, 60, 80]);
});

/* ------------------------------------------------------- metric 组装 --- */

const snapshot = (over: Partial<ProviderSnapshot> = {}): ProviderSnapshot => ({
  id: 'codex',
  label: 'Codex',
  accentColor: '#10a37f',
  status: 'ok',
  source: 'oauth',
  updatedAt: NOON,
  ...over,
});

const TITLES = { primary: '主', secondary: '次', tertiary: '三' };

test('metric 顺序固定 primary → secondary → tertiary → extra', () => {
  const metrics = visibleMetrics(
    snapshot({
      primary: window5h(),
      secondary: window5h({ windowMinutes: 10_080 }),
      tertiary: window5h({ windowMinutes: 43_200 }),
      extraRateWindows: [
        { id: 'code', title: 'Code', window: window5h(), usageKnown: true },
        { id: 'agent', title: 'Agent', window: window5h(), usageKnown: true },
      ],
    }),
    TITLES,
  );
  assert.deepEqual(metrics.map((m) => m.key), ['primary', 'secondary', 'tertiary', 'extra:code', 'extra:agent']);
  assert.deepEqual(metrics.map((m) => m.title), ['主', '次', '三', 'Code', 'Agent']);
});

test('synthetic 占位窗口整条跳过 —— 那是结构补位,不是真额度', () => {
  const metrics = visibleMetrics(
    snapshot({
      primary: window5h({ isSyntheticPlaceholder: true }),
      secondary: window5h({ usedPercent: 40 }),
      extraRateWindows: [
        { id: 'ghost', title: 'Ghost', window: window5h({ isSyntheticPlaceholder: true }), usageKnown: false },
        { id: 'real', title: 'Real', window: window5h(), usageKnown: true },
      ],
    }),
    TITLES,
  );
  assert.deepEqual(metrics.map((m) => m.key), ['secondary', 'extra:real']);
});

test('缺席的窗口不占位', () => {
  assert.deepEqual(visibleMetrics(snapshot({}), TITLES), []);
  assert.deepEqual(visibleMetrics(snapshot({ primary: null, tertiary: undefined }), TITLES), []);
});

/* --------------------------------------------------------- 其他 --- */

test('source 决定可信度标注:本机估算不能冒充官方额度', () => {
  assert.equal(quotaTrust('oauth'), 'authoritative');
  assert.equal(quotaTrust('api'), 'authoritative');
  assert.equal(quotaTrust('local'), 'local');
  assert.equal(quotaTrust('cli'), 'local');
  assert.equal(quotaTrust('none'), 'unknown');
  assert.equal(quotaTrust(undefined), 'unknown');
});

test('header 副标题三态', () => {
  const now = NOON;
  assert.deepEqual(
    headerSubtitle({ status: 'error', error: 'HTTP 401', updatedAt: now }, now, en),
    { kind: 'error', text: 'HTTP 401' },
  );
  assert.deepEqual(
    headerSubtitle({ status: 'loading', error: null, updatedAt: null }, now, en),
    { kind: 'loading', text: 'Refreshing…' },
  );
  assert.deepEqual(
    headerSubtitle({ status: 'ok', error: null, updatedAt: null }, now, en),
    { kind: 'info', text: 'Not fetched yet' },
  );
  assert.deepEqual(
    headerSubtitle({ status: 'ok', error: null, updatedAt: now - 5_000 }, now, en),
    { kind: 'info', text: 'Updated just now' },
  );
  assert.deepEqual(
    headerSubtitle({ status: 'ok', error: null, updatedAt: now - 180_000 }, now, en),
    { kind: 'info', text: 'Updated 3m ago' },
  );
});

test('窗口说明按窗口长度给', () => {
  assert.equal(formatWindowLabel(300, en), '5h window');
  assert.equal(formatWindowLabel(10_080, zh), '7 天窗口');
  assert.equal(formatWindowLabel(null, zh), '');
  assert.equal(formatWindowLabel(0, zh), '');
});

test('十种语言都补齐了额度面板的 key', () => {
  const keys = [
    'quotaPercentLeft', 'quotaPercentUsed', 'quotaResetNow', 'quotaResetIn', 'quotaResetTomorrow',
    'quotaResetOn', 'quotaDurDay', 'quotaDurHour', 'quotaDurMinute', 'quotaWindowLabel',
    'quotaPaceOnTrack', 'quotaPaceDeficit', 'quotaPaceReserve', 'quotaPaceLasts', 'quotaPaceRunsOut',
    'quotaPaceRisk', 'quotaPaceHeadroom', 'quotaRefreshing', 'quotaUpdatedJustNow', 'quotaUpdatedAgo',
    'quotaNotFetched', 'quotaCopyError', 'quotaCopied', 'quotaCreditsTitle', 'quotaCreditsLeft',
    'quotaCreditsTotal', 'quotaCostTitle', 'quotaCostToday', 'quotaCostLast30', 'quotaNoUsageYet',
    'quotaLimitsUnavailable', 'quotaNoUsageConfigured', 'quotaTrustAuthoritative', 'quotaUnconfiguredHint',
    'quotaWindowPrimary', 'quotaWindowSecondary', 'quotaWindowTertiary',
  ];
  for (const language of ['en', 'fr', 'ko', 'zh-CN', 'zh-TW', 'ja', 'de', 'it', 'ru', 'tr']) {
    const t = loadTranslate(language);
    for (const key of keys) assert.ok(t(`workbench.${key}`).length > 0, `${language}/${key} 为空`);
  }
});
