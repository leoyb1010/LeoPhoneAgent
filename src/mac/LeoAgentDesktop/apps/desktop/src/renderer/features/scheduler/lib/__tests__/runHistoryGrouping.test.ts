import { describe, expect, it } from 'vitest';
import type { ScheduleRun } from '@cindy/maker-scheduler';

import { groupRunsForHistory } from '../runHistoryGrouping';

function run(id: string, sessionId?: string): ScheduleRun {
  return {
    id,
    scheduleId: 'schedule-1',
    sessionId,
    firedAt: Number(id.replace(/\D/g, '')) || 1,
    status: 'success',
  };
}

describe('groupRunsForHistory', () => {
  it('keeps non-persistent schedules flat', () => {
    expect(groupRunsForHistory([run('r3', 'shared'), run('r2', 'shared')], false)).toEqual([
      { kind: 'run', key: 'r3', run: run('r3', 'shared') },
      { kind: 'run', key: 'r2', run: run('r2', 'shared') },
    ]);
  });

  it('groups persistent runs by session without dropping standalone failures', () => {
    const entries = groupRunsForHistory([
      run('r5', 'current'),
      run('r4'),
      run('r3', 'current'),
      run('r2', 'historical'),
      run('r1', 'historical'),
    ], true);

    expect(entries).toEqual([
      { kind: 'session', key: 'session:current', sessionId: 'current', runs: [run('r5', 'current'), run('r3', 'current')] },
      { kind: 'run', key: 'r4', run: run('r4') },
      { kind: 'session', key: 'session:historical', sessionId: 'historical', runs: [run('r2', 'historical'), run('r1', 'historical')] },
    ]);
  });
});
