import { describe, expect, it } from 'vitest';

import { buildRecentTrendRows } from '../skillUsageTrend';

describe('skill usage trend', () => {
  it('builds the recent 30-day window from an explicit local day anchor', () => {
    const rows = buildRecentTrendRows([
      {
        day: '2026-06-22',
        useCount: 3,
        averageToolCalls: 1,
        averageRepeatedToolCalls: 0,
        commandFailureRate: null,
      },
    ], '2026-06-22');

    expect(rows).toHaveLength(30);
    expect(rows[0]?.day).toBe('2026-05-24');
    expect(rows.at(-1)).toMatchObject({
      day: '2026-06-22',
      useCount: 3,
    });
  });

  it('moves the window when the local day anchor changes', () => {
    const rows = buildRecentTrendRows([], '2026-06-23');

    expect(rows[0]?.day).toBe('2026-05-25');
    expect(rows.at(-1)?.day).toBe('2026-06-23');
  });
});
