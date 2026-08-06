// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: mocks.sessions, isLoading: false }),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
}));

import { OrcaWorkflowRoute } from '../OrcaWorkflowRoute';

function RedirectTarget() {
  const location = useLocation();
  return (
    <div>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="search">{location.search}</span>
      <span data-testid="state">{JSON.stringify(location.state)}</span>
    </div>
  );
}

describe('OrcaWorkflowRoute navigation intent', () => {
  beforeEach(() => {
    mocks.sessions = [
      {
        id: 'lead-a',
        orcaRole: 'lead',
        status: 'active',
      },
    ];
  });

  it('hands the worker hint to the target Lead route instead of revealing against stale context', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/cc-agent/orca/lead-a',
            search: '?worker=worker-b&source=legacy',
            state: { searchJump: { sessionId: 'worker-b' } },
          },
        ]}
      >
        <Routes>
          <Route path="/cc-agent/orca/:sessionId" element={<OrcaWorkflowRoute />} />
          <Route path="/cc-agent/:sessionId" element={<RedirectTarget />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/cc-agent/lead-a'));
    expect(screen.getByTestId('search').textContent).toBe('?source=legacy');
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).toEqual({
      searchJump: { sessionId: 'worker-b' },
      orcaWorkersReveal: {
        leadSessionId: 'lead-a',
        focusWorkerSessionId: 'worker-b',
      },
    });
  });

  it('still carries a scoped reveal intent when the legacy route has no worker target', async () => {
    render(
      <MemoryRouter initialEntries={['/cc-agent/orca/lead-a']}>
        <Routes>
          <Route path="/cc-agent/orca/:sessionId" element={<OrcaWorkflowRoute />} />
          <Route path="/cc-agent/:sessionId" element={<RedirectTarget />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/cc-agent/lead-a'));
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).toEqual({
      orcaWorkersReveal: {
        leadSessionId: 'lead-a',
        focusWorkerSessionId: null,
      },
    });
  });

  it('does not create a reveal intent for a session without active collaboration', async () => {
    mocks.sessions = [{ id: 'lead-a', orcaRole: null, status: 'active' }];
    render(
      <MemoryRouter initialEntries={['/cc-agent/orca/lead-a?worker=worker-b']}>
        <Routes>
          <Route path="/cc-agent/orca/:sessionId" element={<OrcaWorkflowRoute />} />
          <Route path="/cc-agent/:sessionId" element={<RedirectTarget />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/cc-agent/lead-a'));
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).toEqual({});
  });
});
