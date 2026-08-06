// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../useSkillSync', () => ({
  registerSyncStoreSetters: vi.fn(),
  invalidateSkillSyncRequests: vi.fn(),
}));

import { bootstrapSkillhub, setSkillhubDataOwner } from '../useSkillhub';

describe('SkillHub data-owner bootstrap', () => {
  const scan = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    scan.mockResolvedValue({ success: true, skills: [], sources: [] });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      skillhub: { scan },
    };
  });

  it('starts a fresh local scan when cloud auth switches to local mode', async () => {
    setSkillhubDataOwner('cloud-owner');
    bootstrapSkillhub();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));

    setSkillhubDataOwner('local-v1');
    bootstrapSkillhub();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));

    expect(scan).toHaveBeenLastCalledWith({ projects: [] });
  });
});
