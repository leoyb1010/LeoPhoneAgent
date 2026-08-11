import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { appConfigDb } from '@/modules/database/index.js';

/**
 * Claude subscription window usage, measured from local session logs.
 *
 * Why this is consumption, not a quota percentage: Anthropic does not publish
 * the absolute token ceilings for Pro/Max rate limits, and exposes only
 * percentages to the CLI. So any "remaining % of your plan" a third party
 * computes from token counts is fabricated. What we CAN measure exactly from
 * `~/.claude/projects/**\/*.jsonl` is the work done inside each rolling
 * window — input + output tokens (the part that actually counts against the
 * limit; cache_read re-reads are near-free), the number of turns, and an
 * estimated API-equivalent cost.
 *
 * The rings therefore show real local consumption and composition per window
 * plus the reset time — not an invented quota fraction. Labelled "本地实测".
 */

export type ClaudePlanId = 'pro' | 'max5' | 'max20';

const PLAN_LABEL: Record<ClaudePlanId, string> = {
  pro: 'Pro',
  max5: 'Max 5x',
  max20: 'Max 20x',
};

const PLAN_CONFIG_KEY = 'claude_quota_plan';
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Rough API-equivalent pricing (USD per million tokens) for the cost estimate.
// Sonnet-class is the dominant model in these logs; we use a blended rate.
const COST_PER_MILLION_INPUT = 3;
const COST_PER_MILLION_OUTPUT = 15;

export function getClaudePlan(): ClaudePlanId {
  const raw = (appConfigDb.get(PLAN_CONFIG_KEY) || '').toLowerCase();
  return raw === 'max5' || raw === 'max20' || raw === 'pro' ? (raw as ClaudePlanId) : 'max5';
}

export function setClaudePlan(value: unknown): ClaudePlanId {
  const raw = String(value ?? '').toLowerCase();
  const plan: ClaudePlanId = raw === 'pro' || raw === 'max20' ? (raw as ClaudePlanId) : 'max5';
  appConfigDb.set(PLAN_CONFIG_KEY, plan);
  return plan;
}

type WindowAggregate = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  oldestMs: number | null;
};

function newWindow(): WindowAggregate {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0, oldestMs: null };
}

function readTokenCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function addUsage(win: WindowAggregate, usage: Record<string, unknown>, tsMs: number): void {
  win.inputTokens += readTokenCount(usage.input_tokens ?? usage.inputTokens);
  win.outputTokens += readTokenCount(usage.output_tokens ?? usage.outputTokens);
  win.cacheReadTokens += readTokenCount(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens);
  win.cacheCreationTokens += readTokenCount(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens);
  win.turns += 1;
  if (win.oldestMs === null || tsMs < win.oldestMs) win.oldestMs = tsMs;
}

async function collectJsonlFiles(rootDir: string, sinceMs: number, maxDepth = 3): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Only files touched within the widest window can hold in-range entries.
        // The projects dir accumulates tens of thousands of old logs (2GB+); a
        // stat is far cheaper than streaming every one, so prune by mtime here.
        try {
          const st = await fsp.stat(full);
          if (st.mtimeMs >= sinceMs) results.push(full);
        } catch {
          // Unreadable — skip.
        }
      }
    }
  }
  await walk(rootDir, 0);
  return results;
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

async function aggregateFile(filePath: string, five: WindowAggregate, week: WindowAggregate, nowMs: number): Promise<void> {
  try {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const tsMs = Date.parse(String(entry.timestamp ?? ''));
      if (!Number.isFinite(tsMs)) continue;
      const ageMs = nowMs - tsMs;
      if (ageMs > SEVEN_DAYS_MS) continue;
      const usage = (entry.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      if (!usage) continue;
      if (ageMs <= FIVE_HOURS_MS) addUsage(five, usage, tsMs);
      addUsage(week, usage, tsMs);
    }
  } catch {
    // Unreadable file — skip; a partial measure is more useful than none.
  }
}

export type ClaudeWindowUsage = {
  /** Tokens that count against the rate limit (input + output). */
  countedTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Near-free re-reads, shown as context but not counted toward the limit. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  /** API-equivalent cost of the counted tokens, USD. */
  costUsd: number;
  resetsAt: string;
};

export type ClaudeQuotaEstimateResult = {
  plan: ClaudePlanId;
  planLabel: string;
  /** Always 'local-measurement' — these are measured tokens, not a quota %. */
  source: 'local-measurement';
  fiveHour: ClaudeWindowUsage;
  weekly: ClaudeWindowUsage;
  filesScanned: number;
};

function buildWindow(agg: WindowAggregate, nowMs: number, windowMs: number): ClaudeWindowUsage {
  const counted = agg.inputTokens + agg.outputTokens;
  const costUsd = (agg.inputTokens * COST_PER_MILLION_INPUT + agg.outputTokens * COST_PER_MILLION_OUTPUT) / 1_000_000;
  const resetsAtMs = agg.oldestMs !== null ? Math.max(agg.oldestMs + windowMs, nowMs) : nowMs;
  return {
    countedTokens: Math.round(counted),
    inputTokens: Math.round(agg.inputTokens),
    outputTokens: Math.round(agg.outputTokens),
    cacheReadTokens: Math.round(agg.cacheReadTokens),
    cacheCreationTokens: Math.round(agg.cacheCreationTokens),
    turns: agg.turns,
    costUsd: Math.round(costUsd * 100) / 100,
    resetsAt: new Date(resetsAtMs).toISOString(),
  };
}

/**
 * Scan local Claude session logs and aggregate the two rolling windows.
 * Reset for a rolling window is estimated as (oldest contributing turn +
 * window length); with no usage it equals now.
 */
// Scanning tens of thousands of session logs is expensive, and the dashboard
// polls this every 30s. Serve a recent result from a short-lived cache so only
// the first call after each window pays for the scan.
let quotaCache: { at: number; result: ClaudeQuotaEstimateResult } | null = null;
const QUOTA_CACHE_TTL_MS = 60_000; // longer than the dashboard's 30s poll so polls hit cache

export async function estimateClaudeQuota(): Promise<ClaudeQuotaEstimateResult> {
  if (quotaCache && Date.now() - quotaCache.at < QUOTA_CACHE_TTL_MS) {
    return quotaCache.result;
  }

  const plan = getClaudePlan();
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const nowMs = Date.now();

  const five = newWindow();
  const week = newWindow();
  // Only files modified within the 7d window can contribute; pruning by mtime
  // turns a 2GB full read into a few recent files. Read them concurrently.
  const files = await collectJsonlFiles(projectsDir, nowMs - SEVEN_DAYS_MS);
  await mapWithConcurrency(files, 16, (file) => aggregateFile(file, five, week, nowMs));

  const result: ClaudeQuotaEstimateResult = {
    plan,
    planLabel: PLAN_LABEL[plan],
    source: 'local-measurement',
    fiveHour: buildWindow(five, nowMs, FIVE_HOURS_MS),
    weekly: buildWindow(week, nowMs, SEVEN_DAYS_MS),
    filesScanned: files.length,
  };
  quotaCache = { at: Date.now(), result };
  return result;
}
