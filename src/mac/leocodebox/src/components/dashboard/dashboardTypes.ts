// Shared types for the dashboard. These mirror the backend payloads exactly
// (see server/modules/leocodebox/cli-tools.routes.ts, usage.db.ts,
// provider routes, mission.routes.ts) — nothing here is invented.

export type CliToolStatus = {
  id: string;
  label: string;
  installed: boolean;
  runnable?: boolean;
  currentVersion: string | null;
  latestVersion?: string | null;
  installSource?: string;
  active?: boolean;
  error?: string | null;
};

export type CliToolsStatusPayload = {
  tools?: CliToolStatus[];
  mutationsAllowed?: boolean;
  stale?: boolean;
};

export type ProviderAuthStatus = {
  provider: string;
  installed: boolean;
  authenticated: boolean;
  email?: string | null;
  method?: string | null;
  version?: string | null;
  error?: string | null;
};

export type UsageSummaryRow = {
  day: string;
  provider: string;
  model: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
};

export type MissionCard = {
  id: string;
  title: string;
  goal?: string;
  provider?: string;
  status: 'backlog' | 'running' | 'review' | 'done' | 'discarded';
  costUsd?: number | null;
};

export type RunningSession = {
  sessionId: string;
  provider: string;
  startedAt?: number;
  statusText?: string;
  canInterrupt?: boolean;
  projectPath?: string;
};

// ---- Claude local window measurement (Task 5) ----
// These are MEASURED tokens from local session logs — not a quota fraction.
// Anthropic does not publish absolute rate-limit ceilings, so we never show
// an invented "remaining %". We show real consumption + composition + reset.
export type ClaudeWindowUsage = {
  countedTokens: number; // input + output (counts against the limit)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number; // near-free re-reads, context only
  cacheCreationTokens: number;
  turns: number;
  costUsd: number;
  resetsAt: string; // ISO
};

export type ClaudeQuotaEstimate = {
  plan: string;
  planLabel: string;
  source: 'local-measurement';
  fiveHour: ClaudeWindowUsage;
  weekly: ClaudeWindowUsage;
};
