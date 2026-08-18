/**
 * [T-quota-card] 额度卡片的纯格式化层。
 *
 * 排版与文案规格 1:1 复刻上游 CodexBar(MIT,见 NOTICE)的下拉菜单:百分比
 * 标签、重置文案、配速 meta 串、刻痕位置、synthetic 占位窗口的跳过规则,全部
 * 收在这里,好让它们能脱离 React 被单测钉住 —— 这些字符串是面板唯一的"内容",
 * 写错一个字比画歪一根进度条严重得多。
 *
 * 一个关键的坐标系约定,跟上游一致:进度条画的是**标签上那个数**。默认标签是
 * "剩余 72%",条就填 72%,随着额度消耗往回退;切到 "已用" 模式才反过来。配速
 * 标记和阈值刻痕都落在同一根轴上。
 *
 * 所有文案走 i18n:函数收一个 i18next 风格的 `t`,自己不硬编码任何语言。
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export type RateWindow = {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
  resetDescription?: string | null;
  isSyntheticPlaceholder?: boolean;
};

export type NamedRateWindow = {
  id: string;
  title: string;
  window: RateWindow;
  usageKnown: boolean;
};

export type PaceStage =
  | 'onTrack'
  | 'slightlyAhead'
  | 'ahead'
  | 'farAhead'
  | 'slightlyBehind'
  | 'behind'
  | 'farBehind';

export type UsagePace = {
  stage: PaceStage;
  deltaPercent: number;
  expectedUsedPercent: number;
  etaSeconds: number | null;
  willLastToReset: boolean;
  speedMultiplier: number | null;
  riskPercent: number | null;
};

export type ProviderStatus = 'ok' | 'error' | 'loading' | 'unconfigured';
export type ProviderSource = 'oauth' | 'api' | 'web' | 'cli' | 'local' | 'none';

export type ProviderSnapshot = {
  id: string;
  label: string;
  accentColor: string;
  status: ProviderStatus;
  source: ProviderSource;
  identity?: { accountEmail?: string | null; plan?: string | null; organization?: string | null } | null;
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
  tertiary?: RateWindow | null;
  extraRateWindows?: NamedRateWindow[];
  credits?: { remaining?: number | null; total?: number | null; unit?: string | null; hint?: string | null } | null;
  cost?: {
    todayUSD?: number | null;
    last30DaysUSD?: number | null;
    todayTokens?: number | null;
    last30DaysTokens?: number | null;
  } | null;
  details?: { title: string; rows: { label: string; value: string; secondaryValue?: string | null }[] }[];
  updatedAt: number | null;
  error?: string | null;
  note?: string | null;
};

export type PercentMode = 'left' | 'used';

function toFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, toFinite(value)));
}

/** 把"已用百分比"换算到显示轴。默认显示剩余,所以要翻个面。 */
export function displayPercent(usedPercent: number, mode: PercentMode = 'left'): number {
  return clampPercent(mode === 'left' ? 100 - toFinite(usedPercent) : usedPercent);
}

/* --------------------------------------------------------------- 状态色 --- */

/**
 * 状态色只有三档 —— 剩余 ≤10% 红、≤50% 橙、否则 provider 品牌色。
 *
 * 注:上游的条永远是品牌色,严重度只体现在配速条纹上。这一档是本项目要求的
 * 附加规则(见任务规格),保留。
 */
export type QuotaTone = 'critical' | 'warning' | 'normal';

const CRITICAL_REMAINING = 10;
const WARNING_REMAINING = 50;

export function quotaTone(usedPercent: number): QuotaTone {
  const remaining = 100 - toFinite(usedPercent);
  if (remaining <= CRITICAL_REMAINING) return 'critical';
  if (remaining <= WARNING_REMAINING) return 'warning';
  return 'normal';
}

/* ------------------------------------------------------------- 百分比 --- */

/**
 * 百分比数值(不含"剩余/已用"前缀)。上游的对齐规则:严格落在 (0,1) 之间
 * 显示 `<1%`,恰好 0 显示 `0%` —— 把 0.4% 四舍五入成 0% 会让人以为已经用光,
 * 而把 0% 写成 `<1%` 又会让人以为还剩一点。
 */
export function percentValueLabel(usedPercent: number, mode: PercentMode = 'left'): string {
  const value = displayPercent(usedPercent, mode);
  if (value <= 0) return '0%';
  if (value < 1) return '<1%';
  return `${Math.round(value)}%`;
}

/** `"剩余 72%"` / `"已用 28%"` / `"剩余 <1%"`。 */
export function formatPercentLabel(usedPercent: number, mode: PercentMode, t: Translate): string {
  const value = percentValueLabel(usedPercent, mode);
  return t(mode === 'left' ? 'workbench.quotaPercentLeft' : 'workbench.quotaPercentUsed', { value });
}

/**
 * 进度条实际画到哪。跟标签对齐:标签写 0% 就画空、写 100% 就画满,其余按真值
 * 画 —— 否则用户会看到"100% 但还差一丝"这种自相矛盾的画面。
 */
export function renderedFillPercent(value: number): number {
  const clamped = clampPercent(value);
  const shown = Math.round(clamped);
  if (shown <= 0) return 0;
  if (shown >= 100) return 100;
  return clamped;
}

/* --------------------------------------------------------------- 刻痕 --- */

/** 上游默认的额度告警阈值(按剩余百分比)。 */
export const DEFAULT_WARNING_THRESHOLDS = [50, 20];
export const WEEK_WINDOW_MINUTES = 10_080;

export function isWeekWindow(windowMinutes: number | null | undefined): boolean {
  return windowMinutes === WEEK_WINDOW_MINUTES;
}

/** 阈值刻痕落在显示轴上:显示"已用"时要翻面。0 / 100 两端不画。 */
export function warningMarkerPercents(
  thresholds: number[] = DEFAULT_WARNING_THRESHOLDS,
  mode: PercentMode = 'left',
): number[] {
  return thresholds
    .map((threshold) => (mode === 'used' ? 100 - threshold : threshold))
    .filter((percent) => percent > 0 && percent < 100);
}

/** 工作日刻度只在 7 天窗口上有意义 —— 5 小时窗口画日界线是纯装饰。 */
export function workdayMarkerPercents(windowMinutes: number | null | undefined, days = 7): number[] {
  if (!isWeekWindow(windowMinutes) || days < 2 || days > 7) return [];
  return Array.from({ length: days - 1 }, (_, index) => ((index + 1) * 100) / days);
}

const MARKER_EPSILON = 0.001;

/** 去重:撞在阈值刻痕上的工作日刻度直接丢掉,阈值优先。 */
export function dedupeWorkdayMarkers(workdays: number[], warnings: number[]): number[] {
  return workdays.filter((day) => !warnings.some((warning) => Math.abs(warning - day) <= MARKER_EPSILON));
}

/* ----------------------------------------------------------- 时间文案 --- */

/**
 * `"2 小时 15 分"`。分钟向上取整、最多两级单位 —— 完全照上游
 * `resetCountdownDescription` 的分档,再细在菜单里就是噪音。
 */
export function formatDuration(seconds: number, t: Translate): string {
  const totalMinutes = Math.max(1, Math.ceil(Math.max(0, toFinite(seconds)) / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const day = (value: number) => t('workbench.quotaDurDay', { value });
  const hour = (value: number) => t('workbench.quotaDurHour', { value });
  const minute = (value: number) => t('workbench.quotaDurMinute', { value });

  if (days > 0) {
    if (hours > 0) return `${day(days)} ${hour(hours)}`;
    if (minutes > 0) return `${day(days)} ${minute(minutes)}`;
    return day(days);
  }
  if (hours > 0) {
    if (minutes > 0) return `${hour(hours)} ${minute(minutes)}`;
    return hour(hours);
  }
  return minute(totalMinutes);
}

export type ResetTextOptions = { locale?: string; description?: string | null };

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clockTime(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  } catch {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
}

function weekdayName(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
  } catch {
    return '';
  }
}

/**
 * 三种形态,和上游一致:
 *   已到点       → `"已重置"`
 *   今天之内     → `"2 小时 15 分后重置"`
 *   明天 / 更远  → `"明天 14:30 重置"` / `"周五 14:30 重置"`
 * 没有 resetsAt 时退回后端给的 resetDescription(可能是"每月 1 日"这类)。
 */
export function formatResetText(
  resetsAt: number | null | undefined,
  now: number,
  t: Translate,
  options: ResetTextOptions = {},
): string {
  const locale = options.locale || 'zh-CN';
  if (resetsAt == null || !Number.isFinite(resetsAt)) return options.description?.trim() || '';
  if (resetsAt - now < 1000) return t('workbench.quotaResetNow');

  const target = new Date(resetsAt);
  const today = new Date(now);
  if (sameDay(target, today)) {
    return t('workbench.quotaResetIn', { duration: formatDuration((resetsAt - now) / 1000, t) });
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const time = clockTime(target, locale);
  if (sameDay(target, tomorrow)) return t('workbench.quotaResetTomorrow', { time });
  return t('workbench.quotaResetOn', { weekday: weekdayName(target, locale), time });
}

/* --------------------------------------------------------------- 配速 --- */

const AHEAD_STAGES: ReadonlySet<PaceStage> = new Set<PaceStage>(['slightlyAhead', 'ahead', 'farAhead']);

/** 结余够多、且实际速度确实慢得下来,才报"× 余量"。 */
const HEADROOM_DELTA = -15;
const HEADROOM_MULTIPLIER = 1.5;

function trimNumber(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** 上游把风险百分比吸附到最近的 5,免得给出"37% 风险"这种假精度。 */
export function roundedRiskPercent(riskPercent: number): number {
  return Math.round(Math.min(100, Math.max(0, toFinite(riskPercent))) / 5) * 5;
}

/**
 * 配速那一行。左半是偏差,右半是续航,用 ` · ` 接起来;风险用空格挂在续航后面。
 * 典型产物:
 *   `"按计划 · 可用到重置"`
 *   `"超支 11% · 3 小时 20 分后耗尽 (25% 风险)"`
 *   `"结余 8% · 可用到重置 · 1.5× 余量"`
 */
export function formatMetaText(pace: UsagePace | null | undefined, t: Translate): string {
  if (!pace) return '';

  const delta = toFinite(pace.deltaPercent);
  const deltaValue = Math.round(Math.abs(delta));
  const left = deltaValue === 0 || pace.stage === 'onTrack'
    ? t('workbench.quotaPaceOnTrack')
    : AHEAD_STAGES.has(pace.stage)
      ? t('workbench.quotaPaceDeficit', { value: deltaValue })
      : t('workbench.quotaPaceReserve', { value: deltaValue });

  let right: string | null = null;
  if (pace.willLastToReset) {
    right = t('workbench.quotaPaceLasts');
    const multiplier = pace.speedMultiplier;
    if (delta < HEADROOM_DELTA && multiplier != null && Number.isFinite(multiplier) && multiplier >= HEADROOM_MULTIPLIER) {
      right = `${right} · ${t('workbench.quotaPaceHeadroom', { value: trimNumber(multiplier) })}`;
    }
  } else if (pace.etaSeconds != null && Number.isFinite(pace.etaSeconds)) {
    right = t('workbench.quotaPaceRunsOut', { duration: formatDuration(pace.etaSeconds, t) });
  }

  if (pace.riskPercent != null && Number.isFinite(pace.riskPercent)) {
    const risk = t('workbench.quotaPaceRisk', { risk: roundedRiskPercent(pace.riskPercent) });
    right = right ? `${right} ${risk}` : risk;
  }

  return [left, right].filter(Boolean).join(' · ');
}

/** `300` → `"5 小时窗口"`;`10080` → `"7 天窗口"`。 */
export function formatWindowLabel(windowMinutes: number | null | undefined, t: Translate): string {
  if (windowMinutes == null || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return '';
  return t('workbench.quotaWindowLabel', { duration: formatDuration(windowMinutes * 60, t) });
}

/* ------------------------------------------------------------- 数据面 --- */

export type QuotaMetric = {
  key: string;
  title: string;
  window: RateWindow;
  pace?: UsagePace | null;
};

/**
 * 一个 provider 要画的 metric 列表,顺序固定 primary → secondary → tertiary →
 * extraRateWindows。`isSyntheticPlaceholder` 的窗口整条跳过 —— 那是后端为了补齐
 * 结构塞的占位值,画出来就是凭空编一个额度。
 */
export function visibleMetrics(
  snapshot: Pick<ProviderSnapshot, 'primary' | 'secondary' | 'tertiary' | 'extraRateWindows'>,
  titles: { primary: string; secondary: string; tertiary: string },
): QuotaMetric[] {
  const metrics: QuotaMetric[] = [];
  const push = (key: string, title: string, window: RateWindow | null | undefined) => {
    if (!window || window.isSyntheticPlaceholder) return;
    metrics.push({ key, title, window, pace: (window as { pace?: UsagePace | null }).pace ?? null });
  };
  push('primary', titles.primary, snapshot.primary);
  push('secondary', titles.secondary, snapshot.secondary);
  push('tertiary', titles.tertiary, snapshot.tertiary);
  for (const extra of snapshot.extraRateWindows ?? []) {
    if (!extra?.window || extra.window.isSyntheticPlaceholder) continue;
    metrics.push({
      key: `extra:${extra.id}`,
      title: extra.title,
      window: extra.window,
      pace: (extra.window as { pace?: UsagePace | null }).pace ?? null,
    });
  }
  return metrics;
}

/** `source` 决定这张卡的可信度标注。本机估算绝不能显示得像官方额度。 */
export type QuotaTrust = 'authoritative' | 'local' | 'unknown';

export function quotaTrust(source: ProviderSource | undefined): QuotaTrust {
  if (source === 'oauth' || source === 'api') return 'authoritative';
  if (source === 'local' || source === 'cli') return 'local';
  return 'unknown';
}

/** Header 第二行的三态副标题。 */
export type SubtitleKind = 'error' | 'loading' | 'info';

export function headerSubtitle(
  snapshot: Pick<ProviderSnapshot, 'status' | 'error' | 'updatedAt'>,
  now: number,
  t: Translate,
): { kind: SubtitleKind; text: string } {
  if (snapshot.status === 'error' && snapshot.error) return { kind: 'error', text: snapshot.error };
  if (snapshot.status === 'loading') return { kind: 'loading', text: t('workbench.quotaRefreshing') };
  if (snapshot.updatedAt == null) return { kind: 'info', text: t('workbench.quotaNotFetched') };
  const seconds = Math.max(0, (now - snapshot.updatedAt) / 1000);
  if (seconds < 60) return { kind: 'info', text: t('workbench.quotaUpdatedJustNow') };
  return { kind: 'info', text: t('workbench.quotaUpdatedAgo', { ago: formatDuration(seconds, t) }) };
}
