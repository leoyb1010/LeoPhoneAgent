import { getHealthSnapshot } from './provider-health.service.js';
import type { TargetHealth } from './provider-health.service.js';
import { readStore, sanitizeProvider } from './provider-store.service.js';

/**
 * Read-only environment readiness ("doctor"). Distinct from diagnostics.service
 * (a shareable data dump): this turns the same already-collected state into a
 * per-check ok/warn/fail verdict answering "is everything actually wired up right
 * now" — the #1 real-world question when driving seven agent CLIs. Deterministic
 * from stored state (no live probes), so it is safe and unit-testable.
 */

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export type DoctorCheck = {
  id: string;
  category: 'cli' | 'leoapi';
  label: string;
  status: DoctorStatus;
  detail: string;
};

export type DoctorReport = {
  generatedAt: string;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
};

type CliToolStatusLike = {
  id?: string;
  label?: string;
  installed?: boolean;
  runnable?: boolean;
  currentVersion?: string | null;
  error?: string | null;
};

type DoctorInput = {
  cliTools: CliToolStatusLike[];
  switchProviders: ReturnType<typeof sanitizeProvider>[];
  activeByTarget: Record<string, string>;
  /** Live background-monitor state; degraded targets outrank the static "已就绪" verdict. */
  healthByTarget?: Record<string, TargetHealth>;
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];

  for (const tool of input.cliTools) {
    const id = asString(tool.id) || 'cli';
    const label = asString(tool.label) || id;
    if (tool.runnable) {
      checks.push({
        id: `cli:${id}`,
        category: 'cli',
        label,
        status: 'ok',
        detail: tool.currentVersion ? `已就绪 · ${tool.currentVersion}` : '已就绪',
      });
    } else if (tool.installed) {
      checks.push({
        id: `cli:${id}`,
        category: 'cli',
        label,
        status: 'fail',
        detail: `已安装但无法运行${tool.error ? ` · ${tool.error}` : ''}`,
      });
    } else {
      checks.push({ id: `cli:${id}`, category: 'cli', label, status: 'warn', detail: '未安装' });
    }
  }

  const providerById = new Map(input.switchProviders.map((provider) => [provider.id, provider]));
  for (const [target, providerId] of Object.entries(input.activeByTarget)) {
    const label = `Leoapi · ${target}`;
    const provider = providerById.get(providerId);
    if (!provider) {
      checks.push({ id: `leoapi:${target}`, category: 'leoapi', label, status: 'warn', detail: '活动接口记录缺失' });
      continue;
    }

    const name = asString(provider.name) || provider.id;
    if (!asString(provider.apiKey)) {
      checks.push({ id: `leoapi:${target}`, category: 'leoapi', label, status: 'fail', detail: `${name} 未配置 API Key` });
      continue;
    }

    const health = input.healthByTarget?.[target];
    if (health && health.providerId === provider.id && health.status === 'degraded') {
      checks.push({
        id: `leoapi:${target}`,
        category: 'leoapi',
        label,
        status: 'warn',
        detail: `${name} 连续 ${health.consecutiveFailures} 次探测失败${health.lastNote ? ` · ${health.lastNote}` : ''}`,
      });
      continue;
    }

    const stats = provider.endpointStats as Record<string, { usable?: boolean }> | undefined;
    const latest = stats?.[asString(provider.baseUrl)];
    if (latest && latest.usable === false) {
      checks.push({ id: `leoapi:${target}`, category: 'leoapi', label, status: 'warn', detail: `${name} 最近一次测速不可用` });
    } else {
      checks.push({ id: `leoapi:${target}`, category: 'leoapi', label, status: 'ok', detail: `${name} 已就绪` });
    }
  }

  const summary = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 },
  );

  return { generatedAt: new Date().toISOString(), checks, summary };
}

export async function collectDoctorReport(cliTools: CliToolStatusLike[]): Promise<DoctorReport> {
  const store = await readStore();
  return buildDoctorReport({
    cliTools,
    switchProviders: store.providers.map(sanitizeProvider),
    activeByTarget: store.activeByTarget,
    healthByTarget: getHealthSnapshot(store.healthMonitor).targets,
  });
}
