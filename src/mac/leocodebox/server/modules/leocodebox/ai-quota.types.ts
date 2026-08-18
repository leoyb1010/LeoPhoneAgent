/**
 * [T-quota-bar] AI 额度快照的数据契约。
 *
 * 结构照搬 CodexBar(steipete/CodexBar,MIT,见 NOTICE)的 ProviderSnapshot ——
 * 服务端、菜单栏、状态栏浮窗共用同一份形状,谁都不用自己再翻译一次。
 *
 * 契约里的两条硬规则:
 *  1. `status` 与 `source` 必须如实反映数字的来路。`source: 'api' | 'oauth'` 才是
 *     服务端下发的权威额度;`'local'` 是本机日志累加出来的估算,UI 必须另行标注。
 *  2. 读不到就 `status: 'error' | 'unconfigured'` + `note`/`error` 说明,
 *     **绝不**用 0 或者任何算出来的百分比顶上 —— 假的"额度还很满"比没有更糟。
 */

/** 一个额度窗口。usedPercent 不做归一化:服务端给 >100 就照实传。 */
export type RateWindow = {
  usedPercent: number;
  /** 300 = 5 小时,10080 = 7 天。null = 服务端没说窗口有多长。 */
  windowMinutes: number | null;
  /** epoch 毫秒。null = 该窗口没给重置时间。 */
  resetsAt: number | null;
  resetDescription?: string | null;
  nextRegenPercent?: number | null;
  /**
   * true = 这个窗口是**造出来占位**的,不是服务端给的。
   * Claude 的 five_hour 为 null 时上游会补一个 0% 的空窗口保持布局稳定,
   * 不标出来的话 UI 上就会出现一个幽灵般的 "5h 0%"。
   */
  isSyntheticPlaceholder?: boolean;
};

/** 主/次窗口之外的额外窗口(Codex 的 additional_rate_limits、Claude 的模型分档)。 */
export type NamedRateWindow = {
  id: string;
  title: string;
  window: RateWindow;
  /** false = 这一档服务端没给用量,只知道它存在。 */
  usageKnown: boolean;
};

export type ProviderIdentity = {
  accountEmail?: string | null;
  plan?: string | null;
  organization?: string | null;
};

export type ProviderCredits = {
  remaining?: number | null;
  total?: number | null;
  unit?: string | null;
  hint?: string | null;
};

export type ProviderCost = {
  todayUSD?: number | null;
  last30DaysUSD?: number | null;
  todayTokens?: number | null;
  last30DaysTokens?: number | null;
  currencyCode?: string | null;
};

export type ProviderDetailRow = { label: string; value: string; secondaryValue?: string | null };
export type ProviderDetailSection = { title: string; rows: ProviderDetailRow[] };

/**
 * 配速:实际消耗相对"按时间均匀消耗"的偏差。公式见 ai-quota.pace.ts。
 * deltaPercent > 0 表示超前消耗(赤字),< 0 表示还有富余。
 */
export type UsagePace = {
  stage: 'onTrack' | 'slightlyAhead' | 'ahead' | 'farAhead' | 'slightlyBehind' | 'behind' | 'farBehind';
  deltaPercent: number;
  expectedUsedPercent: number;
  etaSeconds: number | null;
  willLastToReset: boolean;
  speedMultiplier: number | null;
  /** 按 5% 取整 —— 这是个启发式估计,给到个位数是假精度。 */
  riskPercent: number | null;
};

export type ProviderStatus = 'ok' | 'error' | 'loading' | 'unconfigured';

/**
 * 数字的来路,决定 UI 敢不敢把它当额度用:
 *  - `oauth` / `api`:服务端下发的权威额度
 *  - `web` / `cli`:借浏览器会话或子进程拿到的权威额度
 *  - `local`:本机日志累加的估算,**不是**官方额度
 *  - `none`:什么都没读到
 */
export type ProviderSource = 'oauth' | 'api' | 'web' | 'cli' | 'local' | 'none';

export type ProviderSnapshot = {
  id: string;
  label: string;
  accentColor: string;
  status: ProviderStatus;
  source: ProviderSource;
  identity?: ProviderIdentity | null;
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
  tertiary?: RateWindow | null;
  extraRateWindows?: NamedRateWindow[];
  credits?: ProviderCredits | null;
  cost?: ProviderCost | null;
  details?: ProviderDetailSection[];
  /** epoch 毫秒。null = 这次没取到任何数据。 */
  updatedAt: number | null;
  error?: string | null;
  /** unconfigured 时说明**缺什么**,而不是笼统的"未接入"。 */
  note?: string | null;
};

/** Provider 品牌色,照 CodexBar 的取值。 */
export const PROVIDER_ACCENT: Record<string, string> = {
  codex: '#49A3B0',
  claude: '#CC7C5E',
  gemini: '#AB87EA',
  cursor: '#00BFA5',
  copilot: '#A855F7',
  grok: '#E85A6A',
  opencode: '#3B82F6',
};

export const accentFor = (id: string): string => PROVIDER_ACCENT[id] ?? '#8B8B8B';
