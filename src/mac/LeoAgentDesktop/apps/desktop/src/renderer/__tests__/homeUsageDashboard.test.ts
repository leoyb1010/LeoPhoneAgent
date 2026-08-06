import { describe, expect, it } from 'vitest';

import { buildTokenDistributionRows } from '../components/new-chat/HomeUsageDashboard';

describe('HomeUsageDashboard', () => {
  it('merges token distribution rows with the same display model', () => {
    const rows = buildTokenDistributionRows([
      { model: 'gpt-5.5', tokens: 1_000 },
      { model: 'gpt-5.5', tokens: 2_000 },
      { model: 'claude-sonnet-4-6', tokens: 500 },
      { model: 'unused-zero', tokens: 0 },
    ]);

    expect(rows).toEqual([
      { model: 'gpt-5.5', tokens: 3_000 },
      { model: 'claude-sonnet-4-6', tokens: 500 },
    ]);
  });
});
