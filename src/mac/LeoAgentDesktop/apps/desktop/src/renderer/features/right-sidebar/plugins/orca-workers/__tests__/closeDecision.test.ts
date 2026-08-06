import { describe, expect, it } from 'vitest';

import { getOrcaWorkersCloseDecision } from '../closeDecision';

describe('orca-workers close decision', () => {
  it('asks to stop the team only while the lead session still has active collaboration', () => {
    expect(getOrcaWorkersCloseDecision({
      isLoading: false,
      leadSession: { orcaRole: 'lead' },
    })).toBe('stop-team');
  });

  it('lets orphan collaboration tabs close directly after collaboration has ended', () => {
    expect(getOrcaWorkersCloseDecision({
      isLoading: false,
      leadSession: { orcaRole: null },
    })).toBe('close');
  });

  it('vetoes while session identity is still unknown', () => {
    expect(getOrcaWorkersCloseDecision({
      isLoading: true,
      leadSession: null,
    })).toBe('veto');
  });
});
