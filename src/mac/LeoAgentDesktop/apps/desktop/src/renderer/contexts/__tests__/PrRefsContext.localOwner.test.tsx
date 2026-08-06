// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dataOwnerId: 'local-v1' as string | null,
  listAllPrRefs: vi.fn(),
  onPrRefsChanged: vi.fn(() => () => undefined),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: mocks.dataOwnerId }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { PrRefsProvider, usePrRefsForSession } from '../PrRefsContext';

function RefCount() {
  return <div>{usePrRefsForSession('session-local').length}</div>;
}

describe('PrRefsProvider local owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dataOwnerId = 'local-v1';
    mocks.listAllPrRefs.mockResolvedValue([
      {
        id: 'ref-1',
        sessionId: 'session-local',
        owner: 'makecindy',
        repo: 'cindy',
        prNumber: 445,
        url: 'https://github.com/makecindy/cindy/pull/445',
        firstSeenAt: 1,
        lastSeenAt: 2,
      },
    ]);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      gitContext: {
        listAllPrRefs: mocks.listAllPrRefs,
        onPrRefsChanged: mocks.onPrRefsChanged,
        listPrRefs: vi.fn(),
        getPrStatuses: vi.fn(),
      },
    };
  });

  it('loads PR refs for the account-free local data owner', async () => {
    render(
      <PrRefsProvider>
        <RefCount />
      </PrRefsProvider>,
    );

    expect(await screen.findByText('1')).toBeTruthy();
    expect(mocks.listAllPrRefs).toHaveBeenCalledOnce();
    expect(mocks.onPrRefsChanged).toHaveBeenCalledOnce();
  });
});
