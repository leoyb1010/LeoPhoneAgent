import { appConfigDb, getConnection } from '@/modules/database/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';

import { usageDb } from './usage.db.js';

const LAST_SENT_KEY = 'usage_daily_summary_last_sent';
let timer: NodeJS.Timeout | null = null;

function dayOffset(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function runDailyUsageSummary(now = new Date()): boolean {
  const yesterday = dayOffset(-1);
  if (appConfigDb.get(LAST_SENT_KEY) === yesterday) return false;
  // Send after 09:00 local time so yesterday's totals are stable.
  if (now.getHours() < 9) return false;
  const rows = usageDb.summary({ from: yesterday, to: yesterday });
  const totals = rows.reduce((sum, row) => ({
    sessions: sum.sessions + row.sessionCount,
    tokens: sum.tokens + row.inputTokens + row.outputTokens + row.cacheTokens,
    costUsd: sum.costUsd + row.costUsd,
  }), { sessions: 0, tokens: 0, costUsd: 0 });
  const users = getConnection().prepare('SELECT id FROM users').all() as Array<{ id: number }>;
  for (const user of users) {
    notifyUserIfEnabled({
      userId: user.id,
      event: createNotificationEvent({
        provider: 'system',
        kind: 'info',
        code: 'usage.daily_summary',
        meta: {
          message: `Yesterday: ${totals.sessions} sessions, ${totals.tokens.toLocaleString()} tokens, about $${totals.costUsd.toFixed(2)}`,
        },
        dedupeKey: `usage:daily:${yesterday}:${user.id}`,
      }),
    });
  }
  appConfigDb.set(LAST_SENT_KEY, yesterday);
  return true;
}

export function startDailyUsageSummary(): void {
  if (timer) return;
  void Promise.resolve().then(() => runDailyUsageSummary());
  timer = setInterval(() => runDailyUsageSummary(), 60 * 60 * 1000);
  timer.unref?.();
}
