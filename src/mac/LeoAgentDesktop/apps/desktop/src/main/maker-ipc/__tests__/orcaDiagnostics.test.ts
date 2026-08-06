import { describe, expect, it, vi } from 'vitest';

import {
  getOrcaWorkspaceInfoReadOnly,
  getOrcaWorkerDiagnosticStatusReadOnly,
  readOrcaWorkerOutputReadOnly,
  type OrcaDiagnosticsDeps,
} from '../orcaDiagnostics';

function createDeps(overrides: Partial<OrcaDiagnosticsDeps> = {}): OrcaDiagnosticsDeps {
  return {
    readActiveTeam: vi.fn(async () => ({
      id: 'team-1',
      leadSessionId: 'lead-1',
      status: 'active',
    })),
    listWorkersByLead: vi.fn(async () => [{
      id: 'worker-1',
      sessionId: 'worker-session-1',
      status: 'done',
      label: 'dev',
      role: 'developer',
      focused: true,
      idleSince: null,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      session: {
        agentKind: 'codex' as const,
        model: 'gpt-5.5',
        effort: 'high',
        workingDir: '/repo',
      },
    }]),
    getSessionStatus: vi.fn((sessionId) => sessionId === 'worker-session-1' ? 'not_running' : 'active'),
    readLatestAssistantMessage: vi.fn(async () => 'latest assistant output'),
    ...overrides,
  };
}

describe('orca diagnostics read-only helpers', () => {
  it('returns empty workspace info without reading workers when there is no active team', async () => {
    const deps = createDeps({
      readActiveTeam: vi.fn(async () => null),
      listWorkersByLead: vi.fn(async () => {
        throw new Error('listWorkersByLead should not be called without active team');
      }),
    });

    await expect(getOrcaWorkspaceInfoReadOnly(deps, 'lead-without-active-team')).resolves.toEqual({
      ok: true,
      workflow: null,
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    });

    expect(deps.readActiveTeam).toHaveBeenCalledWith('lead-without-active-team');
    expect(deps.listWorkersByLead).not.toHaveBeenCalled();
  });

  it('matches legacy workspace diagnostic fields', async () => {
    const deps = createDeps();

    const result = await getOrcaWorkspaceInfoReadOnly(deps, 'lead-1');

    expect(result).toMatchObject({
      ok: true,
      workflow: {
        workflow_id: 'team-1',
        lead_session_id: 'lead-1',
        status: 'active',
      },
      ui_capacity: 1,
      worker_count: 1,
      workers: [{
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        restored_from_storage: true,
        label: 'dev',
        role: 'developer',
        agent_kind: 'codex',
        model: 'gpt-5.5',
        effort: 'high',
        focused: true,
        working_dir: '/repo',
      }],
    });
    if (!result.ok) throw new Error('expected ok result');
    expect(result.workers[0]?.idle_ms).toEqual(expect.any(Number));
  });

  it('returns worker_status fields and accepts worker session id as diagnostic ref', async () => {
    const deps = createDeps();

    await expect(getOrcaWorkerDiagnosticStatusReadOnly(
      deps,
      'lead-1',
      'worker-session-1',
    )).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      restored_from_storage: true,
    });
  });

  it('reads latest assistant output for read_worker', async () => {
    const deps = createDeps();

    await expect(readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1')).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      result: 'latest assistant output',
    });
    expect(deps.readLatestAssistantMessage).toHaveBeenCalledWith('worker-session-1');
  });
});
