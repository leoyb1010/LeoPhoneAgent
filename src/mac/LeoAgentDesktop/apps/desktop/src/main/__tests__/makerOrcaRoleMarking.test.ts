import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
);
const makerHostSource = readFileSync(
  resolve(__dirname, '..', 'maker-host', 'index.ts'),
  'utf8',
);

describe('maker Orca role marking IPC boundary', () => {
  it('exposes explicit markOrcaRole IPC for post-addWorker marking', () => {
    expect(registerSource).toContain('ipcMain.handle(MAKER_INVOKE.MARK_ORCA_ROLE');
    expect(registerSource).toContain('await markOrcaRoleIfNeeded(sessionId, role);');
  });

  it('suppresses Agent Island notifications for known Orca workers', () => {
    expect(registerSource).toContain("from '../agent-island/notificationPolicy.js'");
    expect(registerSource).toContain('function shouldNotifyAgentIslandForSession(sessionId: string): boolean');
    expect(registerSource).toContain('isKnownOrcaWorkerSession(sessionId)');
    expect(registerSource).toContain('if (!shouldNotifyAgentIslandForSession(session.id)) return;');
    expect(registerSource).toContain('if (!shouldNotifyAgentIslandForSession(sessionId)) return;');
  });

  it('clears any existing Agent Island entry when a session is marked as an Orca worker', () => {
    const roleMarkingSource = registerSource.slice(registerSource.indexOf('async function markOrcaRoleIfNeeded'));

    expect(roleMarkingSource).toContain("if (orcaRole === 'worker') {");
    expectOrder(roleMarkingSource, 'markKnownOrcaWorkerSession(sessionId);', 'clearSuppressedOrcaWorkerAgentIslandSession(sessionId);');
  });

  it('registers rehydrated worker sessions as known before Maker publishes them', () => {
    const successHookSource = makerHostSource.slice(
      makerHostSource.indexOf('onStartSucceeded:'),
      makerHostSource.indexOf('getCodexHistoryHasProductPrompt:'),
    );

    expect(successHookSource).toContain("if (createOpts.orcaRole === 'worker') {");
    expect(successHookSource).toContain('markKnownOrcaWorkerSession(sessionId);');
  });
});

function expectOrder(source: string, before: string, after: string): void {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  expect(beforeIndex).toBeGreaterThanOrEqual(0);
  expect(afterIndex).toBeGreaterThan(beforeIndex);
}
