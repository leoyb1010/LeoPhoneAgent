// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateSkillSyncRequests,
  registerSyncStoreSetters,
  triggerIncrementalSync,
} from '../useSkillSync';

describe('SkillHub sync owner boundaries', () => {
  const mergeSyncResults = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    registerSyncStoreSetters({
      setSyncResults: vi.fn(),
      mergeSyncResults,
      setSyncError: vi.fn(),
    });
  });

  it('drops an in-flight sync result after the owner is invalidated', async () => {
    let resolveSync: ((value: unknown) => void) | undefined;
    const sync = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    );
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      skillhub: { sync },
    };

    const pending = triggerIncrementalSync(['owner-skill']);
    await vi.waitFor(() => expect(resolveSync).toBeDefined());
    invalidateSkillSyncRequests();
    resolveSync!({
      success: true,
      results: [{ name: 'owner-skill', status: 'synced' }],
    });
    await pending;

    expect(mergeSyncResults).not.toHaveBeenCalled();
  });
});
