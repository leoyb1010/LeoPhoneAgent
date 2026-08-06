import { describe, expect, it, vi } from 'vitest';

import { didOpenOrcaWorkersTab, revealOrcaWorkersWithRetry } from '../orcaWorkersRevealRetry';

describe('revealOrcaWorkersWithRetry', () => {
  it('retries stale-context until the explicit reveal is attached', async () => {
    const reveal = vi
      .fn()
      .mockResolvedValueOnce('stale-context')
      .mockResolvedValueOnce('stale-context')
      .mockResolvedValueOnce('attached');
    const wait = vi.fn(async () => undefined);

    await expect(revealOrcaWorkersWithRetry({ reveal, wait })).resolves.toBe('attached');
    expect(reveal).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('does not retry queued and does not report queued or stale as opened', async () => {
    const reveal = vi.fn(async () => 'queued' as const);
    const wait = vi.fn(async () => undefined);

    await expect(revealOrcaWorkersWithRetry({ reveal, wait })).resolves.toBe('queued');
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(didOpenOrcaWorkersTab('queued')).toBe(false);
    expect(didOpenOrcaWorkersTab('stale-context')).toBe(false);
    expect(didOpenOrcaWorkersTab('attached')).toBe(true);
    expect(didOpenOrcaWorkersTab('routed')).toBe(true);
  });

  it('stops after the configured stale-context attempt limit', async () => {
    const reveal = vi.fn(async () => 'stale-context' as const);
    const wait = vi.fn(async () => undefined);

    await expect(revealOrcaWorkersWithRetry({ reveal, wait, maxAttempts: 3 })).resolves.toBe(
      'stale-context',
    );
    expect(reveal).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
