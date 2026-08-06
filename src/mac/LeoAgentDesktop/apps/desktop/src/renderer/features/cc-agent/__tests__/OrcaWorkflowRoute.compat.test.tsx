// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; orcaRole?: 'lead' | 'worker' | null }>,
  remoteSessions: [] as Array<{ id: string; orcaRole?: 'lead' | 'worker' | null }>,
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: mocks.sessions, isLoading: false }),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => mocks.remoteSessions,
}));

import { OrcaWorkflowRoute } from '../OrcaWorkflowRoute';

function LocationProbe() {
  const location = useLocation();
  return (
    <div>
      <span data-testid="location">{`${location.pathname}${location.search}`}</span>
      <span data-testid="state">{JSON.stringify(location.state)}</span>
    </div>
  );
}

function renderLegacyRoute(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/cc-agent/orca/:sessionId" element={<OrcaWorkflowRoute />} />
        <Route path="/cc-agent/:sessionId" element={<LocationProbe />} />
        <Route path="/cc-agent" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrcaWorkflowRoute legacy compatibility redirect', () => {
  beforeEach(() => {
    mocks.sessions = [];
    mocks.remoteSessions = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('does not carry an orca-workers reveal intent for sessions without active collaboration', async () => {
    mocks.sessions = [{ id: 'lead-1', orcaRole: null }];

    renderLegacyRoute('/cc-agent/orca/lead-1?worker=worker-1&foo=bar');

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/cc-agent/lead-1?foo=bar');
    });
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).toEqual({});
  });
});
